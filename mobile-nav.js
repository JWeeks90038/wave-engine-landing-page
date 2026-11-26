for (const [index, nav] of Array.from(document.querySelectorAll(".site-nav")).entries()) {
  const links = nav.querySelector(".nav-links");
  if (!links) continue;

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "mobile-nav-toggle";
  toggle.setAttribute("aria-label", "Open navigation menu");
  toggle.setAttribute("aria-expanded", "false");
  if (!links.id) links.id = `mobile-navigation-${index + 1}`;
  toggle.setAttribute("aria-controls", links.id);
  for (let i = 0; i < 3; i++) toggle.append(document.createElement("span"));

  const backdrop = document.createElement("div");
  backdrop.className = "mobile-nav-backdrop";
  backdrop.hidden = true;
  backdrop.setAttribute("aria-hidden", "true");
  nav.insertBefore(toggle, links);
  nav.append(backdrop);

  const mobile = window.matchMedia("(max-width: 900px)");
  function close(restoreFocus = false) {
    if (!nav.classList.contains("mobile-nav-open")) return;
    nav.classList.remove("mobile-nav-open");
    document.body.classList.remove("mobile-nav-active");
    backdrop.hidden = true;
    toggle.setAttribute("aria-expanded", "false");
    toggle.setAttribute("aria-label", "Open navigation menu");
    if (restoreFocus && mobile.matches) toggle.focus();
  }
  toggle.addEventListener("click", () => {
    if (nav.classList.contains("mobile-nav-open")) return close();
    nav.classList.add("mobile-nav-open");
    document.body.classList.add("mobile-nav-active");
    backdrop.hidden = false;
    toggle.setAttribute("aria-expanded", "true");
    toggle.setAttribute("aria-label", "Close navigation menu");
    const first = Array.from(links.querySelectorAll("a")).find((link) => !link.hidden);
    if (first) first.focus();
  });
  backdrop.addEventListener("click", () => close(true));
  links.addEventListener("click", (event) => {
    if (event.target.closest("a")) close();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && nav.classList.contains("mobile-nav-open")) {
      event.preventDefault();
      close(true);
    }
  });
  document.addEventListener("focusin", (event) => {
    if (!nav.contains(event.target)) close();
  });
  mobile.addEventListener("change", () => { if (!mobile.matches) close(); });
  nav.classList.add("mobile-nav-ready");
}
