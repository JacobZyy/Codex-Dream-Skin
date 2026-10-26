import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  CHAT_BUBBLE_PRESETS,
  chatBubblePreferencesPath,
  normalizeChatBubbleStyle,
  normalizeChatBubblePreferences,
  readChatBubblePreferences,
  resolveChatBubbleStyle,
  writeChatBubblePreferences,
} from "../runtime/chat-bubbles.mjs";

const run = promisify(execFile);
const script = fileURLToPath(new URL("../runtime/chat-bubbles.mjs", import.meta.url));
const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "dream-skin-bubbles-")));
const preferencesPath = path.join(temp, "bubble-preferences.json");
const themePath = path.join(temp, "theme.json");
const style = CHAT_BUBBLE_PRESETS[0].style;
const authored = CHAT_BUBBLE_PRESETS[1].style;
const options = { preferencesPath };
const cli = async (...args) => {
  const { stdout } = await run(process.execPath, [script, ...args, "--preferences", preferencesPath]);
  return JSON.parse(stdout);
};

try {
  assert.equal(chatBubblePreferencesPath("darwin", {}, "/test"),
    path.join("/test", "Library", "Application Support", "CodexDreamSkinStudio", "bubble-preferences.json"));
  assert.equal(chatBubblePreferencesPath("win32", { LOCALAPPDATA: "/local" }, "/test"),
    path.join("/local", "CodexDreamSkin", "bubble-preferences.json"));
  assert.deepEqual(await readChatBubblePreferences(options), { schemaVersion: 1, mode: "theme" });
  assert.equal(resolveChatBubbleStyle(undefined, { schemaVersion: 1, mode: "theme" }), undefined);
  assert.deepEqual(resolveChatBubbleStyle(authored, { schemaVersion: 1, mode: "theme" }), authored);

  for (const boundary of [{ transparency: 0, blur: 0 }, { transparency: 100, blur: 64 }]) {
    assert.deepEqual(normalizeChatBubbleStyle({ ...style, ...boundary }), { ...style, ...boundary });
  }
  for (const invalid of [null, [], {}, { ...style, background: "#1234" },
    { ...style, foreground: "rgba(1,2,3,.5)" }, { ...style, foreground: "#123456; color:red" },
    { ...style, transparency: -1 }, { ...style, transparency: 101 }, { ...style, transparency: "25" },
    { ...style, blur: Infinity }, { ...style, blur: NaN }, { ...style, blur: 65 },
    { ...style, opacity: 0.5 }]) {
    assert.throws(() => normalizeChatBubbleStyle(invalid));
  }
  for (const invalid of [{ schemaVersion: 2, mode: "theme" }, { schemaVersion: 1, mode: "preset" },
    { schemaVersion: 1, mode: "preset", style, presetId: "../theme" },
    { schemaVersion: 1, mode: "theme", unknown: true }]) {
    assert.throws(() => normalizeChatBubblePreferences(invalid));
  }

  const globalPreferences = path.join(temp, "theme-preferences.json");
  const globalBefore = '{"schemaVersion":1,"themes":{"first":{"transparency":30}}}\n';
  await fs.writeFile(globalPreferences, globalBefore);
  await fs.writeFile(themePath, JSON.stringify({ id: "first", chatBubbles: authored }));
  const themeBefore = await fs.readFile(themePath, "utf8");
  let report = await cli("preset", "sea-glass", "--theme", themePath);
  assert.equal(report.preferences.mode, "preset");
  assert.deepEqual(report.effectiveStyle, style);
  assert.equal(await fs.readFile(globalPreferences, "utf8"), globalBefore);
  assert.equal(await fs.readFile(themePath, "utf8"), themeBefore);
  const saved = await fs.readFile(preferencesPath, "utf8");
  await fs.writeFile(themePath, JSON.stringify({ id: "second", chatBubbles: CHAT_BUBBLE_PRESETS[2].style }));
  report = await cli("get", "--theme", themePath);
  assert.deepEqual(report.effectiveStyle, style, "Theme switches must not replace independent values");
  assert.equal(await fs.readFile(preferencesPath, "utf8"), saved);
  report = await cli("theme", "--theme", themePath);
  assert.deepEqual(report.effectiveStyle, CHAT_BUBBLE_PRESETS[2].style);
  assert.deepEqual(report.preferences.style, style, "Following a theme keeps the last independent snapshot");
  await fs.writeFile(themePath, JSON.stringify({ id: "legacy" }));
  report = await cli("get", "--theme", themePath);
  assert.equal(report.effectiveStyle, null, "Legacy themes must not receive a default bubble override");
  report = await cli("custom", "--foreground", "#abcdef", "--background", "#123456",
    "--transparency", "100", "--blur", "0");
  assert.deepEqual(report.effectiveStyle,
    { foreground: "#ABCDEF", background: "#123456", transparency: 100, blur: 0 });
  const validBefore = await fs.readFile(preferencesPath, "utf8");
  await assert.rejects(cli("custom", "--foreground", "#abcdef", "--background", "#123456",
    "--transparency", "101", "--blur", "0"));
  await assert.rejects(cli("preset", "absent"));
  await assert.rejects(cli("theme", "--blur", "1"));
  await assert.rejects(cli("get", "--preferences"));
  assert.equal(await fs.readFile(preferencesPath, "utf8"), validBefore);

  const messages = [];
  for (const data of ['{"PRIVATE_CONTENT":"DO_NOT_LOG"', "x".repeat(16_385),
    JSON.stringify({ schemaVersion: 1, mode: "preset", style: { ...style, blur: -1 } }),
    Buffer.from([0xff, 0xfe])]) {
    await fs.writeFile(preferencesPath, data);
    assert.deepEqual(await readChatBubblePreferences({ ...options, warn: (m) => messages.push(m) }),
      { schemaVersion: 1, mode: "theme" });
  }
  assert(messages.length > 0);
  assert(messages.every((message) => !message.includes("DO_NOT_LOG") && !message.includes(temp)));
  report = await cli("get");
  assert.equal(report.preferences.mode, "theme");
  assert.equal(report.warnings.length, 1);

  await fs.rm(preferencesPath);
  const sentinel = path.join(temp, "sentinel.json");
  await fs.writeFile(sentinel, "unchanged");
  await fs.symlink(sentinel, preferencesPath);
  await assert.rejects(writeChatBubblePreferences({ schemaVersion: 1, mode: "preset", style }, options));
  assert.equal(await fs.readFile(sentinel, "utf8"), "unchanged");
  await fs.rm(preferencesPath);
  await fs.link(sentinel, preferencesPath);
  await assert.rejects(writeChatBubblePreferences({ schemaVersion: 1, mode: "preset", style }, options));
  assert.equal(await fs.readFile(sentinel, "utf8"), "unchanged");
  await fs.rm(preferencesPath);
  await writeChatBubblePreferences({ schemaVersion: 1, mode: "preset", presetId: "sea-glass", style }, options);
  assert.deepEqual(await readChatBubblePreferences(options),
    { schemaVersion: 1, mode: "preset", presetId: "sea-glass", style });
  assert.equal((await fs.readdir(temp)).some((name) => name.endsWith(".tmp")), false);
  console.log("PASS: independent bubble preferences, precedence, CLI, validation and atomic file isolation");
} finally {
  await fs.rm(temp, { recursive: true, force: true });
}
