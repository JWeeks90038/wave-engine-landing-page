const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { runInNewContext } = require("node:vm");
const path = require("node:path");

const statusScript = readFileSync(path.join(__dirname, "..", "apparel-status.js"), "utf8");

async function loadStatus(data) {
  const statusElement = { textContent: "Verifying your payment..." };
  const apiConfig = { dataset: {}, content: "https://api.example.test" };
  let cart = JSON.stringify([{ id: "product", size: "M", color: "Black", quantity: 1 }]);
  const context = {
    URLSearchParams,
    location: { search: "?session_id=cs_test_example", protocol: "https:", hostname: "example.test" },
    document: {
      querySelector(selector) {
        return selector === 'meta[name="apparel-api-base"]' ? apiConfig : statusElement;
      }
    },
    sessionStorage: {
      removeItem(key) {
        if (key === "wave-apparel-cart-v1") cart = null;
      }
    },
    fetch: async () => ({ ok: true, json: async () => data })
  };

  runInNewContext(statusScript, context);
  await new Promise((resolve) => setImmediate(resolve));
  return { status: statusElement.textContent, cart };
}

test("verified payment clears the current tab's apparel cart", async () => {
  const result = await loadStatus({ paid: true, mode: "test" });

  assert.equal(result.cart, null);
  assert.match(result.status, /payment is confirmed/i);
});

test("payment under order processing clears the cart after Stripe confirms payment", async () => {
  const result = await loadStatus({ paid: false, orderStatus: "processing", mode: "live" });

  assert.equal(result.cart, null);
  assert.match(result.status, /being confirmed/i);
});

test("unconfirmed or refunded payment keeps the cart", async () => {
  const pending = await loadStatus({ paid: false, mode: "test" });
  assert.notEqual(pending.cart, null);
  assert.match(pending.status, /not confirmed/i);

  const refunded = await loadStatus({ paid: false, orderStatus: "refunded", mode: "test" });
  assert.notEqual(refunded.cart, null);
  assert.match(refunded.status, /refunded/i);
});
