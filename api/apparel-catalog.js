const { products } = require("../server/apparel-catalog");
const { sendJson, setCorsHeaders } = require("../server/api-utils");
const { getStripe, getMode } = require("../server/apparel-stripe");
const { getPublicProducts } = require("../server/apparel-pricing");
const { inventoryForProducts } = require("../server/apparel-inventory");

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
    let inventory;
    try {
      inventory = await inventoryForProducts();
    } catch (error) {
      console.error("Apparel inventory unavailable:", error.message);
      return sendJson(response, 503, {
        error: "Inventory is temporarily unavailable. Shopping is disabled; please try again later.",
        products: publicProducts.map((product) => ({ ...product, availabilityUnavailable: true })),
        mode: getMode()
      });
    }
    sendJson(response, 200, { products: publicProducts.map((product) => {
      const stock = inventory.find((entry) => entry.id === product.id);
      return { ...product, active: stock.active, inventory: stock.quantities };
    }), mode: getMode() });
  } catch (error) {
    console.error("Apparel catalog error:", error.message);
    sendJson(response, 503, { error: "The collection is unavailable. Please try again later." });
  }
};
