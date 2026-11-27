const { sendJson, setCorsHeaders } = require("./api-utils");
const marketplace = require("./artist-marketplace");
const sharp = require("sharp");

async function createShareImage(file) {
  const [input] = await file.download();
  const mask = Buffer.from('<svg width="560" height="560" xmlns="http://www.w3.org/2000/svg"><circle cx="280" cy="280" r="280" fill="#fff"/></svg>');
  const avatar = await sharp(input, { limitInputPixels: 40000000, sequentialRead: true })
    .rotate().resize(560, 560, { fit: "cover" })
    .composite([{ input: mask, blend: "dest-in" }]).png().toBuffer();
  return sharp({ create: { width: 1200, height: 630, channels: 3, background: "#101a2d" } })
    .composite([{ input: avatar, left: 320, top: 35 }]).jpeg({ quality: 85 }).toBuffer();
}

function createHandler({
  database = marketplace.database,
  bucket = marketplace.bucket,
  authenticate = marketplace.authenticate
} = {}) {
  return async (request, response) => {
    if (request.method === "OPTIONS") {
      setCorsHeaders(response);
      response.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
      response.writeHead(204);
      return response.end();
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      return sendJson(response, 405, { error: "Method not allowed." });
    }
    const params = new URL(request.url, "http://localhost").searchParams;

    try {
      const asset = params.get("asset");
      if (!["avatar", "banner", "background", "gallery", "cover"].includes(asset)) {
        return sendJson(response, 400, { error: "Invalid artist image request." });
      }
      const preview = params.get("preview");
      if (preview !== null && !["owner", "review"].includes(preview)) {
        return sendJson(response, 400, { error: "Invalid artist image request." });
      }
      const variant = params.get("variant");
      if (variant !== null && (variant !== "share" || asset !== "avatar" || preview)) {
        return sendJson(response, 400, { error: "Invalid artist image request." });
      }
      if (preview) response.setHeader("Cache-Control", "private, no-store");
      const user = preview ? await authenticate(request, preview === "review") : null;
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
        if (!release || typeof release.artistUid !== "string") {
          return sendJson(response, 404, { error: "Artist image not found." });
        }
        if (preview === "review") {
          if (!["submitted", "published"].includes(release.status)) {
            return sendJson(response, 404, { error: "Artist image not found." });
          }
        } else {
          const owner = await db.collection("artists").doc(release.artistUid).get();
          if (preview === "owner") {
            if (user.uid !== release.artistUid || !owner.exists ||
                !["pending", "approved"].includes(owner.data().status) ||
                !["draft", "submitted", "published"].includes(release.status)) {
              return sendJson(response, 404, { error: "Artist image not found." });
            }
          } else {
            if (release.status !== "published" || release.rightsConfirmed !== true ||
                !owner.exists || owner.data().status !== "approved") {
              return sendJson(response, 404, { error: "Artist image not found." });
            }
            const ownerSlug = await db.collection("artistSlugs").doc(owner.data().slug).get();
            if (!ownerSlug.exists || ownerSlug.data().status !== "approved" ||
                ownerSlug.data().artistUid !== release.artistUid) {
              return sendJson(response, 404, { error: "Artist image not found." });
            }
          }
        }
        path = release.coverPath;
        const ownerPattern = release.artistUid.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        pathPattern = new RegExp(
          `^artistUploads/${ownerPattern}/${id}-${uuid}/cover\\.(?:jpg|jpeg|png|webp)$`
        );
      } else {
        const slug = marketplace.validateSlug(params.get("slug"));
        let artistSnapshot;
        if (preview === "owner") {
          artistSnapshot = await db.collection("artists").doc(user.uid).get();
          if (!artistSnapshot.exists || !["pending", "approved"].includes(artistSnapshot.data().status)) {
            return sendJson(response, 404, { error: "Artist image not found." });
          }
        } else if (preview === "review") {
          const slugDoc = await db.collection("artistSlugs").doc(slug).get();
          if (!slugDoc.exists || slugDoc.data().status !== "pending") {
            return sendJson(response, 404, { error: "Artist image not found." });
          }
          artistSnapshot = await db.collection("artists").doc(slugDoc.data().artistUid).get();
          if (!artistSnapshot.exists || artistSnapshot.data().status !== "pending") {
            return sendJson(response, 404, { error: "Artist image not found." });
          }
        } else {
          const slugDoc = await db.collection("artistSlugs").doc(slug).get();
          if (!slugDoc.exists || slugDoc.data().status !== "approved") {
            return sendJson(response, 404, { error: "Artist image not found." });
          }
          artistSnapshot = await db.collection("artists").doc(slugDoc.data().artistUid).get();
          if (!artistSnapshot.exists || artistSnapshot.data().status !== "approved") {
            return sendJson(response, 404, { error: "Artist image not found." });
          }
        }
        const artist = artistSnapshot.data();
        if (artist.slug !== slug) {
          return sendJson(response, 404, { error: "Artist image not found." });
        }
        if (asset === "background" || asset === "gallery") {
          const imageId = params.get("id");
          const paths = asset === "background" ? artist.backgroundPaths : artist.galleryPaths;
          path = Array.isArray(paths) && /^[a-f0-9]{64}$/.test(imageId || "")
            ? paths.find((entry) => typeof entry === "string" && marketplace.profileImageId(entry) === imageId) : "";
        } else {
          path = asset === "avatar" ? artist.avatarPath : artist.bannerPath;
        }
        try {
          marketplace.validateProfileAssetPath(artistSnapshot.id, asset, path);
        } catch (error) {
          if (error.statusCode === 400) return sendJson(response, 404, { error: "Artist image not found." });
          throw error;
        }
      }
      if (typeof path !== "string" || !path || (pathPattern && !pathPattern.test(path))) {
        return sendJson(response, 404, { error: "Artist image not found." });
      }

      const file = bucket().file(path);
      const [metadata] = await file.getMetadata();
      if (!["image/jpeg", "image/png", "image/webp"].includes(metadata.contentType) ||
          !Number.isSafeInteger(Number(metadata.size)) || Number(metadata.size) <= 0 ||
          Number(metadata.size) > 10 * 1024 * 1024) {
        throw new Error("Invalid artist image metadata.");
      }
      const shareImage = variant === "share" ? await createShareImage(file) : null;
      setCorsHeaders(response);
      response.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
      response.setHeader("Cache-Control", preview ? "private, no-store" : "public, max-age=300");
      response.setHeader("Content-Type", shareImage ? "image/jpeg" : metadata.contentType);
      response.setHeader("Content-Length", String(shareImage ? shareImage.length : metadata.size));
      response.setHeader("X-Content-Type-Options", "nosniff");
      response.writeHead(200);
      if (request.method === "HEAD") return response.end();
      if (shareImage) return response.end(shareImage);
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
