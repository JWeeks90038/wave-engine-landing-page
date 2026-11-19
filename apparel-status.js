const apiConfig = document.querySelector('meta[name="apparel-api-base"]');
const isLocal = location.protocol === "file:" || ["localhost", "127.0.0.1"].includes(location.hostname);
const apiSetting = (isLocal && apiConfig.dataset.localApiBase || apiConfig.content).trim();
const apiBase = apiSetting.replace(/\/$/, "") || (isLocal ? "http://127.0.0.1:8787" : "");
const statusElement = document.querySelector("#payment-status");
const cartStorageKey = "wave-apparel-cart-v1";
const sessionId = new URLSearchParams(location.search).get("session_id");
if (!sessionId) {
  statusElement.textContent = "A checkout session was not provided. Payment could not be verified.";
} else {
  fetch(`${apiBase}/api/apparel-order-status?session_id=${encodeURIComponent(sessionId)}`, { cache: "no-store" })
    .then((response) => { if (!response.ok) throw new Error("Payment could not be verified."); return response.json(); })
    .then((data) => {
      if (data.paid || data.orderStatus === "processing") {
        try {
          sessionStorage.removeItem(cartStorageKey);
        } catch (error) {
          statusElement.textContent = "Your payment is confirmed, but this tab could not clear your cart. Please remove any remaining items manually.";
          return;
        }
      }
      statusElement.textContent = data.orderStatus === "refunded"
        ? "Sorry, this size is no longer available. Your payment has been refunded."
        : data.orderStatus === "refund_pending"
          ? "Sorry, this size is no longer available. Your refund is being processed."
          : data.orderStatus === "processing"
            ? "Payment received. Your order is being confirmed; please check again shortly."
            : data.paid
        ? (data.mode === "test" ? "TEST MODE: Your test payment is confirmed. No real order was placed." : "Your payment is confirmed. Thank you!")
        : "Your payment is not confirmed yet. Please check again later.";
    })
    .catch(() => { statusElement.textContent = "Payment status could not be verified. Please try again later."; });
}
