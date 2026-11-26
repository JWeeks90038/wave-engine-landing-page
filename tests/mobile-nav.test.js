const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.join(__dirname, "..");

function setup() {
  const documentEvents = {};
  const media = { matches: true, addEventListener(_name, callback) { this.change = callback; } };
  class Element {
    constructor() {
      this.events = {};
      this.attributes = {};
      this.children = [];
      this.classes = new Set();
      this.classList = {
        add: (name) => this.classes.add(name),
        remove: (name) => this.classes.delete(name),
        contains: (name) => this.classes.has(name)
      };
    }
    setAttribute(name, value) { this.attributes[name] = value; }
    append(element) { this.children.push(element); }
    insertBefore(element) { this.toggle = element; }
    addEventListener(name, callback) { this.events[name] = callback; }
    focus() { document.activeElement = this; }
  }
  const nav = new Element();
  const links = new Element();
  const hidden = new Element();
  hidden.hidden = true;
  const visible = new Element();
  visible.hidden = false;
  links.querySelectorAll = () => [hidden, visible];
  nav.querySelector = () => links;
  nav.contains = (target) => [nav.toggle, links, hidden, visible, ...nav.children].includes(target);
  const body = new Element();
  const document = {
    body, createElement: () => new Element(),
    querySelectorAll: () => [nav],
    addEventListener(name, callback) { documentEvents[name] = callback; }
  };
  vm.runInNewContext(fs.readFileSync(path.join(root, "mobile-nav.js"), "utf8"), {
    document, window: { matchMedia: () => media }
  });
  return { nav, links, toggle: nav.toggle, backdrop: nav.children[0], visible, body, document, documentEvents, media };
}

test("mobile navigation opens, focuses available links and closes on escape, backdrop and navigation", () => {
  const p = setup();
  assert.equal(p.toggle.attributes["aria-expanded"], "false");
  assert.equal(p.toggle.attributes["aria-controls"], "mobile-navigation-1");
  p.toggle.events.click();
  assert.equal(p.toggle.attributes["aria-expanded"], "true");
  assert.equal(p.backdrop.hidden, false);
  assert.equal(p.body.classList.contains("mobile-nav-active"), true);
  assert.equal(p.document.activeElement, p.visible);
  let prevented = false;
  p.documentEvents.keydown({ key: "Escape", preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(p.toggle.attributes["aria-expanded"], "false");
  assert.equal(p.document.activeElement, p.toggle);
  assert.equal(p.backdrop.hidden, true);

  p.toggle.events.click();
  p.backdrop.events.click();
  assert.equal(p.toggle.attributes["aria-expanded"], "false");
  p.toggle.events.click();
  p.links.events.click({ target: { closest: () => p.visible } });
  assert.equal(p.toggle.attributes["aria-expanded"], "false");
  p.toggle.events.click();
  p.media.matches = false;
  p.media.change();
  assert.equal(p.nav.classList.contains("mobile-nav-open"), false);
  assert.equal(p.body.classList.contains("mobile-nav-active"), false);
});

test("primary navigation pages load the shared progressive enhancement", () => {
  const pages = [...fs.readdirSync(root).filter((file) => file.endsWith(".html")), "legal\\policies.html"];
  for (const file of pages) {
    const html = fs.readFileSync(path.join(root, file), "utf8");
    if (!html.includes('class="topbar site-nav') && !html.includes('class="site-nav"')) continue;
    assert.match(html, /href="(?:\.\.\/)?mobile-nav\.css"/, file);
    assert.match(html, /defer src="(?:\.\.\/)?mobile-nav\.js"/, file);
    assert.match(html, /class="nav-links"/, file);
  }
});
