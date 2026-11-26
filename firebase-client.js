import { getApps, initializeApp } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-app.js";

// A named app gets its own Firebase Auth session, so admin and artist sign-ins don't overwrite each other.
export async function firebaseClient(apiBase, name = "[DEFAULT]") {
  const existing = getApps().find((app) => app.name === name);
  if (existing) return existing;
  const response = await fetch(`${apiBase}/api/apparel-firebase-config`);
  if (!response.ok) throw new Error("Firebase authentication is not configured.");
  return initializeApp(await response.json(), name);
}
