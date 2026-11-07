const { readJsonBody, sendJson, setCorsHeaders } = require("../server/api-utils");
const { validateCart } = require("../server/apparel-catalog");
const { getStripe, getSiteUrl } = require("../server/apparel-stripe");
const { validateStripePrice, cartMetadata } = require("../server/apparel-pricing");

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
    const site = getSiteUrl();
    const stripe = getStripe();
    const stripePrices = new Map();
    for (const { product } of items) {
      if (product.stripePriceId && !stripePrices.has(product.stripePriceId)) {
        const price = await stripe.prices.retrieve(product.stripePriceId);
        validateStripePrice(price, product);
        stripePrices.set(product.stripePriceId, price);
      }
    }
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      metadata: cartMetadata(items),
      custom_text: {
        submit: { message: "This is a real payment. No apparel will be shipped or fulfilled." }
      },
      line_items: items.map(({ product, size, color, quantity }) => product.stripePriceId ? ({
        price: product.stripePriceId,
        quantity
      }) : ({
        price_data: {
          currency: product.currency,
          unit_amount: product.price,
          product_data: { name: product.name, description: `Size: ${size} | Color: ${color}` }
        },
        quantity
      })),
      success_url: new URL("apparel-success.html?session_id={CHECKOUT_SESSION_ID}", site).href.replace("%7BCHECKOUT_SESSION_ID%7D", "{CHECKOUT_SESSION_ID}"),
      cancel_url: new URL("apparel-cancel.html", site).href
    });
    if (!session.url || session.livemode !== true) throw new Error("Stripe did not return a live checkout session.");
    sendJson(response, 200, { url: session.url });
  } catch (error) {
    console.error("Apparel checkout error:", error.message);
    sendJson(response, 503, { error: "Checkout is unavailable. Please try again later." });
  }
};
module.exports.config = { api: { bodyParser: false } };
