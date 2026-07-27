const crypto = require("crypto");
const { createAnonymousUser, ensureUser } = require("./storage/database");

const USER_ID_HEADER = "x-wave-user-id";
const USER_TOKEN_HEADER = "x-wave-user-token";

function getSessionSecret() {
  return (
    process.env.WAVE_SESSION_SECRET ||
    process.env.OPENAI_API_KEY ||
    process.env.SOLANA_RECEIVER_WALLET ||
    "wave-engine-dev-session-secret"
  );
}

function createUserToken(userId) {
  return crypto.createHmac("sha256", getSessionSecret()).update(userId).digest("hex");
}

function tokensMatch(expected, actual) {
  if (!expected || !actual) {
    return false;
  }

  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(actual);

  if (expectedBuffer.length !== actualBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(expectedBuffer, actualBuffer);
}

async function resolveUserSession(request, { autoCreate = false } = {}) {
  const userId = request.headers[USER_ID_HEADER];
  const userToken = request.headers[USER_TOKEN_HEADER];

  if (typeof userId === "string" && typeof userToken === "string") {
    const expectedToken = createUserToken(userId);

    if (tokensMatch(expectedToken, userToken)) {
      await ensureUser(userId);
      return {
        userId,
        userToken,
        isNew: false
      };
    }
  }

  if (!autoCreate) {
    return null;
  }

  const user = await createAnonymousUser();

  return {
    userId: user.id,
    userToken: createUserToken(user.id),
    isNew: true
  };
}

module.exports = {
  resolveUserSession
};