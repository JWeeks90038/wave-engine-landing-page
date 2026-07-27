const http = require("http");
const { requestOpenAiImage } = require("./album-generator-service");

const HOST = process.env.ALBUM_GENERATOR_HOST || "127.0.0.1";
const PORT = Number(process.env.ALBUM_GENERATOR_PORT || 8787);
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

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
      throw new Error("Request body is too large.");
    }

    chunks.push(chunk);
  }

  if (!chunks.length) {
    return {};
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function handleAlbumCoverRequest(request, response) {
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
      apiKey: OPENAI_API_KEY
    });
    sendJson(response, 200, result);
  } catch (error) {
    const statusCode = error instanceof SyntaxError ? 400 : error.statusCode || 500;
    sendJson(response, statusCode, {
      error:
        error instanceof SyntaxError
          ? "The request payload was invalid JSON."
          : error.message || "The artwork could not be generated."
    });
  }
}

const server = http.createServer(async (request, response) => {
  // Expose a single narrow route so the browser never talks to OpenAI directly.
  if (request.method === "OPTIONS") {
    setCorsHeaders(response);
    response.writeHead(204);
    response.end();
    return;
  }

  if (request.method === "POST" && request.url === "/api/album-cover") {
    await handleAlbumCoverRequest(request, response);
    return;
  }

  sendJson(response, 404, {
    error: "Not found."
  });
});

server.listen(PORT, HOST, () => {
  console.log(`Wave Engine album generator server listening on http://${HOST}:${PORT}/api/album-cover`);
});