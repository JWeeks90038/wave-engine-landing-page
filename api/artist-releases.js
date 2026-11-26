const releases = require("../server/artist-releases-handler");
const payments = require("../server/artist-payments").createHandler();
const { createHandler: createStreamCountHandler } = require("../server/song-stream-counts");
const countStream = createStreamCountHandler("artist");

module.exports = (request, response) => {
  const action = new URL(request.url, "http://localhost").searchParams.get("action");
  if (action === "count-stream") return countStream(request, response);
  return ["connect", "checkout", "purchase", "download", "contribute", "contribution-status"].includes(action)
    ? payments(request, response) : releases(request, response);
};
module.exports.config = { api: { bodyParser: false } };
