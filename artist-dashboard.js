import {
  createUserWithEmailAndPassword,
  getAuth,
  onAuthStateChanged,
  sendEmailVerification,
  signInWithEmailAndPassword,
  signOut
} from "https://www.gstatic.com/firebasejs/11.10.0/firebase-auth.js";
import { getStorage, ref, uploadBytesResumable, deleteObject } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-storage.js";
import { firebaseClient } from "./firebase-client.js";
import { createCoverPreviews } from "./artist-cover-preview.js";

const isLocal = location.protocol === "file:" || ["localhost", "127.0.0.1"].includes(location.hostname);
const apiBase = isLocal ? "http://127.0.0.1:8787" :
  location.hostname.endsWith(".vercel.app") ? location.origin : "https://wave-engine-landing-page.vercel.app";
const status = document.querySelector("#artist-status");
const authPanel = document.querySelector("#artist-auth");
const account = document.querySelector("#artist-account");
const signin = document.querySelector("#artist-signin");
const signup = document.querySelector("#artist-signup");
const profileSection = document.querySelector("#artist-profile-section");
const profileForm = document.querySelector("#artist-profile-form");
const releaseSection = document.querySelector("#artist-releases-section");
const releaseForm = document.querySelector("#artist-release-form");
const releasesList = document.querySelector("#artist-releases");
const coverPreview = document.querySelector("#artist-release-cover-preview");
const genreSearch = document.querySelector("#artist-genre-search");
const genreSearchStatus = document.querySelector("#artist-genre-search-status");
const uploadSpecs = {
  avatar: { types: ["image/jpeg", "image/png", "image/webp"], max: 10 * 1024 * 1024 },
  banner: { types: ["image/jpeg", "image/png", "image/webp"], max: 10 * 1024 * 1024 },
  background: { types: ["image/jpeg", "image/png", "image/webp"], max: 10 * 1024 * 1024 },
  gallery: { types: ["image/jpeg", "image/png", "image/webp"], max: 10 * 1024 * 1024 },
  audio: { types: ["audio/mpeg", "audio/wav", "audio/x-wav"], max: 100 * 1024 * 1024 },
  cover: { types: ["image/jpeg", "image/png", "image/webp"], max: 10 * 1024 * 1024 }
};
let auth;
let storage;
let currentUser = null;
let currentProfile = null;
let galleryFiles = [];
let editingRelease = null;
let albumTracks = [];
let busy = false;
let releaseLoad = 0;
let verificationTimer;
let verificationCheck = null;
let verificationGeneration = 0;
const releaseCovers = createCoverPreviews(apiBase, "owner", () => currentUser);
const formCover = createCoverPreviews(apiBase, "owner", () => currentUser);
const backgroundPreviews = createCoverPreviews(apiBase, "owner", () => currentUser);
const galleryPreviews = createCoverPreviews(apiBase, "owner", () => currentUser);

function sellsAlbum(mode) {
  return mode === "album" || mode === "both";
}

function sellsTracks(mode) {
  return mode === "tracks" || mode === "both";
}

function show(message) {
  status.textContent = message;
}

function showRelease(message) {
  document.querySelector("#artist-release-status").textContent = message;
  show(message);
}

function setBusy(value) {
  busy = value;
  const blocked = currentProfile && ["rejected", "suspended"].includes(currentProfile.status);
  for (const control of profileForm.elements) control.disabled = value || Boolean(blocked);
  for (const control of releaseForm.querySelectorAll("input, textarea, select")) {
    control.disabled = value ||
      (control.name === "releaseType" && Boolean(editingRelease)) ||
      (control.name === "downloadPrice" && releaseForm.elements.releaseType.value === "album" &&
        !sellsAlbum(releaseForm.elements.saleMode.value)) ||
      (control.className === "artist-track-price" && !sellsTracks(releaseForm.elements.saleMode.value));
  }
  for (const button of account.querySelectorAll("button")) {
    if (!profileForm.contains(button) && button.id !== "artist-storefront-unavailable") button.disabled = value;
  }
}

async function apiRequest(path, { method = "GET", body, user = currentUser } = {}) {
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (user) headers.Authorization = `Bearer ${await user.getIdToken()}`;
  const response = await fetch(`${apiBase}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store"
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "The request could not be completed.");
  return data;
}

function extension(file, allowed) {
  const result = /\.([a-z0-9]+)$/i.exec(file.name);
  const ext = result && result[1].toLowerCase();
  if (!ext || !allowed.includes(ext)) throw new Error("Choose a supported file format.");
  return ext;
}

function validateUpload(file, kind) {
  if (!file) return;
  const spec = uploadSpecs[kind];
  if (!spec.types.includes(file.type) || !file.size || file.size > spec.max) {
    throw new Error(`${kind === "audio" ? "Audio" : "Image"} file is invalid or exceeds its size limit.`);
  }
}

function uploadName(kind, file) {
  const ext = extension(file, kind === "audio" ? ["mp3", "wav"] : ["jpg", "jpeg", "png", "webp"]);
  if (kind === "audio") return `audio.${ext}`;
  if (kind === "cover") return `cover.${ext}`;
  return `${kind}.${ext}`;
}

function upload(path, file, kind) {
  return new Promise((resolve, reject) => {
    const task = uploadBytesResumable(ref(storage, path), file, { contentType: file.type });
    task.on("state_changed", (snapshot) => {
      show(`Uploading ${kind}: ${Math.round(snapshot.bytesTransferred / snapshot.totalBytes * 100)}%`);
    }, reject, () => resolve(path));
  });
}

async function uploadPrivateAsset(file, kind, ownerId, groupId) {
  validateUpload(file, kind);
  const uploadId = groupId === "profile" ? `profile-${crypto.randomUUID()}` : `${groupId}-${crypto.randomUUID()}`;
  const path = `artistUploads/${ownerId}/${uploadId}/${uploadName(kind, file)}`;
  return upload(path, file, kind);
}

async function cleanupUploads(paths, owner = null) {
  const errors = [];
  for (const path of paths) {
    if (owner && owner !== currentUser) {
      errors.push(path);
      continue;
    }
    try { await deleteObject(ref(storage, path)); }
    catch (error) {
      if (error.code !== "storage/object-not-found") errors.push(path);
    }
  }
  return errors;
}

function profileFormData() {
  const values = new FormData(profileForm);
  return {
    artistName: String(values.get("artistName") || "").trim(),
    slug: String(values.get("slug") || "").trim(),
    biography: String(values.get("biography") || "").trim(),
    socialLinks: {
      website: String(values.get("website") || "").trim(),
      facebook: String(values.get("facebook") || "").trim(),
      instagram: String(values.get("instagram") || "").trim(),
      youtube: String(values.get("youtube") || "").trim(),
      tiktok: String(values.get("tiktok") || "").trim()
    },
    bannerPositionY: Number(values.get("bannerPositionY")),
    appearance: {
      accentColor: String(values.get("accentColor") || ""),
      backgroundColor: String(values.get("backgroundColor") || ""),
      featuredMessage: String(values.get("featuredMessage") || "").trim()
    }
  };
}

const bannerPreview = document.querySelector("#banner-preview");
let bannerPreviewObjectUrl = "";

function updateBannerPreview(url) {
  if (url !== undefined) bannerPreview.style.backgroundImage = url ? `url("${url}")` : "";
  bannerPreview.style.backgroundPosition = `center ${profileForm.elements.bannerPositionY.value}%`;
}

profileForm.elements.bannerPositionY.addEventListener("input", () => updateBannerPreview());
profileForm.elements.banner.addEventListener("change", () => {
  if (bannerPreviewObjectUrl) URL.revokeObjectURL(bannerPreviewObjectUrl);
  const file = profileForm.elements.banner.files[0];
  bannerPreviewObjectUrl = file ? URL.createObjectURL(file) : "";
  if (file) updateBannerPreview(bannerPreviewObjectUrl);
});

const stylePreview = document.querySelector("#artist-style-preview");
const imagePreviews = {
  background: { input: "backgroundImages", clear: "clearBackgroundImages", container: "#artist-background-preview", manager: backgroundPreviews, limit: 5 },
  gallery: { input: "galleryImages", clear: "clearGalleryImages", container: "#artist-gallery-preview", manager: galleryPreviews, limit: 6 }
};
let backgroundPreviewUrl = "";
const imagePreviewVersion = { background: 0, gallery: 0 };

function updateStylePreview() {
  stylePreview.style.setProperty("--preview-accent", profileForm.elements.accentColor.value);
  stylePreview.style.setProperty("--preview-color", profileForm.elements.backgroundColor.value);
  stylePreview.style.setProperty("--preview-image", backgroundPreviewUrl ? `url(${JSON.stringify(backgroundPreviewUrl)})` : "none");
  document.querySelector("#artist-message-preview").textContent = profileForm.elements.featuredMessage.value;
}

function refreshProfileImages(kind) {
  const config = imagePreviews[kind];
  const container = document.querySelector(config.container);
  const version = ++imagePreviewVersion[kind];
  config.manager.clear();
  container.replaceChildren();
  if (kind === "background") backgroundPreviewUrl = "";
  const files = kind === "gallery" ? galleryFiles : Array.from(profileForm.elements[config.input].files);
  if (!profileForm.elements[config.clear].checked) {
    if (files.length && kind !== "gallery") {
      if (files.length > config.limit) show(`Choose up to ${config.limit} ${kind} images.`);
      for (const [index, file] of files.slice(0, config.limit).entries()) {
        const url = config.manager.addLocal(container, file, `${kind} image ${index + 1}`, "preview");
        if (kind === "background" && index === 0) backgroundPreviewUrl = url;
      }
    } else {
      const saved = currentProfile && currentProfile[config.input] || [];
      saved.forEach((image, index) => {
        config.manager.addProfile(container, image, `${kind} image ${index + 1}`).then((url) => {
          if (kind === "background" && index === 0 && version === imagePreviewVersion[kind] && url) {
            backgroundPreviewUrl = url;
            updateStylePreview();
          }
        });
      });
      if (kind === "gallery") {
        for (const [index, file] of files.entries()) {
          config.manager.addLocal(container, file, `${kind} image ${saved.length + index + 1}`, "preview");
        }
      }
    }
  }
  updateStylePreview();
}

function renderGallerySelection() {
  const list = document.querySelector("#artist-gallery-selection-list");
  list.replaceChildren();
  const saved = currentProfile && currentProfile.galleryImages ? currentProfile.galleryImages.length : 0;
  const clearing = profileForm.elements.clearGalleryImages.checked;
  const remaining = imagePreviews.gallery.limit - saved - galleryFiles.length;
  document.querySelector("#artist-gallery-selection").textContent =
    clearing ? `${saved} saved photos will be removed when you save your profile.` :
      `${saved} saved; ${galleryFiles.length} selected; ${remaining} slots remaining.`;
  for (const [index, file] of galleryFiles.entries()) {
    const row = document.createElement("div");
    const name = document.createElement("span");
    const remove = document.createElement("button");
    name.textContent = file.name;
    remove.type = "button";
    remove.textContent = "Remove";
    remove.disabled = busy || Boolean(currentProfile && ["rejected", "suspended"].includes(currentProfile.status));
    remove.addEventListener("click", () => {
      if (busy) return;
      galleryFiles.splice(index, 1);
      document.querySelector("#artist-gallery-error").textContent = "";
      renderGallerySelection();
      refreshProfileImages("gallery");
    });
    row.append(name, remove);
    list.append(row);
  }
}

for (const name of ["accentColor", "backgroundColor", "featuredMessage"]) {
  profileForm.elements[name].addEventListener("input", updateStylePreview);
}
for (const [kind, config] of Object.entries(imagePreviews)) {
  profileForm.elements[config.input].addEventListener("change", () => {
    if (kind === "gallery") {
      const selected = Array.from(profileForm.elements[config.input].files);
      profileForm.elements[config.input].value = "";
      if (!selected.length) return;
      const errorMessage = document.querySelector("#artist-gallery-error");
      errorMessage.textContent = "";
      try {
        if (profileForm.elements[config.clear].checked) {
          throw new Error("Save your profile to remove the existing gallery before adding new photos.");
        }
        const savedCount = currentProfile && currentProfile.galleryImages ? currentProfile.galleryImages.length : 0;
        if (savedCount + galleryFiles.length + selected.length > config.limit) {
          const remaining = config.limit - savedCount - galleryFiles.length;
          throw new Error(`Choose up to ${config.limit} gallery images in total. ${remaining} more can be selected; existing selections were kept.`);
        }
        for (const file of selected) {
          try {
            validateUpload(file, kind);
            uploadName(kind, file);
          } catch (error) {
            throw new Error(`${file.name}: ${error.message}`);
          }
        }
        galleryFiles.push(...selected);
        renderGallerySelection();
      } catch (error) { errorMessage.textContent = error.message; show(error.message); return; }
    }
    profileForm.elements[config.clear].checked = false;
    refreshProfileImages(kind);
  });
  profileForm.elements[config.clear].addEventListener("change", () => {
    if (profileForm.elements[config.clear].checked) {
      profileForm.elements[config.input].value = "";
      if (kind === "gallery") galleryFiles = [];
    }
    if (kind === "gallery") {
      document.querySelector("#artist-gallery-error").textContent = "";
      renderGallerySelection();
    }
    refreshProfileImages(kind);
  });
}

function renderProfile(profile) {
  currentProfile = profile;
  renderGallerySelection();
  const blocked = ["rejected", "suspended"].includes(profile.status);
  profileSection.hidden = false;
  releaseSection.hidden = blocked;
  document.querySelector("#artist-profile-title").textContent =
    profile.status === "approved" ? "Your artist profile" : "Artist profile application";
  document.querySelector("#artist-profile-notice").textContent = blocked
    ? "This profile is not active. Contact Wave Engine support for assistance."
    : profile.status === "approved"
      ? "Your profile is approved. Submit saved releases for review before they can be streamed."
      : "Your profile is private while it awaits administrator review.";
  profileForm.elements.artistName.value = profile.artistName;
  profileForm.elements.slug.value = profile.slug;
  profileForm.elements.slug.readOnly = true;
  profileForm.elements.biography.value = profile.biography || "";
  for (const field of ["website", "facebook", "instagram", "youtube", "tiktok"]) {
    profileForm.elements[field].value = profile.socialLinks && profile.socialLinks[field] || "";
  }
  profileForm.elements.bannerPositionY.value = Number.isInteger(profile.bannerPositionY) ? profile.bannerPositionY : 50;
  profileForm.elements.accentColor.value = profile.appearance ? profile.appearance.accentColor : "#83b5f5";
  profileForm.elements.backgroundColor.value = profile.appearance ? profile.appearance.backgroundColor : "#101a2d";
  profileForm.elements.featuredMessage.value = profile.appearance ? profile.appearance.featuredMessage : "";
  refreshProfileImages("background");
  refreshProfileImages("gallery");
  if (!bannerPreviewObjectUrl) updateBannerPreview(profile.bannerUrl || "");
  else updateBannerPreview();
  for (const control of profileForm.elements) control.disabled = blocked || busy;
  const approved = profile.status === "approved";
  document.querySelector("#artist-release-review-actions").hidden = !approved;
  document.querySelector("#artist-release-submit-review").hidden = !approved;
  document.querySelector("#artist-profile-link").hidden = false;
  const link = document.querySelector("#artist-storefront-link");
  link.hidden = !approved;
  link.href = approved ? `/artist/${encodeURIComponent(profile.slug)}` : "";
  const navLink = document.querySelector("#studio-profile-link");
  navLink.hidden = !approved;
  navLink.href = link.href;
  document.querySelector("#artist-storefront-unavailable").hidden = approved;
  document.querySelector("#artist-storefront-notice").textContent = approved ? "" :
    profile.status === "pending" ? "Your profile is awaiting review. Your storefront will be available after approval." :
      "Your storefront is unavailable while your profile is inactive.";
}

async function loadProfile() {
  const user = currentUser;
  const data = await apiRequest("/api/artist-profile?me=1", { user });
  if (user !== currentUser) return;
  if (data.tokenRefreshRequired) await user.getIdToken(true);
  if (user !== currentUser) return;
  renderProfile(data.profile);
  await loadReleases();
}

async function loadReleases() {
  const user = currentUser;
  const load = ++releaseLoad;
  const data = await apiRequest("/api/artist-releases");
  if (user !== currentUser || load !== releaseLoad) return;
  releaseCovers.clear();
  releasesList.replaceChildren();
  for (const release of data.releases) {
    const card = document.createElement("article");
    const heading = document.createElement("h3");
    heading.textContent = release.title;
    const details = document.createElement("p");
    const labels = { draft: "Private draft", submitted: "Awaiting review", published: "Public streaming" };
    details.textContent = `${release.genre || "Genre not set"} · ${labels[release.status] || "Unknown status"}`;
    const files = document.createElement("p");
    const isAlbum = release.releaseType === "album";
    const tracks = isAlbum ? release.tracks || [] : [];
    const hasSales = release.downloadPriceCents != null ||
      (isAlbum && sellsTracks(release.saleMode) && tracks.some((track) => track.downloadPriceCents != null));
    files.textContent = [
      isAlbum ? `${tracks.length} ${tracks.length === 1 ? "song" : "songs"} uploaded` :
        release.audioPath ? "Audio uploaded" : "Audio not uploaded",
      release.coverPath ? "Artwork uploaded" : "Artwork not uploaded"
    ].join(" · ");
    card.append(heading, details, files);
    if (release.coverPath) releaseCovers.add(card, release);
    if (isAlbum && tracks.length) {
      const songs = document.createElement("p");
      songs.textContent = tracks.map((track) => track.title).join(" · ");
      card.append(songs);
    }
    if (release.downloadPriceCents != null) {
      const price = document.createElement("p");
      price.textContent = `Download price: $${(release.downloadPriceCents / 100).toFixed(2)}`;
      card.append(price);
    }
    if (release.status === "draft") {
      const edit = document.createElement("button");
      edit.type = "button";
      edit.className = "cta-button";
      edit.textContent = "Edit draft";
      edit.addEventListener("click", () => editDraft(release));
      card.append(edit);
      if (currentProfile.status === "approved" && (isAlbum ? tracks.length && release.coverPath : release.audioPath)) {
        const label = document.createElement("label");
        label.className = "artist-rights-confirmation";
        const confirmation = document.createElement("input");
        confirmation.type = "checkbox";
        const text = document.createElement("span");
        text.textContent = !hasSales
          ? "I confirm I have the rights to upload and publicly stream this release and authorize Wave Engine to host and stream it."
          : "I confirm I have the rights to upload, stream, and sell downloads of this release and authorize Wave Engine to host and deliver it.";
        label.append(confirmation, text);
        const submit = document.createElement("button");
        submit.type = "button";
        submit.className = "cta-button cta-primary";
        submit.textContent = "Submit saved release for review";
        submit.addEventListener("click", async () => {
          if (busy) return;
          if (!confirmation.checked) return show("Confirm your rights before submitting this release.");
          setBusy(true);
          try {
            await apiRequest("/api/artist-releases", {
              method: "POST", body: { action: "submit", id: release.id, rightsConfirmed: true,
                salesRightsConfirmed: hasSales }
            });
            if (editingRelease && editingRelease.id === release.id) resetReleaseForm();
            await loadReleases();
            show("Release submitted for review. It remains private until approved.");
          } catch (error) { show(error.message); }
          finally { setBusy(false); }
        });
        card.append(label, submit);
      } else {
        const notice = document.createElement("p");
        notice.textContent = currentProfile.status !== "approved"
          ? "Your artist profile must be approved before you can submit this draft."
          : isAlbum
            ? "Add at least one song and an album cover before submitting this draft."
            : "Add audio before submitting this draft.";
        card.append(notice);
      }
    } else if (["submitted", "published"].includes(release.status)) {
      const withdraw = document.createElement("button");
      withdraw.type = "button";
      withdraw.className = "cta-button";
      withdraw.textContent = release.status === "published" ? "Remove from public streaming" : "Withdraw submission";
      withdraw.addEventListener("click", async () => {
        if (busy) return;
        setBusy(true);
        try {
          await apiRequest("/api/artist-releases", { method: "POST", body: { action: "withdraw", id: release.id } });
          await loadReleases();
          show("Release returned to a private draft.");
        } catch (error) { show(error.message); }
        finally { setBusy(false); }
      });
      card.append(withdraw);
    }
    releasesList.append(card);
  }
  if (!data.releases.length) releasesList.textContent = "No drafts yet.";
}

function filterGenres() {
  const genreSelect = releaseForm.elements.genre;
  const normalize = (value) => value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  const query = normalize(genreSearch.value.trim());
  let matches = 0;
  for (const option of genreSelect.options) {
    const matchesQuery = option.value && normalize(option.textContent || option.value).includes(query);
    if (matchesQuery) matches++;
    option.hidden = Boolean(query) && option.value !== "" && !matchesQuery &&
      option.value !== genreSelect.value && option.value !== "Other";
  }
  for (const group of genreSelect.querySelectorAll("optgroup")) {
    group.hidden = Array.from(group.children).every((option) => option.hidden);
  }
  genreSearchStatus.textContent = !query ? "Search to narrow the genre list."
    : matches ? `${matches} matching ${matches === 1 ? "genre" : "genres"}.`
      : "No matching genres. Try another search or choose Other; your current selection is kept.";
}

genreSearch.addEventListener("input", filterGenres);
releaseForm.elements.genre.addEventListener("change", filterGenres);

function priceCents(raw) {
  raw = raw.trim();
  if (!raw) return null;
  if (!/^\d+(?:\.\d{1,2})?$/.test(raw)) throw new Error("Enter a valid download price.");
  const cents = Math.round(Number(raw) * 100);
  if (cents < 50 || cents > 10000) throw new Error("Download prices must be between $0.50 and $100.00.");
  return cents;
}

function renderAlbumTracks() {
  const container = document.querySelector("#artist-album-tracks");
  container.replaceChildren();
  if (releaseForm.elements.releaseType.value !== "album") return;
  for (const [index, track] of albumTracks.entries()) {
    const row = document.createElement("div");
    row.className = "artist-album-track";
    const titleLabel = document.createElement("label");
    titleLabel.textContent = `Song ${index + 1} title`;
    const title = document.createElement("input");
    title.value = track.title;
    title.maxLength = 160;
    title.required = true;
    title.addEventListener("input", () => { track.title = title.value; });
    titleLabel.append(title);
    const priceLabel = document.createElement("label");
    priceLabel.textContent = "Song download price in USD ($0.50–$100.00)";
    priceLabel.hidden = !sellsTracks(releaseForm.elements.saleMode.value);
    const price = document.createElement("input");
    price.type = "number";
    price.className = "artist-track-price";
    price.min = "0.50";
    price.max = "100.00";
    price.step = "0.01";
    price.value = track.price || "";
    price.disabled = priceLabel.hidden;
    price.required = !priceLabel.hidden;
    price.addEventListener("input", () => { track.price = price.value; });
    priceLabel.append(price);
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "cta-button";
    remove.textContent = "Remove song";
    remove.addEventListener("click", () => { albumTracks.splice(index, 1); renderAlbumTracks(); });
    row.append(titleLabel, priceLabel, remove);
    container.append(row);
  }
}

function updateReleaseType() {
  const album = releaseForm.elements.releaseType.value === "album";
  if (!editingRelease) document.querySelector("#artist-release-title").textContent = album ? "New album draft" : "New single draft";
  document.querySelector("#artist-title-label").textContent = album ? "Album title" : "Track title";
  document.querySelector("#artist-price-text").textContent = album
    ? "Album download price in USD ($0.50–$100.00)"
    : "Download price in USD (optional; $0.50–$100.00)";
  document.querySelector("#artist-sale-mode-label").hidden = !album;
  document.querySelector("#artist-single-audio").hidden = album;
  document.querySelector("#artist-album-audio").hidden = !album;
  const showPrice = !album || sellsAlbum(releaseForm.elements.saleMode.value);
  document.querySelector("#artist-price-label").hidden = !showPrice;
  releaseForm.elements.downloadPrice.disabled = !showPrice;
  releaseForm.elements.downloadPrice.required = album && sellsAlbum(releaseForm.elements.saleMode.value);
  renderAlbumTracks();
}

releaseForm.elements.releaseType.addEventListener("change", updateReleaseType);
releaseForm.elements.saleMode.addEventListener("change", updateReleaseType);
releaseForm.elements.cover.addEventListener("change", () => {
  formCover.clear();
  coverPreview.replaceChildren();
  const file = releaseForm.elements.cover.files[0];
  if (!file) {
    if (editingRelease && editingRelease.coverPath) formCover.add(coverPreview, editingRelease);
    return;
  }
  try {
    validateUpload(file, "cover");
    extension(file, ["jpg", "jpeg", "png", "webp"]);
    formCover.addLocal(coverPreview, file, releaseForm.elements.title.value.trim() || "Selected");
  } catch (error) {
    show(error.message);
  }
});
releaseForm.elements.albumAudio.addEventListener("change", () => {
  const files = Array.from(releaseForm.elements.albumAudio.files);
  try {
    if (albumTracks.length + files.length > 20) throw new Error("An album can contain at most 20 songs.");
    for (const file of files) { validateUpload(file, "audio"); extension(file, ["mp3", "wav"]); }
    albumTracks.push(...files.map((file) => ({
      id: crypto.randomUUID(), title: file.name.replace(/\.[^.]+$/, ""), file, audioPath: "", price: ""
    })));
    renderAlbumTracks();
  } catch (error) { show(error.message); }
  releaseForm.elements.albumAudio.value = "";
});

function editDraft(release) {
  editingRelease = release;
  releaseForm.elements.releaseType.value = release.releaseType || "single";
  releaseForm.elements.releaseType.disabled = true;
  releaseForm.elements.saleMode.value = release.saleMode || "none";
  albumTracks = (release.tracks || []).map((track) => ({
    ...track, price: track.downloadPriceCents == null ? "" : (track.downloadPriceCents / 100).toFixed(2)
  }));
  updateReleaseType();
  releaseForm.elements.title.value = release.title || "";
  releaseForm.elements.description.value = release.description || "";
  releaseForm.elements.downloadPrice.value = release.downloadPriceCents == null ? "" : (release.downloadPriceCents / 100).toFixed(2);
  const genreSelect = releaseForm.elements.genre;
  const oldGenre = genreSelect.querySelector("option[data-legacy-genre]");
  if (oldGenre) oldGenre.remove();
  if (release.genre && !Array.from(genreSelect.options).some((option) => option.value === release.genre)) {
    const option = document.createElement("option");
    option.value = release.genre;
    option.textContent = release.genre;
    option.dataset.legacyGenre = "true";
    genreSelect.append(option);
  }
  genreSelect.value = release.genre || "";
  genreSearch.value = "";
  filterGenres();
  releaseForm.elements.audio.value = "";
  releaseForm.elements.cover.value = "";
  formCover.clear();
  coverPreview.replaceChildren();
  if (release.coverPath) formCover.add(coverPreview, release);
  document.querySelector("#artist-release-title").textContent = `Edit draft: ${release.title}`;
  document.querySelector("#artist-release-cancel").hidden = false;
  releaseForm.scrollIntoView({ behavior: "smooth" });
}

function resetReleaseForm() {
  formCover.clear();
  coverPreview.replaceChildren();
  editingRelease = null;
  albumTracks = [];
  const oldGenre = releaseForm.elements.genre.querySelector("option[data-legacy-genre]");
  if (oldGenre) oldGenre.remove();
  releaseForm.reset();
  releaseForm.elements.releaseType.disabled = false;
  updateReleaseType();
  genreSearch.value = "";
  filterGenres();
  document.querySelector("#artist-release-title").textContent = "New single draft";
  document.querySelector("#artist-release-cancel").hidden = true;
}

async function initializeAccount(user) {
  currentUser = user;
  account.hidden = false;
  authPanel.hidden = true;
  document.querySelector("#artist-email").textContent = user.email || "";
  const verifyButton = document.querySelector("#artist-verify");
  verifyButton.hidden = Boolean(user.emailVerified);
  clearInterval(verificationTimer);
  verificationTimer = user.emailVerified ? undefined : setInterval(() => {
    if (document.visibilityState === "visible") return checkEmailVerification();
  }, 15000);
  profileSection.hidden = true;
  releaseSection.hidden = true;

  if (!user.emailVerified) {
    show("Verify your email address to create an artist profile or upload drafts.");
    return;
  }
  try {
    await loadProfile();
    if (user !== currentUser) return;
    show("Artist Studio is ready. Drafts are private until approved for streaming.");
  } catch (error) {
    if (user !== currentUser) return;
    if (/No artist profile is registered/.test(error.message)) {
      currentProfile = null;
      setBusy(busy);
      profileSection.hidden = false;
      releaseSection.hidden = true;
      document.querySelector("#artist-profile-link").hidden = true;
      document.querySelector("#artist-profile-title").textContent = "Create your artist profile";
      document.querySelector("#artist-profile-notice").textContent = "Artist profiles are reviewed before they become public.";
      profileForm.elements.slug.readOnly = false;
      show("Create an artist profile to begin.");
      return;
    }
    show(error.message);
  }
}

async function checkEmailVerification() {
  const user = currentUser;
  if (!user || document.querySelector("#artist-verify").hidden) return;
  if (verificationCheck && verificationCheck.user === user) return verificationCheck.promise;
  const generation = verificationGeneration;
  const check = { user, promise: null };
  verificationCheck = check;
  check.promise = (async () => {
    try {
      if (!user.emailVerified) await user.reload();
      if (generation !== verificationGeneration || user !== currentUser || user !== auth.currentUser) return;
      if (!user.emailVerified) {
        show("Verify your email address to create an artist profile or upload drafts.");
        return;
      }
      await user.getIdToken(true);
      if (generation !== verificationGeneration || user !== currentUser || user !== auth.currentUser) return;
      await initializeAccount(user);
    } catch (error) {
      if (generation === verificationGeneration && user === currentUser) show(`Email verification could not be checked: ${error.message}`);
    } finally {
      if (verificationCheck === check) verificationCheck = null;
    }
  })();
  return check.promise;
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") return checkEmailVerification();
});

document.querySelector("#show-signin").addEventListener("click", () => {
  signin.hidden = false;
  signup.hidden = true;
});
document.querySelector("#show-signup").addEventListener("click", () => {
  signin.hidden = true;
  signup.hidden = false;
});
signin.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await signInWithEmailAndPassword(auth, signin.elements.email.value, signin.elements.password.value);
    signin.elements.password.value = "";
  } catch (error) {
    show(`Sign-in failed: ${error.message}`);
  }
});
signup.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const credential = await createUserWithEmailAndPassword(auth, signup.elements.email.value, signup.elements.password.value);
    await sendEmailVerification(credential.user);
    signup.elements.password.value = "";
    show("Account created. Check your email and verify your address before continuing.");
  } catch (error) {
    show(`Account creation failed: ${error.message}`);
  }
});
document.querySelector("#artist-signout").addEventListener("click", () => signOut(auth));
document.querySelector("#artist-verify").addEventListener("click", checkEmailVerification);

profileForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (busy) return;
  const uploaded = [];
  const creatingProfile = !currentProfile;
  let assetsSaved = false;
  let updateAttempted = false;
  const user = currentUser;
  const data = profileFormData();
  const files = {
    avatar: profileForm.elements.avatar.files[0],
    banner: profileForm.elements.banner.files[0]
  };
  const customFiles = Object.fromEntries(Object.entries(imagePreviews).map(([kind, config]) =>
    [kind, kind === "gallery" ? [...galleryFiles] : Array.from(profileForm.elements[config.input].files)]));
  setBusy(true);
  try {
    for (const [kind, file] of Object.entries(files)) validateUpload(file, kind);
    for (const [kind, selected] of Object.entries(customFiles)) {
      const config = imagePreviews[kind];
      if (selected.length > config.limit) throw new Error(`Choose up to ${config.limit} ${kind} images.`);
      if (selected.length && profileForm.elements[config.clear].checked) {
        throw new Error(`Choose new ${kind} images or remove the existing set, not both.`);
      }
      for (const file of selected) validateUpload(file, kind);
    }

    if (creatingProfile) {
      const created = await apiRequest("/api/artist-profile", {
        method: "POST",
        body: { action: "create", ...data },
        user
      });
      if (user !== currentUser) throw new Error("Your account changed. Sign in again before editing your profile.");
      currentProfile = created.profile;
      renderProfile(created.profile);
      if (created.tokenRefreshRequired) await user.getIdToken(true);
    }

    const assetPaths = {};
    for (const [kind, file] of Object.entries(files)) {
      if (!file) continue;
      if (user !== currentUser) throw new Error("Your account changed. Sign in again before editing your profile.");
      assetPaths[`${kind}Path`] = await uploadPrivateAsset(file, kind, user.uid, "profile");
      uploaded.push(assetPaths[`${kind}Path`]);
    }
    for (const [kind, selected] of Object.entries(customFiles)) {
      const config = imagePreviews[kind];
      if (!selected.length && !profileForm.elements[config.clear].checked) continue;
      const paths = [];
      for (const file of selected) {
        if (user !== currentUser) throw new Error("Your account changed. Sign in again before editing your profile.");
        const path = await uploadPrivateAsset(file, kind, user.uid, "profile");
        paths.push(path);
        uploaded.push(path);
      }
      assetPaths[kind === "gallery" && selected.length ? "addGalleryPaths" : `${kind}Paths`] = paths;
    }

    let result = { profile: currentProfile, cleanupPaths: [] };
    if (!creatingProfile || Object.keys(assetPaths).length) {
      if (user !== currentUser) throw new Error("Your account changed. Sign in again before editing your profile.");
      updateAttempted = true;
      result = await apiRequest("/api/artist-profile", {
        method: "POST",
        body: { action: "update", ...data, ...assetPaths },
        user
      });
      assetsSaved = true;
      if (user !== currentUser) throw new Error("Your profile was saved, but your account changed. Sign in again to continue.");
      for (const config of Object.values(imagePreviews)) {
        profileForm.elements[config.input].value = "";
        profileForm.elements[config.clear].checked = false;
      }
      galleryFiles = [];
      document.querySelector("#artist-gallery-error").textContent = "";
      renderGallerySelection();
      renderProfile(result.profile);
    }
    assetsSaved = true;
    if (creatingProfile) await loadReleases();
    const cleanupFailures = await cleanupUploads(result.cleanupPaths || [], user);
    show(cleanupFailures.length
      ? `Profile saved, but old images could not be removed: ${cleanupFailures.join(", ")}`
      : result.profile.status === "approved" ? "Artist profile saved." : "Profile saved and awaiting review.");
  } catch (error) {
    let preserveUploads = assetsSaved;
    let verificationError = "";
    if (!assetsSaved && updateAttempted && uploaded.length) {
      try {
        const saved = await apiRequest("/api/artist-profile?me=1", { user });
        if (!Array.isArray(saved.assetPaths)) throw new Error("The saved image paths were unavailable.");
        preserveUploads = uploaded.some((path) => saved.assetPaths.includes(path));
      } catch (failure) {
        preserveUploads = true;
        verificationError = ` Could not verify whether the profile saved; uploaded files were retained: ${failure.message}`;
      }
    }
    const failures = preserveUploads ? [] : await cleanupUploads(uploaded, user);
    show(`${error.message}${verificationError}${preserveUploads && !assetsSaved && !verificationError
      ? " Some uploaded files are referenced by the saved profile; refresh before retrying." : ""}${failures.length ? ` Upload cleanup failed for ${failures.join(", ")}.` : ""}`);
  } finally {
    setBusy(false);
  }
});

releaseForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (busy) return;
  const submitForReview = event.submitter && event.submitter.id === "artist-release-submit-review";
  const uploaded = [];
  let isSaved = false;
  let submissionAttempted = false;
  let submissionSucceeded = false;
  let cleanupFailures = [];
  let updateAttempted = false;
  let releaseId = "";
  setBusy(true);
  try {
    const title = releaseForm.elements.title.value.trim();
    const description = releaseForm.elements.description.value.trim();
    const genre = releaseForm.elements.genre.value.trim();
    const releaseType = releaseForm.elements.releaseType.value;
    const isAlbum = releaseType === "album";
    const saleMode = isAlbum ? releaseForm.elements.saleMode.value : "";
    const downloadPriceCents = !isAlbum || sellsAlbum(saleMode)
      ? priceCents(releaseForm.elements.downloadPrice.value) : null;
    if (isAlbum && sellsAlbum(saleMode) && downloadPriceCents === null) {
      throw new Error("Set a download price for the album.");
    }
    const moods = editingRelease ? editingRelease.moods || [] : [];
    const audio = releaseForm.elements.audio.files[0];
    const cover = releaseForm.elements.cover.files[0];
    const selectedTracks = isAlbum ? albumTracks.map((track) => ({
      ...track, title: track.title.trim(),
      downloadPriceCents: sellsTracks(saleMode) ? priceCents(track.price) : null
    })) : [];
    if (submitForReview) {
      if (!currentProfile || currentProfile.status !== "approved") throw new Error("Your artist profile must be approved before submitting.");
      if (!releaseForm.elements.reviewRights.checked) throw new Error("Confirm your rights before submitting this release.");
      if (!isAlbum && !audio && !(editingRelease && editingRelease.audioPath)) {
        throw new Error("Upload audio before submitting this release.");
      }
      if (isAlbum && !cover && !(editingRelease && editingRelease.coverPath)) {
        throw new Error("Upload album cover artwork before submitting.");
      }
    }
    if (isAlbum && (!selectedTracks.length || selectedTracks.length > 20)) {
      throw new Error("Choose between 1 and 20 songs for an album.");
    }
    for (const track of selectedTracks) {
      if (!track.title || track.title.length > 160) throw new Error("Enter a title for every album song.");
      if (sellsTracks(saleMode) && track.downloadPriceCents === null) throw new Error("Set a price for every album song.");
      if (track.file) { validateUpload(track.file, "audio"); extension(track.file, ["mp3", "wav"]); }
    }
    if (!isAlbum) validateUpload(audio, "audio");
    validateUpload(cover, "cover");

    let release = editingRelease;
    if (!release) {
      const created = await apiRequest("/api/artist-releases", {
        method: "POST",
        body: { action: "create", title, description, genre, downloadPriceCents, moods, releaseType,
          audioPath: "", coverPath: "", ...(isAlbum ? { saleMode, tracks: [] } : {}) }
      });
      release = created.release;
      editingRelease = release;
      releaseForm.elements.releaseType.disabled = true;
      document.querySelector("#artist-release-title").textContent = `Edit draft: ${release.title}`;
      document.querySelector("#artist-release-cancel").hidden = false;
    }
    releaseId = release.id;

    let audioPath = release.audioPath || "";
    let coverPath = release.coverPath || "";
    if (!isAlbum && audio) {
      audioPath = await uploadPrivateAsset(audio, "audio", currentUser.uid, release.id);
      uploaded.push(audioPath);
    }
    const tracks = [];
    for (const track of selectedTracks) {
      let trackPath = track.audioPath;
      if (track.file) {
        trackPath = await uploadPrivateAsset(track.file, "audio", currentUser.uid, release.id);
        uploaded.push(trackPath);
      }
      tracks.push({ id: track.id, title: track.title, audioPath: trackPath, downloadPriceCents: track.downloadPriceCents });
    }
    if (cover) {
      coverPath = await uploadPrivateAsset(cover, "cover", currentUser.uid, release.id);
      uploaded.push(coverPath);
    }
    updateAttempted = true;
    const saved = await apiRequest("/api/artist-releases", {
      method: "POST",
      body: { action: "update", id: release.id, title, description, genre, downloadPriceCents, moods, releaseType,
        audioPath, coverPath, ...(isAlbum ? { saleMode, tracks } : {}) }
    });
    isSaved = true;
    const oldPaths = [
      audio && release.audioPath && release.audioPath !== audioPath ? release.audioPath : "",
      cover && release.coverPath && release.coverPath !== coverPath ? release.coverPath : "",
      ...(isAlbum ? (release.tracks || []).filter((track) => !tracks.some((entry) => entry.audioPath === track.audioPath))
        .map((track) => track.audioPath) : [])
    ].filter(Boolean);
    cleanupFailures = await cleanupUploads(oldPaths);
    resetReleaseForm();
    if (submitForReview) {
      submissionAttempted = true;
      const hasSales = downloadPriceCents != null ||
        (isAlbum && sellsTracks(saleMode) && tracks.some((track) => track.downloadPriceCents != null));
      await apiRequest("/api/artist-releases", {
        method: "POST", body: { action: "submit", id: release.id, rightsConfirmed: true, salesRightsConfirmed: hasSales }
      });
      submissionSucceeded = true;
    }
    await loadReleases();
    const message = submitForReview
      ? "Release submitted for review. It remains private until approved."
      : `Draft saved: ${saved.release.title}. It remains private. Submit it for review from the list below when ready.`;
    showRelease(cleanupFailures.length ? `${message} Old uploads could not be removed: ${cleanupFailures.join(", ")}.` : message);
  } catch (error) {
    let preserveUploads = isSaved;
    let verificationError = "";
    if (!isSaved && updateAttempted && uploaded.length) {
      try {
        const data = await apiRequest("/api/artist-releases");
        const persisted = data.releases.find((entry) => entry.id === releaseId);
        const referenced = persisted ? [persisted.audioPath, persisted.coverPath,
          ...(persisted.tracks || []).map((track) => track.audioPath)] : [];
        preserveUploads = uploaded.some((path) => referenced.includes(path));
      } catch (verificationFailure) {
        preserveUploads = true;
        verificationError = ` Could not verify whether the draft saved; uploaded files were retained: ${verificationFailure.message}`;
      }
    }
    const failures = preserveUploads ? [] : await cleanupUploads(uploaded);
    showRelease(`${isSaved ? (submissionAttempted && !submissionSucceeded
      ? "Draft saved, but submission could not be confirmed. Refresh the release list before retrying. "
      : submissionSucceeded ? "Release submitted, but the release list could not be refreshed. "
        : "Draft saved, but the release list could not be refreshed. ") : ""}${error.message}${verificationError}${preserveUploads && !isSaved && !verificationError
      ? " Some uploaded files are referenced by the saved draft; refresh before retrying." : ""}${failures.length ? ` Upload cleanup failed for ${failures.join(", ")}.` : ""}${cleanupFailures.length ? ` Old uploads could not be removed: ${cleanupFailures.join(", ")}.` : ""}`);
    try { await loadReleases(); } catch (refreshError) { showRelease(`${status.textContent} Draft list refresh failed: ${refreshError.message}`); }
  } finally {
    setBusy(false);
  }
});
document.querySelector("#artist-release-cancel").addEventListener("click", resetReleaseForm);
document.querySelector("#artist-connect").addEventListener("click", async () => {
  if (busy) return;
  setBusy(true);
  try {
    const data = await apiRequest("/api/artist-releases?action=connect", { method: "POST" });
    location.assign(data.url);
  } catch (error) {
    show(error.message);
    setBusy(false);
  }
});
document.querySelector("#artist-connect-status").addEventListener("click", async () => {
  if (busy) return;
  setBusy(true);
  try {
    const data = await apiRequest("/api/artist-releases?action=connect");
    show(data.ready ? "Stripe is ready to accept payments and make payouts." :
      data.connected ? "Stripe onboarding or verification is incomplete. Continue setup to see requirements." :
        "Set up Stripe payouts before selling downloads or accepting contributions.");
  } catch (error) { show(error.message); }
  finally { setBusy(false); }
});

try {
  const [app, configResponse] = await Promise.all([
    firebaseClient(apiBase),
    fetch(`${apiBase}/api/music?action=config`)
  ]);
  const config = await configResponse.json();
  if (!configResponse.ok || !config.storageBucket) {
    throw new Error(config.error || "Music storage is not configured.");
  }
  auth = getAuth(app);
  storage = getStorage(app, `gs://${config.storageBucket}`);
  onAuthStateChanged(auth, async (user) => {
    const navLink = document.querySelector("#studio-profile-link");
    navLink.hidden = true;
    navLink.href = "";
    verificationGeneration++;
    verificationCheck = null;
    clearInterval(verificationTimer);
    verificationTimer = undefined;
    releaseLoad++;
    releaseCovers.clear();
    formCover.clear();
    for (const [kind, config] of Object.entries(imagePreviews)) {
      imagePreviewVersion[kind]++;
      config.manager.clear();
      document.querySelector(config.container).replaceChildren();
    }
    backgroundPreviewUrl = "";
    coverPreview.replaceChildren();
    releasesList.replaceChildren();
    if (currentUser !== user) {
      currentProfile = null;
      profileForm.reset();
      galleryFiles = [];
      document.querySelector("#artist-gallery-error").textContent = "";
      renderGallerySelection();
      if (bannerPreviewObjectUrl) URL.revokeObjectURL(bannerPreviewObjectUrl);
      bannerPreviewObjectUrl = "";
      updateBannerPreview("");
      updateStylePreview();
      resetReleaseForm();
    }
    currentUser = user;
    account.hidden = !user;
    authPanel.hidden = Boolean(user);
    if (!user) {
      currentProfile = null;
      profileForm.reset();
      resetReleaseForm();
      releasesList.replaceChildren();
      profileSection.hidden = true;
      releaseSection.hidden = true;
      show("Sign in or create an account to begin.");
      return;
    }
    await initializeAccount(user);
  });
} catch (error) {
  authPanel.hidden = false;
  show(error.message || "Artist authentication is unavailable.");
}
