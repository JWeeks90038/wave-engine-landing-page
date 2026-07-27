const http = require("http");
const albumCoverHandler = require("../api/album-cover");
const creditsHandler = require("../api/credits");
const deductCreditsHandler = require("../api/deduct-credits");
const useCreditHandler = require("../api/use-credit");
const verifySolanaPaymentHandler = require("../api/verify-solana-payment");
const { sendJson } = require("./api-utils");

const HOST = process.env.ALBUM_GENERATOR_HOST || "127.0.0.1";
const PORT = Number(process.env.ALBUM_GENERATOR_PORT || 8787);

const routeHandlers = {
  "/api/album-cover": albumCoverHandler,
  "/api/credits": creditsHandler,
  "/api/deduct-credits": deductCreditsHandler,
  "/api/use-credit": useCreditHandler
  ,"/api/verify-solana-payment": verifySolanaPaymentHandler
};

const server = http.createServer(async (request, response) => {
  const requestUrl = new URL(request.url, `http://${request.headers.host || `${HOST}:${PORT}`}`);
  const handler = routeHandlers[requestUrl.pathname];

  if (handler) {
    await handler(request, response);
    return;
  }

  sendJson(response, 404, {
    error: "Not found."
  });
});

server.listen(PORT, HOST, () => {
  console.log(`Wave Engine album generator server listening on http://${HOST}:${PORT}`);
});