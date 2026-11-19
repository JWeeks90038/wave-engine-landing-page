const test = require("node:test");
const assert = require("node:assert/strict");
const { Readable } = require("node:stream");
const { products, validateCart } = require("../server/apparel-catalog");
const { inventoryForProducts, updateInventory, checkAvailability, confirmPaidOrder, processPaidSession, requireAdmin } = require("../server/apparel-inventory");

const sizes = ["S", "M", "L", "XL", "XXL"];
const values = (value) => Object.fromEntries(sizes.map((size) => [size, value]));

class FakeDb {
  constructor() { this.docs = new Map(); this.counter = 0; this.queue = Promise.resolve(); }
  collection(path) { return { doc: (id) => this.ref(`${path}/${id}`) }; }
  ref(path) {
    return {
      path,
      collection: (name) => ({ doc: (id) => this.ref(`${path}/${name}/${id}`) }),
      get: async () => this.snapshot(path),
      update: async (data) => this.write(path, data, true)
    };
  }
  snapshot(path) {
    const entry = this.docs.get(path);
    return { exists: Boolean(entry), ref: this.ref(path), data: () => entry?.data,
      updateTime: entry ? { seconds: entry.version, nanoseconds: 0 } : undefined };
  }
  async getAll(...refs) { return refs.map((ref) => this.snapshot(ref.path)); }
  write(path, data, merge = false) {
    this.docs.set(path, { data: merge ? { ...this.docs.get(path)?.data, ...data } : data, version: ++this.counter });
  }
  async runTransaction(work) {
    let release;
    const prior = this.queue;
    this.queue = new Promise((resolve) => { release = resolve; });
    await prior;
    const writes = [];
    const tx = {
      get: async (ref) => this.snapshot(ref.path),
      getAll: async (...refs) => this.getAll(...refs),
      create: (ref, data) => writes.push(() => this.write(ref.path, data)),
      set: (ref, data) => writes.push(() => this.write(ref.path, data)),
      update: (ref, data) => writes.push(() => this.write(ref.path, data, true))
    };
    try {
      const result = await work(tx);
      writes.forEach((write) => write());
      return result;
    } finally { release(); }
  }
}

function session(id, paymentStatus = "paid") {
  return {
    id, livemode: true, payment_status: paymentStatus, payment_intent: `pi_${id}`,
    metadata: { storefront: "wave-apparel-v1", inventoryVersion: "1",
      variants_1: JSON.stringify([[products[0].id, "M", "Black", 1]]) },
    customer_details: { email: "customer@example.test" },
    collected_information: { shipping_details: { name: "Customer", address: {
      line1: "1 Main St", city: "City", state: "CA", postal_code: "90210", country: "US"
    } } }
  };
}
const lines = [{ quantity: 1, amount_subtotal: 2999 }];

async function setup(db, quantity = 1) {
  await updateInventory(products[0].id, { ...values(0), M: quantity }, values(null), "admin", db);
}

test("admin initializes stock, updates it, and detects stale writes and invalid quantities", async () => {
  const db = new FakeDb();
  await setup(db);
  let stock = (await inventoryForProducts(db))[0];
  assert.equal(stock.active, true);
  assert.equal(stock.quantities.M, 1);
  await updateInventory(products[0].id, { ...stock.quantities, M: 3 }, stock.versions, "admin", db);
  await assert.rejects(updateInventory(products[0].id, stock.quantities, stock.versions, "admin", db), /changed/);
  stock = (await inventoryForProducts(db))[0];
  assert.equal(stock.quantities.M, 3);
  await assert.rejects(updateInventory(products[0].id, { ...stock.quantities, M: -1 }, stock.versions, "admin", db), /non-negative/);
  await assert.rejects(updateInventory("unknown", stock.quantities, stock.versions, "admin", db), /non-negative/);
});

test("availability rejects missing, inactive, sold out and excessive stock", async () => {
  const db = new FakeDb();
  const cart = validateCart([{ id: products[0].id, size: "M", color: "Black", quantity: 1 }]);
  await assert.rejects(checkAvailability(cart, db), /no longer available/);
  await setup(db);
  await checkAvailability(cart, db);
  await assert.rejects(checkAvailability([{ ...cart[0], quantity: 2 }], db), /no longer available/);
  await assert.rejects(checkAvailability([{ ...cart[0], size: "S" }], db), /no longer available/);
  db.write(`products/live_${products[0].id}`, { active: false });
  await assert.rejects(checkAvailability(cart, db), /no longer available/);
});

test("only paid orders deduct, and duplicate callbacks do not deduct twice", async () => {
  const db = new FakeDb();
  await setup(db, 2);
  await assert.rejects(confirmPaidOrder(session("cs_live_failed", "unpaid"), lines, db), /not confirmed/);
  const first = await confirmPaidOrder(session("cs_live_paid"), lines, db);
  assert.equal(first.paymentStatus, "paid");
  assert.deepEqual(first.inventoryDeductions.map(({ before, after }) => [before, after]), [[2, 1]]);
  await confirmPaidOrder(session("cs_live_paid"), lines, db);
  assert.equal((await inventoryForProducts(db))[0].quantities.M, 1);
});

test("simultaneous orders for the final item produce one fulfillment and one refund", async () => {
  const db = new FakeDb();
  await setup(db);
  const refunds = [];
  const stripe = {
    checkout: { sessions: { async *listLineItems() { yield* lines; } } },
    refunds: { create: async (args, options) => {
      refunds.push({ args, options });
      return { id: "re_1", status: "succeeded" };
    } }
  };
  await Promise.all([
    processPaidSession(stripe, session("cs_live_first"), db),
    processPaidSession(stripe, session("cs_live_second"), db)
  ]);
  const orders = ["cs_live_first", "cs_live_second"].map((id) => db.snapshot(`orders/${id}`).data());
  assert.deepEqual(orders.map((order) => order.paymentStatus).sort(), ["paid", "refunded"]);
  assert.equal((await inventoryForProducts(db))[0].quantities.M, 0);
  assert.equal(refunds.length, 1);
  const refunded = orders.find((order) => order.paymentStatus === "refunded");
  await processPaidSession(stripe, session(refunded.sessionId), db);
  assert.equal(refunds.length, 1);
});

test("a failed refund can be retried with the same Stripe idempotency key", async () => {
  const db = new FakeDb();
  await setup(db, 0);
  const keys = [];
  const stripe = {
    checkout: { sessions: { async *listLineItems() { yield* lines; } } },
    refunds: { create: async (args, options) => {
      keys.push(options.idempotencyKey);
      if (keys.length === 1) throw new Error("network interrupted");
      return { id: "re_retry", status: "succeeded" };
    } }
  };
  await assert.rejects(processPaidSession(stripe, session("cs_live_retry"), db), /network interrupted/);
  assert.equal(db.snapshot("orders/cs_live_retry").data().paymentStatus, "refund_pending");
  await processPaidSession(stripe, session("cs_live_retry"), db);
  assert.equal(db.snapshot("orders/cs_live_retry").data().paymentStatus, "refunded");
  assert.equal(keys[0], keys[1]);
});

test("pending refunds are rechecked rather than treated as complete", async () => {
  const db = new FakeDb();
  await setup(db, 0);
  let status = "pending";
  const stripe = {
    checkout: { sessions: { async *listLineItems() { yield* lines; } } },
    refunds: {
      create: async () => ({ id: "re_pending", status: "pending" }),
      retrieve: async () => ({ id: "re_pending", status })
    }
  };
  await assert.rejects(processPaidSession(stripe, session("cs_live_pending"), db), /pending/);
  assert.equal(db.snapshot("orders/cs_live_pending").data().paymentStatus, "refund_pending");
  status = "succeeded";
  await processPaidSession(stripe, session("cs_live_pending"), db);
  assert.equal(db.snapshot("orders/cs_live_pending").data().paymentStatus, "refunded");
});

test("checkout rechecks stock and uses an idempotency key", async () => {
  const inventory = require("../server/apparel-inventory");
  const config = require("../server/apparel-stripe");
  const originalCheck = inventory.checkAvailability;
  const originalStripe = config.getStripe;
  const originalSite = config.getSiteUrl;
  const previousEnabled = process.env.APPAREL_LIVE_CHECKOUT_ENABLED;
  const requestId = "9ac019d5-8357-4e8d-a5b1-b97ef5f55137";
  let stockAvailable = true;
  let stripeOptions;
  inventory.checkAvailability = async () => {
    if (!stockAvailable) { const error = new Error("Sorry, this size is no longer available."); error.statusCode = 409; throw error; }
  };
  config.getSiteUrl = () => new URL("https://example.test/");
  config.getStripe = () => ({
    prices: { retrieve: async () => ({
      id: products[0].stripePriceId, livemode: true, active: true, type: "one_time",
      currency: "usd", unit_amount: products[0].previewPrice, billing_scheme: "per_unit"
    }) },
    checkout: { sessions: { create: async (params, options) => {
      stripeOptions = options;
      assert.equal(params.metadata.inventoryVersion, "1");
      return { url: "https://checkout.stripe.com/test", livemode: true };
    } } }
  });
  process.env.APPAREL_LIVE_CHECKOUT_ENABLED = "true";
  delete require.cache[require.resolve("../api/apparel-checkout")];
  const handler = require("../api/apparel-checkout");
  const run = async () => {
    const request = Readable.from([Buffer.from(JSON.stringify({
      requestId, items: [{ id: products[0].id, size: "M", color: "Black", quantity: 1 }]
    }))]);
    request.method = "POST"; request.headers = {};
    const response = { setHeader() {}, writeHead(status) { this.status = status; },
      end(body) { this.body = JSON.parse(body); } };
    await handler(request, response);
    return response;
  };
  try {
    assert.equal((await run()).status, 200);
    assert.equal(stripeOptions.idempotencyKey, `apparel-checkout-${requestId}`);
    stockAvailable = false;
    const unavailable = await run();
    assert.equal(unavailable.status, 409);
    assert.match(unavailable.body.error, /no longer available/);
  } finally {
    inventory.checkAvailability = originalCheck;
    config.getStripe = originalStripe;
    config.getSiteUrl = originalSite;
    if (previousEnabled === undefined) delete process.env.APPAREL_LIVE_CHECKOUT_ENABLED;
    else process.env.APPAREL_LIVE_CHECKOUT_ENABLED = previousEnabled;
    delete require.cache[require.resolve("../api/apparel-checkout")];
  }
});

test("admin endpoint rejects unauthenticated writes", async () => {
  const handler = require("../api/apparel-admin");
  const request = Readable.from([Buffer.from("{}")]);
  request.method = "POST"; request.headers = {};
  const response = {
    setHeader() {},
    writeHead(status) { this.status = status; },
    end(body) { this.body = JSON.parse(body); }
  };
  await handler(request, response);
  assert.equal(response.status, 401);
  assert.match(response.body.error, /sign in/i);
});

test("admin authorization requires a verified, non-revoked token with an admin claim", async () => {
  const request = { headers: { authorization: "Bearer token" } };
  let checkRevoked;
  const auth = (claims) => () => ({ verifyIdToken: async (token, revoked) => {
    assert.equal(token, "token");
    checkRevoked = revoked;
    return claims;
  } });
  await assert.rejects(requireAdmin(request, auth({ uid: "customer" })), /Administrator access/);
  assert.equal(await requireAdmin(request, auth({ uid: "admin", admin: true })), "admin");
  assert.equal(checkRevoked, true);
});
