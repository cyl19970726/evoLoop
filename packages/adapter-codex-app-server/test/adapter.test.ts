import assert from "node:assert/strict";
import { resolve } from "node:path";
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
