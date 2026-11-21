const isLocal = location.protocol === "file:" || ["localhost", "127.0.0.1"].includes(location.hostname);
const apiBase = isLocal ? "http://127.0.0.1:8787" : "https://wave-engine-landing-page.vercel.app";
const status = document.querySelector("#music-status");
const tracks = document.querySelector("#music-tracks");
const players = new Set();

function fileUrl(id, format, download = false) {
  const query = new URLSearchParams({ id, format });
  if (download) query.set("download", "1");
  return `${apiBase}/api/music-file?${query}`;
}

function text(tag, value, className) {
  const element = document.createElement(tag);
  element.textContent = value || "";
  if (className) element.className = className;
  return element;
}

function renderTrack(track) {
  const card = document.createElement("article");
  card.className = "music-card";
  if (track.hasCover) {
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
    const player = document.createElement("audio");
    player.controls = true;
    player.preload = "none";
    player.hidden = true;
    player.setAttribute("aria-label", `Audio player for ${track.title}`);
    player.addEventListener("play", () => {
      for (const other of players) if (other !== player) other.pause();
    });
    player.addEventListener("error", () => {
      status.textContent = `Unable to play ${track.title}. Please try again later.`;
    });
    players.add(player);
    for (const option of ["mp3", "wav"]) {
      if (!track[option === "mp3" ? "hasMp3" : "hasWav"]) continue;
      const listen = document.createElement("button");
      listen.type = "button";
      listen.className = "cta-button cta-primary";
      listen.textContent = `Listen ${option.toUpperCase()}`;
      listen.addEventListener("click", async () => {
        const url = fileUrl(track.id, option);
        if (player.getAttribute("src") !== url) {
          player.pause();
          player.src = url;
        }
        player.hidden = false;
        try { await player.play(); }
        catch { status.textContent = `Unable to play ${track.title}. Please try again later.`; }
      });
      actions.append(listen);
      const link = document.createElement("a");
      link.className = "cta-button";
      link.href = fileUrl(track.id, option, true);
      link.textContent = `Download ${option.toUpperCase()}`;
      actions.append(link);
    }
    details.append(actions, player);
  }
  card.append(details);
  return card;
}

try {
  const response = await fetch(`${apiBase}/api/music-library`);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "The music library could not be loaded.");
  tracks.replaceChildren(...data.tracks.map(renderTrack));
  status.textContent = data.tracks.length ? "" : "No music is currently available.";
} catch (error) {
  status.textContent = error.message || "The music library could not be loaded.";
}
