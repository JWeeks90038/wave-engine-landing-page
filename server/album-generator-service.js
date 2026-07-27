const OPENAI_IMAGE_URL = "https://api.openai.com/v1/images/generations";
const IMAGE_MODEL = "gpt-image-2";
const IMAGE_SIZE = "2880x2880";
const IMAGE_QUALITY = "high";

const PROMPT_PREFIX = [
  "Professional music album cover artwork.",
  "Square composition.",
  "Centered subject.",
  "Ultra detailed.",
  "Cinematic lighting.",
  "High contrast.",
  "Modern digital art.",
  "Professional quality.",
  "Designed for Spotify, Apple Music, Amazon Music and YouTube Music.",
  "No logos.",
  "No watermarks.",
  "No text unless explicitly requested."
].join("\n");

function buildPrompt(userPrompt) {
  return `${PROMPT_PREFIX}\n\n${userPrompt.trim()}`;
}

function mapOpenAiError(errorPayload) {
  const error = errorPayload?.error || {};

  if (error.code === "moderation_blocked") {
    return "That prompt could not be used for image generation. Try a safer, more neutral visual description.";
  }

  if (error.code === "invalid_api_key" || error.type === "invalid_request_error") {
    return error.message || "The image request could not be processed.";
  }

  if (error.type === "insufficient_quota") {
    return "The image generator is temporarily unavailable because the API quota has been reached.";
  }

  return error.message || "The image generator is temporarily unavailable. Please try again.";
}

async function requestOpenAiImage({ prompt, apiKey, fetchImpl = fetch }) {
  if (!apiKey) {
    const error = new Error("The server is missing the OPENAI_API_KEY environment variable.");
    error.statusCode = 500;
    throw error;
  }

  if (typeof fetchImpl !== "function") {
    const error = new Error("This server requires Node.js 18 or newer for the built-in fetch API.");
    error.statusCode = 500;
    throw error;
  }

  const response = await fetchImpl(OPENAI_IMAGE_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: IMAGE_MODEL,
      prompt: buildPrompt(prompt),
      size: IMAGE_SIZE,
      quality: IMAGE_QUALITY,
      output_format: "png"
    })
  });

  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    const error = new Error(mapOpenAiError(payload));
    error.statusCode = response.status;
    throw error;
  }

  const imageBase64 = payload?.data?.[0]?.b64_json;

  if (!imageBase64) {
    const error = new Error("The image API response did not include artwork data.");
    error.statusCode = 502;
    throw error;
  }

  return {
    imageBase64,
    mimeType: "image/png"
  };
}

module.exports = {
  buildPrompt,
  requestOpenAiImage
};