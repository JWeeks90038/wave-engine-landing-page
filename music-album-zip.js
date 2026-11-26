const MAX_FILE_SIZE = 100 * 1024 * 1024;
const encoder = new TextEncoder();
const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

export function validateAlbumFiles(files) {
  const songs = new Map();
  for (const file of files) {
    const match = /^(.+)\.(mp3|wav)$/i.exec(file.name);
    if (!match || match[1].trim().length === 0 || match[1].length > 160 ||
        /[\\/\x00-\x1f]/.test(file.name) || !file.size || file.size > MAX_FILE_SIZE ||
        !(match[2].toLowerCase() === "mp3" ? ["audio/mpeg"] : ["audio/wav", "audio/x-wav"]).includes(file.type)) {
      throw new Error("Choose nonempty MP3 or WAV files of at most 100 MiB, with valid song filenames.");
    }
    const key = match[1].toLowerCase();
    const format = match[2].toLowerCase();
    const song = songs.get(key) || { title: match[1], formats: new Set() };
    if (song.formats.has(format)) throw new Error(`Duplicate ${format.toUpperCase()} for ${song.title}.`);
    song.formats.add(format);
    songs.set(key, song);
  }
  if (!songs.size || songs.size > 20) throw new Error("Choose between 1 and 20 songs.");
  return Array.from(songs.values(), (song) => song.title);
}

export async function readAlbumZip(archive) {
  const invalid = () => new Error("The existing album archive could not be read. Its songs were not changed.");
  if (archive.size < 22) throw invalid();
  const end = new DataView(await archive.slice(archive.size - 22).arrayBuffer());
  if (end.getUint32(0, true) !== 0x06054b50 || end.getUint16(4, true) !== 0 ||
      end.getUint16(6, true) !== 0 || end.getUint16(8, true) !== end.getUint16(10, true) ||
      end.getUint16(20, true) !== 0) throw invalid();
  const count = end.getUint16(10, true);
  const directorySize = end.getUint32(12, true);
  const directoryOffset = end.getUint32(16, true);
  if (!count || count > 40 || directoryOffset + directorySize !== archive.size - 22) throw invalid();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const files = [];
  let offset = 0;
  for (let i = 0; i < count; i++) {
    if (offset + 30 > directoryOffset) throw invalid();
    const header = new DataView(await archive.slice(offset, offset + 30).arrayBuffer());
    if (header.getUint32(0, true) !== 0x04034b50 || header.getUint16(6, true) !== 0x800 ||
        header.getUint16(8, true) !== 0 || header.getUint32(18, true) !== header.getUint32(22, true)) throw invalid();
    const size = header.getUint32(18, true);
    const nameLength = header.getUint16(26, true);
    const start = offset + 30 + nameLength + header.getUint16(28, true);
    if (start + size > directoryOffset) throw invalid();
    let name;
    try { name = decoder.decode(await archive.slice(offset + 30, offset + 30 + nameLength).arrayBuffer()); }
    catch { throw invalid(); }
    const type = /\.mp3$/i.test(name) ? "audio/mpeg" : "audio/wav";
    files.push(new File([archive.slice(start, start + size)], name, { type }));
    offset = start + size;
  }
  if (offset !== directoryOffset) throw invalid();
  validateAlbumFiles(files);
  return files;
}

function header(size) {
  const bytes = new Uint8Array(size);
  return { bytes, view: new DataView(bytes.buffer) };
}

export async function makeAlbumZip(files, onProgress = () => {}) {
  validateAlbumFiles(files);
  const parts = [];
  const directory = [];
  let offset = 0;
  for (const [index, file] of files.entries()) {
    let crc = 0xffffffff;
    const reader = file.stream().getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const byte of value) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
      }
    } finally { reader.releaseLock(); }
    crc = (crc ^ 0xffffffff) >>> 0;
    const name = encoder.encode(file.name);
    const local = header(30);
    local.view.setUint32(0, 0x04034b50, true);
    local.view.setUint16(4, 20, true);
    local.view.setUint16(6, 0x800, true);
    local.view.setUint16(12, 0x21, true);
    local.view.setUint32(14, crc, true);
    local.view.setUint32(18, file.size, true);
    local.view.setUint32(22, file.size, true);
    local.view.setUint16(26, name.length, true);
    const central = header(46);
    central.view.setUint32(0, 0x02014b50, true);
    central.view.setUint16(4, 20, true);
    central.view.setUint16(6, 20, true);
    central.view.setUint16(8, 0x800, true);
    central.view.setUint16(14, 0x21, true);
    central.view.setUint32(16, crc, true);
    central.view.setUint32(20, file.size, true);
    central.view.setUint32(24, file.size, true);
    central.view.setUint16(28, name.length, true);
    central.view.setUint32(42, offset, true);
    parts.push(local.bytes, name, file);
    directory.push(central.bytes, name);
    offset += local.bytes.length + name.length + file.size;
    onProgress(index + 1, files.length);
  }
  const directorySize = directory.reduce((sum, part) => sum + part.length, 0);
  const end = header(22);
  end.view.setUint32(0, 0x06054b50, true);
  end.view.setUint16(8, files.length, true);
  end.view.setUint16(10, files.length, true);
  end.view.setUint32(12, directorySize, true);
  end.view.setUint32(16, offset, true);
  return new Blob([...parts, ...directory, end.bytes], { type: "application/zip" });
}
