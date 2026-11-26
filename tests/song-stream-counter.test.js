const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function player({ duration = 90, fetchResponse } = {}) {
  let now = 0;
  const calls = [];
  const errors = [];
  const events = new Map();
  const audio = {
    currentTime: 0, duration, paused: true, seeking: false, playbackRate: 1,
    addEventListener(name, callback) {
      if (!events.has(name)) events.set(name, []);
      events.get(name).push(callback);
    }
  };
  const emit = (name) => { for (const callback of events.get(name) || []) callback(); };
  const label = { setAttribute() {} };
  const container = { append(node) { assert.equal(node, label); } };
  const source = fs.readFileSync(path.join(__dirname, "..", "song-stream-counter.js"), "utf8")
    .replace("export function attachStreamCounter", "function attachStreamCounter");
  const context = vm.createContext({
    document: { createElement: () => label },
    performance: { now: () => now * 1000 },
    fetch: async (...args) => {
      calls.push(args);
      return fetchResponse ? fetchResponse() : { ok: true, json: async () => ({ count: calls.length }) };
    },
    console: { error: (...args) => errors.push(args) }
  });
  vm.runInContext(source, context);
  context.attachStreamCounter(audio, container, 0, "/count", { id: "song-1" });
  return {
    audio, label, calls, errors,
    start() { audio.paused = false; emit("playing"); },
    progress(seconds, mediaSeconds = seconds * audio.playbackRate) {
      now += seconds;
      audio.currentTime += mediaSeconds;
      emit("timeupdate");
    },
    advanceWithoutUpdate(seconds) {
      now += seconds;
      audio.currentTime += seconds * audio.playbackRate;
    },
    pause() { audio.paused = true; emit("pause"); },
    seek(time) {
      audio.seeking = true;
      emit("seeking");
      audio.currentTime = time;
      audio.seeking = false;
      emit("seeked");
    },
    rate(value) { audio.playbackRate = value; emit("ratechange"); },
    end() { audio.paused = true; emit("pause"); emit("ended"); },
    settle: () => new Promise((resolve) => setImmediate(resolve))
  };
}

test("counts 30 seconds of listening once across pauses, seeks and speed changes", async () => {
  const p = player();
  p.start();
  p.progress(12);
  p.pause();
  p.start();
  p.seek(45);
  p.rate(2);
  p.progress(17, 34);
  assert.equal(p.calls.length, 0);
  p.progress(1, 2);
  await p.settle();
  assert.equal(p.calls.length, 1);
  assert.equal(p.label.textContent, "1 stream");
  assert.equal(JSON.parse(p.calls[0][1].body).id, "song-1");
  p.progress(1, 2);
  p.end();
  await p.settle();
  assert.equal(p.calls.length, 1);
  p.seek(0);
  p.rate(1);
  p.start();
  p.progress(30);
  await p.settle();
  assert.equal(p.calls.length, 2);
  assert.equal(p.label.textContent, "2 streams");
});

test("short songs count on completion, but not when skipped or sought to the end", async () => {
  const complete = player({ duration: 10 });
  complete.start();
  complete.advanceWithoutUpdate(10);
  complete.end();
  await complete.settle();
  assert.equal(complete.calls.length, 1);

  const skipped = player({ duration: 10 });
  skipped.start();
  skipped.progress(2);
  skipped.seek(10);
  skipped.end();
  assert.equal(skipped.calls.length, 0);

  const tiny = player({ duration: 0.1 });
  tiny.start();
  tiny.seek(0.1);
  tiny.end();
  assert.equal(tiny.calls.length, 0);

  const tinyComplete = player({ duration: 0.1 });
  tinyComplete.start();
  tinyComplete.advanceWithoutUpdate(0.1);
  tinyComplete.end();
  await tinyComplete.settle();
  assert.equal(tinyComplete.calls.length, 1);
});

test("a failed count is shown as unavailable and is not retried during the same play", async () => {
  const p = player({ fetchResponse: async () => { throw new Error("offline"); } });
  p.start();
  p.progress(30);
  await p.settle();
  assert.equal(p.label.textContent, "Stream count unavailable");
  assert.equal(p.errors.length, 1);
  p.progress(5);
  p.end();
  await p.settle();
  assert.equal(p.calls.length, 1);
});
