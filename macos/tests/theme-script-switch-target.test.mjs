import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const source = await fs.readFile(new URL("../scripts/switch-theme-macos.sh", import.meta.url), "utf8");
const guard = source.match(/if \[ -e "\$THEME_DIR\/theme\.js"[^]*?\nfi/)?.[0];
assert.ok(guard, "switch validates the active script target before publishing resources");
assert.ok(source.indexOf(guard) < source.indexOf('for entry in "$stage/"*; do'));
const directory = await fs.mkdtemp(path.join(os.tmpdir(), "dreamskin-script-target-"));
const target = path.join(directory, "theme.js");
const trustGate = source.match(/"\$NODE" "\$INJECTOR" --check-payload[^]*?\n\s+\|\| fail [^\n]+/)?.[0];
assert.ok(trustGate?.includes("--require-script-trust"), "switch requires script trust before active publication");
assert.ok(source.indexOf(trustGate) < source.indexOf('for entry in "$stage/"*; do'));
function check(expected) {
  const result = spawnSync("/bin/bash", ["-c", `fail() { exit 42; }\n${guard}`], {
    env: { ...process.env, THEME_DIR: directory }, encoding: "utf8",
  });
  assert.ifError(result.error);
  assert.equal(result.status, expected, result.stderr);
}
try {
  check(0);
  await fs.writeFile(target, "return;");
  check(0);
  await fs.unlink(target);
  await fs.mkdir(target);
  await fs.writeFile(path.join(target, "preserve"), "keep");
  check(42);
  assert.equal(await fs.readFile(path.join(target, "preserve"), "utf8"), "keep");
  await fs.rm(target, { recursive: true });
  const outside = path.join(directory, "outside.js");
  await fs.writeFile(outside, "preserve");
  await fs.symlink(outside, target);
  check(42);
  assert.equal(await fs.readFile(outside, "utf8"), "preserve");
  const stage = path.join(directory, "candidate");
  const fixtureHome = path.join(directory, "home");
  await fs.mkdir(stage);
  await fs.mkdir(fixtureHome);
  await fs.writeFile(path.join(stage, "background.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"));
  const config = { schemaVersion: 1, id: "trust-gate", image: "background.png" };
  const configPath = path.join(stage, "theme.json");
  await fs.writeFile(configPath, JSON.stringify(config));
  const injector = new URL("../scripts/injector.mjs", import.meta.url).pathname;
  const environment = { ...process.env, HOME: fixtureHome, NODE: process.execPath, INJECTOR: injector, stage, THEME_ID: config.id };
  function preflight() {
    const result = spawnSync("/bin/bash", ["-c", `fail() { exit 42; }\n${trustGate}\nprintf 'publication-allowed'`], {
      env: environment, encoding: "utf8", timeout: 10000,
    });
    assert.ifError(result.error);
    return result;
  }
  assert.equal(preflight().status, 0, "ordinary themes require no grant");
  await fs.writeFile(configPath, JSON.stringify({ ...config, script: "theme.js" }));
  await fs.writeFile(path.join(stage, "theme.js"), 'throw new Error("must not execute in preflight");');
  const rejected = preflight();
  assert.equal(rejected.status, 42, rejected.stderr);
  assert.match(rejected.stderr, /not trusted/);
  assert.equal(rejected.stdout, "");
  // This isolated fixture explicitly approves only its own local test script.
  const grant = spawnSync(process.execPath, [injector, "--trust-theme-script", "--theme-dir", stage], {
    env: environment, encoding: "utf8", timeout: 10000,
  });
  assert.ifError(grant.error);
  assert.equal(grant.status, 0, grant.stderr);
  assert.equal(preflight().status, 0, "reviewed candidate may proceed without executing its script");
  await fs.appendFile(path.join(stage, "theme.js"), "\n// edited after approval");
  assert.equal(preflight().status, 42, "edited candidate must stop before active publication");
  console.log("PASS: switch rejects directory and symlink script targets before resource publication.");
} finally {
  await fs.rm(directory, { recursive: true, force: true });
}
