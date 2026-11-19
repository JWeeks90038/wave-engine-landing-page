import { initializeApp } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-app.js";
import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-auth.js";

const apiConfig = document.querySelector('meta[name="apparel-api-base"]');
const isLocal = location.protocol === "file:" || ["localhost", "127.0.0.1"].includes(location.hostname);
const setting = (isLocal && apiConfig.dataset.localApiBase || apiConfig.content).trim();
const apiBase = setting.replace(/\/$/, "") || (isLocal ? "http://127.0.0.1:8787" : "");
const status = document.querySelector("#admin-status");
const login = document.querySelector("#admin-login");
const content = document.querySelector("#admin-content");
const rows = document.querySelector("#inventory-rows");
const sizes = ["S", "M", "L", "XL", "XXL"];
let auth;

async function api(method, body) {
  const token = await auth.currentUser.getIdToken();
  const response = await fetch(`${apiBase}/api/apparel-admin`, {
    method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Inventory request failed.");
  return data;
}

async function loadInventory() {
  status.textContent = "Loading inventory...";
  try {
    const data = await api("GET");
    rows.replaceChildren();
    document.querySelector("#admin-mode").textContent = `Stripe ${data.mode} inventory`;
    for (const product of data.products) {
      const row = document.createElement("tr");
      const name = document.createElement("th");
      name.scope = "row"; name.textContent = product.name; row.append(name);
      const inputs = {};
      for (const size of sizes) {
        const cell = document.createElement("td");
        const input = document.createElement("input");
        input.type = "number"; input.min = "0"; input.step = "1"; input.required = true;
        input.value = product.quantities[size];
        input.setAttribute("aria-label", `${product.name}, ${size} quantity`);
        inputs[size] = input; cell.append(input); row.append(cell);
      }
      const state = document.createElement("td");
      state.textContent = !product.initialized ? "Not set up" : !product.active ? "Inactive" :
        sizes.every((size) => product.quantities[size] === 0) ? "Sold Out" :
          `Sold out: ${sizes.filter((size) => product.quantities[size] === 0).join(", ") || "none"}`;
      const updated = document.createElement("td");
      updated.textContent = product.updatedAt ? new Date(product.updatedAt).toLocaleString() : "Never";
      const action = document.createElement("td");
      const save = document.createElement("button");
      save.type = "button"; save.className = "outline-button"; save.textContent = "Save";
      save.addEventListener("click", async () => {
        const quantities = {};
        for (const size of sizes) {
          const value = inputs[size].value;
          if (!value || !Number.isSafeInteger(Number(value)) || Number(value) < 0) {
            status.textContent = `Enter a non-negative whole number for ${size}.`;
            inputs[size].focus();
            return;
          }
          quantities[size] = Number(value);
        }
        save.disabled = true;
        try {
          await api("POST", { id: product.id, quantities, versions: product.versions });
          await loadInventory();
          status.textContent = `Inventory saved for ${product.name}.`;
        } catch (error) {
          status.textContent = error.message || "Inventory could not be saved.";
          save.disabled = false;
        }
      });
      action.append(save); row.append(state, updated, action); rows.append(row);
    }
    status.textContent = data.products.length ? "" : "No apparel products found.";
  } catch (error) {
    rows.replaceChildren();
    status.textContent = error.message || "Inventory could not be loaded.";
  }
}

try {
  const response = await fetch(`${apiBase}/api/apparel-firebase-config`);
  if (!response.ok) throw new Error("Firebase authentication is not configured.");
  auth = getAuth(initializeApp(await response.json()));
  login.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await signInWithEmailAndPassword(auth, login.elements.email.value, login.elements.password.value);
      login.elements.password.value = "";
    } catch (error) {
      status.textContent = "Sign-in failed. Check your credentials and try again.";
    }
  });
  document.querySelector("#admin-logout").addEventListener("click", () => signOut(auth));
  document.querySelector("#admin-refresh").addEventListener("click", loadInventory);
  onAuthStateChanged(auth, (user) => {
    login.hidden = Boolean(user);
    content.hidden = !user;
    if (user) loadInventory();
    else { rows.replaceChildren(); status.textContent = "Sign in with an administrator account."; }
  });
} catch (error) {
  status.textContent = error.message || "Authentication could not be loaded.";
}
