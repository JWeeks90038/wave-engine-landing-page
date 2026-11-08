const apiSetting = document.querySelector('meta[name="apparel-api-base"]').content.trim();
const apiBase = apiSetting.replace(/\/$/, "") || (location.protocol === "file:" || ["localhost", "127.0.0.1"].includes(location.hostname) ? "http://127.0.0.1:8787" : "");
const statusElement = document.querySelector("#payment-status");
const sessionId = new URLSearchParams(location.search).get("session_id");
if (!sessionId) {
  statusElement.textContent = "A checkout session was not provided. Payment could not be verified.";
} else {
  fetch(`${apiBase}/api/apparel-order-status?session_id=${encodeURIComponent(sessionId)}`, { cache: "no-store" })
    .then((response) => { if (!response.ok) throw new Error("Payment could not be verified."); return response.json(); })
    .then((data) => {
      statusElement.textContent = data.paid
        ? (data.mode === "test" ? "TEST MODE: Your test payment is confirmed. No real order was placed." : "Your payment is confirmed. Thank you!")
        : "Your payment is not confirmed yet. Please check again later.";
    })
    .catch(() => { statusElement.textContent = "Payment status could not be verified. Please try again later."; });
}
