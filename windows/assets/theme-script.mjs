import fs from "node:fs/promises";
import { constants } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { Script } from "node:vm";
import { themePreferencesPath } from "./theme-preferences.mjs";

export const THEME_SCRIPT_NAME = "theme.js";
export const MAX_THEME_SCRIPT_BYTES = 6 * 1024 * 1024;
export const THEME_SCRIPT_MIN_CLIENT_VERSION = "1.5.22";
const MAX_TRUST_BYTES = 64 * 1024;
const SHA256 = /^[0-9a-f]{64}$/;
const decoder = new TextDecoder("utf-8", { fatal: true });
const OPEN_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);

function sameFile(left, right) {
  return left.isFile() && right.isFile() && left.dev === right.dev && left.ino === right.ino
    && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

async function readStableFile(filePath, limit) {
  let original;
  try { original = await fs.lstat(filePath); } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  if (!original.isFile() || original.isSymbolicLink() || original.size < 1 || original.size > limit) {
    throw new Error(`${path.basename(filePath)} must be a bounded non-empty regular file`);
  }
  const handle = await fs.open(filePath, OPEN_FLAGS);
  try {
    const before = await handle.stat();
    if (!sameFile(original, before)) throw new Error(`${path.basename(filePath)} changed while opening`);
    const buffer = Buffer.alloc(before.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    const after = await handle.stat();
    const current = await fs.lstat(filePath);
    if (!sameFile(before, after) || !sameFile(after, current) || length !== before.size) {
      throw new Error(`${path.basename(filePath)} changed while reading`);
    }
    return { bytes: buffer.subarray(0, length), stat: after };
  } finally { await handle.close(); }
}

export function decodeThemeScript(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
  if (bytes.length < 1 || bytes.length > MAX_THEME_SCRIPT_BYTES) {
    throw new Error("theme.js must be non-empty and no larger than 6 MiB");
  }
  let source;
  try { source = decoder.decode(bytes); } catch { throw new Error("theme.js must be valid UTF-8"); }
  if (!source.trim() || source.includes("\0")) throw new Error("theme.js contains empty or invalid source");
  // Syntax validation only: theme code must never execute in the Node loader.
  try { new Script(`(function(api) {\n${source}\n})`, { filename: THEME_SCRIPT_NAME }); }
  catch { throw new Error("theme.js has invalid JavaScript syntax"); }
  return { source, sha256: createHash("sha256").update(bytes).digest("hex") };
}

export async function readThemeScript(themeDir) {
  const loaded = await readStableFile(path.join(themeDir, THEME_SCRIPT_NAME), MAX_THEME_SCRIPT_BYTES);
  return loaded ? { ...loaded, ...decodeThemeScript(loaded.bytes) } : null;
}

export function themeScriptTrustPath(platform = process.platform) {
  return path.join(path.dirname(themePreferencesPath(platform)), "script-trust.json");
}

async function readTrust(trustFile) {
  const loaded = await readStableFile(trustFile, MAX_TRUST_BYTES);
  if (!loaded) return { schemaVersion: 1, scripts: [] };
  let value;
  try { value = JSON.parse(decoder.decode(loaded.bytes)); }
  catch { throw new Error("Theme script trust registry is invalid"); }
  if (!value || typeof value !== "object" || Array.isArray(value)
      || Object.keys(value).sort().join(",") !== "schemaVersion,scripts"
      || value.schemaVersion !== 1 || !Array.isArray(value.scripts) || value.scripts.length > 128
      || value.scripts.some((hash) => typeof hash !== "string" || !SHA256.test(hash))
      || new Set(value.scripts).size !== value.scripts.length) {
    throw new Error("Theme script trust registry is invalid");
  }
  return value;
}

export async function isThemeScriptTrusted(sha256, { trustFile = themeScriptTrustPath() } = {}) {
  if (typeof sha256 !== "string" || !SHA256.test(sha256)) throw new Error("Invalid theme script SHA-256");
  return (await readTrust(trustFile)).scripts.includes(sha256);
}

export async function trustThemeScript(themeDir, { trustFile = themeScriptTrustPath() } = {}) {
  const script = await readThemeScript(themeDir);
  if (!script) throw new Error("No theme.js exists to approve");
  const parent = path.dirname(path.resolve(trustFile));
  await fs.mkdir(parent, { recursive: true, mode: 0o700 });
  const parentStat = await fs.lstat(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) throw new Error("Script trust directory must not be a link");
  const lock = `${trustFile}.lock`;
  let locked = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { await fs.mkdir(lock, { mode: 0o700 }); locked = true; break; }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (attempt === 99) throw new Error("Theme script trust registry is busy");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  let temporary;
  try {
    const registry = await readTrust(trustFile);
    if (!registry.scripts.includes(script.sha256)) {
      if (registry.scripts.length >= 128) throw new Error("Theme script trust registry is full");
      registry.scripts.push(script.sha256);
      const bytes = Buffer.from(`${JSON.stringify(registry, null, 2)}\n`);
      if (bytes.length > MAX_TRUST_BYTES) throw new Error("Theme script trust registry exceeds its limit");
      temporary = path.join(parent, `.script-trust-${randomUUID()}.tmp`);
      await fs.writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
      await fs.rename(temporary, trustFile);
      temporary = null;
    }
    return { sha256: script.sha256 };
  } finally {
    if (temporary) await fs.unlink(temporary).catch((error) => { if (error.code !== "ENOENT") throw error; });
    if (locked) await fs.rmdir(lock);
  }
}
