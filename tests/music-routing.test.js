const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

async function requestsFor(file, location) {
  const requests = [];
  const nodes = new Map();
  const node = () => ({
    addEventListener() {}, replaceChildren() {}, append(child) { this.link = child; }
  });
  const document = {
    querySelector(selector) {
      if (!nodes.has(selector)) nodes.set(selector, node());
      return nodes.get(selector);
    },
    createElement: node
  };
  let source = fs.readFileSync(path.join(__dirname, "..", file), "utf8")
    .replace(/^import .*;\r?\n/gm, "");
  if (file === "music-purchase.js") source = source.replace("loadPurchase();", "await loadPurchase();");
  await vm.runInNewContext(`(async () => {\n${source}\n})()`, {
    document, location: { ...location, search: "?album_purchase=abc&session_id=cs_test_123" },
    fetch: async (url) => {
      requests.push(url);
      return { ok: true, json: async () => ({ tracks: [], albums: [], title: "Album" }) };
    },
    firebaseClient: async (base) => { requests.push(`${base}/api/apparel-firebase-config`); throw new Error("test"); },
    URLSearchParams
  });
  const download = nodes.get("#purchase-downloads");
  if (download && download.link) requests.push(download.link.href);
  return requests;
}

test("music pages use preview API, while production and localhost keep their existing APIs", async () => {
  for (const [location, expected] of [
    [{ protocol: "https:", hostname: "preview.example.vercel.app", origin: "https://preview.example.vercel.app" },
      "https://preview.example.vercel.app"],
    [{ protocol: "https:", hostname: "waveenginemusic.com", origin: "https://waveenginemusic.com" },
      "https://wave-engine-landing-page.vercel.app"],
    [{ protocol: "http:", hostname: "127.0.0.1", origin: "http://127.0.0.1:4173" },
      "http://127.0.0.1:8787"]
  ]) {
    for (const file of ["music.js", "music-albums.js", "music-admin.js", "music-purchase.js"]) {
      const requests = await requestsFor(file, location);
      assert.ok(requests.length, `${file} made no requests`);
      for (const url of requests) assert.ok(url.startsWith(`${expected}/api/`), `${file}: ${url}`);
      if (file === "music-purchase.js") assert.equal(requests.length, 2);
    }
  }
});
