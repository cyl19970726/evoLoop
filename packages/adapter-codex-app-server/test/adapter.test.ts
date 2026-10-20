import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { CodexAppServerAdapter, RuntimeProtocolError, RuntimeServerError, RuntimeUnknownError } from "../src/index.js";
import type { RuntimeBinding, RuntimeSessionSpec } from "@evoloop/contracts/runtime";

const fixture = resolve(import.meta.dirname, "fixture.mjs");
const spec: RuntimeSessionSpec = { sessionId: "session-1", roleId: "role-1", projectId: "project-1", cwd: "/tmp/evoloop-fixture", authorizationScope: "task:fixture", sandbox: "read-only", approvalPolicy: "on-request" };
const open = async (mode = "normal", timeout = 500): Promise<CodexAppServerAdapter> => {
  const adapter = new CodexAppServerAdapter({ executable: process.execPath, spawnArgs: [fixture, mode], requestTimeoutMs: timeout });
  await adapter.open(); return adapter;
};

test("correlates RPCs, filters foreign events, and reads owned history", async t => {
  const adapter = await open(); t.after(() => adapter.close());
  const binding = await adapter.create(spec);
  assert.equal(binding.nativeThreadId, "thread-owned");
  const events: string[] = [];
  const completed = new Promise<void>(resolveCompleted => adapter.onEvent(event => {
    events.push(event.method);
    if (event.method === "turn/completed") resolveCompleted();
  }));
  assert.deepEqual(await adapter.resume(binding), binding);
  assert.equal((await adapter.inspect(binding) as { thread: { id: string } }).thread.id, binding.nativeThreadId);
  const [turns, items] = await Promise.all([adapter.listTurns(binding), adapter.listItems(binding, "turn-1")]);
  assert.equal(turns.data[0]?.id, "turn-1"); assert.equal(items.data.length, 1);
  assert.equal((await adapter.startTurn(binding, "read only", "op-1")).id, "turn-1");
  await adapter.interruptTurn(binding, "turn-1");
  await completed;
  assert.deepEqual(events, ["turn/started", "turn/completed"]);
  await assert.rejects(() => adapter.inspect({ ...binding, authorizationScope: "other" }), RuntimeProtocolError);
});

test("approval is visible and denied by default", async t => {
  const adapter = await open("approval"); t.after(() => adapter.close());
  const binding = await adapter.create(spec);
  const approval = new Promise<string>(resolveDecision => adapter.onApprovalRequest(request => resolveDecision(request.method)));
  const decision = new Promise<unknown>(resolveDecision => adapter.onEvent(event => { if (event.method === "fixture/approvalDecision") resolveDecision((event.params as { decision: unknown }).decision); }));
  await adapter.startTurn(binding, "read", "op-2");
  assert.equal(await approval, "item/commandExecution/requestApproval");
  assert.equal(await decision, "decline");
});

test("approval denial waits for durable observer and disconnect closes admission", async t => {
  const adapter = await open("approval"); t.after(() => adapter.close());
  const binding = await adapter.create(spec);
  let recorded = false;
  adapter.onApprovalRequest(async request => {
    assert.equal(request.projectId, spec.projectId);
    assert.equal(request.sessionId, spec.sessionId);
    assert.equal(request.threadId, binding.nativeThreadId);
    await new Promise(resolve => setTimeout(resolve, 20));
    recorded = true;
  });
  const decision = new Promise<unknown>(resolveDecision => adapter.onEvent(event => {
    if (event.method === "fixture/approvalDecision") resolveDecision((event.params as { decision: unknown }).decision);
  }));
  await adapter.startTurn(binding, "read", "op-approval-durable");
  assert.equal(await decision, "decline");
  assert.equal(recorded, true);
  assert.equal(adapter.isReady(), true);
  const disconnected = new Promise<string>(resolveDisconnected => adapter.onDisconnect(resolveDisconnected));
  await adapter.close();
  assert.match(await disconnected, /closed/);
  assert.equal(adapter.isReady(), false);
});

test("approval during thread creation is recorded before denial without granting ownership", async t => {
  let decisions = 0;
  const adapter = new CodexAppServerAdapter({ executable: process.execPath, spawnArgs: [fixture, "prebind-approval"],
    requestTimeoutMs: 500, decideApproval: async () => { decisions++; return "accept"; } });
  t.after(() => adapter.close()); await adapter.open();
  let persisted = false;
  adapter.onApprovalRequest(async request => {
    assert.equal(request.projectId, spec.projectId);
    assert.equal(request.sessionId, spec.sessionId);
    assert.equal(request.threadId, "thread-owned");
    assert.equal(request.turnId, undefined);
    await assert.rejects(() => adapter.resume({ sessionId: spec.sessionId, roleId: spec.roleId,
      projectId: spec.projectId, authorizationScope: spec.authorizationScope, cwd: spec.cwd,
      nativeThreadId: "thread-owned", nativeSessionId: "thread-owned", owner: "evoloop-codex-app-server" }), RuntimeProtocolError);
    await new Promise(resolve => setTimeout(resolve, 20));
    persisted = true;
  });
  const first = adapter.create(spec);
  await assert.rejects(() => adapter.create({ ...spec, sessionId: "session-2" }), /another thread creation is pending/);
  const binding = await first; // Fixture sends thread/start reply only after it receives decline.
  assert.equal(persisted, true);
  assert.equal(decisions, 0);
  assert.equal(binding.nativeThreadId, "thread-owned");
});

test("unbound unsupported server request is denied without assigning a project hint", async t => {
  const adapter = await open("prebind-unsupported"); t.after(() => adapter.close());
  let observed = false;
  adapter.onApprovalRequest(() => { observed = true; });
  assert.equal((await adapter.create(spec)).nativeThreadId, "thread-owned");
  assert.equal(observed, false);
});

test("failed prebinding approval persistence disconnects and leaves create outcome unknown", async t => {
  const adapter = await open("prebind-approval"); t.after(() => adapter.close());
  adapter.onApprovalRequest(() => { throw new Error("storage unavailable"); });
  await assert.rejects(() => adapter.create(spec), RuntimeUnknownError);
  assert.equal(adapter.isReady(), false);
  await assert.rejects(() => adapter.create(spec), RuntimeProtocolError);
});

test("prebinding approval without a durable observer cannot receive a denial acknowledgement", async t => {
  const adapter = await open("prebind-approval"); t.after(() => adapter.close());
  await assert.rejects(() => adapter.create(spec), RuntimeUnknownError);
  assert.equal(adapter.isReady(), false);
});

for (const mode of ["timeout", "disconnect", "malformed"]) {
  test(`${mode} leaves turn/start outcome unknown`, async t => {
    const adapter = await open(mode, 100); t.after(() => adapter.close());
    const binding = await adapter.create(spec);
    await assert.rejects(() => adapter.startTurn(binding, "task", "op-3"), RuntimeUnknownError);
  });
}

test("an explicit turn/start rejection preserves code without leaking native error text", async t => {
  const adapter = await open("reject-start"); t.after(() => adapter.close());
  const binding = await adapter.create(spec);
  await assert.rejects(() => adapter.startTurn(binding, "task", "op-rejected"), error => {
    assert.ok(error instanceof RuntimeServerError);
    assert.equal(error.method, "turn/start");
    assert.equal(error.code, -32602);
    assert.equal(error.category, "invalid_params");
    assert.doesNotMatch(error.message, /private fixture detail/);
    return true;
  });
});

test("failed turn exposes classified provider metadata without raw error text", async t => {
  const adapter = await open("failed-turn"); t.after(() => adapter.close());
  const binding = await adapter.create(spec);
  const page = await adapter.listTurns(binding);
  assert.deepEqual(page.data[0]?.error, {
    category: "unsupported_model", providerCode: "invalid_request_error", httpStatus: 400,
    summary: "Configured model is not supported with this Codex ChatGPT account",
  });
  assert.doesNotMatch(JSON.stringify(page), /Private fixture detail|gpt-6\.1-sol/);
});

test("a timed-out start can be reconciled by read without replay", async t => {
  const adapter = await open("timeout", 100); t.after(() => adapter.close());
  const binding = await adapter.create(spec);
  await assert.rejects(() => adapter.startTurn(binding, "task", "op-4"), RuntimeUnknownError);
  const turns = await adapter.listTurns(binding);
  assert.equal(turns.data[0]?.id, "turn-1");
});

test("normalizes settled Unix seconds and leaves a transient interrupted projection unsettled", async t => {
  const adapter = await open("transient-interrupted"); t.after(() => adapter.close());
  const binding = await adapter.create(spec);
  const first = await adapter.listTurns(binding);
  assert.equal(first.data[0]?.status, "interrupted");
  assert.equal(first.data[0]?.completedAtUtc, null);
  const second = await adapter.listTurns(binding);
  assert.equal(second.data[0]?.status, "completed");
  assert.equal(second.data[0]?.completedAtUtc, "2026-10-20T12:14:44.000Z");
});

test("rejects malformed native completion time instead of inventing terminal proof", async t => {
  const adapter = await open("invalid-completed-at"); t.after(() => adapter.close());
  const binding = await adapter.create(spec);
  await assert.rejects(() => adapter.listTurns(binding), RuntimeProtocolError);
});

test("rejects unregistered Desktop binding and invalid scope", async t => {
  const adapter = await open(); t.after(() => adapter.close());
  const desktop: RuntimeBinding = { sessionId: "desktop", roleId: "role", projectId: "project", nativeThreadId: "desktop-thread", nativeSessionId: "desktop-thread", cwd: "/tmp/evoloop-fixture", authorizationScope: "task:fixture", owner: "evoloop-codex-app-server" };
  await assert.rejects(() => adapter.resume(desktop), RuntimeProtocolError);
  await assert.rejects(() => adapter.create({ ...spec, cwd: "relative" }), RuntimeProtocolError);
  await assert.rejects(() => adapter.registerBinding(desktop), RuntimeProtocolError);
});

test("restores only a binding accepted by the trusted store", async t => {
  const adapter = new CodexAppServerAdapter({ executable: process.execPath, spawnArgs: [fixture, "normal"], verifyBinding: async binding => binding.nativeThreadId === "thread-owned" && binding.authorizationScope === "task:fixture" });
  t.after(() => adapter.close()); await adapter.open();
  const binding: RuntimeBinding = { sessionId: "session-1", roleId: "role-1", projectId: "project-1", nativeThreadId: "thread-owned", nativeSessionId: "thread-owned", cwd: spec.cwd, authorizationScope: "task:fixture", owner: "evoloop-codex-app-server" };
  await adapter.registerBinding(binding);
  assert.deepEqual(await adapter.resume(binding), binding);
  await assert.rejects(() => adapter.registerBinding({ ...binding, nativeThreadId: "desktop-thread" }), RuntimeProtocolError);
});

test("read and resume reject a changed native session tree", async t => {
  const adapter = await open("changed-session"); t.after(() => adapter.close());
  const binding = await adapter.create(spec);
  await assert.rejects(() => adapter.inspect(binding), /read thread does not match binding/);
  await assert.rejects(() => adapter.resume(binding), /resumed thread does not match registered binding/);
});

test("owned read remains available when native resume is rejected", async t => {
  const adapter = await open("resume-rejected"); t.after(() => adapter.close());
  const binding = await adapter.create(spec);
  await assert.rejects(() => adapter.resume(binding), RuntimeServerError);
  assert.equal((await adapter.inspect(binding) as { thread: { id: string } }).thread.id, binding.nativeThreadId);
  assert.equal((await adapter.listTurns(binding)).data.length, 1);
  assert.equal((await adapter.listItems(binding, "turn-1")).data.length, 1);
});

 test("owned binding comparison survives persistence key order", async t => {
  const adapter = await open(); t.after(() => adapter.close());
  const binding = await adapter.create(spec);
  const restored: RuntimeBinding = { owner: binding.owner, nativeSessionId: binding.nativeSessionId,
    nativeThreadId: binding.nativeThreadId, authorizationScope: binding.authorizationScope, cwd: binding.cwd,
    projectId: binding.projectId, roleId: binding.roleId, sessionId: binding.sessionId };
  assert.equal((await adapter.startTurn(restored, "read only", "reordered-op")).id, "turn-1");
  await assert.rejects(() => adapter.startTurn({...restored, roleId:"other"}, "read", "other-op"), RuntimeProtocolError);
});

test("normalizes native ThreadItemEntry and rejects a foreign turn envelope", async t => {
  const adapter = await open();t.after(()=>adapter.close());const binding=await adapter.create(spec);
  const result=await adapter.listItems(binding,"turn-1");
  assert.deepEqual(result.data,[{id:"item-1",type:"agentMessage",text:"fixture final answer"}]);
  const other=await open("wrong-turn-items");t.after(()=>other.close());const owned=await other.create(spec);
  await assert.rejects(()=>other.listItems(owned,"turn-1"),RuntimeProtocolError);
});
