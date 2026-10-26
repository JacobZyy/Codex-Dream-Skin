import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import process from "node:process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { themePreferencesPath } from "./theme-preferences.mjs";

const MAX_PREFERENCES_BYTES = 16 * 1024;
const MAX_THEME_BYTES = 1024 * 1024;
const STYLE_KEYS = ["foreground", "background", "transparency", "blur"];
const OPEN_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
const decoder = new TextDecoder("utf-8", { fatal: true });
const warned = new Set();
export const MAX_CHAT_BUBBLE_BLUR = 64;

export const CHAT_BUBBLE_PRESETS = Object.freeze([
  { id: "sea-glass", name: "松石青绿", nameEn: "Sea glass", foreground: "#BDD1CB", background: "#2D4947" },
  { id: "mist-blue", name: "雾蓝", nameEn: "Mist blue", foreground: "#BECDE5", background: "#344862" },
  { id: "smoky-lilac", name: "烟紫", nameEn: "Smoky lilac", foreground: "#CDBFDA", background: "#443A58" },
  { id: "dusty-rose", name: "玫瑰灰", nameEn: "Dusty rose", foreground: "#DAC4D0", background: "#503C48" },
  { id: "deep-teal", name: "深海青", nameEn: "Deep teal", foreground: "#BEDBE0", background: "#20505D" },
  { id: "clay-rose", name: "陶红灰", nameEn: "Clay rose", foreground: "#DFCED0", background: "#534345" },
  { id: "frappe", name: "Catppuccin Frappé", nameEn: "Catppuccin Frappé", foreground: "#C6D0F5", background: "#414559" },
].map(({ foreground, background, ...preset }) => Object.freeze({
  ...preset,
  style: Object.freeze({ foreground, background, transparency: 25, blur: 24 }),
})));

export const DEFAULT_CHAT_BUBBLE_STYLE = CHAT_BUBBLE_PRESETS.at(-1).style;

function assertObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
}

function assertKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`${label} contains unsupported field ${key}`);
  }
}

export function normalizeChatBubbleStyle(value, label = "chatBubbles") {
  assertObject(value, label);
  assertKeys(value, STYLE_KEYS, label);
  for (const key of ["foreground", "background"]) {
    if (typeof value[key] !== "string" || !/^#[0-9a-f]{6}$/i.test(value[key])) {
      throw new Error(`${label}.${key} must be an opaque #RRGGBB color`);
    }
  }
  for (const [key, maximum] of [["transparency", 100], ["blur", MAX_CHAT_BUBBLE_BLUR]]) {
    if (typeof value[key] !== "number" || !Number.isFinite(value[key])
      || value[key] < 0 || value[key] > maximum) {
      throw new Error(`${label}.${key} must be between 0 and ${maximum}`);
    }
  }
  return {
    foreground: value.foreground.toUpperCase(),
    background: value.background.toUpperCase(),
    transparency: value.transparency,
    blur: value.blur,
  };
}

export function normalizeChatBubblePreferences(value) {
  const label = "Chat bubble preferences";
  assertObject(value, label);
  assertKeys(value, ["schemaVersion", "mode", "presetId", "style"], label);
  if (value.schemaVersion !== 1 || !["theme", "preset"].includes(value.mode)) {
    throw new Error("Chat bubble preferences must use schemaVersion 1 and theme or preset mode");
  }
  if (value.presetId !== undefined && (typeof value.presetId !== "string"
    || value.presetId.length > 80 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value.presetId))) {
    throw new Error("Chat bubble presetId must be a bounded preset identifier");
  }
  if (value.mode === "preset" && value.style === undefined) {
    throw new Error("Independent chat bubbles require a complete style snapshot");
  }
  if (value.presetId !== undefined && value.style === undefined) {
    throw new Error("Chat bubble presetId requires a style snapshot");
  }
  return {
    schemaVersion: 1,
    mode: value.mode,
    ...(value.presetId === undefined ? {} : { presetId: value.presetId }),
    ...(value.style === undefined ? {} : { style: normalizeChatBubbleStyle(value.style) }),
  };
}

export function chatBubblePreferencesPath(platform = process.platform, env = process.env, home) {
  return path.join(path.dirname(themePreferencesPath(platform, env, home)), "bubble-preferences.json");
}

async function readBoundedJson(filePath, maximum) {
  const before = await fs.lstat(filePath);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error("Invalid configuration file");
  const handle = await fs.open(filePath, OPEN_FLAGS);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maximum || stat.dev !== before.dev || stat.ino !== before.ino) {
      throw new Error("Invalid configuration file");
    }
    const bytes = Buffer.alloc(maximum + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await handle.read(bytes, length, bytes.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > maximum) throw new Error("Configuration file is too large");
    return JSON.parse(decoder.decode(bytes.subarray(0, length)));
  } finally {
    await handle.close();
  }
}

export async function readChatBubblePreferences({
  preferencesPath = chatBubblePreferencesPath(),
  warn = (message) => console.error(message),
} = {}) {
  try {
    const preferences = normalizeChatBubblePreferences(
      await readBoundedJson(preferencesPath, MAX_PREFERENCES_BYTES),
    );
    warned.delete(preferencesPath);
    return preferences;
  } catch (error) {
    if (error.code !== "ENOENT" && !warned.has(preferencesPath)) {
      warned.add(preferencesPath);
      warn("[dream-skin] Chat bubble preferences unavailable or invalid; following the theme.");
    }
    return { schemaVersion: 1, mode: "theme" };
  }
}

export async function writeChatBubblePreferences(value, {
  preferencesPath = chatBubblePreferencesPath(),
} = {}) {
  const preferences = normalizeChatBubblePreferences(value);
  const destination = path.resolve(preferencesPath);
  const directory = path.dirname(destination);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  if (await fs.realpath(directory) !== directory) {
    throw new Error("Chat bubble preferences directory must not use symbolic links");
  }
  const existing = await fs.lstat(destination).catch((error) => {
    if (error.code !== "ENOENT") throw error;
    return null;
  });
  if (existing && (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1)) {
    throw new Error("Chat bubble preferences must be a regular, unlinked file");
  }
  const temporary = path.join(directory, `.bubble-preferences-${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await fs.open(temporary, "wx", 0o600);
    await handle.writeFile(JSON.stringify(preferences, null, 2) + "\n", "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(temporary, destination);
  } finally {
    await handle?.close();
    await fs.rm(temporary, { force: true });
  }
  warned.delete(preferencesPath);
  return preferences;
}

export function resolveChatBubbleStyle(themeDefaults, preferences) {
  const normalized = normalizeChatBubblePreferences(preferences);
  if (normalized.mode === "preset") return normalized.style;
  if (themeDefaults === undefined) return undefined;
  return normalizeChatBubbleStyle(themeDefaults);
}

function parseArguments(args) {
  const [command, ...rest] = args;
  const allowed = new Set(["preferences", "theme", "foreground", "background", "transparency", "blur"]);
  const options = {};
  const positional = [];
  for (let index = 0; index < rest.length; index++) {
    const argument = rest[index];
    if (!argument.startsWith("--")) {
      positional.push(argument);
      continue;
    }
    const key = argument.slice(2);
    const value = rest[++index];
    if (!allowed.has(key) || value === undefined || value.trim() === "" || value.startsWith("--")
      || Object.hasOwn(options, key)) {
      throw new Error("Unknown, repeated or incomplete chat bubble option");
    }
    options[key] = value;
  }
  if (!["get", "list", "preset", "theme", "custom"].includes(command)
    || positional.length !== (command === "preset" ? 1 : 0)) {
    throw new Error("Usage: chat-bubbles.mjs get|list|theme|preset ID|custom [options]");
  }
  if (command === "list" && Object.keys(options).length) throw new Error("list does not accept options");
  for (const key of Object.keys(options)) {
    if (!["preferences", "theme"].includes(key) && command !== "custom") {
      throw new Error("Style options require the custom command");
    }
  }
  return { command, options, presetId: positional[0] };
}

async function main(args) {
  const { command, options, presetId } = parseArguments(args);
  if (command === "list") {
    console.log(JSON.stringify(CHAT_BUBBLE_PRESETS));
    return;
  }
  const warnings = [];
  const preferencesPath = options.preferences || chatBubblePreferencesPath();
  const readOptions = { preferencesPath, warn: (message) => warnings.push(message) };
  const themeStyle = options.theme
    ? (await readBoundedJson(options.theme, MAX_THEME_BYTES)).chatBubbles
    : undefined;
  if (themeStyle !== undefined) normalizeChatBubbleStyle(themeStyle);
  let preferences = await readChatBubblePreferences(readOptions);
  if (command === "preset") {
    const preset = CHAT_BUBBLE_PRESETS.find((entry) => entry.id === presetId);
    if (!preset) throw new Error("Unknown chat bubble preset");
    preferences = await writeChatBubblePreferences({
      schemaVersion: 1, mode: "preset", presetId: preset.id, style: preset.style,
    }, { preferencesPath });
  } else if (command === "theme") {
    preferences = await writeChatBubblePreferences({ ...preferences, mode: "theme" }, { preferencesPath });
  } else if (command === "custom") {
    for (const key of STYLE_KEYS) {
      if (!Object.hasOwn(options, key) || options[key].trim() === "") {
        throw new Error("Custom chat bubbles require all four style values");
      }
    }
    preferences = await writeChatBubblePreferences({
      schemaVersion: 1, mode: "preset", presetId: "custom",
      style: {
        foreground: options.foreground, background: options.background,
        transparency: Number(options.transparency), blur: Number(options.blur),
      },
    }, { preferencesPath });
  }
  console.log(JSON.stringify({
    preferences,
    presets: CHAT_BUBBLE_PRESETS,
    themeStyle: themeStyle === undefined ? null : normalizeChatBubbleStyle(themeStyle),
    effectiveStyle: resolveChatBubbleStyle(themeStyle, preferences) ?? null,
    warnings,
  }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 2;
  });
}
