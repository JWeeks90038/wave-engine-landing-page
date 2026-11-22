const { sendJson, setCorsHeaders } = require("./api-utils");
const music = require("./music-library");
const { verifyPurchase, EXPIRED_DOWNLOAD_MESSAGE } = require("./music-payments");

function createHandler({ database = music.database, filePath = music.filePath, verify = verifyPurchase } = {}) {
  return async (request, response) => {
    if (request.method === "OPTIONS") {
      setCorsHeaders(response);
      response.writeHead(204);
      return response.end();
    }
    if (request.method !== "GET") return sendJson(response, 405, { error: "Method not allowed." });
    response.setHeader("Cache-Control", "private, no-store");
    try {
      const sessionId = new URL(request.url, "http://localhost").searchParams.get("session_id");
      const purchase = await verify(sessionId);
      const doc = await database().collection("musicTracks").doc(purchase.trackId).get();
      const track = doc.exists && doc.data();
      if (!track) return sendJson(response, 404, { error: "This track is no longer available. Please contact us for help." });
      const formats = ["mp3", "wav"].filter((format) => filePath(purchase.trackId, track, format));
      if (!formats.length) return sendJson(response, 404, { error: "This track is no longer available. Please contact us for help." });
      return sendJson(response, 200, { title: purchase.title, trackId: purchase.trackId, formats });
    } catch (error) {
      console.error("Music purchase error:", error.message);
      return sendJson(response, error.statusCode || 503, {
        error: error.statusCode === 410 ? EXPIRED_DOWNLOAD_MESSAGE :
          error.statusCode === 403 ? "Payment could not be verified." : "Your purchase could not be loaded. Please try again later."
      });
    }
  };
}

module.exports = createHandler();
module.exports.createHandler = createHandler;
