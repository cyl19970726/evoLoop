import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RuntimeNotSentError, RuntimeProtocolError, type RuntimeBinding, type RuntimeSessionSpec, type RuntimeSkillPlan,
  type RuntimeTurn } from "@evoloop/contracts/runtime";
import { CLAUDE_BUILTIN_PLUGIN_SKILLS, ClaudeAgentSdkAdapter, TurnLedger, skillPlanHash, skillPluginManifest,
  type ClaudeAgentSdkAdapterOptions } from "../src/index.js";

const fake = fileURLToPath(new URL("./fake-claude.mjs", import.meta.url));
const marker = (operationId: string) => `[evoloop-run-operation:${operationId}]`;

async function setup(mode = "ok", extra: Partial<ClaudeAgentSdkAdapterOptions> = {}) {
  const root = await mkdtemp(join(tmpdir(), "evoloop-claude-"));
  const configDir = join(root, "config"), cwd = join(root, "work"), log = join(root, "fake.log");
  await mkdir(cwd);
  const environment = { PATH: process.env.PATH, HOME: process.env.HOME, FAKE_CLAUDE_MODE: mode, FAKE_CLAUDE_LOG: log,
    SECRET_TOKEN: "do-not-pass", DATABASE_URL: "postgres://user:password@localhost/db", NODE_OPTIONS: "--inspect",
    CLAUDE_CODE_MAX_RETRIES: "2" };
  const options: ClaudeAgentSdkAdapterOptions = { configDir, executable: fake, environment,
    envPassthrough: ["FAKE_CLAUDE_MODE", "FAKE_CLAUDE_LOG"], verifyBinding: async () => true, startTimeoutMs: 15_000, ...extra };
  const adapter = new ClaudeAgentSdkAdapter(options);
  await adapter.open();
  const spec: RuntimeSessionSpec = { actorId: "maintainer", sessionId: randomUUID(), roleId: "builder", projectId: randomUUID(), cwd,
    authorizationScope: "project", sandbox: "danger-full-access", approvalPolicy: "never" };
  const launches = async () => (await readFile(log, "utf8").catch(() => "")).split("\n").filter(Boolean)
    .map(line => JSON.parse(line) as { pid: number; argv: string[]; envKeys: string[]; configDir: string; disableMemory: string | null;
      clientApp: string | null; claudeAiConnectors: string | null });
  return { root, configDir, cwd, options, adapter, spec, launches,
    cleanup: async () => { await adapter.close(); await rm(root, { recursive: true, force: true }); } };
}

async function settled(adapter: ClaudeAgentSdkAdapter, binding: RuntimeBinding, turnId: string): Promise<RuntimeTurn> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const turn = (await adapter.listTurns(binding)).data.find(candidate => candidate.id === turnId);
    if (turn && ["completed", "failed", "interrupted"].includes(turn.status) && turn.completedAtUtc) return turn;
    if (Date.now() > deadline) throw new Error(`Turn ${turnId} did not settle: ${JSON.stringify(turn)}`);
    await new Promise(resolveWait => setTimeout(resolveWait, 25));
  }
}

const running = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };

const deadPid = (): Promise<number> => new Promise((resolvePid, reject) => {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  child.on("error", reject);
  child.on("exit", () => resolvePid(child.pid!));
});

test("a Turn runs in its own process under the fixed session and settles from the result", async () => {
  const h = await setup();
  try {
    const binding = await h.adapter.create(h.spec);
    assert.equal(binding.owner, "evoloop-claude-agent-sdk");
    assert.equal(binding.nativeThreadId, binding.nativeSessionId);
    assert.equal(binding.observedModel, null);
    const first = randomUUID();
    const started = await h.adapter.startTurn(binding, `${marker(first)}\nDo the task`, first);
    assert.equal(started.status, "inProgress");
    const turn = await settled(h.adapter, binding, started.id);
    assert.equal(turn.status, "completed");
    assert.deepEqual(turn.usage, { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 2, cacheCreationInputTokens: 0 });
    assert.equal(turn.costUsd, 0.01);
    const items = (await h.adapter.listItems(binding, started.id)).data as Array<Record<string, unknown>>;
    assert.equal(items[0]!.type, "userMessage");
    assert.match(JSON.stringify(items[0]), new RegExp(first));
    assert.ok(items.some(item => item.type === "agentMessage" && item.phase === "commentary"));
    const tool = items.find(item => item.type === "toolCall");
    assert.equal(tool?.name, "Read");
    assert.doesNotMatch(JSON.stringify(items), /secret\.txt/, "tool input is never recorded");
    assert.equal(items.at(-1)!.phase, "final_answer");

    const second = randomUUID();
    const next = await h.adapter.startTurn(binding, `${marker(second)}\nContinue`, second);
    const nextTurn = await settled(h.adapter, binding, next.id);
    assert.equal(nextTurn.status, "completed");
    assert.equal(nextTurn.costUsd, 0.01, "cumulative session total is differenced per Turn");
    assert.deepEqual((await h.adapter.listTurns(binding)).data.map(entry => entry.id), [next.id, started.id], "newest first");

    const [launchA, launchB] = await h.launches();
    assert.ok(launchA && launchB);
    assert.match(launchA.argv.join(" "), new RegExp(`--session-id[= ]${binding.nativeSessionId}`));
    assert.match(launchB.argv.join(" "), new RegExp(`--resume[= ]${binding.nativeSessionId}`));
    for (const launch of [launchA, launchB]) {
      const argv = launch.argv.join(" ");
      assert.match(argv, /--setting-sources[= ]project/);
      assert.match(argv, /bypassPermissions/);
      assert.match(argv, /--allow-dangerously-skip-permissions/);
      assert.match(argv, /AskUserQuestion/);
      assert.match(argv, /SendMessage/, "the native peer-message tool is disallowed");
      assert.match(argv, /--settings[= ]\{"crossSessionInbound":"refuse","disableClaudeAiConnectors":true\}/,
        "native peer messages are refused and account connectors stay off");
      assert.equal(launch.configDir, h.configDir);
      assert.equal(launch.claudeAiConnectors, "false", "the environment repeats the connector switch");
      assert.equal(launch.disableMemory, "1");
      assert.equal(launch.clientApp, "evoloop/0.1.0");
      for (const name of ["SECRET_TOKEN", "DATABASE_URL", "NODE_OPTIONS"]) assert.ok(!launch.envKeys.includes(name), `${name} must not reach Claude`);
      assert.ok(launch.envKeys.includes("CLAUDE_CODE_MAX_RETRIES"), "the operator retry bound reaches Claude");
    }
    await assert.rejects(h.adapter.startTurn(binding, `${marker(first)}\nAgain`, first), (error: Error) =>
      error instanceof RuntimeProtocolError && !(error instanceof RuntimeNotSentError) && /already attempted/.test(error.message));
  } finally { await h.cleanup(); }
});

test("failures are classified from the result without copying native text", async () => {
  for (const [mode, category, providerCode, httpStatus] of [
    ["budget", "budget_exceeded", "error_max_budget_usd", null],
    ["context", "context_window_exceeded", "prompt_too_long", null],
    ["auth", "authentication_failed", "authentication_failed", 401],
  ] as const) {
    const h = await setup(mode);
    try {
      const binding = await h.adapter.create(h.spec);
      const operationId = randomUUID();
      const started = await h.adapter.startTurn(binding, `${marker(operationId)}\nTask`, operationId);
      const turn = await settled(h.adapter, binding, started.id);
      assert.equal(turn.status, "failed", mode);
      assert.equal(turn.error?.category, category, mode);
      assert.equal(turn.error?.providerCode, providerCode, mode);
      assert.equal(turn.error?.httpStatus, httpStatus, mode);
      const recorded = JSON.stringify([turn, (await h.adapter.listItems(binding, started.id)).data]);
      assert.doesNotMatch(recorded, /\/private\//, `${mode}: native error text is never recorded`);
      if (mode === "budget") assert.equal(turn.costUsd, 0.5);
    } finally { await h.cleanup(); }
  }
});

test("an interrupt reaches the running Turn and the result settles it as interrupted", async () => {
  const h = await setup("hang");
  try {
    const binding = await h.adapter.create(h.spec);
    const operationId = randomUUID();
    const started = await h.adapter.startTurn(binding, `${marker(operationId)}\nLong task`, operationId);
    assert.equal((await h.adapter.listTurns(binding)).data[0]!.status, "inProgress");
    assert.equal(((await h.adapter.inspect(binding)) as { thread: { status: { type: string } } }).thread.status.type, "active");
    const other = randomUUID();
    await assert.rejects(h.adapter.startTurn(binding, `${marker(other)}\nSecond`, other), RuntimeNotSentError);
    await assert.rejects(h.adapter.archiveThread(binding), /running Turn/);
    await h.adapter.interruptTurn(binding, started.id);
    const turn = await settled(h.adapter, binding, started.id);
    assert.equal(turn.status, "interrupted");
    assert.equal(turn.error, undefined);
    // The ledger settles the Turn before the adapter releases the exited process. While it is still
    // held, interrupting a settled Turn is a deliberate no-op, so wait (bounded) for the release.
    const released = Date.now() + 5_000;
    for (;;) {
      const outcome = await h.adapter.interruptTurn(binding, started.id).then(() => "accepted", error => error);
      if (outcome !== "accepted") { assert.match(String((outcome as Error).message), /not running/); break; }
      assert.ok(Date.now() < released, "the settled Turn was never released by the adapter");
      await new Promise(resolveWait => setTimeout(resolveWait, 25));
    }
  } finally { await h.cleanup(); }
});

test("a start right after a settled Turn waits for that process to exit instead of refusing", async () => {
  const h = await setup("ok");
  h.options.environment!.FAKE_CLAUDE_LINGER_MS = "1500";
  h.options.envPassthrough = [...(h.options.envPassthrough ?? []), "FAKE_CLAUDE_LINGER_MS"];
  const adapter = new ClaudeAgentSdkAdapter(h.options);
  await adapter.open();
  try {
    const binding = await adapter.create(h.spec);
    const first = randomUUID();
    const started = await adapter.startTurn(binding, `${marker(first)}\nFirst`, first);
    assert.equal((await settled(adapter, binding, started.id)).status, "completed");
    const second = randomUUID(), before = Date.now();
    const next = await adapter.startTurn(binding, `${marker(second)}\nSecond`, second);
    assert.ok(Date.now() - before >= 500, "the start waited for the lingering process");
    assert.equal((await settled(adapter, binding, next.id)).status, "completed");
  } finally { await adapter.close(); await h.cleanup(); }
});

test("a process still running after its result does not hold the Session and is stopped after the exit grace", async () => {
  // SIGTERM is enough for a CLI that honours it; one that ignores it is killed after the same grace again.
  for (const ignoreTerm of [false, true]) {
    const h = await setup("ok", { exitGraceMs: 200 });
    h.options.environment = { ...h.options.environment, FAKE_CLAUDE_LINGER_MS: "60000", FAKE_CLAUDE_IGNORE_SIGTERM: ignoreTerm ? "1" : "0" };
    h.options.envPassthrough = [...(h.options.envPassthrough ?? []), "FAKE_CLAUDE_LINGER_MS", "FAKE_CLAUDE_IGNORE_SIGTERM"];
    const adapter = new ClaudeAgentSdkAdapter(h.options);
    await adapter.open();
    try {
      const binding = await adapter.create(h.spec);
      const first = randomUUID();
      const started = await adapter.startTurn(binding, `${marker(first)}\nFirst`, first);
      assert.equal((await settled(adapter, binding, started.id)).status, "completed");
      const [launch] = await h.launches();
      assert.ok(launch && running(launch.pid), "the process is still running after its result");
      assert.equal((await adapter.qualifyConversationThread(binding)).available, true,
        "a settled Turn whose process is only exiting is not a running Turn");
      const deadline = Date.now() + 5_000;
      while (running(launch.pid)) {
        assert.ok(Date.now() < deadline, `the lingering process was not stopped (ignoreTerm=${ignoreTerm})`);
        await new Promise(resolveWait => setTimeout(resolveWait, 25));
      }
      assert.equal((await adapter.listTurns(binding)).data[0]!.status, "completed", "stopping the exiting process keeps the settled outcome");
      const second = randomUUID();
      const next = await adapter.startConversationTurn(binding, `${marker(second)}\nSecond`, second);
      assert.equal((await settled(adapter, binding, next.id)).status, "completed");
    } finally { await adapter.close(); await h.cleanup(); }
  }
});

test("a result for a background-task notification queued before the prompt does not settle the Turn", async () => {
  // Seen with the real CLI 2.1.319 on a resumed Session: a zero-usage result with origin task-notification and no
  // echo came first, then the prompt ran. Covered with and without the prompt uuid echo of the current CLI.
  for (const echoed of [true, false]) {
    const h = await setup();
    h.options.environment = { ...h.options.environment, FAKE_CLAUDE_QUEUED_NOTIFICATION: "1", FAKE_CLAUDE_NO_ECHO: echoed ? "0" : "1" };
    h.options.envPassthrough = [...(h.options.envPassthrough ?? []), "FAKE_CLAUDE_QUEUED_NOTIFICATION", "FAKE_CLAUDE_NO_ECHO"];
    const adapter = new ClaudeAgentSdkAdapter(h.options);
    await adapter.open();
    try {
      const binding = await adapter.create(h.spec);
      const operationId = randomUUID();
      const started = await adapter.startTurn(binding, `${marker(operationId)}\nDo the task`, operationId);
      const turn = await settled(adapter, binding, started.id);
      assert.equal(turn.status, "completed");
      assert.deepEqual(turn.usage, { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 2, cacheCreationInputTokens: 0 },
        `the Turn settles from the prompt's own result (echoed=${echoed})`);
      const items = (await adapter.listItems(binding, started.id)).data as Array<Record<string, unknown>>;
      assert.equal(items.at(-1)!.phase, "final_answer");
      assert.match(String(items.at(-1)!.text), /^done: /);
    } finally { await adapter.close(); await h.cleanup(); }
  }
});

test("a process that dies after the prompt was written settles as process_lost", async () => {
  const h = await setup("crash");
  try {
    const binding = await h.adapter.create(h.spec);
    const operationId = randomUUID();
    const started = await h.adapter.startTurn(binding, `${marker(operationId)}\nTask`, operationId);
    const turn = await settled(h.adapter, binding, started.id);
    assert.equal(turn.status, "failed");
    assert.equal(turn.error?.category, "native_failure");
    assert.equal(turn.error?.providerCode, "process_lost");
    assert.equal(turn.costUsd, null);
  } finally { await h.cleanup(); }
});

test("after a first Turn lost before any answer, the next Turn resumes the transcript Claude already wrote", async () => {
  const h = await setup("crash");
  const recovered = new ClaudeAgentSdkAdapter({ ...h.options, environment: { ...h.options.environment, FAKE_CLAUDE_MODE: "ok" } });
  try {
    const binding = await h.adapter.create(h.spec);
    const lost = randomUUID();
    const first = await h.adapter.startTurn(binding, `${marker(lost)}\nTask`, lost);
    assert.equal((await settled(h.adapter, binding, first.id)).status, "failed");
    await h.adapter.close();
    await recovered.open();
    await recovered.registerBinding(binding);
    const next = randomUUID();
    const started = await recovered.startTurn(binding, `${marker(next)}\nContinue`, next);
    assert.equal((await settled(recovered, binding, started.id)).status, "completed", "the Session is not stuck on an ID already in use");
    const launches = await h.launches();
    assert.match(launches[0]!.argv.join(" "), new RegExp(`--session-id[= ]${binding.nativeSessionId}`));
    assert.match(launches.at(-1)!.argv.join(" "), new RegExp(`--resume[= ]${binding.nativeSessionId}`));
  } finally { await recovered.close(); await h.cleanup(); }
});

test("an ordinary Session message starts only after a fresh admission and consumes it", async () => {
  // The Turn hangs until interrupted, so the busy check below never races its result.
  const h = await setup("hang");
  try {
    const binding = await h.adapter.create(h.spec);
    const early = randomUUID();
    await assert.rejects(h.adapter.startConversationTurn(binding, `${marker(early)}\nHello`, early), RuntimeProtocolError,
      "no admission, no start");
    const admitted = await h.adapter.qualifyConversationThread(binding);
    assert.equal(admitted.available, true);
    assert.match(admitted.fingerprint ?? "", /^[0-9a-f]{64}$/);
    assert.deepEqual(await h.adapter.qualifyConversationThread(binding), admitted, "an unchanged Session keeps its fingerprint");
    const operationId = randomUUID();
    const started = await h.adapter.startConversationTurn(binding, `${marker(operationId)}\nHello`, operationId);
    assert.equal(started.status, "inProgress");
    const busy = await h.adapter.qualifyConversationThread(binding);
    assert.equal(busy.available, false, "a running Turn is not admitted");
    await h.adapter.interruptTurn(binding, started.id);
    assert.equal((await settled(h.adapter, binding, started.id)).status, "interrupted");
    const again = randomUUID();
    await assert.rejects(h.adapter.startConversationTurn(binding, `${marker(again)}\nAgain`, again), RuntimeProtocolError,
      "the admission was consumed by the start");
    const next = await h.adapter.qualifyConversationThread(binding);
    assert.equal(next.available, true);
    assert.notEqual(next.fingerprint, admitted.fingerprint, "the newest Turn is part of the admission");
    await assert.rejects(h.adapter.startConversationTurn(binding, `${marker(operationId)}\nReplay`, operationId), RuntimeProtocolError,
      "one operation gets one native start");
    const [first] = await h.launches();
    assert.match(first!.argv.join(" "), /bypassPermissions/);
  } finally { await h.cleanup(); }
});

test("an ordinary Session message needs a full profile and an unarchived Session", async () => {
  const h = await setup();
  try {
    const { actorId: _actorId, ...withoutActor } = h.spec;
    const noProfile = await h.adapter.create(withoutActor);
    assert.equal((await h.adapter.qualifyConversationThread(noProfile)).available, false);
    const archived = await h.adapter.create({ ...h.spec, sessionId: randomUUID() });
    await h.adapter.archiveThread(archived);
    assert.deepEqual(await h.adapter.qualifyConversationThread(archived),
      { available: false, reason: "Claude Session is archived", fingerprint: null });
  } finally { await h.cleanup(); }
});

test("a spawn failure before the prompt write is not sent, withdrawn and retryable", async () => {
  // A NUL byte makes the spawn call throw synchronously, before any byte reaches a child.
  const h = await setup("ok", { executable: "/nonexistent/claude\u0000.mjs" });
  try {
    const binding = await h.adapter.create(h.spec);
    const operationId = randomUUID();
    for (let attempt = 0; attempt < 2; attempt++)
      await assert.rejects(h.adapter.startTurn(binding, `${marker(operationId)}\nTask`, operationId), RuntimeNotSentError);
    assert.deepEqual((await h.adapter.listTurns(binding)).data, []);
    const view = await new TurnLedger(join(h.configDir, "evoloop-ledger")).read(binding.projectId, binding.nativeSessionId);
    assert.equal(view.turns.length, 2);
    assert.ok(view.turns.every(turn => turn.withdrawn && !turn.sent));
  } finally { await h.cleanup(); }
});

test("starts are not sent while the adapter is closed", async () => {
  const h = await setup();
  try {
    const binding = await h.adapter.create(h.spec);
    await h.adapter.close();
    const operationId = randomUUID();
    await assert.rejects(h.adapter.startTurn(binding, `${marker(operationId)}\nTask`, operationId), RuntimeNotSentError);
  } finally { await h.cleanup(); }
});

test("orphaned Turns from an earlier adapter are settled from process liveness, never as completed", async () => {
  const h = await setup();
  try {
    const binding = await h.adapter.create(h.spec);
    const ledger = new TurnLedger(join(h.configDir, "evoloop-ledger"));
    const dead = randomUUID(), running = randomUUID();
    await ledger.append(binding.projectId, binding.nativeSessionId, { kind: "turn.started", at: new Date().toISOString(), turnId: dead, operationId: randomUUID(), input: "x", resume: false });
    await ledger.append(binding.projectId, binding.nativeSessionId, { kind: "turn.process", at: new Date().toISOString(), turnId: dead, pid: await deadPid() });
    await ledger.append(binding.projectId, binding.nativeSessionId, { kind: "turn.sent", at: new Date().toISOString(), turnId: dead });

    const restarted = new ClaudeAgentSdkAdapter(h.options);
    await restarted.open();
    try {
      await restarted.registerBinding(binding);
      const first = (await restarted.listTurns(binding)).data[0]!;
      assert.equal(first.status, "failed");
      assert.equal(first.error?.providerCode, "process_lost");
      assert.deepEqual((await restarted.listTurns(binding)).data[0], first, "the orphan settlement is durable");

      await ledger.append(binding.projectId, binding.nativeSessionId, { kind: "turn.started", at: new Date().toISOString(), turnId: running, operationId: randomUUID(), input: "y", resume: false });
      await ledger.append(binding.projectId, binding.nativeSessionId, { kind: "turn.process", at: new Date().toISOString(), turnId: running, pid: process.pid });
      assert.equal((await restarted.listTurns(binding)).data[0]!.status, "unknown", "a live process outside this adapter is not proven running or done");
      const operationId = randomUUID();
      await assert.rejects(restarted.startTurn(binding, `${marker(operationId)}\nTask`, operationId),
        (error: Error) => error instanceof RuntimeNotSentError && /still running/.test(error.message));
    } finally { await restarted.close(); }
  } finally { await h.cleanup(); }
});

test("archive is recorded by the adapter and refuses further Turns", async () => {
  const h = await setup();
  try {
    const binding = await h.adapter.create(h.spec);
    assert.equal(await h.adapter.isThreadArchived(binding), false);
    await h.adapter.archiveThread(binding);
    assert.equal(await h.adapter.isThreadArchived(binding), true);
    const operationId = randomUUID();
    await assert.rejects(h.adapter.startTurn(binding, `${marker(operationId)}\nTask`, operationId), /archived/);
    assert.equal((await h.launches()).length, 0);
  } finally { await h.cleanup(); }
});

test("bindings and execution profiles are checked before any process starts", async () => {
  const h = await setup();
  try {
    await assert.rejects(h.adapter.create({ ...h.spec, sandbox: "workspace-write" }), /danger-full-access/);
    await assert.rejects(h.adapter.create({ ...h.spec, reasoningEffort: "high" }), /reasoning effort/);
    const binding = await h.adapter.create({ ...h.spec, executionProfileRevisionId: randomUUID() });
    const operationId = randomUUID();
    await assert.rejects(h.adapter.startTurn(binding, `${marker(operationId)}\nTask`, operationId, null), /exact immutable execution profile/);
    const unverified = new ClaudeAgentSdkAdapter({ ...h.options, verifyBinding: undefined });
    await unverified.open();
    await assert.rejects(unverified.registerBinding(binding), /provenance not verified/);
    await assert.rejects(h.adapter.registerBinding({ ...binding, owner: "evoloop-codex-app-server" }), /invalid runtime binding/);
    await assert.rejects(h.adapter.listTurns({ ...binding, cwd: "/elsewhere" }), /not registered/);
    assert.throws(() => new ClaudeAgentSdkAdapter({ ...h.options, envPassthrough: ["CLAUDE_CONFIG_DIR"] }), /cannot be passed/);
    assert.throws(() => new ClaudeAgentSdkAdapter({ ...h.options, envPassthrough: ["ENABLE_CLAUDEAI_MCP_SERVERS"] }), /cannot be passed/,
      "the connector switch cannot be turned back on through passthrough");
    assert.equal((await h.launches()).length, 0);
    await unverified.close();
  } finally { await h.cleanup(); }
});

test("an effort-only revision applies from the next Turn: the adapter says so and re-registers the verified binding", async () => {
  const h = await setup();
  try {
    const revision1 = randomUUID(), revision2 = randomUUID();
    const base = await h.adapter.create({ ...h.spec, executionProfileRevisionId: revision1 });
    assert.equal(h.adapter.appliesEffortWithNextTurn(base), true, "effort travels with each query, there is nothing to activate");
    assert.deepEqual([...h.adapter.allowedReasoningEfforts(base)].sort(), ["high", "low", "max", "medium", "xhigh"], "Claude's own set: no none, no minimal");
    const withEffort = (effort: string, revisionId: string): RuntimeBinding => ({ ...base, resumeProfile: { ...base.resumeProfile!, reasoningEffort: effort, executionProfileRevisionId: revisionId } });
    const first = withEffort("high", revision1), second = withEffort("low", revision2);
    await h.adapter.registerBinding(first);
    await h.adapter.registerBinding(second);             // the revision became active in the store: no "conflicting runtime binding"
    const profile = { revisionId: revision2, version: 2, model: second.resumeProfile!.model ?? null, reasoningEffort: "low", sandbox: "danger-full-access", approvalPolicy: "never",
      cwd: second.cwd, authorizationScope: second.authorizationScope, provenance: "revised" } as Parameters<typeof h.adapter.startTurn>[3];
    const operationId = randomUUID();
    const started = await h.adapter.startTurn(second, `${marker(operationId)}\nTask`, operationId, profile);
    assert.ok(started.id);
    await assert.rejects(h.adapter.registerBinding({ ...second, resumeProfile: { ...second.resumeProfile!, model: "another-model" } }), /conflicting runtime binding/);
  } finally { await h.cleanup(); }
});

test("model list comes from the CLI initialize response without sending a prompt", async () => {
  const h = await setup();
  try {
    const listed = await h.adapter.listModels();
    assert.equal(listed.status, "available");
    assert.deepEqual(listed.models, ["claude-fake-1"]);
    assert.deepEqual(listed.options[0]!.supportedReasoningEfforts, ["low", "high"]);
    const [launch] = await h.launches();
    assert.doesNotMatch(launch!.argv.join(" "), /--session-id|--resume/);
    assert.match(launch!.argv.join(" "), /crossSessionInbound/);
  } finally { await h.cleanup(); }
});

test("close settles a running Turn as failed by adapter close", async () => {
  const h = await setup("hang");
  try {
    const binding = await h.adapter.create(h.spec);
    const operationId = randomUUID();
    const started = await h.adapter.startTurn(binding, `${marker(operationId)}\nTask`, operationId);
    await h.adapter.close();
    const view = await new TurnLedger(join(h.configDir, "evoloop-ledger")).read(binding.projectId, binding.nativeSessionId);
    const turn = view.turns.find(candidate => candidate.turnId === started.id);
    assert.equal(turn?.settled?.status, "failed");
    assert.equal(turn?.settled?.error?.providerCode, "adapter_closed");
  } finally { await h.cleanup(); }
});

test("capabilities declare per-turn process, caller session IDs and ledger archive", () => {
  const adapter = new ClaudeAgentSdkAdapter({ configDir: "/tmp/evoloop-claude-capabilities" });
  const declared = adapter.capabilities();
  assert.equal(declared.provider, "claude");
  assert.equal(declared.process, "per_turn");
  assert.equal(declared.delivery.callerAssignedSessionId, true);
  assert.equal(declared.errors.notSent, true);
  assert.equal(declared.compaction.mode, "unavailable");
  assert.equal(declared.archive, "adapter_ledger");
  assert.equal(declared.usage, "per_turn");
  assert.equal(declared.cost, true);
  assert.throws(() => new ClaudeAgentSdkAdapter({ configDir: "relative" }), /absolute/);
  for (const exitGraceMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY])
    assert.throws(() => new ClaudeAgentSdkAdapter({ configDir: "/tmp/evoloop-claude-capabilities", exitGraceMs }), /exit grace/);
});

const sha = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
const flagValues = (argv: string[], name: string) => argv.flatMap((arg, index) => arg === `--${name}` ? [argv[index + 1] ?? ""] :
  arg.startsWith(`--${name}=`) ? [arg.slice(name.length + 3)] : []);
const initRequests = async (log: string) => (await readFile(`${log}.init`, "utf8").catch(() => "")).split("\n").filter(Boolean)
  .map(line => JSON.parse(line) as { skills: string[] | null; appendSystemPrompt: string | null; systemPromptSnapshot: boolean | null });

async function writePlan(root: string, options: { off?: string[]; builtin?: boolean } = {}): Promise<RuntimeSkillPlan> {
  const source = join(root, "skill-source", "demo");
  await mkdir(source, { recursive: true });
  await writeFile(join(source, "SKILL.md"), "---\nname: demo\ndescription: demo skill\n---\n\nDemo.\n");
  const target = await realpath(source);
  const content = { plugins: [{ name: "evoloop" as const, skills: [{ name: "demo", target }] }], off: options.off ?? [],
    builtin: options.builtin ?? true };
  const planHash = skillPlanHash(content);
  const pluginRoot = join(root, "plans", planHash, "evoloop");
  await mkdir(join(pluginRoot, ".claude-plugin"), { recursive: true });
  await mkdir(join(pluginRoot, "skills"));
  await writeFile(join(pluginRoot, ".claude-plugin", "plugin.json"), skillPluginManifest("evoloop", planHash));
  await symlink(target, join(pluginRoot, "skills", "demo"));
  return { ...content, planHash, plugins: [{ ...content.plugins[0]!, root: pluginRoot }] };
}
const settingsOf = (argv: string[]) => Object.assign({}, ...flagValues(argv, "settings").map(value => JSON.parse(value) as object)) as
  { skillOverrides?: Record<string, string>; disableBundledSkills?: boolean; disableClaudeAiConnectors?: boolean };

test("a Role skill plan is loaded as plugins, turns off what it does not select, and its init report is recorded", async () => {
  let plan!: RuntimeSkillPlan;
  const h = await setup("ok", { skillPlan: async () => plan });
  try {
    for (const name of ["kept", "local-only"]) {
      await mkdir(join(h.cwd, ".claude", "skills", name), { recursive: true });
      await writeFile(join(h.cwd, ".claude", "skills", name, "SKILL.md"), `---\nname: ${name}\n---\n`);
    }
    plan = await writePlan(h.root, { off: ["code-review", "local-only"] });
    const binding = await h.adapter.create(h.spec);
    const operationId = randomUUID();
    const started = await h.adapter.startTurn(binding, `${marker(operationId)}\nTask`, operationId);
    const turn = await settled(h.adapter, binding, started.id);
    assert.equal(turn.status, "completed");
    const [launch] = await h.launches();
    assert.deepEqual(flagValues(launch!.argv, "plugin-dir-no-mcp"), [plan.plugins[0]!.root], "plan plugins load without MCP discovery");
    assert.deepEqual(flagValues(launch!.argv, "plugin-dir"), []);
    assert.deepEqual(flagValues(launch!.argv, "setting-sources"), ["project"], "project mode is the default");
    const settings = settingsOf(launch!.argv);
    assert.deepEqual(settings.skillOverrides, { "code-review": "off", "local-only": "off" });
    assert.equal(settings.disableBundledSkills, false);
    assert.equal(settings.disableClaudeAiConnectors, true, "the plan keeps the fixed child settings");
    const [init] = await initRequests(join(h.root, "fake.log"));
    assert.equal(init!.skills, null, "no allowlist: the plan decides by plugins and overrides");
    assert.equal(init!.appendSystemPrompt, null);
    assert.deepEqual(turn.observedCapabilities, {
      source: "claude.init", observedAtUtc: turn.observedCapabilities!.observedAtUtc, planHash: plan.planHash,
      discoveredSkills: ["update-config", "simplify", "doctor", "kept", "evoloop:demo"],
      allowedSkills: ["evoloop:demo"], missingSkills: [],
      plugins: ["evoloop"], pluginErrors: [], mcpServers: [], contextMode: "project", instructions: null,
    });
    assert.ok(!JSON.stringify(turn).includes(h.root), "no local path is recorded");
  } finally { await h.cleanup(); }
});

test("a Role without built-ins turns off bundled skills and the built-in plugin's skills", async () => {
  let plan!: RuntimeSkillPlan;
  const h = await setup("ok", { skillPlan: async () => plan });
  try {
    plan = await writePlan(h.root, { builtin: false });
    const binding = await h.adapter.create(h.spec);
    const operationId = randomUUID();
    const started = await h.adapter.startTurn(binding, `${marker(operationId)}\nTask`, operationId);
    const turn = await settled(h.adapter, binding, started.id);
    const settings = settingsOf((await h.launches())[0]!.argv);
    assert.equal(settings.disableBundledSkills, true);
    assert.deepEqual(settings.skillOverrides, Object.fromEntries(CLAUDE_BUILTIN_PLUGIN_SKILLS.map(name => [name, "off"])));
    assert.deepEqual(turn.observedCapabilities?.discoveredSkills, ["evoloop:demo"]);
  } finally { await h.cleanup(); }
});

test("explicit mode reads no project settings and passes the cwd's AGENTS.md, else CLAUDE.md, itself", async () => {
  const h = await setup("ok", { contextMode: "explicit" });
  try {
    const agents = "# Agents\nAGENTS-MARKER\n", claude = "# Claude\nCLAUDE-MARKER\n";
    await writeFile(join(h.cwd, "AGENTS.md"), agents);
    await writeFile(join(h.cwd, "CLAUDE.md"), claude);
    const binding = await h.adapter.create(h.spec);
    const run = async () => {
      const operationId = randomUUID();
      const started = await h.adapter.startTurn(binding, `${marker(operationId)}\nTask`, operationId);
      return settled(h.adapter, binding, started.id);
    };
    const first = await run();
    await rm(join(h.cwd, "AGENTS.md"));
    const second = await run();
    const long = `${"a".repeat(70 * 1024)}\nTAIL-MARKER\n`;
    await writeFile(join(h.cwd, "AGENTS.md"), long);
    const third = await run();
    for (const launch of await h.launches()) assert.deepEqual(flagValues(launch.argv, "setting-sources"), [""], "no setting source is read");
    const inits = await initRequests(join(h.root, "fake.log"));
    assert.equal(inits.length, 3);
    assert.match(inits[0]!.appendSystemPrompt ?? "", /AGENTS-MARKER/);
    assert.doesNotMatch(inits[0]!.appendSystemPrompt ?? "", /CLAUDE-MARKER/, "AGENTS.md wins when both exist");
    assert.match(inits[1]!.appendSystemPrompt ?? "", /CLAUDE-MARKER/);
    assert.doesNotMatch(inits[2]!.appendSystemPrompt ?? "", /TAIL-MARKER/, "an oversized file is cut");
    for (const init of inits) { assert.equal(init.systemPromptSnapshot, false); assert.equal(init.skills, null); }
    assert.deepEqual(first.observedCapabilities?.instructions, { file: "AGENTS.md", contentHash: sha(agents), truncated: false });
    assert.deepEqual(second.observedCapabilities?.instructions, { file: "CLAUDE.md", contentHash: sha(claude), truncated: false });
    assert.deepEqual(third.observedCapabilities?.instructions, { file: "AGENTS.md", contentHash: sha(long), truncated: true });
    assert.equal(first.observedCapabilities?.contextMode, "explicit");
    assert.equal(first.observedCapabilities?.allowedSkills, null);
    assert.equal(first.observedCapabilities?.planHash, null);
  } finally { await h.cleanup(); }
});

test("a plan that cannot be prepared or whose plugins no longer match it stops the Turn before it is sent", async () => {
  let provide: () => Promise<RuntimeSkillPlan | null> = async () => null;
  const h = await setup("ok", { skillPlan: () => provide() });
  try {
    const plan = await writePlan(h.root);
    const root = plan.plugins[0]!.root;
    const binding = await h.adapter.create(h.spec);
    const attempt = async (reason: RegExp) => {
      const operationId = randomUUID();
      await assert.rejects(h.adapter.startTurn(binding, `${marker(operationId)}\nTask`, operationId),
        (error: Error) => error instanceof RuntimeNotSentError && reason.test(error.message));
    };
    provide = async () => { throw new Error("skills unreadable"); };
    await attempt(/could not be prepared/);
    provide = async () => ({ ...plan, plugins: [{ ...plan.plugins[0]!, root: "relative/plan" }] });
    await attempt(/do not match/);
    provide = async () => ({ ...plan, off: ["simplify"] });
    await attempt(/do not match/);
    provide = async () => plan;
    await symlink(dirname(plan.plugins[0]!.skills[0]!.target), join(root, "skills", "extra"));
    await attempt(/do not match/);
    await rm(join(root, "skills", "extra"));
    await rm(join(root, "skills", "demo"));
    await symlink(dirname(plan.plugins[0]!.skills[0]!.target), join(root, "skills", "demo"));
    await attempt(/do not match/);
    await rm(join(root, "skills", "demo"));
    await symlink(plan.plugins[0]!.skills[0]!.target, join(root, "skills", "demo"));
    await writeFile(join(root, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "evoloop", mcpServers: {} }));
    await attempt(/do not match/);
    assert.deepEqual(await h.launches(), [], "no Claude process was started");
    assert.deepEqual((await h.adapter.listTurns(binding)).data, [], "nothing reached history");
  } finally { await h.cleanup(); }
});
