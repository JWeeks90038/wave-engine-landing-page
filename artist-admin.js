import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-auth.js";
import { firebaseClient } from "./firebase-client.js";
import { createCoverPreviews } from "./artist-cover-preview.js";

const isLocal = location.protocol === "file:" || ["localhost", "127.0.0.1"].includes(location.hostname);
const apiBase = isLocal ? "http://127.0.0.1:8787" :
  location.hostname.endsWith(".vercel.app") ? location.origin : "https://wave-engine-landing-page.vercel.app";
const status = document.querySelector("#artist-admin-status");
const login = document.querySelector("#artist-admin-login");
const content = document.querySelector("#artist-admin-content");
const applications = document.querySelector("#artist-applications");
const releaseReviews = document.querySelector("#artist-release-reviews");
let auth;
let currentUser;
let reviewUrls = [];
let reviewLoad = 0;
const reviewCovers = createCoverPreviews(apiBase, "review", () => currentUser);
const reviewProfiles = createCoverPreviews(apiBase, "review", () => currentUser);

function show(message) {
  status.textContent = message;
}

async function request(path, method = "GET", body) {
  const headers = { Authorization: `Bearer ${await currentUser.getIdToken()}` };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(`${apiBase}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store"
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Artist review request failed.");
  return data;
}

async function loadReviewAudio(id, trackId, user) {
  const chunks = [];
  let start = 0;
  let total;
  let contentType;
  do {
    const response = await fetch(`${apiBase}/api/artist-releases?action=review&id=${encodeURIComponent(id)}` +
      (trackId ? `&track=${encodeURIComponent(trackId)}` : ""), {
      headers: {
        Authorization: `Bearer ${await user.getIdToken()}`,
        Range: `bytes=${start}-${start + 2 * 1024 * 1024 - 1}`
      },
      cache: "no-store"
    });
    if (!response.ok) {
      const data = await response.json();
      throw new Error(data.error || "The track could not be loaded for review.");
    }
    const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get("Content-Range") || "");
    if (response.status !== 206 || !range || Number(range[1]) !== start ||
        Number(range[2]) < start || Number(range[3]) > 100 * 1024 * 1024 ||
        (total !== undefined && total !== Number(range[3]))) {
      throw new Error("The review audio response was incomplete or invalid.");
    }
    total = Number(range[3]);
    const chunk = await response.blob();
    if (chunk.size !== Number(range[2]) - start + 1 || Number(range[2]) >= total) {
      throw new Error("The review audio response was incomplete or invalid.");
    }
    contentType = response.headers.get("Content-Type");
    chunks.push(chunk);
    start = Number(range[2]) + 1;
  } while (start < total);
  return new Blob(chunks, { type: contentType });
}

function renderApplications(artists) {
  reviewProfiles.clear();
  applications.replaceChildren();
  for (const artist of artists) {
    const card = document.createElement("article");
    const heading = document.createElement("h2");
    heading.textContent = artist.artistName;
    const link = document.createElement("p");
    link.textContent = `Requested URL: /artist/${artist.slug}`;
    const biography = document.createElement("p");
    biography.textContent = artist.biography || "No biography provided.";
    const created = document.createElement("p");
    created.textContent = artist.createdAt ? `Submitted ${new Date(artist.createdAt).toLocaleString()}` : "Submission date unavailable.";
    card.append(heading, link, biography, created);
    if (artist.appearance && artist.appearance.featuredMessage) {
      const message = document.createElement("p");
      message.textContent = `Featured message: ${artist.appearance.featuredMessage}`;
      card.append(message);
    }
    const images = [
      ...(artist.avatarUrl ? [{ url: artist.avatarUrl, label: "Profile" }] : []),
      ...(artist.bannerUrl ? [{ url: artist.bannerUrl, label: "Banner" }] : []),
      ...(artist.backgroundImages || []).map((image) => ({ ...image, label: "Background" })),
      ...(artist.galleryImages || []).map((image) => ({ ...image, label: "Gallery" }))
    ];
    for (const image of images) reviewProfiles.addProfile(card, image, image.label);
    const actions = document.createElement("div");
    actions.className = "music-actions";
    for (const actionName of ["approve", "reject"]) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = actionName === "approve" ? "cta-button cta-primary" : "cta-button";
      button.textContent = actionName === "approve" ? "Approve profile" : "Reject";
      button.addEventListener("click", async () => {
        if (button.disabled) return;
        button.disabled = true;
        try {
          await request("/api/artist-admin", "POST", { action: actionName, artistUid: artist.uid });
          await loadApplications();
          show(actionName === "approve" ? "Artist profile approved." : "Artist application rejected.");
        } catch (error) {
          button.disabled = false;
          show(error.message);
        }
      });
      actions.append(button);
    }
    card.append(actions);
    applications.append(card);
  }
  if (!artists.length) applications.textContent = "No artist applications are waiting for review.";
}

async function loadApplications() {
  const user = currentUser;
  const load = ++reviewLoad;
  const [profiles, tracks] = await Promise.all([
    request("/api/artist-admin"),
    request("/api/artist-admin?type=releases")
  ]);
  if (user !== currentUser || load !== reviewLoad) return;
  renderApplications(profiles.artists);
  renderReleases(tracks.releases);
}

function renderReleases(releases) {
  reviewCovers.clear();
  for (const url of reviewUrls) URL.revokeObjectURL(url);
  reviewUrls = [];
  releaseReviews.replaceChildren();
  for (const release of releases) {
    const isAlbum = release.releaseType === "album";
    const hasSales = release.downloadPriceCents != null ||
      (isAlbum && ["tracks", "both"].includes(release.saleMode) && release.tracks.some((track) => track.downloadPriceCents != null));
    const card = document.createElement("article");
    const heading = document.createElement("h3");
    heading.textContent = `${release.title} — ${release.artistName}`;
    const details = document.createElement("p");
    details.textContent = `${release.genre || "Genre not set"} · ${release.status === "submitted" ? "Awaiting review" : "Public streaming"}`;
    card.append(heading, details);
    if (release.hasCover) {
      reviewCovers.add(card, release);
    } else {
      const artwork = document.createElement("p");
      artwork.textContent = "No cover artwork uploaded.";
      card.append(artwork);
    }
    if (release.status === "submitted") {
      const rights = document.createElement("p");
      rights.textContent = release.rightsConfirmed
        ? "Artist confirmed the rights to upload and publicly stream this release."
        : "Rights confirmation is missing.";
      card.append(rights);
      if (hasSales) {
        const sale = document.createElement("p");
        sale.textContent = `${release.downloadPriceCents == null ? "Songs priced individually" :
          `Download price: $${(release.downloadPriceCents / 100).toFixed(2)}`}. ${
          release.salesRightsConfirmed ? "Artist confirmed rights to sell downloads." : "Sales rights confirmation is missing."
        }`;
        card.append(sale);
      }
      for (const track of isAlbum ? release.tracks : [{ title: release.title }]) {
        const preview = document.createElement("button");
        preview.type = "button";
        preview.className = "cta-button";
        preview.textContent = `Load ${track.title} for review` +
          (track.downloadPriceCents != null ? ` ($${(track.downloadPriceCents / 100).toFixed(2)})` : "");
        preview.addEventListener("click", async () => {
          preview.disabled = true;
          const user = currentUser;
          const load = reviewLoad;
          try {
            const audioBlob = await loadReviewAudio(release.id, track.id, user);
            if (user !== currentUser || load !== reviewLoad) return;
            const url = URL.createObjectURL(audioBlob);
            reviewUrls.push(url);
            const audio = document.createElement("audio");
            audio.controls = true;
            audio.src = url;
            audio.setAttribute("aria-label", `Review ${track.title}`);
            preview.after(audio);
            preview.remove();
          } catch (error) {
            preview.disabled = false;
            show(error.message);
          }
        });
        card.append(preview);
      }
    }
    const actions = document.createElement("div");
    actions.className = "music-actions";
    const choices = release.status === "submitted"
      ? [["approve-release", "Approve release"], ["reject-release", "Return to draft"]]
      : [["unpublish-release", "Remove from public streaming"]];
    for (const [action, label] of choices) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "cta-button";
      button.textContent = label;
      if (action === "approve-release" && (!release.artistApproved || !release.rightsConfirmed ||
          (hasSales && !release.salesRightsConfirmed))) button.disabled = true;
      button.addEventListener("click", async () => {
        button.disabled = true;
        try {
          await request("/api/artist-admin", "POST", { action, id: release.id });
          await loadApplications();
          show(action === "approve-release" ? "Release approved for public streaming." : "Release returned to a private draft.");
        } catch (error) {
          button.disabled = false;
          show(error.message);
        }
      });
      actions.append(button);
    }
    card.append(actions);
    releaseReviews.append(card);
  }
  if (!releases.length) releaseReviews.textContent = "No tracks are awaiting review or publicly streaming.";
}

document.querySelector("#artist-admin-login").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await signInWithEmailAndPassword(auth, login.elements.email.value, login.elements.password.value);
    login.elements.password.value = "";
  } catch (error) {
    show(`Sign-in failed: ${error.message}`);
  }
});
document.querySelector("#artist-admin-refresh").addEventListener("click", async () => {
  try {
    await loadApplications();
    show("Applications refreshed.");
  } catch (error) {
    show(error.message);
  }
});
document.querySelector("#artist-admin-logout").addEventListener("click", () => signOut(auth));

try {
  const app =   await firebaseClient(apiBase, "admin");
  auth = getAuth(app);
  onAuthStateChanged(auth, async (user) => {
    reviewLoad++;
    reviewCovers.clear();
    reviewProfiles.clear();
    for (const url of reviewUrls) URL.revokeObjectURL(url);
    reviewUrls = [];
    applications.replaceChildren();
    releaseReviews.replaceChildren();
    currentUser = user;
    content.hidden = true;
    login.hidden = Boolean(user);
    if (!user) {
      show("Sign in with an administrator account.");
      return;
    }
    try {
      const token = await user.getIdTokenResult(true);
      if (user !== currentUser) return;
      if (token.claims.admin !== true) {
        await signOut(auth);
        show("Administrator access is required.");
        return;
      }
      content.hidden = false;
      await loadApplications();
      if (user !== currentUser) return;
      show("Review artist applications and submitted releases before making them public.");
    } catch (error) {
      if (user !== currentUser) return;
      show(`Unable to load applications: ${error.message}`);
    }
  });
} catch (error) {
  show(error.message || "Administrator authentication is unavailable.");
}
