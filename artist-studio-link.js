import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-auth.js";
import { firebaseClient } from "./firebase-client.js";

const link = document.querySelector("#storefront-studio-link");
const isLocal = location.protocol === "file:" || ["localhost", "127.0.0.1"].includes(location.hostname);
const apiBase = isLocal ? "http://127.0.0.1:8787" :
  location.hostname.endsWith(".vercel.app") ? location.origin : "https://wave-engine-landing-page.vercel.app";
const parts = location.pathname.split("/").filter(Boolean);
const slug = (parts[0] === "artist" ? parts[1] : "") || new URLSearchParams(location.search).get("slug") || "";

try {
  const auth = getAuth(await firebaseClient(apiBase));
  let generation = 0;
  onAuthStateChanged(auth, async (user) => {
    const request = ++generation;
    link.hidden = true;
    if (!user || !user.emailVerified) return;
    try {
      const token = await user.getIdToken();
      if (request !== generation || auth.currentUser !== user) return;
      const response = await fetch(`${apiBase}/api/artist-profile?me=1`, {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store"
      });
      if (response.status === 404) return;
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Artist profile could not be checked.");
      if (request === generation && auth.currentUser === user && data.profile.slug === slug) link.hidden = false;
    } catch (error) {
      if (request === generation) console.error("Artist Studio link could not be checked:", error);
    }
  });
} catch (error) {
  console.error("Artist Studio sign-in status could not be checked:", error);
}
