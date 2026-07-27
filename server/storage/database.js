const crypto = require("crypto");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");

function createEmptyState() {
  return {
    users: {},
    payments: {},
    processedTransactionSignatures: {},
    creditTransactions: [],
    imageHistory: []
  };
}

function getDefaultStorePath() {
  if (process.env.WAVE_ENGINE_DATA_FILE) {
    return process.env.WAVE_ENGINE_DATA_FILE;
  }

  if (process.env.VERCEL) {
    return path.join(os.tmpdir(), "wave-engine-credit-store.json");
  }

  return path.join(process.cwd(), "server", "data", "wave-engine-credit-store.json");
}

const storeFilePath = getDefaultStorePath();

let cachedState = null;
let stateQueue = Promise.resolve();

function enqueue(operation) {
  const nextOperation = stateQueue.then(operation, operation);
  stateQueue = nextOperation.catch(() => undefined);
  return nextOperation;
}

async function persistState(state) {
  await fs.mkdir(path.dirname(storeFilePath), { recursive: true });
  await fs.writeFile(storeFilePath, JSON.stringify(state, null, 2), "utf8");
}

async function loadState() {
  if (cachedState) {
    return cachedState;
  }

  try {
    const fileContents = await fs.readFile(storeFilePath, "utf8");
    cachedState = JSON.parse(fileContents);
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }

    cachedState = createEmptyState();
    await persistState(cachedState);
  }

  return cachedState;
}

function ensureUserRecord(state, userId) {
  if (!state.users[userId]) {
    state.users[userId] = {
      id: userId,
      walletAddress: null,
      creditBalance: 0,
      totalCreditsPurchased: 0,
      totalCreditsUsed: 0,
      createdAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString()
    };
  }

  state.users[userId].lastSeenAt = new Date().toISOString();
  return state.users[userId];
}

function addCreditTransaction(state, entry) {
  state.creditTransactions.unshift({
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    ...entry
  });

  state.creditTransactions = state.creditTransactions.slice(0, 250);
}

async function withState(mutator) {
  return enqueue(async () => {
    const state = await loadState();
    const result = await mutator(state);
    await persistState(state);
    return result;
  });
}

async function createAnonymousUser() {
  return withState(async (state) => {
    const userId = crypto.randomUUID();
    const user = ensureUserRecord(state, userId);
    return { ...user };
  });
}

async function ensureUser(userId) {
  return withState(async (state) => {
    const user = ensureUserRecord(state, userId);
    return { ...user };
  });
}

async function getUserCreditSnapshot(userId) {
  return withState(async (state) => {
    const user = ensureUserRecord(state, userId);
    return {
      userId: user.id,
      walletAddress: user.walletAddress,
      creditBalance: user.creditBalance,
      totalCreditsPurchased: user.totalCreditsPurchased,
      totalCreditsUsed: user.totalCreditsUsed
    };
  });
}

async function setUserWalletAddress(userId, walletAddress) {
  return withState(async (state) => {
    const user = ensureUserRecord(state, userId);
    user.walletAddress = walletAddress;

    return {
      userId,
      walletAddress: user.walletAddress,
      creditBalance: user.creditBalance
    };
  });
}

async function addCredits(userId, amount, details) {
  return withState(async (state) => {
    const user = ensureUserRecord(state, userId);
    user.creditBalance += amount;
    user.totalCreditsPurchased += amount;

    addCreditTransaction(state, {
      userId,
      type: details.type || "credit_purchase",
      amount,
      balanceAfter: user.creditBalance,
      details: details.metadata || {},
      reason: details.reason || "Credits purchased"
    });

    return {
      userId,
      creditBalance: user.creditBalance
    };
  });
}

async function useCredits(userId, amount, details) {
  return withState(async (state) => {
    const user = ensureUserRecord(state, userId);

    if (user.creditBalance < amount) {
      const error = new Error("Insufficient credits.");
      error.statusCode = 402;
      error.creditBalance = user.creditBalance;
      throw error;
    }

    user.creditBalance -= amount;
    user.totalCreditsUsed += amount;

    addCreditTransaction(state, {
      userId,
      type: details.type || "image_generation",
      amount: -amount,
      balanceAfter: user.creditBalance,
      details: details.metadata || {},
      reason: details.reason || "Credits used"
    });

    return {
      userId,
      creditBalance: user.creditBalance
    };
  });
}

async function recordPaymentIntent(payment) {
  return withState(async (state) => {
    state.payments[payment.id] = {
      ...(state.payments[payment.id] || {}),
      ...payment,
      createdAt: state.payments[payment.id]?.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    return { ...state.payments[payment.id] };
  });
}

async function applyVerifiedSolanaPayment({ signature, packId, userId, walletAddress, credits, amountLamports, metadata }) {
  return withState(async (state) => {
    if (state.processedTransactionSignatures[signature]) {
      return {
        alreadyProcessed: true,
        creditsGranted: false,
        payment: state.payments[signature] || null,
        creditBalance: ensureUserRecord(state, userId).creditBalance
      };
    }

    state.processedTransactionSignatures[signature] = {
      processedAt: new Date().toISOString(),
      signature,
      walletAddress,
      packId
    };

    const payment = {
      ...(state.payments[signature] || {}),
      id: signature,
      signature,
      packId,
      userId,
      walletAddress,
      credits,
      amountLamports,
      status: "verified",
      provider: "native-solana",
      metadata: metadata || {},
      updatedAt: new Date().toISOString()
    };

    state.payments[signature] = payment;

    if (payment.creditsGrantedAt) {
      return {
        alreadyProcessed: false,
        creditsGranted: false,
        payment: { ...payment },
        creditBalance: ensureUserRecord(state, userId).creditBalance
      };
    }

    const user = ensureUserRecord(state, userId);
    user.walletAddress = walletAddress;
    user.creditBalance += credits;
    user.totalCreditsPurchased += credits;

    addCreditTransaction(state, {
      userId,
      type: "credit_purchase",
      amount: credits,
      balanceAfter: user.creditBalance,
      details: {
        signature,
        packId,
        walletAddress,
        provider: "native-solana"
      },
      reason: `Credits purchased via ${packId}`
    });

    state.payments[signature].creditsGrantedAt = new Date().toISOString();

    return {
      alreadyProcessed: false,
      creditsGranted: true,
      payment: { ...state.payments[signature] },
      creditBalance: user.creditBalance
    };
  });
}

async function recordImageGeneration(entry) {
  return withState(async (state) => {
    state.imageHistory.unshift({
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      ...entry
    });

    state.imageHistory = state.imageHistory.slice(0, 100);

    return state.imageHistory[0];
  });
}

module.exports = {
  addCredits,
  applyVerifiedSolanaPayment,
  createAnonymousUser,
  ensureUser,
  getUserCreditSnapshot,
  recordImageGeneration,
  recordPaymentIntent,
  setUserWalletAddress,
  useCredits
};