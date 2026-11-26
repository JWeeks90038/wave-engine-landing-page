const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

async function setup({ pathname = "/artist/north-star", search = "", fetchProfile } = {}) {
  const source = fs.readFileSync(path.join(__dirname, "..", "artist-studio-link.js"), "utf8")
    .replace(/^import .*?;\r?\n/gm, "");
  const link = { hidden: true };
  const auth = { currentUser: null };
  const requests = [];
  const errors = [];
  let onAuth;
  await vm.runInNewContext(`(async () => {\n${source}\n})()`, {
    document: { querySelector: () => link },
    location: { protocol: "https:", hostname: "example.com", pathname, search },
    URLSearchParams,
    firebaseClient: async () => ({}),
    getAuth: () => auth,
    onAuthStateChanged: (_auth, callback) => { onAuth = callback; },
    fetch: async (url, options) => {
      requests.push({ url, options });
      return fetchProfile();
    },
    console: { error: (...args) => errors.push(args) }
  });
  return {
    link, requests, errors,
    setUser(user) { auth.currentUser = user; return onAuth(user); }
  };
}

function user() {
  return { emailVerified: true, getIdToken: async () => "test-token" };
}

test("only the signed-in owner sees the Artist Studio link on their storefront", async () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "artist.html"), "utf8");
  assert.match(html, /<a id="storefront-studio-link" href="\/artist-dashboard" hidden>Artist Studio<\/a>/);
  const dashboard = fs.readFileSync(path.join(__dirname, "..", "artist-dashboard.html"), "utf8");
  assert.match(dashboard, /<a id="studio-profile-link" hidden>Artist Profile<\/a>/);
  const page = await setup({
    fetchProfile: async () => ({ ok: true, json: async () => ({ profile: { slug: "north-star" } }) })
  });
  await page.setUser(null);
  assert.equal(page.link.hidden, true);
  await page.setUser({ emailVerified: false });
  assert.equal(page.requests.length, 0);
  await page.setUser(user());
  assert.equal(page.link.hidden, false);
  assert.match(page.requests[0].url, /\/api\/artist-profile\?me=1$/);
  assert.equal(page.requests[0].options.headers.Authorization, "Bearer test-token");
  await page.setUser(null);
  assert.equal(page.link.hidden, true);

  const queryPage = await setup({
    pathname: "/artist.html", search: "?slug=north-star",
    fetchProfile: async () => ({ ok: true, json: async () => ({ profile: { slug: "north-star" } }) })
  });
  await queryPage.setUser(user());
  assert.equal(queryPage.link.hidden, false);

  const other = await setup({
    pathname: "/artist.html", search: "?slug=another-artist",
    fetchProfile: async () => ({ ok: true, json: async () => ({ profile: { slug: "north-star" } }) })
  });
  await other.setUser(user());
  assert.equal(other.link.hidden, true);
  const noProfile = await setup({ fetchProfile: async () => ({ ok: false, status: 404 }) });
  await noProfile.setUser(user());
  assert.equal(noProfile.link.hidden, true);
});

test("profile lookup failures and stale responses do not reveal the link", async () => {
  const failure = await setup({ fetchProfile: async () => { throw new Error("offline"); } });
  await failure.setUser(user());
  assert.equal(failure.link.hidden, true);
  assert.equal(failure.errors.length, 1);

  let resolveResponse;
  const page = await setup({ fetchProfile: () => new Promise((resolve) => { resolveResponse = resolve; }) });
  const pending = page.setUser(user());
  await new Promise((resolve) => setImmediate(resolve));
  await page.setUser(null);
  resolveResponse({ ok: true, json: async () => ({ profile: { slug: "north-star" } }) });
  await pending;
  assert.equal(page.link.hidden, true);

  let resolveToken;
  const switching = await setup({ fetchProfile: async () => { throw new Error("Unexpected request"); } });
  const waitingForToken = switching.setUser({
    emailVerified: true, getIdToken: () => new Promise((resolve) => { resolveToken = resolve; })
  });
  await switching.setUser(null);
  resolveToken("test-token");
  await waitingForToken;
  assert.equal(switching.requests.length, 0);
  assert.equal(switching.link.hidden, true);
});
