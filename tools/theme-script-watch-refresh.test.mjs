import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await fs.readFile(new URL("../macos/scripts/injector.mjs", import.meta.url), "utf8");
function section(start, end, offset = 0) {
  const from = source.indexOf(start, offset);
  const to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `Missing watcher section: ${start}`);
  return source.slice(from, to);
}
const setupHelpers = section("  const beginTargetSetup =", "\n  const registerEarly =");
const refresh = section("  const refreshPayload =", "\n  const queuePayloadRefresh")
  .replace("const refreshPayload =", "globalThis.refreshPayload =");
const setupOffset = source.indexOf("      for (const target of targets) {", source.indexOf("async function runWatch"));
const recordSource = section("          record = {", "\n          connectionEpoch =", setupOffset);
const promoteSource = section("          const verification = await waitForVerifiedSession(", "          if (recoveryOperation &&", setupOffset);

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

async function until(predicate) {
  for (let attempt = 0; attempt < 100 && !predicate(); attempt += 1) {
    await new Promise(setImmediate);
  }
  assert.ok(predicate(), "Controlled watcher step did not start");
}

function fixture() {
  const sessions = new Map();
  const events = [];
  const errors = [];
  const logs = [];
  const hooks = new Map();
  const timerDelays = [];
  let token = 0;
  const step = async (kind, record, values = {}) => {
    events.push({ kind, id: record.session.id, ...values });
    return hooks.get(`${kind}:${record.session.id}`)?.(record);
  };
  const context = vm.createContext({
    sessions, activeTargetSetups: 0, targetSetupWaiters: new Set(),
    mutationEpoch: 0, controlOnly: false, activeOperation: null,
    current: { revision: "A", payload: "payload-A", theme: { id: "A", name: "A" } },
    options: { themeDir: "unused", timeoutMs: 30000 },
    loadPayload: async () => ({ revision: "B", payload: "payload-B", theme: { id: "B", name: "B" }, timings: { buildMs: 0 } }),
    nextOperationToken: () => ++token,
    setTimeout(callback, delay) { timerDelays.push(delay); return setTimeout(callback, delay); },
    clearTimeout,
    presentOperationUi: async (session, operationToken, state) => step(`ui:${state}`, { session }, { operationToken }),
    registerEarlyForRecord: async (record, payload, revision) => {
      await step("register", record, { payload, revision });
      const identifier = `next:${record.session.id}`;
      record.earlyScriptIds.add(identifier);
      return identifier;
    },
    removeEarlyIdentifier: async (record, identifier) => {
      await step("remove", record, { identifier });
      record.earlyScriptIds.delete(identifier);
      if (record.earlyScriptId === identifier) record.earlyScriptId = null;
      return true;
    },
    applyToSession: async (session, payload) => step("apply", { session }, { payload }),
    waitForVerifiedSession: async (session, timeoutMs, themeId, revision) => {
      const result = await step("verify", { session }, { timeoutMs, themeId, revision });
      return result ?? { pass: true };
    },
    console: { error: (line) => errors.push(line), log: (line) => logs.push(line) },
  });
  vm.runInContext(`${setupHelpers}\n${refresh}\nObject.assign(globalThis, { beginTargetSetup, finishTargetSetup });`, context);
  const makeRecord = (id, codexReady = true) => {
    const session = { id, closed: false };
    const record = vm.runInNewContext(`let record; ${recordSource}; record;`, { session });
    assert.equal(record.codexReady, false, "New connections must remain pending until initial verification");
    record.codexReady = codexReady;
    record.earlyScriptId = `previous:${id}`;
    record.earlyScriptIds.add(record.earlyScriptId);
    return record;
  };
  return {
    context, sessions, events, errors, logs, hooks, timerDelays, makeRecord,
    run: () => context.refreshPayload(),
    beginSetup: () => context.beginTargetSetup(),
    finishSetup: () => context.finishTargetSetup(),
    gate(kind, id) {
      const gate = deferred();
      hooks.set(`${kind}:${id}`, () => gate.promise);
      return gate;
    },
    reached: (kind, id) => events.some((event) => event.kind === kind && event.id === id),
  };
}

test("actual refresh handles only the main record while twenty rejected auxiliary generations churn", async () => {
  const f = fixture();
  f.sessions.set("main", f.makeRecord("main"));
  const gate = f.gate("verify", "main");
  const running = f.run();
  await until(() => f.reached("verify", "main"));
  for (let generation = 1; generation <= 20; generation += 1) {
    const id = `auxiliary-${generation}`;
    const record = f.makeRecord(id, false);
    f.sessions.set("auxiliary", record);
    f.hooks.set(`verify:${id}`, () => ({ pass: false }));
    await new Promise(setImmediate);
    if (generation < 20) {
      record.session.closed = true;
      f.sessions.delete("auxiliary");
    }
  }
  gate.resolve({ pass: true });
  await running;
  assert.deepEqual(f.events.filter((event) => event.kind === "apply").map((event) => event.id), ["main"]);
  assert.deepEqual(f.events.filter((event) => event.kind === "verify").map((event) => event.id), ["main"]);
  assert.equal(f.errors.length, 0);
  assert.equal(f.logs.filter((line) => line.includes("refreshed theme")).length, 1);
});

test("snapshot skips an existing pending record and never follows a later ready record", async () => {
  const f = fixture();
  f.sessions.set("main", f.makeRecord("main"));
  f.sessions.set("pending", f.makeRecord("pending", false));
  const gate = f.gate("verify", "main");
  const running = f.run();
  await until(() => f.reached("verify", "main"));
  f.sessions.set("late", f.makeRecord("late"));
  gate.resolve({ pass: true });
  await running;
  assert.deepEqual(f.events.filter((event) => event.kind === "apply").map((event) => event.id), ["main"]);
  assert.equal(f.sessions.get("pending").operationToken, null);
  assert.equal(f.sessions.get("late").operationToken, null);
});

test("a current accepted record still reports a real verification failure", async () => {
  const f = fixture();
  const record = f.makeRecord("main");
  f.sessions.set("main", record);
  f.hooks.set("verify:main", () => ({ pass: false }));
  await f.run();
  assert.equal(record.needsLoadFallback, true);
  assert.equal(f.reached("ui:error", "main"), true);
  assert.deepEqual(f.errors, ["[dream-skin] theme refresh failed: Theme refresh verification failed"]);
  assert.equal(record.earlyScriptIds.has("next:main"), true);
});

for (const stage of ["ui:loading", "register", "remove", "apply", "verify", "ui:success", "ui:error"]) {
  test(`record replacement during ${stage} stops stale refresh side effects`, async () => {
    const f = fixture();
    const old = f.makeRecord("main");
    f.sessions.set("main", old);
    if (stage === "ui:error") f.hooks.set("verify:main", () => ({ pass: false }));
    const gate = f.gate(stage, "main");
    const running = f.run();
    await until(() => f.reached(stage, "main"));
    const replacement = f.makeRecord("replacement");
    f.sessions.set("main", replacement);
    gate.resolve(stage === "verify" ? { pass: false } : undefined);
    await running;
    assert.equal(replacement.operationToken, null);
    assert.equal(replacement.earlyScriptId, "previous:replacement");
    assert.equal(f.errors.length, 0);
    assert.equal(old.needsLoadFallback, stage === "ui:error");
    if (["ui:loading", "register", "remove"].includes(stage)) assert.equal(f.reached("apply", "main"), false);
    if (["ui:loading", "register", "remove", "apply"].includes(stage)) assert.equal(f.reached("verify", "main"), false);
    if (stage !== "ui:loading") assert.equal(old.earlyScriptIds.has("next:main"), false);
    if (stage !== "ui:error") assert.equal(f.reached("ui:error", "main"), false);
  });
}

test("removal and closed-session rejection during verification do not report a theme failure", async () => {
  const f = fixture();
  const record = f.makeRecord("main");
  f.sessions.set("main", record);
  const gate = f.gate("verify", "main");
  const running = f.run();
  await until(() => f.reached("verify", "main"));
  f.sessions.delete("main");
  record.session.closed = true;
  gate.reject(new Error("CDP socket closed"));
  await running;
  assert.equal(record.needsLoadFallback, false);
  assert.equal(f.reached("ui:error", "main"), false);
  assert.equal(f.errors.length, 0);
});

for (const invalidation of ["pause", "epoch"]) {
  test(`${invalidation} during registration cancels the new early script and remaining refresh`, async () => {
    const f = fixture();
    const record = f.makeRecord("main");
    f.sessions.set("main", record);
    const gate = f.gate("register", "main");
    const running = f.run();
    await until(() => f.reached("register", "main"));
    if (invalidation === "pause") f.context.controlOnly = true;
    else f.context.mutationEpoch += 1;
    gate.resolve();
    await running;
    assert.equal(record.earlyScriptIds.has("next:main"), false);
    assert.equal(f.reached("apply", "main"), false);
    assert.equal(f.errors.length, 0);
    assert.equal(f.logs.length, 0);
  });
}

test("refresh drains setup under the old revision before publishing and applying the latest payload", async () => {
  const f = fixture();
  const main = f.makeRecord("main", false);
  f.sessions.set("main", main);
  f.beginSetup();
  const running = f.run();
  await until(() => f.context.targetSetupWaiters.size === 1);
  assert.equal(f.context.current.revision, "A");
  assert.deepEqual(f.timerDelays, [f.context.options.timeoutMs]);
  assert.equal(f.events.length, 0);
  main.codexReady = true;
  f.finishSetup();
  f.beginSetup();
  f.sessions.set("new-pending", f.makeRecord("new-pending", false));
  try { await running; } finally { f.finishSetup(); }
  assert.equal(f.context.current.revision, "B");
  assert.deepEqual(f.events.filter((event) => event.kind === "register").map(({ id, revision }) => ({ id, revision })), [{ id: "main", revision: "B" }]);
  assert.deepEqual(f.events.filter((event) => event.kind === "verify").map(({ id, revision }) => ({ id, revision })), [{ id: "main", revision: "B" }]);
  assert.equal(f.context.targetSetupWaiters.size, 0);
});

for (const invalidation of ["none", "pause", "replace", "closed"]) {
  test(`initial verification promotes readiness only for the current live generation (${invalidation})`, async () => {
    const f = fixture();
    const record = f.makeRecord("main", false);
    const gate = deferred();
    let invalidated = 0;
    Object.assign(f.context, {
      record, session: record.session, target: { id: "main" }, connectionEpoch: 0,
      waitForVerifiedSession: () => gate.promise,
      invalidateEarly: async () => { invalidated += 1; },
    });
    f.sessions.set("main", record);
    vm.runInContext(`globalThis.promote = async () => { for (const target of [globalThis.target]) { ${promoteSource} } };`, f.context);
    const running = f.context.promote();
    assert.equal(record.codexReady, false);
    if (invalidation === "pause") f.context.controlOnly = true;
    if (invalidation === "replace") f.sessions.set("main", f.makeRecord("replacement"));
    if (invalidation === "closed") record.session.closed = true;
    gate.resolve({ pass: true });
    await running;
    assert.equal(record.codexReady, invalidation === "none");
    assert.equal(invalidated, invalidation === "pause" ? 1 : 0);
  });
}
