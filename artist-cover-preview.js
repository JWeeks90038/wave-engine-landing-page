export function createCoverPreviews(apiBase, mode, getUser) {
  let version = 0;
  let urls = [];

  function clear() {
    version++;
    for (const url of urls) URL.revokeObjectURL(url);
    urls = [];
  }

  function elements(container, title) {
    const image = document.createElement("img");
    image.className = "artist-release-cover";
    image.alt = `${title} cover artwork`;
    image.hidden = true;
    const message = document.createElement("p");
    message.setAttribute("role", "status");
    image.addEventListener("error", () => {
      image.hidden = true;
      message.textContent = "Cover artwork could not be displayed.";
    });
    container.append(image, message);
    return { image, message };
  }

  function display(image, blob) {
    const url = URL.createObjectURL(blob);
    urls.push(url);
    image.src = url;
    image.hidden = false;
  }

  async function add(container, release) {
    const { image, message } = elements(container, release.title);
    message.textContent = "Loading cover artwork...";
    const currentVersion = version;
    const user = getUser();
    try {
      if (!user) throw new Error("Sign in to view cover artwork.");
      const token = await user.getIdToken();
      if (currentVersion !== version || user !== getUser()) return;
      const response = await fetch(`${apiBase}/api/artist-media?asset=cover&release=${encodeURIComponent(release.id)}&preview=${mode}`, {
        headers: { Authorization: `Bearer ${token}` },
        cache: "no-store"
      });
      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || "Cover artwork could not be loaded.");
      }
      const blob = await response.blob();
      if (currentVersion !== version || user !== getUser()) return;
      if (!["image/jpeg", "image/png", "image/webp"].includes(blob.type) ||
          !blob.size || blob.size > 10 * 1024 * 1024) {
        throw new Error("Cover artwork is invalid.");
      }
      display(image, blob);
      message.textContent = "";
    } catch (error) {
      if (currentVersion === version && user === getUser()) {
        message.textContent = `Cover artwork could not be loaded: ${error.message}`;
      }
    }
  }

  function addLocal(container, file, title) {
    const { image } = elements(container, title);
    display(image, file);
  }

  return { add, addLocal, clear };
}
