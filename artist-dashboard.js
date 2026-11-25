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
const genreSearch = document.querySelector("#artist-genre-search");
const genreSearchStatus = document.querySelector("#artist-genre-search-status");
const uploadSpecs = {
  avatar: { types: ["image/jpeg", "image/png", "image/webp"], max: 10 * 1024 * 1024 },
  banner: { types: ["image/jpeg", "image/png", "image/webp"], max: 10 * 1024 * 1024 },
  audio: { types: ["audio/mpeg", "audio/wav", "audio/x-wav"], max: 100 * 1024 * 1024 },
  cover: { types: ["image/jpeg", "image/png", "image/webp"], max: 10 * 1024 * 1024 }
};
let auth;
let storage;
let currentUser = null;
let currentProfile = null;
let editingRelease = null;
let busy = false;

function show(message) {
  status.textContent = message;
}

function setBusy(value) {
  busy = value;
  const blocked = currentProfile && ["rejected", "suspended"].includes(currentProfile.status);
  for (const control of profileForm.elements) control.disabled = value || Boolean(blocked);
  for (const button of account.querySelectorAll("button")) {
    if (!profileForm.contains(button)) button.disabled = value;
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

async function cleanupUploads(paths) {
  const errors = [];
  for (const path of paths) {
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
      instagram: String(values.get("instagram") || "").trim(),
      youtube: String(values.get("youtube") || "").trim(),
      tiktok: String(values.get("tiktok") || "").trim()
    }
  };
}

function renderProfile(profile) {
  currentProfile = profile;
  const blocked = ["rejected", "suspended"].includes(profile.status);
  profileSection.hidden = false;
  releaseSection.hidden = blocked;
  document.querySelector("#artist-profile-title").textContent =
    profile.status === "approved" ? "Your artist profile" : "Artist profile application";
  document.querySelector("#artist-profile-notice").textContent = blocked
    ? "This profile is not active. Contact Wave Engine support for assistance."
    : profile.status === "approved"
      ? "Your profile is approved. Submit saved tracks for review before they can be streamed."
      : "Your profile is private while it awaits administrator review.";
  profileForm.elements.artistName.value = profile.artistName;
  profileForm.elements.slug.value = profile.slug;
  profileForm.elements.slug.readOnly = true;
  profileForm.elements.biography.value = profile.biography || "";
  for (const field of ["website", "instagram", "youtube", "tiktok"]) {
    profileForm.elements[field].value = profile.socialLinks && profile.socialLinks[field] || "";
  }
  for (const control of profileForm.elements) control.disabled = blocked || busy;
  const link = document.querySelector("#artist-profile-link");
  link.replaceChildren();
  if (profile.status === "approved") {
    const anchor = document.createElement("a");
    anchor.href = `/artist/${encodeURIComponent(profile.slug)}`;
    anchor.textContent = `View your storefront: ${anchor.href}`;
    link.append(anchor);
  } else {
    link.textContent = "Your storefront will become public after approval.";
  }
}

async function loadProfile() {
  const data = await apiRequest("/api/artist-profile?me=1");
  if (data.tokenRefreshRequired) await currentUser.getIdToken(true);
  renderProfile(data.profile);
  await loadReleases();
}

async function loadReleases() {
  const data = await apiRequest("/api/artist-releases");
  releasesList.replaceChildren();
  for (const release of data.releases) {
    const card = document.createElement("article");
    const heading = document.createElement("h3");
    heading.textContent = release.title;
    const details = document.createElement("p");
    const labels = { draft: "Private draft", submitted: "Awaiting review", published: "Public streaming" };
    details.textContent = `${release.genre || "Genre not set"} · ${labels[release.status] || "Unknown status"}`;
    const files = document.createElement("p");
    files.textContent = [
      release.audioPath ? "Audio uploaded" : "Audio not uploaded",
      release.coverPath ? "Artwork uploaded" : "Artwork not uploaded"
    ].join(" · ");
    card.append(heading, details, files);
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
      if (currentProfile.status === "approved" && release.audioPath) {
        const label = document.createElement("label");
        label.className = "artist-rights-confirmation";
        const confirmation = document.createElement("input");
        confirmation.type = "checkbox";
        const text = document.createElement("span");
        text.textContent = release.downloadPriceCents == null
          ? "I confirm I have the rights to upload and publicly stream this track and authorize Wave Engine to host and stream it."
          : "I confirm I have the rights to upload, stream, and sell downloads of this track and authorize Wave Engine to host and deliver it.";
        label.append(confirmation, text);
        const submit = document.createElement("button");
        submit.type = "button";
        submit.className = "cta-button cta-primary";
        submit.textContent = "Submit saved track for review";
        submit.addEventListener("click", async () => {
          if (busy) return;
          if (!confirmation.checked) return show("Confirm your rights before submitting this track.");
          setBusy(true);
          try {
            await apiRequest("/api/artist-releases", {
              method: "POST", body: { action: "submit", id: release.id, rightsConfirmed: true,
                salesRightsConfirmed: release.downloadPriceCents != null }
            });
            if (editingRelease && editingRelease.id === release.id) resetReleaseForm();
            await loadReleases();
            show("Track submitted for review. It remains private until approved.");
          } catch (error) { show(error.message); }
          finally { setBusy(false); }
        });
        card.append(label, submit);
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
          show("Track returned to a private draft.");
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

function editDraft(release) {
  editingRelease = release;
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
  document.querySelector("#artist-release-title").textContent = `Edit draft: ${release.title}`;
  document.querySelector("#artist-release-cancel").hidden = false;
  releaseForm.scrollIntoView({ behavior: "smooth" });
}

function resetReleaseForm() {
  editingRelease = null;
  const oldGenre = releaseForm.elements.genre.querySelector("option[data-legacy-genre]");
  if (oldGenre) oldGenre.remove();
  releaseForm.reset();
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
  profileSection.hidden = true;
  releaseSection.hidden = true;

  if (!user.emailVerified) {
    show("Verify your email address to create an artist profile or upload drafts.");
    return;
  }
  try {
    await loadProfile();
    show("Artist Studio is ready. Drafts are private until approved for streaming.");
  } catch (error) {
    if (/No artist profile is registered/.test(error.message)) {
      currentProfile = null;
      setBusy(busy);
      profileSection.hidden = false;
      releaseSection.hidden = true;
      document.querySelector("#artist-profile-title").textContent = "Create your artist profile";
      document.querySelector("#artist-profile-notice").textContent = "Artist profiles are reviewed before they become public.";
      profileForm.elements.slug.readOnly = false;
      show("Create an artist profile to begin.");
      return;
    }
    show(error.message);
  }
}

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
document.querySelector("#artist-verify").addEventListener("click", async () => {
  try {
    await currentUser.reload();
    currentUser = auth.currentUser;
    await currentUser.getIdToken(true);
    await initializeAccount(currentUser);
  } catch (error) {
    show(`Email verification could not be checked: ${error.message}`);
  }
});

profileForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (busy) return;
  const uploaded = [];
  const creatingProfile = !currentProfile;
  let assetsSaved = false;
  const data = profileFormData();
  const files = {
    avatar: profileForm.elements.avatar.files[0],
    banner: profileForm.elements.banner.files[0]
  };
  setBusy(true);
  try {
    for (const [kind, file] of Object.entries(files)) validateUpload(file, kind);

    if (creatingProfile) {
      const created = await apiRequest("/api/artist-profile", {
        method: "POST",
        body: { action: "create", ...data }
      });
      currentProfile = created.profile;
      renderProfile(created.profile);
      if (created.tokenRefreshRequired) await currentUser.getIdToken(true);
    }

    const assetPaths = {};
    for (const [kind, file] of Object.entries(files)) {
      if (!file) continue;
      assetPaths[`${kind}Path`] = await uploadPrivateAsset(file, kind, currentUser.uid, "profile");
      uploaded.push(assetPaths[`${kind}Path`]);
    }

    let result = { profile: currentProfile, cleanupPaths: [] };
    if (!creatingProfile || uploaded.length) {
      result = await apiRequest("/api/artist-profile", {
        method: "POST",
        body: { action: "update", ...data, ...assetPaths }
      });
      renderProfile(result.profile);
    }
    assetsSaved = true;
    if (creatingProfile) await loadReleases();
    const cleanupFailures = await cleanupUploads(result.cleanupPaths || []);
    show(cleanupFailures.length
      ? `Profile saved, but old images could not be removed: ${cleanupFailures.join(", ")}`
      : result.profile.status === "approved" ? "Artist profile saved." : "Profile saved and awaiting review.");
  } catch (error) {
    const failures = assetsSaved ? [] : await cleanupUploads(uploaded);
    show(`${error.message}${failures.length ? ` Upload cleanup failed for ${failures.join(", ")}.` : ""}`);
  } finally {
    setBusy(false);
  }
});

releaseForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (busy) return;
  const uploaded = [];
  let isSaved = false;
  setBusy(true);
  try {
    const title = releaseForm.elements.title.value.trim();
    const description = releaseForm.elements.description.value.trim();
    const genre = releaseForm.elements.genre.value.trim();
    const rawPrice = releaseForm.elements.downloadPrice.value.trim();
    if (rawPrice && !/^\d+(?:\.\d{1,2})?$/.test(rawPrice)) throw new Error("Enter a valid download price.");
    const downloadPriceCents = rawPrice ? Math.round(Number(rawPrice) * 100) : null;
    if (downloadPriceCents !== null && (downloadPriceCents < 50 || downloadPriceCents > 10000)) {
      throw new Error("Download prices must be between $0.50 and $100.00.");
    }
    const moods = editingRelease ? editingRelease.moods || [] : [];
    const audio = releaseForm.elements.audio.files[0];
    const cover = releaseForm.elements.cover.files[0];
    validateUpload(audio, "audio");
    validateUpload(cover, "cover");

    let release = editingRelease;
    if (!release) {
      const created = await apiRequest("/api/artist-releases", {
        method: "POST",
        body: { action: "create", title, description, genre, downloadPriceCents, moods, releaseType: "single", audioPath: "", coverPath: "" }
      });
      release = created.release;
    }

    let audioPath = release.audioPath || "";
    let coverPath = release.coverPath || "";
    if (audio) {
      audioPath = await uploadPrivateAsset(audio, "audio", currentUser.uid, release.id);
      uploaded.push(audioPath);
    }
    if (cover) {
      coverPath = await uploadPrivateAsset(cover, "cover", currentUser.uid, release.id);
      uploaded.push(coverPath);
    }
    const saved = await apiRequest("/api/artist-releases", {
      method: "POST",
      body: { action: "update", id: release.id, title, description, genre, downloadPriceCents, moods, releaseType: "single", audioPath, coverPath }
    });
    isSaved = true;
    const oldPaths = [
      audio && release.audioPath && release.audioPath !== audioPath ? release.audioPath : "",
      cover && release.coverPath && release.coverPath !== coverPath ? release.coverPath : ""
    ].filter(Boolean);
    const cleanupFailures = await cleanupUploads(oldPaths);
    resetReleaseForm();
    await loadReleases();
    show(cleanupFailures.length
      ? `Draft saved, but old uploads could not be removed: ${cleanupFailures.join(", ")}`
      : `Draft saved: ${saved.release.title}. It remains private.`);
  } catch (error) {
    const failures = isSaved ? [] : await cleanupUploads(uploaded);
    show(`${error.message}${failures.length ? ` Upload cleanup failed for ${failures.join(", ")}.` : ""}`);
    try { await loadReleases(); } catch (refreshError) { show(`${status.textContent} Draft list refresh failed: ${refreshError.message}`); }
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
        "Set up Stripe payouts before selling downloads.");
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
