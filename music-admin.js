import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-auth.js";
import { getFirestore, collection, doc, getDocs, setDoc, deleteDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js";
import { getStorage, ref, uploadBytesResumable, deleteObject, getBlob } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-storage.js";
import { firebaseClient } from "./firebase-client.js";
import { makeAlbumZip, readAlbumZip, validateAlbumFiles } from "./music-album-zip.js";

const isLocal = location.protocol === "file:" || ["localhost", "127.0.0.1"].includes(location.hostname);
const apiBase = isLocal ? "http://127.0.0.1:8787" :
  location.hostname.endsWith(".vercel.app") ? location.origin : "https://wave-engine-landing-page.vercel.app";
const status = document.querySelector("#admin-status");
const login = document.querySelector("#admin-login");
const content = document.querySelector("#admin-content");
const form = document.querySelector("#track-form");
const list = document.querySelector("#admin-tracks");
const albumForm = document.querySelector("#album-form");
const albumList = document.querySelector("#admin-albums");
const albumFileList = document.querySelector("#album-file-list");
const albumSelectedFiles = document.querySelector("#album-selected-files");
const fields = ["title", "artist", "album", "description", "genre", "releaseDate", "duration"];
const formats = {
  mp3: { types: ["audio/mpeg"], extension: ".mp3", limit: 100 * 1024 * 1024, file: "mp3.mp3" },
  wav: { types: ["audio/wav", "audio/x-wav"], extension: ".wav", limit: 100 * 1024 * 1024, file: "wav.wav" },
  cover: { types: ["image/png", "image/jpeg", "image/webp"], limit: 10 * 1024 * 1024, file: "cover" }
};
let auth, db, storage, editing = null, busy = false;
let editingAlbum = null;
let albumFiles = [];
let previewUrls = [];

function show(message) { status.textContent = message; }
function setBusy(value) {
  busy = value;
  for (const button of content.querySelectorAll("button")) button.disabled = value;
}
function clearPreviews() {
  for (const audio of list.querySelectorAll("audio")) audio.pause();
  for (const url of previewUrls) URL.revokeObjectURL(url);
  previewUrls = [];
}
function resetEditor() {
  editing = null;
  form.reset();
  document.querySelector("#editor-title").textContent = "New track";
}
function editTrack(id, data) {
  editing = { id, ...data };
  form.reset();
  for (const field of fields) form.elements[field].value = data[field] || "";
  form.elements.sortOrder.value = data.sortOrder;
  form.elements.published.checked = data.published;
  document.querySelector("#editor-title").textContent = `Edit: ${data.title}`;
  form.scrollIntoView({ behavior: "smooth" });
}
function action(label, handler) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "cta-button";
  button.textContent = label;
  button.addEventListener("click", handler);
  return button;
}
async function loadTracks() {
  clearPreviews();
  list.replaceChildren();
  const snapshot = await getDocs(collection(db, "musicTracks"));
  const records = snapshot.docs.map((entry) => ({ id: entry.id, ...entry.data() }))
    .sort((a, b) => a.sortOrder - b.sortOrder || a.title.localeCompare(b.title));
  for (const track of records) {
    const card = document.createElement("article");
    const title = document.createElement("h3");
    title.textContent = `${track.title} — ${track.artist}`;
    const info = document.createElement("p");
    info.textContent = track.published ? "Published" : "Unpublished";
    const actions = document.createElement("div");
    actions.className = "music-actions";
    actions.append(action("Edit", () => editTrack(track.id, track)));
    for (const format of ["mp3", "wav"]) {
      const path = track[`${format}StoragePath`];
      if (!path) continue;
      actions.append(action(`Preview ${format.toUpperCase()}`, async () => {
        if (busy) return;
        setBusy(true);
        show(`Loading ${format.toUpperCase()} preview...`);
        try {
          const blob = await getBlob(ref(storage, path), formats[format].limit);
          const url = URL.createObjectURL(blob);
          previewUrls.push(url);
          const player = document.createElement("audio");
          player.controls = true;
          player.src = url;
          player.setAttribute("aria-label", `Preview ${track.title} ${format.toUpperCase()}`);
          player.addEventListener("play", () => {
            for (const other of list.querySelectorAll("audio")) if (other !== player) other.pause();
          });
          card.append(player);
          show("Preview ready. Use the player controls to listen.");
        } catch (error) { show(`Preview failed: ${error.message}`); }
        finally { setBusy(false); }
      }));
    }
    actions.append(action("Delete", async () => {
      if (busy || !confirm(`Delete "${track.title}" and its files?`)) return;
      setBusy(true);
      let deleted = false;
      try {
        await deleteDoc(doc(db, "musicTracks", track.id));
        deleted = true;
        const failures = await removeFiles(["mp3", "wav", "cover"].map((key) => track[`${key}StoragePath`]));
        if (editing && editing.id === track.id) resetEditor();
        await loadTracks();
        show(failures.length ? `Track deleted, but these files could not be removed: ${failures.join(", ")}` : "Track deleted.");
      } catch (error) { show(`${deleted ? "Track deleted, but refresh failed" : "Delete failed"}: ${error.message}`); }
      finally { setBusy(false); }
    }));
    card.append(title, info, actions);
    list.append(card);
  }
  if (!records.length) list.textContent = "No tracks yet.";
}
function resetAlbum() {
  editingAlbum = null;
  albumForm.reset();
  albumFiles = [];
  renderAlbumFiles();
  document.querySelector("#album-editor-title").textContent = "New album";
}
function renderAlbumFiles() {
  albumFileList.replaceChildren();
  albumSelectedFiles.textContent = albumFiles.length ?
    `${albumFiles.length} new file${albumFiles.length === 1 ? "" : "s"} selected (${validateAlbumFiles(albumFiles).length} songs).` :
    "No new song files selected.";
  for (const [index, file] of albumFiles.entries()) {
    const row = document.createElement("div");
    const name = document.createElement("span");
    name.textContent = file.name;
    row.append(name, action("Remove", () => {
      if (busy) return;
      albumFiles.splice(index, 1);
      renderAlbumFiles();
    }));
    albumFileList.append(row);
  }
}
async function loadAlbums() {
  albumList.replaceChildren();
  const snapshot = await getDocs(collection(db, "musicAlbums"));
  const albums = snapshot.docs.map((entry) => ({ id: entry.id, ...entry.data() }))
    .sort((a, b) => a.title.localeCompare(b.title));
  for (const album of albums) {
    const card = document.createElement("article");
    const title = document.createElement("h3");
    title.textContent = album.title;
    const info = document.createElement("p");
    info.textContent = `${album.published ? "Published" : "Unpublished"} · ${album.songTitles.length} songs · $${(album.priceCents / 100).toFixed(2)}`;
    const songs = document.createElement("p");
    songs.textContent = album.songTitles.join(", ");
    const actions = document.createElement("div");
    actions.className = "music-actions";
    actions.append(action("Edit", () => {
      editingAlbum = album;
      albumForm.reset();
      albumFiles = [];
      renderAlbumFiles();
      albumForm.elements.title.value = album.title;
      albumForm.elements.price.value = (album.priceCents / 100).toFixed(2);
      albumForm.elements.published.checked = album.published;
      document.querySelector("#album-editor-title").textContent = `Edit: ${album.title}`;
      albumForm.scrollIntoView({ behavior: "smooth" });
    }));
    actions.append(action("Delete", async () => {
      if (busy || !confirm(`Delete "${album.title}"? Existing album archives are retained for customers with an open checkout.`)) return;
      setBusy(true);
      let deleted = false;
      try {
        await deleteDoc(doc(db, "musicAlbums", album.id));
        deleted = true;
        const failures = await removeFiles([album.coverPath]);
        if (editingAlbum && editingAlbum.id === album.id) resetAlbum();
        await loadAlbums();
        show(failures.length ? `Album deleted, but its cover could not be removed: ${failures.join(", ")}` :
          "Album deleted. Its archives are retained for existing purchases.");
      } catch (error) { show(`${deleted ? "Album deleted, but refresh failed" : "Album delete failed"}: ${error.message}`); }
      finally { setBusy(false); }
    }));
    card.append(title, info, songs, actions);
    albumList.append(card);
  }
  if (!albums.length) albumList.textContent = "No albums yet.";
}
async function removeFiles(paths) {
  const failed = [];
  for (const path of paths.filter(Boolean)) {
    try { await deleteObject(ref(storage, path)); }
    catch (error) { if (error.code !== "storage/object-not-found") failed.push(path); }
  }
  return failed;
}
function validateFile(file, format) {
  const spec = formats[format];
  if (!spec.types.includes(file.type) || (spec.extension && !file.name.toLowerCase().endsWith(spec.extension))) {
    throw new Error(`Invalid ${format.toUpperCase()} file type.`);
  }
  if (!file.size || file.size > spec.limit) throw new Error(`${format.toUpperCase()} file is empty or exceeds its size limit.`);
}
function upload(path, file, format) {
  return new Promise((resolve, reject) => {
    const task = uploadBytesResumable(ref(storage, path), file, { contentType: file.type });
    task.on("state_changed", (snapshot) => {
      show(`Uploading ${format.toUpperCase()}: ${Math.round(snapshot.bytesTransferred / snapshot.totalBytes * 100)}%`);
    }, reject, resolve);
  });
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (busy) return;
  const data = Object.fromEntries(fields.map((field) => [field, form.elements[field].value.trim()]));
  data.sortOrder = Number(form.elements.sortOrder.value);
  data.published = form.elements.published.checked;
  if (!data.title || !data.artist || !Number.isSafeInteger(data.sortOrder)) {
    show("Enter a title, artist, and valid whole-number sort order.");
    return;
  }
  const files = Object.fromEntries(Object.keys(formats).map((key) => [key, form.elements[key].files[0]]));
  try {
    for (const [format, file] of Object.entries(files)) if (file) validateFile(file, format);
  } catch (error) { show(error.message); return; }
  const target = editing ? doc(db, "musicTracks", editing.id) : doc(collection(db, "musicTracks"));
  const oldPaths = [];
  const uploaded = [];
  for (const format of Object.keys(formats)) {
    const key = `${format}StoragePath`;
    const remove = form.elements[`remove${format[0].toUpperCase()}${format.slice(1)}`].checked;
    if (files[format] && remove) { show(`Choose either replacing or removing ${format.toUpperCase()}, not both.`); return; }
    data[key] = editing ? editing[key] || "" : "";
    if ((remove || files[format]) && data[key]) oldPaths.push(data[key]);
    if (remove) data[key] = "";
  }
  if (data.published && !data.mp3StoragePath && !data.wavStoragePath && !files.mp3 && !files.wav) {
    show("Add an MP3 or WAV before publishing.");
    return;
  }
  setBusy(true);
  let saved = false;
  try {
    for (const [format, file] of Object.entries(files)) {
      if (!file) continue;
      const path = `musicTracks/${target.id}/${crypto.randomUUID()}/${formats[format].file}`;
      await upload(path, file, format);
      uploaded.push(path);
      data[`${format}StoragePath`] = path;
    }
    data.updatedAt = serverTimestamp();
    data.createdAt = editing ? editing.createdAt : serverTimestamp();
    data.createdBy = editing ? editing.createdBy : auth.currentUser.uid;
    show("Saving track...");
    await setDoc(target, data);
    saved = true;
    const failures = await removeFiles(oldPaths);
    resetEditor();
    await loadTracks();
    show(failures.length ? `Track saved, but old files could not be removed: ${failures.join(", ")}` : "Track saved.");
  } catch (error) {
    const failures = saved ? [] : await removeFiles(uploaded);
    show(`${saved ? "Track saved, but refresh failed" : "Save failed"}: ${error.message}${failures.length ? `. Cleanup failed: ${failures.join(", ")}` : ""}`);
  } finally { setBusy(false); }
});

albumForm.elements.songs.addEventListener("change", () => {
  if (busy) return;
  const selected = Array.from(albumForm.elements.songs.files);
  albumForm.elements.songs.value = "";
  if (!selected.length) return;
  try {
    validateAlbumFiles([...albumFiles, ...selected]);
    albumFiles.push(...selected);
    renderAlbumFiles();
    show("Song files added to the album selection.");
  } catch (error) { show(error.message); }
});

albumForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (busy) return;
  const title = albumForm.elements.title.value.trim();
  const price = albumForm.elements.price.value;
  const priceCents = Math.round(Number(price) * 100);
  let files = [...albumFiles];
  const replaceSongs = albumForm.elements.replaceSongs.checked;
  const cover = albumForm.elements.cover.files[0];
  const removeCover = albumForm.elements.removeCover.checked;
  if (!title || title.length > 160 || !/^\d+(?:\.\d{1,2})?$/.test(price) ||
      !Number.isSafeInteger(priceCents) || priceCents < 50 || priceCents > 10000) {
    show("Enter an album title and a price from $0.50 to $100.00.");
    return;
  }
  let songTitles;
  try {
    songTitles = files.length ? validateAlbumFiles(files) : editingAlbum && editingAlbum.songTitles;
    if (cover) validateFile(cover, "cover");
    if (cover && removeCover) throw new Error("Choose either replacing or removing the album cover, not both.");
    if (replaceSongs && !files.length) throw new Error("Select replacement song files before replacing the existing songs.");
  }
  catch (error) { show(error.message); return; }
  if (!songTitles) { show("Choose between 1 and 20 songs for the album."); return; }
  const target = editingAlbum ? doc(db, "musicAlbums", editingAlbum.id) : doc(collection(db, "musicAlbums"));
  let archivePath = editingAlbum ? editingAlbum.archivePath : "";
  const oldCoverPath = editingAlbum ? editingAlbum.coverPath || "" : "";
  let coverPath = removeCover ? "" : oldCoverPath;
  const uploaded = [];
  let saved = false;
  setBusy(true);
  try {
    if (files.length) {
      if (editingAlbum && !replaceSongs) {
        show("Loading existing album songs. Keep this page open.");
        const existingArchive = await getBlob(ref(storage, archivePath), 4 * 1024 * 1024 * 1024);
        const existingFiles = await readAlbumZip(existingArchive);
        const existingTitles = validateAlbumFiles(existingFiles);
        if (existingTitles.length !== editingAlbum.songTitles.length ||
            existingTitles.some((title, index) => title !== editingAlbum.songTitles[index])) {
          throw new Error("The existing album's song list does not match its archive. Its songs were not changed.");
        }
        files = [...existingFiles, ...files];
        songTitles = validateAlbumFiles(files);
      }
      show("Preparing album ZIP. Keep this page open.");
      const archive = await makeAlbumZip(files, (done, total) => show(`Preparing album ZIP: ${done} of ${total} files.`));
      archivePath = `musicAlbums/${target.id}/${crypto.randomUUID()}/album.zip`;
      await upload(archivePath, archive, "album");
      uploaded.push(archivePath);
    }
    if (cover) {
      coverPath = `musicAlbums/${target.id}/${crypto.randomUUID()}/cover`;
      await upload(coverPath, cover, "cover");
      uploaded.push(coverPath);
    }
    await setDoc(target, {
      title, priceCents, songTitles, archivePath, published: albumForm.elements.published.checked,
      ...(coverPath ? { coverPath } : {}),
      createdAt: editingAlbum ? editingAlbum.createdAt : serverTimestamp(),
      createdBy: editingAlbum ? editingAlbum.createdBy : auth.currentUser.uid,
      updatedAt: serverTimestamp()
    });
    saved = true;
    const failures = oldCoverPath && oldCoverPath !== coverPath ? await removeFiles([oldCoverPath]) : [];
    resetAlbum();
    await loadAlbums();
    show(failures.length ? `Album saved, but the old cover could not be removed: ${failures.join(", ")}` : "Album saved.");
  } catch (error) {
    const failures = saved ? [] : await removeFiles(uploaded);
    show(`${saved ? "Album saved, but refresh failed" : "Album save failed"}: ${error.message}${failures.length ? `. Cleanup failed: ${failures.join(", ")}` : ""}`);
  } finally { setBusy(false); }
});

try {
  const [app, configResponse] = await Promise.all([firebaseClient(apiBase, "admin"), fetch(`${apiBase}/api/music?action=config`)]);
  const config = await configResponse.json();
  if (!configResponse.ok) throw new Error(config.error || "Music storage is not configured.");
  auth = getAuth(app);
  db = getFirestore(app);
  storage = getStorage(app, `gs://${config.storageBucket}`);
  login.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await signInWithEmailAndPassword(auth, login.elements.email.value, login.elements.password.value);
      login.elements.password.value = "";
    } catch (error) { show(`Sign-in failed: ${error.message}`); }
  });
  document.querySelector("#admin-logout").addEventListener("click", () => signOut(auth));
  document.querySelector("#admin-new").addEventListener("click", resetEditor);
  document.querySelector("#album-new").addEventListener("click", resetAlbum);
  document.querySelector("#admin-refresh").addEventListener("click", async () => {
    try { await Promise.all([loadTracks(), loadAlbums()]); show("Tracks and albums refreshed."); }
    catch (error) { show(`Refresh failed: ${error.message}`); }
  });
  onAuthStateChanged(auth, async (user) => {
    clearPreviews();
    list.replaceChildren();
    albumList.replaceChildren();
    content.hidden = true;
    login.hidden = Boolean(user);
    if (!user) { resetEditor(); resetAlbum(); show("Sign in with an administrator account."); return; }
    try {
      const token = await user.getIdTokenResult(true);
      if (token.claims.admin !== true) { await signOut(auth); show("Administrator access is required."); return; }
      content.hidden = false;
      await Promise.all([loadTracks(), loadAlbums()]);
      show("Manage tracks and albums before publishing.");
    } catch (error) { show(`Unable to load tracks: ${error.message}`); }
  });
} catch (error) { show(error.message || "Authentication could not be loaded."); }
