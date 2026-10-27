import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { earlyPayloadFor as macEarly } from "../macos/scripts/injector.mjs";
import { earlyPayloadFor as winEarly } from "../windows/scripts/injector.mjs";

const stateKey = "__CODEX_DREAM_SKIN_STATE__";
const appliedKey = "__CODEX_DREAM_SKIN_EARLY_APPLIED__";
const disabledKey = "__CODEX_DREAM_SKIN_DISABLED__";
const windowsSource = await fs.readFile(new URL("../windows/scripts/injector.mjs", import.meta.url), "utf8");

function fixture() {
  let visible = false;
  let nextId = 0;
  const listeners = new Set();
  const intervals = new Map();
  const timeouts = new Map();
  const root = { attributes: [], style: { *[Symbol.iterator]() {} } };
  const context = vm.createContext({
    window: { installs: [] },
    location: { protocol: "app:" },
    document: {
      documentElement: root,
      addEventListener(name, callback) { if (name === "DOMContentLoaded") listeners.add(callback); },
      removeEventListener(name, callback) { if (name === "DOMContentLoaded") listeners.delete(callback); },
      querySelector(selector) { return visible && (selector.startsWith("main:is(") || selector === "aside.app-shell-left-panel") ? {} : null; },
      querySelectorAll() { return []; },
      getElementById() { return null; },
    },
    setInterval(callback) { const id = ++nextId; intervals.set(id, callback); return id; },
    clearInterval(id) { intervals.delete(id); },
    setTimeout(callback) { const id = ++nextId; timeouts.set(id, callback); return id; },
    clearTimeout(id) { timeouts.delete(id); },
  });
  return {
    context, listeners, intervals, timeouts,
    show() { visible = true; },
    tick() { for (const callback of [...intervals.values()]) callback(); },
    domReady() { for (const callback of [...listeners]) callback(); },
    expire() { for (const callback of [...timeouts.values()]) callback(); },
  };
}

const payload = (name) => `
  window[${JSON.stringify(disabledKey)}] = false;
  window[${JSON.stringify(stateKey)}] = { installToken: {} };
  window.installs.push(${JSON.stringify(name)});
`;

for (const [platform, earlyPayloadFor] of [["macOS", macEarly], ["Windows", winEarly]]) {
  test(`${platform}: polling before DOMContentLoaded installs a generation only once`, () => {
    const f = fixture();
    vm.runInContext(earlyPayloadFor(payload("A"), "A"), f.context);
    const queuedDomReady = [...f.listeners][0];
    f.show();
    f.tick();
    f.domReady();
    queuedDomReady();
    assert.deepEqual(f.context.window.installs, ["A"]);
    assert.equal(f.listeners.size, 0);
    assert.equal(f.intervals.size, 0);
    assert.equal(f.timeouts.size, 0);
    assert.equal(f.context.window[appliedKey], "A");
  });

  test(`${platform}: timeout cancels the DOM-ready path as well as polling`, () => {
    const f = fixture();
    vm.runInContext(earlyPayloadFor(payload("A"), "A"), f.context);
    const queuedDomReady = [...f.listeners][0];
    f.expire();
    f.show();
    f.tick();
    f.domReady();
    queuedDomReady();
    assert.deepEqual(f.context.window.installs, []);
    assert.equal(f.listeners.size, 0);
    assert.equal(f.intervals.size, 0);
    assert.equal(f.timeouts.size, 0);
  });

  test(`${platform}: a newer early generation supersedes a pending generation`, () => {
    const f = fixture();
    vm.runInContext(earlyPayloadFor(payload("A"), "A"), f.context);
    vm.runInContext(earlyPayloadFor(payload("B"), "B"), f.context);
    f.show();
    f.tick();
    f.domReady();
    assert.deepEqual(f.context.window.installs, ["B"]);
    assert.equal(f.context.window[appliedKey], "B");
  });

  test(`${platform}: a full watcher replacement owns the document before old bootstrap retries`, () => {
    const f = fixture();
    vm.runInContext(earlyPayloadFor(payload("A"), "A"), f.context);
    vm.runInContext(payload("B"), f.context);
    const replacement = f.context.window[stateKey];
    f.show();
    f.tick();
    f.domReady();
    assert.deepEqual(f.context.window.installs, ["B"]);
    assert.equal(f.context.window[stateKey], replacement);
    assert.equal(f.listeners.size, 0);
    assert.equal(f.intervals.size, 0);
  });

  test(`${platform}: explicit A to B to A generations still apply in order`, () => {
    const f = fixture();
    f.show();
    for (const name of ["A", "B", "A"]) vm.runInContext(earlyPayloadFor(payload(name), name), f.context);
    assert.deepEqual(f.context.window.installs, ["A", "B", "A"]);
    assert.equal(f.context.window[appliedKey], "A");
  });
}

test("Windows: remove invalidates a waiting bootstrap, while an explicit resume may mount again", () => {
  const f = fixture();
  vm.runInContext(winEarly(payload("A"), "A"), f.context);
  f.context.window[appliedKey] = "A";
  const start = windowsSource.indexOf("async function removeFromSession(session)");
  const prefix = "return session.evaluate(`";
  const expressionStart = windowsSource.indexOf(prefix, start) + prefix.length;
  const expressionEnd = windowsSource.indexOf("`);", expressionStart);
  assert.ok(start >= 0 && expressionStart >= prefix.length && expressionEnd > expressionStart);
  vm.runInContext(windowsSource.slice(expressionStart, expressionEnd), f.context);
  assert.equal(f.context.window[disabledKey], true);
  assert.equal(f.context.window[appliedKey], undefined);
  f.show();
  f.tick();
  f.domReady();
  assert.deepEqual(f.context.window.installs, []);
  assert.equal(f.context.window[disabledKey], true);
  vm.runInContext(winEarly(payload("A"), "A"), f.context);
  assert.deepEqual(f.context.window.installs, ["A"]);
  assert.equal(f.context.window[disabledKey], false);
  assert.match(windowsSource, /if \(paused\) \{\s*await removeEarlyPayload\(session, previousEarlyScript\);\s*await removeFromSession\(session\);/,
    "pause must unregister future Page scripts before invalidating the current document");
});
