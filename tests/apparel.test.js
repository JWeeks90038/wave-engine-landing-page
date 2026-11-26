const test = require("node:test");
const assert = require("node:assert/strict");
const { Readable } = require("node:stream");
const Stripe = require("stripe");
const { products, validateCart } = require("../server/apparel-catalog");
const stripeConfig = require("../server/apparel-stripe");
const { validateStripePrice, getPublicProducts, cartMetadata, shippingForSubtotal } = require("../server/apparel-pricing");

function request(method, body, headers = {}, url = "/") {
  if (body && url === "/") {
    const parsed = JSON.parse(body);
    if (parsed.items) body = JSON.stringify({ ...parsed, requestId: "9ac019d5-8357-4e8d-a5b1-b97ef5f55137" });
  }
  const stream = Readable.from(body ? [Buffer.from(body)] : []);
  stream.method = method;
  stream.headers = headers;
  stream.url = url;
  return stream;
}
function response() {
  return {
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    writeHead(status, headers) { this.status = status; Object.assign(this.headers, headers); },
    end(body) { this.body = body ? JSON.parse(body) : undefined; }
  };
}
const item = { id: products[0].id, size: "XL", color: "Black", quantity: 2 };
const stripePrice = { id: products[0].stripePriceId, livemode: true, active: true, type: "one_time", currency: "usd", unit_amount: products[0].previewPrice, billing_scheme: "per_unit", tax_behavior: "unspecified" };
const freedomPrice = { ...stripePrice, id: products[1].stripePriceId, unit_amount: 2999 };

test("each product has at least six distinct gallery images that exist", () => {
  for (const product of products) {
    assert.ok(product.images.length >= 6);
    assert.equal(new Set(product.images.map((image) => image.src)).size, product.images.length);
    for (const image of product.images) {
      const fs = require("node:fs");
      assert.ok(fs.existsSync(image.src));
      assert.ok(fs.existsSync(image.previewSrc));
      assert.ok(fs.statSync(image.previewSrc).size < fs.statSync(image.src).size / 5);
    }
  }
});

test("catalog has two distinct products and all requested sizes", () => {
  assert.equal(products.length, 2);
  assert.equal(new Set(products.map((product) => product.id)).size, products.length);
  for (const product of products) {
    assert.deepEqual(product.sizes, ["S", "M", "L", "XL", "XXL"]);
  }
});

test("server validates every cart variant and quantity", () => {
  assert.equal(validateCart([item])[0].product.stripePriceId, stripePrice.id);
  for (const invalid of [
    [], [{ ...item, id: "unknown" }], [{ ...item, color: "Pink" }],
    [{ ...item, size: "" }], [{ ...item, quantity: 0 }],
    [{ ...item, quantity: 21 }], [{ ...item, quantity: 1.5 }],
    [{ ...item, quantity: "2" }], [item, item]
  ]) assert.throws(() => validateCart(invalid));
});

test("catalog uses Stripe's current price and fails closed on unsupported prices", async () => {
  const stripe = { prices: { retrieve: async (id) => id === stripePrice.id ? stripePrice : freedomPrice } };
  const publicProducts = await getPublicProducts(products, () => stripe);
  assert.equal(publicProducts[0].price, products[0].previewPrice);
  assert.equal(publicProducts[0].stripePriceId, undefined);
  assert.equal(publicProducts[0].previewPrice, undefined);
  assert.equal(publicProducts[1].price, 2999);
  assert.equal(publicProducts[1].stripePriceId, undefined);
  assert.equal(publicProducts[1].previewPrice, undefined);
  for (const invalid of [
    { active: false }, { livemode: false }, { type: "recurring" }, { currency: "eur" },
    { unit_amount: null }, { billing_scheme: "tiered" }, { transform_quantity: {} },
    { custom_unit_amount: {} }, { tax_behavior: "inclusive" }, { id: "price_wrong" }, { unit_amount: 2500 }
  ]) assert.throws(() => validateStripePrice({ ...stripePrice, ...invalid }, products[0]));
  const unavailable = await getPublicProducts(products, () => ({ prices: { retrieve: async () => { throw new Error("unavailable"); } } }));
  assert.equal(unavailable[0].price, null);
  assert.equal(unavailable[0].previewPrice, products[0].previewPrice);
  assert.equal(unavailable[1].price, null);
  assert.equal(unavailable[1].previewPrice, 2999);
  const unconfigured = await getPublicProducts(products, () => { throw new Error("missing key"); });
  assert.equal(unconfigured[0].price, null);
  assert.equal(unconfigured[1].price, null);
  const partial = await getPublicProducts(products, () => ({ prices: { retrieve: async (id) => {
    if (id === freedomPrice.id) throw new Error("unavailable");
    return stripePrice;
  } } }));
  assert.equal(partial[0].price, stripePrice.unit_amount);
  assert.equal(partial[1].price, null);
});

test("catalog endpoint returns Stripe pricing and surfaces Stripe failures", async () => {
  const inventory = require("../server/apparel-inventory");
  const originalInventory = inventory.inventoryForProducts;
  inventory.inventoryForProducts = async () => products.map((product) => ({
    id: product.id, active: true, quantities: Object.fromEntries(product.sizes.map((size) => [size, 10]))
  }));
  const originalStripe = stripeConfig.getStripe;
  let shouldFail = false;
  stripeConfig.getStripe = () => ({ prices: { retrieve: async (id) => {
    if (shouldFail) throw new Error("unavailable");
    return id === stripePrice.id ? stripePrice : freedomPrice;
  } } });
  delete require.cache[require.resolve("../api/apparel-catalog")];
  const handler = require("../api/apparel-catalog");
  try {
    const success = response();
    await handler(request("GET"), success);
    assert.equal(success.status, 200);
    assert.equal(success.body.products[0].price, stripePrice.unit_amount);
    assert.equal(success.body.products[1].price, 2999);
    assert.equal(success.headers["Cache-Control"], "no-store");
    shouldFail = true;
    const failure = response();
    await handler(request("GET"), failure);
    assert.equal(failure.status, 200);
    assert.equal(failure.body.products[0].price, null);
    assert.equal(failure.body.products[0].previewPrice, products[0].previewPrice);
    assert.equal(failure.body.products[1].price, null);
    assert.equal(failure.body.products[1].previewPrice, 2999);
  } finally {
    stripeConfig.getStripe = originalStripe;
    inventory.inventoryForProducts = originalInventory;
  }
});

test("catalog returns real product images but no availability when inventory fails", async () => {
  const inventory = require("../server/apparel-inventory");
  const originalInventory = inventory.inventoryForProducts;
  const originalStripe = stripeConfig.getStripe;
  inventory.inventoryForProducts = async () => { throw new Error("Firestore unavailable"); };
  stripeConfig.getStripe = () => ({ prices: { retrieve: async (id) => id === stripePrice.id ? stripePrice : freedomPrice } });
  delete require.cache[require.resolve("../api/apparel-catalog")];
  const handler = require("../api/apparel-catalog");
  try {
    const res = response();
    await handler(request("GET"), res);
    assert.equal(res.status, 503);
    assert.match(res.body.error, /shopping is disabled/i);
    assert.deepEqual(res.body.products.map((product) => product.images), products.map((product) => product.images));
    assert.ok(res.body.products.every((product) => product.availabilityUnavailable && product.inventory === undefined));
  } finally {
    inventory.inventoryForProducts = originalInventory;
    stripeConfig.getStripe = originalStripe;
    delete require.cache[require.resolve("../api/apparel-catalog")];
  }
});

test("variant metadata preserves size, color, and quantities within Stripe limits", () => {
  const items = Array.from({ length: 100 }, (_, i) => ({
    product: products[i % 2], size: "XXXL", color: "Charcoal", quantity: 20
  }));
  const metadata = cartMetadata(items);
  const variants = Object.entries(metadata).filter(([key]) => key.startsWith("variants_"));
  assert.ok(Object.keys(metadata).length <= 50);
  assert.ok(variants.every(([, value]) => value.length <= 500));
  assert.deepEqual(variants.flatMap(([, value]) => JSON.parse(value)), items.map(({ product, size, color, quantity }) => [product.id, size, color, quantity]));
});

test("checkout ignores client price and uses the configured return origin", async () => {
  const inventory = require("../server/apparel-inventory");
  const originalCheck = inventory.checkAvailability;
  inventory.checkAvailability = async () => {};
  const previousEnabled = process.env.APPAREL_LIVE_CHECKOUT_ENABLED;
  process.env.APPAREL_LIVE_CHECKOUT_ENABLED = "true";
  const originalStripe = stripeConfig.getStripe;
  const originalSite = stripeConfig.getSiteUrl;
  let params;
  let liveMode = true;
  let retrievedPrice = stripePrice;
  stripeConfig.getStripe = () => ({ prices: { retrieve: async (id) => id === freedomPrice.id ? freedomPrice : retrievedPrice }, checkout: { sessions: { create: async (value) => {
    params = value; return { url: "https://checkout.stripe.com/live", livemode: liveMode };
  } } } });
  stripeConfig.getSiteUrl = () => new URL("https://example.com/subsite/");
  delete require.cache[require.resolve("../api/apparel-checkout")];
  const handler = require("../api/apparel-checkout");
  try {
    delete process.env.APPAREL_LIVE_CHECKOUT_ENABLED;
    const disabled = response();
    await handler(request("POST", JSON.stringify({ items: [item] })), disabled);
    assert.equal(disabled.status, 503);
    process.env.APPAREL_LIVE_CHECKOUT_ENABLED = "true";
    const res = response();
    await handler(request("POST", JSON.stringify({ items: [{ ...item, price: 1 }] })), res);
    assert.equal(res.status, 200);
    assert.equal(params.line_items[0].price_data.unit_amount, products[0].previewPrice);
    assert.match(params.line_items[0].price_data.product_data.name, /XL \/ Black/);
    assert.equal(params.line_items[0].price_data.product_data.description, products[0].description);
    assert.equal(params.line_items[0].quantity, 2);
    assert.deepEqual(params.shipping_address_collection.allowed_countries, ["US"]);
    assert.equal(params.phone_number_collection.enabled, true);
    assert.equal(params.shipping_options[0].shipping_rate_data.fixed_amount.amount, 599);
    assert.equal(params.metadata.storefront, "wave-apparel-v1");
    assert.deepEqual(JSON.parse(params.metadata.variants_1), [[products[0].id, "XL", "Black", 2]]);
    assert.equal(params.success_url, "https://example.com/subsite/apparel-success.html?session_id={CHECKOUT_SESSION_ID}");
    assert.equal(params.cancel_url, "https://example.com/subsite/apparel-cancel.html");
    const invalid = response();
    await handler(request("POST", JSON.stringify({ items: [{ ...item, size: "invalid" }] })), invalid);
    assert.equal(invalid.status, 400);
    retrievedPrice = { ...stripePrice, active: false };
    const inactive = response();
    await handler(request("POST", JSON.stringify({ items: [item] })), inactive);
    assert.equal(inactive.status, 503);
    retrievedPrice = stripePrice;
    const freedom = response();
    await handler(request("POST", JSON.stringify({ items: [{ id: products[1].id, size: "S", color: "Black", quantity: 1, price: 1 }] })), freedom);
    assert.equal(freedom.status, 200);
    assert.equal(params.line_items[0].price_data.unit_amount, freedomPrice.unit_amount);
    assert.equal(params.line_items[0].quantity, 1);
    assert.deepEqual(JSON.parse(params.metadata.variants_1), [[products[1].id, "S", "Black", 1]]);
    const mixed = response();
    await handler(request("POST", JSON.stringify({ items: [item, { id: products[1].id, size: "S", color: "Black", quantity: 1 }] })), mixed);
    assert.equal(mixed.status, 200);
    assert.deepEqual(params.line_items.map((line) => line.price_data.unit_amount), [products[0].previewPrice, 2999]);
    assert.equal(params.shipping_options[0].shipping_rate_data.fixed_amount.amount, 0);
    const three = response();
    await handler(request("POST", JSON.stringify({ items: [{ ...item, quantity: 3 }] })), three);
    assert.equal(three.status, 200);
    assert.equal(params.shipping_options[0].shipping_rate_data.fixed_amount.amount, 0);
    const four = response();
    await handler(request("POST", JSON.stringify({ items: [{ ...item, quantity: 4 }] })), four);
    assert.equal(four.status, 200);
    assert.equal(params.shipping_options[0].shipping_rate_data.fixed_amount.amount, 0);
    liveMode = false;
    const nonLive = response();
    await handler(request("POST", JSON.stringify({ items: [item] })), nonLive);
    assert.equal(nonLive.status, 503);
  } finally {
    stripeConfig.getStripe = originalStripe;
    stripeConfig.getSiteUrl = originalSite;
    inventory.checkAvailability = originalCheck;
    if (previousEnabled === undefined) delete process.env.APPAREL_LIVE_CHECKOUT_ENABLED; else process.env.APPAREL_LIVE_CHECKOUT_ENABLED = previousEnabled;
  }
});

test("shipping threshold uses the pre-tax merchandise subtotal", () => {
  assert.equal(shippingForSubtotal(7497), 599);
  assert.equal(shippingForSubtotal(7499), 599);
  assert.equal(shippingForSubtotal(7500), 0);
  assert.equal(shippingForSubtotal(7997), 0);
});

test("test mode uses test prices and accepts only test sessions", async () => {
  const inventory = require("../server/apparel-inventory");
  const originalCheck = inventory.checkAvailability;
  inventory.checkAvailability = async () => {};
  const previous = {
    mode: process.env.APPAREL_STRIPE_MODE,
    price: process.env.APPAREL_TEST_PRICE_FREEDOM_1,
    enabled: process.env.APPAREL_LIVE_CHECKOUT_ENABLED
  };
  const originalStripe = stripeConfig.getStripe;
  const originalSite = stripeConfig.getSiteUrl;
  process.env.APPAREL_STRIPE_MODE = "test";
  process.env.APPAREL_TEST_PRICE_FREEDOM_1 = "price_testOriginal";
  delete process.env.APPAREL_LIVE_CHECKOUT_ENABLED;
  let params;
  stripeConfig.getStripe = () => ({
    prices: { retrieve: async (id) => ({ ...stripePrice, id, livemode: false }) },
    checkout: { sessions: { create: async (value) => { params = value; return { url: "https://checkout.stripe.com/test", livemode: false }; } } }
  });
  stripeConfig.getSiteUrl = () => new URL("http://127.0.0.1:5500/");
  delete require.cache[require.resolve("../api/apparel-checkout")];
  const handler = require("../api/apparel-checkout");
  try {
    const res = response();
    await handler(request("POST", JSON.stringify({ items: [item] })), res);
    assert.equal(res.status, 200);
    assert.equal(params.line_items[0].price_data.unit_amount, products[0].previewPrice);
    assert.equal(params.shipping_options[0].shipping_rate_data.fixed_amount.amount, 599);
  } finally {
    stripeConfig.getStripe = originalStripe;
    stripeConfig.getSiteUrl = originalSite;
    inventory.checkAvailability = originalCheck;
    for (const [key, value] of Object.entries({
      APPAREL_STRIPE_MODE: previous.mode,
      APPAREL_TEST_PRICE_FREEDOM_1: previous.price,
      APPAREL_LIVE_CHECKOUT_ENABLED: previous.enabled
    })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test("Stripe keys must match the configured mode and unsafe return URLs are rejected", () => {
  const previousKey = process.env.STRIPE_SECRET_KEY;
  const previousSite = process.env.APPAREL_SITE_URL;
  const previousMode = process.env.APPAREL_STRIPE_MODE;
  try {
    delete process.env.APPAREL_STRIPE_MODE;
    process.env.STRIPE_SECRET_KEY = "sk_test_example";
    assert.throws(() => stripeConfig.getStripe(), /live mode/);
    process.env.APPAREL_STRIPE_MODE = "test";
    assert.ok(stripeConfig.getStripe());
    process.env.APPAREL_STRIPE_MODE = "live";
    process.env.STRIPE_SECRET_KEY = "sk_live_example";
    assert.ok(stripeConfig.getStripe());
    process.env.STRIPE_SECRET_KEY = "rk_live_example";
    assert.ok(stripeConfig.getStripe());
    process.env.APPAREL_SITE_URL = "http://example.com/";
    assert.throws(() => stripeConfig.getSiteUrl(), /HTTPS/);
    process.env.APPAREL_SITE_URL = "http://127.0.0.1:4173/";
    assert.equal(stripeConfig.getSiteUrl().host, "127.0.0.1:4173");
  } finally {
    if (previousKey === undefined) delete process.env.STRIPE_SECRET_KEY; else process.env.STRIPE_SECRET_KEY = previousKey;
    if (previousSite === undefined) delete process.env.APPAREL_SITE_URL; else process.env.APPAREL_SITE_URL = previousSite;
    if (previousMode === undefined) delete process.env.APPAREL_STRIPE_MODE; else process.env.APPAREL_STRIPE_MODE = previousMode;
  }
});

test("order confirmation reports paid only for a verified live session", async () => {
  const originalStripe = stripeConfig.getStripe;
  let session = { livemode: true, payment_status: "paid", metadata: { storefront: "wave-apparel-v1" } };
  stripeConfig.getStripe = () => ({ checkout: { sessions: { retrieve: async () => session } } });
  delete require.cache[require.resolve("../api/apparel-order-status")];
  const handler = require("../api/apparel-order-status");
  try {
    const paid = response();
    await handler(request("GET", "", {}, "/api/apparel-order-status?session_id=cs_live_example"), paid);
    assert.deepEqual(paid.body, { mode: "live", paid: true });
    assert.equal(paid.headers["Cache-Control"], "no-store");
    session = { livemode: true, payment_status: "unpaid", metadata: { storefront: "wave-apparel-v1" } };
    const pending = response();
    await handler(request("GET", "", {}, "/api/apparel-order-status?session_id=cs_live_example"), pending);
    assert.deepEqual(pending.body, { mode: "live", paid: false });
    session = { livemode: false, payment_status: "paid", metadata: { storefront: "wave-apparel-v1" } };
    const testSession = response();
    await handler(request("GET", "", {}, "/api/apparel-order-status?session_id=cs_live_example"), testSession);
    assert.deepEqual(testSession.body, { mode: "live", paid: false });
    session = { livemode: true, payment_status: "paid", metadata: {} };
    const unrelated = response();
    await handler(request("GET", "", {}, "/api/apparel-order-status?session_id=cs_live_example"), unrelated);
    assert.deepEqual(unrelated.body, { mode: "live", paid: false });
    const invalid = response();
    await handler(request("GET", "", {}, "/api/apparel-order-status?session_id=cs_test_example"), invalid);
    assert.equal(invalid.status, 400);
    const previousMode = process.env.APPAREL_STRIPE_MODE;
    try {
      process.env.APPAREL_STRIPE_MODE = "test";
      session = { livemode: false, payment_status: "paid", metadata: { storefront: "wave-apparel-v1" } };
      const verifiedTest = response();
      await handler(request("GET", "", {}, "/api/apparel-order-status?session_id=cs_test_example"), verifiedTest);
      assert.deepEqual(verifiedTest.body, { mode: "test", paid: true });
      const wrongMode = response();
      await handler(request("GET", "", {}, "/api/apparel-order-status?session_id=cs_live_example"), wrongMode);
      assert.equal(wrongMode.status, 400);
    } finally {
      if (previousMode === undefined) delete process.env.APPAREL_STRIPE_MODE; else process.env.APPAREL_STRIPE_MODE = previousMode;
    }
  } finally {
    stripeConfig.getStripe = originalStripe;
  }
});

test("webhook verifies signatures, retrieves paid sessions, and rejects wrong modes", async () => {
  const previousKey = process.env.STRIPE_SECRET_KEY;
  const previousSecret = process.env.STRIPE_WEBHOOK_SECRET;
  process.env.STRIPE_SECRET_KEY = "sk_live_example";
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_example";
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  const originalStripe = stripeConfig.getStripe;
  let session = {
    id: "cs_live_example", livemode: true, payment_status: "paid", metadata: { storefront: "wave-apparel-v1" },
    collected_information: { shipping_details: { name: "Customer", address: { line1: "1 Main St", city: "City", state: "CA", postal_code: "90210", country: "US" } } }
  };
  stripeConfig.getStripe = () => ({ webhooks: stripe.webhooks, checkout: { sessions: { retrieve: async () => session } } });
  delete require.cache[require.resolve("../api/apparel-webhook")];
  const handler = require("../api/apparel-webhook");
  const payload = JSON.stringify({ id: "evt_live_example", type: "checkout.session.completed", livemode: true, data: { object: { id: "cs_live_example", payment_status: "paid", metadata: { storefront: "wave-apparel-v1" } } } });
  const signature = stripe.webhooks.generateTestHeaderString({ payload, secret: process.env.STRIPE_WEBHOOK_SECRET });
  try {
    const valid = response();
    await handler(request("POST", payload, { "stripe-signature": signature }), valid);
    assert.equal(valid.status, 200);
    const duplicate = response();
    await handler(request("POST", payload, { "stripe-signature": signature }), duplicate);
    assert.equal(duplicate.status, 200);
    session.collected_information.shipping_details = null;
    const missingAddress = response();
    await handler(request("POST", payload, { "stripe-signature": signature }), missingAddress);
    assert.equal(missingAddress.status, 503);
    session.payment_status = "unpaid";
    const pending = response();
    await handler(request("POST", payload, { "stripe-signature": signature }), pending);
    assert.equal(pending.status, 200);
    for (const type of ["checkout.session.async_payment_succeeded", "checkout.session.async_payment_failed"]) {
      const asyncPayload = payload.replace("checkout.session.completed", type);
      const asyncSignature = stripe.webhooks.generateTestHeaderString({ payload: asyncPayload, secret: process.env.STRIPE_WEBHOOK_SECRET });
      const asyncResponse = response();
      await handler(request("POST", asyncPayload, { "stripe-signature": asyncSignature }), asyncResponse);
      assert.equal(asyncResponse.status, 200);
    }
    const invalid = response();
    await handler(request("POST", payload, { "stripe-signature": "invalid" }), invalid);
    assert.equal(invalid.status, 400);
    const testPayload = payload.replace('"livemode":true', '"livemode":false');
    const testSignature = stripe.webhooks.generateTestHeaderString({ payload: testPayload, secret: process.env.STRIPE_WEBHOOK_SECRET });
    const testEvent = response();
    await handler(request("POST", testPayload, { "stripe-signature": testSignature }), testEvent);
    assert.equal(testEvent.status, 400);
  } finally {
    stripeConfig.getStripe = originalStripe;
    if (previousKey === undefined) delete process.env.STRIPE_SECRET_KEY; else process.env.STRIPE_SECRET_KEY = previousKey;
    if (previousSecret === undefined) delete process.env.STRIPE_WEBHOOK_SECRET; else process.env.STRIPE_WEBHOOK_SECRET = previousSecret;
  }
});

test("order review retains variants, address and Stripe totals", () => {
  const { orderFromSession } = require("../server/apparel-orders");
  const session = {
    id: "cs_test_example", livemode: false, created: 1700000000, payment_status: "paid",
    payment_intent: "pi_test_example", currency: "usd", amount_subtotal: 7997, amount_total: 7997,
    total_details: { amount_tax: 0, amount_shipping: 0 },
    customer_details: { email: "customer@example.test", phone: null },
    collected_information: { shipping_details: { name: "Customer", address: { line1: "1 Main St", line2: "Unit 2", city: "City", state: "CA", postal_code: "90210", country: "US" } } },
    metadata: cartMetadata(validateCart([item, { id: products[1].id, size: "S", color: "Black", quantity: 1 }]))
  };
  const lines = [{ description: "Original", quantity: 2, amount_total: 4998 }, { description: "Freedom", quantity: 1, amount_total: 2999 }];
  const order = orderFromSession(session, lines);
  assert.equal(order.mode, "test");
  assert.equal(order.customer.shippingAddress.line2, "Unit 2");
  assert.deepEqual(order.items, [
    { design: products[0].id, size: "XL", color: "Black", quantity: 2 },
    { design: products[1].id, size: "S", color: "Black", quantity: 1 }
  ]);
  assert.equal(order.shippingCharge, 0);
  assert.equal(order.salesTax, 0);
  assert.equal(order.totalPaid, 7997);
  session.collected_information.shipping_details = null;
  assert.throws(() => orderFromSession(session, lines), /missing customer or shipping/);
});

test("order review reports incomplete paid sessions without hiding other orders", async () => {
  const { listPaidOrders } = require("../server/apparel-orders");
  const paid = {
    id: "cs_live_valid", livemode: true, created: 1700000000, payment_status: "paid",
    currency: "usd", amount_subtotal: 2499, amount_total: 3098,
    total_details: { amount_tax: 0, amount_shipping: 599 },
    customer_details: { email: "customer@example.test" },
    collected_information: { shipping_details: { name: "Customer", address: { line1: "1 Main St", city: "City", state: "CA", postal_code: "90210", country: "US" } } },
    metadata: cartMetadata(validateCart([{ ...item, quantity: 1 }]))
  };
  const stripe = { checkout: { sessions: {
    async *list() {
      yield paid;
      yield { ...paid, id: "cs_live_missing", collected_information: null };
      yield { ...paid, id: "cs_live_unpaid", payment_status: "unpaid" };
      yield { ...paid, id: "cs_test_paid", livemode: false };
    },
    async *listLineItems() { yield { description: "Original", quantity: 1, amount_total: 2499 }; }
  } } };
  const report = await listPaidOrders(stripe);
  assert.equal(report.mode, "live");
  assert.deepEqual(report.orders.map((order) => order.sessionId), ["cs_live_valid"]);
  assert.deepEqual(report.review.map((order) => order.sessionId), ["cs_live_missing"]);
});
