export function attachStreamCounter(audio, container, count, url, body) {
  const label = document.createElement("p");
  label.className = "song-stream-count";
  label.setAttribute("role", "status");
  function display(value) {
    label.textContent = Number.isSafeInteger(value) && value >= 0
      ? `${value.toLocaleString()} ${value === 1 ? "stream" : "streams"}`
      : "Stream count unavailable";
  }
  display(count);
  container.append(label);

  let lastTime;
  let lastWall;
  let lastRate;
  let listening = 0;
  let heard = 0;
  let counted = false;
  let finished = false;
  let shortEligible = true;
  let displayedCount = Number.isSafeInteger(count) && count >= 0 ? count : 0;
  let requestNumber = 0;
  let latestSettled = 0;

  function anchor() {
    lastTime = audio.currentTime;
    lastWall = performance.now() / 1000;
    lastRate = audio.playbackRate;
  }
  function advance() {
    const now = performance.now() / 1000;
    const delta = audio.currentTime - lastTime;
    const elapsed = now - lastWall;
    if (Number.isFinite(lastRate) && lastRate > 0 &&
        Number.isFinite(delta) && Number.isFinite(elapsed) && delta > 0 && elapsed >= 0 &&
        delta <= elapsed * lastRate + 0.5) {
      heard += delta;
      listening += Math.min(elapsed, delta / lastRate);
    }
    anchor();
  }
  async function record() {
    if (counted) return;
    counted = true;
    const requestId = ++requestNumber;
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        cache: "no-store"
      });
      const data = await response.json();
      if (!response.ok || !Number.isSafeInteger(data.count) || data.count < 0) {
        throw new Error(data.error || "Invalid stream count response.");
      }
      if (requestId < latestSettled) return;
      latestSettled = requestId;
      displayedCount = Math.max(displayedCount, data.count);
      display(displayedCount);
    } catch (error) {
      console.error("Stream count could not be updated:", error);
      if (requestId >= latestSettled) {
        latestSettled = requestId;
        label.textContent = "Stream count unavailable";
      }
    }
  }
  audio.addEventListener("playing", () => {
    if (finished) {
      listening = 0;
      heard = 0;
      counted = false;
      finished = false;
      shortEligible = audio.currentTime <= 0.05;
    } else if (lastTime === undefined && listening === 0 && heard === 0) {
      shortEligible = audio.currentTime <= 0.05;
    }
    anchor();
  });
  audio.addEventListener("timeupdate", () => {
    if (audio.paused || audio.seeking || lastTime === undefined) return;
    advance();
    if (listening >= 30) record();
  });
  audio.addEventListener("seeking", () => { lastTime = undefined; shortEligible = false; });
  audio.addEventListener("seeked", () => {
    if (audio.currentTime <= 0.05 && !counted) {
      heard = 0;
      shortEligible = true;
    }
    if (!audio.paused) anchor();
  });
  audio.addEventListener("ratechange", () => { if (!audio.paused && lastTime !== undefined) advance(); });
  audio.addEventListener("pause", () => {
    if (lastTime !== undefined && !audio.seeking) {
      advance();
      if (listening >= 30) record();
    }
    lastTime = undefined;
  });
  audio.addEventListener("ended", () => {
    if (lastTime !== undefined && !audio.seeking) advance();
    if (listening >= 30 || (shortEligible && Number.isFinite(audio.duration) && audio.duration > 0 &&
        audio.duration < 30 && heard >= audio.duration - Math.min(0.5, audio.duration * 0.05))) record();
    lastTime = undefined;
    finished = true;
  });
}
