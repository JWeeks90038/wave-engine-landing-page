const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { Readable, Writable } = require("node:stream");
const { createHandler: profileHandler } = require("../server/artist-profile-handler");
const { createHandler: releaseHandler } = require("../server/artist-releases-handler");
const { createHandler: adminHandler } = require("../server/artist-admin-handler");
const { createHandler: mediaHandler } = require("../server/artist-media-handler");
const { createHandler: paymentsHandler, artistStripeClient } = require("../server/artist-payments");
const marketplace = require("../server/artist-marketplace");

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

class FakeDatabase {
  constructor() { this.records = new Map(); }
  collection(name) {
    if (!this.records.has(name)) this.records.set(name, new Map());
    const records = this.records.get(name);
    return {
      doc: (id) => new FakeDocument(this, name, id || `generated-${Math.random().toString(36).slice(2, 12)}`),
      where: (field, operator, value) => ({
        get: async () => {
          assert.equal(operator, "==");
          const docs = [];
          for (const [id, data] of records) {
            if (data[field] === value) docs.push({ id, data: () => data });
          }
          return { docs };
        }
      })
    };
  }
  async runTransaction(work) {
    const writes = [];
    const transaction = {
      get: (ref) => ref.get(),
      create: (ref, data) => writes.push({ type: "create", ref, data }),
      update: (ref, data) => writes.push({ type: "update", ref, data })
    };
    const result = await work(transaction);
    for (const write of writes) {
      const current = write.ref.current();
      if (write.type === "create") {
        if (current) throw new Error("Document already exists.");
        write.ref.records().set(write.ref.id, write.data);
      } else {
        if (!current) throw new Error("Document does not exist.");
        write.ref.records().set(write.ref.id, { ...current, ...write.data });
      }
    }
    return result;
  }
}

class FakeDocument {
  constructor(database, collection, id) {
    this.database = database;
    this.collectionName = collection;
    this.id = id;
  }
  records() { return this.database.records.get(this.collectionName); }
  current() { return this.records().get(this.id); }
  async get() {
    const data = this.current();
    return { exists: Boolean(data), id: this.id, data: () => data };
  }
  async create(data) {
    if (this.current()) throw new Error("Document already exists.");
    this.records().set(this.id, data);
  }
}

function request(handler, method, url, body, authorization = "Bearer valid", headers = {}) {
  const input = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  input.method = method;
  input.url = url;
  input.headers = { authorization, ...headers };
  const response = new Response();
  return handler(input, response).then(() => response);
}

function fakeAuth(user = { uid: "artist-1", email_verified: true }) {
  return async (_request, adminOnly = false) => {
    if (adminOnly && user.admin !== true) throw marketplace.statusError("Administrator access is required.", 403);
    if (!adminOnly && user.email_verified !== true) throw marketplace.statusError("Verify your email address.", 403);
    return user;
  };
}

test("artist profile creation reserves a unique slug and stays private until approval", async () => {
  const db = new FakeDatabase();
  let user = { uid: "artist-1", email_verified: true };
  const claimChanges = [];
  const handler = profileHandler({
    database: () => db,
    authenticate: fakeAuth(user),
    setArtistUploadClaim: async (uid, enabled) => claimChanges.push([uid, enabled])
  });
  const input = {
    action: "create",
    artistName: "North Star",
    slug: "north-star",
    biography: "Independent music.",
    socialLinks: { website: "https://example.com" }
  };
  const created = await request(handler, "POST", "/api/artist-profile", input);
  assert.equal(created.statusCode, 201);
  assert.equal(JSON.parse(created.body()).profile.status, "pending");
  assert.equal(JSON.parse(created.body()).tokenRefreshRequired, true);
  assert.deepEqual(claimChanges, [["artist-1", true]]);
  assert.equal(db.records.get("artists").get("artist-1").status, "pending");
  assert.equal(db.records.get("artistSlugs").get("north-star").status, "pending");

  const hidden = await request(handler, "GET", "/api/artist-profile?slug=north-star", undefined, "");
  assert.equal(hidden.statusCode, 404);

  user = { uid: "artist-2", email_verified: true };
  const duplicate = profileHandler({ database: () => db, authenticate: fakeAuth(user) });
  const conflict = await request(duplicate, "POST", "/api/artist-profile", { ...input, artistName: "Another Artist" });
  assert.equal(conflict.statusCode, 409);
});

test("artist admin approval is privileged and makes the storefront public", async () => {
  const db = new FakeDatabase();
  db.records.set("artists", new Map([["artist-1", {
    artistName: "North Star", slug: "north-star", biography: "Independent music.",
    socialLinks: {}, status: "pending", avatarPath: "", bannerPath: ""
  }]]));
  db.records.set("artistSlugs", new Map([["north-star", { artistUid: "artist-1", status: "pending" }]]));
  let admin = false;
  const claimChanges = [];
  const authenticate = async (_request, adminOnly) => {
    if (adminOnly && !admin) throw marketplace.statusError("Administrator access is required.", 403);
    return { uid: admin ? "admin-1" : "artist-1" };
  };
  const adminApi = adminHandler({
    database: () => db,
    authenticate,
    setArtistUploadClaim: async (uid, enabled) => claimChanges.push([uid, enabled])
  });
  const denied = await request(adminApi, "POST", "/api/artist-admin", {
    action: "approve", artistUid: "artist-1"
  });
  assert.equal(denied.statusCode, 403);

  admin = true;
  const approved = await request(adminApi, "POST", "/api/artist-admin", {
    action: "approve", artistUid: "artist-1"
  });
  assert.equal(approved.statusCode, 200);
  assert.equal(db.records.get("artistSlugs").get("north-star").status, "approved");
  assert.deepEqual(claimChanges, [["artist-1", true]]);

  db.records.get("artists").set("artist-2", {
    artistName: "South Star", slug: "south-star", biography: "",
    socialLinks: {}, status: "pending", avatarPath: "", bannerPath: ""
  });
  db.records.get("artistSlugs").set("south-star", { artistUid: "artist-2", status: "pending" });
  const rejected = await request(adminApi, "POST", "/api/artist-admin", {
    action: "reject", artistUid: "artist-2"
  });
  assert.equal(rejected.statusCode, 200);
  assert.deepEqual(claimChanges[1], ["artist-2", false]);

  const publicProfile = await request(profileHandler({ database: () => db }), "GET",
    "/api/artist-profile?slug=north-star", undefined, "");
  const profile = JSON.parse(publicProfile.body()).profile;
  assert.equal(publicProfile.statusCode, 200);
  assert.equal(profile.artistName, "North Star");
  assert.equal(profile.uid, undefined);
  assert.equal(profile.status, "approved");
});

test("artist drafts are owner-scoped and reject storage paths outside the artist folder", async () => {
  const db = new FakeDatabase();
  db.records.set("artists", new Map([["artist-1", {
    artistName: "North Star", status: "pending"
  }]]));
  const handler = releaseHandler({
    database: () => db,
    authenticate: fakeAuth(),
    bucket: () => { throw new Error("Storage should not be read for empty draft paths."); }
  });
  const created = await request(handler, "POST", "/api/artist-releases", {
    action: "create",
    title: "First Light",
    description: "",
    genre: "Electronic",
    releaseType: "single",
    moods: ["inspired"],
    audioPath: "",
    coverPath: ""
  });
  assert.equal(created.statusCode, 201);
  const release = JSON.parse(created.body()).release;
  assert.equal(release.status, "draft");
  assert.equal(db.records.get("artistReleases").get(release.id).artistUid, "artist-1");

  const spoofedPath = await request(handler, "POST", "/api/artist-releases", {
    action: "update",
    id: release.id,
    title: "First Light",
    description: "",
    genre: "Electronic",
    releaseType: "single",
    moods: [],
    audioPath: "artistUploads/another-user/not-owned/audio.mp3",
    coverPath: ""
  });
  assert.equal(spoofedPath.statusCode, 400);

  const foreign = releaseHandler({
    database: () => db,
    authenticate: fakeAuth({ uid: "artist-2", email_verified: true })
  });
  db.records.get("artists").set("artist-2", { artistName: "Other", status: "pending" });
  const crossAccount = await request(foreign, "POST", "/api/artist-releases", {
    action: "update",
    id: release.id,
    title: "Changed",
    description: "",
    genre: "",
    releaseType: "single",
    moods: [],
    audioPath: "",
    coverPath: ""
  });
  assert.equal(crossAccount.statusCode, 404);
});

test("track publication requires rights and review, pins audio, and supports takedown", async () => {
  const db = new FakeDatabase();
  const uid = "artist-1";
  const id = "release-1";
  const audioPath = `artistUploads/${uid}/${id}-12345678-1234-1234-1234-123456789012/audio.mp3`;
  db.records.set("artists", new Map([[uid, {
    artistName: "North Star", slug: "north-star", status: "approved", socialLinks: {}
  }]]));
  db.records.set("artistSlugs", new Map([["north-star", { artistUid: uid, status: "approved" }]]));
  db.records.set("artistReleases", new Map([[id, {
    artistUid: uid, status: "draft", title: "First Light", description: "", genre: "Rock",
    releaseType: "single", moods: [], audioPath, coverPath: ""
  }]]));
  let generation = "101";
  let audio = Buffer.from("audio");
  const bucket = () => ({
    file: (filePath, options = {}) => ({
      getMetadata: async () => {
        assert.equal(filePath, audioPath);
        if (options.generation && options.generation !== generation) {
          const error = new Error("Object not found");
          error.code = 404;
          throw error;
        }
        return [{ contentType: "audio/mpeg", size: audio.length, generation }];
      },
      createReadStream: ({ start, end }) => Readable.from([audio.subarray(start, end + 1)])
    })
  });
  const artist = releaseHandler({ database: () => db, authenticate: fakeAuth(), bucket });
  const admin = adminHandler({
    database: () => db, authenticate: fakeAuth({ uid: "admin-1", admin: true }), bucket
  });
  const visitor = (url, headers) => request(artist, "GET", url, undefined, "", headers);
  const publicBefore = await visitor("/api/artist-releases?action=public");
  assert.deepEqual(JSON.parse(publicBefore.body()).artists[0].tracks, []);
  assert.equal((await visitor(`/api/artist-releases?action=stream&id=${id}`)).statusCode, 404);
  assert.equal((await request(artist, "POST", "/api/artist-releases", { action: "submit", id })).statusCode, 400);
  const stranger = releaseHandler({ database: () => db, authenticate: fakeAuth({ uid: "artist-2", email_verified: true }), bucket });
  db.records.get("artists").set("artist-2", { status: "pending" });
  assert.equal((await request(stranger, "POST", "/api/artist-releases", {
    action: "submit", id, rightsConfirmed: true
  })).statusCode, 404);
  db.records.get("artistReleases").get(id).downloadPriceCents = 155;
  assert.equal((await request(artist, "POST", "/api/artist-releases", { action: "submit", id, rightsConfirmed: true })).statusCode, 400);
  delete db.records.get("artistReleases").get(id).downloadPriceCents;
  const submitted = await request(artist, "POST", "/api/artist-releases", { action: "submit", id, rightsConfirmed: true });
  assert.equal(submitted.statusCode, 200);
  assert.equal(db.records.get("artistReleases").get(id).audioGeneration, "101");
  assert.equal((await request(admin, "GET", "/api/artist-admin?type=releases")).statusCode, 200);
  assert.equal((await visitor(`/api/artist-releases?action=stream&id=${id}`)).statusCode, 404);
  assert.equal((await request(artist, "GET", `/api/artist-releases?action=review&id=${id}`)).statusCode, 403);
  const review = releaseHandler({ database: () => db, authenticate: fakeAuth({ uid: "admin-1", admin: true }), bucket });
  assert.equal((await request(review, "GET", `/api/artist-releases?action=review&id=${id}`)).body(), "audio");
  const edit = await request(artist, "POST", "/api/artist-releases", {
    action: "update", id, title: "Changed", description: "", genre: "Rock",
    releaseType: "single", moods: [], audioPath, coverPath: ""
  });
  assert.equal(edit.statusCode, 409);
  const denied = await request(adminHandler({ database: () => db, authenticate: fakeAuth(), bucket }),
    "POST", "/api/artist-admin", { action: "approve-release", id });
  assert.equal(denied.statusCode, 403);
  db.records.get("artistReleases").get(id).rightsConfirmed = false;
  assert.equal((await request(admin, "POST", "/api/artist-admin", { action: "approve-release", id })).statusCode, 409);
  db.records.get("artistReleases").get(id).rightsConfirmed = true;
  assert.equal((await request(admin, "POST", "/api/artist-admin", { action: "approve-release", id })).statusCode, 200);
  const publicAfter = JSON.parse((await visitor("/api/artist-releases?action=public")).body());
  const northStar = publicAfter.artists.find((entry) => entry.slug === "north-star");
  assert.deepEqual(northStar.tracks, [{ id, title: "First Light", genre: "Rock", downloadPriceCents: null, format: "MP3" }]);
  assert.doesNotMatch(JSON.stringify(publicAfter), /artistUploads|artistUid|audioGeneration/);
  const partial = await visitor(`/api/artist-releases?action=stream&id=${id}`, { range: "bytes=1-3" });
  assert.equal(partial.statusCode, 206);
  assert.equal(partial.body(), "udi");
  assert.equal(partial.headers["content-range"], "bytes 1-3/5");
  assert.equal((await visitor(`/api/artist-releases?action=stream&id=${id}`, { range: "bytes=8-9" })).statusCode, 416);
  audio = Buffer.alloc(3 * 1024 * 1024);
  const capped = await visitor(`/api/artist-releases?action=stream&id=${id}`, { range: "bytes=0-" });
  assert.equal(capped.headers["content-range"], "bytes 0-2097151/3145728");
  assert.equal(capped.chunks.reduce((size, chunk) => size + chunk.length, 0), 2 * 1024 * 1024);
  audio = Buffer.from("audio");
  db.records.get("artistReleases").get(id).rightsConfirmed = false;
  assert.deepEqual(JSON.parse((await visitor("/api/artist-releases?action=public")).body()).artists[0].tracks, []);
  assert.equal((await visitor(`/api/artist-releases?action=stream&id=${id}`)).statusCode, 404);
  db.records.get("artistReleases").get(id).rightsConfirmed = true;
  db.records.get("artistSlugs").get("north-star").status = "rejected";
  assert.deepEqual(JSON.parse((await visitor("/api/artist-releases?action=public")).body()).artists, []);
  assert.equal((await visitor(`/api/artist-releases?action=stream&id=${id}`)).statusCode, 404);
  db.records.get("artistSlugs").get("north-star").status = "approved";
  db.records.get("artists").get(uid).status = "suspended";
  assert.equal((await visitor(`/api/artist-releases?action=stream&id=${id}`)).statusCode, 404);
  db.records.get("artists").get(uid).status = "approved";
  generation = "102";
  assert.equal((await visitor(`/api/artist-releases?action=stream&id=${id}`)).statusCode, 404);
  generation = "101";
  assert.equal((await request(artist, "POST", "/api/artist-releases", { action: "withdraw", id })).statusCode, 200);
  assert.equal((await visitor(`/api/artist-releases?action=stream&id=${id}`)).statusCode, 404);
  assert.equal((await request(artist, "POST", "/api/artist-releases", { action: "submit", id, rightsConfirmed: true })).statusCode, 200);
  assert.equal((await request(admin, "POST", "/api/artist-admin", { action: "approve-release", id })).statusCode, 200);
  assert.equal((await request(admin, "POST", "/api/artist-admin", { action: "unpublish-release", id })).statusCode, 200);
  assert.equal((await visitor(`/api/artist-releases?action=stream&id=${id}`)).statusCode, 404);
});

test("artist circles show the selected artist's tracks and stop previous playback", async () => {
  class Element {
    constructor(tag) {
      this.tagName = tag.toUpperCase();
      this.children = [];
      this.attributes = {};
      this.events = {};
      this.hidden = false;
      this.paused = false;
      this.style = { setProperty() {} };
    }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    setAttribute(name, value) { this.attributes[name] = value; }
    addEventListener(name, callback) { this.events[name] = callback; }
    querySelectorAll(tag) {
      return this.children.flatMap((child) =>
        [...(child.tagName === tag.toUpperCase() ? [child] : []), ...child.querySelectorAll(tag)]);
    }
    pause() { this.paused = true; }
  }
  const status = new Element("p");
  const list = new Element("div");
  const selection = new Element("div");
  selection.hidden = true;
  const elements = {
    "#artist-discovery-status": status,
    "#artist-discovery-list": list,
    "#artist-discovery-selection": selection
  };
  const document = {
    querySelector: (selector) => elements[selector] || null,
    createElement: (tag) => new Element(tag),
    addEventListener() {}
  };
  const source = fs.readFileSync(path.join(__dirname, "..", "artist-listen.js"), "utf8");
  await vm.runInNewContext(`(async () => {\n${source}\n})()`, {
    document, location: { protocol: "https:", hostname: "example.com" },
    fetch: async () => ({ ok: true, json: async () => ({ artists: [
      { artistName: "North Star", slug: "north-star", tracks: [{ id: "track-1", title: "First Light" }] },
      { artistName: "South Star", slug: "south-star", tracks: [] }
    ] }) }),
    URL, URLSearchParams
  });
  const first = list.children[0].children[0];
  const second = list.children[1].children[0];
  first.events.pointerenter({ pointerType: "mouse" });
  assert.equal(selection.hidden, false);
  assert.equal(first.attributes["aria-expanded"], "true");
  assert.equal(selection.children[1].href, "/artist/north-star");
  const audio = selection.querySelectorAll("audio")[0];
  assert.match(audio.src, /action=stream&id=track-1/);
  second.events.focus();
  assert.equal(audio.paused, true);
  assert.equal(first.attributes["aria-expanded"], "false");
  assert.equal(second.attributes["aria-expanded"], "true");
  assert.equal(selection.children[2].textContent, "No tracks available yet.");
});

test("artist checkout uses connected account pricing and verifies paid downloads", async () => {
  const db = new FakeDatabase();
  const audioPath = "artistUploads/artist-1/release-1-12345678-1234-1234-1234-123456789012/audio.mp3";
  db.records.set("artists", new Map([["artist-1", {
    status: "approved", slug: "north-star", stripeConnectLive: "acct_123"
  }]]));
  db.records.set("artistSlugs", new Map([["north-star", { status: "approved", artistUid: "artist-1" }]]));
  db.records.set("artistReleases", new Map([["release-1", {
    artistUid: "artist-1", status: "published", rightsConfirmed: true, salesRightsConfirmed: true,
    title: "First Light", description: "", genre: "", moods: [], releaseType: "single",
    audioPath, coverPath: "", audioGeneration: "101", downloadPriceCents: 155
  }]]));
  let account = { charges_enabled: true, payouts_enabled: true, controller: { fees: { payer: "account" } } };
  let checkout;
  let session;
  const stripe = {
    accounts: { retrieve: async () => account },
    checkout: { sessions: {
      create: async (data, options) => {
        checkout = { data, options };
        session = {
          id: "cs_live_123", url: "https://checkout.stripe.com/test", livemode: true,
          mode: "payment", status: "complete", payment_status: "paid", currency: "usd",
          amount_subtotal: 155, amount_total: 155, metadata: data.metadata,
          line_items: { data: [{ quantity: 1, price: { currency: "usd", unit_amount: 155 } }] },
          payment_intent: { status: "succeeded", application_fee_amount: 16,
            latest_charge: { status: "succeeded", refunded: false, amount_refunded: 0,
              disputed: false, created: Math.floor(Date.now() / 1000) } }
        };
        return session;
      },
      retrieve: async (id, _options, context) => {
        assert.equal(id, "cs_live_123");
        assert.equal(context.stripeAccount, "acct_123");
        return session;
      }
    } }
  };
  const bucket = () => ({ file: (_path, options) => ({
    getMetadata: async () => { assert.equal(options.generation, "101"); return [{ size: 5, contentType: "audio/mpeg" }]; },
    createReadStream: ({ start, end }) => Readable.from([Buffer.from("audio").subarray(start, end + 1)])
  }) });
  const handler = paymentsHandler({
    database: () => db, authenticate: fakeAuth(), bucket, enabled: () => true,
    payment: { mode: () => "live", stripeClient: () => stripe, siteUrl: () => new URL("https://example.com/") }
  });
  account.controller.fees.payer = "application";
  assert.equal((await request(handler, "POST", "/api/artist-releases?action=checkout", { id: "release-1" })).statusCode, 409);
  account.controller.fees.payer = "account";
  const checkoutResponse = await request(handler, "POST", "/api/artist-releases?action=checkout", { id: "release-1", amount: 1 });
  assert.equal(checkoutResponse.statusCode, 200);
  assert.equal(checkout.options.stripeAccount, "acct_123");
  assert.equal(checkout.data.line_items[0].price_data.unit_amount, 155);
  assert.equal(checkout.data.payment_intent_data.application_fee_amount, 16);
  const purchaseId = checkout.data.metadata.purchaseId;
  const url = `/api/artist-releases?action=purchase&purchase_id=${purchaseId}&session_id=cs_live_123`;
  assert.equal((await request(handler, "GET", url)).statusCode, 200);
  const download = await request(handler, "GET", url.replace("action=purchase", "action=download"));
  assert.equal(download.body(), "audio");
  assert.match(download.headers["content-disposition"], /attachment/);
  session.payment_intent.latest_charge.refunded = true;
  assert.equal((await request(handler, "GET", url)).statusCode, 403);
  session.payment_intent.latest_charge.refunded = false;
  session.payment_intent.latest_charge.created -= 600;
  assert.equal((await request(handler, "GET", url)).statusCode, 410);
});

test("artist Stripe onboarding creates and reuses an artist-owned account", async () => {
  const db = new FakeDatabase();
  db.records.set("artists", new Map([["artist-1", { status: "approved", slug: "north-star" }]]));
  let creates = 0;
  const stripe = {
    accounts: {
      create: async (data, options) => {
        creates++;
        assert.equal(data.type, "standard");
        assert.match(options.idempotencyKey, /^artist-connect-live-/);
        return { id: "acct_123" };
      },
      retrieve: async () => ({ charges_enabled: true, payouts_enabled: true, controller: { fees: { payer: "account" } } })
    },
    accountLinks: { create: async (data) => {
      assert.equal(data.account, "acct_123");
      assert.equal(data.type, "account_onboarding");
      return { url: "https://connect.stripe.com/onboarding" };
    } }
  };
  const handler = paymentsHandler({
    database: () => db, authenticate: fakeAuth(), enabled: () => true,
    payment: { mode: () => "live", stripeClient: () => stripe, siteUrl: () => new URL("https://example.com/") }
  });
  assert.equal((await request(handler, "POST", "/api/artist-releases?action=connect")).statusCode, 200);
  assert.equal((await request(handler, "POST", "/api/artist-releases?action=connect")).statusCode, 200);
  assert.equal(creates, 1);
  assert.equal(db.records.get("artists").get("artist-1").stripeConnectLive, "acct_123");
  assert.equal(JSON.parse((await request(handler, "GET", "/api/artist-releases?action=connect")).body()).ready, true);
});

test("artist Stripe client requires a separate key matching the configured mode", () => {
  const original = {
    MUSIC_STRIPE_MODE: process.env.MUSIC_STRIPE_MODE,
    STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY,
    ARTIST_STRIPE_SECRET_KEY: process.env.ARTIST_STRIPE_SECRET_KEY
  };
  try {
    process.env.MUSIC_STRIPE_MODE = "live";
    process.env.STRIPE_SECRET_KEY = "rk_live_existing";
    delete process.env.ARTIST_STRIPE_SECRET_KEY;
    assert.throws(() => artistStripeClient(), /ARTIST_STRIPE_SECRET_KEY/);
    process.env.ARTIST_STRIPE_SECRET_KEY = "rk_test_artist";
    assert.throws(() => artistStripeClient(), /ARTIST_STRIPE_SECRET_KEY/);
    process.env.ARTIST_STRIPE_SECRET_KEY = "rk_live_artist";
    assert.ok(artistStripeClient().checkout.sessions);
    process.env.MUSIC_STRIPE_MODE = "test";
    process.env.ARTIST_STRIPE_SECRET_KEY = "rk_test_artist";
    assert.ok(artistStripeClient().accounts);
  } finally {
    for (const [name, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("artist draft download prices must be whole cents within the permitted range", () => {
  const draft = { title: "Track", description: "", genre: "", releaseType: "single", moods: [] };
  for (const price of [49, 10001, 50.5, "149"]) {
    assert.throws(() => marketplace.validateReleaseInput("artist-1", "release-1", { ...draft, downloadPriceCents: price }));
  }
  for (const price of [50, 10000, null]) {
    assert.equal(marketplace.validateReleaseInput("artist-1", "release-1", { ...draft, downloadPriceCents: price }).downloadPriceCents, price);
  }
});

test("artist images are served only for approved profiles", async () => {
  const path = "artistUploads/artist-1/profile-12345678-1234-1234-1234-123456789012/avatar.png";
  const db = new FakeDatabase();
  db.records.set("artistSlugs", new Map([["north-star", { artistUid: "artist-1", status: "pending" }]]));
  db.records.set("artists", new Map([["artist-1", {
    slug: "north-star", status: "pending", avatarPath: path
  }]]));
  let storageReads = 0;
  const handler = mediaHandler({
    database: () => db,
    bucket: () => ({
      file: () => ({
        getMetadata: async () => {
          storageReads++;
          return [{ contentType: "image/png", size: 3 }];
        },
        createReadStream: () => Readable.from([Buffer.from("img")])
      })
    })
  });
  const hidden = await request(handler, "GET", "/api/artist-media?slug=north-star&asset=avatar", undefined, "");
  assert.equal(hidden.statusCode, 404);
  assert.equal(storageReads, 0);

  db.records.get("artists").get("artist-1").status = "approved";
  db.records.get("artistSlugs").get("north-star").status = "approved";
  const publicImage = await request(handler, "GET", "/api/artist-media?slug=north-star&asset=avatar", undefined, "");
  assert.equal(publicImage.statusCode, 200);
  assert.equal(publicImage.headers["content-type"], "image/png");
  assert.equal(publicImage.body(), "img");
  assert.equal(storageReads, 1);
});

test("artist identifiers, URLs, and upload paths reject unsafe values", () => {
  const uuid = "12345678-1234-1234-1234-123456789012";
  assert.equal(marketplace.validateSlug("North-Star"), "north-star");
  assert.throws(() => marketplace.validateSlug("api"));
  assert.throws(() => marketplace.validateSocialLinks({ website: "javascript:alert(1)" }));
  assert.throws(() => marketplace.validateProfileAssetPath(
    "artist-1", "avatar", "artistUploads/artist-1/profile-../../../avatar.png"
  ));
  assert.equal(
    marketplace.validateProfileAssetPath("artist-1", "avatar",
      `artistUploads/artist-1/profile-${uuid}/avatar.png`),
    `artistUploads/artist-1/profile-${uuid}/avatar.png`
  );
  assert.equal(marketplace.validateReleaseInput("artist-1", "release-1", {
    title: "First Light",
    description: "",
    genre: "Electronic",
    releaseType: "single",
    moods: [],
    audioPath: `artistUploads/artist-1/release-1-${uuid}/audio.mp3`,
    coverPath: ""
  }).audioPath, `artistUploads/artist-1/release-1-${uuid}/audio.mp3`);
});

test("unverified users cannot create artist profiles", async () => {
  let databaseCalls = 0;
  const handler = profileHandler({
    database: () => { databaseCalls++; return new FakeDatabase(); },
    authenticate: fakeAuth({ uid: "artist-1", email_verified: false })
  });
  const response = await request(handler, "POST", "/api/artist-profile", {
    action: "create",
    artistName: "North Star",
    slug: "north-star",
    biography: "",
    socialLinks: {}
  });
  assert.equal(response.statusCode, 403);
  assert.equal(databaseCalls, 0);
});

test("artist upload claim changes preserve unrelated custom claims", async () => {
  let claims;
  const auth = {
    getUser: async () => ({ customClaims: { admin: true, unrelated: "retained" } }),
    setCustomUserClaims: async (uid, value) => { claims = { uid, value }; }
  };
  await marketplace.setArtistUploadClaim("artist-1", true, auth);
  assert.deepEqual(claims, {
    uid: "artist-1",
    value: { admin: true, unrelated: "retained", artistUpload: true }
  });
  await marketplace.setArtistUploadClaim("artist-1", false, auth);
  assert.deepEqual(claims, {
    uid: "artist-1",
    value: { admin: true, unrelated: "retained" }
  });
});

test("artist profile reads reconcile stale upload claims", async () => {
  const db = new FakeDatabase();
  db.records.set("artists", new Map([["artist-1", {
    artistName: "North Star", slug: "north-star", biography: "",
    socialLinks: {}, status: "pending", avatarPath: "", bannerPath: ""
  }]]));
  const claimChanges = [];
  const handler = profileHandler({
    database: () => db,
    authenticate: fakeAuth(),
    setArtistUploadClaim: async (uid, enabled) => claimChanges.push([uid, enabled])
  });
  const result = await request(handler, "GET", "/api/artist-profile?me=1");
  assert.equal(result.statusCode, 200);
  assert.equal(JSON.parse(result.body()).tokenRefreshRequired, true);
  assert.deepEqual(claimChanges, [["artist-1", true]]);
});

test("approved storefront renders with metadata from the page", async () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "artist.html"), "utf8");
  const source = fs.readFileSync(path.join(__dirname, "..", "artist.js"), "utf8");
  const selectors = [
    "#storefront-status", "#storefront-profile", "#storefront-name",
    "#storefront-bio", "#storefront-socials"
  ];
  const elements = Object.fromEntries(selectors.map((selector) => [selector, { hidden: true, append() {} }]));
  for (const [attribute, name] of [
    ["property", "og:title"], ["property", "og:description"],
    ["name", "description"], ["name", "twitter:title"], ["name", "twitter:description"]
  ]) {
    if (html.includes(`${attribute}="${name}"`)) elements[`meta[${attribute}="${name}"]`] = {};
  }
  const document = {
    querySelector: (selector) => elements[selector] || null,
    createElement: () => ({}),
    head: { append() {} }
  };
  await vm.runInNewContext(`(async () => {\n${source}\n})()`, {
    document,
    location: { protocol: "https:", hostname: "example.com", origin: "https://example.com", pathname: "/artist/north-star", search: "" },
    fetch: async () => ({ ok: true, json: async () => ({
      profile: { artistName: "North Star", slug: "north-star", biography: "Independent music.", socialLinks: {} }
    }) }),
    URL, URLSearchParams
  });
  assert.equal(elements["#storefront-profile"].hidden, false);
  assert.equal(elements["#storefront-status"].textContent, "");
  assert.equal(elements['meta[name="twitter:title"]'].content, "North Star | Wave Engine Music");
});

test("switching from a rejected artist to a new account enables the profile form", async () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "artist-dashboard.js"), "utf8")
    .replace(/^import[\s\S]*?from "[^"]+";\r?\n/gm, "");
  const elements = new Map();
  function element(selector) {
    if (!elements.has(selector)) elements.set(selector, {
      hidden: false, textContent: "", addEventListener() {}, replaceChildren() {},
      querySelectorAll: () => [], contains: () => false, reset() {}
    });
    return elements.get(selector);
  }
  const controls = ["artistName", "slug", "biography", "website", "instagram", "youtube", "tiktok"]
    .map(() => ({ value: "", disabled: false }));
  for (const [index, name] of ["artistName", "slug", "biography", "website", "instagram", "youtube", "tiktok"].entries()) {
    controls[name] = controls[index];
  }
  const profileControls = { value: "50", addEventListener() {} };
  controls.bannerPositionY = profileControls;
  controls.banner = { files: [], addEventListener() {} };
  element("#banner-preview").style = {};
  element("#artist-profile-form").elements = controls;
  element("#artist-release-form").elements = {
    genre: { querySelector: () => null, querySelectorAll: () => [], options: [], addEventListener() {} }
  };
  const document = { querySelector: element, createElement: () => ({}) };
  let onAuth;
  await vm.runInNewContext(`(async () => {\n${source}\n})()`, {
    document,
    location: { protocol: "https:", hostname: "example.com" },
    firebaseClient: async () => ({}), getAuth: () => ({}), getStorage: () => ({}),
    onAuthStateChanged: (_auth, callback) => { onAuth = callback; },
    fetch: async (url) => {
      if (url.includes("action=config")) return { ok: true, json: async () => ({ storageBucket: "bucket" }) };
      if (url.includes("artist-releases")) return { ok: true, json: async () => ({ releases: [] }) };
      if (url.includes("artist-profile")) {
        return currentAccount === "rejected"
          ? { ok: true, json: async () => ({ profile: { status: "rejected", artistName: "Artist", slug: "artist", socialLinks: {} } }) }
          : { ok: false, json: async () => ({ error: "No artist profile is registered for this account." }) };
      }
      throw new Error(`Unexpected request: ${url}`);
    },
    URL, URLSearchParams
  });
  let currentAccount = "rejected";
  const user = { email: "artist@example.com", emailVerified: true, getIdToken: async () => "token" };
  await onAuth(user);
  assert.ok(controls.every((control) => control.disabled));
  await onAuth(null);
  currentAccount = "new";
  await onAuth(user);
  assert.ok(controls.every((control) => !control.disabled));
});

test("banner position accepts whole numbers from 0 to 100 and defaults to center", () => {
  assert.equal(marketplace.validateBannerPosition(undefined), 50);
  assert.equal(marketplace.validateBannerPosition(0), 0);
  assert.equal(marketplace.validateBannerPosition(100), 100);
  for (const bad of [-1, 101, 12.5, "40", NaN]) {
    assert.throws(() => marketplace.validateBannerPosition(bad), /0 to 100/);
  }
});

test("draft form offers genre selections without a mood control", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "artist-dashboard.html"), "utf8");
  assert.match(html, /<select id="artist-genre" name="genre">/);
  assert.doesNotMatch(html, /name="moods"/);
  for (const genre of ["Rock", "Hip-Hop", "Gospel", "Cinematic", "Afrobeats", "Other"]) {
    assert.ok(html.includes(`<option>${genre}</option>`));
  }
});

test("editing a draft preserves its legacy genre and moods while new drafts have no moods", async () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "artist-dashboard.js"), "utf8")
    .replace(/^import[\s\S]*?from "[^"]+";\r?\n/gm, "");
  const elements = new Map();
  function element(selector) {
    if (!elements.has(selector)) elements.set(selector, {
      listeners: {}, hidden: false, textContent: "",
      addEventListener(name, callback) { this.listeners[name] = callback; },
      replaceChildren() {}, append() {}, querySelectorAll: () => [],
      contains: () => false, reset() {}, scrollIntoView() {}
    });
    return elements.get(selector);
  }
  const genre = {
    value: "", options: [{ value: "" }, { value: "Rock" }, { value: "Raï" }, { value: "Other" }],
    addEventListener() {},
    querySelectorAll: () => [],
    querySelector() { return this.options.find((option) => option.dataset && option.dataset.legacyGenre) || null; },
    append(option) {
      option.remove = () => { this.options = this.options.filter((item) => item !== option); };
      this.options.push(option);
    }
  };
  const releaseForm = element("#artist-release-form");
  releaseForm.elements = {
    title: { value: "" }, description: { value: "" }, downloadPrice: { value: "" }, genre,
    audio: { value: "", files: [] }, cover: { value: "", files: [] }
  };
  element("#artist-profile-form").elements = [];
  element("#artist-profile-form").elements.bannerPositionY = { value: "50", addEventListener() {} };
  element("#artist-profile-form").elements.banner = { files: [], addEventListener() {} };
  element("#banner-preview").style = {};
  const submitted = [];
  const document = { querySelector: element, createElement: () => ({ dataset: {} }) };
  const context = {
    document, location: { protocol: "https:", hostname: "example.com" },
    firebaseClient: async () => ({}), getAuth: () => ({}), getStorage: () => ({}),
    onAuthStateChanged() {},
    fetch: async (url, options = {}) => {
      if (url.includes("action=config")) return { ok: true, json: async () => ({ storageBucket: "bucket" }) };
      if (url.includes("artist-releases") && options.method === "POST") {
        const body = JSON.parse(options.body);
        submitted.push(body);
        return { ok: true, json: async () => ({ release: { ...body, id: body.id || "new-id" } }) };
      }
      if (url.includes("artist-releases")) return { ok: true, json: async () => ({ releases: [] }) };
      throw new Error(`Unexpected request: ${url}`);
    },
    URL, URLSearchParams
  };
  await vm.runInNewContext(`(async () => {\n${source}\nglobalThis.testEditDraft = editDraft;\nglobalThis.testSetUser = (user) => { currentUser = user; };\n})()`, context);
  context.testSetUser({ uid: "artist-1", getIdToken: async () => "token" });
  context.testEditDraft({ id: "old-id", title: "Existing", genre: "Unlisted genre", moods: ["inspired"] });
  assert.equal(genre.value, "Unlisted genre");
  const search = element("#artist-genre-search");
  search.value = "RAI";
  search.listeners.input();
  assert.equal(genre.options.find((option) => option.value === "Raï").hidden, false);
  assert.equal(genre.options.find((option) => option.value === "Rock").hidden, true);
  assert.equal(genre.options.find((option) => option.value === "Unlisted genre").hidden, false);
  search.value = "no such genre";
  search.listeners.input();
  assert.match(element("#artist-genre-search-status").textContent, /No matching genres/);
  assert.equal(genre.options.find((option) => option.value === "Other").hidden, false);
  assert.equal(genre.value, "Unlisted genre");
  await releaseForm.listeners.submit({ preventDefault() {} });
  assert.equal(submitted[0].genre, "Unlisted genre");
  assert.deepEqual(submitted[0].moods, ["inspired"]);
  assert.equal(genre.querySelector(), null);
  assert.equal(search.value, "");
  assert.equal(genre.options.find((option) => option.value === "Rock").hidden, false);

  releaseForm.elements.title.value = "New";
  genre.value = "Rock";
  await releaseForm.listeners.submit({ preventDefault() {} });
  assert.equal(submitted[1].action, "create");
  assert.equal(submitted[1].genre, "Rock");
  assert.deepEqual(submitted[1].moods, []);
  assert.equal(submitted[2].genre, "Rock");
  assert.deepEqual(submitted[2].moods, []);
});
