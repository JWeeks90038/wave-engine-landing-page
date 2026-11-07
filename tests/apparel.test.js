const test = require("node:test");
const assert = require("node:assert/strict");
const { Readable } = require("node:stream");
const Stripe = require("stripe");
const { products, validateCart } = require("../server/apparel-catalog");
const stripeConfig = require("../server/apparel-stripe");
const { validateStripePrice, getPublicProducts, cartMetadata } = require("../server/apparel-pricing");

function request(method, body, headers = {}, url = "/") {
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
const item = { id: "original", size: "XL", color: "Black", quantity: 2 };
const stripePrice = { id: products[0].stripePriceId, livemode: true, active: true, type: "one_time", currency: "usd", unit_amount: 4500, billing_scheme: "per_unit", tax_behavior: "unspecified" };

test("catalog has two products with three distinct image paths and all requested sizes", () => {
  assert.equal(products.length, 2);
  for (const product of products) {
    assert.deepEqual(product.sizes, ["S", "M", "L", "XL", "XXL", "XXXL"]);
    assert.equal(new Set(product.images.map((image) => image.src)).size, 3);
    for (const image of product.images) assert.ok(require("node:fs").existsSync(image.src));
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
  const stripe = { prices: { retrieve: async () => stripePrice } };
  const publicProducts = await getPublicProducts(products, () => stripe);
  assert.equal(publicProducts[0].price, 4500);
  assert.equal(publicProducts[0].stripePriceId, undefined);
  assert.equal(publicProducts[0].previewPrice, undefined);
  assert.equal(publicProducts[1].price, 3400);
  for (const invalid of [
    { active: false }, { livemode: false }, { type: "recurring" }, { currency: "eur" },
    { unit_amount: null }, { billing_scheme: "tiered" }, { transform_quantity: {} },
    { custom_unit_amount: {} }, { tax_behavior: "inclusive" }, { id: "price_wrong" }
  ]) assert.throws(() => validateStripePrice({ ...stripePrice, ...invalid }, products[0]));
  const unavailable = await getPublicProducts(products, () => ({ prices: { retrieve: async () => { throw new Error("unavailable"); } } }));
  assert.equal(unavailable[0].price, null);
  assert.equal(unavailable[0].previewPrice, 2500);
  assert.equal(unavailable[1].price, 3400);
  const unconfigured = await getPublicProducts(products, () => { throw new Error("missing key"); });
  assert.equal(unconfigured[0].price, null);
  assert.equal(unconfigured[1].price, 3400);
});

test("catalog endpoint returns Stripe pricing and surfaces Stripe failures", async () => {
  const originalStripe = stripeConfig.getStripe;
  let shouldFail = false;
  stripeConfig.getStripe = () => ({ prices: { retrieve: async () => {
    if (shouldFail) throw new Error("unavailable");
    return stripePrice;
  } } });
  delete require.cache[require.resolve("../api/apparel-catalog")];
  const handler = require("../api/apparel-catalog");
  try {
    const success = response();
    await handler(request("GET"), success);
    assert.equal(success.status, 200);
    assert.equal(success.body.products[0].price, stripePrice.unit_amount);
    assert.equal(success.headers["Cache-Control"], "no-store");
    shouldFail = true;
    const failure = response();
    await handler(request("GET"), failure);
    assert.equal(failure.status, 200);
    assert.equal(failure.body.products[0].price, null);
    assert.equal(failure.body.products[0].previewPrice, 2500);
    assert.equal(failure.body.products[1].price, 3400);
  } finally {
    stripeConfig.getStripe = originalStripe;
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
  const originalStripe = stripeConfig.getStripe;
  const originalSite = stripeConfig.getSiteUrl;
  let params;
  let liveMode = true;
  let retrievedPrice = stripePrice;
  stripeConfig.getStripe = () => ({ prices: { retrieve: async () => retrievedPrice }, checkout: { sessions: { create: async (value) => {
    params = value; return { url: "https://checkout.stripe.com/live", livemode: liveMode };
  } } } });
  stripeConfig.getSiteUrl = () => new URL("https://example.com/subsite/");
  delete require.cache[require.resolve("../api/apparel-checkout")];
  const handler = require("../api/apparel-checkout");
  try {
    const res = response();
    await handler(request("POST", JSON.stringify({ items: [{ ...item, price: 1 }] })), res);
    assert.equal(res.status, 200);
    assert.equal(params.line_items[0].price, stripePrice.id);
    assert.equal(params.line_items[0].quantity, 2);
    assert.equal(params.metadata.storefront, "wave-apparel-v1");
    assert.deepEqual(JSON.parse(params.metadata.variants_1), [["original", "XL", "Black", 2]]);
    assert.match(params.custom_text.submit.message, /real payment/i);
    assert.match(params.custom_text.submit.message, /no apparel will be shipped/i);
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
    await handler(request("POST", JSON.stringify({ items: [{ id: "freedom", size: "S", color: "White", quantity: 1, price: 1 }] })), freedom);
    assert.equal(freedom.status, 200);
    assert.equal(params.line_items[0].price_data.unit_amount, 3400);
    liveMode = false;
    const nonLive = response();
    await handler(request("POST", JSON.stringify({ items: [item] })), nonLive);
    assert.equal(nonLive.status, 503);
  } finally {
    stripeConfig.getStripe = originalStripe;
    stripeConfig.getSiteUrl = originalSite;
  }
});

test("only live keys are accepted and unsafe return URLs are rejected", () => {
  const previousKey = process.env.STRIPE_SECRET_KEY;
  const previousSite = process.env.APPAREL_SITE_URL;
  try {
    process.env.STRIPE_SECRET_KEY = "sk_test_example";
    assert.throws(() => stripeConfig.getStripe(), /live mode/);
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
    assert.deepEqual(paid.body, { paid: true });
    assert.equal(paid.headers["Cache-Control"], "no-store");
    session = { livemode: true, payment_status: "unpaid", metadata: { storefront: "wave-apparel-v1" } };
    const pending = response();
    await handler(request("GET", "", {}, "/api/apparel-order-status?session_id=cs_live_example"), pending);
    assert.deepEqual(pending.body, { paid: false });
    session = { livemode: false, payment_status: "paid", metadata: { storefront: "wave-apparel-v1" } };
    const testSession = response();
    await handler(request("GET", "", {}, "/api/apparel-order-status?session_id=cs_live_example"), testSession);
    assert.deepEqual(testSession.body, { paid: false });
    session = { livemode: true, payment_status: "paid", metadata: {} };
    const unrelated = response();
    await handler(request("GET", "", {}, "/api/apparel-order-status?session_id=cs_live_example"), unrelated);
    assert.deepEqual(unrelated.body, { paid: false });
    const invalid = response();
    await handler(request("GET", "", {}, "/api/apparel-order-status?session_id=cs_test_example"), invalid);
    assert.equal(invalid.status, 400);
  } finally {
    stripeConfig.getStripe = originalStripe;
  }
});

test("webhook requires a valid Stripe signature and rejects test events", async () => {
  const previousKey = process.env.STRIPE_SECRET_KEY;
  const previousSecret = process.env.STRIPE_WEBHOOK_SECRET;
  process.env.STRIPE_SECRET_KEY = "sk_live_example";
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_example";
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  const handler = require("../api/apparel-webhook");
  const payload = JSON.stringify({ id: "evt_live_example", type: "checkout.session.completed", livemode: true, data: { object: { id: "cs_live_example", payment_status: "paid", metadata: { storefront: "wave-apparel-v1" } } } });
  const signature = stripe.webhooks.generateTestHeaderString({ payload, secret: process.env.STRIPE_WEBHOOK_SECRET });
  try {
    const valid = response();
    await handler(request("POST", payload, { "stripe-signature": signature }), valid);
    assert.equal(valid.status, 200);
    const invalid = response();
    await handler(request("POST", payload, { "stripe-signature": "invalid" }), invalid);
    assert.equal(invalid.status, 400);
    const testPayload = payload.replace('"livemode":true', '"livemode":false');
    const testSignature = stripe.webhooks.generateTestHeaderString({ payload: testPayload, secret: process.env.STRIPE_WEBHOOK_SECRET });
    const testEvent = response();
    await handler(request("POST", testPayload, { "stripe-signature": testSignature }), testEvent);
    assert.equal(testEvent.status, 400);
  } finally {
    if (previousKey === undefined) delete process.env.STRIPE_SECRET_KEY; else process.env.STRIPE_SECRET_KEY = previousKey;
    if (previousSecret === undefined) delete process.env.STRIPE_WEBHOOK_SECRET; else process.env.STRIPE_WEBHOOK_SECRET = previousSecret;
  }
});
