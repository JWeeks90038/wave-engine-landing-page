const Stripe = require("stripe");

function getMode() {
  const mode = process.env.APPAREL_STRIPE_MODE || "live";
  if (!["live", "test"].includes(mode)) throw new Error("APPAREL_STRIPE_MODE must be live or test.");
  return mode;
}

function getStripe() {
  const key = process.env.STRIPE_SECRET_KEY || "";
  if (!new RegExp(`^(sk|rk)_${getMode()}_`).test(key)) {
    throw new Error(`Stripe ${getMode()} mode requires a matching secret or restricted key.`);
  }
  return new Stripe(key);
}

function getPriceId(product) {
  if (getMode() === "live") return product.stripePriceId;
  const id = process.env[`APPAREL_TEST_PRICE_${product.id.toUpperCase()}`];
  if (!id || !/^price_[a-zA-Z0-9]+$/.test(id)) throw new Error(`Test price is not configured for ${product.id}.`);
  return id;
}

function getSiteUrl() {
  const value = process.env.APPAREL_SITE_URL;
  if (!value) throw new Error("APPAREL_SITE_URL is not configured.");
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash ||
      (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) {
    throw new Error("APPAREL_SITE_URL must be an HTTPS site URL or a localhost URL.");
  }
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url;
}

module.exports = { getStripe, getSiteUrl, getMode, getPriceId };
