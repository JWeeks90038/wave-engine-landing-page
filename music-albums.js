const isLocal = location.protocol === "file:" || ["localhost", "127.0.0.1"].includes(location.hostname);
const apiBase = isLocal ? "http://127.0.0.1:8787" :
  location.hostname.endsWith(".vercel.app") ? location.origin : "https://wave-engine-landing-page.vercel.app";
const status = document.querySelector("#music-albums-status");
const container = document.querySelector("#music-albums");

function renderAlbum(album) {
  const card = document.createElement("article");
  card.className = "music-card";
  const details = document.createElement("div");
  details.className = "music-details";
  const title = document.createElement("h3");
  title.textContent = album.title;
  const songs = document.createElement("p");
  songs.textContent = album.songTitles.join(" · ");
  const actions = document.createElement("div");
  actions.className = "music-actions";
  const buy = document.createElement("button");
  buy.type = "button";
  buy.className = "cta-button cta-primary";
  buy.textContent = `Download album - $${(album.priceCents / 100).toFixed(2)}`;
  buy.addEventListener("click", async () => {
    buy.disabled = true;
    status.textContent = "Opening secure checkout...";
    try {
      const response = await fetch(`${apiBase}/api/music?action=album-checkout`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: album.id })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Album checkout is unavailable.");
      location.assign(data.url);
    } catch (error) {
      status.textContent = error.message || "Album checkout is unavailable. Please try again later.";
      buy.disabled = false;
    }
  });
  actions.append(buy);
  details.append(title, songs, actions);
  card.append(details);
  return card;
}

try {
  const response = await fetch(`${apiBase}/api/music?action=albums`);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Albums could not be loaded.");
  container.replaceChildren(...data.albums.map(renderAlbum));
  status.textContent = data.albums.length ? "" : "No albums are currently available.";
} catch (error) {
  status.textContent = error.message || "Albums could not be loaded.";
}
