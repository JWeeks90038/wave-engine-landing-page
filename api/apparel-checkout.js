const { readJsonBody, sendJson, setCorsHeaders } = require("../server/api-utils");
const { validateCart } = require("../server/apparel-catalog");
const { getStripe, getSiteUrl, getMode, getPriceId } = require("../server/apparel-stripe");
const { validateStripePrice, cartMetadata, shippingForSubtotal } = require("../server/apparel-pricing");

module.exports = async (request, response) => {
  if (request.method === "OPTIONS") {
    setCorsHeaders(response);
    response.writeHead(204);
    response.end();
    return;
  }
  if (request.method !== "POST") return sendJson(response, 405, { error: "Method not allowed." });

  let items;
  try {
    const body = await readJsonBody(request);
    items = validateCart(body.items);
  } catch (error) {
    return sendJson(response, error.statusCode || 400, { error: error.message });
  }

  try {
    if (getMode() === "live" && process.env.APPAREL_LIVE_CHECKOUT_ENABLED !== "true") {
      throw new Error("Live apparel checkout is not enabled.");
    }
    const site = getSiteUrl();
    const stripe = getStripe();
    const stripePrices = new Map();
    for (const { product } of items) {
      if (!stripePrices.has(product.id)) {
        const price = await stripe.prices.retrieve(getPriceId(product));
        stripePrices.set(product.id, validateStripePrice(price, product));
      }
    }
    const subtotal = items.reduce((sum, { product, quantity }) => sum + stripePrices.get(product.id) * quantity, 0);
    const shipping = shippingForSubtotal(subtotal);
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      metadata: cartMetadata(items),
      shipping_address_collection: { allowed_countries: ["US"] },
      phone_number_collection: { enabled: true },
      shipping_options: [{
        shipping_rate_data: {
          type: "fixed_amount",
          fixed_amount: { amount: shipping, currency: "usd" },
          display_name: shipping ? "Standard shipping" : "Free shipping"
        }
      }],
      line_items: items.map(({ product, size, color, quantity }) => ({
        price_data: {
          currency: product.currency,
          unit_amount: stripePrices.get(product.id),
          product_data: { name: `${product.name} - ${size} / ${color}`, description: product.description }
        },
        quantity
      })),
      success_url: new URL("apparel-success.html?session_id={CHECKOUT_SESSION_ID}", site).href.replace("%7BCHECKOUT_SESSION_ID%7D", "{CHECKOUT_SESSION_ID}"),
      cancel_url: new URL("apparel-cancel.html", site).href
    });
    if (!session.url || session.livemode !== (getMode() === "live")) throw new Error("Stripe returned a checkout session in the wrong mode.");
    sendJson(response, 200, { url: session.url });
  } catch (error) {
    console.error("Apparel checkout error:", error.message);
    sendJson(response, 503, { error: "Checkout is unavailable. Please try again later." });
  }
};
module.exports.config = { api: { bodyParser: false } };
