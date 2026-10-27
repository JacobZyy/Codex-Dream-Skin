import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const renderer = await fs.readFile(new URL("../runtime/renderer-inject.js", import.meta.url), "utf8");
const stateKey = "__CODEX_DREAM_SKIN_STATE__";
const sha256 = "a".repeat(64);

function fixture() {
  const allNodes = new Set();
  const revoked = [];
  const timers = new Map();
  const intervals = new Map();
  const listeners = new Map();
  const observers = [];
  let nextId = 0;
  let nextBlob = 0;
  class Node {
    constructor(tagName) {
      this.tagName = tagName.toUpperCase();
      this.parentElement = null;
      this.children = [];
      this.attrs = new Map();
      this.style = {
        values: new Map(),
        getPropertyValue(name) { return this.values.get(name) ?? ""; },
        setProperty(name, value) { this.values.set(name, value); },
        removeProperty(name) { this.values.delete(name); },
        [Symbol.iterator]() { return this.values.keys(); },
      };
      this.classList = { contains: () => false };
      allNodes.add(this);
    }
    get attributes() { return [...this.attrs].map(([name, value]) => ({ name, value })); }
    getAttribute(name) { return this.attrs.get(name) ?? null; }
    setAttribute(name, value) { this.attrs.set(name, String(value)); }
    removeAttribute(name) { this.attrs.delete(name); }
    appendChild(child) { child.remove(); child.parentElement = this; this.children.push(child); return child; }
    remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter((node) => node !== this); this.parentElement = null; }
    querySelector() { return null; }
    querySelectorAll() { return []; }
    closest() { return null; }
  }
  const root = new Node("html");
  const body = root.appendChild(new Node("body"));
  const document = {
    documentElement: root, head: root, body, adoptedStyleSheets: [],
    createElement: (tag) => new Node(tag),
    getElementById: (id) => [...allNodes].find((node) => node.id === id && node.parentElement) ?? null,
    querySelectorAll: (selector) => selector === "[data-ds-part]"
      ? [...allNodes].filter((node) => node.getAttribute("data-ds-part") !== null) : [],
  };
  const window = {
    log: [],
    matchMedia: () => ({ matches: false, addEventListener: (name, callback) => listeners.set(`media:${name}`, callback), removeEventListener: (name) => listeners.delete(`media:${name}`) }),
    navigation: { addEventListener: (name, callback) => listeners.set(`navigation:${name}`, callback), removeEventListener: (name) => listeners.delete(`navigation:${name}`) },
  };
  const context = vm.createContext({
    window, document, Blob, Uint8Array, atob, URLSearchParams, AbortController,
    location: { protocol: "app:", pathname: "/index.html", search: "" },
    URL: { createObjectURL() { return `blob:fixture-${++nextBlob}`; }, revokeObjectURL(url) { revoked.push(url); } },
    CSSStyleSheet: class { replaceSync(text) { this.text = text; } },
    MutationObserver: class { constructor(callback) { this.callback = callback; observers.push(this); } observe() {} disconnect() { this.disconnected = true; } },
    performance: { now: () => 1 },
    setTimeout(callback, delay) { const id = ++nextId; timers.set(id, { callback, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    setInterval(callback, delay) { const id = ++nextId; intervals.set(id, { callback, delay }); return id; },
    clearInterval(id) { intervals.delete(id); },
  });
  function inject(body = null, id = "fixture") {
    const replacements = {
      __DREAM_SKIN_SELECTORS_JSON__: JSON.stringify({ schema: 1, selectors: [], stableTestids: [] }),
      __DREAM_SKIN_CSS_PREDICATES_JSON__: "[]",
      __DREAM_SKIN_VERSION_JSON__: JSON.stringify("test"),
      __DREAM_SKIN_STYLE_REVISION_JSON__: JSON.stringify("style"),
      __DREAM_SKIN_PAYLOAD_REVISION_JSON__: JSON.stringify(`payload-${id}`),
      __DREAM_SKIN_CSS_JSON__: JSON.stringify(".fixture { color: red; }"),
      __DREAM_SKIN_ART_JSON__: JSON.stringify("data:image/png;base64,AA=="),
      __DREAM_SKIN_THEME_JSON__: JSON.stringify({ id, schemaVersion: 1, ...(body === null ? {} : { script: "theme.js", scriptSha256: sha256 }) }),
      __DREAM_SKIN_THEME_SCRIPT__: body === null ? "null" : `function(api) { ${body}\n }`,
    };
    const source = Object.entries(replacements).reduce((text, [token, value]) => text.replace(token, () => value), renderer);
    const result = vm.runInContext(source, context);
    return { result, state: window[stateKey] };
  }
  return { inject, window, document, root, body, revoked, timers, intervals, listeners, observers, allNodes };
}

const settle = async () => { await new Promise((resolve) => setImmediate(resolve)); };

test("one token mounts synchronously after core setup with the exact minimal API", () => {
  assert.equal([...renderer.matchAll(/__DREAM_SKIN_THEME_SCRIPT__/g)].length, 1);
  const f = fixture();
  const { state, result } = f.inject(`
    const state = window.__CODEX_DREAM_SKIN_STATE__;
    window.mountedAfterEnsure = state.metrics.ensureCalls > 0 && state.scope !== null && state.timer !== null;
    window.api = api;
    window.mounts = (window.mounts || 0) + 1;
    const panel = document.createElement("div");
    panel.setAttribute("data-theme-script-panel", "true");
    document.body.appendChild(panel);
    api.onCleanup(() => panel.remove());
  `);
  assert.ok(f.window.mountedAfterEnsure);
  assert.equal(f.root.getAttribute("data-dream-skin"), "active");
  assert.deepEqual(Object.keys(f.window.api).sort(), ["artUrl", "onCleanup", "root", "signal", "theme"]);
  assert.equal(f.window.api.root, f.root);
  assert.equal(f.window.api.artUrl, "blob:fixture-1");
  assert.equal(f.window.api.theme.id, "fixture");
  assert.equal(f.window.api.signal.aborted, false);
  assert.equal(state.hasThemeScript, true);
  assert.deepEqual(JSON.parse(JSON.stringify(state.script)), { state: "ready", sha256 });
  assert.equal(result.script.state, "ready", "a missing return must be ready synchronously");
  for (let count = 0; count < 3; count++) state.ensure({ root: true, scope: true, parts: true });
  for (const { callback } of f.intervals.values()) callback();
  assert.equal(f.window.mounts, 1, "same-generation ensures must not rerun theme.js");
  const panel = [...f.allNodes].find((node) => node.getAttribute("data-theme-script-panel") === "true");
  state.cleanup();
  assert.equal(panel.parentElement, null);
  assert.equal(f.window.api.signal.aborted, true);
  assert.equal(state.script.state, "disposed");
});

test("a readiness promise holds loading until fulfillment", async () => {
  const f = fixture();
  const { state } = f.inject(`return new Promise(resolve => { window.resolve = resolve; });`);
  assert.equal(state.script.state, "loading");
  f.window.resolve();
  await settle();
  assert.equal(state.script.state, "ready");
  state.cleanup();
});

test("synchronous exceptions and rejected promises fail verification and release resources", async () => {
  for (const completion of ['throw new Error("private runtime detail");', 'return Promise.reject(new Error("private rejection detail"));']) {
    const f = fixture();
    const { state } = f.inject(`
      window.api = api;
      api.onCleanup(() => window.log.push("cleaned"));
      ${completion}
    `);
    await settle();
    assert.equal(state.script.state, "error");
    assert.equal(state.script.error, "theme-script-execution-failed");
    assert.equal(f.window.api.signal.aborted, true);
    assert.deepEqual(f.window.log, ["cleaned"]);
    assert.doesNotMatch(JSON.stringify(state.script), /private/);
    state.cleanup();
    assert.deepEqual(f.window.log, ["cleaned"], "core cleanup must not rerun failed-script disposers");
  }
});

test("cleanup aborts first, runs every disposer once, and reports disposer failures", () => {
  const f = fixture();
  const { state } = f.inject(`
    window.api = api;
    api.signal.addEventListener("abort", () => window.log.push("abort"));
    api.onCleanup(() => window.log.push("first"));
    api.onCleanup(() => { window.log.push("throwing"); throw new Error("private cleanup detail"); });
    api.onCleanup(() => window.log.push("last"));
  `);
  assert.equal(state.cleanupScript(), true);
  assert.deepEqual(f.window.log, ["abort", "last", "throwing", "first"]);
  assert.deepEqual(JSON.parse(JSON.stringify(state.script)), { state: "disposed", sha256, error: "theme-script-cleanup-failed" });
  assert.equal(state.cleanupScript(), false);
  f.window.api.onCleanup(() => f.window.log.push("registered-after-disposal"));
  assert.equal(f.window.log.at(-1), "registered-after-disposal", "late cleanup registrations must run immediately");
  state.cleanup();
  assert.equal(f.window.log.filter((entry) => entry === "first").length, 1);
});

test("cleanup and replacement guard both late fulfilled and rejected callbacks", async () => {
  for (const completion of ["resolve", "reject"]) {
    const f = fixture();
    const { state: old } = f.inject(`
      window.api = api;
      return new Promise((resolve, reject) => { window.resolve = resolve; window.reject = reject; });
    `, "A");
    const { state: replacement } = f.inject(null, "B");
    assert.equal(old.script.state, "disposed");
    assert.equal(f.window.api.signal.aborted, true);
    f.window[completion](new Error("late"));
    await settle();
    assert.equal(old.script.state, "disposed");
    assert.equal(replacement.hasThemeScript, false);
    assert.equal(replacement.script, null);
    assert.equal(f.window[stateKey], replacement);
    assert.equal(old.cleanup(), false, "an old core cleanup must leave its replacement intact");
    replacement.cleanup();
  }
});

test("readiness updates require the current install token and an enabled renderer", async () => {
  for (const block of ["disabled", "generation"]) {
    for (const completion of ["resolve", "reject"]) {
      const f = fixture();
      const { state } = f.inject(`return new Promise((resolve, reject) => { window.resolve = resolve; window.reject = reject; });`);
      if (block === "disabled") f.window.__CODEX_DREAM_SKIN_DISABLED__ = true;
      else f.window[stateKey] = { installToken: {} };
      f.window[completion](new Error("late"));
      await settle();
      assert.equal(state.script.state, "loading", `${block} must guard ${completion} independently of disposal`);
      state.cleanupScript();
      assert.equal(state.script.state, "disposed");
      if (block === "generation") f.window[stateKey] = state;
      state.cleanup();
    }
  }
});

test("A to B to A reruns each generation and preserves cleanup order", () => {
  const f = fixture();
  const body = `
    window.log.push("mount:" + api.theme.id);
    api.onCleanup(() => window.log.push("cleanup:" + api.theme.id));
  `;
  const first = f.inject(body, "A").state;
  const second = f.inject(body, "B").state;
  const third = f.inject(body, "A").state;
  assert.deepEqual(f.window.log, ["mount:A", "cleanup:A", "mount:B", "cleanup:B", "mount:A"]);
  assert.equal(first.script.state, "disposed");
  assert.equal(second.script.state, "disposed");
  assert.equal(third.script.state, "ready");
  third.cleanup();
  assert.equal(f.window.log.at(-1), "cleanup:A");
  assert.deepEqual(f.revoked, ["blob:fixture-1", "blob:fixture-2", "blob:fixture-3"]);
});

test("a page reload creates one new mount and core restore removes all runtime state", () => {
  const body = `window.mounts = (window.mounts || 0) + 1; api.onCleanup(() => window.log.push("removed"));`;
  const original = fixture();
  const old = original.inject(body, "A").state;
  old.cleanup();
  const reloaded = fixture();
  const fresh = reloaded.inject(body, "A").state;
  assert.equal(reloaded.window.mounts, 1);
  assert.equal(fresh.script.state, "ready");
  assert.equal(fresh.cleanup(), true);
  assert.equal(fresh.script.state, "disposed");
  assert.deepEqual(reloaded.window.log, ["removed"]);
  assert.equal(reloaded.window[stateKey], undefined);
  assert.equal(reloaded.document.adoptedStyleSheets.length, 0);
  assert.equal(reloaded.root.attrs.size, 0);
  assert.equal(reloaded.root.style.values.size, 0);
  assert.equal(reloaded.timers.size, 0);
  assert.equal(reloaded.intervals.size, 0);
  assert.equal(reloaded.listeners.size, 0);
  assert.ok(reloaded.observers.every((observer) => observer.disconnected));
});

test("ordinary v1 themes do not mount scripts or acquire script resources", () => {
  const f = fixture();
  const { state, result } = f.inject();
  assert.equal(state.hasThemeScript, false);
  assert.equal(state.script, null);
  assert.equal(result.hasThemeScript, false);
  assert.equal(result.script, null);
  assert.equal(state.cleanupScript(), false);
  assert.equal(state.ensure({ root: true }), undefined);
  assert.equal(state.cleanup(), true);
  assert.deepEqual(f.revoked, ["blob:fixture-1"]);
  assert.equal(f.root.style.values.size, 0);
});
