const { sendJson, setCorsHeaders } = require("./api-utils");

module.exports = (request, response) => {
  if (request.method === "OPTIONS") {
    setCorsHeaders(response);
    response.writeHead(204);
    return response.end();
  }
  if (request.method !== "GET") return sendJson(response, 405, { error: "Method not allowed." });
  if (!process.env.FIREBASE_STORAGE_BUCKET) return sendJson(response, 503, { error: "Music storage is not configured." });
  return sendJson(response, 200, { storageBucket: process.env.FIREBASE_STORAGE_BUCKET });
};
