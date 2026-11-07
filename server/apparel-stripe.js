const Stripe = require("stripe");

function getStripe() {
  const key = process.env.STRIPE_SECRET_KEY || "";
  if (!/^(sk|rk)_live_/.test(key)) {
    throw new Error("Stripe live mode is not configured. A live secret or restricted key is required.");
  }
  return new Stripe(key);
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

module.exports = { getStripe, getSiteUrl };
