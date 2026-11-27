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
const { publicArtists } = require("../server/artist-streaming");
const { createHandler: streamCountHandler } = require("../server/song-stream-counts");
const { createHandler: musicLibraryHandler } = require("../server/music-library-handler");
const musicLibrary = require("../server/music-library");
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
      update: (ref, data) => writes.push({ type: "update", ref, data }),
      set: (ref, data) => writes.push({ type: "set", ref, data })
    };
    const result = await work(transaction);
    for (const write of writes) {
      const current = write.ref.current();
      if (write.type === "create") {
        if (current) throw new Error("Document already exists.");
        write.ref.records().set(write.ref.id, write.data);
      } else if (write.type === "set") {
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

function addCustomizationControls(controls, element) {
  for (const [name, value] of [["accentColor", "#83b5f5"], ["backgroundColor", "#101a2d"], ["featuredMessage", ""]]) {
    controls[name] = { value, addEventListener() {} };
  }
  for (const name of ["backgroundImages", "galleryImages"]) {
    controls[name] = { files: [], value: "", addEventListener() {} };
  }
  for (const name of ["clearBackgroundImages", "clearGalleryImages"]) {
    controls[name] = { checked: false, addEventListener() {} };
  }
  element("#artist-style-preview").style = { setProperty() {} };
}

test("artist discovery checks slugs concurrently in bounded batches without exposing inactive profiles", async () => {
  const db = new FakeDatabase();
  for (let index = 0; index < 43; index++) {
    const uid = `artist-${index}`;
    const slug = `artist-${index}`;
    db.collection("artists").doc(uid);
    db.collection("artistSlugs").doc(slug);
    db.records.get("artists").set(uid, { artistName: `Artist ${index}`, slug, status: "approved" });
    db.records.get("artistSlugs").set(slug, { artistUid: uid, status: index === 42 ? "pending" : "approved" });
  }
  const originalCollection = db.collection.bind(db);
  let active = 0;
  let maximum = 0;
  db.collection = (name) => {
    const collection = originalCollection(name);
    if (name !== "artistSlugs") return collection;
    return { doc: (id) => {
      const ref = collection.doc(id);
      return { get: async () => {
        active++;
        maximum = Math.max(maximum, active);
        await new Promise((resolve) => setImmediate(resolve));
        active--;
        return ref.get();
      } };
    } };
  };
  const artists = await publicArtists(db);
  assert.equal(artists.length, 42);
  assert.equal(maximum, 20);
  assert.equal(artists.some((artist) => artist.slug === "artist-42"), false);
});

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
    socialLinks: { website: "https://example.com", facebook: "https://facebook.com/northstar" }
  };
  const created = await request(handler, "POST", "/api/artist-profile", input);
  assert.equal(created.statusCode, 201);
  assert.equal(JSON.parse(created.body()).profile.status, "pending");
  assert.equal(JSON.parse(created.body()).tokenRefreshRequired, true);
  assert.deepEqual(claimChanges, [["artist-1", true]]);
  assert.equal(db.records.get("artists").get("artist-1").status, "pending");
  assert.equal(JSON.parse(created.body()).profile.socialLinks.facebook, "https://facebook.com/northstar");
  assert.equal(db.records.get("artists").get("artist-1").socialLinks.facebook, "https://facebook.com/northstar");
  assert.equal(db.records.get("artistSlugs").get("north-star").status, "pending");

  const updated = await request(handler, "POST", "/api/artist-profile", {
    action: "update", artistName: "North Star", biography: "Updated",
    socialLinks: { facebook: "https://facebook.com/northstar" }
  });
  assert.equal(updated.statusCode, 200);
  assert.equal(JSON.parse(updated.body()).profile.socialLinks.facebook, "https://facebook.com/northstar");

  const hidden = await request(handler, "GET", "/api/artist-profile?slug=north-star", undefined, "");
  assert.equal(hidden.statusCode, 404);

  user = { uid: "artist-2", email_verified: true };
  const duplicate = profileHandler({ database: () => db, authenticate: fakeAuth(user) });
  const conflict = await request(duplicate, "POST", "/api/artist-profile", { ...input, artistName: "Another Artist" });
  assert.equal(conflict.statusCode, 409);
});

test("artist sitemap includes only approved canonical profiles and reflects status changes", async () => {
  const db = new FakeDatabase();
  db.records.set("artists", new Map([
    ["one", { status: "approved", slug: "north-star" }],
    ["two", { status: "pending", slug: "pending-star" }],
    ["three", { status: "approved", slug: "unapproved-slug" }],
    ["four", { status: "approved", slug: "wrong-owner" }],
    ["five", { status: "suspended", slug: "suspended-star" }]
  ]));
  db.records.set("artistSlugs", new Map([
    ["north-star", { status: "approved", artistUid: "one" }],
    ["pending-star", { status: "approved", artistUid: "two" }],
    ["unapproved-slug", { status: "pending", artistUid: "three" }],
    ["wrong-owner", { status: "approved", artistUid: "different" }],
    ["suspended-star", { status: "approved", artistUid: "five" }]
  ]));
  const handler = profileHandler({ database: () => db });
  const index = await request(handler, "GET", "/api/artist-profile?sitemap=index");
  assert.equal(index.statusCode, 200);
  assert.match(index.headers["content-type"], /^application\/xml/);
  assert.match(index.body(), /<loc>https:\/\/waveenginemusic\.com\/sitemap\.xml<\/loc>/);
  assert.match(index.body(), /<loc>https:\/\/waveenginemusic\.com\/sitemap-artists-1\.xml<\/loc>/);
  const page = await request(handler, "GET", "/api/artist-profile?sitemap=1");
  assert.equal(page.statusCode, 200);
  assert.deepEqual([...page.body().matchAll(/<loc>(.*?)<\/loc>/g)].map((match) => match[1]),
    ["https://waveenginemusic.com/artist/north-star"]);
  const head = await request(handler, "HEAD", "/api/artist-profile?sitemap=1");
  assert.equal(head.statusCode, 200);
  assert.equal(head.body(), "");
  assert.equal(head.headers["content-length"], String(Buffer.byteLength(page.body())));
  const previousSite = process.env.MUSIC_SITE_URL;
  process.env.MUSIC_SITE_URL = "https://staging.example.com/";
  try {
    const staging = await request(handler, "GET", "/api/artist-profile?sitemap=1");
    assert.match(staging.body(), /<loc>https:\/\/staging\.example\.com\/artist\/north-star<\/loc>/);
  } finally {
    if (previousSite === undefined) delete process.env.MUSIC_SITE_URL;
    else process.env.MUSIC_SITE_URL = previousSite;
  }

  db.records.get("artists").get("one").status = "suspended";
  const emptyIndex = await request(handler, "GET", "/api/artist-profile?sitemap=index");
  assert.doesNotMatch(emptyIndex.body(), /sitemap-artists-1\.xml/);
  assert.equal((await request(handler, "GET", "/api/artist-profile?sitemap=1")).statusCode, 404);
  assert.equal((await request(handler, "GET", "/api/artist-profile?sitemap=0")).statusCode, 404);
  assert.equal((await request(handler, "POST", "/api/artist-profile?sitemap=index")).statusCode, 405);
  const unavailable = profileHandler({ database: () => { throw new Error("Database unavailable"); } });
  assert.equal((await request(unavailable, "GET", "/api/artist-profile?sitemap=0")).statusCode, 404);
  assert.equal((await request(unavailable, "GET", "/api/artist-profile?sitemap=index")).statusCode, 503);
});

test("artist sitemap splits profiles into bounded pages", async () => {
  const db = new FakeDatabase();
  const artists = new Map();
  const slugs = new Map();
  for (let i = 0; i < 10001; i++) {
    const slug = `artist-${String(i).padStart(5, "0")}`;
    artists.set(`uid-${i}`, { status: "approved", slug });
    slugs.set(slug, { status: "approved", artistUid: `uid-${i}` });
  }
  db.records.set("artists", artists);
  db.records.set("artistSlugs", slugs);
  const handler = profileHandler({ database: () => db });
  const index = await request(handler, "GET", "/api/artist-profile?sitemap=index");
  assert.match(index.body(), /sitemap-artists-1\.xml/);
  assert.match(index.body(), /sitemap-artists-2\.xml/);
  assert.doesNotMatch(index.body(), /sitemap-artists-3\.xml/);
  const first = await request(handler, "GET", "/api/artist-profile?sitemap=1");
  const second = await request(handler, "GET", "/api/artist-profile?sitemap=2");
  assert.equal([...first.body().matchAll(/<url>/g)].length, 10000);
  assert.equal([...second.body().matchAll(/<url>/g)].length, 1);
  assert.match(first.body(), /\/artist\/artist-09999<\/loc>/);
  assert.match(second.body(), /\/artist\/artist-10000<\/loc>/);
});

test("artist share pages render approved profile metadata and public avatar without JavaScript", async () => {
  const previousSite = process.env.MUSIC_SITE_URL;
  process.env.MUSIC_SITE_URL = "https://staging.example.com/";
  try {
    const uid = "artist-1";
    const slug = "north-star";
    const avatarPath = `artistUploads/${uid}/profile-12345678-1234-1234-1234-123456789012/avatar.png`;
    const profile = {
      status: "approved", slug, artistName: 'North "Star" <script>', biography: 'Music & "light" <script>',
      socialLinks: {}, avatarPath, bannerPath: ""
    };
    const db = new FakeDatabase();
    db.records.set("artists", new Map([[uid, profile]]));
    db.records.set("artistSlugs", new Map([[slug, { artistUid: uid, status: "approved" }]]));
    const handler = profileHandler({ database: () => db });
    const response = await request(handler, "GET", `/api/artist-profile?page=1&slug=${slug}`, undefined, "",
      { host: "attacker.example" });
    assert.equal(response.statusCode, 200);
    assert.match(response.headers["content-type"], /^text\/html/);
    assert.equal(response.headers["cache-control"], "no-store");
    const html = response.body();
    assert.match(html, /<title>North &quot;Star&quot; &lt;script&gt; \| Wave Engine Music<\/title>/);
    assert.match(html, /content="Music &amp; &quot;light&quot; &lt;script&gt;"/);
    assert.doesNotMatch(html, /North "Star" <script>/);
    assert.match(html, /<meta name="twitter:card" content="summary"/);
    assert.match(html, /<link rel="canonical" href="https:\/\/staging\.example\.com\/artist\/north-star"/);
    const image = /<meta property="og:image" content="([^"]+)"/.exec(html)[1].replace(/&amp;/g, "&");
    assert.match(image, /^https:\/\/staging\.example\.com\/api\/artist-media\?slug=north-star&asset=avatar&v=/);
    assert.ok(html.includes(`<meta name="twitter:image" content="${image.replace(/&/g, "&amp;")}"`));
    assert.doesNotMatch(html, /attacker\.example/);
    const head = await request(handler, "HEAD", `/api/artist-profile?page=1&slug=${slug}`);
    assert.equal(head.statusCode, 200);
    assert.equal(head.body(), "");
    assert.equal(Number(head.headers["content-length"]), Buffer.byteLength(html));

    const media = mediaHandler({
      database: () => db,
      bucket: () => ({ file: (filePath) => ({
        getMetadata: async () => {
          assert.equal(filePath, avatarPath);
          return [{ contentType: "image/png", size: 5 }];
        },
        createReadStream: () => Readable.from([Buffer.from("image")])
      }) })
    });
    const imageUrl = new URL(image);
    const imageResponse = await request(media, "GET", `${imageUrl.pathname}${imageUrl.search}`);
    assert.equal(imageResponse.statusCode, 200);
    assert.equal(imageResponse.headers["content-type"], "image/png");
    assert.equal(imageResponse.body(), "image");

    profile.avatarPath = `artistUploads/${uid}/profile-87654321-1234-1234-1234-123456789012/avatar.png`;
    const updatedAvatar = await request(handler, "GET", `/api/artist-profile?page=1&slug=${slug}`);
    const updatedImage = /<meta property="og:image" content="([^"]+)"/.exec(updatedAvatar.body())[1].replace(/&amp;/g, "&");
    assert.notEqual(updatedImage, image);
    profile.avatarPath = "";
    const noAvatar = await request(handler, "GET", `/api/artist-profile?page=1&slug=${slug}`);
    assert.match(noAvatar.body(), /og:image" content="https:\/\/staging\.example\.com\/Images\/wave-engine-social-card-4k-v1\.png"/);
    profile.status = "pending";
    const privatePage = await request(handler, "GET", `/api/artist-profile?page=1&slug=${slug}&me=1`);
    assert.equal(privatePage.statusCode, 404);
    assert.match(privatePage.body(), /name="robots" content="noindex"/);
    assert.doesNotMatch(privatePage.body(), /North|light/);
    assert.equal((await request(handler, "GET", "/api/artist-profile?page=1&slug=bad%21")).statusCode, 404);
  } finally {
    if (previousSite === undefined) delete process.env.MUSIC_SITE_URL;
    else process.env.MUSIC_SITE_URL = previousSite;
  }
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

test("album validation enforces 20 unique tracks, shared ownership and pricing mode", () => {
  const uid = "artist-1";
  const id = "release-1";
  const track = (n) => ({
    id: `${String(n).padStart(8, "0")}-1234-1234-1234-123456789012`,
    title: `Song ${n}`,
    audioPath: `artistUploads/${uid}/${id}-${String(n).padStart(8, "0")}-1234-1234-1234-123456789012/audio.mp3`,
    downloadPriceCents: 150
  });
  const album = {
    title: "Album", description: "", genre: "", releaseType: "album", moods: [],
    audioPath: "", coverPath: "", saleMode: "tracks", downloadPriceCents: null,
    tracks: Array.from({ length: 20 }, (_, i) => track(i + 1))
  };
  assert.equal(marketplace.validateReleaseInput(uid, id, album).tracks.length, 20);
  assert.throws(() => marketplace.validateReleaseInput(uid, id, { ...album, tracks: [...album.tracks, track(21)] }), /20 tracks/);
  assert.throws(() => marketplace.validateReleaseInput(uid, id, { ...album, tracks: [track(1), track(1)] }), /unique/);
  assert.throws(() => marketplace.validateReleaseInput(uid, id, {
    ...album, tracks: [{ ...track(1), audioPath: track(1).audioPath.replace(uid, "other") }]
  }), /uploaded audio/);
  assert.throws(() => marketplace.validateReleaseInput(uid, id, {
    ...album, tracks: [{ ...track(1), downloadPriceCents: null }]
  }), /price for every/);
  assert.throws(() => marketplace.validateReleaseInput(uid, id, {
    ...album, saleMode: "album", tracks: [], downloadPriceCents: null
  }), /price for the album/);
  const both = { ...album, saleMode: "both", downloadPriceCents: 500 };
  assert.equal(marketplace.validateReleaseInput(uid, id, both).tracks.length, 20);
  assert.throws(() => marketplace.validateReleaseInput(uid, id, { ...both, downloadPriceCents: null }), /price for the album/);
  assert.throws(() => marketplace.validateReleaseInput(uid, id, {
    ...both, tracks: [{ ...track(1), downloadPriceCents: null }]
  }), /price for every/);
});

test("album drafts verify every uploaded song and retain all 20 in order", async () => {
  const db = new FakeDatabase();
  db.records.set("artists", new Map([["artist-1", { status: "pending" }]]));
  const checked = [];
  let badPath = "";
  const bucket = () => ({ file: (filePath) => ({
    getMetadata: async () => {
      checked.push(filePath);
      return [{ contentType: filePath === badPath ? "text/plain" : "audio/mpeg", size: 5, generation: "101" }];
    }
  }) });
  const handler = releaseHandler({ database: () => db, authenticate: fakeAuth(), bucket });
  const fields = {
    title: "Album", description: "", genre: "", releaseType: "album", moods: [],
    audioPath: "", coverPath: "", saleMode: "none", downloadPriceCents: null, tracks: []
  };
  const created = await request(handler, "POST", "/api/artist-releases", { action: "create", ...fields });
  assert.equal(created.statusCode, 201);
  const id = JSON.parse(created.body()).release.id;
  const tracks = Array.from({ length: 20 }, (_, i) => {
    const uuid = `${String(i + 1).padStart(8, "0")}-1234-1234-1234-123456789012`;
    return { id: uuid, title: `Song ${i + 1}`, audioPath: `artistUploads/artist-1/${id}-${uuid}/audio.mp3`, downloadPriceCents: null };
  });
  badPath = tracks[19].audioPath;
  const invalid = await request(handler, "POST", "/api/artist-releases", { action: "update", id, ...fields, tracks });
  assert.equal(invalid.statusCode, 400);
  assert.equal(db.records.get("artistReleases").get(id).tracks.length, 0);
  checked.length = 0;
  badPath = "";
  const updated = await request(handler, "POST", "/api/artist-releases", { action: "update", id, ...fields, tracks });
  assert.equal(updated.statusCode, 200);
  assert.equal(checked.length, 20);
  assert.deepEqual(db.records.get("artistReleases").get(id).tracks.map((entry) => entry.title), tracks.map((entry) => entry.title));
});

test("album submission reviews and pins every song and publishes one shared cover", async () => {
  const db = new FakeDatabase();
  const uid = "artist-1";
  const id = "release-1";
  const track = (n) => ({
    id: `${String(n).padStart(8, "0")}-1234-1234-1234-123456789012`, title: `Song ${n}`,
    audioPath: `artistUploads/${uid}/${id}-${String(n).padStart(8, "0")}-1234-1234-1234-123456789012/audio.mp3`,
    downloadPriceCents: 100 + n
  });
  const tracks = [track(1), track(2)];
  const coverPath = `artistUploads/${uid}/${id}-00000003-1234-1234-1234-123456789012/cover.png`;
  db.records.set("artists", new Map([[uid, { status: "approved", artistName: "Artist", slug: "north-star" }]]));
  db.records.set("artistSlugs", new Map([["north-star", { status: "approved", artistUid: uid }]]));
  db.records.set("artistReleases", new Map([[id, {
    artistUid: uid, status: "draft", title: "Album", description: "", genre: "Rock",
    releaseType: "album", saleMode: "both", moods: [], tracks, coverPath: "", audioPath: "", downloadPriceCents: 500
  }]]));
  const bucket = () => ({ file: (path, options = {}) => ({
    getMetadata: async () => {
      if (path === coverPath) return [{ contentType: "image/png", size: 5 }];
      const index = tracks.findIndex((entry) => entry.audioPath === path);
      if (index < 0 || (options.generation && options.generation !== String(index + 101))) {
        const error = new Error("Missing file"); error.code = 404; throw error;
      }
      return [{ contentType: "audio/mpeg", size: 5, generation: String(index + 101) }];
    },
    createReadStream: ({ start, end }) => Readable.from([Buffer.from(path === tracks[0].audioPath ? "first" : "other").subarray(start, end + 1)])
  }) });
  const artist = releaseHandler({ database: () => db, authenticate: fakeAuth(), bucket });
  const admin = adminHandler({ database: () => db, authenticate: fakeAuth({ uid: "admin", admin: true }), bucket });
  const review = releaseHandler({ database: () => db, authenticate: fakeAuth({ uid: "admin", admin: true }), bucket });
  const submit = (extra = {}) => request(artist, "POST", "/api/artist-releases", { action: "submit", id, rightsConfirmed: true, ...extra });
  db.records.get("artistReleases").get(id).tracks = [];
  assert.match((await submit({ salesRightsConfirmed: true })).body(), /upload audio/i);
  db.records.get("artistReleases").get(id).tracks = tracks;
  assert.equal((await submit()).statusCode, 400);
  assert.match((await submit({ salesRightsConfirmed: true })).body(), /cover/i);
  db.records.get("artistReleases").get(id).coverPath = coverPath;
  assert.equal((await submit({ salesRightsConfirmed: true })).statusCode, 200);
  assert.deepEqual(db.records.get("artistReleases").get(id).trackGenerations, { [tracks[0].id]: "101", [tracks[1].id]: "102" });
  const listed = JSON.parse((await request(admin, "GET", "/api/artist-admin?type=releases")).body()).releases[0];
  assert.deepEqual(listed.tracks.map((entry) => entry.title), ["Song 1", "Song 2"]);
  assert.equal(listed.hasCover, true);
  assert.equal("coverPath" in listed, false);
  assert.equal((await request(review, "GET", `/api/artist-releases?action=review&id=${id}&track=${tracks[1].id}`)).body(), "other");
  assert.equal((await request(artist, "GET", `/api/artist-releases?action=review&id=${id}&track=${tracks[1].id}`)).statusCode, 403);
  db.records.get("artistReleases").get(id).trackGenerations[tracks[1].id] = "";
  assert.equal((await request(admin, "POST", "/api/artist-admin", { action: "approve-release", id })).statusCode, 409);
  db.records.get("artistReleases").get(id).trackGenerations[tracks[1].id] = "102";
  assert.equal((await request(admin, "POST", "/api/artist-admin", { action: "approve-release", id })).statusCode, 200);
  const album = JSON.parse((await request(artist, "GET", "/api/artist-releases?action=public")).body()).artists[0].albums[0];
  assert.equal(album.tracks.length, 2);
  const count = streamCountHandler("artist", { getDatabase: () => db });
  const countTrack = (trackId) => request(count, "POST", "/api/artist-releases?action=count-stream", { id, trackId });
  assert.equal(JSON.parse((await countTrack(tracks[0].id)).body()).count, 1);
  assert.equal(JSON.parse((await countTrack(tracks[0].id)).body()).count, 2);
  assert.equal(JSON.parse((await countTrack(tracks[1].id)).body()).count, 1);
  assert.equal((await countTrack("00000003-1234-1234-1234-123456789012")).statusCode, 404);
  const countedAlbum = JSON.parse((await request(artist, "GET", "/api/artist-releases?action=public")).body()).artists[0].albums[0];
  assert.deepEqual(countedAlbum.tracks.map((entry) => entry.streamCount), [2, 1]);
  assert.match(album.coverUrl, /asset=cover/);
  assert.doesNotMatch(JSON.stringify(album), /artistUploads|Generation/);
  const oldSales = process.env.ARTIST_SALES_ENABLED;
  const oldMode = process.env.MUSIC_STRIPE_MODE;
  try {
    process.env.ARTIST_SALES_ENABLED = "true";
    process.env.MUSIC_STRIPE_MODE = "live";
    db.records.get("artists").get(uid).stripeConnectLive = "acct_123";
    const priced = JSON.parse((await request(artist, "GET", "/api/artist-releases?action=public")).body()).artists[0].albums[0];
    assert.equal(priced.downloadPriceCents, 500);
    assert.deepEqual(priced.tracks.map((entry) => entry.downloadPriceCents), [101, 102]);
    process.env.ARTIST_SALES_ENABLED = "false";
    const disabled = JSON.parse((await request(artist, "GET", "/api/artist-releases?action=public")).body()).artists[0].albums[0];
    assert.equal(disabled.downloadPriceCents, null);
    assert.deepEqual(disabled.tracks.map((entry) => entry.downloadPriceCents), [null, null]);
  } finally {
    if (oldSales === undefined) delete process.env.ARTIST_SALES_ENABLED;
    else process.env.ARTIST_SALES_ENABLED = oldSales;
    if (oldMode === undefined) delete process.env.MUSIC_STRIPE_MODE;
    else process.env.MUSIC_STRIPE_MODE = oldMode;
  }
  assert.equal((await request(artist, "GET", `/api/artist-releases?action=stream&id=${id}&track=${tracks[0].id}`)).body(), "first");
  assert.equal((await request(artist, "GET", `/api/artist-releases?action=stream&id=${id}`)).statusCode, 404);
  assert.equal((await request(artist, "POST", "/api/artist-releases", { action: "withdraw", id })).statusCode, 200);
  assert.equal((await request(artist, "GET", `/api/artist-releases?action=stream&id=${id}&track=${tracks[0].id}`)).statusCode, 404);
  assert.equal((await countTrack(tracks[0].id)).statusCode, 404);
  assert.deepEqual(JSON.parse((await request(artist, "GET", "/api/artist-releases?action=public")).body()).artists[0].albums, []);
});

test("stream counts require a published playable song and reject invalid requests", async () => {
  const db = new FakeDatabase();
  const handler = streamCountHandler("music", { getDatabase: () => db });
  const song = { published: true, mp3StoragePath: "musicTracks/song-1/file/mp3.mp3" };
  db.records.set("musicTracks", new Map([["song-1", song]]));
  const post = (body) => request(handler, "POST", "/api/music?action=count-stream", body);
  for (const body of [null, [], {}, { id: "../song-1" }, { id: "song-1", trackId: "bad" }]) {
    assert.equal((await post(body)).statusCode, 400);
  }
  assert.equal((await request(handler, "GET", "/api/music?action=count-stream")).statusCode, 405);
  assert.equal(JSON.parse((await post({ id: "song-1" })).body()).count, 1);
  assert.equal(JSON.parse((await post({ id: "song-1" })).body()).count, 2);
  const library = musicLibraryHandler({ ...musicLibrary, database: () => db });
  assert.equal(JSON.parse((await request(library, "GET", "/api/music?action=library")).body()).tracks[0].streamCount, 2);
  const transaction = db.runTransaction.bind(db);
  let pending = Promise.resolve();
  db.runTransaction = (work) => {
    const operation = pending.then(() => transaction(work));
    pending = operation.catch(() => {});
    return operation;
  };
  const results = await Promise.all(Array.from({ length: 5 }, () => post({ id: "song-1" })));
  assert.deepEqual(results.map((response) => JSON.parse(response.body()).count), [3, 4, 5, 6, 7]);
  song.published = false;
  assert.equal((await post({ id: "song-1" })).statusCode, 404);
  assert.deepEqual(JSON.parse((await request(library, "GET", "/api/music?action=library")).body()).tracks, []);
  song.published = true;
  song.mp3StoragePath = "other/song.mp3";
  assert.equal((await post({ id: "song-1" })).statusCode, 404);
  assert.equal(db.records.get("songStreamCounts").get("music_song-1").counts.single, 7);
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
  assert.deepEqual(northStar.tracks, [{ id, title: "First Light", genre: "Rock", downloadPriceCents: null, streamCount: 0, coverUrl: "", format: "MP3" }]);
  assert.doesNotMatch(JSON.stringify(publicAfter), /artistUploads|artistUid|audioGeneration/);
  const count = streamCountHandler("artist", { getDatabase: () => db });
  const countSingle = () => request(count, "POST", "/api/artist-releases?action=count-stream", { id });
  assert.equal(JSON.parse((await countSingle()).body()).count, 1);
  assert.equal(JSON.parse((await visitor("/api/artist-releases?action=public")).body()).artists[0].tracks[0].streamCount, 1);
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
  assert.equal((await countSingle()).statusCode, 404);
  assert.deepEqual(JSON.parse((await visitor("/api/artist-releases?action=public")).body()).artists[0].tracks, []);
  assert.equal((await visitor(`/api/artist-releases?action=stream&id=${id}`)).statusCode, 404);
  db.records.get("artistReleases").get(id).rightsConfirmed = true;
  db.records.get("artistSlugs").get("north-star").status = "rejected";
  assert.equal((await countSingle()).statusCode, 404);
  assert.deepEqual(JSON.parse((await visitor("/api/artist-releases?action=public")).body()).artists, []);
  assert.equal((await visitor(`/api/artist-releases?action=stream&id=${id}`)).statusCode, 404);
  db.records.get("artistSlugs").get("north-star").status = "approved";
  db.records.get("artists").get(uid).status = "suspended";
  assert.equal((await countSingle()).statusCode, 404);
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

test("artist storefront and previews omit song prices while retaining purchase options", async () => {
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
    focus() { if (this.events.focus) this.events.focus(); }
    querySelectorAll(tag) {
      return this.children.flatMap((child) =>
        [...(child.tagName === tag.toUpperCase() ? [child] : []), ...child.querySelectorAll(tag)]);
    }
    pause() { this.paused = true; }
  }
  const source = fs.readFileSync(path.join(__dirname, "..", "artist-listen.js"), "utf8")
    .replace(/^import .*?;\r?\n/m, "");
  const checkouts = [];
  const counters = [];
  async function loadPage(profile) {
    const status = new Element("p");
    const list = new Element("div");
    const selection = new Element("div");
    selection.hidden = true;
    const elements = {
      "#artist-discovery-status": status,
      "#artist-discovery-list": list,
      "#artist-discovery-selection": selection,
      "#storefront-profile": profile ? new Element("main") : null
    };
    const document = {
      querySelector: (selector) => elements[selector] || null,
      createElement: (tag) => new Element(tag),
      addEventListener() {}
    };
    await vm.runInNewContext(`(async () => {\n${source}\n})()`, {
      document, location: { protocol: "https:", hostname: "example.com", pathname: "/artist/north-star" },
      fetch: async (url, options) => {
        if (url.includes("action=checkout")) {
          checkouts.push(JSON.parse(options.body));
          return { ok: false, json: async () => ({ error: "Checkout unavailable" }) };
        }
        return { ok: true, json: async () => ({ artists: [
          { artistName: "North Star", slug: "north-star", tracks: [
            { id: "track-1", title: "First Light", downloadPriceCents: 149, format: "WAV", streamCount: 4 }
          ], albums: [{ id: "album-1", title: "Album", downloadPriceCents: 500, tracks: [
            { id: "album-1", trackId: "song-1", title: "Song", downloadPriceCents: 125, format: "MP3", streamCount: 7 }
          ] }] },
          { artistName: "South Star", slug: "south-star", tracks: [] }
        ] }) };
      },
      URL, URLSearchParams,
      attachStreamCounter(audio, container, count, url, body) { counters.push({ count, url, body }); }
    });
    return { status, list, selection };
  }
  function checkPrices(container) {
    const buttons = container.querySelectorAll("button").filter((button) => button.className.includes("artist-download"));
    assert.deepEqual(buttons.map((button) => button.textContent), ["Download WAV", "Download album", "Download MP3"]);
    assert.deepEqual(container.querySelectorAll("p")
      .filter((paragraph) => paragraph.className === "artist-download-notice")
      .map((paragraph) => paragraph.textContent), ["Album download price: $5.00"]);
    return buttons;
  }
  const storefront = await loadPage(true);
  assert.equal(counters[0].count, 4);
  assert.equal(counters[0].body.id, "track-1");
  assert.equal(counters[1].count, 7);
  assert.equal(counters[1].body.trackId, "song-1");
  assert.match(counters[1].url, /action=count-stream/);
  const storefrontButtons = checkPrices(storefront.list);
  await storefrontButtons[0].events.click();

  const { list, selection } = await loadPage(false);
  const first = list.children[0].children[0];
  const second = list.children[1].children[0];
  first.events.pointerenter({ pointerType: "mouse" });
  assert.equal(selection.hidden, false);
  assert.equal(first.attributes["aria-expanded"], "true");
  assert.equal(selection.children[1].href, "/artist/north-star");
  const audio = selection.querySelectorAll("audio")[0];
  assert.match(audio.src, /action=stream&id=track-1/);
  const buttons = checkPrices(selection);
  await buttons[1].events.click();
  await buttons[2].events.click();
  assert.deepEqual(checkouts, [{ id: "track-1" }, { id: "album-1" }, { id: "album-1", trackId: "song-1" }]);
  const close = selection.children[0].children[1];
  assert.equal(close.attributes["aria-label"], "Close North Star preview");
  close.events.click();
  assert.equal(audio.paused, true);
  assert.equal(selection.hidden, true);
  assert.equal(selection.children.length, 0);
  assert.equal(first.attributes["aria-expanded"], "false");
  first.events.pointerenter({ pointerType: "touch" });
  assert.equal(selection.hidden, true);
  first.events.click();
  assert.equal(selection.hidden, false);
  assert.equal(first.attributes["aria-expanded"], "true");
  const reopenedAudio = selection.querySelectorAll("audio")[0];
  second.events.focus();
  assert.equal(reopenedAudio.paused, true);
  assert.equal(first.attributes["aria-expanded"], "false");
  assert.equal(second.attributes["aria-expanded"], "true");
  assert.equal(selection.children[2].textContent, "No tracks available yet.");
  let prevented = false;
  selection.events.keydown({ key: "Escape", preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(selection.hidden, true);
  assert.equal(second.attributes["aria-expanded"], "false");
  first.events.pointerenter({ pointerType: "mouse" });
  assert.equal(selection.hidden, false);
  assert.equal(first.attributes["aria-expanded"], "true");
  first.events.keydown({ key: "Escape", preventDefault() {} });
  assert.equal(selection.hidden, true);
  assert.equal(first.attributes["aria-expanded"], "false");
  first.events.focus();
  assert.equal(selection.hidden, false);
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

test("contributions charge the approved artist's Stripe account with a 5% fee", async () => {
  const db = new FakeDatabase();
  const artist = { status: "approved", slug: "north-star", artistName: "North Star", stripeConnectTest: "acct_artist" };
  const slugRecord = { status: "approved", artistUid: "artist-1" };
  db.records.set("artists", new Map([["artist-1", artist]]));
  db.records.set("artistSlugs", new Map([["north-star", slugRecord]]));
  let enabled = false;
  let account = { charges_enabled: true, payouts_enabled: true, controller: { fees: { payer: "account" } } };
  let checkout;
  let session;
  let creations = 0;
  let accountReads = 0;
  const stripe = {
    accounts: { retrieve: async (id) => { accountReads++; assert.equal(id, "acct_artist"); return account; } },
    checkout: { sessions: {
      create: async (data, options) => {
        creations++;
        checkout = { data, options };
        const amount = data.line_items[0].price_data.unit_amount;
        session = {
          id: "cs_test_123", url: "https://checkout.stripe.com/test", livemode: false,
          mode: "payment", status: "complete", payment_status: "paid", currency: "usd",
          amount_total: amount, amount_subtotal: amount, metadata: data.metadata,
          payment_intent: { status: "succeeded", application_fee_amount: data.payment_intent_data.application_fee_amount,
            latest_charge: { status: "succeeded", refunded: false, amount_refunded: 0, disputed: false } }
        };
        return session;
      },
      retrieve: async (id, _options, context) => {
        assert.equal(id, "cs_test_123");
        assert.equal(context.stripeAccount, "acct_artist");
        return session;
      }
    } }
  };
  const handler = paymentsHandler({
    database: () => db, authenticate: fakeAuth(), enabled: () => false, contributions: () => enabled,
    payment: { mode: () => "test", stripeClient: () => stripe, siteUrl: () => new URL("https://example.com/") }
  });
  const contribute = (amountCents, slug = "north-star") => request(handler, "POST",
    "/api/artist-releases?action=contribute", { amountCents, slug }, "");
  const status = (slug = "north-star", sessionId = "cs_test_123") => request(handler, "GET",
    `/api/artist-releases?action=contribution-status&slug=${slug}&session_id=${sessionId}`, undefined, "");

  assert.equal((await contribute(1000)).statusCode, 503);
  assert.equal(creations, 0);
  enabled = true;
  const connect = await request(handler, "GET", "/api/artist-releases?action=connect");
  assert.deepEqual(JSON.parse(connect.body()), { connected: true, ready: true });
  for (const invalid of [0, 49, 50.1, "100", 100000000, null]) {
    assert.equal((await contribute(invalid)).statusCode, 400);
  }
  assert.equal((await request(handler, "POST", "/api/artist-releases?action=contribute&slug=north-star", null)).statusCode, 400);
  assert.equal(creations, 0);
  const readsBeforeInvalidArtist = accountReads;
  assert.equal((await contribute(500, "missing")).statusCode, 404);
  slugRecord.status = "pending";
  assert.equal((await contribute(500)).statusCode, 404);
  slugRecord.status = "approved";
  artist.status = "suspended";
  assert.equal((await contribute(500)).statusCode, 404);
  artist.status = "approved";
  artist.slug = "other-artist";
  assert.equal((await contribute(500)).statusCode, 404);
  artist.slug = "north-star";
  assert.equal(accountReads, readsBeforeInvalidArtist);
  account.controller.fees.payer = "application";
  assert.equal((await contribute(500)).statusCode, 409);
  account.controller.fees.payer = "account";
  account.payouts_enabled = false;
  assert.equal((await contribute(500)).statusCode, 409);
  account.payouts_enabled = true;
  delete artist.stripeConnectTest;
  assert.equal((await contribute(500)).statusCode, 409);
  artist.stripeConnectTest = "acct_artist";
  assert.equal(creations, 0);

  for (const [amount, fee] of [[50, 3], [51, 3], [1010, 51], [1000000, 50000], [99999999, 5000000]]) {
    const response = await contribute(amount);
    assert.equal(response.statusCode, 200);
    assert.equal(JSON.parse(response.body()).url, "https://checkout.stripe.com/test");
    assert.equal(response.headers["cache-control"], "private, no-store");
    assert.equal(checkout.options.stripeAccount, "acct_artist");
    assert.equal(checkout.data.line_items[0].price_data.unit_amount, amount);
    assert.equal(checkout.data.line_items[0].price_data.currency, "usd");
    assert.equal(checkout.data.payment_intent_data.application_fee_amount, fee);
    assert.equal(checkout.data.payment_intent_data.metadata.type, "artist-contribution-v1");
    assert.equal(checkout.data.metadata.type, "artist-contribution-v1");
    assert.equal(checkout.data.metadata.artistUid, "artist-1");
    assert.equal(checkout.data.success_url, "https://example.com/artist/north-star?contribution=success&session_id={CHECKOUT_SESSION_ID}");
    assert.equal(checkout.data.cancel_url, "https://example.com/artist/north-star?contribution=cancelled");
  }
  assert.deepEqual(JSON.parse((await status()).body()), { confirmed: true });
  enabled = false;
  assert.equal((await status()).statusCode, 200);
  assert.equal((await status("north-star", "cs_live_123")).statusCode, 403);
  session.payment_status = "unpaid";
  assert.equal((await status()).statusCode, 403);
  session.payment_status = "paid";
  session.livemode = true;
  assert.equal((await status()).statusCode, 403);
  session.livemode = false;
  session.metadata.artistUid = "artist-2";
  assert.equal((await status()).statusCode, 403);
  session.metadata.artistUid = "artist-1";
  session.payment_intent.application_fee_amount--;
  assert.equal((await status()).statusCode, 403);
  session.payment_intent.application_fee_amount++;
  session.payment_intent.latest_charge.refunded = true;
  assert.equal((await status()).statusCode, 403);
});

test("album and song checkout charge configured prices and deliver only purchased audio", async () => {
  const db = new FakeDatabase();
  const uid = "artist-1";
  const id = "release-1";
  const tracks = [1, 2].map((n) => ({
    id: `${String(n).padStart(8, "0")}-1234-1234-1234-123456789012`, title: `Song ${n}`,
    audioPath: `artistUploads/${uid}/${id}-${String(n).padStart(8, "0")}-1234-1234-1234-123456789012/audio.mp3`,
    downloadPriceCents: null
  }));
  const release = {
    artistUid: uid, status: "published", rightsConfirmed: true, salesRightsConfirmed: true,
    title: "Album", description: "", genre: "", moods: [], releaseType: "album",
    saleMode: "album", downloadPriceCents: 500, tracks, audioPath: "",
    coverPath: `artistUploads/${uid}/${id}-00000003-1234-1234-1234-123456789012/cover.png`,
    trackGenerations: { [tracks[0].id]: "101", [tracks[1].id]: "102" }
  };
  db.records.set("artists", new Map([[uid, { status: "approved", slug: "artist", stripeConnectLive: "acct_123" }]]));
  db.records.set("artistSlugs", new Map([["artist", { status: "approved", artistUid: uid }]]));
  db.records.set("artistReleases", new Map([[id, release]]));
  const sessions = new Map();
  const stripe = {
    accounts: { retrieve: async () => ({ charges_enabled: true, payouts_enabled: true, controller: { fees: { payer: "account" } } }) },
    checkout: { sessions: {
      create: async (data) => {
        const amount = data.line_items[0].price_data.unit_amount;
        const session = {
          id: `cs_live_${sessions.size + 1}`, url: "https://checkout.stripe.com/test", livemode: true,
          mode: "payment", status: "complete", payment_status: "paid", currency: "usd",
          amount_subtotal: amount, amount_total: amount, metadata: data.metadata,
          line_items: { data: [{ quantity: 1, price: { currency: "usd", unit_amount: amount } }] },
          payment_intent: { status: "succeeded", application_fee_amount: Math.round(amount / 10),
            latest_charge: { status: "succeeded", refunded: false, amount_refunded: 0,
              disputed: false, created: Math.floor(Date.now() / 1000) } }
        };
        sessions.set(session.id, session);
        return session;
      },
      retrieve: async (sessionId) => sessions.get(sessionId)
    } }
  };
  const bucket = () => ({ file: (filePath) => ({
    getMetadata: async () => [{ size: 5, contentType: "audio/mpeg" }],
    createReadStream: ({ start, end }) => Readable.from([Buffer.from(filePath === tracks[0].audioPath ? "first" : "other").subarray(start, end + 1)])
  }) });
  const handler = paymentsHandler({
    database: () => db, authenticate: fakeAuth(), bucket, enabled: () => true,
    payment: { mode: () => "live", stripeClient: () => stripe, siteUrl: () => new URL("https://example.com/") }
  });
  const buy = (body) => request(handler, "POST", "/api/artist-releases?action=checkout", { id, ...body });
  assert.equal((await buy({ trackId: tracks[0].id })).statusCode, 404);
  assert.equal((await buy({ amount: 1 })).statusCode, 200);
  const first = sessions.get("cs_live_1");
  assert.equal(first.amount_total, 500);
  const albumUrl = `/api/artist-releases?action=purchase&purchase_id=${first.metadata.purchaseId}&session_id=cs_live_1`;
  const albumPurchase = JSON.parse((await request(handler, "GET", albumUrl)).body());
  assert.deepEqual(albumPurchase.tracks.map((entry) => entry.title), ["Song 1", "Song 2"]);
  const downloadUrl = albumUrl.replace("action=purchase", "action=download");
  assert.equal((await request(handler, "GET", `${downloadUrl}&track=${tracks[1].id}`)).body(), "other");
  assert.equal((await request(handler, "GET", `${downloadUrl}&track=unowned`)).statusCode, 403);
  release.trackGenerations[tracks[1].id] = "999";
  assert.equal((await request(handler, "GET", albumUrl)).statusCode, 404);
  release.trackGenerations[tracks[1].id] = "102";

  release.saleMode = "tracks";
  release.downloadPriceCents = null;
  tracks[0].downloadPriceCents = 125;
  tracks[1].downloadPriceCents = 175;
  assert.equal((await buy({})).statusCode, 404);
  assert.equal((await buy({ trackId: tracks[1].id, amount: 1 })).statusCode, 200);
  const second = sessions.get("cs_live_2");
  assert.equal(second.amount_total, 175);
  const songUrl = `/api/artist-releases?action=download&purchase_id=${second.metadata.purchaseId}&session_id=cs_live_2`;
  assert.equal((await request(handler, "GET", `${songUrl}&track=${tracks[1].id}`)).body(), "other");
  assert.equal((await request(handler, "GET", `${songUrl}&track=${tracks[0].id}`)).statusCode, 403);
  release.saleMode = "both";
  release.downloadPriceCents = 500;
  assert.equal((await buy({})).statusCode, 200);
  const bothAlbum = sessions.get("cs_live_3");
  assert.equal(bothAlbum.amount_total, 500);
  const bothAlbumUrl = `/api/artist-releases?action=purchase&purchase_id=${bothAlbum.metadata.purchaseId}&session_id=cs_live_3`;
  assert.equal(JSON.parse((await request(handler, "GET", bothAlbumUrl)).body()).tracks.length, 2);
  assert.equal((await buy({ trackId: tracks[0].id, amount: 1 })).statusCode, 200);
  const bothSong = sessions.get("cs_live_4");
  assert.equal(bothSong.amount_total, 125);
  const bothSongUrl = `/api/artist-releases?action=download&purchase_id=${bothSong.metadata.purchaseId}&session_id=cs_live_4`;
  assert.equal((await request(handler, "GET", `${bothSongUrl}&track=${tracks[0].id}`)).body(), "first");
  assert.equal((await request(handler, "GET", `${bothSongUrl}&track=${tracks[1].id}`)).statusCode, 403);
  release.tracks = [tracks[0]];
  assert.equal((await request(handler, "GET", bothAlbumUrl)).statusCode, 404);
  release.tracks = tracks;
  release.status = "draft";
  assert.equal((await request(handler, "GET", `${songUrl}&track=${tracks[1].id}`)).statusCode, 404);
});

test("album purchase page offers a separate verified download link for every song", async () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "music-purchase.js"), "utf8")
    .replace("loadPurchase();", "await loadPurchase();");
  const status = {};
  const links = [];
  const document = {
    querySelector: (selector) => selector === "#purchase-status" ? status : { append: (link) => links.push(link) },
    createElement: () => ({})
  };
  await vm.runInNewContext(`(async () => {\n${source}\n})()`, {
    document, location: { protocol: "https:", hostname: "example.com", search: "?artist_purchase=abc&session_id=cs_live_123" },
    fetch: async () => ({ ok: true, json: async () => ({ title: "Album", tracks: [
      { id: "one", title: "First", format: "mp3" }, { id: "two", title: "Second", format: "wav" }
    ] }) }),
    URLSearchParams
  });
  assert.equal(links.length, 2);
  assert.equal(links[0].textContent, "Download First (MP3)");
  assert.equal(links[1].textContent, "Download Second (WAV)");
  assert.match(links[0].href, /action=download.*track=one/);
  assert.match(links[1].href, /action=download.*track=two/);
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

test("profile customization saves validated image sets and protects unpublished images", async () => {
  const uid = "artist-1";
  const imagePath = (id, kind) => `artistUploads/${uid}/profile-${id}/${kind}.png`;
  const first = imagePath("12345678-1234-1234-1234-123456789012", "background");
  const second = imagePath("22345678-1234-1234-1234-123456789012", "background");
  const photo = imagePath("32345678-1234-1234-1234-123456789012", "gallery");
  const db = new FakeDatabase();
  db.records.set("artists", new Map([[uid, {
    status: "pending", slug: "north-star", artistName: "North Star", biography: "", socialLinks: {}
  }]]));
  db.records.set("artistSlugs", new Map([["north-star", { artistUid: uid, status: "pending" }]]));
  const bucket = () => ({ file: () => ({
    getMetadata: async () => [{ contentType: "image/png", size: 3 }],
    createReadStream: () => Readable.from([Buffer.from("img")])
  }) });
  const handler = profileHandler({ database: () => db, bucket, authenticate: fakeAuth() });
  const base = { action: "update", artistName: "North Star", biography: "", socialLinks: {} };
  const appearance = { accentColor: "#FFFFFF", backgroundColor: "#234567", featuredMessage: "Welcome!" };
  const saved = await request(handler, "POST", "/api/artist-profile", {
    ...base, appearance, backgroundPaths: [first, second], galleryPaths: [photo]
  });
  assert.equal(saved.statusCode, 200);
  const profile = JSON.parse(saved.body()).profile;
  assert.equal(profile.appearance.accentColor, "#ffffff");
  assert.equal(profile.backgroundImages.length, 2);
  assert.equal(profile.galleryImages.length, 1);
  assert.doesNotMatch(JSON.stringify(profile), /artistUploads/);
  const media = mediaHandler({ database: () => db, bucket, authenticate: fakeAuth() });
  const background = profile.backgroundImages[0].url;
  assert.equal((await request(media, "GET", background, undefined, "")).statusCode, 404);
  const owner = await request(media, "GET", `${background}&preview=owner`);
  assert.equal(owner.statusCode, 200);
  assert.equal(owner.headers["cache-control"], "private, no-store");
  const other = mediaHandler({ database: () => db, bucket, authenticate: fakeAuth({ uid: "other", email_verified: true }) });
  assert.equal((await request(other, "GET", `${background}&preview=owner`)).statusCode, 404);
  const review = mediaHandler({ database: () => db, bucket, authenticate: async (req, adminOnly) => {
    if (adminOnly && req.headers.authorization !== "Bearer admin") throw marketplace.statusError("Administrator access is required.", 403);
    return { uid, email_verified: true };
  } });
  assert.equal((await request(review, "GET", `${background}&preview=review`)).statusCode, 403);
  assert.equal((await request(review, "GET", `${background}&preview=review`, undefined, "Bearer admin")).statusCode, 200);

  db.records.get("artists").get(uid).status = "approved";
  db.records.get("artistSlugs").get("north-star").status = "approved";
  assert.equal((await request(media, "GET", background, undefined, "")).statusCode, 200);
  const legacyUpdate = await request(handler, "POST", "/api/artist-profile", base);
  assert.equal(JSON.parse(legacyUpdate.body()).profile.backgroundImages.length, 2);
  const replaced = await request(handler, "POST", "/api/artist-profile", {
    ...base, backgroundPaths: [second], galleryPaths: []
  });
  assert.deepEqual(JSON.parse(replaced.body()).cleanupPaths, [first, photo]);
  assert.equal((await request(media, "GET", background, undefined, "")).statusCode, 404);
  for (const invalid of [
    { appearance: { ...appearance, accentColor: "red" } },
    { appearance: { ...appearance, featuredMessage: "x".repeat(281) } },
    { backgroundPaths: [first, first] },
    { backgroundPaths: Array(6).fill(first) },
    { galleryPaths: [first] },
    { galleryPaths: [photo.replace(uid, "another-artist")] }
  ]) {
    assert.equal((await request(handler, "POST", "/api/artist-profile", { ...base, ...invalid })).statusCode, 400);
  }
  for (const size of [0, "invalid", 10 * 1024 * 1024 + 1]) {
    const invalidFile = profileHandler({
      database: () => db, authenticate: fakeAuth(),
      bucket: () => ({ file: () => ({ getMetadata: async () => [{ contentType: "image/png", size }] }) })
    });
    assert.equal((await request(invalidFile, "POST", "/api/artist-profile", { ...base, galleryPaths: [photo] })).statusCode, 400);
  }
});

test("gallery additions preserve saved photos and enforce the six-photo limit", async () => {
  const uid = "artist-1";
  const photo = (number) => `artistUploads/${uid}/profile-${number}2345678-1234-1234-1234-123456789012/gallery.png`;
  const db = new FakeDatabase();
  db.records.set("artists", new Map([[uid, {
    status: "approved", slug: "artist", artistName: "Artist", biography: "", socialLinks: {}, galleryPaths: [photo(1)]
  }]]));
  const handler = profileHandler({
    database: () => db, authenticate: fakeAuth(),
    bucket: () => ({ file: () => ({ getMetadata: async () => [{ contentType: "image/png", size: 3 }] }) })
  });
  const base = { action: "update", artistName: "Artist", biography: "", socialLinks: {} };
  const add = await request(handler, "POST", "/api/artist-profile", { ...base, addGalleryPaths: [photo(2), photo(3)] });
  assert.equal(add.statusCode, 200);
  assert.deepEqual(db.records.get("artists").get(uid).galleryPaths, [photo(1), photo(2), photo(3)]);
  assert.deepEqual(JSON.parse(add.body()).cleanupPaths, []);
  assert.equal(JSON.parse(add.body()).profile.galleryImages.length, 3);
  const six = await request(handler, "POST", "/api/artist-profile", { ...base, addGalleryPaths: [photo(4), photo(5), photo(6)] });
  assert.equal(six.statusCode, 200);
  assert.equal(db.records.get("artists").get(uid).galleryPaths.length, 6);
  for (const invalid of [
    { addGalleryPaths: [photo(7)] },
    { addGalleryPaths: [photo(1)] },
    { addGalleryPaths: [photo(7).replace(uid, "other")] },
    { galleryPaths: [], addGalleryPaths: [photo(7)] }
  ]) {
    assert.equal((await request(handler, "POST", "/api/artist-profile", { ...base, ...invalid })).statusCode, 400);
    assert.equal(db.records.get("artists").get(uid).galleryPaths.length, 6);
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
  let streams = 0;
  const handler = mediaHandler({
    database: () => db,
    bucket: () => ({
      file: () => ({
        getMetadata: async () => {
          storageReads++;
          return [{ contentType: "image/png", size: 3 }];
        },
        createReadStream: () => { streams++; return Readable.from([Buffer.from("img")]); }
      })
    })
  });
  const hidden = await request(handler, "GET", "/api/artist-media?slug=north-star&asset=avatar", undefined, "");
  assert.equal(hidden.statusCode, 404);
  assert.equal((await request(handler, "HEAD", "/api/artist-media?slug=north-star&asset=avatar", undefined, "")).statusCode, 404);
  assert.equal(storageReads, 0);

  db.records.get("artists").get("artist-1").status = "approved";
  db.records.get("artistSlugs").get("north-star").status = "approved";
  const publicImage = await request(handler, "GET", "/api/artist-media?slug=north-star&asset=avatar", undefined, "");
  assert.equal(publicImage.statusCode, 200);
  assert.equal(publicImage.headers["content-type"], "image/png");
  assert.equal(publicImage.body(), "img");
  assert.equal(storageReads, 1);
  const head = await request(handler, "HEAD", "/api/artist-media?slug=north-star&asset=avatar", undefined, "");
  assert.equal(head.statusCode, 200);
  for (const header of ["content-type", "content-length", "cache-control", "x-content-type-options"]) {
    assert.equal(head.headers[header], publicImage.headers[header]);
  }
  assert.equal(head.body(), "");
  assert.equal(streams, 1);
  assert.match(head.headers["access-control-allow-methods"], /HEAD/);
  const options = await request(handler, "OPTIONS", "/api/artist-media");
  assert.match(options.headers["access-control-allow-methods"], /HEAD/);
});

test("release covers are served only for published tracks of approved artists", async () => {
  const path = "artistUploads/artist-1/rel1-12345678-1234-1234-1234-123456789012/cover.png";
  const db = new FakeDatabase();
  db.records.set("artistSlugs", new Map([["north-star", { artistUid: "artist-1", status: "approved" }]]));
  db.records.set("artists", new Map([["artist-1", { slug: "north-star", status: "approved" }]]));
  db.records.set("artistReleases", new Map([["rel1", {
    artistUid: "artist-1", status: "submitted", rightsConfirmed: true, coverPath: path
  }]]));
  const handler = mediaHandler({
    database: () => db,
    bucket: () => ({
      file: () => ({
        getMetadata: async () => [{ contentType: "image/png", size: 3 }],
        createReadStream: () => Readable.from([Buffer.from("img")])
      })
    })
  });
  const url = "/api/artist-media?release=rel1&asset=cover";
  assert.equal((await request(handler, "GET", url, undefined, "")).statusCode, 404);
  db.records.get("artistReleases").get("rel1").status = "published";
  const published = await request(handler, "GET", url, undefined, "");
  assert.equal(published.statusCode, 200);
  assert.equal(published.body(), "img");
});

test("private release covers require the owner or a review administrator", async () => {
  const coverPath = "artistUploads/artist-1/rel1-12345678-1234-1234-1234-123456789012/cover.png";
  const db = new FakeDatabase();
  const release = { artistUid: "artist-1", status: "draft", coverPath, rightsConfirmed: true };
  db.records.set("artistReleases", new Map([["rel1", release]]));
  db.records.set("artists", new Map([["artist-1", { status: "pending", slug: "north-star" }]]));
  db.records.set("artistSlugs", new Map([["north-star", { artistUid: "artist-1", status: "pending" }]]));
  let storageReads = 0;
  const handler = mediaHandler({
    database: () => db,
    authenticate: async (req, adminOnly) => {
      if (!req.headers.authorization) throw marketplace.statusError("Sign in to continue.", 401);
      const users = {
        "Bearer owner": { uid: "artist-1", email_verified: true },
        "Bearer other": { uid: "artist-2", email_verified: true },
        "Bearer admin": { uid: "admin", admin: true }
      };
      const user = users[req.headers.authorization];
      if (!user) throw marketplace.statusError("Invalid session.", 401);
      if (adminOnly && !user.admin) throw marketplace.statusError("Administrator access is required.", 403);
      return user;
    },
    bucket: () => ({ file: () => ({
      getMetadata: async () => { storageReads++; return [{ contentType: "image/png", size: 3 }]; },
      createReadStream: () => Readable.from([Buffer.from("img")])
    }) })
  });
  const url = "/api/artist-media?release=rel1&asset=cover";
  const preview = (mode, authorization) => request(handler, "GET", `${url}&preview=${mode}`, undefined, authorization);
  assert.equal((await request(handler, "GET", url, undefined, "")).statusCode, 404);
  assert.equal((await request(handler, "HEAD", `${url}&preview=owner`, undefined, "Bearer other")).statusCode, 404);
  assert.equal((await request(handler, "HEAD", url, undefined, "")).statusCode, 404);
  assert.equal((await preview("owner", "")).statusCode, 401);
  assert.equal((await preview("owner", "Bearer other")).statusCode, 404);
  assert.equal((await preview("review", "Bearer owner")).statusCode, 403);
  assert.equal((await preview("review", "Bearer admin")).statusCode, 404);
  assert.equal(storageReads, 0);
  for (const status of ["draft", "submitted", "published"]) {
    release.status = status;
    const own = await preview("owner", "Bearer owner");
    assert.equal(own.statusCode, 200);
    assert.equal(own.body(), "img");
    assert.equal(own.headers["cache-control"], "private, no-store");
    assert.equal(own.headers["access-control-allow-origin"], "*");
    if (status !== "draft") {
      const admin = await preview("review", "Bearer admin");
      assert.equal(admin.statusCode, 200);
      assert.equal(admin.headers["cache-control"], "private, no-store");
    }
    assert.equal((await request(handler, "GET", url, undefined, "")).statusCode, 404);
  }
  const readsBeforeInvalid = storageReads;
  release.coverPath = coverPath.replace("artist-1", "artist-2");
  assert.equal((await preview("owner", "Bearer owner")).statusCode, 404);
  assert.equal((await preview("review", "Bearer admin")).statusCode, 404);
  release.coverPath = coverPath;
  db.records.get("artists").get("artist-1").status = "suspended";
  assert.equal((await preview("owner", "Bearer owner")).statusCode, 404);
  assert.equal((await request(handler, "GET", `${url}&preview=invalid`)).statusCode, 400);
  assert.equal(storageReads, readsBeforeInvalid);
  db.records.get("artists").get("artist-1").status = "approved";
  db.records.get("artistSlugs").get("north-star").status = "approved";
  const publicImage = await request(handler, "GET", url, undefined, "");
  assert.equal(publicImage.statusCode, 200);
  assert.equal(publicImage.headers["cache-control"], "public, max-age=300");
});

test("cover previews use authenticated requests, report failures and revoke stale images", async () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "artist-cover-preview.js"), "utf8")
    .replace("export function", "function");
  const created = [];
  const revoked = [];
  const requests = [];
  let fetchResponse;
  const user = { getIdToken: async () => "owner-token" };
  let currentUser = user;
  const context = {
    document: { createElement: () => ({
      hidden: false, textContent: "", listeners: {},
      setAttribute() {}, addEventListener(name, callback) { this.listeners[name] = callback; }
    }) },
    URL: {
      createObjectURL(blob) { const url = `blob:${created.length}`; created.push({ url, blob }); return url; },
      revokeObjectURL(url) { revoked.push(url); }
    },
    fetch: async (url, options) => { requests.push({ url, options }); return fetchResponse; }
  };
  vm.runInNewContext(`${source}\nglobalThis.create = createCoverPreviews;`, context);
  const previews = context.create("https://api.example.com", "owner", () => currentUser);
  const container = () => ({ children: [], append(...children) { this.children.push(...children); } });
  const first = container();
  fetchResponse = { ok: true, blob: async () => ({ type: "image/png", size: 3 }) };
  await previews.add(first, { id: "release-1", title: "Album" });
  assert.match(requests[0].url, /release=release-1&preview=owner/);
  assert.equal(requests[0].options.headers.Authorization, "Bearer owner-token");
  assert.equal(requests[0].options.cache, "no-store");
  assert.equal(first.children[0].src, "blob:0");
  assert.equal(first.children[0].alt, "Album cover artwork");
  assert.equal(first.children[0].hidden, false);
  first.children[0].listeners.error();
  assert.match(first.children[1].textContent, /could not be displayed/);
  previews.clear();
  assert.deepEqual(revoked, ["blob:0"]);

  fetchResponse = { ok: false, json: async () => ({ error: "Access denied." }) };
  const failed = container();
  await previews.add(failed, { id: "release-1", title: "Album" });
  assert.match(failed.children[1].textContent, /Access denied/);
  assert.equal(failed.children[0].hidden, true);

  let finishBlob;
  fetchResponse = { ok: true, blob: () => new Promise((resolve) => { finishBlob = resolve; }) };
  const stale = container();
  const pending = previews.add(stale, { id: "release-1", title: "Album" });
  await new Promise((resolve) => setImmediate(resolve));
  previews.clear();
  currentUser = null;
  finishBlob({ type: "image/png", size: 3 });
  await pending;
  assert.equal(created.length, 1);
  assert.equal(stale.children[0].hidden, true);

  const selected = container();
  previews.addLocal(selected, { type: "image/png", size: 3 }, "Selected");
  assert.equal(selected.children[0].src, "blob:1");
  previews.clear();
  assert.deepEqual(revoked, ["blob:0", "blob:1"]);
});

test("artist identifiers, URLs, and upload paths reject unsafe values", () => {
  const uuid = "12345678-1234-1234-1234-123456789012";
  assert.equal(marketplace.validateSlug("North-Star"), "north-star");
  assert.throws(() => marketplace.validateSlug("api"));
  assert.throws(() => marketplace.validateSocialLinks({ website: "javascript:alert(1)" }));
  assert.throws(() => marketplace.validateSocialLinks({ facebook: "http://facebook.com/artist" }));
  assert.throws(() => marketplace.validateSocialLinks({ facebook: "https://user:pass@facebook.com/artist" }));
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

test("storefront displays personalized colors, message, gallery, and controllable backgrounds", async () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "artist.js"), "utf8");
  const elements = new Map();
  function element(selector) {
    if (!elements.has(selector)) elements.set(selector, {
      hidden: true, textContent: "", children: [], events: {},
      append(...children) { this.children.push(...children); },
      addEventListener(name, callback) { this.events[name] = callback; },
      querySelector() { return element(`${selector} p`); }
    });
    return elements.get(selector);
  }
  const properties = {};
  const body = { style: { setProperty(name, value) { properties[name] = value; } },
    classList: { add(name) { this.name = name; } } };
  let interval;
  const mediaQuery = { matches: true, addEventListener(_name, callback) { this.change = callback; } };
  const images = (asset, ids) => ids.map((id) => ({ url: `/api/artist-media?slug=north-star&asset=${asset}&id=${id}` }));
  const profile = {
    artistName: "North Star", slug: "north-star", socialLinks: {},
    appearance: { accentColor: "#ffffff", backgroundColor: "#112233", featuredMessage: "<Welcome>" },
    backgroundImages: images("background", ["first", "second"]),
    galleryImages: images("gallery", ["one", "two", "three", "four", "five", "six"])
  };
  await vm.runInNewContext(`(async () => {\n${source}\n})()`, {
    document: { body, querySelector: element, createElement: () => ({}), head: { append() {} } },
    location: { protocol: "https:", hostname: "example.com", origin: "https://example.com", pathname: "/artist/north-star", search: "" },
    window: { matchMedia: () => mediaQuery }, URL, URLSearchParams,
    setInterval(callback) { interval = callback; return 1; },
    clearInterval() { interval = null; },
    fetch: async () => ({ ok: true, json: async () => ({ profile }) })
  });
  assert.equal(body.classList.name, "artist-custom-theme");
  assert.equal(properties["--artist-accent-text"], "#000000");
  assert.equal(properties["--artist-page-color"], "#112233");
  assert.match(properties["--artist-page-image"], /id=first/);
  assert.equal(element("#artist-featured-message p").textContent, "<Welcome>");
  assert.equal(element("#artist-featured-message").hidden, false);
  assert.equal(element("#artist-gallery-images").children[0].alt, "North Star gallery image 1");
  assert.equal(element("#artist-gallery-images").children.length, 6);
  assert.equal(element("#artist-gallery").hidden, false);
  const toggle = element("#artist-background-toggle");
  assert.equal(toggle.textContent, "Play background slideshow");
  assert.equal(interval, undefined);
  toggle.events.click();
  assert.equal(toggle.textContent, "Pause background slideshow");
  interval();
  assert.match(properties["--artist-page-image"], /id=second/);
  mediaQuery.change({ matches: true });
  assert.equal(interval, null);
  assert.equal(toggle.textContent, "Play background slideshow");
});

test("approved storefront renders with metadata from the page", async () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "artist.html"), "utf8");
  assert.ok(html.indexOf('id="artist-gallery"') < html.indexOf('aria-labelledby="artist-support-title"'));
  const source = fs.readFileSync(path.join(__dirname, "..", "artist.js"), "utf8");
  const selectors = [
    "#storefront-status", "#storefront-profile", "#storefront-name",
    "#storefront-bio", "#storefront-socials", "#artist-support-status"
  ];
  const elements = Object.fromEntries(selectors.map((selector) => [selector, { hidden: true, append() {} }]));
  const links = [];
  elements["#storefront-socials"].append = (link) => links.push(link);
  elements["#artist-support-form"] = { querySelector: () => ({}), addEventListener() {} };
  for (const [attribute, name] of [
    ["property", "og:title"], ["property", "og:description"],
    ["name", "description"], ["name", "twitter:title"], ["name", "twitter:description"]
  ]) {
    if (html.includes(`${attribute}="${name}"`)) elements[`meta[${attribute}="${name}"]`] = {};
  }
  const document = {
    querySelector: (selector) => elements[selector] || null,
    createElement: () => ({
      children: [], append(child) { this.children.push(child); },
      setAttribute(name, value) { this[name] = value; }
    }),
    head: { append() {} }
  };
  const context = {
    document,
    location: { protocol: "https:", hostname: "example.com", origin: "https://example.com", pathname: "/artist/north-star", search: "" },
    fetch: async () => ({ ok: true, json: async () => ({
      profile: {
        artistName: "North Star", slug: "north-star", biography: "Independent music.",
        socialLinks: {
          website: "https://example.com/music", facebook: "https://facebook.com/artist",
          instagram: "https://instagram.com/artist", youtube: "https://youtube.com/artist",
          tiktok: "https://tiktok.com/@artist"
        }
      }
    }) }),
    URL, URLSearchParams
  };
  await vm.runInNewContext(`(async () => {\n${source}\nglobalThis.testAddSocialLink = addSocialLink;\n})()`, context);
  assert.equal(elements["#storefront-profile"].hidden, false);
  assert.equal(elements["#storefront-status"].textContent, "");
  assert.equal(elements['meta[name="twitter:title"]'].content, "North Star | Wave Engine Music");
  assert.equal(links[0].textContent, "Visit Artist Website");
  assert.equal(links[0].className, "artist-website-link");
  assert.equal(links[0].href, "https://example.com/music");
  assert.equal(links[0].target, "_blank");
  assert.equal(links[0].rel, "noopener noreferrer");
  for (const [index, label, icon, url] of [
    [1, "Facebook", "facebook", "https://facebook.com/artist"],
    [2, "Instagram", "instagram", "https://instagram.com/artist"],
    [3, "YouTube", "youtube", "https://youtube.com/artist"],
    [4, "TikTok", "tiktok", "https://tiktok.com/@artist"]
  ]) {
    assert.equal(links[index]["aria-label"], `Visit artist's ${label} profile`);
    assert.equal(links[index].children[0].src, `/Images/social/${icon}.svg`);
    assert.equal(links[index].children[0].alt, "");
    assert.match(fs.readFileSync(path.join(__dirname, "..", "Images", "social", `${icon}.svg`), "utf8"), /<svg/);
    assert.equal(links[index].href, url);
    assert.equal(links[index].target, "_blank");
    assert.equal(links[index].rel, "noopener noreferrer");
  }
  for (const invalid of ["", "http://example.com", "javascript:alert(1)", "https://user:pass@example.com"]) {
    context.testAddSocialLink(elements["#storefront-socials"], "Visit Artist Website", invalid, "artist-website-link");
  }
  assert.equal(links.length, 5);
});

test("artist support form validates amounts, opens checkout and verifies the return", async () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "artist.js"), "utf8");
  async function storefront(search = "", confirmed = true) {
    const listeners = {};
    const button = { disabled: false };
    const amount = { value: "" };
    const form = {
      elements: { amount }, querySelector: () => button,
      addEventListener(name, callback) { listeners[name] = callback; }
    };
    const elements = new Map([
      ["#artist-support-form", form], ["#artist-support-status", { textContent: "" }]
    ]);
    function element(selector) {
      if (!elements.has(selector)) elements.set(selector, { hidden: true, append() {} });
      return elements.get(selector);
    }
    const requests = [];
    const locations = [];
    let response = { ok: true, json: async () => ({ url: "https://checkout.stripe.com/session" }) };
    const location = {
      protocol: "https:", hostname: "example.com", origin: "https://example.com",
      pathname: "/artist/north-star", search, assign: (url) => locations.push(url)
    };
    await vm.runInNewContext(`(async () => {\n${source}\n})()`, {
      document: { querySelector: element, createElement: () => ({}), head: { append() {} } },
      location, URL, URLSearchParams,
      fetch: async (url, options) => {
        requests.push({ url, options });
        if (url.includes("artist-profile")) return { ok: true, json: async () => ({
          profile: { artistName: "North Star", slug: "north-star", socialLinks: {} }
        }) };
        if (url.includes("contribution-status")) return { ok: true, json: async () => ({ confirmed }) };
        return response;
      }
    });
    return { element, listeners, amount, button, requests, locations, setResponse(value) { response = value; } };
  }
  const page = await storefront();
  for (const invalid of ["0.49", "10.999", "1e2", "1000000", "-1"]) {
    page.amount.value = invalid;
    await page.listeners.submit({ preventDefault() {} });
    assert.match(page.element("#artist-support-status").textContent, /amount/i);
    assert.equal(page.button.disabled, false);
  }
  assert.equal(page.requests.length, 1);
  page.amount.value = "10.10";
  await page.listeners.submit({ preventDefault() {} });
  assert.deepEqual(JSON.parse(page.requests[1].options.body), { slug: "north-star", amountCents: 1010 });
  assert.equal(page.locations[0], "https://checkout.stripe.com/session");
  assert.equal(page.button.disabled, true);

  const failed = await storefront();
  failed.amount.value = "5";
  failed.setResponse({ ok: false, json: async () => ({ error: "Artist not ready." }) });
  await failed.listeners.submit({ preventDefault() {} });
  assert.equal(failed.element("#artist-support-status").textContent, "Artist not ready.");
  assert.equal(failed.button.disabled, false);

  const returned = await storefront("?contribution=success&session_id=cs_test_123");
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(returned.element("#artist-support-status").textContent, /confirmed/i);
  assert.match(returned.requests[1].url, /action=contribution-status/);
  assert.equal(returned.requests[1].options.referrerPolicy, "no-referrer");
  const unconfirmed = await storefront("?contribution=success&session_id=cs_test_123", false);
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(unconfirmed.element("#artist-support-status").textContent, /could not be verified/i);
  const cancelled = await storefront("?contribution=cancelled");
  assert.match(cancelled.element("#artist-support-status").textContent, /cancelled/i);
});

test("verification updates automatically and storefront state resets when switching accounts", async () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "artist-dashboard.js"), "utf8")
    .replace(/^import[\s\S]*?from "[^"]+";\r?\n/gm, "");
  const elements = new Map();
  function element(selector) {
    if (!elements.has(selector)) elements.set(selector, {
      hidden: false, textContent: "", listeners: {},
      addEventListener(name, callback) { this.listeners[name] = callback; }, replaceChildren() {},
      querySelectorAll: () => [], contains: () => false, reset() {}
    });
    return elements.get(selector);
  }
  const controls = ["artistName", "slug", "biography", "website", "facebook", "instagram", "youtube", "tiktok"]
    .map(() => ({ value: "", disabled: false }));
  for (const [index, name] of ["artistName", "slug", "biography", "website", "facebook", "instagram", "youtube", "tiktok"].entries()) {
    controls[name] = controls[index];
  }
  const profileControls = { value: "50", addEventListener() {} };
  controls.bannerPositionY = profileControls;
  controls.banner = { files: [], addEventListener() {} };
  addCustomizationControls(controls, element);
  element("#banner-preview").style = {};
  element("#artist-profile-form").elements = controls;
  element("#artist-profile-form").reset = () => {
    controls.artistName.value = "";
    controls.featuredMessage.value = "";
    controls.backgroundImages.files = [];
  };
  element("#artist-release-form").elements = {
    genre: { querySelector: () => null, querySelectorAll: () => [], options: [], addEventListener() {} },
    releaseType: { value: "single", addEventListener() {} },
    saleMode: { value: "none", addEventListener() {} },
    albumAudio: { files: [], addEventListener() {} },
    cover: { files: [], addEventListener() {} },
    downloadPrice: { value: "" }
  };
  const document = {
    querySelector: element, createElement: () => ({}), visibilityState: "visible", listeners: {},
    addEventListener(name, callback) { this.listeners[name] = callback; }
  };
  const auth = { currentUser: null };
  const timers = new Map();
  let nextTimer = 0;
  let onAuth;
  await vm.runInNewContext(`(async () => {\n${source}\n})()`, {
    document,
    location: { protocol: "https:", hostname: "example.com" },
    firebaseClient: async () => ({}), getAuth: () => auth, getStorage: () => ({}),
    onAuthStateChanged: (_auth, callback) => { onAuth = callback; },
    setInterval: (callback, delay) => { assert.equal(delay, 15000); timers.set(++nextTimer, callback); return nextTimer; },
    clearInterval: (id) => timers.delete(id),
    createCoverPreviews: () => ({ clear() {}, add() {}, addLocal() {} }),
    fetch: async (url) => {
      if (url.includes("action=config")) return { ok: true, json: async () => ({ storageBucket: "bucket" }) };
      if (url.includes("artist-releases")) return { ok: true, json: async () => ({ releases: [] }) };
      if (url.includes("artist-profile")) {
        return currentAccount !== "new"
          ? { ok: true, json: async () => ({ profile: { status: currentAccount, artistName: "Artist", slug: "artist", socialLinks: {} } }) }
          : { ok: false, json: async () => ({ error: "No artist profile is registered for this account." }) };
      }
      throw new Error(`Unexpected request: ${url}`);
    },
    URL, URLSearchParams
  });
  let currentAccount = "rejected";
  const setUser = async (value) => { auth.currentUser = value; await onAuth(value); };
  let verified = false;
  let reloads = 0;
  let tokenRefreshes = 0;
  const unverified = {
    email: "pending@example.com", emailVerified: false,
    async reload() { reloads++; this.emailVerified = verified; },
    async getIdToken(force) { if (force) tokenRefreshes++; return "token"; }
  };
  await setUser(unverified);
  assert.equal(element("#artist-verify").hidden, false);
  assert.equal(timers.size, 1);
  document.visibilityState = "hidden";
  await Array.from(timers.values())[0]();
  assert.equal(reloads, 0);
  document.visibilityState = "visible";
  await element("#artist-verify").listeners.click();
  assert.equal(element("#artist-verify").hidden, false);
  assert.equal(reloads, 1);
  verified = true;
  await document.listeners.visibilitychange();
  assert.equal(element("#artist-verify").hidden, true);
  assert.equal(tokenRefreshes, 1);
  assert.equal(timers.size, 0);

  verified = false;
  unverified.emailVerified = false;
  await setUser(unverified);
  verified = true;
  await Array.from(timers.values())[0]();
  assert.equal(element("#artist-verify").hidden, true);
  assert.equal(timers.size, 0);

  const user = { email: "artist@example.com", emailVerified: true, getIdToken: async () => "token" };
  unverified.emailVerified = false;
  unverified.reload = async () => { throw new Error("Network unavailable"); };
  await setUser(unverified);
  await document.listeners.visibilitychange();
  assert.match(element("#artist-status").textContent, /Network unavailable/);
  assert.equal(element("#artist-verify").hidden, false);
  assert.equal(timers.size, 1);
  unverified.reload = async () => { unverified.emailVerified = true; };
  unverified.getIdToken = async () => { throw new Error("Token refresh failed"); };
  await document.listeners.visibilitychange();
  assert.match(element("#artist-status").textContent, /Token refresh failed/);
  assert.equal(element("#artist-verify").hidden, false);
  unverified.getIdToken = async () => "token";
  await document.listeners.visibilitychange();
  assert.equal(element("#artist-verify").hidden, true);

  unverified.emailVerified = false;
  await setUser(unverified);
  let finishReload;
  unverified.reload = () => new Promise((resolve) => { finishReload = resolve; });
  const pendingCheck = document.listeners.visibilitychange();
  const secondCheck = element("#artist-verify").listeners.click();
  await setUser(user);
  unverified.emailVerified = true;
  finishReload();
  await pendingCheck;
  await secondCheck;
  assert.equal(element("#artist-email").textContent, user.email);
  assert.equal(element("#artist-verify").hidden, true);
  assert.equal(timers.size, 0);

  await setUser(user);
  assert.equal(element("#artist-verify").hidden, true);
  assert.ok(controls.every((control) => control.disabled));
  assert.match(element("#artist-storefront-notice").textContent, /inactive/);
  currentAccount = "pending";
  await setUser(user);
  assert.equal(element("#artist-storefront-link").hidden, true);
  assert.equal(element("#studio-profile-link").hidden, true);
  assert.equal(element("#artist-storefront-unavailable").hidden, false);
  assert.match(element("#artist-storefront-notice").textContent, /awaiting review/);
  currentAccount = "approved";
  await setUser(user);
  assert.equal(element("#artist-storefront-link").hidden, false);
  assert.equal(element("#artist-storefront-link").href, "/artist/artist");
  assert.equal(element("#studio-profile-link").hidden, false);
  assert.equal(element("#studio-profile-link").href, "/artist/artist");
  assert.equal(element("#artist-storefront-unavailable").hidden, true);
  assert.equal(element("#artist-storefront-notice").textContent, "");
  controls.artistName.value = "Previous artist";
  controls.featuredMessage.value = "Private message";
  controls.backgroundImages.files = [{ name: "private.png" }];
  currentAccount = "new";
  await setUser({ ...user, uid: "other" });
  assert.equal(element("#studio-profile-link").hidden, true);
  assert.equal(element("#studio-profile-link").href, "");
  assert.equal(controls.artistName.value, "");
  assert.equal(controls.featuredMessage.value, "");
  assert.deepEqual(controls.backgroundImages.files, []);
  await setUser(null);
  assert.equal(element("#studio-profile-link").hidden, true);
  await setUser(user);
  assert.ok(controls.every((control) => !control.disabled));
  assert.equal(element("#artist-profile-link").hidden, true);
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

test("editing drafts preserves metadata and supports both album and song prices", async () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "artist-dashboard.js"), "utf8")
    .replace(/^import[\s\S]*?from "[^"]+";\r?\n/gm, "");
  const elements = new Map();
  function element(selector) {
    if (!elements.has(selector)) elements.set(selector, {
      listeners: {}, children: [], hidden: false, textContent: "",
      addEventListener(name, callback) { this.listeners[name] = callback; },
      replaceChildren(...children) { this.children = children; },
      append(...children) { this.children.push(...children); }, querySelectorAll: () => [],
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
    audio: { value: "", files: [] }, cover: {
      value: "", files: [], listeners: {},
      addEventListener(name, callback) { this.listeners[name] = callback; }
    },
    releaseType: { value: "single", addEventListener() {} },
    saleMode: { value: "none", addEventListener() {} },
    albumAudio: {
      files: [], listeners: {},
      addEventListener(name, callback) { this.listeners[name] = callback; }
    }, reviewRights: { checked: false }
  };
  element("#artist-profile-form").elements = [];
  element("#artist-profile-form").elements.bannerPositionY = { value: "50", addEventListener() {} };
  element("#artist-profile-form").elements.banner = { files: [], addEventListener() {} };
  addCustomizationControls(element("#artist-profile-form").elements, element);
  element("#banner-preview").style = {};
  const submitted = [];
  let failSubmission = false;
  let releaseList = [];
  const previewManagers = [];
  const document = { querySelector: element, addEventListener() {}, createElement: () => ({
    dataset: {}, children: [], append(...children) { this.children.push(...children); }, addEventListener() {}
  }) };
  const context = {
    document, location: { protocol: "https:", hostname: "example.com" },
    firebaseClient: async () => ({}), getAuth: () => ({}), getStorage: () => ({}),
    onAuthStateChanged() {},
    crypto: { randomUUID: () => "12345678-1234-1234-1234-123456789012" },
    ref: (_storage, path) => path,
    uploadBytesResumable: () => ({ on(_event, _progress, _error, complete) { complete(); } }),
    createCoverPreviews: () => {
      const manager = { added: [], local: [], clear() {}, add(_container, release) { this.added.push(release); },
        addLocal(_container, file) { this.local.push(file); } };
      previewManagers.push(manager);
      return manager;
    },
    fetch: async (url, options = {}) => {
      if (url.includes("action=config")) return { ok: true, json: async () => ({ storageBucket: "bucket" }) };
      if (url.includes("artist-releases") && options.method === "POST") {
        const body = JSON.parse(options.body);
        submitted.push(body);
        if (body.action === "submit" && failSubmission) {
          return { ok: false, json: async () => ({ error: "Review unavailable." }) };
        }
        return { ok: true, json: async () => ({ release: { ...body, id: body.id || "new-id" } }) };
      }
      if (url.includes("artist-releases")) return { ok: true, json: async () => ({ releases: releaseList }) };
      throw new Error(`Unexpected request: ${url}`);
    },
    URL, URLSearchParams
  };
  await vm.runInNewContext(`(async () => {\n${source}\nglobalThis.testEditDraft = editDraft;\nglobalThis.testLoadReleases = loadReleases;\nglobalThis.testSetUser = (user) => { currentUser = user; currentProfile = { status: "approved" }; };\n})()`, context);
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

  context.testEditDraft({
    id: "album-id", title: "Album", genre: "Rock", releaseType: "album", saleMode: "both",
    downloadPriceCents: 500, moods: [], coverPath: "cover",
    tracks: [{ id: "track-1", title: "Song", audioPath: "audio", downloadPriceCents: 125 }]
  });
  assert.equal(previewManagers[1].added.at(-1).title, "Album");
  const selectedCover = { name: "cover.png", type: "image/png", size: 5 };
  releaseForm.elements.cover.files = [selectedCover];
  releaseForm.elements.cover.listeners.change();
  assert.equal(previewManagers[1].local[0], selectedCover);
  releaseForm.elements.cover.files = [];
  assert.equal(element("#artist-price-label").hidden, false);
  assert.equal(releaseForm.elements.downloadPrice.required, true);
  const songPriceLabel = element("#artist-album-tracks").children[0].children[1];
  assert.equal(songPriceLabel.hidden, false);
  assert.equal(songPriceLabel.children[0].required, true);
  await releaseForm.listeners.submit({ preventDefault() {} });
  assert.equal(submitted[3].saleMode, "both");
  assert.equal(submitted[3].downloadPriceCents, 500);
  assert.equal(submitted[3].tracks[0].downloadPriceCents, 125);
  const reviewEvent = { preventDefault() {}, submitter: { id: "artist-release-submit-review" } };
  context.testEditDraft({
    id: "album-id", title: "Album", genre: "Rock", releaseType: "album", saleMode: "both",
    downloadPriceCents: 500, coverPath: "cover",
    tracks: [{ id: "track-1", title: "Song", audioPath: "audio", downloadPriceCents: 125 }]
  });
  await releaseForm.listeners.submit(reviewEvent);
  assert.equal(submitted.length, 4);
  assert.match(element("#artist-status").textContent, /confirm your rights/i);
  assert.match(element("#artist-release-status").textContent, /confirm your rights/i);
  releaseForm.elements.reviewRights.checked = true;
  await releaseForm.listeners.submit(reviewEvent);
  assert.equal(submitted[4].action, "update");
  assert.deepEqual(submitted[5], {
    action: "submit", id: "album-id", rightsConfirmed: true, salesRightsConfirmed: true
  });
  assert.match(element("#artist-status").textContent, /submitted for review/i);

  context.testEditDraft({
    id: "missing-cover", title: "Album", releaseType: "album", saleMode: "none",
    tracks: [{ id: "track-1", title: "Song", audioPath: "audio" }]
  });
  await releaseForm.listeners.submit(reviewEvent);
  assert.equal(submitted.length, 6);
  assert.match(element("#artist-status").textContent, /album cover/i);

  context.testEditDraft({ id: "single-id", title: "Song", releaseType: "single", audioPath: "audio" });
  failSubmission = true;
  await releaseForm.listeners.submit(reviewEvent);
  assert.equal(submitted[6].action, "update");
  assert.deepEqual(submitted[7], {
    action: "submit", id: "single-id", rightsConfirmed: true, salesRightsConfirmed: false
  });
  assert.match(element("#artist-status").textContent, /draft saved.*submission could not be confirmed.*Review unavailable/i);

  failSubmission = false;
  releaseForm.elements.releaseType.value = "album";
  releaseForm.elements.saleMode.value = "none";
  releaseForm.elements.title.value = "New album";
  releaseForm.elements.albumAudio.files = [{ name: "song.mp3", type: "audio/mpeg", size: 5 }];
  releaseForm.elements.albumAudio.listeners.change();
  releaseForm.elements.cover.files = [{ name: "cover.png", type: "image/png", size: 5 }];
  await releaseForm.listeners.submit(reviewEvent);
  assert.equal(submitted[8].action, "create");
  assert.equal(submitted[9].action, "update");
  assert.match(submitted[9].tracks[0].audioPath, /audio\.mp3$/);
  assert.match(submitted[9].coverPath, /cover\.png$/);
  assert.equal(submitted[10].action, "submit");
  assert.equal(submitted[10].id, "new-id");
  assert.match(element("#artist-release-status").textContent, /submitted for review/i);
  releaseList = ["draft", "submitted", "published"].map((status) => ({
    id: status, title: status, status, releaseType: "single", coverPath: "cover", audioPath: "audio"
  }));
  await context.testLoadReleases();
  assert.deepEqual(previewManagers[0].added.map((release) => release.status), ["draft", "submitted", "published"]);
});

test("profile editor saves image sets and safely handles uncertain saves and account changes", async () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "artist-dashboard.js"), "utf8")
    .replace(/^import[\s\S]*?from "[^"]+";\r?\n/gm, "");
  const elements = new Map();
  function element(selector) {
    if (!elements.has(selector)) elements.set(selector, {
      listeners: {}, children: [], style: { setProperty() {} },
      addEventListener(name, callback) { this.listeners[name] = callback; },
      replaceChildren(...children) { this.children = children; },
      append(...children) { this.children.push(...children); },
      querySelectorAll: () => [], contains: () => false, reset() {}
    });
    return elements.get(selector);
  }
  const form = element("#artist-profile-form");
  const controls = [];
  for (const [name, value] of Object.entries({
    artistName: "Artist", slug: "artist", biography: "Bio", website: "", facebook: " https://facebook.com/artist ", instagram: "", youtube: "", tiktok: "",
    bannerPositionY: "50", accentColor: "#123456", backgroundColor: "#abcdef", featuredMessage: " Hello "
  })) controls[name] = { value, addEventListener() {} };
  for (const name of ["avatar", "banner", "backgroundImages", "galleryImages"]) {
    let files = [];
    controls[name] = {
      get files() { return files; }, set files(value) { files = value; },
      set value(value) { if (!value) files = []; }, listeners: {},
      addEventListener(name, callback) { this.listeners[name] = callback; }
    };
  }
  for (const name of ["clearBackgroundImages", "clearGalleryImages"]) controls[name] = { checked: false, addEventListener() {} };
  form.elements = controls;
  const releaseForm = element("#artist-release-form");
  releaseForm.elements = {
    genre: { querySelector: () => null, querySelectorAll: () => [], options: [], addEventListener() {} },
    releaseType: { value: "single", addEventListener() {} }, saleMode: { value: "none", addEventListener() {} },
    albumAudio: { files: [], addEventListener() {} }, cover: { files: [], addEventListener() {} },
    downloadPrice: { value: "" }
  };
  const user = { uid: "artist-1", getIdToken: async () => "token" };
  const other = { uid: "other", getIdToken: async () => "other-token" };
  const profile = { status: "approved", artistName: "Artist", slug: "artist", socialLinks: { facebook: "https://facebook.com/artist" },
    galleryImages: [{ url: "/existing" }] };
  const submitted = [];
  const deleted = [];
  let uploadedPaths = [];
  let mode = "success";
  let id = 0;
  const context = {
    document: { querySelector: element, addEventListener() {}, createElement: () => ({
      children: [], listeners: {}, append(...children) { this.children.push(...children); },
      addEventListener(name, callback) { this.listeners[name] = callback; }
    }) },
    location: { protocol: "https:", hostname: "example.com" },
    firebaseClient: async () => ({}), getAuth: () => ({}), getStorage: () => ({}), onAuthStateChanged() {},
    createCoverPreviews: () => ({ clear() {}, add() {}, addProfile: async () => {}, addLocal() {} }),
    FormData: class { get(name) { return controls[name].value; } },
    crypto: { randomUUID: () => `uuid-${++id}` },
    ref: (_storage, path) => path,
    uploadBytesResumable: (path) => ({ on(_event, _progress, _error, done) {
      uploadedPaths.push(path);
      if (mode === "switch") context.testSetUser(other);
      done();
    } }),
    deleteObject: async (path) => { deleted.push(path); },
    fetch: async (url, options = {}) => {
      if (url.includes("action=config")) return { ok: true, json: async () => ({ storageBucket: "bucket" }) };
      if (options.method === "POST") {
        const body = JSON.parse(options.body);
        submitted.push(body);
        if (mode !== "success") throw new Error("Connection lost");
        if (body.addGalleryPaths) profile.galleryImages.push(...body.addGalleryPaths.map((path) => ({ url: path })));
        if (body.galleryPaths) profile.galleryImages = body.galleryPaths.map((path) => ({ url: path }));
        return { ok: true, json: async () => ({ profile, cleanupPaths: ["old-image"] }) };
      }
      if (url.includes("me=1")) {
        if (mode === "verify-fails") throw new Error("Verification unavailable");
        return { ok: true, json: async () => ({ assetPaths: mode === "saved" ? uploadedPaths : [] }) };
      }
      throw new Error(`Unexpected request: ${url}`);
    },
    URL, URLSearchParams
  };
  context.testProfile = profile;
  await vm.runInNewContext(`(async () => {\n${source}\nglobalThis.testSetUser = (user) => { currentUser = user; currentProfile = testProfile; };\n})()`, context);
  const image = (name) => ({ name: `${name}.png`, type: "image/png", size: 10 });
  const submit = () => form.listeners.submit({ preventDefault() {} });
  context.testSetUser(user);
  controls.backgroundImages.files = [image("one"), image("two")];
  for (const name of ["three", "four", "five"]) {
    controls.galleryImages.files = [image(name)];
    controls.galleryImages.listeners.change();
  }
  assert.equal(element("#artist-gallery-selection").textContent, "1 saved; 3 selected; 2 slots remaining.");
  await submit();
  assert.equal(submitted[0].socialLinks.facebook, "https://facebook.com/artist");
  assert.equal(controls.facebook.value, "https://facebook.com/artist");
  assert.equal(submitted[0].appearance.accentColor, "#123456");
  assert.equal(submitted[0].appearance.backgroundColor, "#abcdef");
  assert.equal(submitted[0].appearance.featuredMessage, "Hello");
  assert.equal(submitted[0].backgroundPaths.length, 2);
  assert.equal(submitted[0].addGalleryPaths.length, 3);
  assert.deepEqual(deleted, ["old-image"]);
  assert.equal(profile.galleryImages.length, 4);

  controls.galleryImages.files = [image("six")];
  controls.galleryImages.listeners.change();
  controls.galleryImages.files = [image("seven")];
  controls.galleryImages.listeners.change();
  await submit();
  assert.equal(submitted[1].addGalleryPaths.length, 2);
  assert.equal(profile.galleryImages.length, 6);
  controls.galleryImages.files = [image("over-limit")];
  controls.galleryImages.listeners.change();
  assert.match(element("#artist-status").textContent, /up to 6/);
  assert.match(element("#artist-gallery-error").textContent, /0 more can be selected/);
  assert.equal(element("#artist-gallery-selection").textContent, "6 saved; 0 selected; 0 slots remaining.");

  controls.clearGalleryImages.checked = true;
  await submit();
  assert.deepEqual(submitted[2].galleryPaths, []);
  assert.equal("backgroundPaths" in submitted[2], false);
  for (let index = 0; index < 6; index++) {
    controls.galleryImages.files = [image(`batch-${index}`)];
    controls.galleryImages.listeners.change();
  }
  assert.equal(element("#artist-gallery-selection").textContent, "0 saved; 6 selected; 0 slots remaining.");
  assert.equal(element("#artist-gallery-selection-list").children.length, 6);
  await submit();
  assert.equal(submitted[3].addGalleryPaths.length, 6);
  assert.equal(profile.galleryImages.length, 6);
  controls.backgroundImages.files = Array.from({ length: 6 }, (_, index) => image(`excess-${index}`));
  await submit();
  assert.match(element("#artist-status").textContent, /up to 5/);
  assert.equal(submitted.length, 4);

  for (const nextMode of ["saved", "verify-fails", "not-saved", "switch"]) {
    context.testSetUser(user);
    mode = nextMode;
    uploadedPaths = [];
    controls.backgroundImages.files = [image("next")];
    deleted.length = 0;
    await submit();
    if (nextMode === "not-saved") assert.deepEqual(deleted, uploadedPaths);
    else assert.deepEqual(deleted, []);
    if (nextMode === "verify-fails") assert.match(element("#artist-status").textContent, /retained/);
    if (nextMode === "switch") assert.match(element("#artist-status").textContent, /account changed/);
  }
});

test("admin review displays release covers and pending profile customization", async () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "artist-admin.js"), "utf8")
    .replace(/^import[\s\S]*?from "[^"]+";\r?\n/gm, "");
  const elements = new Map();
  function element(selector) {
    if (!elements.has(selector)) elements.set(selector, {
      children: [], addEventListener() {}, replaceChildren(...children) { this.children = children; },
      append(...children) { this.children.push(...children); }
    });
    return elements.get(selector);
  }
  const added = [];
  const profileImages = [];
  let cleared = 0;
  let onAuth;
  const context = {
    document: { querySelector: element, createElement: () => ({
      children: [], addEventListener() {}, append(...children) { this.children.push(...children); }
    }) },
    location: { protocol: "https:", hostname: "example.com" },
    firebaseClient: async () => ({}), getAuth: () => ({}),
    onAuthStateChanged: (_auth, callback) => { onAuth = callback; },
    createCoverPreviews: (_api, mode) => {
      assert.equal(mode, "review");
      return { clear() { cleared++; }, add(_card, release) { added.push(release.id); },
        addProfile(_card, image, title) { profileImages.push({ image, title }); } };
    },
    URL
  };
  await vm.runInNewContext(`(async () => {\n${source}\nglobalThis.testRenderReleases = renderReleases;\nglobalThis.testRenderApplications = renderApplications;\n})()`, context);
  context.testRenderReleases([
    { id: "album", title: "Album", artistName: "Artist", status: "submitted", releaseType: "album", tracks: [], hasCover: true },
    { id: "single", title: "Single", artistName: "Artist", status: "published", hasCover: true },
    { id: "no-cover", title: "No cover", artistName: "Artist", status: "submitted", hasCover: false }
  ]);
  assert.deepEqual(added, ["album", "single"]);
  assert.ok(element("#artist-release-reviews").children[2].children.some((child) =>
    child.textContent === "No cover artwork uploaded."));
  context.testRenderApplications([{ artistName: "Artist", slug: "artist",
    appearance: { featuredMessage: "Welcome" }, backgroundImages: [{ url: "/background" }],
    galleryImages: [{ url: "/gallery" }] }]);
  assert.deepEqual(profileImages.map((image) => image.title), ["Background", "Gallery"]);
  assert.ok(element("#artist-applications").children[0].children.some((child) =>
    child.textContent === "Featured message: Welcome"));
  await onAuth(null);
  assert.equal(element("#artist-release-reviews").children.length, 0);
  assert.equal(cleared, 4);
});
