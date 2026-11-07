const { products } = require("../server/apparel-catalog");
const { sendJson, setCorsHeaders } = require("../server/api-utils");
const { getStripe } = require("../server/apparel-stripe");
const { getPublicProducts } = require("../server/apparel-pricing");

module.exports = async (request, response) => {
  if (request.method === "OPTIONS") {
    setCorsHeaders(response);
    response.writeHead(204);
    response.end();
    return;
  }
  if (request.method !== "GET") return sendJson(response, 405, { error: "Method not allowed." });
  try {
    const publicProducts = await getPublicProducts(products, getStripe);
    response.setHeader("Cache-Control", "no-store");
    sendJson(response, 200, { products: publicProducts });
  } catch (error) {
    console.error("Apparel catalog error:", error.message);
    sendJson(response, 503, { error: "The collection is unavailable. Please try again later." });
  }
};
