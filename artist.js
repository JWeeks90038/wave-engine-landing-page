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

try {
  const slug = slugFromLocation();
  if (!/^[a-z0-9](?:[a-z0-9-]{1,28}[a-z0-9])$/.test(slug)) {
    throw new Error("Artist profile not found.");
  }
  const response = await fetch(`${apiBase}/api/artist-profile?slug=${encodeURIComponent(slug)}`, { cache: "no-store" });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Artist profile not found.");

  const profile = data.profile;
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
  const canonical = document.createElement("link");
  canonical.rel = "canonical";
  canonical.href = `${location.origin}/artist/${encodeURIComponent(profile.slug)}`;
  document.head.append(canonical);
  profileSection.hidden = false;
  status.textContent = "";
} catch (error) {
  status.textContent = error.message || "Artist profile not found.";
}
