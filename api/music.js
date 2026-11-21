const { sendJson } = require("../server/api-utils");
const library = require("../server/music-library-handler");
const file = require("../server/music-file-handler");
const config = require("../server/music-config-handler");

module.exports = (request, response) => {
  const action = new URL(request.url, "http://localhost").searchParams.get("action");
  if (action === "library") return library(request, response);
  if (action === "file") return file(request, response);
  if (action === "config") return config(request, response);
  return sendJson(response, 404, { error: "Music endpoint not found." });
};
