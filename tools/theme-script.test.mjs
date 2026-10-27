import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { decodeThemeScript, readThemeScript, isThemeScriptTrusted, trustThemeScript, MAX_THEME_SCRIPT_BYTES } from "../runtime/theme-script.mjs";
import * as mac from "../macos/scripts/injector.mjs";
import * as win from "../windows/scripts/injector.mjs";

async function fixture(t, source = "globalThis.__themeScriptMustNotExecute = true; api.onCleanup(() => {});") {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dream-theme-script-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.writeFile(path.join(directory, "theme.js"), source);
  await fs.writeFile(path.join(directory, "theme.json"), JSON.stringify({ schemaVersion: 1, id: "script-fixture", name: "Script fixture", image: "background.png", script: "theme.js" }));
  await fs.writeFile(path.join(directory, "background.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aG2QAAAAASUVORK5CYII=", "base64"));
  await fs.writeFile(path.join(directory, "theme.css"), '[data-ds-part="main"] { background-color: transparent; }');
  return { directory, trustFile: path.join(directory, "grants", "script-trust.json") };
}

test("script validation parses without executing and bounds source bytes/encoding", () => {
  delete globalThis.__themeScriptMustNotExecute;
  const parsed = decodeThemeScript(Buffer.from("globalThis.__themeScriptMustNotExecute = true; return Promise.resolve();"));
  assert.match(parsed.sha256, /^[0-9a-f]{64}$/);
  assert.equal(globalThis.__themeScriptMustNotExecute, undefined);
  assert.throws(() => decodeThemeScript(Buffer.from("return (")), /syntax/);
  for (const value of [Buffer.alloc(0), Buffer.from("  "), Buffer.from([0xff]), Buffer.from("\0"), Buffer.alloc(MAX_THEME_SCRIPT_BYTES + 1)]) assert.throws(() => decodeThemeScript(value));
  assert.doesNotThrow(() => decodeThemeScript(Buffer.from(`//${"a".repeat(MAX_THEME_SCRIPT_BYTES - 2)}`)));
});

test("explicit trust is hash-bound, atomic and preserves concurrent grants", async (t) => {
  const { directory, trustFile } = await fixture(t);
  const other = await fs.mkdtemp(path.join(os.tmpdir(), "dream-theme-other-"));
  t.after(() => fs.rm(other, { recursive: true, force: true }));
  await fs.writeFile(path.join(other, "theme.js"), "return undefined;");
  const initial = await readThemeScript(directory);
  assert.equal(await isThemeScriptTrusted(initial.sha256, { trustFile }), false);
  const grants = await Promise.all([trustThemeScript(directory, { trustFile }), trustThemeScript(other, { trustFile })]);
  for (const grant of grants) assert.equal(await isThemeScriptTrusted(grant.sha256, { trustFile }), true);
  await fs.appendFile(path.join(directory, "theme.js"), "\n// changed");
  assert.equal(await isThemeScriptTrusted((await readThemeScript(directory)).sha256, { trustFile }), false);
  assert.equal(globalThis.__themeScriptMustNotExecute, undefined);
  assert.equal((await fs.readdir(path.dirname(trustFile))).some((name) => name.endsWith(".lock") || name.endsWith(".tmp")), false);
});

test("script and trust files reject links, corrupt records and unsupported types", async (t) => {
  const { directory, trustFile } = await fixture(t);
  const script = await readThemeScript(directory);
  await fs.mkdir(path.dirname(trustFile));
  for (const value of [{ schemaVersion: 2, scripts: [] }, { schemaVersion: 1, scripts: [script.sha256, script.sha256] }, { schemaVersion: 1, scripts: [], extra: true }, { schemaVersion: 1, scripts: ["not-a-hash"] }]) {
    await fs.writeFile(trustFile, JSON.stringify(value));
    await assert.rejects(isThemeScriptTrusted(script.sha256, { trustFile }), /registry/);
  }
  await fs.rm(trustFile);
  await fs.symlink(path.join(directory, "theme.js"), trustFile);
  await assert.rejects(isThemeScriptTrusted(script.sha256, { trustFile }), /regular file/);
  await fs.rm(path.join(directory, "theme.js"));
  await fs.symlink(path.join(directory, "theme.json"), path.join(directory, "theme.js"));
  await assert.rejects(readThemeScript(directory), /regular file/);
});

test("both loaders require dynamic trust, static checks never grant or execute, script edits change revision", async (t) => {
  const { directory, trustFile } = await fixture(t);
  for (const loader of [mac, win]) {
    await assert.rejects(loader.loadTheme(directory, {}, { trustFile }), /not trusted/);
  }
  const initialScript = await readThemeScript(directory);
  const before = await Promise.all([
    mac.loadPayload(directory, {}, { allowUntrustedScript: true, trustFile }),
    win.loadPayload(directory, null, { allowUntrustedScript: true, trustFile }),
  ]);
  assert.equal(await isThemeScriptTrusted(initialScript.sha256, { trustFile }), false);
  assert.equal(globalThis.__themeScriptMustNotExecute, undefined);
  await trustThemeScript(directory, { trustFile });
  for (const loader of [mac, win]) {
    const loaded = await loader.loadTheme(directory, {}, { trustFile });
    assert.equal(loaded.theme.scriptSha256, initialScript.sha256);
  }
  await fs.appendFile(path.join(directory, "theme.js"), "\n// a new candidate");
  for (const loader of [mac, win]) await assert.rejects(loader.loadTheme(directory, {}, { trustFile }), /not trusted/);
  const after = await Promise.all([
    mac.loadPayload(directory, {}, { allowUntrustedScript: true, trustFile }),
    win.loadPayload(directory, null, { allowUntrustedScript: true, trustFile }),
  ]);
  for (let index = 0; index < 2; index += 1) {
    assert.notEqual(before[index].revision, after[index].revision);
    assert.doesNotMatch(after[index].payload, /__DREAM_SKIN_THEME_SCRIPT__/);
  }
  assert.equal(globalThis.__themeScriptMustNotExecute, undefined);
});

test("unexpected script and declared missing/invalid paths fail", async (t) => {
  const { directory } = await fixture(t);
  const configPath = path.join(directory, "theme.json");
  const raw = JSON.parse(await fs.readFile(configPath));
  delete raw.script;
  await fs.writeFile(configPath, JSON.stringify(raw));
  for (const loader of [mac, win]) await assert.rejects(loader.loadTheme(directory), /undeclared theme.js/);
  raw.script = "../theme.js";
  await fs.writeFile(configPath, JSON.stringify(raw));
  for (const loader of [mac, win]) await assert.rejects(loader.loadTheme(directory), /must be theme.js/);
  raw.script = "theme.js";
  await fs.writeFile(configPath, JSON.stringify(raw));
  await fs.rm(path.join(directory, "theme.js"));
  for (const loader of [mac, win]) await assert.rejects(loader.loadTheme(directory), /is missing/);
});

 test("theme script source containing template-like text remains verbatim", async (t) => {
  const { directory, trustFile } = await fixture(t);
  const source = 'const marker = "__DREAM_SKIN_THEME_JSON__ __DREAM_SKIN_THEME_SCRIPT__ $&"; return;';
  await fs.writeFile(path.join(directory, "theme.js"), source);
  const payloads = await Promise.all([mac.loadPayload(directory, {}, { allowUntrustedScript: true, trustFile }), win.loadPayload(directory, null, { allowUntrustedScript: true, trustFile })]);
  for (const { payload } of payloads) { assert.ok(payload.includes(source)); assert.doesNotThrow(() => new Function(payload)); }
});
