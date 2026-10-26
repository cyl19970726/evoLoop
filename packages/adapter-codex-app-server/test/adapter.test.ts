import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { CodexAppServerAdapter, RuntimeProtocolError, RuntimeServerError, RuntimeUnknownError } from "../src/index.js";
import { mapWorkItem } from "../src/work-trace.js";
import type { RuntimeBinding, RuntimeSessionSpec } from "@evoloop/contracts/runtime";

const fixture = resolve(import.meta.dirname, "fixture.mjs");
const spec: RuntimeSessionSpec = { actorId:"original-actor", sessionId: "session-1", roleId: "role-1", projectId: "project-1", cwd: "/tmp/evoloop-fixture", authorizationScope: "task:fixture", sandbox: "read-only", approvalPolicy: "on-request" };
const restoreSpec: RuntimeSessionSpec = { ...spec, actorId: "original-actor" };
const open = async (mode = "normal", timeout = 500): Promise<CodexAppServerAdapter> => {
  const adapter = new CodexAppServerAdapter({ executable: process.execPath, spawnArgs: [fixture, mode], requestTimeoutMs: timeout });
  await adapter.open(); return adapter;
};

test("only the two reviewed CLI protocol versions can be selected", () => {
  assert.throws(() => new CodexAppServerAdapter({ expectedVersion: "codex-cli 0.165.0" }), /unsupported Codex CLI protocol version/);
  assert.throws(() => new CodexAppServerAdapter({ expectedVersion: "0.164.0-alpha.11.1" }), /unsupported Codex CLI protocol version/);
});

test("version mismatch and changed standard or experimental schema stop before App Server startup", async t => {
  const directory=await mkdtemp(join(tmpdir(),"evoloop-protocol-fingerprint-"));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const executable=join(directory,"fake-codex");
  await writeFile(executable,`#!/bin/sh
if [ "$1" = "--version" ]; then printf '%s\\n' 'codex-cli 0.164.0-alpha.11.1'; exit 0; fi
if [ "$1" = "app-server" ] && [ "$2" = "generate-json-schema" ]; then
  while [ "$#" -gt 0 ]; do if [ "$1" = "--out" ]; then shift; mkdir -p "$1"; printf '{}' > "$1/codex_app_server_protocol.v2.schemas.json"; exit 0; fi; shift; done
fi
printf 'app-server-started' > '${join(directory,"started")}'
exit 1
`,{mode:0o700});
  const wrongVersion=new CodexAppServerAdapter({executable,expectedVersion:"codex-cli 0.154.0"});
  await assert.rejects(()=>wrongVersion.open(),/CLI version mismatch/);
  for(const experimental of [false,true]){
    const adapter=new CodexAppServerAdapter({executable,expectedVersion:"codex-cli 0.164.0-alpha.11.1",
      enableRestrictedMessagePermissions:experimental});
    await assert.rejects(()=>adapter.open(),/schema changed/);
  }
  await assert.rejects(()=>import("node:fs/promises").then(fs=>fs.stat(join(directory,"started"))),{code:"ENOENT"});
});

for (const expectedVersion of ["codex-cli 0.154.0", "codex-cli 0.164.0-alpha.11.1"]) {
  test(`${expectedVersion} answers current time only for an owned Thread when its schema supports it`, async t => {
    const adapter = new CodexAppServerAdapter({ executable: process.execPath, spawnArgs: [fixture, "protocol-0164"],
      expectedVersion, requestTimeoutMs: 500 });
    t.after(() => adapter.close()); await adapter.open();
    const binding = await adapter.create(spec);
    const replies = new Map<number, Record<string, unknown>>();
    const settled = new Promise<void>(resolveReplies => adapter.onEvent(event => {
      if (event.method !== "fixture/timeDecision") return;
      const value = event.params as Record<string, unknown>;
      replies.set(value.requestId as number, value);
      if (replies.size === 4) resolveReplies();
    }));
    await adapter.startTurn(binding, "business", "business-op");
    await settled;
    const own = replies.get(850)!;
    if (expectedVersion === "codex-cli 0.164.0-alpha.11.1") {
      assert.equal(Number.isSafeInteger((own.result as Record<string, unknown>).currentTimeAt), true);
      assert.ok(Math.abs((own.result as {currentTimeAt:number}).currentTimeAt - Math.floor(Date.now()/1000)) < 5);
    } else assert.equal((own.error as {code:number}).code, -32601);
    assert.equal((replies.get(851)!.error as {code:number}).code, expectedVersion.endsWith("0.154.0") ? -32601 : -32000);
    assert.equal((replies.get(852)!.error as {code:number}).code, expectedVersion.endsWith("0.154.0") ? -32601 : -32000);
    assert.equal((replies.get(853)!.error as {code:number}).code, -32601);
  });

  test(`${expectedVersion} retains owned business RPCs, unknown start, and ordinary policy restoration`, async t => {
    const business = new CodexAppServerAdapter({ executable: process.execPath, spawnArgs:[fixture,"normal"],
      expectedVersion, requestTimeoutMs:500 });
    t.after(()=>business.close()); await business.open();
    const owned=await business.create(spec);
    assert.equal((await business.inspect(owned) as {thread:{id:string}}).thread.id,owned.nativeThreadId);
    assert.equal((await business.resume(owned,restoreSpec)).nativeThreadId,owned.nativeThreadId);
    assert.equal((await business.startTurn(owned,"fixed business input","business-op")).id,"turn-1");
    assert.equal((await business.listTurns(owned)).data[0]?.id,"turn-1");
    assert.equal((await business.listItems(owned,"turn-1")).data.length,1);
    await business.interruptTurn(owned,"turn-1");
    await business.archiveThread(owned);
    assert.equal(await business.isThreadArchived(owned),true);

    const ordinary = new CodexAppServerAdapter({ executable:process.execPath,spawnArgs:[fixture,"message-profile"],
      expectedVersion,requestTimeoutMs:500,enableRestrictedMessagePermissions:true,
      verifyBinding:async()=>true,
      threadConfig:async()=>({"sandbox_workspace_write.network_access":true}) });
    t.after(()=>ordinary.close()); await ordinary.open();
    const messageBinding:RuntimeBinding={sessionId:spec.sessionId,roleId:spec.roleId,projectId:spec.projectId,
      nativeThreadId:"thread-owned",nativeSessionId:"thread-owned",cwd:spec.cwd,
      authorizationScope:spec.authorizationScope,owner:"evoloop-codex-app-server",
      resumeProfile:{actorId:"original-actor",model:null,sandbox:"workspace-write",approvalPolicy:"on-request"}};
    await ordinary.registerBinding(messageBinding);
    assert.equal((await ordinary.qualifyReadOnlyThread(messageBinding)).available,true);
    assert.equal((await ordinary.startReadOnlyTurn(messageBinding,"ordinary question","message-op")).id,"turn-1");
    await assert.rejects(()=>ordinary.startTurn(messageBinding,"business","business-op"),RuntimeProtocolError);
    await ordinary.resume(messageBinding,{...restoreSpec,model:null,sandbox:"workspace-write"});
    assert.equal((await ordinary.startTurn(messageBinding,"fixed business input","business-op")).id,"turn-1");
    assert.equal((await ordinary.listTurns(messageBinding)).data[0]?.id,"turn-1");
  });

  test(`${expectedVersion} keeps an unacknowledged native Turn start unknown`, async t => {
    const adapter=new CodexAppServerAdapter({executable:process.execPath,spawnArgs:[fixture,"timeout"],
      expectedVersion,requestTimeoutMs:100});
    t.after(()=>adapter.close());await adapter.open();
    const owned=await adapter.create(spec);
    await assert.rejects(()=>adapter.startTurn(owned,"business","durable-op"),RuntimeUnknownError);
    assert.equal((await adapter.listTurns(owned)).data[0]?.id,"turn-1");
  });
}

test("owned archive requires exact native readback; empty and lost acknowledgements are not proof", async t => {
  const normal = await open(); t.after(() => normal.close());
  const binding = await normal.create(spec);
  assert.equal(await normal.isThreadArchived(binding), false);
  await normal.archiveThread(binding);
  assert.equal(await normal.isThreadArchived(binding), true);
  await assert.rejects(() => normal.archiveThread({ ...binding, nativeThreadId: "desktop" }), RuntimeProtocolError);

  // The same RPC deadline covers child initialization; retain the normal startup budget.
  const lost = await open("lost-archive-ack"); t.after(() => lost.close());
  const same = await lost.create(spec);
  await assert.rejects(() => lost.archiveThread(same), RuntimeUnknownError);
  assert.equal(await lost.isThreadArchived(same), true);

  const foreign = await open("foreign-archive"); t.after(() => foreign.close());
  const other = await foreign.create(spec);
  await foreign.archiveThread(other);
  await assert.rejects(() => foreign.isThreadArchived(other), RuntimeProtocolError);

  for (const [mode, expected] of [["vscode-archive", true], ["foreign-samecwd", true], ["foreign-only", false]] as const) {
    const candidate = await open(mode); t.after(() => candidate.close());
    const owned = await candidate.create(spec);
    await candidate.archiveThread(owned);
    assert.equal(await candidate.isThreadArchived(owned), expected, mode);
  }
});

test("actual App Server child receives only explicit login and transport environment", async t => {
  const adapter = new CodexAppServerAdapter({ executable: process.execPath,
    spawnArgs: [fixture, "env-observe"], requestTimeoutMs: 500,
    environment: {
      HOME: "/synthetic/home", CODEX_HOME: "/synthetic/codex-auth", PATH: "/usr/bin:/bin",
      HTTPS_PROXY: "http://synthetic-proxy.invalid:8080", SSL_CERT_FILE: "/synthetic/ca.pem",
      EVOLOOP_DATABASE_URL: "postgres://synthetic-secret.invalid/private",
      EVOLOOP_AUTH_FILE: "/synthetic/credentials.json", OPENAI_API_KEY: "sk-synthetic-only",
      AWS_SECRET_ACCESS_KEY: "synthetic-only", ARBITRARY_SECRET: "synthetic-only",
      NODE_OPTIONS: "--require=/synthetic/should-never-load.js",
    },
  });
  t.after(() => adapter.close());
  await adapter.open();
  const binding = await adapter.create(spec);
  const read = await adapter.inspect(binding) as { observedEnvironment: Record<string, string | null> };
  assert.deepEqual(read.observedEnvironment, {
    HOME: "/synthetic/home", CODEX_HOME: "/synthetic/codex-auth", PATH: "/usr/bin:/bin",
    HTTPS_PROXY: "http://synthetic-proxy.invalid:8080", SSL_CERT_FILE: "/synthetic/ca.pem",
    EVOLOOP_DATABASE_URL: null, EVOLOOP_AUTH_FILE: null, OPENAI_API_KEY: null,
    AWS_SECRET_ACCESS_KEY: null, NODE_OPTIONS: null, ARBITRARY_SECRET: null,
  });
});

test("correlates RPCs, filters foreign events, and reads owned history", async t => {
  const adapter = await open(); t.after(() => adapter.close());
  const binding = await adapter.create(spec);
  assert.equal(binding.nativeThreadId, "thread-owned");
  const events: string[] = [];
  const completed = new Promise<void>(resolveCompleted => adapter.onEvent(event => {
    events.push(event.method);
    if (event.method === "turn/completed") resolveCompleted();
  }));
  assert.deepEqual(await adapter.resume(binding, restoreSpec), binding);
  assert.equal((await adapter.inspect(binding) as { thread: { id: string } }).thread.id, binding.nativeThreadId);
  const [turns, items] = await Promise.all([adapter.listTurns(binding), adapter.listItems(binding, "turn-1")]);
  assert.equal(turns.data[0]?.id, "turn-1"); assert.equal(items.data.length, 1);
  assert.equal((await adapter.startTurn(binding, "read only", "op-1")).id, "turn-1");
  await adapter.interruptTurn(binding, "turn-1");
  await completed;
  assert.deepEqual(events, ["turn/started", "turn/completed"]);
  await assert.rejects(() => adapter.inspect({ ...binding, authorizationScope: "other" }), RuntimeProtocolError);
});

test("classified work pages expose command/tool outcomes and omit reasoning and unknown bodies", async t => {
  const adapter = await open("work-trace"); t.after(() => adapter.close());
  const binding = await adapter.create(spec);
  const first = await adapter.readWorkPage(binding, "turn-1");
  assert.equal(first.unsupportedCount, 2);
  assert.equal(first.nextCursor, "page-2");
  assert.deepEqual(first.data.map(item => item.kind), ["command"]);
  assert.equal(first.data[0]?.exitCode, 0);
  assert.equal(first.data[0]?.output, "hello");
  assert.equal(JSON.stringify(first).includes("private thought"), false);
  assert.equal(JSON.stringify(first).includes("private future content"), false);
  const second = await adapter.readWorkPage(binding, "turn-1", first.nextCursor!);
  assert.deepEqual(second.data.map(item => item.kind), ["tool", "file_change", "message"]);
  assert.deepEqual(second.data[1]?.artifactRefs, ["/tmp/output.txt"]);
  assert.equal(second.data[0]?.output, "read output");
  await assert.rejects(() => adapter.readWorkPage({ ...binding, authorizationScope: "foreign" }, "turn-1"), RuntimeProtocolError);
});

test("work item fields have a visible bound and non-text tool output is marked incomplete", () => {
  const command = mapWorkItem({ id: "long", type: "commandExecution", command: "echo x", status: "completed",
    aggregatedOutput: "x".repeat(2500), exitCode: 0 });
  assert.equal(command?.output?.length, 2000);
  assert.equal(command?.truncated, true);
  const tool = mapWorkItem({ id: "tool", type: "mcpToolCall", server: "files", tool: "read", status: "completed",
    result: { content: [{ type: "image", data: "hidden image" }] } });
  assert.equal(tool?.truncated, true);
  assert.equal(JSON.stringify(tool).includes("hidden image"), false);
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
      nativeThreadId: "thread-owned", nativeSessionId: "thread-owned", owner: "evoloop-codex-app-server" }, restoreSpec), RuntimeProtocolError);
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
  await assert.rejects(() => adapter.resume(desktop, restoreSpec), RuntimeProtocolError);
  await assert.rejects(() => adapter.create({ ...spec, cwd: "relative" }), RuntimeProtocolError);
  await assert.rejects(() => adapter.registerBinding(desktop), RuntimeProtocolError);
});

test("restores only a binding accepted by the trusted store", async t => {
  const adapter = new CodexAppServerAdapter({ executable: process.execPath, spawnArgs: [fixture, "normal"], verifyBinding: async binding => binding.nativeThreadId === "thread-owned" && binding.authorizationScope === "task:fixture" });
  t.after(() => adapter.close()); await adapter.open();
  const binding: RuntimeBinding = { sessionId: "session-1", roleId: "role-1", projectId: "project-1", nativeThreadId: "thread-owned", nativeSessionId: "thread-owned", cwd: spec.cwd, authorizationScope: "task:fixture", owner: "evoloop-codex-app-server",
    resumeProfile:{actorId:"original-actor",model:null,sandbox:"read-only",approvalPolicy:"on-request"} };
  await adapter.registerBinding(binding);
  assert.deepEqual(await adapter.resume(binding, restoreSpec), binding);
  await assert.rejects(() => adapter.registerBinding({ ...binding, nativeThreadId: "desktop-thread" }), RuntimeProtocolError);
});

test("new owned Threads retain their first execution profile revision in the adapter binding",async t=>{
  const revisionId="00000000-0000-4000-8000-000000000131";
  const adapter=await open();t.after(()=>adapter.close());
  const first={...spec,executionProfileRevisionId:revisionId};
  const binding=await adapter.create(first);
  assert.equal(binding.resumeProfile?.executionProfileRevisionId,revisionId);
  await assert.rejects(()=>adapter.resume(binding,{...first,executionProfileRevisionId:
    "00000000-0000-4000-8000-000000000132"}),RuntimeProtocolError);
  await adapter.resume(binding,first);
});

test("resuming a persisted Session reapplies its exact native profile", async t => {
  const adapter = new CodexAppServerAdapter({ executable: process.execPath, spawnArgs: [fixture, "resume-profile"],
    verifyBinding: async () => true,
    threadConfig: async session => session.actorId === "original-actor" && session.roleId === spec.roleId &&
      session.model === "gpt-6-astra" ? {"sandbox_workspace_write.network_access": true} : undefined });
  t.after(() => adapter.close()); await adapter.open();
  const binding: RuntimeBinding = { sessionId: spec.sessionId, roleId: spec.roleId, projectId: spec.projectId,
    nativeThreadId: "thread-owned", nativeSessionId: "thread-owned", cwd: spec.cwd,
    authorizationScope: spec.authorizationScope, owner: "evoloop-codex-app-server",
    resumeProfile:{actorId:"original-actor",model:"gpt-6-astra",sandbox:"workspace-write",approvalPolicy:"on-request"} };
  await adapter.registerBinding(binding);
  const profile = { ...spec, actorId: "original-actor", model: "gpt-6-astra", sandbox: "workspace-write" as const };
  assert.deepEqual(await adapter.resume(binding, profile), binding);
  await assert.rejects(() => adapter.resume(binding, { ...profile, roleId: "other-role" }), RuntimeProtocolError);
  await assert.rejects(() => adapter.resume(binding, { ...profile, cwd: "/tmp/other" }), RuntimeProtocolError);
  await assert.rejects(() => adapter.resume(binding, { ...profile, actorId: "other-actor" }), RuntimeProtocolError);
  await assert.rejects(() => adapter.resume(binding, { ...profile, model: "other-model" }), RuntimeProtocolError);
  await assert.rejects(() => adapter.resume(binding, { ...profile, sandbox: "read-only" }), RuntimeProtocolError);
  await assert.rejects(() => adapter.resume(binding, { ...profile, approvalPolicy: "untrusted" }), RuntimeProtocolError);
});

for (const expectedVersion of ["codex-cli 0.154.0", "codex-cli 0.164.0-alpha.11.1"]) {
test(`${expectedVersion} approved execution profile revision changes only the owned Thread and freezes the next Turn model`, async t => {
  const priorRevisionId = "00000000-0000-4000-8000-000000000101";
  const revisionId = "00000000-0000-4000-8000-000000000102";
  const operationId = "00000000-0000-4000-8000-000000000103";
  let authorized = false;
  const adapter = new CodexAppServerAdapter({ executable: process.execPath, spawnArgs: [fixture, "profile-transition"],
    expectedVersion,
    verifyBinding: async () => true, authorizeExecutionProfileActivation: async () => authorized,
    threadConfig: async () => ({ "sandbox_workspace_write.network_access": false }) });
  t.after(() => adapter.close()); await adapter.open();
  const prior: RuntimeBinding = { sessionId: spec.sessionId, roleId: spec.roleId, projectId: spec.projectId,
    nativeThreadId: "thread-owned", nativeSessionId: "thread-owned", cwd: spec.cwd,
    authorizationScope: spec.authorizationScope, owner: "evoloop-codex-app-server",
    resumeProfile: { actorId: "original-actor", model: "old-model", sandbox: "workspace-write",
      approvalPolicy: "on-request", executionProfileRevisionId: priorRevisionId } };
  const target: RuntimeSessionSpec = { ...restoreSpec, model: "new-model", sandbox: "workspace-write",
    executionProfileRevisionId: revisionId };
  await adapter.registerBinding(prior);
  await assert.rejects(() => adapter.activateExecutionProfile(prior, target, revisionId, operationId), RuntimeProtocolError);
  assert.equal((await adapter.inspect(prior) as { observedResumes: number }).observedResumes, 0);
  authorized = true;
  const revised = await adapter.activateExecutionProfile(prior, target, revisionId, operationId);
  assert.equal(revised.nativeThreadId, prior.nativeThreadId);
  assert.equal(revised.resumeProfile?.model, "new-model");
  assert.equal(revised.resumeProfile?.executionProfileRevisionId, revisionId);
  await assert.rejects(() => adapter.registerBinding(prior), RuntimeProtocolError);
  await assert.rejects(() => adapter.startTurn(prior, "business", "run-op"), RuntimeProtocolError);
  await adapter.startTurn(revised, "business", "run-op", { revisionId,version:2,model:"new-model",
    sandbox:"workspace-write",approvalPolicy:"on-request",cwd:spec.cwd,
    authorizationScope:spec.authorizationScope,provenance:"revised" });
  const observed = await adapter.inspect(revised) as { lastTurnModel: string; observedTurnStarts: number };
  assert.equal(observed.lastTurnModel, "new-model");
  assert.equal(observed.observedTurnStarts, 1);
});
}

test("lost execution profile acknowledgement is reconciled by one read of the original Thread", async t => {
  const oldRevisionId="00000000-0000-4000-8000-000000000111";
  const revisionId="00000000-0000-4000-8000-000000000112";
  const operationId="00000000-0000-4000-8000-000000000113";
  const adapter=new CodexAppServerAdapter({executable:process.execPath,spawnArgs:[fixture,"profile-transition-lost"],
    requestTimeoutMs:50,verifyBinding:async()=>true,authorizeExecutionProfileActivation:async()=>true,
    threadConfig:async()=>({"sandbox_workspace_write.network_access":false})});
  t.after(()=>adapter.close());await adapter.open();
  const old:RuntimeBinding={sessionId:spec.sessionId,roleId:spec.roleId,projectId:spec.projectId,
    nativeThreadId:"thread-owned",nativeSessionId:"thread-owned",cwd:spec.cwd,authorizationScope:spec.authorizationScope,
    owner:"evoloop-codex-app-server",resumeProfile:{actorId:"original-actor",model:"old-model",
      sandbox:"workspace-write",approvalPolicy:"on-request",executionProfileRevisionId:oldRevisionId}};
  const target:RuntimeSessionSpec={...restoreSpec,model:"new-model",sandbox:"workspace-write",
    executionProfileRevisionId:revisionId};
  await adapter.registerBinding(old);
  await assert.rejects(()=>adapter.activateExecutionProfile(old,target,revisionId,operationId),RuntimeUnknownError);
  assert.equal((await adapter.inspect(old) as {observedResumes:number;observedTurnStarts:number}).observedResumes,1);
  await assert.rejects(()=>adapter.startTurn(old,"forbidden","run-op"),RuntimeProtocolError);
  const confirmed=await adapter.inspectExecutionProfileActivation(old,target,revisionId,operationId);
  assert.equal(confirmed?.resumeProfile?.model,"new-model");
  assert.equal((await adapter.inspect(confirmed!) as {observedResumes:number}).observedResumes,1);
});

test("an inconsistent native model acknowledgement cannot activate the revised business profile",async t=>{
  for(const mode of ["profile-transition-wrong-model","profile-transition-broad"]){
  const oldRevisionId="00000000-0000-4000-8000-000000000121";
  const revisionId="00000000-0000-4000-8000-000000000122";
  const adapter=new CodexAppServerAdapter({executable:process.execPath,
    spawnArgs:[fixture,mode],verifyBinding:async()=>true,
    authorizeExecutionProfileActivation:async()=>true,
    threadConfig:async()=>({"sandbox_workspace_write.network_access":false})});
  t.after(()=>adapter.close());await adapter.open();
  const current:RuntimeBinding={sessionId:spec.sessionId,roleId:spec.roleId,projectId:spec.projectId,
    nativeThreadId:"thread-owned",nativeSessionId:"thread-owned",cwd:spec.cwd,authorizationScope:spec.authorizationScope,
    owner:"evoloop-codex-app-server",resumeProfile:{actorId:"original-actor",model:"old-model",
      sandbox:"workspace-write",approvalPolicy:"on-request",executionProfileRevisionId:oldRevisionId}};
  const target:RuntimeSessionSpec={...restoreSpec,model:"new-model",sandbox:"workspace-write",
    executionProfileRevisionId:revisionId};
  await adapter.registerBinding(current);
  await assert.rejects(()=>adapter.activateExecutionProfile(current,target,revisionId,
    "00000000-0000-4000-8000-000000000123"),RuntimeUnknownError);
  await assert.rejects(()=>adapter.startTurn(current,"must stay blocked","run-op"),RuntimeProtocolError);
  assert.equal((await adapter.inspect(current) as {observedTurnStarts:number}).observedTurnStarts,0);
  }
});

test("resume explicitly revokes inherited workspace network access on the same Thread", async t => {
  let network:boolean|null = true;
  const adapter = new CodexAppServerAdapter({ executable: process.execPath, spawnArgs:[fixture,"resume-network-transition"],
    verifyBinding:async()=>true, threadConfig:async()=>network===null ? undefined : {"sandbox_workspace_write.network_access":network} });
  t.after(()=>adapter.close()); await adapter.open();
  const binding:RuntimeBinding={sessionId:spec.sessionId,roleId:spec.roleId,projectId:spec.projectId,
    nativeThreadId:"thread-owned",nativeSessionId:"thread-owned",cwd:spec.cwd,
    authorizationScope:spec.authorizationScope,owner:"evoloop-codex-app-server",
    resumeProfile:{actorId:"original-actor",model:"gpt-6-astra",sandbox:"workspace-write",approvalPolicy:"on-request"}};
  await adapter.registerBinding(binding);
  const profile={...restoreSpec,model:"gpt-6-astra",sandbox:"workspace-write" as const};
  await adapter.resume(binding,profile);
  network=false;
  await adapter.resume(binding,profile);
  network=null;
  await assert.rejects(()=>adapter.resume(binding,profile),RuntimeProtocolError);
  await assert.rejects(()=>adapter.resume(binding,{...profile,sandbox:"read-only"}),RuntimeProtocolError);
  await assert.rejects(()=>adapter.resume(binding,{...profile,actorId:"other-actor"}),RuntimeProtocolError);
});

test("a read-only bound Session cannot resume as a workspace writer",async t=>{
  const adapter=await open();t.after(()=>adapter.close());
  const binding=await adapter.create(spec);
  await assert.rejects(()=>adapter.resume(binding,{...restoreSpec,sandbox:"workspace-write"}),RuntimeProtocolError);
});

test('ordinary messages require the restricted protocol at native startup',async t=>{
  const adapter=new CodexAppServerAdapter({executable:process.execPath,spawnArgs:[fixture,'normal'],requestTimeoutMs:500,
    verifyBinding:async()=>true,threadConfig:async()=>({'sandbox_workspace_write.network_access':true})});
  t.after(()=>adapter.close());await adapter.open();
  const binding:RuntimeBinding={sessionId:spec.sessionId,roleId:spec.roleId,projectId:spec.projectId,
    nativeThreadId:'thread-owned',nativeSessionId:'thread-owned',cwd:spec.cwd,authorizationScope:spec.authorizationScope,
    owner:'evoloop-codex-app-server',resumeProfile:{actorId:'original-actor',model:'gpt-6-astra',sandbox:'workspace-write',approvalPolicy:'on-request'}};
  await adapter.registerBinding(binding);
  const proof=await adapter.qualifyReadOnlyThread(binding);
  assert.equal(proof.available,false);
  assert.match(proof.reason,/named-permission protocol was not enabled/);
  await assert.rejects(()=>adapter.startReadOnlyTurn(binding,'[evoloop-message-operation:op] hello','op'),RuntimeProtocolError);
  assert.equal((await adapter.inspect(binding) as {observedTurnStarts:number}).observedTurnStarts,0);
  await adapter.resume(binding,{...restoreSpec,model:'gpt-6-astra',sandbox:'workspace-write'});
  assert.equal((await adapter.startTurn(binding,'business','business-op')).id,'turn-1');
});

for(const mode of ['message-profile-apps-enabled','message-profile-app-override','message-profile-mcp',
  'message-profile-broad','message-profile-active']){
  test(`ordinary ${mode} is blocked before any native Turn`,async t=>{
    const adapter=new CodexAppServerAdapter({executable:process.execPath,spawnArgs:[fixture,mode],
      verifyBinding:async()=>true,requestTimeoutMs:500,enableRestrictedMessagePermissions:true});
    t.after(()=>adapter.close());await adapter.open();
    const binding:RuntimeBinding={sessionId:spec.sessionId,roleId:spec.roleId,projectId:spec.projectId,
      nativeThreadId:'thread-owned',nativeSessionId:'thread-owned',cwd:spec.cwd,authorizationScope:spec.authorizationScope,
      owner:'evoloop-codex-app-server',resumeProfile:{actorId:'original-actor',model:null,sandbox:'workspace-write',approvalPolicy:'on-request'}};
    await adapter.registerBinding(binding);
    const proof=await adapter.qualifyReadOnlyThread(binding);
    assert.equal(proof.available,false);assert.equal(proof.fingerprint,null);
    await assert.rejects(()=>adapter.startReadOnlyTurn(binding,'hello','op'),RuntimeProtocolError);
    assert.equal((await adapter.inspect(binding) as {observedTurnStarts:number}).observedTurnStarts,0);
  });
}

for(const mode of ['message-profile','message-profile-reject','message-profile-timeout']){
  test(`ordinary ${mode} uses cwd-only permissions and preserves later business policy`,async t=>{
    const adapter=new CodexAppServerAdapter({executable:process.execPath,spawnArgs:[fixture,mode],
      verifyBinding:async()=>true,requestTimeoutMs:300,enableRestrictedMessagePermissions:true,
      threadConfig:async()=>({'sandbox_workspace_write.network_access':true})});
    t.after(()=>adapter.close());await adapter.open();
    const binding:RuntimeBinding={sessionId:spec.sessionId,roleId:spec.roleId,projectId:spec.projectId,
      nativeThreadId:'thread-owned',nativeSessionId:'thread-owned',cwd:spec.cwd,authorizationScope:spec.authorizationScope,
      owner:'evoloop-codex-app-server',resumeProfile:{actorId:'original-actor',model:null,sandbox:'workspace-write',approvalPolicy:'on-request'}};
    await adapter.registerBinding(binding);
    const proof=await adapter.qualifyReadOnlyThread(binding);
    assert.equal(proof.available,true,proof.reason);
    assert.match(proof.fingerprint??'',/^[a-f0-9]{64}$/);
    if(mode==='message-profile')assert.equal((await adapter.startReadOnlyTurn(binding,'[evoloop-message-operation:op] hello','op')).id,'turn-1');
    else await assert.rejects(()=>adapter.startReadOnlyTurn(binding,'[evoloop-message-operation:op] hello','op'),
      mode==='message-profile-timeout'?RuntimeUnknownError:RuntimeServerError);
    await assert.rejects(()=>adapter.startTurn(binding,'business','business-op'),RuntimeProtocolError);
    await adapter.resume(binding,{...restoreSpec,sandbox:'workspace-write'});
    assert.equal((await adapter.startTurn(binding,'business','business-op')).id,'turn-1');
    assert.equal((await adapter.inspect(binding) as {observedTurnStarts:number}).observedTurnStarts,2);
  });
}

for(const mode of ['message-profile-drift','message-profile-activity-race']){
  test(`ordinary ${mode} is rechecked before native Turn start`,async t=>{
    const adapter=new CodexAppServerAdapter({executable:process.execPath,spawnArgs:[fixture,mode],
      verifyBinding:async()=>true,enableRestrictedMessagePermissions:true});
    t.after(()=>adapter.close());await adapter.open();
    const binding:RuntimeBinding={sessionId:spec.sessionId,roleId:spec.roleId,projectId:spec.projectId,
      nativeThreadId:'thread-owned',nativeSessionId:'thread-owned',cwd:spec.cwd,authorizationScope:spec.authorizationScope,
      owner:'evoloop-codex-app-server',resumeProfile:{actorId:'original-actor',model:null,sandbox:'workspace-write',approvalPolicy:'on-request'}};
    await adapter.registerBinding(binding);
    assert.equal((await adapter.qualifyReadOnlyThread(binding)).available,true);
    await assert.rejects(()=>adapter.startReadOnlyTurn(binding,'hello','op'),RuntimeProtocolError);
    assert.equal((await adapter.inspect(binding) as {observedTurnStarts:number}).observedTurnStarts,0);
  });
}

test('bounded message history starts with the newest native Turn even after one hundred older Turns',async t=>{
  const adapter=new CodexAppServerAdapter({executable:process.execPath,spawnArgs:[fixture,'message-profile-history'],
    verifyBinding:async()=>true,enableRestrictedMessagePermissions:true});
  t.after(()=>adapter.close());await adapter.open();
  const binding:RuntimeBinding={sessionId:spec.sessionId,roleId:spec.roleId,projectId:spec.projectId,
    nativeThreadId:'thread-owned',nativeSessionId:'thread-owned',cwd:spec.cwd,authorizationScope:spec.authorizationScope,
    owner:'evoloop-codex-app-server',resumeProfile:{actorId:'original-actor',model:null,sandbox:'workspace-write',approvalPolicy:'on-request'}};
  await adapter.registerBinding(binding);
  const first=await adapter.listTurns(binding);
  assert.equal(first.data.length,100);assert.equal(first.data[0]?.id,'turn-1');assert.equal(first.nextCursor,'older-page');
  assert.equal((await adapter.listTurns(binding,first.nextCursor)).data[0]?.id,'older-100');
});


test("read and resume reject a changed native session tree", async t => {
  const adapter = await open("changed-session"); t.after(() => adapter.close());
  const binding = await adapter.create(spec);
  await assert.rejects(() => adapter.inspect(binding), /read thread does not match binding/);
  await assert.rejects(() => adapter.resume(binding, restoreSpec), /resumed thread does not match registered binding/);
});

test("experimental tool is declared only for the selected thread and dispatches a bounded result", async t => {
  const calls:string[]=[];
  const adapter=new CodexAppServerAdapter({executable:process.execPath,spawnArgs:[fixture,"dynamic"],requestTimeoutMs:500,
    dynamicTools:async session=>session.sessionId===spec.sessionId ? [{type:"function",name:"browser_snapshot",description:"Read approved view",inputSchema:{type:"object",properties:{},additionalProperties:false}}] : undefined,
    callDynamicTool:async (call,binding)=>{calls.push(`${binding.nativeThreadId}:${call.turnId}:${call.tool}`);return {contentItems:[{type:"inputText",text:"approved text"}],success:true};},
  });
  t.after(()=>adapter.close());await adapter.open();
  const binding=await adapter.create(spec);
  const result=new Promise<unknown>(resolve=>adapter.onEvent(event=>{if(event.method==="fixture/toolDecision")resolve(event.params);}));
  await adapter.startTurn(binding,"read","operation-1");
  const decision=await result as {result:unknown};
  assert.deepEqual(calls,["thread-owned:turn-1:browser_snapshot"]);
  assert.deepEqual(decision.result,{contentItems:[{type:"inputText",text:"approved text"}],success:true});
});

test("experimental tool rejects foreign thread, unknown tool and replay", async t => {
  for (const mode of ["dynamic-foreign","dynamic-unknown-tool","dynamic-replay"]) {
    let calls=0;
    const adapter=new CodexAppServerAdapter({executable:process.execPath,spawnArgs:[fixture,mode],requestTimeoutMs:500,
      dynamicTools:async()=>[{type:"function",name:"browser_snapshot",description:"Read approved view",inputSchema:{type:"object",properties:{},additionalProperties:false}}],
      callDynamicTool:async()=>{calls++;return {contentItems:[{type:"inputText",text:"approved"}],success:true};},
    });
    t.after(()=>adapter.close());await adapter.open();const binding=await adapter.create(spec);
    const results:unknown[]=[];
    const done=new Promise<void>(resolve=>adapter.onEvent(event=>{
      if(event.method==="fixture/toolDecision") {results.push((event.params as {result:unknown}).result);if(results.length===(mode==="dynamic-replay"?2:1))resolve();}
    }));
    await adapter.startTurn(binding,"read","operation-1");await done;
    assert.equal(calls,mode==="dynamic-replay"?1:0,mode);
    assert.equal((results.at(-1) as {success:boolean}).success,false,mode);
  }
});

test("experimental tool deadline cancels its scope and sends one denial despite a late completion",async t=>{
  let cancelled=0,aborted=false,calls=0;
  const adapter=new CodexAppServerAdapter({executable:process.execPath,spawnArgs:[fixture,"dynamic-hang"],
    requestTimeoutMs:500,dynamicToolTimeoutMs:20,
    dynamicTools:async()=>[{type:"function",name:"browser_snapshot",description:"Read approved view",inputSchema:{type:"object",properties:{},additionalProperties:false}}],
    callDynamicTool:async call=>{calls++;await new Promise(resolve=>setTimeout(resolve,100));aborted=!!call.signal?.aborted;
      return {contentItems:[{type:"inputText",text:"late success"}],success:true};},
    cancelDynamicTool:async()=>{cancelled++;},
  });
  t.after(()=>adapter.close());await adapter.open();const binding=await adapter.create(spec);
  const results:unknown[]=[];
  const done=new Promise<void>(resolve=>adapter.onEvent(event=>{
    if(event.method==="fixture/toolDecision"){results.push((event.params as {result:unknown}).result);resolve();}
  }));
  await adapter.startTurn(binding,"read","operation-1");await done;
  await new Promise(resolve=>setTimeout(resolve,150));
  assert.equal(calls,1);assert.equal(cancelled,1);assert.equal(aborted,true);
  assert.equal(results.length,1);
  assert.deepEqual(results[0],{contentItems:[{type:"inputText",text:"Browser read unavailable"}],success:false});
});

test("restored native binding stays fail-closed when its tool declaration cannot be proven",async t=>{
  let calls=0;
  const adapter=new CodexAppServerAdapter({executable:process.execPath,spawnArgs:[fixture,"dynamic-restore"],requestTimeoutMs:500,
    verifyBinding:async()=>true,
    dynamicTools:async()=>[{type:"function",name:"browser_snapshot",description:"Read approved view",inputSchema:{type:"object",properties:{},additionalProperties:false}}],
    callDynamicTool:async()=>{calls++;return {contentItems:[{type:"inputText",text:"unexpected"}],success:true};},
  });
  t.after(()=>adapter.close());await adapter.open();
  const binding:RuntimeBinding={sessionId:spec.sessionId,roleId:spec.roleId,projectId:spec.projectId,
    nativeThreadId:"thread-owned",nativeSessionId:"thread-owned",cwd:spec.cwd,
    authorizationScope:spec.authorizationScope,owner:"evoloop-codex-app-server",
    resumeProfile:{actorId:"original-actor",model:null,sandbox:"read-only",approvalPolicy:"on-request"}};
  await adapter.registerBinding(binding);
  await adapter.resume(binding, restoreSpec);
  const result=new Promise<unknown>(resolve=>adapter.onEvent(event=>{if(event.method==="fixture/toolDecision")resolve(event.params);}));
  await adapter.startTurn(binding,"read","operation-1");
  assert.deepEqual((await result as {result:unknown}).result,
    {contentItems:[{type:"inputText",text:"Browser read unavailable"}],success:false});
  assert.equal(calls,0);
});

test("owned read remains available when native resume is rejected", async t => {
  const adapter = await open("resume-rejected"); t.after(() => adapter.close());
  const binding = await adapter.create(spec);
  await assert.rejects(() => adapter.resume(binding, restoreSpec), RuntimeServerError);
  assert.equal((await adapter.inspect(binding) as { thread: { id: string } }).thread.id, binding.nativeThreadId);
  assert.equal((await adapter.listTurns(binding)).data.length, 1);
  assert.equal((await adapter.listItems(binding, "turn-1")).data.length, 1);
});

 test("owned binding comparison survives persistence key order", async t => {
  const adapter = await open(); t.after(() => adapter.close());
  const binding = await adapter.create(spec);
  const restored: RuntimeBinding = { owner: binding.owner, nativeSessionId: binding.nativeSessionId,
    nativeThreadId: binding.nativeThreadId, authorizationScope: binding.authorizationScope, cwd: binding.cwd,
    projectId: binding.projectId, roleId: binding.roleId, sessionId: binding.sessionId,
    resumeProfile: binding.resumeProfile ? {approvalPolicy:binding.resumeProfile.approvalPolicy,
      sandbox:binding.resumeProfile.sandbox,model:binding.resumeProfile.model,actorId:binding.resumeProfile.actorId} : undefined };
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
