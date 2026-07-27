const APP_CONFIG = {
  payment: {
    provider: "native-solana",
    network: "Solana",
    currency: "SOL",
    rpcEndpoint: process.env.SOLANA_RPC_ENDPOINT || "https://api.mainnet-beta.solana.com",
    receiverWallet: process.env.SOLANA_RECEIVER_WALLET || "REPLACE_WITH_SOLANA_RECEIVER_WALLET",
    commitment: process.env.SOLANA_COMMITMENT || "confirmed",
    creditPacks: [
      {
        id: "starter",
        name: "Starter",
        amountSol: "0.05",
        lamports: 50000000,
        displayPrice: "0.05 SOL",
        credits: 50
      },
      {
        id: "professional",
        name: "Professional",
        amountSol: "0.10",
        lamports: 100000000,
        displayPrice: "0.10 SOL",
        credits: 120
      },
      {
        id: "studio",
        name: "Studio",
        amountSol: "0.25",
        lamports: 250000000,
        displayPrice: "0.25 SOL",
        credits: 350
      }
    ]
  },
  imageCosts: {
    default: 1,
    highResolution: 2
  },
  defaults: {
    imageCostKey: "default"
  }
};

function getCreditPack(packId) {
  return APP_CONFIG.payment.creditPacks.find((pack) => pack.id === packId) || null;
}

function getImageCost(costKey) {
  return APP_CONFIG.imageCosts[costKey] || APP_CONFIG.imageCosts[APP_CONFIG.defaults.imageCostKey];
}

module.exports = {
  APP_CONFIG,
  getCreditPack,
  getImageCost
};