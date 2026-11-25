const { readJsonBody, sendJson, setCorsHeaders } = require("./api-utils");
const marketplace = require("./artist-marketplace");

function createHandler({
  database = marketplace.database,
  authenticate = marketplace.authenticate,
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
        const snapshot = await db.collection("artists").where("status", "==", "pending").get();
        const artists = snapshot.docs.map((entry) => ({
          uid: entry.id,
          ...marketplace.profileResponse(entry.data()),
          createdAt: timestampString(entry.data().createdAt)
        }));
        return sendJson(response, 200, { artists });
      }

      const body = await readJsonBody(request);
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
