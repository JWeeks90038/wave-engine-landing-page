const { readJsonBody, sendJson, setCorsHeaders } = require("./api-utils");
const { database, filePath } = require("./music-library");
const marketplace = require("./artist-marketplace");

function countFor(data, key) {
  if (!data) return 0;
  if (!data.counts || typeof data.counts !== "object" || Array.isArray(data.counts)) {
    throw new Error("Invalid stream count data.");
  }
  const count = data.counts[key];
  if (count === undefined) return 0;
  if (!Number.isSafeInteger(count) || count < 0) throw new Error("Invalid stream count.");
  return count;
}

async function countDocuments(db, kind, documents) {
  const counts = new Map();
  for (let offset = 0; offset < documents.length; offset += 20) {
    const batch = documents.slice(offset, offset + 20);
    const snapshots = await Promise.all(batch.map((doc) =>
      db.collection("songStreamCounts").doc(`${kind}_${doc.id}`).get()));
    for (const snapshot of snapshots) {
      if (snapshot.exists) counts.set(snapshot.id, snapshot.data());
    }
  }
  return counts;
}

function createHandler(kind, { getDatabase = database } = {}) {
  return async (request, response) => {
    response.setHeader("Cache-Control", "private, no-store");
    if (request.method === "OPTIONS") {
      setCorsHeaders(response);
      response.writeHead(204);
      return response.end();
    }
    if (request.method !== "POST") return sendJson(response, 405, { error: "Method not allowed." });
    try {
      const body = await readJsonBody(request);
      if (!body || typeof body !== "object" || Array.isArray(body) ||
          typeof body.id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(body.id) ||
          (body.trackId !== undefined && (typeof body.trackId !== "string" ||
            !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(body.trackId)))) {
        return sendJson(response, 400, { error: "Invalid stream count request." });
      }
      const db = getDatabase();
      const songRef = db.collection(kind === "music" ? "musicTracks" : "artistReleases").doc(body.id);
      const countRef = db.collection("songStreamCounts").doc(`${kind}_${body.id}`);
      let updatedCount;
      await db.runTransaction(async (transaction) => {
        const songDoc = await transaction.get(songRef);
        const song = songDoc.exists && songDoc.data();
        let key = "single";
        if (kind === "music") {
          if (!song || song.published !== true || body.trackId !== undefined ||
              (!filePath(body.id, song, "mp3") && !filePath(body.id, song, "wav"))) {
            throw marketplace.statusError("Song not found.", 404);
          }
        } else {
          if (!song || song.status !== "published" || song.rightsConfirmed !== true ||
              typeof song.artistUid !== "string") {
            throw marketplace.statusError("Song not found.", 404);
          }
          const artist = await transaction.get(db.collection("artists").doc(song.artistUid));
          if (!artist.exists || artist.data().status !== "approved") throw marketplace.statusError("Song not found.", 404);
          const slug = marketplace.validateSlug(artist.data().slug);
          const slugDoc = await transaction.get(db.collection("artistSlugs").doc(slug));
          if (!slugDoc.exists || slugDoc.data().status !== "approved" || slugDoc.data().artistUid !== song.artistUid) {
            throw marketplace.statusError("Song not found.", 404);
          }
          marketplace.validateReleaseInput(song.artistUid, body.id, song);
          const audio = marketplace.releaseAudio(song);
          const track = song.releaseType === "album"
            ? audio.find((entry) => entry.id === body.trackId)
            : body.trackId === undefined ? audio[0] : null;
          if (!track || !track.audioPath || typeof track.audioGeneration !== "string" ||
              !/^\d+$/.test(track.audioGeneration)) throw marketplace.statusError("Song not found.", 404);
          if (song.releaseType === "album") key = track.id;
        }
        const countDoc = await transaction.get(countRef);
        const current = countDoc.exists ? countDoc.data() : undefined;
        if (current && current.kind !== kind) throw new Error("Invalid stream count type.");
        updatedCount = countFor(current, key) + 1;
        if (!Number.isSafeInteger(updatedCount)) throw new Error("Stream count limit reached.");
        transaction.set(countRef, { kind, counts: { ...(current ? current.counts : {}), [key]: updatedCount } });
      });
      return sendJson(response, 200, { count: updatedCount });
    } catch (error) {
      if (error instanceof SyntaxError) return sendJson(response, 400, { error: "Invalid stream count request." });
      if (!error.statusCode) console.error("Stream count error:", error.message);
      return sendJson(response, error.statusCode || 503, { error: error.statusCode ? error.message : "Stream count could not be updated." });
    }
  };
}

module.exports = { countFor, countDocuments, createHandler };
