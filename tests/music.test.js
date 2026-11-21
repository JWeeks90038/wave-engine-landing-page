const test = require("node:test");
const assert = require("node:assert/strict");
const { Readable, Writable } = require("node:stream");
const music = require("../server/music-library");
const { createHandler: fileHandler } = require("../server/music-file-handler");
const { createHandler: libraryHandler } = require("../server/music-library-handler");
const { createHandler: checkoutHandler } = require("../server/music-checkout-handler");
const { createHandler: purchaseHandler } = require("../server/music-purchase-handler");
const payments = require("../server/music-payments");
const musicHandler = require("../api/music");

class Response extends Writable {
  constructor() {
    super();
    this.headers = {};
    this.chunks = [];
    this.statusCode = 200;
    this.headersSent = false;
  }
  setHeader(name, value) { this.headers[name.toLowerCase()] = value; }
  writeHead(status, headers = {}) {
    this.statusCode = status;
    for (const [name, value] of Object.entries(headers)) this.setHeader(name, value);
    this.headersSent = true;
  }
  _write(chunk, encoding, callback) { this.chunks.push(Buffer.from(chunk)); callback(); }
  body() { return Buffer.concat(this.chunks).toString(); }
}

function fakeMusic(track, content = "0123456789") {
  let storageAccesses = 0;
  const dependencies = {
    ...music,
    verify: async (sessionId) => {
      if (sessionId !== "paid") throw payments.denied();
      return { trackId: "track1", title: "Test" };
    },
    database: () => ({
      collection: () => ({
        doc: (id) => ({ get: async () => ({ exists: Boolean(track), data: () => track, id }) }),
        where: (field, operator, value) => ({
          get: async () => ({ docs: track && track[field] === value ? [{ id: "track1", data: () => track }] : [] })
        })
      })
    }),
    bucket: () => {
      storageAccesses++;
      return { file: () => ({
        getMetadata: async () => [{ size: content.length, contentType: "image/png" }],
        createReadStream: ({ start, end }) => Readable.from([content.slice(start, end + 1)])
      }) };
    }
  };
  return { dependencies, accesses: () => storageAccesses };
}
const track = {
  title: "Test", artist: "Wave Engine", album: "Album", description: "", genre: "", releaseDate: "",
  duration: "1:23", sortOrder: 1, published: true, mp3StoragePath: "musicTracks/track1/file/mp3.mp3",
  wavStoragePath: "", coverStoragePath: "", createdBy: "private-admin"
};
async function request(handler, url, headers = {}) {
  const response = new Response();
  await handler({ method: "GET", url, headers }, response);
  return response;
}

test("library exposes only published metadata, not internal paths or creator", async () => {
  const published = fakeMusic(track);
  const response = await request(libraryHandler(published.dependencies), "/api/music-library");
  const data = JSON.parse(response.body());
  assert.equal(data.tracks.length, 1);
  assert.equal(data.tracks[0].hasMp3, true);
  assert.equal(data.tracks[0].hasWav, false);
  assert.equal(data.tracks[0].mp3StoragePath, undefined);
  assert.equal(data.tracks[0].createdBy, undefined);
  const unpublished = fakeMusic({ ...track, published: false });
  const hidden = await request(libraryHandler(unpublished.dependencies), "/api/music-library");
  assert.deepEqual(JSON.parse(hidden.body()).tracks, []);
});

test("unpublished and missing tracks never access storage", async () => {
  for (const value of [null, { ...track, published: false }]) {
    const fake = fakeMusic(value);
    const response = await request(fileHandler(fake.dependencies), "/api/music-file?id=track1&format=mp3");
    assert.equal(response.statusCode, 404);
    assert.equal(fake.accesses(), 0);
  }
});

test("published audio supports seeking, named downloads, and invalid ranges", async () => {
  const fake = fakeMusic(track);
  const handler = fileHandler(fake.dependencies);
  const partial = await request(handler, "/api/music-file?id=track1&format=mp3", { range: "bytes=3-5" });
  assert.equal(partial.statusCode, 206);
  assert.equal(partial.headers["content-range"], "bytes 3-5/10");
  assert.equal(partial.body(), "345");
  assert.equal(partial.headers["cache-control"], "private, no-store");
  const download = await request(handler, "/api/music-file?id=track1&format=mp3&download=1&session_id=paid");
  assert.equal(download.body(), "0123456789");
  assert.equal(download.headers["content-disposition"], 'attachment; filename="Wave Engine - Test.mp3"');
  const invalid = await request(handler, "/api/music-file?id=track1&format=mp3", { range: "bytes=20-" });
  assert.equal(invalid.statusCode, 416);
  assert.equal(invalid.headers["content-range"], "bytes */10");
});

test("WAV downloads work and unpublishing blocks later requests", async () => {
  const changing = { ...track, wavStoragePath: "musicTracks/track1/file/wav.wav" };
  const fake = fakeMusic(changing);
  const handler = fileHandler(fake.dependencies);
  const download = await request(handler, "/api/music-file?id=track1&format=wav&download=1&session_id=paid");
  assert.equal(download.statusCode, 200);
  assert.equal(download.headers["content-type"], "audio/wav");
  assert.equal(download.headers["content-disposition"], 'attachment; filename="Wave Engine - Test.wav"');
  changing.published = false;
  const hidden = await request(handler, "/api/music-file?id=track1&format=wav");
  assert.equal(hidden.statusCode, 404);
  assert.equal(fake.accesses(), 1);
  const purchased = await request(handler, "/api/music-file?id=track1&format=wav&download=1&session_id=paid");
  assert.equal(purchased.statusCode, 200);
});

test("downloads require payment for the selected track while streaming remains free", async () => {
  const fake = fakeMusic(track);
  const handler = fileHandler(fake.dependencies);
  const unpaid = await request(handler, "/api/music-file?id=track1&format=mp3&download=1");
  assert.equal(unpaid.statusCode, 403);
  assert.equal(fake.accesses(), 0);
  const wrongTrack = await request(handler, "/api/music-file?id=track2&format=mp3&download=1&session_id=paid");
  assert.equal(wrongTrack.statusCode, 403);
  assert.equal(fake.accesses(), 0);
  const stream = await request(handler, "/api/music-file?id=track1&format=mp3");
  assert.equal(stream.statusCode, 200);
});

test("purchase verification rejects unpaid, refunded, disputed and mismatched sessions", async () => {
  const session = {
    mode: "payment", status: "complete", payment_status: "paid", livemode: false,
    currency: "usd", amount_subtotal: 149, amount_total: 149,
    metadata: { type: "music-download-v1", trackId: "track1", priceId: "price_123", title: "Test" },
    line_items: { data: [{ quantity: 1, price: { id: "price_123" } }] },
    payment_intent: { status: "succeeded", latest_charge: { status: "succeeded", refunded: false, amount_refunded: 0, disputed: false } }
  };
  const stripe = { checkout: { sessions: { retrieve: async () => session } } };
  assert.deepEqual(await payments.verifyPurchase("cs_test_123", stripe, "test"), { trackId: "track1", title: "Test" });
  session.payment_status = "unpaid";
  await assert.rejects(() => payments.verifyPurchase("cs_test_123", stripe, "test"), { statusCode: 403 });
  session.payment_status = "paid";
  session.amount_total = 0;
  await assert.rejects(() => payments.verifyPurchase("cs_test_123", stripe, "test"), { statusCode: 403 });
  session.amount_total = 149;
  session.payment_intent.latest_charge.amount_refunded = 1;
  await assert.rejects(() => payments.verifyPurchase("cs_test_123", stripe, "test"), { statusCode: 403 });
  session.payment_intent.latest_charge.amount_refunded = 0;
  session.payment_intent.latest_charge.disputed = true;
  await assert.rejects(() => payments.verifyPurchase("cs_test_123", stripe, "test"), { statusCode: 403 });
  session.payment_intent.latest_charge.disputed = false;
  session.line_items.data[0].price.id = "price_other";
  await assert.rejects(() => payments.verifyPurchase("cs_test_123", stripe, "test"), { statusCode: 403 });
  await assert.rejects(() => payments.verifyPurchase("cs_live_123", stripe, "test"), { statusCode: 403 });
});

test("checkout uses one verified $1.49 price and purchase exposes both available formats", async () => {
  const fake = fakeMusic({ ...track, wavStoragePath: "musicTracks/track1/file/wav.wav" });
  let created;
  const price = { id: "price_123", livemode: false, active: true, type: "one_time", currency: "usd",
    unit_amount: 149, billing_scheme: "per_unit" };
  const payment = {
    mode: () => "test",
    stripeClient: () => ({
      prices: { retrieve: async () => price },
      checkout: { sessions: { create: async (params) => {
        created = params;
        return { url: "https://checkout.stripe.com/example", livemode: false };
      } } }
    }),
    priceId: () => "price_123",
    siteUrl: () => new URL("https://example.com/"),
    validatePrice: payments.validatePrice
  };
  const handler = checkoutHandler({ ...fake.dependencies, payment });
  const response = new Response();
  const input = Readable.from([Buffer.from(JSON.stringify({ id: "track1" }))]);
  input.method = "POST";
  await handler(input, response);
  assert.equal(response.statusCode, 200);
  assert.equal(created.line_items[0].price, "price_123");
  assert.deepEqual(created.payment_method_types, ["card"]);
  assert.equal(created.metadata.trackId, "track1");
  assert.match(created.success_url, /session_id=\{CHECKOUT_SESSION_ID\}$/);
  const purchase = await request(purchaseHandler(fake.dependencies), "/api/music?action=purchase&session_id=paid");
  assert.deepEqual(JSON.parse(purchase.body()).formats, ["mp3", "wav"]);
  const denied = await request(purchaseHandler(fake.dependencies), "/api/music?action=purchase");
  assert.equal(denied.statusCode, 403);
  assert.throws(() => payments.validatePrice({ ...price, unit_amount: 150 }, "price_123", false));
});

test("range and path validation reject malformed input", () => {
  assert.deepEqual(music.byteRange("bytes=-3", 10), { start: 7, end: 9 });
  assert.deepEqual(music.byteRange("bytes=7-", 10), { start: 7, end: 9 });
  assert.equal(music.byteRange("bytes=0-1,4-5", 10), false);
  assert.equal(music.filePath("track1", { mp3StoragePath: "musicTracks/other/file/mp3.mp3" }, "mp3"), null);
});

test("the consolidated music function routes configuration and rejects invalid requests", async () => {
  const previous = process.env.FIREBASE_STORAGE_BUCKET;
  process.env.FIREBASE_STORAGE_BUCKET = "test-bucket";
  try {
    const config = await request(musicHandler, "/api/music?action=config");
    assert.deepEqual(JSON.parse(config.body()), { storageBucket: "test-bucket" });
    const missingFile = await request(musicHandler, "/api/music?action=file");
    assert.equal(missingFile.statusCode, 400);
    const unknown = await request(musicHandler, "/api/music?action=unknown");
    assert.equal(unknown.statusCode, 404);
  } finally {
    if (previous === undefined) delete process.env.FIREBASE_STORAGE_BUCKET;
    else process.env.FIREBASE_STORAGE_BUCKET = previous;
  }
});
