const fs = require("fs");
const path = require("path");
const { readJsonBody, sendJson, setCorsHeaders } = require("./api-utils");
const marketplace = require("./artist-marketplace");

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[character]);
}

function siteOrigin() {
  const url = new URL(process.env.MUSIC_SITE_URL || "https://waveenginemusic.com");
  if (url.username || url.password || url.search || url.hash ||
      (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) {
    throw new Error("MUSIC_SITE_URL must be an HTTPS site URL or a localhost URL.");
  }
  return url.origin;
}

function sendProfilePage(response, profile, { head = false, status = 200 } = {}) {
  const template = fs.readFileSync(path.join(__dirname, "..", "artist.html"), "utf8");
  const marker = /<!-- artist-meta:start -->[\s\S]*?<!-- artist-meta:end -->/;
  if (!marker.test(template)) throw new Error("The artist page metadata template is missing.");
  const origin = siteOrigin();
  const title = profile ? `${profile.artistName} | Wave Engine Music` : "Independent Artist | Wave Engine Music";
  const description = profile
    ? (profile.biography || `Discover ${profile.artistName} on Wave Engine Music.`).replace(/\s+/g, " ").trim().slice(0, 200)
    : "Discover independent artists on Wave Engine Music.";
  const image = new URL(profile && profile.avatarUrl ? profile.avatarUrl : "/Images/wave-engine-social-card-4k-v1.png", origin).href;
  const imageAlt = profile && profile.avatarUrl ? `${profile.artistName} profile image` : "Wave Engine Music";
  const canonical = profile ? new URL(`/artist/${encodeURIComponent(profile.slug)}`, origin).href : "";
  const metadata = [
    `<title>${escapeHtml(title)}</title>`,
    `<meta name="description" content="${escapeHtml(description)}" />`,
    '<meta property="og:type" content="profile" />',
    `<meta property="og:title" content="${escapeHtml(title)}" />`,
    `<meta property="og:description" content="${escapeHtml(description)}" />`,
    `<meta property="og:image" content="${escapeHtml(image)}" />`,
    `<meta property="og:image:alt" content="${escapeHtml(imageAlt)}" />`,
    '<meta name="twitter:card" content="summary" />',
    `<meta name="twitter:title" content="${escapeHtml(title)}" />`,
    `<meta name="twitter:description" content="${escapeHtml(description)}" />`,
    `<meta name="twitter:image" content="${escapeHtml(image)}" />`,
    `<meta name="twitter:image:alt" content="${escapeHtml(imageAlt)}" />`,
    ...(canonical ? [`<meta property="og:url" content="${escapeHtml(canonical)}" />`,
      `<link rel="canonical" href="${escapeHtml(canonical)}" />`] : ['<meta name="robots" content="noindex" />'])
  ].join("\n    ");
  let html = template.replace(marker, () => metadata);
  if (!profile) html = html.replace("Loading artist profile...", "Artist profile not found.");
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.setHeader("Content-Length", String(Buffer.byteLength(html)));
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.writeHead(status);
  return response.end(head ? undefined : html);
}

function createHandler({
  database = marketplace.database,
  bucket = marketplace.bucket,
  authenticate = marketplace.authenticate,
  setArtistUploadClaim = marketplace.setArtistUploadClaim,
  profileResponse = marketplace.profileResponse
} = {}) {
  return async (request, response) => {
    const params = new URL(request.url, "http://localhost").searchParams;
    const page = params.get("page") === "1";
    const head = request.method === "HEAD";
    if (request.method === "OPTIONS") {
      setCorsHeaders(response);
      response.writeHead(204);
      return response.end();
    }
    if (request.method !== "GET" && request.method !== "POST" && !(head && page)) {
      return sendJson(response, 405, { error: "Method not allowed." });
    }
    response.setHeader("Cache-Control", "no-store");

    try {
      if (request.method === "GET" || head) {
        if (params.get("me") === "1" && !page) {
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
          if (page) return sendProfilePage(response, null, { head, status: 404 });
          return sendJson(response, 404, { error: "Artist profile not found." });
        }
        const artistDoc = await db.collection("artists").doc(slugDoc.data().artistUid).get();
        if (!artistDoc.exists || artistDoc.data().status !== "approved" || artistDoc.data().slug !== slug) {
          if (page) return sendProfilePage(response, null, { head, status: 404 });
          return sendJson(response, 404, { error: "Artist profile not found." });
        }
        const profile = profileResponse(artistDoc.data());
        if (page) return sendProfilePage(response, profile, { head });
        return sendJson(response, 200, { profile });
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
      if (page && (request.method === "GET" || head) && error.statusCode === 400) {
        return sendProfilePage(response, null, { head, status: 404 });
      }
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
