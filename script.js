const ctaButtons = document.querySelectorAll(".cta-button");
const embedFrames = document.querySelectorAll("iframe[data-placeholder]");
const coverCarouselTracks = document.querySelectorAll(".cover-carousel-track");

function isPlaceholderUrl(value) {
  return !value || value.includes("YOUR_");
}

function buildEmbedPlaceholder(title, message) {
  const placeholder = document.createElement("div");
  const heading = document.createElement("strong");
  const copy = document.createElement("p");

  placeholder.className = "embed-placeholder";
  heading.textContent = title;
  copy.textContent = message;

  placeholder.append(heading, copy);

  return placeholder;
}

function trackCtaClick(platform, destination) {
  console.log("CTA click", {
    platform,
    destination,
    timestamp: new Date().toISOString()
  });
}

function enhanceCoverCarousel(track) {
  if (!track || track.dataset.enhanced === "true") {
    return;
  }

  const motionPreference = window.matchMedia("(prefers-reduced-motion: reduce)");
  const originals = Array.from(track.children);

  if (!originals.length) {
    return;
  }

  const cloneFragment = document.createDocumentFragment();

  originals.forEach((item) => {
    const clone = item.cloneNode(true);
    const cloneImage = clone.querySelector("img");

    clone.dataset.clone = "true";
    clone.setAttribute("aria-hidden", "true");

    if (cloneImage) {
      cloneImage.alt = "";
      cloneImage.loading = "lazy";
    }

    cloneFragment.append(clone);
  });

  track.append(cloneFragment);
  track.dataset.enhanced = "true";

  let animationFrameId = 0;
  let previousTimestamp = 0;
  let offset = 0;
  let loopWidth = 0;
  const pixelsPerSecond = 22;

  function measureLoopWidth() {
    const firstClone = track.querySelector('[data-clone="true"]');

    if (!firstClone) {
      return;
    }

    loopWidth = firstClone.offsetLeft - track.firstElementChild.offsetLeft;

    if (loopWidth > 0) {
      offset %= loopWidth;
    }
  }

  function stop() {
    if (animationFrameId) {
      window.cancelAnimationFrame(animationFrameId);
      animationFrameId = 0;
    }

    previousTimestamp = 0;
    offset = 0;
    track.style.transform = "translate3d(0, 0, 0)";
  }

  function step(timestamp) {
    if (!loopWidth) {
      measureLoopWidth();
    }

    if (!loopWidth) {
      animationFrameId = window.requestAnimationFrame(step);
      return;
    }

    if (!previousTimestamp) {
      previousTimestamp = timestamp;
    }

    const deltaSeconds = (timestamp - previousTimestamp) / 1000;
    previousTimestamp = timestamp;
    offset = (offset + pixelsPerSecond * deltaSeconds) % loopWidth;
    track.style.transform = `translate3d(${-offset}px, 0, 0)`;
    animationFrameId = window.requestAnimationFrame(step);
  }

  function start() {
    if (motionPreference.matches || animationFrameId) {
      return;
    }

    measureLoopWidth();

    if (!loopWidth) {
      return;
    }

    animationFrameId = window.requestAnimationFrame(step);
  }

  function syncMotionPreference() {
    if (motionPreference.matches) {
      stop();
      return;
    }

    start();
  }

  const carouselImages = track.querySelectorAll("img");
  carouselImages.forEach((image) => {
    if (!image.complete) {
      image.addEventListener("load", measureLoopWidth, { once: true });
    }
  });

  if (typeof ResizeObserver === "function") {
    const resizeObserver = new ResizeObserver(() => {
      measureLoopWidth();
    });

    resizeObserver.observe(track);
  } else {
    window.addEventListener("resize", measureLoopWidth);
  }

  if (typeof motionPreference.addEventListener === "function") {
    motionPreference.addEventListener("change", syncMotionPreference);
  } else if (typeof motionPreference.addListener === "function") {
    motionPreference.addListener(syncMotionPreference);
  }

  start();
}

ctaButtons.forEach((button) => {
  button.addEventListener("click", () => {
    trackCtaClick(button.dataset.platform || "Unknown", button.href);
  });
});

embedFrames.forEach((frame) => {
  if (!isPlaceholderUrl(frame.getAttribute("src"))) {
    return;
  }

  const fallback = buildEmbedPlaceholder(
    frame.title,
    frame.dataset.placeholder || "Replace this placeholder URL to load the embed."
  );

  frame.replaceWith(fallback);
});

coverCarouselTracks.forEach((track) => {
  enhanceCoverCarousel(track);
});