const { APP_CONFIG, getImageCost } = require("../server/app-config");
const { readJsonBody, sendJson, setCorsHeaders } = require("../server/api-utils");
const { resolveUserSession } = require("../server/session-service");
const { useCredits } = require("../server/storage/database");

module.exports = async (request, response) => {
  if (request.method === "OPTIONS") {
    setCorsHeaders(response);
    response.writeHead(204);
    response.end();
    return;
  }

  if (request.method !== "POST") {
    sendJson(response, 405, {
      error: "Method not allowed."
    });
    return;
  }

  try {
    const session = await resolveUserSession(request, { autoCreate: true });
    const body = await readJsonBody(request);
    const imageCostKey = typeof body.imageCostKey === "string" ? body.imageCostKey : APP_CONFIG.defaults.imageCostKey;
    const amount = getImageCost(imageCostKey);
    const updatedBalance = await useCredits(session.userId, amount, {
      reason: "Manual credit usage",
      metadata: {
        imageCostKey
      }
    });

    sendJson(response, 200, {
      creditBalance: updatedBalance.creditBalance,
      usedCredits: amount,
      userId: session.userId,
      userToken: session.userToken
    });
  } catch (error) {
    sendJson(response, error instanceof SyntaxError ? 400 : error.statusCode || 500, {
      error:
        error instanceof SyntaxError
          ? "The request payload was invalid JSON."
          : error.message || "Credits could not be used."
    });
  }
};