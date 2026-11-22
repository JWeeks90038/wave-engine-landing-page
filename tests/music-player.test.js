const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

class Element {
  constructor(tagName) {
    this.tagName = tagName;
    this.children = [];
    this.attributes = {};
    this.listeners = {};
    this.paused = true;
    this.playCount = 0;
  }
  append(...elements) { this.children.push(...elements); }
  replaceChildren(...elements) { this.children = elements; }
  setAttribute(name, value) { this.attributes[name] = value; }
  getAttribute(name) { return this.attributes[name] || null; }
  set src(value) { this.setAttribute("src", value); }
  addEventListener(name, callback) {
    (this.listeners[name] ||= []).push(callback);
  }
  async dispatch(name) {
    for (const callback of this.listeners[name] || []) await callback();
    await new Promise((resolve) => setImmediate(resolve));
  }
  pause() { this.paused = true; }
  async play() {
    if (this.playFailure) throw new Error("Playback blocked");
    this.paused = false;
    this.playCount++;
    for (const callback of this.listeners.play || []) callback();
  }
}

function descendants(element, tagName) {
  return element.children.flatMap((child) => [
    ...(child.tagName === tagName ? [child] : []),
    ...descendants(child, tagName)
  ]);
}

async function loadLibrary(trackData) {
  const status = new Element("p");
  const tracks = new Element("div");
  const document = {
    querySelector: (selector) => selector === "#music-status" ? status : tracks,
    createElement: (tagName) => new Element(tagName)
  };
  const source = fs.readFileSync(path.join(__dirname, "..", "music.js"), "utf8");
  await vm.runInNewContext(`(async () => {\n${source}\n})()`, {
    document,
    location: { protocol: "https:", hostname: "example.com" },
    fetch: async () => ({ ok: true, json: async () => ({ tracks: trackData }) }),
    URLSearchParams
  });
  return { status, tracks, audio: descendants(tracks, "audio") };
}

test("finished tracks advance in library order, skipping unplayable tracks and stopping at the end", async () => {
  const { tracks, audio } = await loadLibrary([
    { id: "first", title: "First", hasMp3: true, hasWav: true },
    { id: "unavailable", title: "Unavailable" },
    { id: "second", title: "Second", hasWav: true },
    { id: "third", title: "Third", hasMp3: true, hasWav: true }
  ]);

  const buttons = descendants(tracks.children[0], "button");
  const secondPanel = descendants(tracks.children[2], "div").find((element) => element.className === "music-player");
  assert.equal(secondPanel.hidden, true);
  await buttons[0].dispatch("click");
  assert.match(audio[0].getAttribute("src"), /id=first&format=mp3/);
  await audio[0].dispatch("ended");
  assert.match(audio[1].getAttribute("src"), /id=second&format=wav/);
  assert.equal(audio[1].hidden, false);
  assert.equal(secondPanel.hidden, false);
  assert.equal(audio[1].controls, true);
  assert.equal(audio[0].paused, true);
  await audio[1].dispatch("ended");
  assert.match(audio[2].getAttribute("src"), /id=third&format=mp3/);
  assert.equal(audio[1].paused, true);
  await audio[2].dispatch("ended");
  assert.deepEqual(audio.map((player) => player.playCount), [1, 1, 1]);
});

test("automatic playback preserves a previously chosen format and reports playback failures", async () => {
  const { status, tracks, audio } = await loadLibrary([
    { id: "first", title: "First", hasMp3: true },
    { id: "second", title: "Second", hasMp3: true, hasWav: true }
  ]);
  const secondButtons = descendants(tracks.children[1], "button");
  await secondButtons[1].dispatch("click");
  await descendants(tracks.children[0], "button")[0].dispatch("click");
  await audio[0].dispatch("ended");
  assert.match(audio[1].getAttribute("src"), /id=second&format=wav/);
  audio[1].playFailure = true;
  await audio[0].dispatch("ended");
  assert.match(status.textContent, /Unable to play Second.*select Listen/);
});
