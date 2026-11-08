const apiSetting = document.querySelector('meta[name="apparel-api-base"]').content.trim();
const apiBase = apiSetting.replace(/\/$/, "") || (location.protocol === "file:" || ["localhost", "127.0.0.1"].includes(location.hostname) ? "http://127.0.0.1:8787" : "");
const storageKey = "wave-apparel-cart-v1";
const productsElement = document.querySelector("#products");
const cartItems = document.querySelector("#cart-items");
const cartNotice = document.querySelector("#cart-notice");
const checkoutButton = document.querySelector("#checkout");
const dialog = document.querySelector("#image-dialog");
let products = [];
let cart = [];
let busy = false;

function message(text) { cartNotice.textContent = text; }
function money(cents) { return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100); }
function productFor(item) { return products.find((product) => product.id === item.id); }
function hasPrice(product) { return Number.isSafeInteger(product.price) && product.price >= 0; }
function hasPreviewPrice(product) { return Number.isSafeInteger(product.previewPrice) && product.previewPrice >= 0; }
function validItem(item) {
  const product = item && productFor(item);
  return Boolean(product && product.colors.includes(item.color) && product.sizes.includes(item.size) &&
    Number.isInteger(item.quantity) && item.quantity >= 1 && item.quantity <= 20);
}
function saveCart() {
  try { localStorage.setItem(storageKey, JSON.stringify(cart)); }
  catch (error) { message("Your cart could not be saved in this browser; it may be lost when you leave."); }
}
function loadCart() {
  try {
    const saved = localStorage.getItem(storageKey);
    if (saved) {
      const parsed = JSON.parse(saved);
      if (!Array.isArray(parsed)) throw new Error("Invalid cart");
      cart = parsed;
    }
  } catch (error) {
    message("Your saved cart could not be loaded. Check your browser storage settings.");
  }
}
function renderCart() {
  cartItems.replaceChildren();
  let subtotal = 0;
  let count = 0;
  let invalid = false;
  let priceUnavailable = false;
  cart.forEach((item, index) => {
    const row = document.createElement("div");
    row.className = "cart-item";
    const details = document.createElement("div");
    const name = document.createElement("strong");
    const variant = document.createElement("p");
    if (validItem(item)) {
      const product = productFor(item);
      name.textContent = product.name;
      if (hasPrice(product)) {
        variant.textContent = `${item.color} / ${item.size} · ${money(product.price)} each`;
        subtotal += product.price * item.quantity;
      } else {
        variant.textContent = hasPreviewPrice(product)
          ? `${item.color} / ${item.size} · ${money(product.previewPrice)} each (unverified preview price). Checkout requires a verified price.`
          : `${item.color} / ${item.size} · Price unavailable. Checkout requires a verified price.`;
        priceUnavailable = true;
      }
      count += item.quantity;
    } else {
      invalid = true;
      name.textContent = "Unavailable cart item";
      variant.textContent = "Remove this item before checkout.";
    }
    details.append(name, variant);
    row.append(details);
    if (validItem(item)) {
      const label = document.createElement("label");
      label.textContent = "Quantity";
      const input = document.createElement("input");
      input.type = "number"; input.min = "1"; input.max = "20"; input.value = item.quantity;
      input.setAttribute("aria-label", `Quantity for ${productFor(item).name}, ${item.color}, ${item.size}`);
      input.addEventListener("change", () => {
        const quantity = Number(input.value);
        if (!input.value || !Number.isInteger(quantity) || quantity < 1 || quantity > 20) {
          message("Choose a quantity between 1 and 20.");
          input.value = item.quantity;
          return;
        }
        item.quantity = quantity;
        message("");
        saveCart(); renderCart();
      });
      label.append(input); row.append(label);
    }
    const remove = document.createElement("button");
    remove.type = "button"; remove.className = "remove-item"; remove.textContent = "Remove";
    remove.setAttribute("aria-label", `Remove ${name.textContent} ${validItem(item) ? `${item.color} ${item.size}` : ""}`);
    remove.addEventListener("click", () => { cart.splice(index, 1); message(""); saveCart(); renderCart(); });
    row.append(remove); cartItems.append(row);
  });
  if (!cart.length) {
    const empty = document.createElement("p"); empty.textContent = "Your cart is empty."; cartItems.append(empty);
  }
  document.querySelector("#cart-count").textContent = count;
  document.querySelector("#cart-subtotal").textContent = priceUnavailable || invalid ? "Unavailable" : money(subtotal);
  checkoutButton.disabled = busy || !cart.length || invalid || priceUnavailable || !products.length;
}
function addItem(item) {
  const existing = cart.find((entry) => entry && entry.id === item.id && entry.size === item.size && entry.color === item.color);
  if (existing && (!validItem(existing) || existing.quantity + item.quantity > 20)) {
    message("Each size and color is limited to 20 items. Adjust the quantity in your cart.");
    return false;
  }
  if (existing) existing.quantity += item.quantity; else cart.push(item);
  message("Added to your cart.");
  saveCart(); renderCart();
  return true;
}
async function checkout(items, feedback) {
  if (busy) return;
  function checkoutMessage(text) { message(text); if (feedback) feedback.textContent = text; }
  busy = true; renderCart(); checkoutMessage("Opening secure Stripe checkout...");
  try {
    const response = await fetch(`${apiBase}/api/apparel-checkout`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ items })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Checkout could not be started.");
    const checkoutUrl = new URL(result.url);
    if (checkoutUrl.protocol !== "https:" || checkoutUrl.hostname !== "checkout.stripe.com") throw new Error("Invalid checkout destination.");
    location.assign(checkoutUrl.href);
  } catch (error) {
    checkoutMessage(error.message || "Checkout could not be started. Please try again.");
    busy = false; renderCart();
  }
}
function renderProduct(product) {
  const card = document.querySelector("#product-template").content.firstElementChild.cloneNode(true);
  card.querySelector("h3").textContent = product.name;
  card.querySelector(".product-description").textContent = product.description;
  card.querySelector(".product-price").textContent = hasPrice(product)
    ? money(product.price)
    : hasPreviewPrice(product)
      ? `${money(product.previewPrice)} (unverified preview price)`
      : "Price temporarily unavailable";
  card.querySelector(".product-disclaimer").textContent = `${product.pricePlaceholder ? "Placeholder imagery and price." : ""} `;
  const mainImage = card.querySelector(".main-image img");
  const thumbs = card.querySelector(".thumbnails");
  product.images.forEach((image, index) => {
    const button = document.createElement("button");
    button.type = "button"; button.setAttribute("aria-label", `${product.name}: ${image.label}`);
    const thumbnail = document.createElement("img");
    thumbnail.src = image.src; thumbnail.alt = ""; thumbnail.loading = "lazy"; thumbnail.decoding = "async";
    button.append(thumbnail); thumbs.append(button);
    button.addEventListener("click", () => {
      mainImage.src = image.src; mainImage.alt = `${product.name}, ${image.label}`;
      thumbs.querySelectorAll("button").forEach((thumb) => thumb.setAttribute("aria-pressed", String(thumb === button)));
    });
    if (index === 0) button.click();
  });
  card.querySelector(".main-image").addEventListener("click", () => {
    const image = dialog.querySelector("img"); image.src = mainImage.src; image.alt = mainImage.alt;
    dialog.showModal();
  });
  const form = card.querySelector("form");
  if (!hasPrice(product)) {
    card.querySelector(".buy-now").disabled = true;
    card.querySelector(".product-feedback").textContent = "Checkout is unavailable until Stripe verifies the price.";
  }
  ["color", "size"].forEach((field) => {
    product[`${field}s`].forEach((value) => {
      const option = document.createElement("option"); option.value = value; option.textContent = value;
      form.elements[field].append(option);
    });
  });
  function selection() {
    if (!form.reportValidity()) return null;
    return { id: product.id, color: form.elements.color.value, size: form.elements.size.value, quantity: Number(form.elements.quantity.value) };
  }
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const item = selection();
    if (item && addItem(item)) document.querySelector("#cart").scrollIntoView({ behavior: "smooth" });
  });
  card.querySelector(".buy-now").addEventListener("click", () => {
    const item = selection(); if (item) checkout([item], card.querySelector(".product-feedback"));
  });
  productsElement.append(card);
}
dialog.querySelector(".dialog-close").addEventListener("click", () => dialog.close());
checkoutButton.addEventListener("click", () => checkout(cart));
loadCart();
renderCart();
fetch(`${apiBase}/api/apparel-catalog`)
  .then((response) => { if (!response.ok) throw new Error("The collection could not be loaded."); return response.json(); })
  .then((data) => {
    if (!Array.isArray(data.products)) throw new Error("The collection response was invalid.");
    document.querySelector("#store-mode").textContent = data.mode === "test" ? "TEST MODE: No real payments or orders." : "";
    products = data.products;
    products.forEach(renderProduct);
    document.querySelector("#catalog-status").textContent = products.length ? "" : "The collection is currently empty.";
    renderCart();
  })
  .catch(() => { document.querySelector("#catalog-status").textContent = "The collection is unavailable. Please try again later."; });
