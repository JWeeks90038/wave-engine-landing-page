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
      const slug = marketplace.validateSlug(params.get("slug"));
      const asset = params.get("asset");
      if (!["avatar", "banner"].includes(asset)) {
        return sendJson(response, 400, { error: "Invalid artist image request." });
      }
      const db = database();
      const slugDoc = await db.collection("artistSlugs").doc(slug).get();
      if (!slugDoc.exists || slugDoc.data().status !== "approved") {
        return sendJson(response, 404, { error: "Artist image not found." });
      }
      const artistSnapshot = await db.collection("artists").doc(slugDoc.data().artistUid).get();
      if (!artistSnapshot.exists || artistSnapshot.data().status !== "approved") {
        return sendJson(response, 404, { error: "Artist image not found." });
      }
      const artist = artistSnapshot.data();
      const path = asset === "avatar" ? artist.avatarPath : artist.bannerPath;
      const fileName = asset === "avatar" ? "avatar" : "banner";
      const pathPattern = new RegExp(
        `^artistUploads/${artistSnapshot.id}/profile-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/${fileName}\\.(?:jpg|jpeg|png|webp)$`
      );
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
