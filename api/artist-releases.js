const releases = require("../server/artist-releases-handler");
const payments = require("../server/artist-payments").createHandler();

module.exports = (request, response) => {
  const action = new URL(request.url, "http://localhost").searchParams.get("action");
  return ["connect", "checkout", "purchase", "download", "contribute", "contribution-status"].includes(action)
    ? payments(request, response) : releases(request, response);
};
module.exports.config = { api: { bodyParser: false } };
