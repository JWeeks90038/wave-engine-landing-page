function setCorsHeaders(response) {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Wave-User-Id, X-Wave-User-Token");
}

function sendJson(response, statusCode, payload) {
  setCorsHeaders(response);
  response.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

async function readRawBody(request) {
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

  return Buffer.concat(chunks).toString("utf8");
}

async function readJsonBody(request) {
  const rawBody = await readRawBody(request);

  if (!rawBody) {
    return {};
  }

  return JSON.parse(rawBody);
}

function getRequestOrigin(request) {
  const forwardedProto = request.headers["x-forwarded-proto"];
  const host = request.headers["x-forwarded-host"] || request.headers.host;
  const protocol = forwardedProto || "http";

  if (!host) {
    return "";
  }

  return `${protocol}://${host}`;
}

module.exports = {
  getRequestOrigin,
  readJsonBody,
  readRawBody,
  sendJson,
  setCorsHeaders
};