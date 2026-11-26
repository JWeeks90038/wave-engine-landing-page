const crypto = require("crypto");
const { sendJson, setCorsHeaders } = require("./api-utils");
const { byteRange } = require("./music-library");
const marketplace = require("./artist-marketplace");

function validId(id) {
  return typeof id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(id);
}

async function publicArtists(db) {
  const [profiles, releases] = await Promise.all([
    db.collection("artists").where("status", "==", "approved").get(),
    db.collection("artistReleases").where("status", "==", "published").get()
  ]);
  const tracksByArtist = new Map();
  const albumsByArtist = new Map();
  for (const entry of releases.docs) {
    const release = entry.data();
    if (release.releaseType === "album") {
      if (release.rightsConfirmed !== true || !Array.isArray(release.tracks) || !release.tracks.length ||
          release.tracks.length > 20 || !release.coverPath) continue;
      try { marketplace.validateReleaseInput(release.artistUid, entry.id, release); }
      catch (error) {
        if (error.statusCode === 400) {
          console.error("Invalid published album:", entry.id, error.message);
          continue;
        }
        throw error;
      }
      const tracks = marketplace.releaseAudio(release);
      if (tracks.some((track) => typeof track.audioGeneration !== "string" || !/^\d+$/.test(track.audioGeneration))) continue;
      if (!albumsByArtist.has(release.artistUid)) albumsByArtist.set(release.artistUid, []);
      albumsByArtist.get(release.artistUid).push({
        id: entry.id, title: release.title, genre: release.genre, saleMode: release.saleMode,
        downloadPriceCents: release.salesRightsConfirmed === true && ["album", "both"].includes(release.saleMode) ? release.downloadPriceCents : null,
        coverUrl: `/api/artist-media?release=${encodeURIComponent(entry.id)}&asset=cover&v=${crypto.createHash("sha256").update(release.coverPath).digest("hex").slice(0, 12)}`,
        tracks: tracks.map((track) => ({
          id: entry.id, trackId: track.id, title: track.title, genre: release.genre,
          downloadPriceCents: release.salesRightsConfirmed === true && ["tracks", "both"].includes(release.saleMode) ? track.downloadPriceCents : null,
          format: track.audioPath.endsWith(".wav") ? "WAV" : "MP3"
        }))
      });
      continue;
    }
    if (release.rightsConfirmed !== true || typeof release.audioGeneration !== "string" ||
        !/^\d+$/.test(release.audioGeneration)) continue;
    if (!tracksByArtist.has(release.artistUid)) tracksByArtist.set(release.artistUid, []);
    const price = release.salesRightsConfirmed === true && Number.isSafeInteger(release.downloadPriceCents) &&
      release.downloadPriceCents >= 50 && release.downloadPriceCents <= 10000
      ? release.downloadPriceCents : null;
    tracksByArtist.get(release.artistUid).push({
      id: entry.id, title: release.title, genre: release.genre, downloadPriceCents: price,
      coverUrl: typeof release.coverPath === "string" && release.coverPath
        ? `/api/artist-media?release=${encodeURIComponent(entry.id)}&asset=cover&v=${crypto.createHash("sha256").update(release.coverPath).digest("hex").slice(0, 12)}`
        : "",
      format: typeof release.audioPath === "string" && release.audioPath.endsWith(".wav") ? "WAV" : "MP3"
    });
  }
  const artists = [];
  for (const doc of profiles.docs) {
    const profile = doc.data();
    const slug = marketplace.validateSlug(profile.slug);
    const slugDoc = await db.collection("artistSlugs").doc(slug).get();
    if (!slugDoc.exists || slugDoc.data().status !== "approved" || slugDoc.data().artistUid !== doc.id) continue;
    const salesAvailable = process.env.ARTIST_SALES_ENABLED === "true" &&
      profile[process.env.MUSIC_STRIPE_MODE === "test" ? "stripeConnectTest" : "stripeConnectLive"];
    artists.push({
      artistName: profile.artistName,
      slug,
      avatarUrl: marketplace.profileResponse(profile).avatarUrl,
      tracks: (tracksByArtist.get(doc.id) || []).map((track) => ({
        ...track,
        downloadPriceCents: salesAvailable ? track.downloadPriceCents : null
      })),
      albums: (albumsByArtist.get(doc.id) || []).map((album) => ({
        ...album, downloadPriceCents: salesAvailable ? album.downloadPriceCents : null,
        tracks: album.tracks.map((track) => ({ ...track, downloadPriceCents: salesAvailable ? track.downloadPriceCents : null }))
      }))
    });
  }
  return artists.sort((a, b) => a.artistName.localeCompare(b.artistName));
}

async function streamRelease(request, response, { db, bucket, authenticate, review }) {
  const params = new URL(request.url, "http://localhost").searchParams;
  const id = params.get("id");
  if (!validId(id)) return sendJson(response, 400, { error: "Invalid artist track request." });
  if (review) await authenticate(request, true);
  const snapshot = await db.collection("artistReleases").doc(id).get();
  const release = snapshot.exists && snapshot.data();
  if (!release || release.status !== (review ? "submitted" : "published") ||
      release.rightsConfirmed !== true || !validId(release.artistUid)) {
    return sendJson(response, 404, { error: "Artist track not found." });
  }
  const artist = await db.collection("artists").doc(release.artistUid).get();
  if (!artist.exists || artist.data().status !== "approved") {
    return sendJson(response, 404, { error: "Artist track not found." });
  }
  const slugDoc = await db.collection("artistSlugs").doc(artist.data().slug).get();
  if (!slugDoc.exists || slugDoc.data().status !== "approved" || slugDoc.data().artistUid !== release.artistUid) {
    return sendJson(response, 404, { error: "Artist track not found." });
  }
  marketplace.validateReleaseInput(release.artistUid, id, release);
  const trackId = params.get("track");
  const track = release.releaseType === "album"
    ? marketplace.releaseAudio(release).find((entry) => entry.id === trackId)
    : trackId === null ? marketplace.releaseAudio(release)[0] : null;
  if (!track || !track.audioPath || typeof track.audioGeneration !== "string" || !/^\d+$/.test(track.audioGeneration)) {
    return sendJson(response, 404, { error: "Artist track not found." });
  }
  const file = bucket().file(track.audioPath, { generation: track.audioGeneration });
  const [metadata] = await file.getMetadata();
  const size = Number(metadata.size);
  const type = track.audioPath.endsWith(".mp3") ? "audio/mpeg" : "audio/wav";
  if (!Number.isSafeInteger(size) || size <= 0 || size > 100 * 1024 * 1024 ||
      !(metadata.contentType === type || (type === "audio/wav" && metadata.contentType === "audio/x-wav"))) {
    throw new Error("Invalid artist audio metadata.");
  }
  const range = byteRange(request.headers.range, size);
  setCorsHeaders(response);
  response.setHeader("Access-Control-Expose-Headers", "Accept-Ranges, Content-Range, Content-Length");
  response.setHeader("Cache-Control", "private, no-store");
  response.setHeader("Accept-Ranges", "bytes");
  response.setHeader("X-Content-Type-Options", "nosniff");
  if (range === false) {
    response.setHeader("Content-Range", `bytes */${size}`);
    response.writeHead(416);
    return response.end();
  }
  const start = range ? range.start : 0;
  const end = range ? Math.min(range.end, start + 2 * 1024 * 1024 - 1) : size - 1;
  response.setHeader("Content-Type", type);
  response.setHeader("Content-Length", String(end - start + 1));
  if (range) response.setHeader("Content-Range", `bytes ${start}-${end}/${size}`);
  response.writeHead(range ? 206 : 200);
  await new Promise((resolve, reject) => {
    const source = file.createReadStream({ start, end });
    source.on("error", reject);
    response.on("close", () => { source.destroy(); resolve(); });
    response.on("finish", resolve);
    source.pipe(response);
  });
}

module.exports = { publicArtists, streamRelease, validId };
