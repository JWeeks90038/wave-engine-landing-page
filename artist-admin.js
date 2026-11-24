import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-auth.js";
import { firebaseClient } from "./firebase-client.js";

const isLocal = location.protocol === "file:" || ["localhost", "127.0.0.1"].includes(location.hostname);
const apiBase = isLocal ? "http://127.0.0.1:8787" :
  location.hostname.endsWith(".vercel.app") ? location.origin : "https://wave-engine-landing-page.vercel.app";
const status = document.querySelector("#artist-admin-status");
const login = document.querySelector("#artist-admin-login");
const content = document.querySelector("#artist-admin-content");
const applications = document.querySelector("#artist-applications");
let auth;
let currentUser;

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

function renderApplications(artists) {
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
    card.append(heading, link, biography, created, actions);
    applications.append(card);
  }
  if (!artists.length) applications.textContent = "No artist applications are waiting for review.";
}

async function loadApplications() {
  const data = await request("/api/artist-admin");
  renderApplications(data.artists);
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
  const app = await firebaseClient(apiBase);
  auth = getAuth(app);
  onAuthStateChanged(auth, async (user) => {
    currentUser = user;
    content.hidden = true;
    login.hidden = Boolean(user);
    if (!user) {
      show("Sign in with an administrator account.");
      return;
    }
    try {
      const token = await user.getIdTokenResult(true);
      if (token.claims.admin !== true) {
        await signOut(auth);
        show("Administrator access is required.");
        return;
      }
      content.hidden = false;
      await loadApplications();
      show("Review artist applications. Approval makes the artist profile public.");
    } catch (error) {
      show(`Unable to load applications: ${error.message}`);
    }
  });
} catch (error) {
  show(error.message || "Administrator authentication is unavailable.");
}
