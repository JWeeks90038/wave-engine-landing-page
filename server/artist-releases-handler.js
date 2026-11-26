const { readJsonBody, sendJson, setCorsHeaders } = require("./api-utils");
const marketplace = require("./artist-marketplace");
const { publicArtists, streamRelease, validId } = require("./artist-streaming");

function createHandler({
  database = marketplace.database,
  authenticate = marketplace.authenticate,
  bucket = marketplace.bucket
} = {}) {
  return async (request, response) => {
    if (request.method === "OPTIONS") {
      setCorsHeaders(response);
      response.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Range");
      response.writeHead(204);
      return response.end();
    }
    if (request.method !== "GET" && request.method !== "POST") {
      return sendJson(response, 405, { error: "Method not allowed." });
    }
    response.setHeader("Cache-Control", "private, no-store");

    try {
      const action = new URL(request.url, "http://localhost").searchParams.get("action");
      if (request.method === "GET" && action === "public") {
        return sendJson(response, 200, { artists: await publicArtists(database()) });
      }
      if (request.method === "GET" && (action === "stream" || action === "review")) {
        return await streamRelease(request, response, {
          db: database(), bucket, authenticate, review: action === "review"
        });
      }
      const user = await authenticate(request);
      const db = database();
      const artistRef = db.collection("artists").doc(user.uid);
      const artistSnapshot = await artistRef.get();
      if (!artistSnapshot.exists || ["rejected", "suspended"].includes(artistSnapshot.data().status)) {
        return sendJson(response, 403, { error: "An active artist profile is required to manage drafts." });
      }

      if (request.method === "GET") {
        const snapshot = await db.collection("artistReleases").where("artistUid", "==", user.uid).get();
        const releases = snapshot.docs.map((entry) => ({ id: entry.id, ...entry.data() }))
          .sort((a, b) => {
            const first = a.updatedAt && a.updatedAt.toMillis ? a.updatedAt.toMillis() : 0;
            const second = b.updatedAt && b.updatedAt.toMillis ? b.updatedAt.toMillis() : 0;
            return second - first;
          });
        return sendJson(response, 200, { releases });
      }

      const body = await readJsonBody(request);
      if (body.action === "submit" || body.action === "withdraw") {
        if (!validId(body.id)) return sendJson(response, 400, { error: "Invalid draft identifier." });
        const releaseRef = db.collection("artistReleases").doc(body.id);
        if (body.action === "submit") {
          if (body.rightsConfirmed !== true) {
            return sendJson(response, 400, { error: "Confirm your rights to upload and publicly stream this track." });
          }
          const draft = await releaseRef.get();
          const release = draft.exists && draft.data();
          if (!release || release.artistUid !== user.uid) return sendJson(response, 404, { error: "Draft not found." });
          if (release.status !== "draft" || artistSnapshot.data().status !== "approved") {
            return sendJson(response, 409, { error: "Only drafts from approved artists can be submitted." });
          }
          const fields = marketplace.validateReleaseInput(user.uid, body.id, release);
          const hasSales = marketplace.releaseHasSales(fields);
          if (hasSales && body.salesRightsConfirmed !== true) {
            return sendJson(response, 400, { error: "Confirm your rights to sell downloads of this release." });
          }
          const tracks = marketplace.releaseAudio(fields);
          if (!tracks.length || tracks.some((track) => !track.audioPath)) {
            return sendJson(response, 400, { error: "Upload audio before submitting this release." });
          }
          if (fields.releaseType === "album") {
            if (!fields.coverPath) return sendJson(response, 400, { error: "Upload album cover artwork before submitting." });
            await verifyCover(bucket, fields.coverPath);
          }
          const generations = await Promise.all(tracks.map((track) => verifyAudio(bucket, track.audioPath)));
          await db.runTransaction(async (transaction) => {
            const current = await transaction.get(releaseRef);
            const artist = await transaction.get(artistRef);
            if (!current.exists || current.data().artistUid !== user.uid ||
                current.data().status !== "draft" ||
                JSON.stringify(marketplace.validateReleaseInput(user.uid, body.id, current.data())) !== JSON.stringify(fields) ||
                !artist.exists || artist.data().status !== "approved") {
              throw marketplace.statusError("The draft or artist status changed. Refresh and try again.", 409);
            }
            transaction.update(releaseRef, {
              status: "submitted", rightsConfirmed: true,
              salesRightsConfirmed: hasSales && body.salesRightsConfirmed === true,
              ...(fields.releaseType === "album"
                ? { trackGenerations: Object.fromEntries(tracks.map((track, index) => [track.id, generations[index]])) }
                : { audioGeneration: generations[0] }),
              submittedAt: marketplace.FieldValue.serverTimestamp(),
              updatedAt: marketplace.FieldValue.serverTimestamp()
            });
          });
          return sendJson(response, 200, { status: "submitted" });
        }
        await db.runTransaction(async (transaction) => {
          const current = await transaction.get(releaseRef);
          if (!current.exists || current.data().artistUid !== user.uid) {
            throw marketplace.statusError("Track not found.", 404);
          }
          if (!["submitted", "published"].includes(current.data().status)) {
            throw marketplace.statusError("This track is not submitted or published.", 409);
          }
          transaction.update(releaseRef, {
            status: "draft", rightsConfirmed: false, salesRightsConfirmed: false,
            updatedAt: marketplace.FieldValue.serverTimestamp()
          });
        });
        return sendJson(response, 200, { status: "draft" });
      }
      if (body.action !== "create" && body.action !== "update") {
        return sendJson(response, 400, { error: "Choose a valid draft action." });
      }
      const releaseRef = body.action === "create"
        ? db.collection("artistReleases").doc()
        : db.collection("artistReleases").doc(
          typeof body.id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(body.id) ? body.id : "_invalid"
        );
      if (releaseRef.id === "_invalid") return sendJson(response, 400, { error: "Invalid draft identifier." });
      const fields = marketplace.validateReleaseInput(user.uid, releaseRef.id, body);
      await Promise.all(marketplace.releaseAudio(fields).filter((track) => track.audioPath)
        .map((track) => verifyAudio(bucket, track.audioPath)));
      if (fields.coverPath) await verifyCover(bucket, fields.coverPath);

      if (body.action === "create") {
        const record = {
          ...fields, artistUid: user.uid, status: "draft",
          createdAt: marketplace.FieldValue.serverTimestamp(),
          updatedAt: marketplace.FieldValue.serverTimestamp()
        };
        await releaseRef.create(record);
        return sendJson(response, 201, { release: { id: releaseRef.id, ...fields, status: "draft" } });
      }

      await db.runTransaction(async (transaction) => {
        const existing = await transaction.get(releaseRef);
        if (!existing.exists || existing.data().artistUid !== user.uid) {
          throw marketplace.statusError("Draft not found.", 404);
        }
        if (existing.data().status !== "draft") {
          throw marketplace.statusError("Only unpublished drafts can be edited.", 409);
        }
        transaction.update(releaseRef, {
          ...fields, updatedAt: marketplace.FieldValue.serverTimestamp()
        });
      });
      return sendJson(response, 200, { release: { id: releaseRef.id, ...fields, status: "draft" } });
    } catch (error) {
      if (response.headersSent) return response.destroy(error);
      if (error instanceof SyntaxError) return sendJson(response, 400, { error: "The request payload was invalid JSON." });
      console.error("Artist draft error:", error.message);
      const requestAction = new URL(request.url, "http://localhost").searchParams.get("action");
      if ((requestAction === "stream" || requestAction === "review") && (error.code === 404 || error.code === "404")) {
        return sendJson(response, 404, { error: "Artist track not found." });
      }
      return sendJson(response, error.statusCode || (error.code === 404 ? 400 : 503), {
        error: error.statusCode ? error.message :
          error.code === 404 ? "An uploaded file could not be found." : "The artist draft could not be saved."
      });
    }
  };
}

async function verifyAudio(bucketFactory, path) {
  const [metadata] = await bucketFactory().file(path).getMetadata();
  const allowed = {
    "audio.mp3": ["audio/mpeg", 100 * 1024 * 1024],
    "audio.wav": [["audio/wav", "audio/x-wav"], 100 * 1024 * 1024]
  };
  const spec = allowed[path.split("/").pop()];
  const validContentType = spec && (Array.isArray(spec[0])
    ? spec[0].includes(metadata.contentType)
    : metadata.contentType === spec[0]);
  const size = Number(metadata.size);
  if (!spec || !validContentType || !Number.isSafeInteger(size) || size <= 0 || size > spec[1]) {
    throw marketplace.statusError("The uploaded audio file is invalid.", 400);
  }
  if (typeof metadata.generation !== "string" || !/^\d+$/.test(metadata.generation)) {
    throw new Error("The audio file generation is unavailable.");
  }
  return metadata.generation;
}

async function verifyCover(bucketFactory, path) {
  const [metadata] = await bucketFactory().file(path).getMetadata();
  const allowed = {
    "cover.jpg": "image/jpeg",
    "cover.jpeg": "image/jpeg",
    "cover.png": "image/png",
    "cover.webp": "image/webp"
  };
  const contentType = allowed[path.split("/").pop()];
  const size = Number(metadata.size);
  if (!contentType || metadata.contentType !== contentType || !Number.isSafeInteger(size) || size <= 0 ||
      size > 10 * 1024 * 1024) {
    throw marketplace.statusError("The uploaded cover artwork is invalid.", 400);
  }
}

module.exports = createHandler();
module.exports.createHandler = createHandler;
