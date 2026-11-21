const { sendJson, setCorsHeaders } = require("./api-utils");
const music = require("./music-library");

function createHandler({ bucket, database, filePath, byteRange, downloadName } = music) {
  return async (request, response) => {
  if (request.method === "OPTIONS") {
    setCorsHeaders(response);
    response.setHeader("Access-Control-Allow-Headers", "Range");
    response.writeHead(204);
    return response.end();
  }
  if (request.method !== "GET") return sendJson(response, 405, { error: "Method not allowed." });
  const params = new URL(request.url, "http://localhost").searchParams;
  const id = params.get("id");
  const format = params.get("format");
  if (!id || !/^[a-zA-Z0-9_-]{1,128}$/.test(id) || !["mp3", "wav", "cover"].includes(format)) {
    return sendJson(response, 400, { error: "Invalid music file request." });
  }
  try {
    const doc = await database().collection("musicTracks").doc(id).get();
    const track = doc.exists && doc.data();
    const path = track && track.published === true && filePath(id, track, format);
    if (!path) return sendJson(response, 404, { error: "Music file not found." });
    const file = bucket().file(path);
    const [metadata] = await file.getMetadata();
    const size = Number(metadata.size);
    if (!Number.isSafeInteger(size) || size <= 0) throw new Error("Invalid music file size.");
    const range = byteRange(request.headers.range, size);
    setCorsHeaders(response);
    response.setHeader("Cache-Control", "private, no-store");
    response.setHeader("Accept-Ranges", "bytes");
    response.setHeader("X-Content-Type-Options", "nosniff");
    if (range === false) {
      response.setHeader("Content-Range", `bytes */${size}`);
      response.writeHead(416);
      return response.end();
    }
    const start = range ? range.start : 0;
    const end = range ? range.end : size - 1;
    response.setHeader("Content-Type", format === "mp3" ? "audio/mpeg" : format === "wav" ? "audio/wav" : metadata.contentType);
    response.setHeader("Content-Length", String(end - start + 1));
    if (range) response.setHeader("Content-Range", `bytes ${start}-${end}/${size}`);
    if (params.get("download") === "1" && format !== "cover") {
      response.setHeader("Content-Disposition", `attachment; filename="${downloadName(track, format)}"`);
    }
    response.writeHead(range ? 206 : 200);
    await new Promise((resolve, reject) => {
      const source = file.createReadStream({ start, end });
      source.on("error", reject);
      response.on("close", () => { source.destroy(); resolve(); });
      response.on("finish", resolve);
      source.pipe(response);
    });
  } catch (error) {
    console.error("Music file error:", error.message);
    if (response.headersSent) return response.destroy(error);
    return sendJson(response, error.code === 404 ? 404 : 503, { error: "The music file could not be loaded." });
  }
  };
}
module.exports = createHandler();
module.exports.createHandler = createHandler;
