const test = require("node:test");
const assert = require("node:assert/strict");
const { Readable, Writable } = require("node:stream");
const music = require("../server/music-library");
const { createHandler: fileHandler } = require("../server/music-file-handler");
const { createHandler: libraryHandler } = require("../server/music-library-handler");
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
  const download = await request(handler, "/api/music-file?id=track1&format=mp3&download=1");
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
  const download = await request(handler, "/api/music-file?id=track1&format=wav&download=1");
  assert.equal(download.statusCode, 200);
  assert.equal(download.headers["content-type"], "audio/wav");
  assert.equal(download.headers["content-disposition"], 'attachment; filename="Wave Engine - Test.wav"');
  changing.published = false;
  const hidden = await request(handler, "/api/music-file?id=track1&format=wav");
  assert.equal(hidden.statusCode, 404);
  assert.equal(fake.accesses(), 1);
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
