const { readJsonBody, sendJson, setCorsHeaders } = require("../server/api-utils");
const { inventoryForProducts, updateInventory, requireAdmin } = require("../server/apparel-inventory");
const { products } = require("../server/apparel-catalog");
const { getMode } = require("../server/apparel-stripe");

module.exports = async (request, response) => {
  if (request.method === "OPTIONS") {
    setCorsHeaders(response);
    response.writeHead(204);
    response.end();
    return;
  }
  if (!["GET", "POST"].includes(request.method)) return sendJson(response, 405, { error: "Method not allowed." });
  try {
    const uid = await requireAdmin(request);
    response.setHeader("Cache-Control", "no-store");
    if (request.method === "GET") {
      const inventory = await inventoryForProducts();
      return sendJson(response, 200, {
        mode: getMode(),
        products: inventory.map((stock) => ({ ...stock, name: products.find((product) => product.id === stock.id).name }))
      });
    }
    const body = await readJsonBody(request);
    await updateInventory(body.id, body.quantities, body.versions, uid);
    return sendJson(response, 200, { saved: true });
  } catch (error) {
    console.error("Apparel admin error:", error.message);
    return sendJson(response, error.statusCode || 503, {
      error: error.statusCode ? error.message : "Inventory could not be updated or loaded. Please try again."
    });
  }
};
module.exports.config = { api: { bodyParser: false } };
