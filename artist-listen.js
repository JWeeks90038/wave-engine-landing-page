const isLocal = location.protocol === "file:" || ["localhost", "127.0.0.1"].includes(location.hostname);
const apiBase = isLocal ? "http://127.0.0.1:8787" :
  location.hostname.endsWith(".vercel.app") ? location.origin : "https://wave-engine-landing-page.vercel.app";
const status = document.querySelector("#artist-discovery-status");
const list = document.querySelector("#artist-discovery-list");
const isProfile = Boolean(document.querySelector("#storefront-profile"));
const selection = document.querySelector("#artist-discovery-selection");

function element(tag, value, className) {
  const node = document.createElement(tag);
  if (value) node.textContent = value;
  if (className) node.className = className;
  return node;
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "--:--";
  const total = Math.floor(seconds);
  const minutes = Math.floor(total / 60);
  const remaining = String(total % 60).padStart(2, "0");
  if (minutes < 60) return `${minutes}:${remaining}`;
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}:${remaining}`;
}

function trackPlayer(track) {
  const container = document.createElement("div");
  container.className = "artist-public-track";
  const details = element("div", "", "music-details");
  details.append(element("h4", track.title));
  if (track.genre) details.append(element("p", track.genre, "music-meta"));

  const audio = document.createElement("audio");
  audio.preload = "none";
  audio.hidden = true;
  audio.src = `${apiBase}/api/artist-releases?action=stream&id=${encodeURIComponent(track.id)}`;
  audio.addEventListener("error", () => { status.textContent = `Unable to play ${track.title}. Please try again later.`; });

  const panel = element("div", "", "music-player");
  panel.hidden = true;
  const toggle = element("button", "", "music-player-toggle");
  toggle.type = "button";
  const icon = element("span", "", "music-player-icon");
  icon.setAttribute("aria-hidden", "true");
  const toggleText = element("span", "Play");
  toggle.append(icon, toggleText);
  const progress = element("input", "", "music-player-range");
  progress.type = "range";
  progress.min = "0";
  progress.max = "1000";
  progress.step = "1";
  progress.value = "0";
  progress.disabled = true;
  progress.setAttribute("aria-label", `Seek in ${track.title}`);
  const elapsed = element("span", "0:00");
  const duration = element("span", "--:--");
  const times = element("div", "", "music-player-times");
  times.append(elapsed, duration);
  const timeline = element("div", "", "music-player-timeline");
  timeline.append(progress, times);
  const controls = element("div", "", "music-player-controls");
  controls.append(toggle, timeline);

  const mute = element("button", "", "music-player-mute");
  mute.type = "button";
  const volume = element("input", "", "music-player-range music-player-volume");
  volume.type = "range";
  volume.min = "0";
  volume.max = "1";
  volume.step = "0.05";
  volume.value = String(audio.volume);
  volume.setAttribute("aria-label", `Volume for ${track.title}`);
  const speed = element("select", "", "music-player-speed");
  speed.setAttribute("aria-label", `Playback speed for ${track.title}`);
  for (const rate of [0.75, 1, 1.25, 1.5, 2]) {
    const option = element("option", `${rate}x`);
    option.value = String(rate);
    option.selected = rate === 1;
    speed.append(option);
  }
  const options = element("div", "", "music-player-options");
  options.append(mute, volume, speed);

  function updatePlayback() {
    const playing = !audio.paused && !audio.ended;
    toggleText.textContent = playing ? "Pause" : "Play";
    toggle.className = playing ? "music-player-toggle is-playing" : "music-player-toggle";
    toggle.setAttribute("aria-label", `${playing ? "Pause" : "Play"} ${track.title}`);
  }
  function updateProgress() {
    const valid = Number.isFinite(audio.duration) && audio.duration > 0;
    const current = Number.isFinite(audio.currentTime) ? audio.currentTime : 0;
    const position = valid ? Math.min(1000, Math.max(0, current / audio.duration * 1000)) : 0;
    progress.disabled = !valid;
    progress.value = String(position);
    progress.style.setProperty("--range-fill", `${position / 10}%`);
    elapsed.textContent = formatTime(current);
    duration.textContent = valid ? formatTime(audio.duration) : "--:--";
  }
  function updateVolume() {
    const muted = audio.muted || audio.volume === 0;
    mute.textContent = muted ? "Unmute" : "Mute";
    mute.setAttribute("aria-label", `${muted ? "Unmute" : "Mute"} ${track.title}`);
    volume.value = String(audio.muted ? 0 : audio.volume);
    volume.style.setProperty("--range-fill", `${Number(volume.value) * 100}%`);
  }
  async function play() {
    panel.hidden = false;
    try { await audio.play(); }
    catch { status.textContent = `Unable to play ${track.title}. Please select Listen to try again.`; }
  }
  audio.addEventListener("play", updatePlayback);
  audio.addEventListener("pause", updatePlayback);
  audio.addEventListener("ended", updatePlayback);
  for (const name of ["loadedmetadata", "durationchange", "timeupdate", "emptied"]) audio.addEventListener(name, updateProgress);
  audio.addEventListener("volumechange", updateVolume);
  toggle.addEventListener("click", () => { if (audio.paused || audio.ended) play(); else audio.pause(); });
  progress.addEventListener("input", () => {
    if (!Number.isFinite(audio.duration) || audio.duration <= 0) return;
    audio.currentTime = Number(progress.value) / 1000 * audio.duration;
    updateProgress();
  });
  mute.addEventListener("click", () => {
    if (audio.muted || audio.volume === 0) {
      if (audio.volume === 0) audio.volume = 1;
      audio.muted = false;
    } else {
      audio.muted = true;
    }
  });
  volume.addEventListener("input", () => { audio.volume = Number(volume.value); audio.muted = false; });
  speed.addEventListener("change", () => { audio.playbackRate = Number(speed.value); });
  updatePlayback();
  updateProgress();
  updateVolume();

  const actions = element("div", "", "music-actions");
  const listen = element("button", "Listen", "cta-button cta-primary");
  listen.type = "button";
  listen.addEventListener("click", play);
  actions.append(listen);
  panel.append(element("p", "Wave Engine Studio / Audio Player", "music-player-label"), controls, options, audio);
  details.append(actions, panel);
  container.append(details);

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
    actions.append(button);
  } else {
    const unavailable = element("button", "Download coming soon", "cta-button artist-download");
    unavailable.type = "button";
    unavailable.disabled = true;
    actions.append(unavailable);
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
