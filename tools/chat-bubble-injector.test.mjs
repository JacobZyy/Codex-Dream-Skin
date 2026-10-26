import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import * as mac from "../macos/scripts/injector.mjs";
import * as windows from "../windows/scripts/injector.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const themeStyle = { foreground: "#AFCBC5", background: "#253E3C", transparency: 20, blur: 18 };
const presetStyle = { foreground: "#C6D0F5", background: "#414559", transparency: 25, blur: 24 };

async function withFixture(run) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "dreamskin-bubble-injector-"));
  const themeDir = path.join(temp, "theme");
  const preferencesPath = path.join(temp, "theme-preferences.json");
  const chatBubblePreferencesPath = path.join(temp, "chat-bubble-preferences.json");
  const options = { preferencesPath, chatBubblePreferencesPath, warn: () => {} };
  const theme = {
    schemaVersion: 1, id: "bubble-fixture", image: "background.png",
    colors: { text: "#E0E0E0", panel: "#101010", accent: "#70BDEB" },
    resolvedChatBubbles: { ...presetStyle, foreground: "#FF0000" },
  };
  await fs.mkdir(themeDir);
  await fs.copyFile(path.join(root, "macos/assets/portal-hero.png"), path.join(themeDir, "background.png"));
  const writeTheme = () => fs.writeFile(path.join(themeDir, "theme.json"), JSON.stringify(theme));
  const writePreferences = (value) => fs.writeFile(chatBubblePreferencesPath, JSON.stringify(value));
  await writeTheme();
  await fs.writeFile(preferencesPath, JSON.stringify({ schemaVersion: 1, themes: { "bubble-fixture": { transparency: 90 } } }));
  await fs.writeFile(path.join(themeDir, "theme.css"),
    '[data-ds-part="message"] { color: #FFFF00; background-color: #123456; backdrop-filter: blur(1px); opacity: .7; border-radius: 22px; }');
  try {
    await run({ temp, themeDir, theme, options, writeTheme, writePreferences });
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
}

for (const [name, api] of [["macOS", mac], ["Windows", windows]]) {
  test(`${name}: theme defaults, independent presets and reset remain separate`, async () => {
    await withFixture(async ({ themeDir, theme, options, writeTheme, writePreferences }) => {
      const load = () => api.loadTheme(themeDir, options);
      const payload = (loaded) => name === "macOS"
        ? api.loadPayload(themeDir, options) : api.loadPayload(themeDir, loaded);
      const legacy = await load();
      assert.equal(legacy.theme.resolvedChatBubbles, undefined,
        "Package-supplied internal derived values must be ignored.");
      assert.equal(legacy.theme.userTransparency, 90);
      const legacyPayload = await payload(legacy);
      theme.chatBubbles = themeStyle;
      await writeTheme();
      const authored = await load();
      assert.deepEqual(authored.theme.chatBubbles, themeStyle);
      assert.deepEqual(authored.theme.resolvedChatBubbles, themeStyle);
      const authoredPayload = await payload(authored);
      assert.notEqual(authoredPayload.revision, legacyPayload.revision);

      await writePreferences({ schemaVersion: 1, mode: "preset", presetId: "frappe", style: presetStyle });
      const independent = await load();
      assert.deepEqual(independent.theme.chatBubbles, themeStyle);
      assert.deepEqual(independent.theme.resolvedChatBubbles, presetStyle);
      assert.deepEqual(independent.theme.colors, authored.theme.colors);
      assert.equal(independent.theme.userTransparency, 90,
        "Global transparency must retain its separate preference.");
      const independentPayload = await payload(independent);
      assert.notEqual(independentPayload.revision, authoredPayload.revision);
      if (name === "Windows") assert.notEqual(independent.fingerprint, authored.fingerprint);

      theme.id = "another-wallpaper";
      theme.colors.panel = "#212123";
      theme.chatBubbles = { ...themeStyle, blur: 2 };
      await writeTheme();
      assert.deepEqual((await load()).theme.resolvedChatBubbles, presetStyle,
        "Switching wallpapers must retain an independently selected preset.");
      await writePreferences({ schemaVersion: 1, mode: "theme" });
      const reset = await load();
      assert.deepEqual(reset.theme.resolvedChatBubbles, theme.chatBubbles);
      delete theme.chatBubbles;
      await writeTheme();
      assert.equal((await load()).theme.resolvedChatBubbles, undefined);

      await writePreferences({ schemaVersion: 1, mode: "preset", style: presetStyle });
      const beforeEdit = await load();
      const beforePayload = await payload(beforeEdit);
      await writePreferences({ schemaVersion: 1, mode: "preset", style: { ...presetStyle, blur: 0, transparency: 100 } });
      const afterEdit = await load();
      const afterPayload = await payload(afterEdit);
      assert.notEqual(beforePayload.revision, afterPayload.revision,
        "Preference-only edits must invalidate cached and early renderer payloads.");
      if (name === "Windows") assert.notEqual(beforeEdit.fingerprint, afterEdit.fingerprint);
      await fs.writeFile(options.chatBubblePreferencesPath, "{broken");
      assert.equal((await load()).theme.resolvedChatBubbles, undefined,
        "Invalid independent preferences must return to theme mode.");
      theme.chatBubbles = { ...themeStyle, blur: 65 };
      await writeTheme();
      await assert.rejects(load(), /chatBubbles|blur/);
    });
  });
}

test("macOS watches atomic bubble preference writes independently of theme files", async () => {
  await withFixture(async ({ temp, themeDir, options }) => {
    const signals = [];
    const close = mac.watchPayloadSources(themeDir, (change) => signals.push(change), options);
    try {
      const staged = path.join(temp, "bubble-write.tmp");
      await fs.writeFile(staged, JSON.stringify({ schemaVersion: 1, mode: "preset", style: presetStyle }));
      await fs.rename(staged, options.chatBubblePreferencesPath);
      const deadline = Date.now() + 2000;
      while (!signals.length && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
      assert.ok(signals.length > 0, "Atomic replacement of the preferences file must request a refresh.");
      assert.ok(signals.every((change) => change.staticChanged === false));
      const observed = signals.length;
      await fs.writeFile(path.join(temp, "unrelated.json"), "{}");
      await new Promise((resolve) => setTimeout(resolve, 80));
      assert.equal(signals.length, observed, "Unrelated state files must not trigger a theme refresh.");
    } finally {
      close();
    }
  });
});
