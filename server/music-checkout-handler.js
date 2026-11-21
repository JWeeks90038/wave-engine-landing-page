const { readJsonBody, sendJson, setCorsHeaders } = require("./api-utils");
const music = require("./music-library");
const payments = require("./music-payments");

function createHandler({ database = music.database, filePath = music.filePath, payment = payments } = {}) {
  return async (request, response) => {
    if (request.method === "OPTIONS") {
      setCorsHeaders(response);
      response.writeHead(204);
      return response.end();
    }
    if (request.method !== "POST") return sendJson(response, 405, { error: "Method not allowed." });
    let id;
    try {
      const body = await readJsonBody(request);
      id = body.id;
      if (typeof id !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(id)) {
        return sendJson(response, 400, { error: "Invalid music track." });
      }
    } catch (error) {
      return sendJson(response, error.statusCode || 400, { error: "Invalid checkout request." });
    }
    try {
      if (payment.mode() === "live" && process.env.MUSIC_LIVE_CHECKOUT_ENABLED !== "true") {
        throw new Error("Live music checkout is not enabled.");
      }
      const doc = await database().collection("musicTracks").doc(id).get();
      const track = doc.exists && doc.data();
      if (!track || track.published !== true || (!filePath(id, track, "mp3") && !filePath(id, track, "wav"))) {
        return sendJson(response, 404, { error: "This track is not available for purchase." });
      }
      const stripe = payment.stripeClient();
      const configuredPrice = payment.priceId();
      payment.validatePrice(await stripe.prices.retrieve(configuredPrice), configuredPrice, payment.mode() === "live");
      const site = payment.siteUrl();
      const successUrl = new URL("music-purchase?session_id={CHECKOUT_SESSION_ID}", site).href
        .replace("%7BCHECKOUT_SESSION_ID%7D", "{CHECKOUT_SESSION_ID}");
      const session = await stripe.checkout.sessions.create({
        mode: "payment",
        payment_method_types: ["card"],
        line_items: [{ price: configuredPrice, quantity: 1 }],
        metadata: { type: "music-download-v1", trackId: id, title: track.title, priceId: configuredPrice },
        custom_text: { submit: { message: `Track: ${track.title}. Personal listening only; commercial use requires a separate license.` } },
        success_url: successUrl,
        cancel_url: new URL("music", site).href
      });
      if (!session.url || session.livemode !== (payment.mode() === "live")) {
        throw new Error("Stripe returned a checkout session in the wrong mode.");
      }
      response.setHeader("Cache-Control", "no-store");
      return sendJson(response, 200, { url: session.url });
    } catch (error) {
      console.error("Music checkout error:", error.message);
      return sendJson(response, 503, { error: "Music checkout is unavailable. Please try again later." });
    }
  };
}

module.exports = createHandler();
module.exports.createHandler = createHandler;
