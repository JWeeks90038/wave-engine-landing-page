const form = document.querySelector("#album-generator-form");
const promptField = document.querySelector("#album-prompt");
const generateButton = document.querySelector("#generate-button");
const downloadButton = document.querySelector("#download-button");
const statusMessage = document.querySelector("#generator-status");
const errorMessage = document.querySelector("#generator-error");
const previewImage = document.querySelector("#preview-image");
const previewEmpty = document.querySelector("#preview-empty");

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

function setGeneratingState(isGenerating) {
  const hasGeneratedImage = Boolean(downloadButton.dataset.imageUrl);

  generateButton.disabled = isGenerating;
  promptField.disabled = isGenerating;
  downloadButton.disabled = isGenerating || !hasGeneratedImage;
  generateButton.textContent = isGenerating ? "Generating artwork..." : "Generate Image";

  if (isGenerating) {
    statusMessage.textContent = "Generating artwork...";
  }
}

function clearError() {
  errorMessage.hidden = true;
  errorMessage.textContent = "";
}

function showError(message) {
  errorMessage.textContent = message;
  errorMessage.hidden = false;
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

  if (response.ok && payload) {
    return payload;
  }

  const message = payload?.error || "The artwork could not be generated. Please try again.";
  throw new Error(message);
}

async function generateAlbumCover(prompt) {
  // Send only the raw user prompt. The server appends the enforced album-art instructions.
  let response;

  try {
    response = await fetch(getApiEndpoint(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ prompt })
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

  setGeneratingState(true);

  try {
    const result = await generateAlbumCover(prompt);
    showPreview(result.imageBase64, result.mimeType || "image/png");
    statusMessage.textContent = "Artwork ready.";
  } catch (error) {
    resetPreview();
    statusMessage.textContent = "";
    showError(error.message || "The artwork could not be generated. Please try again.");
  } finally {
    setGeneratingState(false);
  }
}

if (form) {
  form.addEventListener("submit", handleSubmit);
}

if (downloadButton) {
  downloadButton.addEventListener("click", downloadImage);
}