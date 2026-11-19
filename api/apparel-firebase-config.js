const { sendJson, setCorsHeaders } = require("../server/api-utils");

module.exports = async (request, response) => {
  if (request.method === "OPTIONS") {
    setCorsHeaders(response);
    response.writeHead(204);
    response.end();
    return;
  }
  if (request.method !== "GET") return sendJson(response, 405, { error: "Method not allowed." });
  const { FIREBASE_WEB_API_KEY, FIREBASE_AUTH_DOMAIN, FIREBASE_PROJECT_ID } = process.env;
  if (!FIREBASE_WEB_API_KEY || !FIREBASE_AUTH_DOMAIN || !FIREBASE_PROJECT_ID) {
    return sendJson(response, 503, { error: "Firebase authentication is not configured." });
  }
  return sendJson(response, 200, { apiKey: FIREBASE_WEB_API_KEY, authDomain: FIREBASE_AUTH_DOMAIN, projectId: FIREBASE_PROJECT_ID });
};
