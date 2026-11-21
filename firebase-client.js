import { getApps, initializeApp } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-app.js";

export async function firebaseClient(apiBase) {
  if (getApps().length) return getApps()[0];
  const response = await fetch(`${apiBase}/api/apparel-firebase-config`);
  if (!response.ok) throw new Error("Firebase authentication is not configured.");
  return initializeApp(await response.json());
}
