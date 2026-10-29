import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { CodexAppServerAdapter, RuntimeProtocolError, RuntimeServerError, RuntimeUnknownError, type CodexAppServerOptions } from "../src/index.js";
import { mapWorkItem } from "../src/work-trace.js";
import type { RuntimeBinding, RuntimeSessionSpec } from "@evoloop/contracts/runtime";

const fixture = resolve(import.meta.dirname, "fixture.mjs");
const spec: RuntimeSessionSpec = { actorId:"original-actor", sessionId: "session-1", roleId: "role-1", projectId: "project-1", cwd: "/tmp/evoloop-fixture", authorizationScope: "task:fixture", model:"gpt-6-sol", sandbox: "danger-full-access", approvalPolicy: "never" };
const fullSpec:RuntimeSessionSpec={...spec};
const restoreSpec: RuntimeSessionSpec = { ...spec };
// Whole-repository parallel tests can delay fake-child startup. Keep each test's
// short request deadline for the deliberately lost native operation.
const testAdapter = (options: CodexAppServerOptions): CodexAppServerAdapter =>
  new CodexAppServerAdapter({initializationTimeoutMs:5_000,...options});
const open = async (mode = "normal", timeout = 500): Promise<CodexAppServerAdapter> => {
  const adapter = testAdapter({ executable: process.execPath, spawnArgs: [fixture, mode], requestTimeoutMs: timeout });
  await adapter.open(); return adapter;
};

test("native naming changes only the exact owned Thread and verifies its readback", async t => {
  for (const mode of ["name-sync", "name-sync-lost", "name-sync-reject"]) await t.test(mode, async () => {
    const adapter = testAdapter({ executable: process.execPath, spawnArgs: [fixture, mode],
      expectedVersion: "codex-cli 0.164.0-alpha.11.1", requestTimeoutMs: 100,
      verifyBinding: async () => true });
    t.after(() => adapter.close());
    await adapter.open();
    const binding = await adapter.create(fullSpec);
    assert.equal(binding.observedModel,"gpt-6-sol");
    assert.equal(binding.observedProvider,"openai");
    assert.equal(await adapter.readThreadName(binding), null);
    if (mode === "name-sync-reject") await assert.rejects(() => adapter.setThreadName(binding, "方案设计"), RuntimeServerError);
    else if (mode === "name-sync-lost") await assert.rejects(() => adapter.setThreadName(binding, "方案设计"), RuntimeUnknownError);
    else await adapter.setThreadName(binding, "方案设计");
    assert.equal(await adapter.readThreadName(binding), mode === "name-sync-reject" ? null : "方案设计");
    await assert.rejects(() => adapter.readThreadName({ ...binding, nativeThreadId: "foreign-thread" }), RuntimeProtocolError);
    if (mode === "name-sync") {
      await adapter.setThreadName(binding, "新名称");
      assert.equal(await adapter.readThreadName(binding), "新名称");
    }
  });
});

test("only the two reviewed CLI protocol versions can be selected", () => {
  assert.throws(() => testAdapter({ expectedVersion: "codex-cli 0.165.0" }), /unsupported Codex CLI protocol version/);
  assert.throws(() => testAdapter({ expectedVersion: "0.164.0-alpha.11.1" }), /unsupported Codex CLI protocol version/);
});

test('transport EOF does not prove child exit and close waits for the actual receipt',async t=>{
  const exits:Array<{pid:number;code:number|null;signal:NodeJS.Signals|null}>=[];
  const adapter=testAdapter({executable:process.execPath,spawnArgs:[fixture,'stdout-eof-live'],
    onExited:receipt=>{exits.push(receipt);}});
  let pid=0;
  const disconnected=new Promise<void>(resolveDisconnected=>adapter.onDisconnect(()=>resolveDisconnected()));
  t.after(async()=>{if(pid)try{process.kill(pid,'SIGKILL');}catch{}await adapter.close().catch(()=>undefined);});
  await adapter.open();
  const child=(adapter as unknown as {ownedProcess:{pid?:number}}).ownedProcess;
  pid=child.pid!;
  assert.equal(adapter.hasProcessHandle(),true);
  await disconnected;
  assert.deepEqual(exits,[]);
  let closed=false;
  const closing=adapter.close().then(()=>{closed=true;});
  await new Promise(resolveWait=>setTimeout(resolveWait,100));
  assert.equal(closed,false);
  process.kill(pid,'SIGKILL');
  await closing;
  assert.deepEqual(exits,[{pid,code:null,signal:'SIGKILL'}]);
  assert.equal(adapter.hasProcessHandle(),true);
});

for(const expectedVersion of ['codex-cli 0.154.0','codex-cli 0.164.0-alpha.11.1'] as const){
  test(`${expectedVersion} creates and runs the exact full native policy`,async t=>{
    const adapter=testAdapter({executable:process.execPath,spawnArgs:[fixture,'full-normal'],expectedVersion});
    t.after(()=>adapter.close());await adapter.open();
    const binding=await adapter.create(fullSpec);
    assert.equal(binding.resumeProfile?.sandbox,'danger-full-access');
    assert.equal(binding.resumeProfile?.approvalPolicy,'never');
    assert.equal((await adapter.startTurn(binding,'business','run-op')).id,'turn-1');
    assert.equal((await adapter.resume(binding,fullSpec)).nativeThreadId,binding.nativeThreadId);
  });
}

test('same full Thread can receive an ordinary Turn with its native tools intact',async t=>{
  const adapter=testAdapter({executable:process.execPath,spawnArgs:[fixture,'full-normal'],
    expectedVersion:'codex-cli 0.164.0-alpha.11.1'});
  t.after(()=>adapter.close());await adapter.open();const binding=await adapter.create(fullSpec);
  await assert.rejects(()=>adapter.startConversationTurn(binding,'too early','message-op'),RuntimeProtocolError);
  const admission=await adapter.qualifyConversationThread(binding);
  assert.equal(admission.available,true,admission.reason);
  assert.match(admission.fingerprint??'',/^[a-f0-9]{64}$/);
  assert.equal((await adapter.startConversationTurn(binding,'ordinary message','message-op')).id,'turn-1');
  await assert.rejects(()=>adapter.startConversationTurn(binding,'replay','message-op'),RuntimeProtocolError);
  assert.equal((await adapter.inspect(binding) as {observedTurnStarts:number}).observedTurnStarts,1);
});

test('full conversation Turn retains current trusted dynamic tool callback',async t=>{
  let bridgeCalls=0;
  const adapter=testAdapter({executable:process.execPath,spawnArgs:[fixture,'full-dynamic'],
    expectedVersion:'codex-cli 0.164.0-alpha.11.1',
    dynamicTools:async()=>[{type:'function',name:'browser_snapshot',description:'Read browser',inputSchema:{}}],
    callDynamicTool:async()=>{bridgeCalls++;return{contentItems:[{type:'inputText',text:'fixture observation'}],success:true};}});
  t.after(()=>adapter.close());await adapter.open();const binding=await adapter.create(fullSpec);
  const decision=new Promise<void>(resolveDecision=>adapter.onEvent(event=>{
    if(event.method==='fixture/toolDecision')resolveDecision();
  }));
  assert.equal((await adapter.qualifyConversationThread(binding)).available,true);
  await adapter.startConversationTurn(binding,'ordinary message','message-op');
  await decision;
  assert.equal(bridgeCalls,1);
});

test('full sequence keeps message and business inputs on one owned Thread',async t=>{
  const adapter=testAdapter({executable:process.execPath,spawnArgs:[fixture,'full-sequence'],
    expectedVersion:'codex-cli 0.164.0-alpha.11.1'});
  t.after(()=>adapter.close());await adapter.open();const binding=await adapter.create(fullSpec);
  assert.equal((await adapter.qualifyConversationThread(binding)).available,true);
  assert.equal((await adapter.startConversationTurn(binding,'message-marker','message-op')).id,'turn-1');
  assert.equal((await adapter.startTurn(binding,'business-marker','business-op')).id,'turn-2');
  const turns=await adapter.listTurns(binding);
  assert.deepEqual(turns.data.map(turn=>turn.id),['turn-2','turn-1']);
  assert.equal(((await adapter.listItems(binding,'turn-1')).data[0] as {text:string})?.text,'message-marker');
  assert.equal(((await adapter.listItems(binding,'turn-2')).data[0] as {text:string})?.text,'business-marker');
  assert.deepEqual(await adapter.inspect(binding).then(value=>{
    const result=value as {observedTurnStarts:number;observedResumes:number;lastTurnModel:string};
    return {starts:result.observedTurnStarts,resumes:result.observedResumes,model:result.lastTurnModel};
  }),{starts:2,resumes:1,model:'gpt-6-sol'});
});

test('default-model full Session survives persisted resume and an ordinary message',async t=>{
  const {model:_configuredModel,...defaultSpec}=fullSpec;
  const original=testAdapter({executable:process.execPath,spawnArgs:[fixture,'full-default'],
    expectedVersion:'codex-cli 0.164.0-alpha.11.1'});
  t.after(()=>original.close());await original.open();
  const binding=await original.create(defaultSpec);
  assert.equal(binding.resumeProfile?.model,null);
  await original.close();
  const restored=testAdapter({executable:process.execPath,spawnArgs:[fixture,'full-default'],
    expectedVersion:'codex-cli 0.164.0-alpha.11.1',verifyBinding:async()=>true});
  t.after(()=>restored.close());await restored.open();await restored.registerBinding(binding);
  assert.equal((await restored.resume(binding,defaultSpec)).nativeThreadId,binding.nativeThreadId);
  assert.equal((await restored.startTurn(binding,'first business Run','run-op')).id,'turn-1');
  assert.equal((await restored.qualifyConversationThread(binding)).available,true);
  assert.equal((await restored.startConversationTurn(binding,'ordinary','message-op')).id,'turn-1');
  const observed=await restored.inspect(binding) as {observedResumes:number;observedTurnStarts:number};
  assert.equal(observed.observedResumes,2);
  assert.equal(observed.observedTurnStarts,2);
});

for(const mode of ['full-resume-wrong-model','full-resume-thread-model-mismatch'] as const){
  test(`${mode} rejects an inconsistent native model reply`,async t=>{
    const adapter=testAdapter({executable:process.execPath,spawnArgs:[fixture,mode],
      expectedVersion:'codex-cli 0.164.0-alpha.11.1'});
    t.after(()=>adapter.close());await adapter.open();const binding=await adapter.create(fullSpec);
    await assert.rejects(()=>adapter.resume(binding,fullSpec),
      error=>error instanceof RuntimeUnknownError&&error.method==='thread/resume');
  });
}

for(const mode of ['full-unloaded','full-unloaded-lost-resume','full-unloaded-wrong-policy'] as const){
  test(`${mode} requires one exact full resume before an ordinary Turn`,async t=>{
    const adapter=testAdapter({executable:process.execPath,spawnArgs:[fixture,mode],
      expectedVersion:'codex-cli 0.164.0-alpha.11.1',verifyBinding:async()=>true,requestTimeoutMs:100});
    t.after(()=>adapter.close());await adapter.open();
    const binding:RuntimeBinding={sessionId:fullSpec.sessionId,roleId:fullSpec.roleId,
      projectId:fullSpec.projectId,nativeThreadId:'thread-owned',nativeSessionId:'thread-owned',
      cwd:fullSpec.cwd,authorizationScope:fullSpec.authorizationScope,owner:'evoloop-codex-app-server',
      resumeProfile:{actorId:'original-actor',model:'gpt-6-sol',sandbox:'danger-full-access',approvalPolicy:'never'}};
    await adapter.registerBinding(binding);
    assert.equal((await adapter.qualifyConversationThread(binding)).available,true);
    if(mode==='full-unloaded'){
      assert.equal((await adapter.startConversationTurn(binding,'ordinary','message-op')).id,'turn-1');
      assert.equal((await adapter.startTurn(binding,'business','run-op')).id,'turn-2');
    }else await assert.rejects(()=>adapter.startConversationTurn(binding,'ordinary','message-op'),
      error=>error instanceof RuntimeUnknownError&&error.method==='thread/resume');
    await assert.rejects(()=>adapter.startConversationTurn(binding,'replay','message-op'),RuntimeProtocolError);
    const observed=await adapter.inspect(binding) as {observedResumes:number;observedTurnStarts:number};
    assert.equal(observed.observedResumes,1);
    assert.equal(observed.observedTurnStarts,mode==='full-unloaded'?2:0);
  });
}

test('unloaded default-model Session starts its first ordinary message after one full resume',async t=>{
  const adapter=testAdapter({executable:process.execPath,spawnArgs:[fixture,'full-unloaded-default'],
    expectedVersion:'codex-cli 0.164.0-alpha.11.1',verifyBinding:async()=>true});
  t.after(()=>adapter.close());await adapter.open();
  const binding:RuntimeBinding={sessionId:fullSpec.sessionId,roleId:fullSpec.roleId,
    projectId:fullSpec.projectId,nativeThreadId:'thread-owned',nativeSessionId:'thread-owned',
    cwd:fullSpec.cwd,authorizationScope:fullSpec.authorizationScope,owner:'evoloop-codex-app-server',
    resumeProfile:{actorId:'original-actor',model:null,sandbox:'danger-full-access',approvalPolicy:'never'}};
  await adapter.registerBinding(binding);
  assert.equal((await adapter.qualifyConversationThread(binding)).available,true);
  assert.equal((await adapter.startConversationTurn(binding,'first ordinary message','message-op')).id,'turn-1');
  assert.equal(binding.resumeProfile?.model,null);
  const observed=await adapter.inspect(binding) as {observedResumes:number;observedTurnStarts:number};
  assert.deepEqual([observed.observedResumes,observed.observedTurnStarts],[1,1]);
});

test('full creation and resume reject native policy mismatches without inventing success',async t=>{
  const badCreate=testAdapter({executable:process.execPath,spawnArgs:[fixture,'full-start-wrong'],
    expectedVersion:'codex-cli 0.164.0-alpha.11.1'});
  t.after(()=>badCreate.close());await badCreate.open();
  await assert.rejects(()=>badCreate.create(fullSpec),error=>error instanceof RuntimeUnknownError&&error.method==='thread/start');
  const badResume=testAdapter({executable:process.execPath,spawnArgs:[fixture,'full-resume-wrong'],
    expectedVersion:'codex-cli 0.164.0-alpha.11.1'});
  t.after(()=>badResume.close());await badResume.open();const binding=await badResume.create(fullSpec);
  await assert.rejects(()=>badResume.resume(binding,fullSpec),RuntimeUnknownError);
});

test('historical read-only Thread cannot enter full conversation or claim activation from model-only readback',async t=>{
  const adapter=testAdapter({executable:process.execPath,spawnArgs:[fixture,'full-loaded-old'],
    expectedVersion:'codex-cli 0.164.0-alpha.11.1',verifyBinding:async()=>true,
    authorizeExecutionProfileActivation:async()=>true});
  t.after(()=>adapter.close());await adapter.open();
  const current:RuntimeBinding={sessionId:spec.sessionId,roleId:spec.roleId,projectId:spec.projectId,
    nativeThreadId:'thread-owned',nativeSessionId:'thread-owned',cwd:spec.cwd,authorizationScope:spec.authorizationScope,
    owner:'evoloop-codex-app-server',resumeProfile:{actorId:'original-actor',model:'old-model',
      sandbox:'read-only',approvalPolicy:'on-request',executionProfileRevisionId:'old-revision'}};
  await adapter.registerBinding(current);
  assert.equal((await adapter.qualifyConversationThread(current)).available,false);
  const target={...fullSpec,executionProfileRevisionId:'new-revision'};
  await assert.rejects(()=>adapter.activateExecutionProfile(current,target,'new-revision','profile-op'),RuntimeUnknownError);
  assert.equal(await adapter.inspectExecutionProfileActivation(current,target,'new-revision','profile-op'),null);
  assert.equal((await adapter.inspect(current) as {observedTurnStarts:number}).observedTurnStarts,0);
});

test('lost full conversation start stays unknown and is never replayed',async t=>{
  const adapter=testAdapter({executable:process.execPath,spawnArgs:[fixture,'full-lost'],
    expectedVersion:'codex-cli 0.164.0-alpha.11.1',requestTimeoutMs:100});
  t.after(()=>adapter.close());await adapter.open();const binding=await adapter.create(fullSpec);
  assert.equal((await adapter.qualifyConversationThread(binding)).available,true);
  await assert.rejects(()=>adapter.startConversationTurn(binding,'ordinary message','message-op'),
    error=>error instanceof RuntimeUnknownError&&error.method==='turn/start');
  await assert.rejects(()=>adapter.startConversationTurn(binding,'replay','message-op'),RuntimeProtocolError);
  assert.equal((await adapter.inspect(binding) as {observedTurnStarts:number}).observedTurnStarts,1);
});

test('lost full business start cannot replay the same operation in the adapter',async t=>{
  const adapter=testAdapter({executable:process.execPath,spawnArgs:[fixture,'full-lost'],
    expectedVersion:'codex-cli 0.164.0-alpha.11.1',requestTimeoutMs:100});
  t.after(()=>adapter.close());await adapter.open();const binding=await adapter.create(fullSpec);
  await assert.rejects(()=>adapter.startTurn(binding,'business','run-op'),
    error=>error instanceof RuntimeUnknownError&&error.method==='turn/start');
  await assert.rejects(()=>adapter.startTurn(binding,'replay','run-op'),RuntimeProtocolError);
  assert.equal((await adapter.inspect(binding) as {observedTurnStarts:number}).observedTurnStarts,1);
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
  const wrongVersion=testAdapter({executable,expectedVersion:"codex-cli 0.154.0"});
  await assert.rejects(()=>wrongVersion.open(),/CLI version mismatch/);
  for(const experimental of [false,true]){
    const adapter=testAdapter({executable,expectedVersion:"codex-cli 0.164.0-alpha.11.1",
      ...(experimental?{dynamicTools:async()=>[],callDynamicTool:async()=>({contentItems:[],success:false})}:{})});
    await assert.rejects(()=>adapter.open(),/schema changed/);
  }
  await assert.rejects(()=>import("node:fs/promises").then(fs=>fs.stat(join(directory,"started"))),{code:"ENOENT"});
});

for (const expectedVersion of ["codex-cli 0.154.0", "codex-cli 0.164.0-alpha.11.1"]) {
  test(`${expectedVersion} answers current time only for an owned Thread when its schema supports it`, async t => {
    const adapter = testAdapter({ executable: process.execPath, spawnArgs: [fixture, "protocol-0164"],
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

  test(`${expectedVersion} retains owned business RPCs and native history`, async t => {
    const business = testAdapter({ executable: process.execPath, spawnArgs:[fixture,"normal"],
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

  });

  test(`${expectedVersion} keeps an unacknowledged native Turn start unknown`, async t => {
    const adapter=testAdapter({executable:process.execPath,spawnArgs:[fixture,"timeout"],
      expectedVersion,requestTimeoutMs:500});
    t.after(()=>adapter.close());await adapter.open();
    const owned=await adapter.create(spec);
    await assert.rejects(()=>adapter.startTurn(owned,"business","durable-op"),
      error=>error instanceof RuntimeUnknownError&&error.method==="turn/start");
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
  const adapter = testAdapter({ executable: process.execPath,
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
  const adapter = testAdapter({ executable: process.execPath, spawnArgs: [fixture, "prebind-approval"],
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
    await assert.rejects(() => adapter.startTurn(binding, "task", "op-3"),
      error => error instanceof RuntimeUnknownError && error.method === "turn/start");
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
  const adapter = testAdapter({ executable: process.execPath, spawnArgs: [fixture, "normal"], verifyBinding: async binding => binding.nativeThreadId === "thread-owned" && binding.authorizationScope === "task:fixture" });
  t.after(() => adapter.close()); await adapter.open();
  const binding: RuntimeBinding = { sessionId: "session-1", roleId: "role-1", projectId: "project-1", nativeThreadId: "thread-owned", nativeSessionId: "thread-owned", cwd: spec.cwd, authorizationScope: "task:fixture", owner: "evoloop-codex-app-server",
    resumeProfile:{actorId:"original-actor",model:"gpt-6-sol",sandbox:"danger-full-access",approvalPolicy:"never"} };
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
  const adapter = testAdapter({ executable: process.execPath, spawnArgs: [fixture, "resume-profile"],
    verifyBinding: async () => true });
  t.after(() => adapter.close()); await adapter.open();
  const binding: RuntimeBinding = { sessionId: spec.sessionId, roleId: spec.roleId, projectId: spec.projectId,
    nativeThreadId: "thread-owned", nativeSessionId: "thread-owned", cwd: spec.cwd,
    authorizationScope: spec.authorizationScope, owner: "evoloop-codex-app-server",
    resumeProfile:{actorId:"original-actor",model:"gpt-6-astra",sandbox:"danger-full-access",approvalPolicy:"never"} };
  await adapter.registerBinding(binding);
  const profile = { ...spec, model: "gpt-6-astra" };
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
  const adapter = testAdapter({ executable: process.execPath, spawnArgs: [fixture, "profile-transition"],
    expectedVersion,
    verifyBinding: async () => true, authorizeExecutionProfileActivation: async () => authorized,
    threadConfig: async () => undefined });
  t.after(() => adapter.close()); await adapter.open();
  const prior: RuntimeBinding = { sessionId: spec.sessionId, roleId: spec.roleId, projectId: spec.projectId,
    nativeThreadId: "thread-owned", nativeSessionId: "thread-owned", cwd: spec.cwd,
    authorizationScope: spec.authorizationScope, owner: "evoloop-codex-app-server",
    resumeProfile: { actorId: "original-actor", model: "old-model", sandbox: "danger-full-access",
      approvalPolicy: "never", executionProfileRevisionId: priorRevisionId } };
  const target: RuntimeSessionSpec = { ...restoreSpec, model: "new-model", sandbox: "danger-full-access",approvalPolicy:"never",
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
    sandbox:"danger-full-access",approvalPolicy:"never",cwd:spec.cwd,
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
  const adapter=testAdapter({executable:process.execPath,spawnArgs:[fixture,"profile-transition-lost"],
    requestTimeoutMs:50,verifyBinding:async()=>true,authorizeExecutionProfileActivation:async()=>true,
    threadConfig:async()=>undefined});
  t.after(()=>adapter.close());await adapter.open();
  const old:RuntimeBinding={sessionId:spec.sessionId,roleId:spec.roleId,projectId:spec.projectId,
    nativeThreadId:"thread-owned",nativeSessionId:"thread-owned",cwd:spec.cwd,authorizationScope:spec.authorizationScope,
    owner:"evoloop-codex-app-server",resumeProfile:{actorId:"original-actor",model:"old-model",
      sandbox:"danger-full-access",approvalPolicy:"never",executionProfileRevisionId:oldRevisionId}};
  const target:RuntimeSessionSpec={...restoreSpec,model:"new-model",sandbox:"danger-full-access",approvalPolicy:"never",
    executionProfileRevisionId:revisionId};
  await adapter.registerBinding(old);
  await assert.rejects(()=>adapter.activateExecutionProfile(old,target,revisionId,operationId),
    error=>error instanceof RuntimeUnknownError&&error.method==="thread/resume");
  assert.equal((await adapter.inspect(old) as {observedResumes:number;observedTurnStarts:number}).observedResumes,1);
  await assert.rejects(()=>adapter.startTurn(old,"forbidden","run-op"),RuntimeProtocolError);
  const confirmed=await adapter.inspectExecutionProfileActivation(old,target,revisionId,operationId);
  assert.equal(confirmed?.resumeProfile?.model,"new-model");
  assert.equal((await adapter.inspect(confirmed!) as {observedResumes:number}).observedResumes,1);
});

test("an inconsistent native model acknowledgement cannot activate the revised business profile",async t=>{
  for(const mode of ["profile-transition-wrong-model","profile-transition-wrong-policy"]){
  const oldRevisionId="00000000-0000-4000-8000-000000000121";
  const revisionId="00000000-0000-4000-8000-000000000122";
  const adapter=testAdapter({executable:process.execPath,
    spawnArgs:[fixture,mode],verifyBinding:async()=>true,
    authorizeExecutionProfileActivation:async()=>true,
    threadConfig:async()=>undefined});
  t.after(()=>adapter.close());await adapter.open();
  const current:RuntimeBinding={sessionId:spec.sessionId,roleId:spec.roleId,projectId:spec.projectId,
    nativeThreadId:"thread-owned",nativeSessionId:"thread-owned",cwd:spec.cwd,authorizationScope:spec.authorizationScope,
    owner:"evoloop-codex-app-server",resumeProfile:{actorId:"original-actor",model:"old-model",
      sandbox:"danger-full-access",approvalPolicy:"never",executionProfileRevisionId:oldRevisionId}};
  const target:RuntimeSessionSpec={...restoreSpec,model:"new-model",sandbox:"danger-full-access",approvalPolicy:"never",
    executionProfileRevisionId:revisionId};
  await adapter.registerBinding(current);
  await assert.rejects(()=>adapter.activateExecutionProfile(current,target,revisionId,
    "00000000-0000-4000-8000-000000000123"),RuntimeUnknownError);
  await assert.rejects(()=>adapter.startTurn(current,"must stay blocked","run-op"),RuntimeProtocolError);
  assert.equal((await adapter.inspect(current) as {observedTurnStarts:number}).observedTurnStarts,0);
  }
});

test('bounded message history starts with the newest native Turn even after one hundred older Turns',async t=>{
  const adapter=testAdapter({executable:process.execPath,spawnArgs:[fixture,'history-newest'],
    verifyBinding:async()=>true});
  t.after(()=>adapter.close());await adapter.open();
  const binding:RuntimeBinding={sessionId:spec.sessionId,roleId:spec.roleId,projectId:spec.projectId,
    nativeThreadId:'thread-owned',nativeSessionId:'thread-owned',cwd:spec.cwd,authorizationScope:spec.authorizationScope,
    owner:'evoloop-codex-app-server',resumeProfile:{actorId:'original-actor',model:null,sandbox:'workspace-write',approvalPolicy:'on-request'}};
  await adapter.registerBinding(binding);
  const first=await adapter.listTurns(binding);
  assert.equal(first.data.length,100);assert.equal(first.data[0]?.id,'turn-1');assert.equal(first.nextCursor,'older-page');
  assert.equal((await adapter.listTurns(binding,first.nextCursor)).data[0]?.id,'older-100');
});

test('pinned 0.164 requests Turn metadata without loading Items',async t=>{
  const adapter=testAdapter({executable:process.execPath,spawnArgs:[fixture,'history-newest-0164'],
    expectedVersion:'codex-cli 0.164.0-alpha.11.1',verifyBinding:async()=>true});
  t.after(()=>adapter.close());await adapter.open();
  const binding:RuntimeBinding={sessionId:spec.sessionId,roleId:spec.roleId,projectId:spec.projectId,
    nativeThreadId:'thread-owned',nativeSessionId:'thread-owned',cwd:spec.cwd,authorizationScope:spec.authorizationScope,
    owner:'evoloop-codex-app-server'};
  await adapter.registerBinding(binding);
  assert.equal((await adapter.listTurns(binding)).data[0]?.id,'turn-1');
});

for (const mode of ['turn-cursor-missing', 'turn-cursor-empty', 'turn-cursor-number']) {
  test(`pinned 0.164 rejects ${mode} rather than reporting exhausted Turn history`, async t => {
    const adapter=testAdapter({executable:process.execPath,spawnArgs:[fixture,mode],
      expectedVersion:'codex-cli 0.164.0-alpha.11.1',verifyBinding:async()=>true});
    t.after(()=>adapter.close());await adapter.open();
    const binding:RuntimeBinding={sessionId:spec.sessionId,roleId:spec.roleId,projectId:spec.projectId,
      nativeThreadId:'thread-owned',nativeSessionId:'thread-owned',cwd:spec.cwd,authorizationScope:spec.authorizationScope,
      owner:'evoloop-codex-app-server'};
    await adapter.registerBinding(binding);
    await assert.rejects(()=>adapter.listTurns(binding),/invalid turns continuation cursor/);
  });
}

test('pinned 0.154 retains its existing missing cursor compatibility', async t => {
  const adapter=testAdapter({executable:process.execPath,spawnArgs:[fixture,'turn-cursor-legacy-missing'],
    verifyBinding:async()=>true});
  t.after(()=>adapter.close());await adapter.open();
  const binding:RuntimeBinding={sessionId:spec.sessionId,roleId:spec.roleId,projectId:spec.projectId,
    nativeThreadId:'thread-owned',nativeSessionId:'thread-owned',cwd:spec.cwd,authorizationScope:spec.authorizationScope,
    owner:'evoloop-codex-app-server'};
  await adapter.registerBinding(binding);
  assert.equal((await adapter.listTurns(binding)).nextCursor,null);
});


test("read and resume reject a changed native session tree", async t => {
  const adapter = await open("changed-session"); t.after(() => adapter.close());
  const binding = await adapter.create(spec);
  await assert.rejects(() => adapter.inspect(binding), /read thread does not match binding/);
  await assert.rejects(() => adapter.resume(binding, restoreSpec), /resumed thread does not match registered binding/);
});

test("experimental tool is declared only for the selected thread and dispatches a bounded result", async t => {
  const calls:string[]=[];
  const adapter=testAdapter({executable:process.execPath,spawnArgs:[fixture,"dynamic"],requestTimeoutMs:500,
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
    const adapter=testAdapter({executable:process.execPath,spawnArgs:[fixture,mode],requestTimeoutMs:500,
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
  const adapter=testAdapter({executable:process.execPath,spawnArgs:[fixture,"dynamic-hang"],
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
  let calls=0,declarations=0;
  const adapter=testAdapter({executable:process.execPath,spawnArgs:[fixture,"dynamic-restore"],requestTimeoutMs:500,
    verifyBinding:async()=>true,
    dynamicTools:async()=>{declarations++;return undefined;},
    callDynamicTool:async()=>{calls++;return {contentItems:[{type:"inputText",text:"unexpected"}],success:true};},
  });
  t.after(()=>adapter.close());await adapter.open();
  const binding:RuntimeBinding={sessionId:spec.sessionId,roleId:spec.roleId,projectId:spec.projectId,
    nativeThreadId:"thread-owned",nativeSessionId:"thread-owned",cwd:spec.cwd,
    authorizationScope:spec.authorizationScope,owner:"evoloop-codex-app-server",
    resumeProfile:{actorId:"original-actor",model:"gpt-6-sol",sandbox:"danger-full-access",approvalPolicy:"never"}};
  await adapter.registerBinding(binding);
  await adapter.resume(binding, restoreSpec);
  const result=new Promise<unknown>(resolve=>adapter.onEvent(event=>{if(event.method==="fixture/toolDecision")resolve(event.params);}));
  await adapter.startTurn(binding,"read","operation-1");
  assert.deepEqual((await result as {result:unknown}).result,
    {contentItems:[{type:"inputText",text:"Browser read unavailable"}],success:false});
  assert.equal(declarations,1);
  assert.equal(calls,0);
});

test("persisted business resume uses only current trusted tool names and clears them on revocation or provider failure",async t=>{
  let declarations=0,bridges=0;
  const adapter=testAdapter({executable:process.execPath,spawnArgs:[fixture,"dynamic-persisted-resume"],
    requestTimeoutMs:500,verifyBinding:async()=>true,
    dynamicTools:async()=>{
      declarations++;
      if(declarations===3)throw new Error("private declaration provider detail");
      return declarations===1?[{type:"function" as const,name:"browser_snapshot",description:"trusted browser read",inputSchema:{type:"object"}}]:[];
    },
    callDynamicTool:async(call)=>{bridges++;assert.equal(call.tool,"browser_snapshot");
      return {contentItems:[{type:"inputText",text:"approved"}],success:true};},
  });
  t.after(()=>adapter.close());await adapter.open();
  const binding:RuntimeBinding={sessionId:spec.sessionId,roleId:spec.roleId,projectId:spec.projectId,
    nativeThreadId:"thread-owned",nativeSessionId:"thread-owned",cwd:spec.cwd,
    authorizationScope:spec.authorizationScope,owner:"evoloop-codex-app-server",
    resumeProfile:{actorId:"original-actor",model:"gpt-6-sol",sandbox:"danger-full-access",approvalPolicy:"never"}};
  await adapter.registerBinding(binding);
  const decisions=new Map<number,{success:boolean}>();
  let target=0,wake:(()=>void)|null=null;
  adapter.onEvent(event=>{if(event.method!=="fixture/toolDecision")return;
    const value=event.params as {requestId:number;result:{success:boolean}};
    decisions.set(value.requestId,value.result);
    if(decisions.size>=target)wake?.();});
  const waitFor=(count:number)=>new Promise<void>(resolveDone=>{
    target=count;wake=resolveDone;if(decisions.size>=target)resolveDone();});
  await assert.rejects(()=>adapter.resume(binding,{...restoreSpec,roleId:"untrusted-role"}),RuntimeProtocolError);
  assert.equal(declarations,0,"invalid identity must not consult the declaration provider");
  await adapter.resume(binding,restoreSpec);
  assert.equal((await adapter.startTurn(binding,"first business","business-1")).id,"turn-1");
  await waitFor(2);
  assert.equal(decisions.get(801)?.success,true,"trusted current declaration is callable after cold resume");
  assert.equal(decisions.get(802)?.success,false,"untrusted historic declaration stays denied");
  assert.equal(bridges,1);
  await adapter.resume(binding,restoreSpec);
  assert.equal((await adapter.startTurn(binding,"revoked business","business-2")).id,"turn-2");
  await waitFor(4);
  assert.equal(decisions.get(803)?.success,false,"revoked declaration is removed");
  assert.equal(decisions.get(804)?.success,false);
  await assert.rejects(()=>adapter.resume(binding,restoreSpec),RuntimeProtocolError);
  assert.equal((await adapter.startTurn(binding,"provider failed","business-3")).id,"turn-3");
  await waitFor(6);
  assert.equal(decisions.get(805)?.success,false,"provider failure cannot retain a prior allowlist");
  assert.equal(decisions.get(806)?.success,false);
  assert.equal((await adapter.inspect(binding) as {observedResumes:number}).observedResumes,2,
    "declaration provider failure stops before native resume");
  assert.equal(declarations,3);assert.equal(bridges,1);
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
