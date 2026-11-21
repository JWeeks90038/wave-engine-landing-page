import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-auth.js";
import { getFirestore, collection, doc, getDocs, setDoc, deleteDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js";
import { getStorage, ref, uploadBytesResumable, deleteObject, getBlob } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-storage.js";
import { firebaseClient } from "./firebase-client.js";

const isLocal = location.protocol === "file:" || ["localhost", "127.0.0.1"].includes(location.hostname);
const apiBase = isLocal ? "http://127.0.0.1:8787" : "https://wave-engine-landing-page.vercel.app";
const status = document.querySelector("#admin-status");
const login = document.querySelector("#admin-login");
const content = document.querySelector("#admin-content");
const form = document.querySelector("#track-form");
const list = document.querySelector("#admin-tracks");
const fields = ["title", "artist", "album", "description", "genre", "releaseDate", "duration"];
const formats = {
  mp3: { types: ["audio/mpeg"], extension: ".mp3", limit: 100 * 1024 * 1024, file: "mp3.mp3" },
  wav: { types: ["audio/wav", "audio/x-wav"], extension: ".wav", limit: 100 * 1024 * 1024, file: "wav.wav" },
  cover: { types: ["image/png", "image/jpeg", "image/webp"], limit: 10 * 1024 * 1024, file: "cover" }
};
let auth, db, storage, editing = null, busy = false;
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

try {
  const [app, configResponse] = await Promise.all([firebaseClient(apiBase), fetch(`${apiBase}/api/music-config`)]);
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
  document.querySelector("#admin-refresh").addEventListener("click", async () => {
    try { await loadTracks(); show("Tracks refreshed."); }
    catch (error) { show(`Refresh failed: ${error.message}`); }
  });
  onAuthStateChanged(auth, async (user) => {
    clearPreviews();
    list.replaceChildren();
    content.hidden = true;
    login.hidden = Boolean(user);
    if (!user) { resetEditor(); show("Sign in with an administrator account."); return; }
    try {
      const token = await user.getIdTokenResult(true);
      if (token.claims.admin !== true) { await signOut(auth); show("Administrator access is required."); return; }
      content.hidden = false;
      await loadTracks();
      show("Manage and preview tracks before publishing.");
    } catch (error) { show(`Unable to load tracks: ${error.message}`); }
  });
} catch (error) { show(error.message || "Authentication could not be loaded."); }
