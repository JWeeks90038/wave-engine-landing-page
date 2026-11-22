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
    this.currentTime = 0;
    this.duration = NaN;
    this.volume = 1;
    this.muted = false;
    this.style = { setProperty() {} };
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
  pause() {
    this.paused = true;
    for (const callback of this.listeners.pause || []) callback();
  }
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

test("WAV download buttons omit the price while MP3-only downloads keep their label", async () => {
  const { tracks } = await loadLibrary([
    { id: "wav", title: "WAV", hasWav: true },
    { id: "both", title: "Both", hasMp3: true, hasWav: true },
    { id: "mp3", title: "MP3", hasMp3: true }
  ]);
  const download = (card) => descendants(card, "button").find((button) => button.textContent.startsWith("Download"));
  assert.equal(download(tracks.children[0]).textContent, "Download WAV");
  assert.equal(download(tracks.children[1]).textContent, "Download MP3 & WAV");
  assert.match(download(tracks.children[0]).className, /music-download-wav/);
  assert.match(download(tracks.children[1]).className, /music-download-wav/);
  assert.equal(download(tracks.children[2]).textContent, "Download MP3 - $1.49");
});

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
  assert.equal(audio[1].hidden, true);
  assert.equal(secondPanel.hidden, false);
  assert.equal(audio[0].paused, true);
  await audio[1].dispatch("ended");
  assert.match(audio[2].getAttribute("src"), /id=third&format=mp3/);
  assert.equal(audio[1].paused, true);
  await audio[2].dispatch("ended");
  assert.deepEqual(audio.map((player) => player.playCount), [1, 1, 1]);
});

test("custom controls support playback, seeking, volume, and speed", async () => {
  const { tracks, audio } = await loadLibrary([{ id: "first", title: "First", hasMp3: true }]);
  const card = tracks.children[0];
  const buttons = descendants(card, "button");
  const inputs = descendants(card, "input");
  const toggle = buttons.find((button) => button.className === "music-player-toggle");
  const mute = buttons.find((button) => button.className === "music-player-mute");
  const progress = inputs.find((input) => input.className === "music-player-range");
  const volume = inputs.find((input) => input.className === "music-player-range music-player-volume");
  const speed = descendants(card, "select")[0];
  assert.equal(progress.disabled, true);
  await buttons[0].dispatch("click");
  assert.equal(toggle.getAttribute("aria-label"), "Pause First");
  await toggle.dispatch("click");
  assert.equal(audio[0].paused, true);
  assert.equal(toggle.getAttribute("aria-label"), "Play First");
  await toggle.dispatch("click");
  assert.equal(audio[0].paused, false);

  audio[0].duration = 120;
  await audio[0].dispatch("loadedmetadata");
  assert.equal(progress.disabled, false);
  progress.value = "500";
  await progress.dispatch("input");
  assert.equal(audio[0].currentTime, 60);
  assert.equal(progress.getAttribute("aria-valuetext"), "1:00 of 2:00");

  volume.value = "0.5";
  await volume.dispatch("input");
  assert.equal(audio[0].volume, 0.5);
  await mute.dispatch("click");
  assert.equal(audio[0].muted, true);
  await mute.dispatch("click");
  assert.equal(audio[0].muted, false);
  speed.value = "1.5";
  await speed.dispatch("change");
  assert.equal(audio[0].playbackRate, 1.5);
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
