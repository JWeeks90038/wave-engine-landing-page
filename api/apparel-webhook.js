const { readRawBody, sendJson } = require("../server/api-utils");
const { getStripe } = require("../server/apparel-stripe");

// Stripe signature verification requires the original bytes, not parsed JSON.
module.exports = async (request, response) => {
  if (request.method !== "POST") return sendJson(response, 405, { error: "Method not allowed." });
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    console.error("Apparel webhook secret is not configured.");
    return sendJson(response, 503, { error: "Webhook is not configured." });
  }
  let event;
  try {
    const raw = await readRawBody(request);
    event = getStripe().webhooks.constructEvent(raw, request.headers["stripe-signature"], secret);
  } catch (error) {
    console.error("Apparel webhook verification failed:", error.message);
    return sendJson(response, error.statusCode || 400, { error: "Invalid webhook." });
  }
  if (!event.livemode) return sendJson(response, 400, { error: "Test events are not accepted." });
  if (["checkout.session.completed", "checkout.session.async_payment_succeeded"].includes(event.type) &&
      event.data.object.metadata?.storefront === "wave-apparel-v1" &&
      event.data.object.payment_status === "paid") {
    // This is an audit signal only, not durable order storage or fulfillment.
    console.log("Verified live apparel payment:", event.id, event.data.object.id);
  }
  sendJson(response, 200, { received: true });
};
module.exports.config = { api: { bodyParser: false } };
