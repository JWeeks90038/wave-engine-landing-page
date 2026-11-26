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

test("music admin initializes and loads tracks and albums after sign-in", async () => {
  const nodes = new Map();
  const element = () => ({
    children: [], listeners: {}, elements: { title: {}, price: {}, published: {} },
    addEventListener(event, callback) { this.listeners[event] = callback; },
    querySelectorAll() { return []; },
    replaceChildren(...children) { this.children = children; },
    append(...children) { this.children.push(...children); },
    reset() { this.resetCount = (this.resetCount || 0) + 1; },
    scrollIntoView() {}
  });
  const document = {
    querySelector(selector) {
      if (!nodes.has(selector)) nodes.set(selector, element());
      return nodes.get(selector);
    },
    createElement: element
  };
  const records = {
    musicTracks: [{ id: "song", data: () => ({ title: "Song", artist: "Artist", sortOrder: 1, published: true }) }],
    musicAlbums: [{ id: "album", data: () => ({ title: "Album", songTitles: ["Song"], priceCents: 500, published: true }) }]
  };
  let authListener;
  const source = fs.readFileSync(path.join(__dirname, "..", "music-admin.js"), "utf8")
    .replace(/^import .*;\r?\n/gm, "");
  await vm.runInNewContext(`(async () => {\n${source}\n})()`, {
    document,
    location: { protocol: "https:", hostname: "example.com" },
    firebaseClient: async () => ({}),
    fetch: async () => ({ ok: true, json: async () => ({ storageBucket: "bucket" }) }),
    getAuth: () => ({}), getFirestore: () => ({}), getStorage: () => ({}),
    onAuthStateChanged: (auth, listener) => { authListener = listener; },
    collection: (db, name) => name,
    getDocs: async (name) => ({ docs: records[name] }),
    URL
  });
  assert.equal(typeof authListener, "function");
  await authListener(null);
  assert.equal(nodes.get("#admin-status").textContent, "Sign in with an administrator account.");
  await authListener({ getIdTokenResult: async () => ({ claims: { admin: true } }) });
  assert.equal(nodes.get("#admin-status").textContent, "Manage tracks and albums before publishing.");
  assert.equal(nodes.get("#admin-tracks").children.length, 1);
  assert.equal(nodes.get("#admin-albums").children.length, 1);
  await nodes.get("#admin-refresh").listeners.click();
  assert.equal(nodes.get("#admin-status").textContent, "Tracks and albums refreshed.");
  nodes.get("#album-new").listeners.click();
  assert.equal(nodes.get("#album-editor-title").textContent, "New album");
});
