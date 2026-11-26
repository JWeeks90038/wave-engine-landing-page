const { sendJson, setCorsHeaders } = require("./api-utils");
const marketplace = require("./artist-marketplace");

function createHandler({
  database = marketplace.database,
  bucket = marketplace.bucket
} = {}) {
  return async (request, response) => {
    if (request.method === "OPTIONS") {
      setCorsHeaders(response);
      response.writeHead(204);
      return response.end();
    }
    if (request.method !== "GET") return sendJson(response, 405, { error: "Method not allowed." });
    const params = new URL(request.url, "http://localhost").searchParams;

    try {
      const asset = params.get("asset");
      if (!["avatar", "banner", "cover"].includes(asset)) {
        return sendJson(response, 400, { error: "Invalid artist image request." });
      }
      const db = database();
      const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
      let path;
      let pathPattern;
      if (asset === "cover") {
        const id = params.get("release");
        if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) {
          return sendJson(response, 400, { error: "Invalid artist image request." });
        }
        const releaseSnapshot = await db.collection("artistReleases").doc(id).get();
        const release = releaseSnapshot.exists && releaseSnapshot.data();
        if (!release || release.status !== "published" || release.rightsConfirmed !== true ||
            typeof release.artistUid !== "string") {
          return sendJson(response, 404, { error: "Artist image not found." });
        }
        const owner = await db.collection("artists").doc(release.artistUid).get();
        if (!owner.exists || owner.data().status !== "approved") {
          return sendJson(response, 404, { error: "Artist image not found." });
        }
        const ownerSlug = await db.collection("artistSlugs").doc(owner.data().slug).get();
        if (!ownerSlug.exists || ownerSlug.data().status !== "approved" ||
            ownerSlug.data().artistUid !== release.artistUid) {
          return sendJson(response, 404, { error: "Artist image not found." });
        }
        path = release.coverPath;
        pathPattern = new RegExp(
          `^artistUploads/${release.artistUid}/${id}-${uuid}/cover\\.(?:jpg|jpeg|png|webp)$`
        );
      } else {
        const slug = marketplace.validateSlug(params.get("slug"));
        const slugDoc = await db.collection("artistSlugs").doc(slug).get();
        if (!slugDoc.exists || slugDoc.data().status !== "approved") {
          return sendJson(response, 404, { error: "Artist image not found." });
        }
        const artistSnapshot = await db.collection("artists").doc(slugDoc.data().artistUid).get();
        if (!artistSnapshot.exists || artistSnapshot.data().status !== "approved") {
          return sendJson(response, 404, { error: "Artist image not found." });
        }
        const artist = artistSnapshot.data();
        path = asset === "avatar" ? artist.avatarPath : artist.bannerPath;
        pathPattern = new RegExp(
          `^artistUploads/${artistSnapshot.id}/profile-${uuid}/${asset}\\.(?:jpg|jpeg|png|webp)$`
        );
      }
      if (typeof path !== "string" || !pathPattern.test(path)) {
        return sendJson(response, 404, { error: "Artist image not found." });
      }

      const file = bucket().file(path);
      const [metadata] = await file.getMetadata();
      if (!["image/jpeg", "image/png", "image/webp"].includes(metadata.contentType) ||
          !Number.isSafeInteger(Number(metadata.size)) || Number(metadata.size) <= 0 ||
          Number(metadata.size) > 10 * 1024 * 1024) {
        throw new Error("Invalid artist image metadata.");
      }
      response.setHeader("Cache-Control", "public, max-age=300");
      response.setHeader("Content-Type", metadata.contentType);
      response.setHeader("Content-Length", String(metadata.size));
      response.setHeader("X-Content-Type-Options", "nosniff");
      response.writeHead(200);
      await new Promise((resolve, reject) => {
        const source = file.createReadStream();
        source.on("error", reject);
        response.on("close", () => { source.destroy(); resolve(); });
        response.on("finish", resolve);
        source.pipe(response);
      });
    } catch (error) {
      if (response.headersSent) return response.destroy(error);
      if (error.statusCode) return sendJson(response, error.statusCode, { error: error.message });
      if (error.code === 404 || error.code === "404") return sendJson(response, 404, { error: "Artist image not found." });
      console.error("Artist media error:", error.message);
      return sendJson(response, 503, { error: "The artist image could not be loaded." });
    }
  };
}

module.exports = createHandler();
module.exports.createHandler = createHandler;
