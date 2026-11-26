const status = document.querySelector("#storefront-status");
const profileSection = document.querySelector("#storefront-profile");
const isLocal = location.protocol === "file:" || ["localhost", "127.0.0.1"].includes(location.hostname);
const apiBase = isLocal ? "http://127.0.0.1:8787" :
  location.hostname.endsWith(".vercel.app") ? location.origin : "https://wave-engine-landing-page.vercel.app";

function slugFromLocation() {
  const parts = location.pathname.split("/").filter(Boolean);
  const pathSlug = parts[0] === "artist" ? parts[1] : "";
  return pathSlug || new URLSearchParams(location.search).get("slug") || "";
}

function addSocialLink(container, label, href) {
  if (!href) return;
  let url;
  try { url = new URL(href); }
  catch { return; }
  if (url.protocol !== "https:" || url.username || url.password) return;
  const link = document.createElement("a");
  link.href = url.href;
  link.textContent = label;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  container.append(link);
}

function contributionCents(value) {
  const match = /^(\d{1,6})(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!match) throw new Error("Enter an amount from $0.50 to $999,999.99 USD, with at most two decimal places.");
  const amount = Number(match[1]) * 100 + Number((match[2] || "").padEnd(2, "0"));
  if (amount < 50 || amount > 99999999) {
    throw new Error("Enter an amount from $0.50 to $999,999.99 USD.");
  }
  return amount;
}

function setupContributions(slug) {
  const form = document.querySelector("#artist-support-form");
  const message = document.querySelector("#artist-support-status");
  const button = form.querySelector('button[type="submit"]');
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (button.disabled) return;
    button.disabled = true;
    try {
      const amountCents = contributionCents(form.elements.amount.value);
      message.textContent = "Opening secure Stripe Checkout...";
      const response = await fetch(`${apiBase}/api/artist-releases?action=contribute`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug, amountCents }),
        cache: "no-store"
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Unable to start your contribution.");
      location.assign(data.url);
    } catch (error) {
      message.textContent = error.message || "Unable to start your contribution.";
      button.disabled = false;
    }
  });

  const params = new URLSearchParams(location.search);
  if (params.get("contribution") === "cancelled") {
    message.textContent = "Checkout cancelled. If you completed payment, check your Stripe receipt.";
  } else if (params.get("contribution") === "success") {
    message.textContent = "Confirming your contribution...";
    const query = new URLSearchParams({
      action: "contribution-status", slug, session_id: params.get("session_id") || ""
    });
    fetch(`${apiBase}/api/artist-releases?${query}`, { cache: "no-store", referrerPolicy: "no-referrer" })
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok || data.confirmed !== true) throw new Error(data.error || "Payment could not be verified.");
        message.textContent = "Thank you! Your contribution has been confirmed.";
      })
      .catch((error) => { message.textContent = `${error.message} Please contact support if you were charged.`; });
  }
}

function readableAccentText(color) {
  const channels = [1, 3, 5].map((offset) => {
    const channel = parseInt(color.slice(offset, offset + 2), 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2] > 0.179 ? "#000000" : "#ffffff";
}

function profileImageUrl(image) {
  const url = new URL(image.url, apiBase);
  if (url.origin !== new URL(apiBase).origin || url.pathname !== "/api/artist-media") {
    throw new Error("Artist image URL is invalid.");
  }
  return url.href;
}

function applyAppearance(profile) {
  const appearance = profile.appearance;
  const backgrounds = (profile.backgroundImages || []).map(profileImageUrl);
  const gallery = profile.galleryImages || [];
  if (appearance) {
    if (!/^#[0-9a-f]{6}$/i.test(appearance.accentColor) ||
        !/^#[0-9a-f]{6}$/i.test(appearance.backgroundColor) ||
        typeof appearance.featuredMessage !== "string") {
      throw new Error("Artist page appearance is invalid.");
    }
    document.body.style.setProperty("--artist-accent", appearance.accentColor);
    document.body.style.setProperty("--artist-accent-text", readableAccentText(appearance.accentColor));
    document.body.style.setProperty("--artist-page-color", appearance.backgroundColor);
    const featured = document.querySelector("#artist-featured-message");
    featured.querySelector("p").textContent = appearance.featuredMessage;
    featured.hidden = !appearance.featuredMessage;
  }
  if (appearance || backgrounds.length) document.body.classList.add("artist-custom-theme");
  if (backgrounds.length) {
    let position = 0;
    const showBackground = () => document.body.style.setProperty("--artist-page-image", `url(${JSON.stringify(backgrounds[position])})`);
    showBackground();
    if (backgrounds.length > 1) {
      const toggle = document.querySelector("#artist-background-toggle");
      const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
      let timer;
      function stop() {
        if (timer) clearInterval(timer);
        timer = undefined;
        toggle.textContent = "Play background slideshow";
      }
      function start() {
        if (timer) return;
        timer = setInterval(() => {
          position = (position + 1) % backgrounds.length;
          showBackground();
        }, 8000);
        toggle.textContent = "Pause background slideshow";
      }
      toggle.hidden = false;
      toggle.addEventListener("click", () => { if (timer) stop(); else start(); });
      reducedMotion.addEventListener("change", (event) => { if (event.matches) stop(); });
      if (reducedMotion.matches) stop(); else start();
    }
  }
  if (gallery.length) {
    const container = document.querySelector("#artist-gallery-images");
    gallery.forEach((photo, index) => {
      const image = document.createElement("img");
      image.src = profileImageUrl(photo);
      image.alt = `${profile.artistName} gallery image ${index + 1}`;
      image.loading = "lazy";
      container.append(image);
    });
    document.querySelector("#artist-gallery").hidden = false;
  }
}

try {
  const slug = slugFromLocation();
  if (!/^[a-z0-9](?:[a-z0-9-]{1,28}[a-z0-9])$/.test(slug)) {
    throw new Error("Artist profile not found.");
  }
  const response = await fetch(`${apiBase}/api/artist-profile?slug=${encodeURIComponent(slug)}`, { cache: "no-store" });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Artist profile not found.");

  const profile = data.profile;
  applyAppearance(profile);
  document.title = `${profile.artistName} | Wave Engine Music`;
  document.querySelector("#storefront-name").textContent = profile.artistName;
  document.querySelector("#storefront-bio").textContent = profile.biography || "";
  if (profile.avatarUrl) {
    const avatar = document.querySelector("#storefront-avatar");
    avatar.src = new URL(profile.avatarUrl, apiBase).href;
    avatar.alt = `${profile.artistName} profile`;
    avatar.hidden = false;
  }
  if (profile.bannerUrl) {
    const banner = document.querySelector("#storefront-banner");
    const bannerUrl = new URL(profile.bannerUrl, apiBase).href;
    banner.style.backgroundImage = `linear-gradient(90deg, rgba(5, 8, 22, 0.18), rgba(5, 8, 22, 0.78)), url("${bannerUrl}")`;
    const positionY = Number.isInteger(profile.bannerPositionY) ? profile.bannerPositionY : 50;
    banner.style.backgroundPosition = `center ${positionY}%`;
  }
  const socials = document.querySelector("#storefront-socials");
  for (const [key, label] of [["website", "Website"], ["instagram", "Instagram"], ["youtube", "YouTube"], ["tiktok", "TikTok"]]) {
    addSocialLink(socials, label, profile.socialLinks && profile.socialLinks[key]);
  }
  for (const selector of ['meta[property="og:title"]', 'meta[name="twitter:title"]']) {
    document.querySelector(selector).content = `${profile.artistName} | Wave Engine Music`;
  }
  for (const selector of ['meta[property="og:description"]', 'meta[name="description"]', 'meta[name="twitter:description"]']) {
    document.querySelector(selector).content = profile.biography || `Discover ${profile.artistName} on Wave Engine Music.`;
  }
  if (!document.querySelector('link[rel="canonical"]')) {
    const canonical = document.createElement("link");
    canonical.rel = "canonical";
    canonical.href = `${location.origin}/artist/${encodeURIComponent(profile.slug)}`;
    document.head.append(canonical);
  }
  profileSection.hidden = false;
  status.textContent = "";
  setupContributions(profile.slug);
} catch (error) {
  status.textContent = error.message || "Artist profile not found.";
}
