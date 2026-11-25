const isLocal = location.protocol === "file:" || ["localhost", "127.0.0.1"].includes(location.hostname);
const apiBase = isLocal ? "http://127.0.0.1:8787" : "https://wave-engine-landing-page.vercel.app";
const status = document.querySelector("#purchase-status");
const downloads = document.querySelector("#purchase-downloads");
const sessionId = new URLSearchParams(location.search).get("session_id");
const artistPurchase = new URLSearchParams(location.search).get("artist_purchase");
const artistApiBase = !isLocal && location.hostname.endsWith(".vercel.app") ? location.origin : apiBase;

async function loadPurchase() {
  if (!sessionId) {
    status.textContent = "A checkout session was not provided. Payment could not be verified.";
    return;
  }
  try {
    if (artistPurchase) {
      const query = new URLSearchParams({ action: "purchase", purchase_id: artistPurchase, session_id: sessionId });
      const response = await fetch(`${artistApiBase}/api/artist-releases?${query}`, { cache: "no-store", referrerPolicy: "no-referrer" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Your purchase could not be loaded.");
      status.textContent = `Payment confirmed. Download ${data.title}:`;
      query.set("action", "download");
      const link = document.createElement("a");
      link.className = "cta-button";
      link.href = `${artistApiBase}/api/artist-releases?${query}`;
      link.rel = "noreferrer";
      link.textContent = `Download ${data.format.toUpperCase()}`;
      downloads.append(link);
      return;
    }
    const query = new URLSearchParams({ action: "purchase", session_id: sessionId });
    const response = await fetch(`${apiBase}/api/music?${query}`, { cache: "no-store", referrerPolicy: "no-referrer" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Your purchase could not be loaded.");
    status.textContent = `Payment confirmed. Download ${data.title}:`;
    for (const format of data.formats) {
      const params = new URLSearchParams({ action: "file", id: data.trackId, format, download: "1", session_id: sessionId });
      const link = document.createElement("a");
      link.className = "cta-button";
      link.href = `${apiBase}/api/music?${params}`;
      link.rel = "noreferrer";
      link.textContent = `Download ${format.toUpperCase()}`;
      downloads.append(link);
    }
  } catch (error) {
    status.textContent = error.message || "Your purchase could not be loaded. Please try again later.";
  }
}

loadPurchase();
