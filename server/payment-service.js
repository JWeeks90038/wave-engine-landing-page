const { APP_CONFIG, getCreditPack } = require("./app-config");
const { applyVerifiedSolanaPayment, setUserWalletAddress } = require("./storage/database");

function getPublicPaymentConfig() {
  return {
    provider: APP_CONFIG.payment.provider,
    network: APP_CONFIG.payment.network,
    currency: APP_CONFIG.payment.currency,
    receiverWallet: APP_CONFIG.payment.receiverWallet,
    rpcEndpoint: APP_CONFIG.payment.rpcEndpoint,
    commitment: APP_CONFIG.payment.commitment
  };
}

function getCommitmentRank(commitment) {
  const order = {
    processed: 0,
    confirmed: 1,
    finalized: 2
  };

  return order[commitment] ?? 0;
}

async function rpcRequest(method, params, fetchImpl = fetch) {
  const response = await fetchImpl(APP_CONFIG.payment.rpcEndpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: method,
      method,
      params
    })
  });

  const payload = await response.json().catch(() => null);

  if (!response.ok || payload?.error) {
    const errorMessage = payload?.error?.message || `Solana RPC request failed for ${method}.`;
    const error = new Error(errorMessage);
    error.statusCode = response.status || 502;
    throw error;
  }

  return payload.result;
}

function collectTransfersFromInstructions(instructions, walletAddress, receiverWallet) {
  return (instructions || []).reduce((sum, instruction) => {
    if (instruction?.program !== "system" || instruction?.parsed?.type !== "transfer") {
      return sum;
    }

    const info = instruction.parsed.info || {};
    const source = info.source || info.from;
    const destination = info.destination || info.to;

    if (source !== walletAddress || destination !== receiverWallet) {
      return sum;
    }

    return sum + Number(info.lamports || 0);
  }, 0);
}

function extractTransferredLamports(transactionDetails, walletAddress, receiverWallet) {
  const message = transactionDetails?.transaction?.message;
  const topLevelInstructions = message?.instructions || [];
  const innerInstructions = (transactionDetails?.meta?.innerInstructions || []).flatMap((entry) => entry.instructions || []);

  return collectTransfersFromInstructions(topLevelInstructions, walletAddress, receiverWallet) +
    collectTransfersFromInstructions(innerInstructions, walletAddress, receiverWallet);
}

async function verifySolanaPayment({ packId, signature, walletAddress, userId, fetchImpl = fetch }) {
  const pack = getCreditPack(packId);

  if (!pack) {
    const error = new Error("Unknown credit pack.");
    error.statusCode = 400;
    throw error;
  }

  if (!signature || !walletAddress) {
    const error = new Error("A wallet address and transaction signature are required.");
    error.statusCode = 400;
    throw error;
  }

  const statusResult = await rpcRequest("getSignatureStatuses", [[signature], { searchTransactionHistory: true }], fetchImpl);
  const status = statusResult?.value?.[0];

  if (!status) {
    const error = new Error("The Solana transaction could not be found yet. Please wait a moment and try again.");
    error.statusCode = 400;
    throw error;
  }

  if (status.err) {
    const error = new Error("The Solana transaction failed and could not be credited.");
    error.statusCode = 400;
    throw error;
  }

  if (getCommitmentRank(status.confirmationStatus) < getCommitmentRank(APP_CONFIG.payment.commitment)) {
    const error = new Error(`The transaction has not reached ${APP_CONFIG.payment.commitment} confirmation yet. Please try again shortly.`);
    error.statusCode = 409;
    throw error;
  }

  const transactionDetails = await rpcRequest(
    "getTransaction",
    [signature, { commitment: APP_CONFIG.payment.commitment, encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }],
    fetchImpl
  );

  if (!transactionDetails) {
    const error = new Error("The transaction details are not available yet. Please try again shortly.");
    error.statusCode = 409;
    throw error;
  }

  const transferredLamports = extractTransferredLamports(
    transactionDetails,
    walletAddress,
    APP_CONFIG.payment.receiverWallet
  );

  if (transferredLamports < pack.lamports) {
    const error = new Error("The transaction did not transfer the required SOL amount to the configured receiver wallet.");
    error.statusCode = 400;
    throw error;
  }

  await setUserWalletAddress(userId, walletAddress);

  return applyVerifiedSolanaPayment({
    signature,
    packId: pack.id,
    userId,
    walletAddress,
    credits: pack.credits,
    amountLamports: pack.lamports,
    metadata: {
      network: APP_CONFIG.payment.network,
      currency: APP_CONFIG.payment.currency,
      slot: transactionDetails.slot,
      blockTime: transactionDetails.blockTime || null
    }
  });
}

module.exports = {
  getPublicPaymentConfig,
  verifySolanaPayment
};