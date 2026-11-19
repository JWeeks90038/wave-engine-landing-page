const { sendJson, setCorsHeaders } = require("../server/api-utils");
const { getStripe, getMode } = require("../server/apparel-stripe");
const { database } = require("../server/apparel-inventory");

module.exports = async (request, response) => {
  if (request.method === "OPTIONS") {
    setCorsHeaders(response);
    response.writeHead(204);
    response.end();
    return;
  }
  if (request.method !== "GET") return sendJson(response, 405, { error: "Method not allowed." });
  const id = new URL(request.url, "http://localhost").searchParams.get("session_id") || "";
  try {
    const live = getMode() === "live";
    if (!new RegExp(`^cs_${live ? "live" : "test"}_[a-zA-Z0-9]+$`).test(id)) return sendJson(response, 400, { error: "Invalid checkout session." });
    const session = await getStripe().checkout.sessions.retrieve(id);
    let orderStatus = null;
    if (session.livemode === live && session.metadata?.storefront === "wave-apparel-v1" &&
        session.metadata.inventoryVersion === "1" && session.payment_status === "paid") {
      const order = await database().collection("orders").doc(id).get();
      orderStatus = order.exists ? order.data().paymentStatus : "processing";
    }
    response.setHeader("Cache-Control", "no-store");
    sendJson(response, 200, {
      mode: live ? "live" : "test",
      paid: session.livemode === live && session.metadata?.storefront === "wave-apparel-v1" &&
        session.payment_status === "paid" && (session.metadata.inventoryVersion !== "1" || orderStatus === "paid"),
      ...(orderStatus ? { orderStatus } : {})
    });
  } catch (error) {
    console.error("Apparel order status error:", error.message);
    sendJson(response, 503, { error: "Payment status could not be verified." });
  }
};
