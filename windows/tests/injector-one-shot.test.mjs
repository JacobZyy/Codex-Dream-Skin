import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const here = path.dirname(fileURLToPath(import.meta.url));
const injectorPath = path.resolve(here, "../scripts/injector.mjs");
let versionRequests = 0;
let port = 0;

const server = http.createServer((request, response) => {
  response.setHeader("content-type", "application/json");
  if (request.url === "/json/list") {
    response.end("[]");
    return;
  }
  if (request.url === "/json/version") {
    versionRequests += 1;
    response.end(JSON.stringify({
      webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/test-browser`,
    }));
    return;
  }
  response.statusCode = 404;
  response.end("{}");
});

await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
port = server.address().port;

const runMode = (mode) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [
    injectorPath,
    mode,
    "--port", String(port),
    "--browser-id", "test-browser",
    "--timeout-ms", "250",
  ], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.once("error", reject);
  child.once("close", (code) => resolve({ code, stdout, stderr }));
});

try {
  for (const mode of ["--verify", "--once", "--remove"]) {
    const requestsBefore = versionRequests;
    const result = await runMode(mode);
    assert.notEqual(result.code, 0, `${mode} should time out because the fixture exposes no page targets.`);
    assert.ok(versionRequests > requestsBefore,
      `${mode} must pass its expected Browser ID into one-shot target discovery.`);
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /options is not defined/,
      `${mode} must not reference a CLI options binding outside its lexical scope.`);
  }
} finally {
  await new Promise((resolve) => server.close(resolve));
}

console.log("PASS: Windows verify, once, and remove pass Browser ID explicitly into one-shot discovery.");

function oneShotFixture(functionSource, verificationPass = true) {
  const calls = { reload: 0, apply: 0, remove: 0, verify: [], verifyRemoved: 0, close: 0 };
  const output = [];
  const isolatedProcess = { exitCode: 0 };
  const session = {
    async send(method, params) {
      assert.equal(method, "Page.reload");
      assert.equal(params.ignoreCache, true);
      calls.reload += 1;
    },
    close() { calls.close += 1; },
  };
  const runOneShot = vm.runInNewContext(`${functionSource}\nrunOneShot;`, {
    connectCodexTargets: async () => [{ target: { id: "test-page" }, session, probe: { markers: [] } }],
    loadPayload: async () => ({ payload: "test-payload", theme: { id: "test-theme", name: "Test Theme" }, revision: "test-revision" }),
    applyToSession: async (actualSession, payload) => {
      assert.equal(actualSession, session);
      assert.equal(payload, "test-payload");
      calls.apply += 1;
    },
    removeFromSession: async (actualSession) => {
      assert.equal(actualSession, session);
      calls.remove += 1;
    },
    waitForVerifiedSession: async (...args) => {
      assert.equal(args[0], session);
      calls.verify.push(args.slice(1));
      return { pass: verificationPass };
    },
    verifyRemovedSession: async (actualSession) => {
      assert.equal(actualSession, session);
      calls.verifyRemoved += 1;
      return true;
    },
    nextOperationToken: () => "test-operation",
    presentOperationUi: async () => true,
    bestEffortOperationUi: async () => true,
    setTimeout: (callback) => callback(),
    console: { log: (message) => output.push(JSON.parse(message)) },
    process: isolatedProcess,
    SKIN_VERSION: "test-version",
  });
  return { runOneShot, calls, output, process: isolatedProcess };
}

for (const [platform, relativePath] of [
  ["macOS", "../../macos/scripts/injector.mjs"],
  ["Windows", "../scripts/injector.mjs"],
]) {
  const source = await fs.readFile(path.resolve(here, relativePath), "utf8");
  const start = source.indexOf("async function runOneShot(options) {");
  const end = source.indexOf("\n}\n", start);
  assert.ok(start >= 0 && end > start, `${platform} must expose its complete one-shot function body.`);
  const functionSource = source.slice(start, end + 2);
  const options = { reload: true, port: 9222, timeoutMs: 250, browserId: "test-browser", themeDir: "test-theme-dir" };
  const expectedVerifyArgs = platform === "Windows"
    ? ["test-page", 250, "test-theme", "test-revision"]
    : [250, "test-theme", "test-revision"];

  for (const [mode, applyCount, removeCount] of [["verify", 0, 0], ["once", 2, 0], ["remove", 0, 1]]) {
    test(`${platform}: ${mode} with reload preserves its one-shot operation`, async () => {
      const fixture = oneShotFixture(functionSource);
      await fixture.runOneShot({ ...options, mode });
      assert.equal(fixture.calls.reload, 1);
      assert.equal(fixture.calls.apply, applyCount);
      assert.equal(fixture.calls.remove, removeCount);
      assert.deepEqual(fixture.calls.verify, mode === "remove" ? [] : [expectedVerifyArgs]);
      assert.equal(fixture.calls.verifyRemoved, removeCount);
      assert.equal(fixture.process.exitCode, 0);
      assert.ok(fixture.calls.close >= 1, "The one-shot session must be closed.");
      assert.equal(fixture.output[0].targets.length, 1);
      assert.equal(fixture.output[0].targets[0].error, undefined);
    });
  }

  test(`${platform}: verify with reload fails when the watcher does not restore the theme`, async () => {
    const fixture = oneShotFixture(functionSource, false);
    await fixture.runOneShot({ ...options, mode: "verify" });
    assert.equal(fixture.calls.reload, 1);
    assert.equal(fixture.calls.apply, 0, "Verification must not conceal a missing watcher by applying the theme itself.");
    assert.equal(fixture.calls.remove, 0);
    assert.deepEqual(fixture.calls.verify, [expectedVerifyArgs]);
    assert.equal(fixture.output[0].targets[0].result.pass, false);
    assert.equal(fixture.process.exitCode, 2, "A failed watcher verification must fail the isolated CLI process.");
  });
}
