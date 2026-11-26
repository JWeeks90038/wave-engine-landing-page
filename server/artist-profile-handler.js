const { readJsonBody, sendJson, setCorsHeaders } = require("./api-utils");
const marketplace = require("./artist-marketplace");

function createHandler({
  database = marketplace.database,
  bucket = marketplace.bucket,
  authenticate = marketplace.authenticate,
  setArtistUploadClaim = marketplace.setArtistUploadClaim,
  profileResponse = marketplace.profileResponse
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
    response.setHeader("Cache-Control", "no-store");

    try {
      if (request.method === "GET") {
        const params = new URL(request.url, "http://localhost").searchParams;
        if (params.get("me") === "1") {
          const user = await authenticate(request);
          const db = database();
          const doc = await db.collection("artists").doc(user.uid).get();
          if (!doc.exists) return sendJson(response, 404, { error: "No artist profile is registered for this account." });
          const profile = doc.data();
          const shouldHaveClaim = ["pending", "approved"].includes(profile.status);
          const tokenRefreshRequired = Boolean(user.artistUpload) !== shouldHaveClaim;
          if (tokenRefreshRequired) await setArtistUploadClaim(user.uid, shouldHaveClaim);
          return sendJson(response, 200, {
            profile: profileResponse(profile),
            tokenRefreshRequired
          });
        }

        const slug = marketplace.validateSlug(params.get("slug"));
        const db = database();
        const slugDoc = await db.collection("artistSlugs").doc(slug).get();
        if (!slugDoc.exists || slugDoc.data().status !== "approved") {
          return sendJson(response, 404, { error: "Artist profile not found." });
        }
        const artistDoc = await db.collection("artists").doc(slugDoc.data().artistUid).get();
        if (!artistDoc.exists || artistDoc.data().status !== "approved") {
          return sendJson(response, 404, { error: "Artist profile not found." });
        }
        return sendJson(response, 200, { profile: profileResponse(artistDoc.data()) });
      }

      const user = await authenticate(request);
      const db = database();
      const body = await readJsonBody(request);
      const action = body.action;
      if (action !== "create" && action !== "update") {
        return sendJson(response, 400, { error: "Choose a valid profile action." });
      }
      const artistRef = db.collection("artists").doc(user.uid);

      if (action === "create") {
        const artistName = marketplace.validateArtistName(body.artistName);
        const slug = marketplace.validateSlug(body.slug);
        const biography = marketplace.validateBiography(body.biography || "");
        const socialLinks = marketplace.validateSocialLinks(body.socialLinks || {});
        const avatarPath = marketplace.validateProfileAssetPath(user.uid, "avatar", body.avatarPath);
        const bannerPath = marketplace.validateProfileAssetPath(user.uid, "banner", body.bannerPath);
        const bannerPositionY = marketplace.validateBannerPosition(body.bannerPositionY);
        if (avatarPath) await verifyProfileImage(bucket, avatarPath);
        if (bannerPath) await verifyProfileImage(bucket, bannerPath);
        const slugRef = db.collection("artistSlugs").doc(slug);
        await db.runTransaction(async (transaction) => {
          const existingArtist = await transaction.get(artistRef);
          const existingSlug = await transaction.get(slugRef);
          if (existingArtist.exists) throw marketplace.statusError("An artist profile already exists for this account.", 409);
          if (existingSlug.exists) throw marketplace.statusError("That artist URL is already in use.", 409);
          transaction.create(artistRef, {
            artistName, slug, biography, socialLinks, avatarPath, bannerPath, bannerPositionY,
            status: "pending", createdAt: marketplace.FieldValue.serverTimestamp(),
            updatedAt: marketplace.FieldValue.serverTimestamp()
          });
          transaction.create(slugRef, { artistUid: user.uid, status: "pending" });
        });
        await setArtistUploadClaim(user.uid, true);
        return sendJson(response, 201, { profile: profileResponse({
          artistName, slug, biography, socialLinks, avatarPath, bannerPath, bannerPositionY, status: "pending"
        }), tokenRefreshRequired: true });
      }

      const artistName = marketplace.validateArtistName(body.artistName);
      const biography = marketplace.validateBiography(body.biography || "");
      const socialLinks = marketplace.validateSocialLinks(body.socialLinks || {});
      const avatarPath = marketplace.validateProfileAssetPath(user.uid, "avatar", body.avatarPath);
      const bannerPath = marketplace.validateProfileAssetPath(user.uid, "banner", body.bannerPath);
      const bannerPositionY = marketplace.validateBannerPosition(body.bannerPositionY);
      if (avatarPath) await verifyProfileImage(bucket, avatarPath);
      if (bannerPath) await verifyProfileImage(bucket, bannerPath);
      let updatedProfile;
      let cleanupPaths = [];
      await db.runTransaction(async (transaction) => {
        const existing = await transaction.get(artistRef);
        if (!existing.exists) throw marketplace.statusError("Create an artist profile before editing it.", 404);
        const current = existing.data();
        if (["rejected", "suspended"].includes(current.status)) {
          throw marketplace.statusError("This artist profile cannot be edited. Contact Wave Engine support.", 403);
        }
        const keptPosition = body.bannerPositionY === undefined && Number.isInteger(current.bannerPositionY)
          ? current.bannerPositionY : bannerPositionY;
        updatedProfile = {
          ...current, artistName, biography, socialLinks, bannerPositionY: keptPosition,
          avatarPath: avatarPath || current.avatarPath || "",
          bannerPath: bannerPath || current.bannerPath || ""
        };
        cleanupPaths = [
          avatarPath && current.avatarPath && avatarPath !== current.avatarPath ? current.avatarPath : "",
          bannerPath && current.bannerPath && bannerPath !== current.bannerPath ? current.bannerPath : ""
        ].filter(Boolean);
        transaction.update(artistRef, {
          artistName, biography, socialLinks, bannerPositionY: keptPosition,
          ...(avatarPath ? { avatarPath } : {}),
          ...(bannerPath ? { bannerPath } : {}),
          updatedAt: marketplace.FieldValue.serverTimestamp()
        });
      });
      return sendJson(response, 200, {
        profile: profileResponse(updatedProfile),
        cleanupPaths
      });
    } catch (error) {
      if (error instanceof SyntaxError) return sendJson(response, 400, { error: "The request payload was invalid JSON." });
      console.error("Artist profile error:", error.message);
      return sendJson(response, error.statusCode || 503, {
        error: error.statusCode ? error.message : "The artist profile could not be saved."
      });
    }
  };
}

async function verifyProfileImage(bucketFactory, path) {
  let metadata;
  try {
    [metadata] = await bucketFactory().file(path).getMetadata();
  } catch (error) {
    if (error.code === 404 || error.code === "404") {
      throw marketplace.statusError("The uploaded profile image could not be found.", 400);
    }
    throw error;
  }
  if (!["image/jpeg", "image/png", "image/webp"].includes(metadata.contentType) ||
      Number(metadata.size) <= 0 || Number(metadata.size) > 10 * 1024 * 1024) {
    throw marketplace.statusError("The uploaded profile image is invalid.", 400);
  }
}

module.exports = createHandler();
module.exports.createHandler = createHandler;
