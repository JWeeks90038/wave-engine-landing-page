const ctaButtons = document.querySelectorAll(".cta-button");
const embedFrames = document.querySelectorAll("iframe[data-placeholder]");

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