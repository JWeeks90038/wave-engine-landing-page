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

test("music admin replaces and removes an album cover without replacing the archive", async () => {
  const nodes = new Map();
  const element = () => ({
    children: [], listeners: {},
    elements: { title: {}, price: {}, published: {}, songs: { files: [] },
      cover: { files: [] }, removeCover: { checked: false } },
    addEventListener(event, callback) { this.listeners[event] = callback; },
    querySelectorAll() { return []; },
    replaceChildren(...children) { this.children = children; },
    append(...children) { this.children.push(...children); },
    reset() { this.elements.cover.files = []; this.elements.removeCover.checked = false; },
    scrollIntoView() {}
  });
  const document = {
    querySelector(selector) {
      if (!nodes.has(selector)) nodes.set(selector, element());
      return nodes.get(selector);
    },
    createElement: element
  };
  let album = { title: "Album", songTitles: ["Song"], priceCents: 500, published: true,
    archivePath: "musicAlbums/album/archive/album.zip", coverPath: "musicAlbums/album/old/cover",
    createdAt: "created", createdBy: "admin" };
  const removed = [];
  let saved;
  let authListener;
  const source = fs.readFileSync(path.join(__dirname, "..", "music-admin.js"), "utf8")
    .replace(/^import .*;\r?\n/gm, "");
  await vm.runInNewContext(`(async () => {\n${source}\n})()`, {
    document, location: { protocol: "https:", hostname: "example.com" },
    firebaseClient: async () => ({}), fetch: async () => ({ ok: true, json: async () => ({ storageBucket: "bucket" }) }),
    getAuth: () => ({ currentUser: { uid: "admin" } }), getFirestore: () => ({}), getStorage: () => ({}),
    onAuthStateChanged: (auth, listener) => { authListener = listener; },
    collection: (db, name) => name,
    getDocs: async (name) => ({ docs: name === "musicAlbums" ? [{ id: "album", data: () => album }] : [] }),
    doc: (db, name, id) => ({ id }),
    ref: (storage, path) => path,
    uploadBytesResumable: () => ({ on: (event, progress, reject, resolve) => resolve() }),
    setDoc: async (target, data) => { saved = data; album = data; },
    deleteObject: async (path) => { removed.push(path); },
    serverTimestamp: () => "updated",
    crypto: { randomUUID: () => "new" }, URL
  });
  await authListener({ getIdTokenResult: async () => ({ claims: { admin: true } }) });
  const edit = () => nodes.get("#admin-albums").children[0].children[3].children[0].listeners.click();
  const form = nodes.get("#album-form");
  edit();
  form.elements.cover.files = [{ type: "image/png", size: 12 }];
  await form.listeners.submit({ preventDefault() {} });
  assert.equal(saved.coverPath, "musicAlbums/album/new/cover");
  assert.equal(saved.archivePath, "musicAlbums/album/archive/album.zip");
  assert.deepEqual(removed, ["musicAlbums/album/old/cover"]);
  edit();
  form.elements.removeCover.checked = true;
  await form.listeners.submit({ preventDefault() {} });
  assert.equal("coverPath" in saved, false);
  assert.equal(saved.archivePath, "musicAlbums/album/archive/album.zip");
  assert.deepEqual(removed, ["musicAlbums/album/old/cover", "musicAlbums/album/new/cover"]);
});

test("album listing renders uploaded cover artwork", async () => {
  const nodes = new Map();
  const element = (tag) => ({
    tag, children: [], addEventListener() {},
    append(...children) { this.children.push(...children); },
    replaceChildren(...children) { this.children = children; }
  });
  const document = {
    querySelector(selector) {
      if (!nodes.has(selector)) nodes.set(selector, element("div"));
      return nodes.get(selector);
    },
    createElement: element
  };
  const source = fs.readFileSync(path.join(__dirname, "..", "music-albums.js"), "utf8");
  await vm.runInNewContext(`(async () => {\n${source}\n})()`, {
    document, location: { protocol: "https:", hostname: "example.com" },
    fetch: async () => ({ ok: true, json: async () => ({
      albums: [{ id: "album", title: "Album", songTitles: ["Song"], priceCents: 500, hasCover: true }]
    }) }),
    URLSearchParams
  });
  const card = nodes.get("#music-albums").children[0];
  assert.match(card.className, /has-cover/);
  assert.equal(card.children[0].tag, "img");
  assert.match(card.children[0].src, /action=album-cover&id=album/);
  assert.equal(card.children[0].alt, "Cover artwork for Album");
});
