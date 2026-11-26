const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const origin = "https://example.com";
const pages = [
  ...fs.readdirSync(root).filter((file) => file.endsWith(".html")),
  "legal/policies.html"
];

function pageFile(pathname) {
  return path.join(root, pathname === "/" ? "index.html" : `${pathname.slice(1)}.html`);
}

test("internal page links use clean URLs that resolve to existing pages", () => {
  const config = JSON.parse(fs.readFileSync(path.join(root, "vercel.json"), "utf8"));
  assert.equal(config.cleanUrls, true);
  assert.equal(config.functions["api/artist-profile.js"].includeFiles, "artist.html");
  assert.ok(config.redirects.some((route) =>
    route.source === "/index.html" && route.destination === "/" && route.permanent
  ));
  assert.ok(config.rewrites.some((route) =>
    route.source === "/artist/:slug" && route.destination === "/api/artist-profile?page=1&slug=:slug"
  ));

  for (const file of pages) {
    const sourcePath = file === "index.html" ? "/" : `/${file.slice(0, -5)}`;
    const html = fs.readFileSync(path.join(root, file), "utf8");
    for (const match of html.matchAll(/<a\b[^>]*\bhref="([^"]+)"/g)) {
      const target = new URL(match[1], `${origin}${sourcePath}`);
      if (target.origin !== origin || match[1].startsWith("#")) continue;
      assert.equal(target.pathname.endsWith(".html"), false, `${file}: ${match[1]}`);
      assert.ok(fs.existsSync(pageFile(target.pathname)), `${file}: ${match[1]}`);
    }
  }
});

test("sitemap URLs match the pages' clean canonical URLs", () => {
  const sitemap = fs.readFileSync(path.join(root, "sitemap.xml"), "utf8");
  const seen = new Set();
  for (const match of sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)) {
    const url = new URL(match[1]);
    assert.equal(seen.has(url.href), false, `duplicate sitemap URL: ${url.href}`);
    seen.add(url.href);
    assert.equal(url.pathname.endsWith(".html"), false, url.href);
    const html = fs.readFileSync(pageFile(url.pathname), "utf8");
    assert.ok(html.includes(`rel="canonical" href="${url.href}"`), url.href);
    assert.doesNotMatch(html, /<meta\s+name=["']robots["']\s+content=["'][^"']*\bnoindex\b/i, url.href);
  }
});

test("artist support links to the fee terms without displaying them in the support section", () => {
  const artist = fs.readFileSync(path.join(root, "artist.html"), "utf8");
  const policy = fs.readFileSync(path.join(root, "legal", "policies.html"), "utf8");
  const support = /<section class="artist-support"[\s\S]*?<\/section>/.exec(artist);
  assert.ok(support);
  assert.match(support[0], /href="\/legal\/policies#artist-payments"/);
  assert.doesNotMatch(support[0], /Wave Engine receives 5%|Stripe processing fees are paid by the artist/i);
  assert.match(policy, /id="artist-payments"/);
  assert.match(policy, /5% of each artist contribution/);
});
