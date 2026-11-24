const test = require("node:test");
const assert = require("node:assert/strict");
const { Readable, Writable } = require("node:stream");
const { createHandler: profileHandler } = require("../server/artist-profile-handler");
const { createHandler: releaseHandler } = require("../server/artist-releases-handler");
const { createHandler: adminHandler } = require("../server/artist-admin-handler");
const { createHandler: mediaHandler } = require("../server/artist-media-handler");
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

function request(handler, method, url, body, authorization = "Bearer valid") {
  const input = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  input.method = method;
  input.url = url;
  input.headers = { authorization };
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
