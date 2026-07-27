const { APP_CONFIG } = require("../server/app-config");
const { sendJson, setCorsHeaders } = require("../server/api-utils");
const { getPublicPaymentConfig } = require("../server/payment-service");
const { resolveUserSession } = require("../server/session-service");
const { getUserCreditSnapshot } = require("../server/storage/database");

module.exports = async (request, response) => {
  if (request.method === "OPTIONS") {
    setCorsHeaders(response);
    response.writeHead(204);
    response.end();
    return;
  }

  if (request.method !== "GET") {
    sendJson(response, 405, {
      error: "Method not allowed."
    });
    return;
  }

  try {
    const session = await resolveUserSession(request, { autoCreate: true });
    const creditSnapshot = await getUserCreditSnapshot(session.userId);

    sendJson(response, 200, {
      ...creditSnapshot,
      userId: session.userId,
      userToken: session.userToken,
      creditPacks: APP_CONFIG.payment.creditPacks,
      imageCosts: APP_CONFIG.imageCosts,
      payment: getPublicPaymentConfig()
    });
  } catch (error) {
    sendJson(response, error.statusCode || 500, {
      error: error.message || "Credits could not be loaded."
    });
  }
};