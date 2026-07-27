const { getImageCost, APP_CONFIG } = require("../server/app-config");
const { readJsonBody, sendJson, setCorsHeaders } = require("../server/api-utils");
const { requestOpenAiImage } = require("../server/album-generator-service");
const { resolveUserSession } = require("../server/session-service");
const { addCredits, getUserCreditSnapshot, recordImageGeneration, useCredits } = require("../server/storage/database");

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
    const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
    const imageCostKey = typeof body.imageCostKey === "string" ? body.imageCostKey : APP_CONFIG.defaults.imageCostKey;
    const requiredCredits = getImageCost(imageCostKey);

    if (!prompt) {
      sendJson(response, 400, {
        error: "A prompt is required to generate artwork."
      });
      return;
    }

    try {
      await useCredits(session.userId, requiredCredits, {
        reason: "Album artwork generation",
        metadata: {
          imageCostKey,
          promptPreview: prompt.slice(0, 120)
        }
      });
    } catch (creditError) {
      const creditSnapshot = await getUserCreditSnapshot(session.userId);
      sendJson(response, creditError.statusCode || 402, {
        error: "You need additional credits before generating artwork.",
        creditBalance: creditSnapshot.creditBalance,
        requiredCredits,
        userId: session.userId,
        userToken: session.userToken
      });
      return;
    }

    try {
      const result = await requestOpenAiImage({
        prompt,
        apiKey: process.env.OPENAI_API_KEY
      });

      const creditSnapshot = await getUserCreditSnapshot(session.userId);

      await recordImageGeneration({
        userId: session.userId,
        prompt,
        imageCostKey,
        creditsUsed: requiredCredits
      });

      sendJson(response, 200, {
        ...result,
        creditsRemaining: creditSnapshot.creditBalance,
        userId: session.userId,
        userToken: session.userToken
      });
    } catch (generationError) {
      const refundedBalance = await addCredits(session.userId, requiredCredits, {
        reason: "Refund for failed image generation",
        type: "credit_refund",
        metadata: {
          imageCostKey,
          promptPreview: prompt.slice(0, 120)
        }
      });

      sendJson(response, generationError.statusCode || 500, {
        error: generationError.message || "The artwork could not be generated.",
        creditBalance: refundedBalance.creditBalance,
        userId: session.userId,
        userToken: session.userToken
      });
    }
  } catch (error) {
    sendJson(response, error instanceof SyntaxError ? 400 : error.statusCode || 500, {
      error:
        error instanceof SyntaxError
          ? "The request payload was invalid JSON."
          : error.message || "The artwork could not be generated."
    });
  }
};