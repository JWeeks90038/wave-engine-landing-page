const { readRawBody, sendJson } = require("../server/api-utils");
const { getStripe, getMode } = require("../server/apparel-stripe");

// Stripe signature verification requires the original bytes, not parsed JSON.
module.exports = async (request, response) => {
  if (request.method !== "POST") return sendJson(response, 405, { error: "Method not allowed." });
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    console.error("Apparel webhook secret is not configured.");
    return sendJson(response, 503, { error: "Webhook is not configured." });
  }
  let event;
  let stripe;
  try {
    const raw = await readRawBody(request);
    stripe = getStripe();
    event = stripe.webhooks.constructEvent(raw, request.headers["stripe-signature"], secret);
  } catch (error) {
    console.error("Apparel webhook verification failed:", error.message);
    return sendJson(response, error.statusCode || 400, { error: "Invalid webhook." });
  }
  if (event.livemode !== (getMode() === "live")) return sendJson(response, 400, { error: "Webhook mode mismatch." });
  if (["checkout.session.completed", "checkout.session.async_payment_succeeded", "checkout.session.async_payment_failed"].includes(event.type)) {
    try {
      const session = await stripe.checkout.sessions.retrieve(event.data.object.id);
      if (session.livemode !== event.livemode) throw new Error("Checkout session mode mismatch.");
      if (session.metadata?.storefront === "wave-apparel-v1") {
        if (event.type !== "checkout.session.async_payment_failed" && session.payment_status === "paid") {
          const shipping = session.collected_information?.shipping_details || session.shipping_details;
          const address = shipping?.address;
          if (!shipping?.name || !address?.line1 || !address.city || !address.state ||
              !address.postal_code || address.country !== "US") {
            throw new Error("Paid apparel session is missing required US shipping details.");
          }
          console.log("Verified apparel payment:", event.id, session.id);
        } else {
          console.log("Apparel payment not confirmed:", event.id, session.id);
        }
      }
    } catch (error) {
      console.error("Apparel webhook processing failed:", error.message);
      return sendJson(response, 503, { error: "Webhook processing failed." });
    }
  }
  sendJson(response, 200, { received: true });
};
module.exports.config = { api: { bodyParser: false } };
