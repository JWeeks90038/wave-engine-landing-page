import { attachStreamCounter } from "./song-stream-counter.js";

const isLocal = location.protocol === "file:" || ["localhost", "127.0.0.1"].includes(location.hostname);
const apiBase = isLocal ? "http://127.0.0.1:8787" : "https://wave-engine-landing-page.vercel.app";
const status = document.querySelector("#music-status");
const tracks = document.querySelector("#music-tracks");
const players = [];

function fileUrl(id, format) {
  const query = new URLSearchParams({ action: "file", id, format });
  return `${apiBase}/api/music?${query}`;
}

async function purchaseTrack(id, button) {
  button.disabled = true;
  status.textContent = "Opening secure checkout...";
  try {
    const response = await fetch(`${apiBase}/api/music?action=checkout`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Music checkout is unavailable.");
    location.assign(data.url);
  } catch (error) {
    status.textContent = error.message || "Music checkout is unavailable. Please try again later.";
    button.disabled = false;
  }
}

function text(tag, value, className) {
  const element = document.createElement(tag);
  element.textContent = value || "";
  if (className) element.className = className;
  return element;
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "--:--";
  const total = Math.floor(seconds);
  const minutes = Math.floor(total / 60);
  const remaining = String(total % 60).padStart(2, "0");
  if (minutes < 60) return `${minutes}:${remaining}`;
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}:${remaining}`;
}

function renderTrack(track) {
  const card = document.createElement("article");
  card.className = "music-card";
  if (track.hasCover) {
    card.className += " has-cover";
    const cover = document.createElement("img");
    cover.src = fileUrl(track.id, "cover");
    cover.alt = `Cover artwork for ${track.title}`;
    cover.loading = "lazy";
    cover.className = "music-cover";
    card.append(cover);
  }
  const details = document.createElement("div");
  details.className = "music-details";
  details.append(text("h3", track.title), text("p", [track.artist, track.album].filter(Boolean).join(" · "), "music-meta"));
  if (track.description) details.append(text("p", track.description));
  if (track.duration) details.append(text("p", `Duration: ${track.duration}`, "music-meta"));
  const actions = document.createElement("div");
  actions.className = "music-actions";
  if (track.hasMp3 || track.hasWav) {
    const playerPanel = document.createElement("div");
    playerPanel.className = "music-player";
    playerPanel.hidden = true;
    const player = document.createElement("audio");
    player.preload = "none";
    player.hidden = true;
    attachStreamCounter(player, details, track.streamCount, `${apiBase}/api/music?action=count-stream`, { id: track.id });

    const controls = document.createElement("div");
    controls.className = "music-player-controls";
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "music-player-toggle";
    const icon = document.createElement("span");
    icon.className = "music-player-icon";
    icon.setAttribute("aria-hidden", "true");
    const toggleText = text("span", "Play");
    toggle.append(icon, toggleText);

    const timeline = document.createElement("div");
    timeline.className = "music-player-timeline";
    const progress = document.createElement("input");
    progress.type = "range";
    progress.className = "music-player-range";
    progress.min = "0";
    progress.max = "1000";
    progress.step = "1";
    progress.value = "0";
    progress.disabled = true;
    progress.setAttribute("aria-label", `Seek in ${track.title}`);
    const times = document.createElement("div");
    times.className = "music-player-times";
    const elapsed = text("span", "0:00");
    const duration = text("span", "--:--");
    duration.setAttribute("aria-label", "Duration");
    times.append(elapsed, duration);
    timeline.append(progress, times);
    controls.append(toggle, timeline);

    const options = document.createElement("div");
    options.className = "music-player-options";
    const mute = document.createElement("button");
    mute.type = "button";
    mute.className = "music-player-mute";
    const volume = document.createElement("input");
    volume.type = "range";
    volume.className = "music-player-range music-player-volume";
    volume.min = "0";
    volume.max = "1";
    volume.step = "0.05";
    volume.value = String(player.volume);
    volume.setAttribute("aria-label", `Volume for ${track.title}`);
    const speed = document.createElement("select");
    speed.className = "music-player-speed";
    speed.setAttribute("aria-label", `Playback speed for ${track.title}`);
    for (const rate of [0.75, 1, 1.25, 1.5, 2]) {
      const option = text("option", `${rate}x`);
      option.value = String(rate);
      if (rate === 1) option.selected = true;
      speed.append(option);
    }
    options.append(mute, volume, speed);

    function updatePlayback() {
      const playing = !player.paused && !player.ended;
      toggleText.textContent = playing ? "Pause" : "Play";
      toggle.className = playing ? "music-player-toggle is-playing" : "music-player-toggle";
      toggle.setAttribute("aria-label", `${playing ? "Pause" : "Play"} ${track.title}`);
    }
    function updateProgress() {
      const validDuration = Number.isFinite(player.duration) && player.duration > 0;
      const current = Number.isFinite(player.currentTime) ? player.currentTime : 0;
      const position = validDuration ? Math.min(1000, Math.max(0, current / player.duration * 1000)) : 0;
      progress.disabled = !validDuration;
      progress.value = String(position);
      progress.style.setProperty("--range-fill", `${position / 10}%`);
      elapsed.textContent = formatTime(current);
      duration.textContent = validDuration ? formatTime(player.duration) : "--:--";
      progress.setAttribute("aria-valuetext", `${elapsed.textContent} of ${duration.textContent}`);
    }
    function updateVolume() {
      const muted = player.muted || player.volume === 0;
      mute.textContent = muted ? "Unmute" : "Mute";
      mute.setAttribute("aria-label", `${muted ? "Unmute" : "Mute"} ${track.title}`);
      volume.value = String(player.muted ? 0 : player.volume);
      volume.style.setProperty("--range-fill", `${Number(volume.value) * 100}%`);
      volume.setAttribute("aria-valuetext", `${Math.round(Number(volume.value) * 100)}%`);
    }

    player.addEventListener("play", () => {
      for (const other of players) if (other.player !== player) other.player.pause();
      updatePlayback();
    });
    player.addEventListener("pause", updatePlayback);
    for (const event of ["loadedmetadata", "durationchange", "timeupdate", "emptied"]) {
      player.addEventListener(event, updateProgress);
    }
    player.addEventListener("volumechange", updateVolume);
    player.addEventListener("error", () => {
      status.textContent = `Unable to play ${track.title}. Please try again later.`;
    });
    async function playTrack(format) {
      const url = format
        ? fileUrl(track.id, format)
        : player.getAttribute("src") || fileUrl(track.id, track.hasMp3 ? "mp3" : "wav");
      if (player.getAttribute("src") !== url) {
        player.pause();
        player.src = url;
      }
      playerPanel.hidden = false;
      try { await player.play(); }
      catch { status.textContent = `Unable to play ${track.title}. Please select Listen to try again.`; }
    }
    toggle.addEventListener("click", () => {
      if (player.paused || player.ended) playTrack();
      else player.pause();
    });
    progress.addEventListener("input", () => {
      if (!Number.isFinite(player.duration) || player.duration <= 0) return;
      try {
        player.currentTime = Number(progress.value) / 1000 * player.duration;
        updateProgress();
      } catch {
        status.textContent = `Unable to seek in ${track.title}. Please try again.`;
      }
    });
    mute.addEventListener("click", () => {
      if (player.muted || player.volume === 0) {
        if (player.volume === 0) player.volume = 1;
        player.muted = false;
      } else {
        player.muted = true;
      }
    });
    volume.addEventListener("input", () => {
      player.volume = Number(volume.value);
      player.muted = false;
    });
    speed.addEventListener("change", () => { player.playbackRate = Number(speed.value); });
    updatePlayback();
    updateProgress();
    updateVolume();
    const playerIndex = players.length;
    players.push({ player, playTrack });
    player.addEventListener("ended", () => {
      updatePlayback();
      const next = players[playerIndex + 1];
      if (next) next.playTrack();
    });
    for (const option of ["mp3", "wav"]) {
      if (!track[option === "mp3" ? "hasMp3" : "hasWav"]) continue;
      const listen = document.createElement("button");
      listen.type = "button";
      listen.className = "cta-button cta-primary";
      listen.textContent = `Listen ${option.toUpperCase()}`;
      listen.addEventListener("click", () => playTrack(option));
      actions.append(listen);
    }
    const buy = document.createElement("button");
    buy.type = "button";
    buy.className = track.hasWav ? "cta-button music-download-wav" : "cta-button";
    const formats = [track.hasMp3 && "MP3", track.hasWav && "WAV"].filter(Boolean).join(" & ");
    buy.textContent = `Download ${formats}${track.hasWav ? "" : " - $1.49"}`;
    buy.addEventListener("click", () => purchaseTrack(track.id, buy));
    actions.append(buy);
    playerPanel.append(text("p", "Wave Engine Studio / Audio Player", "music-player-label"), controls, options, player);
    details.append(actions, playerPanel);
  }
  card.append(details);
  return card;
}

try {
  const response = await fetch(`${apiBase}/api/music?action=library`);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "The music library could not be loaded.");
  tracks.replaceChildren(...data.tracks.map(renderTrack));
  status.textContent = data.tracks.length ? "" : "No music is currently available.";
} catch (error) {
  status.textContent = error.message || "The music library could not be loaded.";
}
