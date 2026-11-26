const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

async function requestsFor(file, location) {
  const requests = [];
  const nodes = new Map();
  const node = () => ({
    elements: { songs: { addEventListener() {} } },
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
    children: [], listeners: {}, elements: { title: {}, price: {}, published: {}, songs: { addEventListener() {} } },
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
    elements: { title: {}, price: {}, published: {}, songs: { files: [], addEventListener() {} },
      cover: { files: [] }, removeCover: { checked: false }, replaceSongs: { checked: false } },
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

test("music admin accumulates song selections and adds them to an existing album", async () => {
  const zipSource = fs.readFileSync(path.join(__dirname, "..", "music-album-zip.js"), "utf8")
    .replace(/export function /g, "function ").replace(/export async function /g, "async function ");
  const zip = vm.runInNewContext(`${zipSource}\n({ makeAlbumZip, readAlbumZip, validateAlbumFiles })`,
    { TextEncoder, TextDecoder, Uint8Array, Uint32Array, DataView, Blob, File });
  const nodes = new Map();
  const element = () => ({
    children: [], listeners: {},
    elements: {
      title: {}, price: {}, published: {}, cover: { files: [] }, removeCover: { checked: false },
      replaceSongs: { checked: false },
      songs: { files: [], listeners: {}, addEventListener(event, callback) { this.listeners[event] = callback; } }
    },
    addEventListener(event, callback) { this.listeners[event] = callback; },
    querySelectorAll() { return []; },
    replaceChildren(...children) { this.children = children; },
    append(...children) { this.children.push(...children); },
    reset() { this.elements.replaceSongs.checked = false; this.elements.cover.files = []; },
    scrollIntoView() {}
  });
  const document = {
    querySelector(selector) {
      if (!nodes.has(selector)) nodes.set(selector, element());
      return nodes.get(selector);
    },
    createElement: element
  };
  const file = (name) => new File([name], name, { type: "audio/mpeg" });
  let archive = await zip.makeAlbumZip([file("Existing.mp3")]);
  let album = { title: "Album", songTitles: ["Existing"], priceCents: 500, published: true,
    archivePath: "musicAlbums/album/old/album.zip", createdAt: "created", createdBy: "admin" };
  let uploaded;
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
    getBlob: async () => archive,
    uploadBytesResumable: (path, blob) => {
      uploaded = blob;
      return { on: (event, progress, reject, resolve) => resolve() };
    },
    setDoc: async (target, data) => { album = data; archive = uploaded; },
    serverTimestamp: () => "updated",
    crypto: { randomUUID: () => "new" }, URL,
    ...zip
  });
  await authListener({ getIdTokenResult: async () => ({ claims: { admin: true } }) });
  const form = nodes.get("#album-form");
  const edit = () => nodes.get("#admin-albums").children[0].children[3].children[0].listeners.click();
  const select = (...files) => {
    form.elements.songs.files = files;
    form.elements.songs.listeners.change();
  };
  edit();
  for (let i = 1; i <= 5; i++) select(file(`Song ${i}.mp3`));
  assert.match(nodes.get("#album-selected-files").textContent, /5 new files selected \(5 songs\)/);
  await form.listeners.submit({ preventDefault() {} });
  assert.deepEqual(Array.from(album.songTitles), ["Existing", "Song 1", "Song 2", "Song 3", "Song 4", "Song 5"]);
  assert.deepEqual(Array.from(await zip.readAlbumZip(archive), (item) => item.name),
    ["Existing.mp3", "Song 1.mp3", "Song 2.mp3", "Song 3.mp3", "Song 4.mp3", "Song 5.mp3"]);

  edit();
  select(...Array.from({ length: 15 }, (_, i) => file(`Extra ${i}.mp3`)));
  await form.listeners.submit({ preventDefault() {} });
  assert.match(nodes.get("#admin-status").textContent, /20 songs/);
  assert.equal(album.songTitles.length, 6);
  assert.equal((await zip.readAlbumZip(archive)).length, 6);

  nodes.get("#album-new").listeners.click();
  edit();
  select(...Array.from({ length: 14 }, (_, i) => file(`Extra ${i}.mp3`)));
  await form.listeners.submit({ preventDefault() {} });
  assert.equal(album.songTitles.length, 20);
  assert.equal((await zip.readAlbumZip(archive)).length, 20);

  edit();
  select(file("Existing.mp3"));
  await form.listeners.submit({ preventDefault() {} });
  assert.match(nodes.get("#admin-status").textContent, /Duplicate MP3/);
  assert.equal(album.songTitles.length, 20);

  form.elements.replaceSongs.checked = true;
  await form.listeners.submit({ preventDefault() {} });
  assert.deepEqual(Array.from(album.songTitles), ["Existing"]);
  assert.deepEqual(Array.from(await zip.readAlbumZip(archive), (item) => item.name), ["Existing.mp3"]);

  nodes.get("#album-new").listeners.click();
  assert.match(nodes.get("#album-selected-files").textContent, /No new song files/);
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
