const form = document.querySelector("#album-generator-form");
const promptField = document.querySelector("#album-prompt");
const generateButton = document.querySelector("#generate-button");
const downloadButton = document.querySelector("#download-button");
const statusMessage = document.querySelector("#generator-status");
const errorMessage = document.querySelector("#generator-error");
const previewImage = document.querySelector("#preview-image");
const previewEmpty = document.querySelector("#preview-empty");
const creditBalance = document.querySelector("#credit-balance");
const creditNote = document.querySelector("#credit-note");
const creditPackGrid = document.querySelector("#credit-pack-grid");
const paymentStatus = document.querySelector("#payment-status");
const connectWalletButton = document.querySelector("#connect-wallet-button");
const walletAddress = document.querySelector("#wallet-address");

const USER_ID_STORAGE_KEY = "wave-engine-user-id";
const USER_TOKEN_STORAGE_KEY = "wave-engine-user-token";

let currentCreditBalance = 0;
let currentImageCost = 1;
let isGenerating = false;
let isCreditsLoading = true;
let currentPaymentConfig = null;
let currentWalletProvider = null;
let currentWalletName = "";
let currentWalletAddress = "";

function shortenAddress(value) {
  if (!value || value.length < 10) {
    return value || "Not connected";
  }

  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

function getAvailableWallets() {
  const wallets = [];

  if (window.phantom?.solana?.isPhantom) {
    wallets.push({ name: "Phantom", provider: window.phantom.solana });
  }

  if (window.solflare?.isSolflare) {
    wallets.push({ name: "Solflare", provider: window.solflare });
  }

  if (window.backpack?.isBackpack) {
    wallets.push({ name: "Backpack", provider: window.backpack });
  }

  if (window.backpack?.solana?.isBackpack) {
    wallets.push({ name: "Backpack", provider: window.backpack.solana });
  }

  return wallets.filter((wallet, index, list) => {
    return list.findIndex((entry) => entry.name === wallet.name) === index;
  });
}

function updateWalletDisplay() {
  if (currentWalletAddress) {
    walletAddress.textContent = shortenAddress(currentWalletAddress);
    connectWalletButton.textContent = "Connected";
    return;
  }

  walletAddress.textContent = "Not connected";
  connectWalletButton.textContent = "Connect Wallet";
}

async function connectWallet() {
  const availableWallets = getAvailableWallets();

  if (!availableWallets.length) {
    throw new Error("Install a Solana wallet such as Phantom, Solflare, or Backpack to buy credits.");
  }

  const wallet = availableWallets[0];
  const connectionResult = await wallet.provider.connect();
  const publicKey = connectionResult?.publicKey || wallet.provider.publicKey;

  if (!publicKey) {
    throw new Error("The selected wallet did not return a public key.");
  }

  currentWalletProvider = wallet.provider;
  currentWalletName = wallet.name;
  currentWalletAddress = typeof publicKey.toBase58 === "function" ? publicKey.toBase58() : String(publicKey);
  updateWalletDisplay();

  return currentWalletProvider;
}

function getConnectedWalletAddress() {
  return currentWalletAddress;
}

function getApiEndpoint() {
  // Default to localhost only during local development. Production should use a deployed backend endpoint.
  const configTag = document.querySelector('meta[name="album-generator-api"]');
  const configuredEndpoint = configTag?.content?.trim();
  const isLocalPage =
    window.location.protocol === "file:" ||
    window.location.hostname === "localhost" ||
    window.location.hostname === "127.0.0.1";

  if (isLocalPage && (!configuredEndpoint || configuredEndpoint === "/api/album-cover")) {
    return "http://127.0.0.1:8787/api/album-cover";
  }

  return configuredEndpoint || "/api/album-cover";
}

function getEndpointUrl(routePath) {
  const baseEndpoint = getApiEndpoint();
  const resolvedUrl = new URL(baseEndpoint, window.location.href);
  resolvedUrl.pathname = routePath;
  resolvedUrl.search = "";
  resolvedUrl.hash = "";
  return resolvedUrl.toString();
}

function getStoredSession() {
  return {
    userId: window.localStorage.getItem(USER_ID_STORAGE_KEY),
    userToken: window.localStorage.getItem(USER_TOKEN_STORAGE_KEY)
  };
}

function storeSession(payload) {
  if (!payload?.userId || !payload?.userToken) {
    return;
  }

  window.localStorage.setItem(USER_ID_STORAGE_KEY, payload.userId);
  window.localStorage.setItem(USER_TOKEN_STORAGE_KEY, payload.userToken);
}

function syncGenerateAvailability() {
  const hasGeneratedImage = Boolean(downloadButton.dataset.imageUrl);

  generateButton.disabled = isGenerating || isCreditsLoading || currentCreditBalance < currentImageCost;
  promptField.disabled = isGenerating;
  downloadButton.disabled = isGenerating || !hasGeneratedImage;
  generateButton.textContent = isGenerating ? "Generating artwork..." : "Generate Image";

  if (!isGenerating && currentCreditBalance < currentImageCost) {
    statusMessage.textContent = "";
  }
}

function setGeneratingState(nextState) {
  isGenerating = nextState;
  syncGenerateAvailability();

  if (nextState) {
    statusMessage.textContent = "Generating artwork...";
  }
}

function setCreditsLoading(nextState) {
  isCreditsLoading = nextState;
  syncGenerateAvailability();
}

function clearError() {
  errorMessage.hidden = true;
  errorMessage.textContent = "";
}

function showError(message) {
  errorMessage.textContent = message;
  errorMessage.hidden = false;
}

function updateCreditNote() {
  if (currentCreditBalance < currentImageCost) {
    creditNote.textContent = "You need additional credits before generating artwork.";
    return;
  }

  creditNote.textContent = `${currentImageCost} credit per standard image.`;
}

function updateCreditDisplay(payload) {
  currentCreditBalance = typeof payload.creditBalance === "number" ? payload.creditBalance : currentCreditBalance;
  currentImageCost = typeof payload.imageCosts?.default === "number" ? payload.imageCosts.default : currentImageCost;
  currentPaymentConfig = payload.payment || currentPaymentConfig;
  creditBalance.textContent = String(currentCreditBalance);
  updateCreditNote();
  syncGenerateAvailability();
}

function renderCreditPacks(packs) {
  creditPackGrid.replaceChildren();

  packs.forEach((pack) => {
    const button = document.createElement("button");
    const label = document.createElement("span");
    const meta = document.createElement("span");

    button.type = "button";
    button.className = "cta-button cta-outline credit-pack-button";
    button.dataset.packId = pack.id;

    label.className = "credit-pack-label";
    meta.className = "credit-pack-meta";

    label.textContent = `Buy ${pack.credits} Credits`;
    meta.textContent = `${pack.name} • ${pack.displayPrice}`;

    button.append(label, meta);
    button.addEventListener("click", () => {
      handleBuyCredits(pack);
    });

    creditPackGrid.append(button);
  });
}

function showPreview(imageBase64, mimeType) {
  previewImage.src = `data:${mimeType};base64,${imageBase64}`;
  previewImage.hidden = false;
  previewEmpty.hidden = true;
  downloadButton.disabled = false;
  downloadButton.dataset.imageUrl = previewImage.src;
}

function resetPreview() {
  previewImage.hidden = true;
  previewImage.removeAttribute("src");
  previewEmpty.hidden = false;
  downloadButton.disabled = true;
  delete downloadButton.dataset.imageUrl;
}

async function parseResponse(response) {
  const payload = await response.json().catch(() => null);

  storeSession(payload);

  if (response.ok && payload) {
    return payload;
  }

  const message = payload?.error || "The artwork could not be generated. Please try again.";
  const error = new Error(message);
  error.data = payload;
  error.status = response.status;
  throw error;
}

async function apiRequest(routePath, options = {}) {
  let response;
  const session = getStoredSession();
  const headers = new Headers(options.headers || {});

  if (session.userId && session.userToken) {
    headers.set("X-Wave-User-Id", session.userId);
    headers.set("X-Wave-User-Token", session.userToken);
  }

  let body = options.body;

  if (body && !(body instanceof FormData) && typeof body !== "string") {
    headers.set("Content-Type", "application/json");
    body = JSON.stringify(body);
  }

  try {
    response = await fetch(getEndpointUrl(routePath), {
      method: options.method || "GET",
      headers,
      body
    });
  } catch (error) {
    const isLocalPage =
      window.location.protocol === "file:" ||
      window.location.hostname === "localhost" ||
      window.location.hostname === "127.0.0.1";

    if (isLocalPage) {
      throw new Error("The local image server could not be reached. Start server/album-generator-server.js and make sure it is listening on http://127.0.0.1:8787.");
    }

    throw new Error("The image generator backend could not be reached. If this page is hosted on GitHub Pages, deploy the backend separately over HTTPS and update the album-generator-api endpoint.");
  }

  return parseResponse(response);
}

async function generateAlbumCover(prompt) {
  // Send only the raw user prompt. The server appends the enforced album-art instructions.
  return apiRequest("/api/album-cover", {
    method: "POST",
    body: {
      prompt,
      imageCostKey: "default"
    }
  });
}

async function loadCredits() {
  setCreditsLoading(true);

  try {
    const payload = await apiRequest("/api/credits");
    updateCreditDisplay(payload);
    renderCreditPacks(payload.creditPacks || []);
  } finally {
    setCreditsLoading(false);
  }
}

async function sendWalletTransaction(pack) {
  if (!window.solanaWeb3) {
    throw new Error("The Solana web3 client did not load correctly.");
  }

  const provider = currentWalletProvider || (await connectWallet());
  const connection = new window.solanaWeb3.Connection(currentPaymentConfig.rpcEndpoint, currentPaymentConfig.commitment);
  const latestBlockhash = await connection.getLatestBlockhash(currentPaymentConfig.commitment);
  const transaction = new window.solanaWeb3.Transaction({
    feePayer: provider.publicKey,
    recentBlockhash: latestBlockhash.blockhash
  });

  transaction.add(
    window.solanaWeb3.SystemProgram.transfer({
      fromPubkey: provider.publicKey,
      toPubkey: new window.solanaWeb3.PublicKey(currentPaymentConfig.receiverWallet),
      lamports: pack.lamports
    })
  );

  let signature;

  if (typeof provider.signAndSendTransaction === "function") {
    const result = await provider.signAndSendTransaction(transaction, {
      preflightCommitment: currentPaymentConfig.commitment
    });
    signature = typeof result === "string" ? result : result?.signature;
  } else if (typeof provider.signTransaction === "function") {
    const signedTransaction = await provider.signTransaction(transaction);
    signature = await connection.sendRawTransaction(signedTransaction.serialize(), {
      skipPreflight: false,
      preflightCommitment: currentPaymentConfig.commitment
    });
  }

  if (!signature) {
    throw new Error("The connected wallet did not return a transaction signature.");
  }

  await connection.confirmTransaction(
    {
      signature,
      blockhash: latestBlockhash.blockhash,
      lastValidBlockHeight: latestBlockhash.lastValidBlockHeight
    },
    currentPaymentConfig.commitment
  );

  return signature;
}

async function handleBuyCredits(pack) {
  paymentStatus.textContent = "Preparing Solana wallet payment...";
  clearError();

  try {
    if (!getConnectedWalletAddress()) {
      await connectWallet();
    }

    paymentStatus.textContent = `Requesting ${pack.displayPrice} payment in ${currentWalletName || "your wallet"}...`;
    const signature = await sendWalletTransaction(pack);
    paymentStatus.textContent = "Payment submitted. Verifying on Solana...";

    const payload = await apiRequest("/api/verify-solana-payment", {
      method: "POST",
      body: {
        packId: pack.id,
        signature,
        walletAddress: getConnectedWalletAddress()
      }
    });

    updateCreditDisplay({
      creditBalance: payload.creditBalance,
      imageCosts: {
        default: currentImageCost
      },
      payment: currentPaymentConfig
    });
    paymentStatus.textContent = payload.alreadyProcessed
      ? "This payment was already credited."
      : `Credits added. New balance: ${payload.creditBalance}.`;
  } catch (error) {
    paymentStatus.textContent = "";
    showError(error.message || "The wallet payment could not be completed.");
  }
}

function applyCheckoutMessage() {
  const searchParams = new URLSearchParams(window.location.search);
  const checkoutState = searchParams.get("checkout");

  if (checkoutState === "success") {
    paymentStatus.textContent = "Payment received.";
  } else if (checkoutState === "cancelled") {
    paymentStatus.textContent = "Payment cancelled.";
  } else {
    paymentStatus.textContent = "";
  }
}

function downloadImage() {
  const imageUrl = downloadButton.dataset.imageUrl;

  if (!imageUrl) {
    return;
  }

  const link = document.createElement("a");
  link.href = imageUrl;
  link.download = "album-cover.png";
  document.body.append(link);
  link.click();
  link.remove();
}

async function handleSubmit(event) {
  event.preventDefault();
  clearError();

  const prompt = promptField.value.trim();

  if (!prompt) {
    resetPreview();
    showError("Enter a description for the artwork before generating an image.");
    return;
  }

  if (currentCreditBalance < currentImageCost) {
    showError("You need additional credits before generating artwork.");
    return;
  }

  setGeneratingState(true);

  try {
    const result = await generateAlbumCover(prompt);
    showPreview(result.imageBase64, result.mimeType || "image/png");
    if (typeof result.creditsRemaining === "number") {
      updateCreditDisplay({
        creditBalance: result.creditsRemaining,
        imageCosts: {
          default: currentImageCost
        }
      });
    }

    statusMessage.textContent = `Artwork ready. ${typeof result.creditsRemaining === "number" ? `${result.creditsRemaining} credits remaining.` : ""}`.trim();
  } catch (error) {
    resetPreview();
    statusMessage.textContent = "";
    if (typeof error.data?.creditBalance === "number") {
      updateCreditDisplay({
        creditBalance: error.data.creditBalance,
        imageCosts: {
          default: currentImageCost
        }
      });
    }
    showError(error.message || "The artwork could not be generated. Please try again.");
  } finally {
    setGeneratingState(false);
  }
}

async function initializeGenerator() {
  applyCheckoutMessage();
  updateWalletDisplay();

  try {
    await loadCredits();
  } catch (error) {
    showError(error.message || "Credits could not be loaded.");
  }
}

if (form) {
  form.addEventListener("submit", handleSubmit);
}

if (downloadButton) {
  downloadButton.addEventListener("click", downloadImage);
}

if (connectWalletButton) {
  connectWalletButton.addEventListener("click", async () => {
    clearError();
    paymentStatus.textContent = "Connecting wallet...";

    try {
      await connectWallet();
      paymentStatus.textContent = "Wallet connected.";
    } catch (error) {
      paymentStatus.textContent = "";
      showError(error.message || "Wallet connection failed.");
    }
  });
}

initializeGenerator();