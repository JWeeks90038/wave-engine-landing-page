const { sendJson, setCorsHeaders } = require("../server/api-utils");
const music = require("../server/music-library");

function createHandler({ database, publicTrack } = music) {
  return async (request, response) => {
  if (request.method === "OPTIONS") {
    setCorsHeaders(response);
    response.writeHead(204);
    return response.end();
  }
  if (request.method !== "GET") return sendJson(response, 405, { error: "Method not allowed." });
  try {
    const snapshot = await database().collection("musicTracks").where("published", "==", true).get();
    const tracks = snapshot.docs.map(publicTrack).sort((a, b) =>
      (Number(a.sortOrder) || 0) - (Number(b.sortOrder) || 0) || a.title.localeCompare(b.title));
    response.setHeader("Cache-Control", "no-store");
    return sendJson(response, 200, { tracks });
  } catch (error) {
    console.error("Music library error:", error.message);
    return sendJson(response, 503, { error: "The music library could not be loaded. Please try again later." });
  }
  };
}
module.exports = createHandler();
module.exports.createHandler = createHandler;
