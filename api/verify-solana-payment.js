const { readJsonBody, sendJson, setCorsHeaders } = require("../server/api-utils");
const { verifySolanaPayment } = require("../server/payment-service");
const { resolveUserSession } = require("../server/session-service");

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
    const packId = typeof body.packId === "string" ? body.packId : "";
    const signature = typeof body.signature === "string" ? body.signature : "";
    const walletAddress = typeof body.walletAddress === "string" ? body.walletAddress : "";

    const result = await verifySolanaPayment({
      packId,
      signature,
      walletAddress,
      userId: session.userId
    });

    sendJson(response, 200, {
      ...result,
      userId: session.userId,
      userToken: session.userToken
    });
  } catch (error) {
    sendJson(response, error instanceof SyntaxError ? 400 : error.statusCode || 500, {
      error:
        error instanceof SyntaxError
          ? "The request payload was invalid JSON."
          : error.message || "The Solana payment could not be verified."
    });
  }
};