const { sendJson } = require("../server/api-utils");
const library = require("../server/music-library-handler");
const file = require("../server/music-file-handler");
const config = require("../server/music-config-handler");
const checkout = require("../server/music-checkout-handler");
const purchase = require("../server/music-purchase-handler");
const albums = require("../server/music-albums-handler");
const { createHandler: createStreamCountHandler } = require("../server/song-stream-counts");
const countStream = createStreamCountHandler("music");

module.exports = (request, response) => {
  const action = new URL(request.url, "http://localhost").searchParams.get("action");
  if (action === "library") return library(request, response);
  if (action === "file") return file(request, response);
  if (action === "config") return config(request, response);
  if (action === "checkout") return checkout(request, response);
  if (action === "purchase") return purchase(request, response);
  if (["albums", "album-cover", "album-checkout", "album-purchase", "album-download"].includes(action)) return albums(request, response);
  if (action === "count-stream") return countStream(request, response);
  return sendJson(response, 404, { error: "Music endpoint not found." });
};
module.exports.config = { api: { bodyParser: false } };
