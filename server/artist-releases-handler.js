const { readJsonBody, sendJson, setCorsHeaders } = require("./api-utils");
const marketplace = require("./artist-marketplace");

function createHandler({
  database = marketplace.database,
  authenticate = marketplace.authenticate,
  bucket = marketplace.bucket
} = {}) {
  return async (request, response) => {
    if (request.method === "OPTIONS") {
      setCorsHeaders(response);
      response.writeHead(204);
      return response.end();
    }
    if (request.method !== "GET" && request.method !== "POST") {
      return sendJson(response, 405, { error: "Method not allowed." });
    }
    response.setHeader("Cache-Control", "private, no-store");

    try {
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
      if (fields.audioPath) await verifyAudio(bucket, fields.audioPath);
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
      if (error instanceof SyntaxError) return sendJson(response, 400, { error: "The request payload was invalid JSON." });
      console.error("Artist draft error:", error.message);
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
  if (!spec || !validContentType || Number(metadata.size) <= 0 || Number(metadata.size) > spec[1]) {
    throw marketplace.statusError("The uploaded audio file is invalid.", 400);
  }
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
  if (!contentType || metadata.contentType !== contentType || Number(metadata.size) <= 0 ||
      Number(metadata.size) > 10 * 1024 * 1024) {
    throw marketplace.statusError("The uploaded cover artwork is invalid.", 400);
  }
}

module.exports = createHandler();
module.exports.createHandler = createHandler;
