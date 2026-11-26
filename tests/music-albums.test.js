const test = require("node:test");
const assert = require("node:assert/strict");
const { Readable, Writable } = require("node:stream");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createHandler } = require("../server/music-albums-handler");
const payments = require("../server/music-payments");

class Response extends Writable {
  constructor() { super(); this.headers = {}; this.chunks = []; this.statusCode = 200; this.headersSent = false; }
  setHeader(name, value) { this.headers[name.toLowerCase()] = value; }
  writeHead(status, headers = {}) {
    this.statusCode = status;
    for (const [name, value] of Object.entries(headers)) this.setHeader(name, value);
    this.headersSent = true;
  }
  _write(chunk, encoding, callback) { this.chunks.push(Buffer.from(chunk)); callback(); }
  body() { return Buffer.concat(this.chunks).toString(); }
}

async function request(handler, url, body) {
  const input = Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []);
  input.url = url;
  input.method = body ? "POST" : "GET";
  input.headers = {};
  const response = new Response();
  await handler(input, response);
  return response;
}

function fixture() {
  const album = { title: "Test Album", published: true, priceCents: 500,
    songTitles: ["First", "Second"], archivePath: "musicAlbums/album1/upload1/album.zip" };
  const records = new Map();
  const calls = [];
  let session;
  const charge = { status: "succeeded", refunded: false, amount_refunded: 0, disputed: false,
    created: Math.floor(Date.now() / 1000) };
  const db = { collection: (name) => ({
    where: () => ({ get: async () => ({ docs: [{ id: "album1", data: () => album }] }) }),
    doc: (id) => ({
      get: async () => name === "musicAlbums" ? { exists: true, data: () => album } :
        { exists: records.has(id), data: () => records.get(id) },
      create: async (value) => { records.set(id, value); },
      update: async (value) => Object.assign(records.get(id), value)
    })
  }) };
  const bucket = () => ({ file: (filePath, options) => ({
    getMetadata: async () => [{ generation: "123", size: "20" }],
    getSignedUrl: async (config) => { calls.push({ filePath, options, config }); return ["https://storage.example/download"]; }
  }) });
  const stripe = { checkout: { sessions: {
    create: async (input) => {
      session = {
        id: "cs_test_123", url: "https://checkout.stripe.com/test", livemode: false,
        mode: "payment", status: "complete", payment_status: "paid", currency: "usd",
        amount_subtotal: 500, amount_total: 500, metadata: input.metadata,
        line_items: { data: [{ quantity: 1, price: { unit_amount: 500, currency: "usd" } }] },
        payment_intent: { status: "succeeded", latest_charge: charge }
      };
      return session;
    },
    retrieve: async () => session
  } } };
  const payment = { mode: () => "test", stripeClient: () => stripe,
    siteUrl: () => new URL("https://example.com/"), denied: payments.denied };
  return { album, records, charge, calls, session: () => session, handler: createHandler({ database: () => db, bucket, payment }) };
}

test("album listing and paid ZIP delivery use a pinned purchase snapshot", async () => {
  const previous = process.env.MUSIC_ALBUM_SALES_ENABLED;
  process.env.MUSIC_ALBUM_SALES_ENABLED = "true";
  try {
    const f = fixture();
    const listing = await request(f.handler, "/api/music?action=albums");
    assert.deepEqual(JSON.parse(listing.body()).albums[0], {
      id: "album1", title: "Test Album", priceCents: 500, songTitles: ["First", "Second"]
    });
    const checkout = await request(f.handler, "/api/music?action=album-checkout", { id: "album1" });
    assert.equal(checkout.statusCode, 200);
    const purchaseId = [...f.records.keys()][0];
    const query = `purchase_id=${purchaseId}&session_id=cs_test_123`;
    f.album.published = false;
    f.album.archivePath = "musicAlbums/album1/new/album.zip";
    f.album.priceCents = 700;
    const purchase = await request(f.handler, `/api/music?action=album-purchase&${query}`);
    assert.equal(JSON.parse(purchase.body()).title, "Test Album");
    const download = await request(f.handler, `/api/music?action=album-download&${query}`);
    assert.equal(download.statusCode, 302);
    assert.equal(download.headers.location, "https://storage.example/download");
    assert.equal(f.calls[0].filePath, "musicAlbums/album1/upload1/album.zip");
    assert.equal(f.calls[0].options.generation, "123");
    assert.equal(f.calls[0].config.queryParams.generation, "123");
    assert.ok(f.calls[0].config.expires <= (f.charge.created + 600) * 1000);
    f.session().payment_status = "unpaid";
    assert.equal((await request(f.handler, `/api/music?action=album-download&${query}`)).statusCode, 403);
    f.session().payment_status = "paid";
    f.session().amount_total = 1;
    assert.equal((await request(f.handler, `/api/music?action=album-download&${query}`)).statusCode, 403);
    f.session().amount_total = 500;
    f.charge.refunded = true;
    assert.equal((await request(f.handler, `/api/music?action=album-download&${query}`)).statusCode, 403);
    f.charge.refunded = false;
    f.charge.created -= 600;
    assert.equal((await request(f.handler, `/api/music?action=album-download&${query}`)).statusCode, 410);
    assert.equal(f.calls.length, 1);
    assert.equal((await request(f.handler, `/api/music?action=album-download&purchase_id=${purchaseId}&session_id=cs_test_wrong`)).statusCode, 403);
  } finally {
    if (previous === undefined) delete process.env.MUSIC_ALBUM_SALES_ENABLED;
    else process.env.MUSIC_ALBUM_SALES_ENABLED = previous;
  }
});

test("album checkout fails closed for invalid and unpublished albums", async () => {
  const previous = process.env.MUSIC_ALBUM_SALES_ENABLED;
  process.env.MUSIC_ALBUM_SALES_ENABLED = "true";
  try {
    const f = fixture();
    f.album.published = false;
    assert.equal((await request(f.handler, "/api/music?action=album-checkout", { id: "album1" })).statusCode, 404);
    f.album.published = true;
    f.album.archivePath = "musicAlbums/other/upload/album.zip";
    assert.equal((await request(f.handler, "/api/music?action=album-checkout", { id: "album1" })).statusCode, 404);
    process.env.MUSIC_ALBUM_SALES_ENABLED = "false";
    assert.equal((await request(f.handler, "/api/music?action=album-checkout", { id: "album1" })).statusCode, 503);
    assert.equal(f.records.size, 0);
  } finally {
    if (previous === undefined) delete process.env.MUSIC_ALBUM_SALES_ENABLED;
    else process.env.MUSIC_ALBUM_SALES_ENABLED = previous;
  }
});

test("album ZIP includes every selected format and validates song count", async () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "music-album-zip.js"), "utf8")
    .replace(/export function /g, "function ").replace(/export async function /g, "async function ");
  const { makeAlbumZip, validateAlbumFiles } = vm.runInNewContext(
    `${source}\n({ makeAlbumZip, validateAlbumFiles })`, { TextEncoder, Uint8Array, Uint32Array, DataView, Blob }
  );
  const file = (name, data = "123456789") => {
    const blob = new Blob([data], { type: name.toLowerCase().endsWith(".wav") ? "audio/wav" : "audio/mpeg" });
    Object.defineProperty(blob, "name", { value: name });
    return blob;
  };
  const files = [file("Song.mp3"), file("Song.wav", "wav")];
  assert.deepEqual(Array.from(validateAlbumFiles(files)), ["Song"]);
  const maximum = Array.from({ length: 20 }, (_, i) => [file(`${i}.mp3`), file(`${i}.wav`)]).flat();
  assert.equal(validateAlbumFiles(maximum).length, 20);
  const maximumZip = new DataView(await (await makeAlbumZip(maximum)).arrayBuffer());
  assert.equal(maximumZip.getUint16(maximumZip.byteLength - 12, true), 40);
  assert.throws(() => validateAlbumFiles([file("Song.mp3"), file("song.MP3")]), /Duplicate/);
  assert.throws(() => validateAlbumFiles(Array.from({ length: 21 }, (_, i) => file(`${i}.mp3`))), /20 songs/);
  assert.throws(() => validateAlbumFiles([file("../song.mp3")]), /valid song filenames/);
  const zip = new Uint8Array(await (await makeAlbumZip(files)).arrayBuffer());
  const view = new DataView(zip.buffer);
  assert.equal(view.getUint32(0, true), 0x04034b50);
  assert.equal(view.getUint32(14, true), 0xcbf43926);
  const second = 30 + "Song.mp3".length + 9;
  assert.equal(view.getUint32(second, true), 0x04034b50);
  assert.equal(view.getUint32(zip.length - 22, true), 0x06054b50);
  assert.equal(view.getUint16(zip.length - 12, true), 2);
});
