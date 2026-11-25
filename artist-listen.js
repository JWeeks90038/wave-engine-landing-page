const isLocal = location.protocol === "file:" || ["localhost", "127.0.0.1"].includes(location.hostname);
const apiBase = isLocal ? "http://127.0.0.1:8787" :
  location.hostname.endsWith(".vercel.app") ? location.origin : "https://wave-engine-landing-page.vercel.app";
const status = document.querySelector("#artist-discovery-status");
const list = document.querySelector("#artist-discovery-list");
const isProfile = Boolean(document.querySelector("#storefront-profile"));
const selection = document.querySelector("#artist-discovery-selection");

function trackPlayer(track) {
  const container = document.createElement("div");
  container.className = "artist-public-track";
  const title = document.createElement("p");
  title.textContent = track.title;
  const audio = document.createElement("audio");
  audio.controls = true;
  audio.preload = "none";
  audio.src = `${apiBase}/api/artist-releases?action=stream&id=${encodeURIComponent(track.id)}`;
  audio.setAttribute("aria-label", `Play ${track.title}`);
  audio.addEventListener("error", () => { status.textContent = `Unable to play ${track.title}. Please try again later.`; });
  container.append(title, audio);
  if (Number.isSafeInteger(track.downloadPriceCents)) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "cta-button artist-download";
    button.textContent = `Download $${(track.downloadPriceCents / 100).toFixed(2)}`;
    button.addEventListener("click", async () => {
      button.disabled = true;
      try {
        const response = await fetch(`${apiBase}/api/artist-releases?action=checkout`, {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: track.id })
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "Artist checkout is unavailable.");
        location.assign(data.url);
      } catch (error) {
        status.textContent = error.message || "Artist checkout is unavailable.";
        button.disabled = false;
      }
    });
    container.append(button);
  }
  return container;
}

document.addEventListener("play", (event) => {
  if (event.target.tagName !== "AUDIO") return;
  for (const audio of document.querySelectorAll("audio")) {
    if (audio !== event.target) audio.pause();
  }
}, true);

try {
  const response = await fetch(`${apiBase}/api/artist-releases?action=public`, { cache: "no-store" });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Artists could not be loaded.");
  if (isProfile) {
    const parts = location.pathname.split("/").filter(Boolean);
    const slug = parts[0] === "artist" ? parts[1] : new URLSearchParams(location.search).get("slug");
    const artist = data.artists.find((entry) => entry.slug === slug);
    list.replaceChildren(...(artist ? artist.tracks.map(trackPlayer) : []));
    status.textContent = artist && artist.tracks.length ? "" : "No tracks are currently available.";
  } else {
    let activeButton;
    function selectArtist(artist, button) {
      if (activeButton === button) return;
      if (activeButton) activeButton.setAttribute("aria-expanded", "false");
      activeButton = button;
      button.setAttribute("aria-expanded", "true");
      const heading = document.createElement("h3");
      heading.textContent = artist.artistName;
      const profile = document.createElement("a");
      profile.className = "artist-selection-link";
      profile.href = `/artist/${encodeURIComponent(artist.slug)}`;
      profile.textContent = "View artist profile";
      for (const audio of selection.querySelectorAll("audio")) audio.pause();
      selection.replaceChildren(heading, profile);
      if (artist.tracks.length) {
        selection.append(...artist.tracks.map(trackPlayer));
      }
      else {
        const empty = document.createElement("p");
        empty.textContent = "No tracks available yet.";
        selection.append(empty);
      }
      selection.hidden = false;
    }

    for (const artist of data.artists) {
      const card = document.createElement("article");
      card.className = "artist-bubble";
      const button = document.createElement("button");
      button.type = "button";
      button.className = "artist-bubble-profile";
      button.setAttribute("aria-expanded", "false");
      button.setAttribute("aria-controls", "artist-discovery-selection");
      if (artist.avatarUrl) {
        const image = document.createElement("img");
        image.src = new URL(artist.avatarUrl, apiBase).href;
        image.alt = "";
        image.loading = "lazy";
        button.append(image);
      } else {
        const placeholder = document.createElement("span");
        placeholder.className = "artist-bubble-placeholder";
        placeholder.setAttribute("aria-hidden", "true");
        placeholder.textContent = artist.artistName.charAt(0).toUpperCase();
        button.append(placeholder);
      }
      const name = document.createElement("span");
      name.className = "artist-bubble-name";
      name.textContent = artist.artistName;
      button.append(name);
      button.addEventListener("pointerenter", (event) => {
        if (event.pointerType === "mouse") selectArtist(artist, button);
      });
      button.addEventListener("focus", () => selectArtist(artist, button));
      button.addEventListener("click", () => selectArtist(artist, button));
      card.append(button);
      list.append(card);
    }
    status.textContent = data.artists.length ? "" : "No artist profiles are available yet.";
  }
} catch (error) {
  status.textContent = error.message || "Artists could not be loaded.";
}
