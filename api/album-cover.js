const { requestOpenAiImage } = require("../server/album-generator-service");

function setCorsHeaders(response) {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function sendJson(response, statusCode, payload) {
  setCorsHeaders(response);
  response.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

async function readJsonBody(request) {
  const chunks = [];
  let size = 0;

  for await (const chunk of request) {
    size += chunk.length;

    if (size > 1_000_000) {
      const error = new Error("Request body is too large.");
      error.statusCode = 413;
      throw error;
    }

    chunks.push(chunk);
  }

  if (!chunks.length) {
    return {};
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

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
    const body = await readJsonBody(request);
    const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";

    if (!prompt) {
      sendJson(response, 400, {
        error: "A prompt is required to generate artwork."
      });
      return;
    }

    const result = await requestOpenAiImage({
      prompt,
      apiKey: process.env.OPENAI_API_KEY
    });

    sendJson(response, 200, result);
  } catch (error) {
    sendJson(response, error instanceof SyntaxError ? 400 : error.statusCode || 500, {
      error:
        error instanceof SyntaxError
          ? "The request payload was invalid JSON."
          : error.message || "The artwork could not be generated."
    });
  }
};