import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import type { RuntimeSessionSpec } from "@evoloop/contracts/runtime";
import { CodexAppServerAdapter, RuntimeNotSentError, RuntimeProtocolError, RuntimeUnknownError, type CodexAppServerOptions } from "../src/index.js";

// Transport and fault-scope hardening (audit C1, C2, C3, C5, C7–C10).
const fixture = resolve(import.meta.dirname, "fixture.mjs");
const spec: RuntimeSessionSpec = { actorId: "original-actor", sessionId: "session-1", roleId: "role-1", projectId: "project-1",
  cwd: "/tmp/evoloop-fixture", authorizationScope: "task:fixture", model: "gpt-6-sol", sandbox: "danger-full-access", approvalPolicy: "never" };
const testAdapter = (mode: string, options: CodexAppServerOptions = {}, extra: string[] = []): CodexAppServerAdapter =>
  new CodexAppServerAdapter({ initializationTimeoutMs: 5_000, requestTimeoutMs: 2_000, executable: process.execPath,
    spawnArgs: [fixture, mode, ...extra], ...options });
const sleep = (ms: number) => new Promise(resolveWait => setTimeout(resolveWait, ms));
const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
};

test("a closed App Server stdin ends in-flight work as unknown without an uncaught EPIPE", async t => {
  const adapter = testAdapter("stdin-closed-live");
  t.after(() => adapter.close());
  await adapter.open();
  const binding = await adapter.create(spec);
  await sleep(50);
  await assert.rejects(() => adapter.startTurn(binding, "task", "op-stdin"),
    error => error instanceof RuntimeUnknownError && error.method === "turn/start");
  assert.ok(["stdin_error", "stdout_closed"].includes(adapter.lastChildDiagnostic()?.firstLossReason ?? ""));
  assert.equal(adapter.isReady(), false);
});

test("an overlong native line disconnects as protocol_error instead of buffering without bound", async t => {
  const adapter = testAdapter("overlong-line", { maxLineBytes: 4096 });
  t.after(() => adapter.close());
  await adapter.open();
  const binding = await adapter.create(spec);
  await assert.rejects(() => adapter.startTurn(binding, "task", "op-long"), RuntimeUnknownError);
  assert.equal(adapter.lastChildDiagnostic()?.firstLossReason, "protocol_error");
  assert.equal(adapter.isReady(), false);
  assert.throws(() => new CodexAppServerAdapter({ maxLineBytes: 0 }), /maxLineBytes/);
});

test("an invalid server request is answered alone and the shared connection keeps serving", async t => {
  const adapter = testAdapter("invalid-server-request");
  t.after(() => adapter.close());
  await adapter.open();
  const binding = await adapter.create(spec);
  const answered = new Promise<number>(resolveCode => adapter.onEvent(event => {
    if (event.method === "fixture/invalidRequestAnswered") resolveCode((event.params as { code: number }).code);
  }));
  const turn = await adapter.startTurn(binding, "task", "op-invalid");
  assert.equal(turn.id, "turn-1");
  assert.equal(await answered, -32600);
  assert.equal(adapter.isReady(), true);
  assert.equal((await adapter.listTurns(binding)).data[0]?.status, "completed");
  assert.equal(adapter.lastChildDiagnostic(), null);
});

test("close stops tools the App Server started through its process group", { skip: process.platform === "win32" }, async t => {
  const directory = await mkdtemp(join(tmpdir(), "evoloop-codex-group-"));
  const pidFile = join(directory, "sleeper.pid");
  let sleeper = 0;
  t.after(async () => {
    if (sleeper && alive(sleeper)) try { process.kill(sleeper, "SIGKILL"); } catch { /* already gone */ }
    await rm(directory, { recursive: true, force: true });
  });
  const adapter = testAdapter("grandchild", {}, [pidFile]);
  await adapter.open();
  sleeper = Number(await readFile(pidFile, "utf8"));
  assert.ok(Number.isSafeInteger(sleeper) && sleeper > 0);
  assert.equal(alive(sleeper), true);
  await adapter.close();
  const deadline = Date.now() + 3_000;
  while (alive(sleeper) && Date.now() < deadline) await sleep(25);
  assert.equal(alive(sleeper), false, "grandchild survived adapter close");
});

for (const mode of ["context-window-turn", "context-window-object"]) {
  test(`${mode}: native context overflow is classified from codexErrorInfo`, async t => {
    const adapter = testAdapter(mode);
    t.after(() => adapter.close());
    await adapter.open();
    const binding = await adapter.create(spec);
    const page = await adapter.listTurns(binding);
    assert.equal(page.data[0]?.status, "failed");
    assert.equal(page.data[0]?.error?.category, "context_window_exceeded");
    assert.equal(page.data[0]?.error?.httpStatus, null);
    assert.doesNotMatch(JSON.stringify(page), /private overflow detail/);
  });
}

test("a Turn refused before any write is not-sent and stays dispatchable; a written Turn is never not-sent", async t => {
  const adapter = testAdapter("normal");
  t.after(() => adapter.close());
  await adapter.open();
  const binding = await adapter.create(spec);
  (adapter as unknown as { child: { stdin: { destroy(): void } } }).child.stdin.destroy();
  // Same macrotask: the connection is still marked ready, so both calls reach the pre-write check.
  await assert.rejects(adapter.startTurn(binding, "task", "op-not-sent"),
    error => error instanceof RuntimeNotSentError && error instanceof RuntimeProtocolError && !(error instanceof RuntimeUnknownError));
  await assert.rejects(adapter.startTurn(binding, "task", "op-not-sent"), RuntimeNotSentError,
    "a not-sent attempt must not be remembered as an attempted full Turn");
  const disconnected = testAdapter("disconnect", { requestTimeoutMs: 500 });
  t.after(() => disconnected.close());
  await disconnected.open();
  const written = await disconnected.create(spec);
  await assert.rejects(disconnected.startTurn(written, "task", "op-written"),
    error => error instanceof RuntimeUnknownError && !(error instanceof RuntimeNotSentError));
});

test("a Session cannot be created with a reasoning effort thread/start would drop", async t => {
  const adapter = testAdapter("normal");
  t.after(() => adapter.close());
  await adapter.open();
  await assert.rejects(() => adapter.create({ ...spec, reasoningEffort: "high" }), /execution profile activation/);
  assert.equal(adapter.isReady(), true);
});

test("dynamic tool call replay memory is bounded and evicts the oldest entry first", async t => {
  const adapter = testAdapter("dynamic", {
    dynamicTools: async () => [{ type: "function", name: "browser_snapshot", description: "Read approved view", inputSchema: { type: "object", properties: {}, additionalProperties: false } }],
    callDynamicTool: async () => ({ contentItems: [{ type: "inputText", text: "approved" }], success: true }),
  });
  t.after(() => adapter.close());
  await adapter.open();
  const binding = await adapter.create(spec);
  const seen = (adapter as unknown as { seenToolCalls: Set<string> }).seenToolCalls;
  for (let index = 0; index < 10_000; index++) seen.add(`old\0${index}`);
  const decided = new Promise(resolveDecision => adapter.onEvent(event => { if (event.method === "fixture/toolDecision") resolveDecision(event.params); }));
  await adapter.startTurn(binding, "read", "operation-cap");
  assert.equal((await decided as { result: { success: boolean } }).result.success, true);
  assert.equal(seen.size, 10_000);
  assert.equal(seen.has("old\u00000"), false);
  assert.equal(seen.has("old\u00001"), true);
  assert.equal(seen.has("thread-owned\u0000call-1"), true);
});

test("a dedicated codexHome replaces the inherited CODEX_HOME for the App Server child", async t => {
  const adapter = testAdapter("env-observe", { requestTimeoutMs: 500, codexHome: "/synthetic/evoloop-codex",
    environment: { HOME: "/synthetic/home", CODEX_HOME: "/synthetic/personal-codex", PATH: "/usr/bin:/bin" } });
  t.after(() => adapter.close());
  await adapter.open();
  const binding = await adapter.create(spec);
  const read = await adapter.inspect(binding) as { observedEnvironment: Record<string, string | null> };
  assert.equal(read.observedEnvironment.CODEX_HOME, "/synthetic/evoloop-codex");
  assert.equal(read.observedEnvironment.HOME, "/synthetic/home");
  assert.throws(() => new CodexAppServerAdapter({ codexHome: "relative/codex" }), /codexHome must be an absolute path/);
});

test("the Codex adapter declares a shared process and its outcome classes", () => {
  const capabilities = new CodexAppServerAdapter({ expectedVersion: "codex-cli 0.167.0-alpha.3.2" }).capabilities();
  assert.equal(capabilities.provider, "codex");
  assert.equal(capabilities.process, "shared");
  assert.deepEqual(capabilities.errors, { notSent: true, rejected: true });
  assert.equal(capabilities.compaction.autoCompacts, true);
  assert.equal(new CodexAppServerAdapter().capabilities().compaction.mode, "unavailable");
});
