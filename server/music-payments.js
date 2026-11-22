const Stripe = require("stripe");
const DOWNLOAD_LINK_LIFETIME_SECONDS = 10 * 60;
const EXPIRED_DOWNLOAD_MESSAGE = "This download link has expired. Please contact Wave Engine Studio for help.";

function mode() {
  const value = process.env.MUSIC_STRIPE_MODE || "live";
  if (!["live", "test"].includes(value)) throw new Error("MUSIC_STRIPE_MODE must be live or test.");
  return value;
}

function stripeClient() {
  const key = process.env.STRIPE_SECRET_KEY || "";
  if (!new RegExp(`^(sk|rk)_${mode()}_`).test(key)) {
    throw new Error(`Stripe ${mode()} mode requires a matching secret or restricted key.`);
  }
  return new Stripe(key);
}

function priceId() {
  const value = process.env.MUSIC_STRIPE_PRICE_ID || "";
  if (!/^price_[a-zA-Z0-9]+$/.test(value)) throw new Error("MUSIC_STRIPE_PRICE_ID is not configured.");
  return value;
}

function siteUrl() {
  if (!process.env.MUSIC_SITE_URL) throw new Error("MUSIC_SITE_URL is not configured.");
  const url = new URL(process.env.MUSIC_SITE_URL);
  if (url.username || url.password || url.search || url.hash ||
      (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) {
    throw new Error("MUSIC_SITE_URL must be an HTTPS site URL or a localhost URL.");
  }
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url;
}

function validatePrice(price, id, live) {
  if (!price || price.id !== id || price.livemode !== live || !price.active ||
      price.type !== "one_time" || price.currency !== "usd" || price.unit_amount !== 149 ||
      price.billing_scheme !== "per_unit" || price.custom_unit_amount || price.transform_quantity ||
      price.tax_behavior === "inclusive") {
    throw new Error("The music price must be an active, one-time $1.49 USD price.");
  }
}

function denied(message = "Payment could not be verified.") {
  const error = new Error(message);
  error.statusCode = 403;
  return error;
}

async function verifyPurchase(sessionId, stripe = stripeClient(), expectedMode = mode()) {
  if (!new RegExp(`^cs_${expectedMode}_[a-zA-Z0-9]+$`).test(sessionId || "")) {
    throw denied();
  }
  const session = await stripe.checkout.sessions.retrieve(sessionId, {
    expand: ["line_items.data.price", "payment_intent.latest_charge"]
  });
  const lines = session.line_items && session.line_items.data;
  const payment = session.payment_intent;
  const charge = payment && typeof payment === "object" && payment.latest_charge;
  if (session.mode !== "payment" || session.status !== "complete" || session.payment_status !== "paid" ||
      session.livemode !== (expectedMode === "live") || session.currency !== "usd" ||
      session.amount_subtotal !== 149 || !Number.isSafeInteger(session.amount_total) || session.amount_total < 149 ||
      !session.metadata || session.metadata.type !== "music-download-v1" ||
      !/^[a-zA-Z0-9_-]{1,128}$/.test(session.metadata.trackId || "") ||
      !Array.isArray(lines) || lines.length !== 1 || lines[0].quantity !== 1 ||
      !lines[0].price || lines[0].price.id !== session.metadata.priceId ||
      !payment || typeof payment !== "object" || payment.status !== "succeeded" ||
      !charge || typeof charge !== "object" || charge.status !== "succeeded" ||
      charge.refunded || charge.amount_refunded !== 0 || charge.disputed) {
    throw denied();
  }
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isSafeInteger(charge.created) || charge.created <= 0 || charge.created > now) {
    throw new Error("The verified charge has an invalid creation time.");
  }
  if (now >= charge.created + DOWNLOAD_LINK_LIFETIME_SECONDS) {
    const error = new Error(EXPIRED_DOWNLOAD_MESSAGE);
    error.statusCode = 410;
    throw error;
  }
  return { trackId: session.metadata.trackId, title: session.metadata.title || "Music track" };
}

module.exports = { mode, stripeClient, priceId, siteUrl, validatePrice, verifyPurchase, denied, EXPIRED_DOWNLOAD_MESSAGE };
