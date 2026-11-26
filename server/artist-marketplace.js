const crypto = require("crypto");
const { getAuth } = require("firebase-admin/auth");
const { getStorage } = require("firebase-admin/storage");
const { FieldValue } = require("firebase-admin/firestore");
const { database, firebaseApp } = require("./apparel-inventory");

const RESERVED_SLUGS = new Set([
  "about", "account", "admin", "api", "apparel", "artist", "artists", "blog", "contact",
  "discover", "legal", "login", "music", "music-admin", "new", "register", "stream"
]);
const MOODS = new Set([
  "adventurous", "cinematic", "emotional", "energized", "focused", "inspired",
  "motivated", "nostalgic", "peaceful", "relaxed", "romantic"
]);
const UUID_PATTERN = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

function bucket() {
  if (!process.env.FIREBASE_STORAGE_BUCKET) throw new Error("FIREBASE_STORAGE_BUCKET is not configured.");
  return getStorage(firebaseApp()).bucket(process.env.FIREBASE_STORAGE_BUCKET);
}

function statusError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

async function authenticate(request, adminOnly = false) {
  const match = /^Bearer ([^\s]+)$/.exec(request.headers.authorization || "");
  if (!match) throw statusError("Sign in to continue.", 401);

  let token;
  try {
    token = await getAuth(firebaseApp()).verifyIdToken(match[1], true);
  } catch (cause) {
    if (["auth/argument-error", "auth/invalid-id-token", "auth/id-token-expired",
      "auth/id-token-revoked", "auth/user-disabled", "auth/user-not-found"].includes(cause.code)) {
      throw statusError("Your session is invalid or expired. Sign in again.", 401);
    }
    throw cause;
  }

  if (adminOnly && token.admin !== true) throw statusError("Administrator access is required.", 403);
  if (!adminOnly && token.email_verified !== true) {
    throw statusError("Verify your email address before creating an artist account.", 403);
  }
  return token;
}

async function setArtistUploadClaim(uid, enabled, auth = getAuth(firebaseApp())) {
  const user = await auth.getUser(uid);
  const claims = { ...(user.customClaims || {}) };
  if (enabled) claims.artistUpload = true;
  else delete claims.artistUpload;
  await auth.setCustomUserClaims(uid, claims);
}

function validateSlug(value) {
  if (typeof value !== "string") throw statusError("Choose a valid artist URL.", 400);
  const slug = value.trim().toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]{1,28}[a-z0-9])$/.test(slug) || RESERVED_SLUGS.has(slug)) {
    throw statusError("Use 3–30 lowercase letters, numbers, or hyphens for the artist URL.", 400);
  }
  return slug;
}

function validateArtistName(value) {
  if (typeof value !== "string") throw statusError("Enter an artist name.", 400);
  const name = value.trim();
  if (!name || name.length > 100) throw statusError("Artist names must be 1–100 characters.", 400);
  return name;
}

function validateBiography(value) {
  if (typeof value !== "string") throw statusError("Enter an artist biography.", 400);
  const biography = value.trim();
  if (biography.length > 2000) throw statusError("Artist biographies must be 2,000 characters or fewer.", 400);
  return biography;
}

function validateSocialLinks(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw statusError("Enter valid social links.", 400);
  }
  const keys = ["website", "instagram", "youtube", "tiktok"];
  if (Object.keys(value).some((key) => !keys.includes(key))) {
    throw statusError("Only website, Instagram, YouTube, and TikTok links are supported.", 400);
  }
  const result = {};
  for (const key of keys) {
    const raw = value[key];
    if (raw === undefined || raw === "") continue;
    if (typeof raw !== "string" || raw.length > 300) throw statusError("Social links must be 300 characters or fewer.", 400);
    let url;
    try { url = new URL(raw); }
    catch { throw statusError("Social links must be valid HTTPS URLs.", 400); }
    if (url.protocol !== "https:" || url.username || url.password) {
      throw statusError("Social links must be valid HTTPS URLs.", 400);
    }
    result[key] = url.href;
  }
  return result;
}

function validateBannerPosition(value) {
  if (value === undefined || value === null) return 50;
  if (!Number.isInteger(value) || value < 0 || value > 100) {
    throw statusError("Banner position must be a whole number from 0 to 100.", 400);
  }
  return value;
}

function validateProfileAssetPath(uid, asset, value) {
  if (value === undefined || value === "") return "";
  if (typeof value !== "string") throw statusError("Invalid profile image.", 400);
  const allowedNames = asset === "avatar" ? "avatar" : "banner";
  const pattern = new RegExp(
    `^artistUploads/${escapeRegExp(uid)}/profile-${UUID_PATTERN}/${allowedNames}\\.(?:jpg|jpeg|png|webp)$`
  );
  if (!pattern.test(value)) throw statusError("Invalid profile image.", 400);
  return value;
}

function validateReleaseInput(uid, releaseId, body) {
  if (typeof body.title !== "string" || !body.title.trim() || body.title.trim().length > 160) {
    throw statusError("Release titles must be 1–160 characters.", 400);
  }
  if (typeof body.description !== "string" || body.description.length > 2000) {
    throw statusError("Descriptions must be 2,000 characters or fewer.", 400);
  }
  if (typeof body.genre !== "string" || body.genre.trim().length > 80) {
    throw statusError("Genres must be 80 characters or fewer.", 400);
  }
  if (body.releaseType !== "single") throw statusError("Single-track drafts are supported in this phase.", 400);
  if (!Array.isArray(body.moods) || body.moods.length > 5 ||
      body.moods.some((mood) => typeof mood !== "string" || !MOODS.has(mood))) {
    throw statusError("Choose up to five supported moods.", 400);
  }
  if (body.downloadPriceCents !== undefined && body.downloadPriceCents !== null &&
      (!Number.isSafeInteger(body.downloadPriceCents) || body.downloadPriceCents < 50 || body.downloadPriceCents > 10000)) {
    throw statusError("Download prices must be between $0.50 and $100.00.", 400);
  }
  const uploadPrefix = `^artistUploads/${escapeRegExp(uid)}/${escapeRegExp(releaseId)}-${UUID_PATTERN}/`;
  const audioPath = body.audioPath || "";
  const coverPath = body.coverPath || "";
  const validPath = (value, names) => value === "" ||
    (typeof value === "string" && new RegExp(`${uploadPrefix}${names}$`).test(value));
  if (!validPath(audioPath, "audio\\.(?:mp3|wav)")) {
    throw statusError("Upload an MP3 or WAV audio file to this draft.", 400);
  }
  if (!validPath(coverPath, "cover\\.(?:jpg|jpeg|png|webp)")) {
    throw statusError("Upload valid cover artwork to this draft.", 400);
  }
  return {
    title: body.title.trim(),
    description: body.description.trim(),
    genre: body.genre.trim(),
    releaseType: body.releaseType,
    moods: [...new Set(body.moods)],
    downloadPriceCents: body.downloadPriceCents === undefined ? null : body.downloadPriceCents,
    audioPath,
    coverPath
  };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function profileResponse(profile) {
  const assetUrl = (asset, path) => path
    ? `/api/artist-media?slug=${encodeURIComponent(profile.slug)}&asset=${asset}&v=${crypto.createHash("sha256").update(path).digest("hex").slice(0, 12)}`
    : "";
  return {
    artistName: profile.artistName,
    slug: profile.slug,
    biography: profile.biography,
    socialLinks: profile.socialLinks || {},
    status: profile.status,
    avatarUrl: assetUrl("avatar", profile.avatarPath),
    bannerUrl: assetUrl("banner", profile.bannerPath),
    bannerPositionY: Number.isInteger(profile.bannerPositionY) ? profile.bannerPositionY : 50
  };
}

module.exports = {
  FieldValue,
  MOODS,
  authenticate,
  bucket,
  database,
  profileResponse,
  setArtistUploadClaim,
  statusError,
  validateArtistName,
  validateBiography,
  validateBannerPosition,
  validateProfileAssetPath,
  validateReleaseInput,
  validateSlug,
  validateSocialLinks
};
