const { readJsonBody, sendJson, setCorsHeaders } = require("./api-utils");
const marketplace = require("./artist-marketplace");
const { validId } = require("./artist-streaming");

function createHandler({
  database = marketplace.database,
  authenticate = marketplace.authenticate,
  bucket = marketplace.bucket,
  setArtistUploadClaim = marketplace.setArtistUploadClaim
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
    let reviewSaved = false;

    try {
      const admin = await authenticate(request, true);
      const db = database();
      if (request.method === "GET") {
        const type = new URL(request.url, "http://localhost").searchParams.get("type");
        if (type === "releases") {
          const [submitted, published] = await Promise.all([
            db.collection("artistReleases").where("status", "==", "submitted").get(),
            db.collection("artistReleases").where("status", "==", "published").get()
          ]);
          const releases = [];
          for (const entry of [...submitted.docs, ...published.docs]) {
            const release = entry.data();
            const artist = await db.collection("artists").doc(release.artistUid).get();
            releases.push({
              id: entry.id, title: release.title, genre: release.genre, status: release.status,
              artistName: artist.exists ? artist.data().artistName : "Artist unavailable",
              artistApproved: artist.exists && artist.data().status === "approved",
              rightsConfirmed: release.rightsConfirmed === true,
              downloadPriceCents: release.downloadPriceCents,
              salesRightsConfirmed: release.salesRightsConfirmed === true,
              submittedAt: timestampString(release.submittedAt)
            });
          }
          return sendJson(response, 200, { releases });
        }
        const snapshot = await db.collection("artists").where("status", "==", "pending").get();
        const artists = snapshot.docs.map((entry) => ({
          uid: entry.id,
          ...marketplace.profileResponse(entry.data()),
          createdAt: timestampString(entry.data().createdAt)
        }));
        return sendJson(response, 200, { artists });
      }

      const body = await readJsonBody(request);
      if (["approve-release", "reject-release", "unpublish-release"].includes(body.action)) {
        if (!validId(body.id)) return sendJson(response, 400, { error: "Invalid artist track request." });
        const releaseRef = db.collection("artistReleases").doc(body.id);
        const releaseSnapshot = await releaseRef.get();
        const release = releaseSnapshot.exists && releaseSnapshot.data();
        const expectedStatus = body.action === "unpublish-release" ? "published" : "submitted";
        if (!release || release.status !== expectedStatus) {
          return sendJson(response, 409, { error: "This track is no longer awaiting that action." });
        }
        if (body.action === "approve-release") {
          if (!validId(release.artistUid) || release.rightsConfirmed !== true ||
              typeof release.audioGeneration !== "string" || !/^\d+$/.test(release.audioGeneration)) {
            return sendJson(response, 409, { error: "This submission is missing required rights or audio information." });
          }
          if (release.downloadPriceCents != null && release.salesRightsConfirmed !== true) {
            return sendJson(response, 409, { error: "This submission is missing sales rights confirmation." });
          }
          marketplace.validateReleaseInput(release.artistUid, body.id, release);
          if (!release.audioPath) return sendJson(response, 409, { error: "This submission has no audio." });
          await bucket().file(release.audioPath, { generation: release.audioGeneration }).getMetadata();
        }
        await db.runTransaction(async (transaction) => {
          const current = await transaction.get(releaseRef);
          if (!current.exists || current.data().status !== expectedStatus ||
              current.data().artistUid !== release.artistUid ||
              current.data().audioPath !== release.audioPath ||
              current.data().audioGeneration !== release.audioGeneration ||
              current.data().downloadPriceCents !== release.downloadPriceCents ||
              current.data().salesRightsConfirmed !== release.salesRightsConfirmed ||
              (body.action === "approve-release" && current.data().rightsConfirmed !== true)) {
            throw marketplace.statusError("This track changed. Refresh and try again.", 409);
          }
          if (body.action === "approve-release") {
            const artist = await transaction.get(db.collection("artists").doc(release.artistUid));
            if (!artist.exists || artist.data().status !== "approved") {
              throw marketplace.statusError("The artist profile must be approved first.", 409);
            }
          }
          transaction.update(releaseRef, {
            status: body.action === "approve-release" ? "published" : "draft",
            ...(body.action === "approve-release" ? {} : { rightsConfirmed: false, salesRightsConfirmed: false }),
            reviewedAt: marketplace.FieldValue.serverTimestamp(), reviewedBy: admin.uid,
            updatedAt: marketplace.FieldValue.serverTimestamp()
          });
        });
        return sendJson(response, 200, { status: body.action === "approve-release" ? "published" : "draft" });
      }
      if (!["approve", "reject"].includes(body.action) ||
          typeof body.artistUid !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(body.artistUid)) {
        return sendJson(response, 400, { error: "Invalid artist review request." });
      }
      const artistRef = db.collection("artists").doc(body.artistUid);
      await db.runTransaction(async (transaction) => {
        const artistSnapshot = await transaction.get(artistRef);
        if (!artistSnapshot.exists || artistSnapshot.data().status !== "pending") {
          throw marketplace.statusError("This artist application is no longer pending.", 409);
        }
        const status = body.action === "approve" ? "approved" : "rejected";
        const slugRef = db.collection("artistSlugs").doc(artistSnapshot.data().slug);
        transaction.update(artistRef, {
          status,
          reviewedAt: marketplace.FieldValue.serverTimestamp(),
          reviewedBy: admin.uid
        });
        transaction.update(slugRef, { status });
      });
      reviewSaved = true;
      await setArtistUploadClaim(body.artistUid, body.action === "approve");
      return sendJson(response, 200, { status: body.action === "approve" ? "approved" : "rejected" });
    } catch (error) {
      if (error instanceof SyntaxError) return sendJson(response, 400, { error: "The request payload was invalid JSON." });
      console.error("Artist administration error:", error.message);
      return sendJson(response, error.statusCode || 503, {
        error: reviewSaved
          ? "Artist status was saved, but upload permissions could not be synchronized. Refresh the artist's upload claim before allowing uploads."
          : error.statusCode ? error.message : "The artist review could not be completed."
      });
    }
  };
}

function timestampString(value) {
  return value && typeof value.toDate === "function" ? value.toDate().toISOString() : "";
}

module.exports = createHandler();
module.exports.createHandler = createHandler;
