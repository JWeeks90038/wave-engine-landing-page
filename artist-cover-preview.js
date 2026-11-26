export function createCoverPreviews(apiBase, mode, getUser) {
  let version = 0;
  let urls = [];

  function clear() {
    version++;
    for (const url of urls) URL.revokeObjectURL(url);
    urls = [];
  }

  function elements(container, title, suffix = "cover artwork", label = "Cover artwork") {
    const image = document.createElement("img");
    image.className = "artist-release-cover";
    image.alt = `${title} ${suffix}`;
    image.hidden = true;
    const message = document.createElement("p");
    message.setAttribute("role", "status");
    image.addEventListener("error", () => {
      image.hidden = true;
      message.textContent = `${label} could not be displayed.`;
    });
    container.append(image, message);
    return { image, message };
  }

  function display(image, blob) {
    const url = URL.createObjectURL(blob);
    urls.push(url);
    image.src = url;
    image.hidden = false;
    return url;
  }

  async function load(container, title, url, label = "Cover artwork", suffix = "cover artwork") {
    const { image, message } = elements(container, title, suffix, label);
    message.textContent = `Loading ${label.toLowerCase()}...`;
    const currentVersion = version;
    const user = getUser();
    try {
      if (!user) throw new Error(`Sign in to view ${label.toLowerCase()}.`);
      const token = await user.getIdToken();
      if (currentVersion !== version || user !== getUser()) return;
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store"
      });
      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || `${label} could not be loaded.`);
      }
      const blob = await response.blob();
      if (currentVersion !== version || user !== getUser()) return;
      if (!["image/jpeg", "image/png", "image/webp"].includes(blob.type) ||
          !blob.size || blob.size > 10 * 1024 * 1024) {
        throw new Error(`${label} is invalid.`);
      }
      const objectUrl = display(image, blob);
      message.textContent = "";
      return objectUrl;
    } catch (error) {
      if (currentVersion === version && user === getUser()) {
        message.textContent = `${label} could not be loaded: ${error.message}`;
      }
    }
  }

  function add(container, release) {
    return load(container, release.title,
      `${apiBase}/api/artist-media?asset=cover&release=${encodeURIComponent(release.id)}&preview=${mode}`);
  }

  function addProfile(container, image, title) {
    const url = new URL(image.url, apiBase);
    url.searchParams.set("preview", mode);
    return load(container, title, url.href, "Profile image", "profile image");
  }

  function addLocal(container, file, title, suffix = "cover artwork") {
    const { image } = elements(container, title, suffix, suffix === "cover artwork" ? "Cover artwork" : "Image");
    return display(image, file);
  }

  return { add, addProfile, addLocal, clear };
}
