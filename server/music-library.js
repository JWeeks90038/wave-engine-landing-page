const { getStorage } = require("firebase-admin/storage");
const { database, firebaseApp } = require("./apparel-inventory");

function bucket() {
  if (!process.env.FIREBASE_STORAGE_BUCKET) throw new Error("FIREBASE_STORAGE_BUCKET is not configured.");
  return getStorage(firebaseApp()).bucket(process.env.FIREBASE_STORAGE_BUCKET);
}

function publicTrack(doc) {
  const data = doc.data();
  return {
    id: doc.id,
    title: data.title,
    artist: data.artist,
    album: data.album,
    description: data.description,
    genre: data.genre,
    releaseDate: data.releaseDate,
    duration: data.duration,
    sortOrder: data.sortOrder,
    hasCover: Boolean(data.coverStoragePath),
    hasMp3: Boolean(data.mp3StoragePath),
    hasWav: Boolean(data.wavStoragePath)
  };
}

function filePath(id, track, format) {
  const fields = { mp3: "mp3StoragePath", wav: "wavStoragePath", cover: "coverStoragePath" };
  const path = track[fields[format]];
  return typeof path === "string" && path.startsWith(`musicTracks/${id}/`) ? path : null;
}

function byteRange(header, size) {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2])) return false;
  let start;
  let end;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix < 1) return false;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || end < start) return false;
    end = Math.min(end, size - 1);
  }
  return { start, end };
}

function downloadName(track, format) {
  const label = `${track.artist || "Wave Engine"} - ${track.title || "Track"}`
    .replace(/[^a-zA-Z0-9 ._-]+/g, "").trim().slice(0, 120) || "Wave Engine - Track";
  return `${label}.${format}`;
}

module.exports = { bucket, database, publicTrack, filePath, byteRange, downloadName };
