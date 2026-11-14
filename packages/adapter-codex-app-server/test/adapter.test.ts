import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { CodexAppServerAdapter, RuntimeCompactionPreflightError, RuntimeProtocolError, RuntimeServerError, RuntimeUnknownError, type CodexAppServerOptions } from "../src/index.js";

test('compaction readback requires the exact persisted item entry, not a Turn summary', async () => {
  const adapter = new CodexAppServerAdapter({expectedVersion:'codex-cli 0.166.0-alpha.6'});
  const calls:string[]=[];
  const internals=adapter as unknown as Record<string,unknown>;
  internals.owned=()=>{};
  internals.inspect=async()=>({thread:{id:'thread',status:{type:'idle'},model:'gpt-6-astra',reasoningEffort:'max'}});
  internals.request=async(method:string,params:{turnId?:string})=>{
    calls.push(method);
    if(method==='thread/turns/list')return {data:[{id:'compact-turn',status:'completed',completedAt:1700000001,
      items:[{id:'summary-item',type:'contextCompaction'}]}]};
    if(method==='thread/items/list'){
      assert.equal(params.turnId,'compact-turn');
      return {data:[{turnId:'compact-turn',item:{id:'persisted-item',type:'contextCompaction'},
        completedAtMs:1700000001000}],nextCursor:null};
    }
    assert.fail(method);
  };
  const binding={nativeThreadId:'thread'} as Parameters<typeof adapter.observeCompaction>[0];
  const observed=await adapter.observeCompaction(binding,'compact-turn');
  assert.deepEqual(calls,['thread/turns/list','thread/items/list']);
  assert.equal(observed.compactionItemId,'persisted-item');
  assert.equal(observed.compactionItemCompleted,true);
});

test('failed owner Thread is reattached with its fixed profile before compaction', async () => {
  const adapter = new CodexAppServerAdapter({expectedVersion:'codex-cli 0.166.0-alpha.6'});
  const internals=adapter as unknown as Record<string,unknown>;
  const binding={sessionId:'session',roleId:'role',projectId:'project',nativeThreadId:'thread',
    nativeSessionId:'thread',cwd:'/tmp/compact',authorizationScope:'project',owner:'evoloop-codex-app-server',
    resumeProfile:{actorId:'owner',model:'gpt-6-astra',reasoningEffort:'max',sandbox:'danger-full-access',approvalPolicy:'never'}} as Parameters<typeof adapter.compactThread>[0];
  let latest='old-turn',resumed=0,sent=0;
  internals.owned=()=>{};
  internals.nativeInputConnectionId=()=> 'connection-A';
  internals.resumeBinding=async(_binding:unknown,spec:{model:string;reasoningEffort:string})=>{
    assert.equal(spec.model,'gpt-6-astra');assert.equal(spec.reasoningEffort,'max');resumed++;
  };
  internals.inspect=async()=>({thread:{id:'thread',status:{type:'systemError'},model:'gpt-6-astra',reasoningEffort:'max'}});
  internals.request=async(method:string)=>{
    if(method==='thread/turns/list')return {data:[{id:latest,status:'failed',completedAt:1700000001}]};
    if(method==='thread/compact/start'){sent++;throw new RuntimeServerError(method,17,-32000,'controlled refusal')}
    assert.fail(method);
  };
  await assert.rejects(()=>adapter.compactThread(binding,'old-turn',async()=>{}),RuntimeServerError);
  assert.equal(resumed,1);assert.equal(sent,1);
  latest='different-turn';
  await assert.rejects(()=>adapter.compactThread(binding,'old-turn',async()=>{}),RuntimeProtocolError);
  assert.equal(sent,1,'a changed native history cannot consume the compaction request');
});

test('compaction accepts the Thread default effort but still requires the exact model', async () => {
  const adapter = new CodexAppServerAdapter({expectedVersion:'codex-cli 0.166.0-alpha.6'});
  const internals=adapter as unknown as Record<string,unknown>;
  const binding={sessionId:'session',roleId:'role',projectId:'project',nativeThreadId:'thread',
    nativeSessionId:'thread',cwd:'/tmp/compact',authorizationScope:'project',owner:'evoloop-codex-app-server',
    resumeProfile:{actorId:'owner',model:'gpt-6-astra',reasoningEffort:'max',sandbox:'danger-full-access',approvalPolicy:'never'}} as Parameters<typeof adapter.compactThread>[0];
  let threadModel='gpt-6-astra',sendCount=0,resumeEffort='';
  let listener:((event:{method:string;threadId:string;turnId:string})=>void)|null=null;
  internals.owned=()=>{};
  internals.nativeInputConnectionId=()=> 'connection-A';
  internals.resumeBinding=async(_binding:unknown,spec:{model:string;reasoningEffort:string})=>{
    assert.equal(spec.model,'gpt-6-astra');
    resumeEffort=spec.reasoningEffort;
  };
  internals.inspect=async()=>({thread:{id:'thread',status:{type:'idle'},model:threadModel,reasoningEffort:'high'}});
  internals.onEvent=(callback:typeof listener)=>{listener=callback;return()=>{listener=null}};
  internals.request=async(method:string,params:Record<string,unknown>,_timeout:number,
    beforeSend?:()=>Promise<void>,afterSend?:()=>void)=>{
    if(method==='thread/turns/list')return {data:[{id:'old-turn',status:'failed',completedAt:1700000001}]};
    assert.equal(method,'thread/compact/start');
    assert.equal(params.threadId,'thread');
    assert.equal(Object.hasOwn(params,'effort'),false,'compaction has no per-Turn effort parameter');
    sendCount++;
    await beforeSend?.();
    afterSend?.();
    listener?.({method:'turn/started',threadId:'thread',turnId:'compact-turn'});
    return {};
  };
  const beforeSend=async()=>{};
  assert.equal(await adapter.compactThread(binding,'old-turn',beforeSend),'compact-turn');
  assert.equal(resumeEffort,'max');
  assert.equal(sendCount,1);
  threadModel='gpt-6-sol';
  await assert.rejects(()=>adapter.compactThread(binding,'old-turn',beforeSend),
    error=>error instanceof RuntimeCompactionPreflightError&&error.code==='thread_read_rejected');
  assert.equal(sendCount,1,'a different native model cannot consume another compaction request');
});

test('known compaction preflight failure is distinct from a lost native request', async () => {
  const adapter = new CodexAppServerAdapter({expectedVersion:'codex-cli 0.166.0-alpha.6'});
  const internals=adapter as unknown as Record<string,unknown>;
  const binding={sessionId:'session',roleId:'role',projectId:'project',nativeThreadId:'11111111-1111-4111-8111-111111111111',
    nativeSessionId:'thread',cwd:'/tmp/compact',authorizationScope:'project',owner:'evoloop-codex-app-server',
    resumeProfile:{actorId:'owner',model:'gpt-6-astra',reasoningEffort:'max',sandbox:'danger-full-access',approvalPolicy:'never'}} as Parameters<typeof adapter.compactThread>[0];
  let requested=false;
  internals.owned=()=>{};
  internals.resumeBinding=async()=>{
    throw new RuntimeServerError('thread/resume',7,-32600,
      `thread ${binding.nativeThreadId} already has an active writer`,binding.nativeThreadId);
  };
  internals.request=async()=>{requested=true;throw new Error('compaction request must not be sent')};
  await assert.rejects(()=>adapter.compactThread(binding,'old-turn',async()=>{
    throw new Error('beforeSend must not run');
  }),error=>error instanceof RuntimeCompactionPreflightError &&
    error.code==='owner_resume_writer_conflict');
  assert.equal(requested,false);
});

test('owner connection disappearing after preflight is a known unsent compaction', async () => {
  const adapter = new CodexAppServerAdapter({expectedVersion:'codex-cli 0.166.0-alpha.6'});
  const internals=adapter as unknown as Record<string,unknown>;
  const binding={sessionId:'session',roleId:'role',projectId:'project',nativeThreadId:'thread',
    nativeSessionId:'thread',cwd:'/tmp/compact',authorizationScope:'project',owner:'evoloop-codex-app-server',
    resumeProfile:{actorId:'owner',model:'gpt-6-astra',reasoningEffort:'max',sandbox:'danger-full-access',approvalPolicy:'never'}} as Parameters<typeof adapter.compactThread>[0];
  let sendCount=0;
  internals.owned=()=>{};
  internals.resumeBinding=async()=>{};
  internals.inspect=async()=>({thread:{id:'thread',status:{type:'idle'},model:'gpt-6-astra',reasoningEffort:'max'}});
  internals.request=async(method:string)=>{
    if(method==='thread/turns/list')return {data:[{id:'old-turn',status:'failed',completedAt:1700000001}]};
    sendCount++;throw new Error('compaction request must not be sent');
  };
  internals.nativeInputConnectionId=()=>null;
  await assert.rejects(()=>adapter.compactThread(binding,'old-turn',async()=>{
    throw new Error('beforeSend must not run');
  }),error=>error instanceof RuntimeCompactionPreflightError &&
    error.code==='send_connection_rejected');
  assert.equal(sendCount,0);
});

test('compaction acceptance is recorded only for a valid reply on the same owner connection', async () => {
  const adapter = new CodexAppServerAdapter({expectedVersion:'codex-cli 0.166.0-alpha.6'});
  const internals=adapter as unknown as Record<string,unknown>;
  const binding={sessionId:'session',roleId:'role',projectId:'project',nativeThreadId:'thread',
    nativeSessionId:'thread',cwd:'/tmp/compact',authorizationScope:'project',owner:'evoloop-codex-app-server',
    resumeProfile:{actorId:'owner',model:'gpt-6-astra',reasoningEffort:'max',sandbox:'danger-full-access',approvalPolicy:'never'}} as Parameters<typeof adapter.compactThread>[0];
  let connectionId='connection-A',reply:unknown={},accepted:string[]=[];
  internals.owned=()=>{};
  internals.nativeInputConnectionId=()=>connectionId;
  internals.resumeBinding=async()=>{};
  internals.inspect=async()=>({thread:{id:'thread',status:{type:'idle'},model:'gpt-6-astra',reasoningEffort:'max'}});
  let listener:((event:{method:string;threadId:string;turnId:string})=>void)|null=null;
  internals.onEvent=(callback:typeof listener)=>{listener=callback;return ()=>{listener=null}};
  internals.request=async(method:string,_params:unknown,_timeout:unknown,beforeSend?: (id:number)=>Promise<void>,
    afterSend?:()=>void)=>{
    if(method==='thread/turns/list')return {data:[{id:'old-turn',status:'failed',completedAt:1700000001}]};
    assert.equal(method,'thread/compact/start');
    await beforeSend?.(17);
    if(reply==='event-before-send')listener?.({method:'turn/started',threadId:'thread',turnId:'foreign-turn'});
    afterSend?.();
    if(reply==='event-before-send-reject'){
      throw new RuntimeServerError(method,17,-32000,'controlled refusal');
    }
    if(reply==='event-then-timeout'){
      listener?.({method:'turn/started',threadId:'thread',turnId:'captured-turn'});
      throw new RuntimeUnknownError(method,17,'response timeout');
    }
    if(reply==='event-then-reject'){
      listener?.({method:'turn/started',threadId:'thread',turnId:'captured-rejected-turn'});
      throw new RuntimeServerError(method,17,-32000,'controlled refusal');
    }
    if(reply instanceof Error)throw reply;
    if(reply==='connection-changed')connectionId='connection-B';
    if(reply==='valid-event')listener?.({method:'turn/started',threadId:'thread',turnId:'compact-turn'});
    return reply==='valid-event'||reply==='connection-changed'?{}:reply;
  };
  const beforeSend=async()=>{};
  const afterAccepted=async(id:string)=>{accepted.push(id)};
  reply='valid-event';
  assert.equal(await adapter.compactThread(binding,'old-turn',beforeSend,afterAccepted),'compact-turn');
  assert.deepEqual(accepted,['connection-A']);
  for(const invalid of [new RuntimeUnknownError('thread/compact/start',17,'timeout'),
    new RuntimeServerError('thread/compact/start',17,-32000,'controlled refusal'),{unexpected:true}]){
    reply=invalid;
    await assert.rejects(()=>adapter.compactThread(binding,'old-turn',beforeSend,afterAccepted));
    assert.deepEqual(accepted,['connection-A']);
  }
  reply='connection-changed';
  await assert.rejects(()=>adapter.compactThread(binding,'old-turn',beforeSend,afterAccepted),RuntimeUnknownError);
  assert.deepEqual(accepted,['connection-A']);
  connectionId='connection-A';reply='event-before-send';
  await assert.rejects(()=>adapter.compactThread(binding,'old-turn',beforeSend,afterAccepted),
    error=>error instanceof RuntimeUnknownError&&error.observedTurnId===undefined);
  reply='event-then-timeout';
  await assert.rejects(()=>adapter.compactThread(binding,'old-turn',beforeSend,afterAccepted),
    error=>error instanceof RuntimeUnknownError&&error.observedTurnId==='captured-turn');
  reply='event-before-send-reject';
  await assert.rejects(()=>adapter.compactThread(binding,'old-turn',beforeSend,afterAccepted),
    error=>error instanceof RuntimeServerError&&error.category==='server_rejected');
  reply='event-then-reject';
  await assert.rejects(()=>adapter.compactThread(binding,'old-turn',beforeSend,afterAccepted),
    error=>error instanceof RuntimeUnknownError&&error.method==='thread/compact/start'&&
      error.requestId===17&&error.observedTurnId==='captured-rejected-turn');
});

import { mapWorkItem } from "../src/work-trace.js";
import type { RuntimeBinding, RuntimeSessionSpec } from "@evoloop/contracts/runtime";

test("native thread read permission failure keeps permission category without exposing its message", () => {
  const error = new RuntimeServerError("thread/read", 7, -32000, "thread/read permission denied at /private/credential");
  assert.equal(error.category, "permission_denied");
  assert.equal(error.message.includes("/private/credential"), false);
});

test('only an exact native resume writer rejection is a pre-Turn writer conflict',()=>{
  const writer='thread 01a19c3b-2123-74d1-918e-0add8d529455 already has an active writer';
  const threadId='01a19c3b-2123-74d1-918e-0add8d529455';
  const conflict=new RuntimeServerError('thread/resume',9,-32600,writer,threadId);
  assert.equal(conflict.category,'writer_conflict');
  assert.equal(conflict.preTurnWriterConflict,true);
  assert.equal(new RuntimeServerError('thread/resume',9,-32600,writer,'01a19c3b-2123-74d1-918e-0add8d529456').preTurnWriterConflict,false);
  assert.doesNotMatch(conflict.message,/01a19c3b/);
  for(const [method,code,message] of [
    ['thread/read',-32600,writer],
    ['thread/resume',-32600,'no rollout found for new thread'],
    ['thread/resume',-32000,writer],
    ['thread/resume',-32600,`${writer}: private credential`],
  ] as const){
    const error=new RuntimeServerError(method,10,code,message);
    assert.equal(error.preTurnWriterConflict,false);
    assert.notEqual(error.category,'writer_conflict');
  }
});

test('native resume writer rejection surfaces before any Turn start',async t=>{
  const adapter=testAdapter({executable:process.execPath,spawnArgs:[fixture,'resume-writer-conflict']});
  t.after(()=>adapter.close());await adapter.open();
  const binding=await adapter.create(fullSpec);
  await adapter.resume(binding,fullSpec); // Consume the local thread/start proof.
  await assert.rejects(()=>adapter.resume(binding,fullSpec),error=>
    error instanceof RuntimeServerError&&error.method==='thread/resume'&&
    error.category==='writer_conflict'&&error.preTurnWriterConflict);
  assert.equal((await adapter.inspect(binding) as {observedTurnStarts:number}).observedTurnStarts,0);
});

test('ordinary Turn may reuse its operation after a writer conflict, but never after native start',async t=>{
  const adapter=testAdapter({executable:process.execPath,spawnArgs:[fixture,'resume-writer-conflict'],
    expectedVersion:'codex-cli 0.166.0-alpha.6'});
  t.after(()=>adapter.close());await adapter.open();
  const binding=await adapter.create(fullSpec);
  await adapter.resume(binding,fullSpec); // The next resume must acquire native writer ownership.
  assert.equal((await adapter.qualifyConversationThread(binding)).available,true);
  await assert.rejects(()=>adapter.startConversationTurn(binding,'fixed message','original-operation'),error=>
    error instanceof RuntimeServerError&&error.preTurnWriterConflict);
  assert.equal((await adapter.inspect(binding) as {observedTurnStarts:number}).observedTurnStarts,0);
  assert.equal((await adapter.qualifyConversationThread(binding)).available,true);
  assert.equal((await adapter.startConversationTurn(binding,'fixed message','original-operation')).id,'turn-1');
  await assert.rejects(()=>adapter.startConversationTurn(binding,'duplicate','original-operation'),RuntimeProtocolError);
  assert.equal((await adapter.inspect(binding) as {observedTurnStarts:number}).observedTurnStarts,1);
});

test('ordinary Turn reserves the Thread during pre-start work',async t=>{
  const adapter=testAdapter({executable:process.execPath,spawnArgs:[fixture,'full-normal'],
    expectedVersion:'codex-cli 0.166.0-alpha.6'});
  t.after(()=>adapter.close());await adapter.open();
  const binding=await adapter.create(fullSpec);
  assert.equal((await adapter.qualifyConversationThread(binding)).available,true);
  const first=adapter.startConversationTurn(binding,'first','first-operation');
  await assert.rejects(()=>adapter.startConversationTurn(binding,'concurrent','first-operation'),RuntimeProtocolError);
  assert.equal((await first).id,'turn-1');
  assert.equal((await adapter.inspect(binding) as {observedTurnStarts:number}).observedTurnStarts,1);
});

const fixture = resolve(import.meta.dirname, "fixture.mjs");
const spec: RuntimeSessionSpec = { actorId:"original-actor", sessionId: "session-1", roleId: "role-1", projectId: "project-1", cwd: "/tmp/evoloop-fixture", authorizationScope: "task:fixture", model:"gpt-6-sol", sandbox: "danger-full-access", approvalPolicy: "never" };
const fullSpec:RuntimeSessionSpec={...spec};
const restoreSpec: RuntimeSessionSpec = { ...spec };
const connectorBindingId='123e4567-e89b-42d3-a456-426614174000';
const connectorSpec:RuntimeSessionSpec={...spec,authorizationScope:`connector-receiver:${connectorBindingId}`,
  sandbox:'read-only',approvalPolicy:'never'};
const supportedVersions = ["codex-cli 0.154.0", "codex-cli 0.164.0-alpha.11.1", "codex-cli 0.166.0-alpha.5.1", "codex-cli 0.166.0-alpha.6", "codex-cli 0.167.0-alpha.3.2"] as const;
const modernVersions = supportedVersions.slice(1);
// Whole-repository parallel tests can delay fake-child startup. Keep each test's
// short request deadline for the deliberately lost native operation.
const testAdapter = (options: CodexAppServerOptions): CodexAppServerAdapter =>
  new CodexAppServerAdapter({initializationTimeoutMs:5_000,...options});
const open = async (mode = "normal", timeout = 500): Promise<CodexAppServerAdapter> => {
  const adapter = testAdapter({ executable: process.execPath, spawnArgs: [fixture, mode], requestTimeoutMs: timeout });
  await adapter.open(); return adapter;
};

for (const expectedVersion of modernVersions) test(`${expectedVersion} native naming changes only the exact owned Thread and verifies its readback`, async t => {
  for (const mode of ["name-sync", "name-sync-lost", "name-sync-reject"]) await t.test(mode, async () => {
    const adapter = testAdapter({ executable: process.execPath, spawnArgs: [fixture, mode],
      expectedVersion, requestTimeoutMs: 750,
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

test("only the reviewed CLI protocol versions can be selected", () => {
  for (const expectedVersion of supportedVersions)
    assert.doesNotThrow(() => testAdapter({ expectedVersion }));
  assert.doesNotThrow(() => testAdapter({expectedVersion:"codex-cli 0.167.0-alpha.3.2",nativeUserInput:true,workspaceExperimental:true}));
  assert.throws(() => testAdapter({ expectedVersion: "codex-cli 0.165.0" }), /unsupported Codex CLI protocol version/);
  assert.throws(() => testAdapter({ expectedVersion: "codex-cli 0.166.0" }), /unsupported Codex CLI protocol version/);
  assert.throws(() => testAdapter({ expectedVersion: "codex-cli 0.167.0-alpha.3.1" }), /unsupported Codex CLI protocol version/);
  assert.throws(() => testAdapter({ expectedVersion: "0.164.0-alpha.11.1" }), /unsupported Codex CLI protocol version/);
});

test('transport EOF does not prove child exit and close waits for the actual receipt',async t=>{
  const exits:Array<{pid:number;code:number|null;signal:NodeJS.Signals|null}>=[];
  const delivered:Array<{startId:string;exitObserved:boolean;firstLossAtUtc:string;stopReason:string}>=[];
  const adapter=testAdapter({executable:process.execPath,spawnArgs:[fixture,'stdout-eof-live'],
    onExited:receipt=>{exits.push(receipt);}});
  adapter.onChildDiagnostic(async diagnostic=>{
    await new Promise(resolveWait=>setTimeout(resolveWait,10));
    delivered.push({startId:diagnostic.startId,exitObserved:diagnostic.exitObserved,
      firstLossAtUtc:diagnostic.firstLossAtUtc,stopReason:diagnostic.stopReason});
  });
  let pid=0;
  const disconnected=new Promise<void>(resolveDisconnected=>adapter.onDisconnect(()=>resolveDisconnected()));
  t.after(async()=>{if(pid)try{process.kill(pid,'SIGKILL');}catch{}await adapter.close().catch(()=>undefined);});
  await adapter.open();
  const child=(adapter as unknown as {ownedProcess:{pid?:number}}).ownedProcess;
  pid=child.pid!;
  assert.equal(adapter.hasProcessHandle(),true);
  await disconnected;
  const beforeExit=adapter.lastChildDiagnostic();
  assert.equal(beforeExit?.pid,pid);
  assert.match(beforeExit?.startId??'',/^[0-9a-f-]{36}$/);
  assert.equal(beforeExit?.stopReason,'stdout_closed');
  assert.equal(beforeExit?.firstLossReason,'stdout_closed');
  assert.equal(beforeExit?.firstLossAtUtc,beforeExit?.observedAtUtc);
  assert.equal(beforeExit?.exitObserved,false);
  assert.equal(beforeExit?.exitCode,null);
  assert.equal(beforeExit?.exitSignal,null);
  assert.equal(beforeExit?.nativeTurnOutcome,'unknown');
  assert.equal(beforeExit?.exitedAtUtc,null);
  assert.ok(Date.parse(beforeExit!.startedAtUtc)<=Date.parse(beforeExit!.observedAtUtc));
  assert.deepEqual(exits,[]);
  let closed=false;
  const closing=adapter.close().then(()=>{closed=true;});
  await new Promise(resolveWait=>setTimeout(resolveWait,100));
  assert.equal(closed,false);
  process.kill(pid,'SIGKILL');
  await closing;
  assert.deepEqual(exits,[{pid,code:null,signal:'SIGKILL'}]);
  const afterExit=adapter.lastChildDiagnostic();
  assert.equal(afterExit?.stopReason,'process_exited');
  assert.equal(afterExit?.firstLossReason,'stdout_closed');
  assert.equal(afterExit?.firstLossAtUtc,beforeExit?.firstLossAtUtc);
  assert.equal(afterExit?.observedAtUtc,beforeExit?.observedAtUtc);
  assert.equal(afterExit?.exitObserved,true);
  assert.equal(afterExit?.exitCode,null);
  assert.equal(afterExit?.exitSignal,'SIGKILL');
  assert.ok(Date.parse(afterExit!.exitedAtUtc!)>=Date.parse(beforeExit!.firstLossAtUtc));
  assert.deepEqual(adapter.listChildDiagnostics(),[afterExit]);
  assert.deepEqual(delivered,[
    {startId:beforeExit!.startId,exitObserved:false,firstLossAtUtc:beforeExit!.firstLossAtUtc,stopReason:'stdout_closed'},
    {startId:beforeExit!.startId,exitObserved:true,firstLossAtUtc:beforeExit!.firstLossAtUtc,stopReason:'process_exited'},
  ]);
  assert.equal(adapter.hasProcessHandle(),true);
});

test('unexpected child exit retains a bounded private-free diagnostic and no Turn terminal event',async t=>{
  let exited!:()=>void;
  const exit=new Promise<void>(resolveExit=>{exited=resolveExit;});
  const adapter=testAdapter({executable:process.execPath,spawnArgs:[fixture,'exit-private-stderr'],
    onExited:()=>exited()});
  t.after(()=>adapter.close());
  const events:string[]=[];
  adapter.onEvent(event=>events.push(event.method));
  const disconnected=new Promise<void>(resolveDisconnected=>adapter.onDisconnect(()=>resolveDisconnected()));
  await adapter.open();
  await disconnected;
  await exit;
  const diagnostic=adapter.lastChildDiagnostic();
  assert.equal(diagnostic?.stopReason,'process_exited');
  assert.equal(diagnostic?.exitObserved,true);
  assert.equal(diagnostic?.exitCode,23);
  assert.equal(diagnostic?.exitSignal,null);
  assert.equal(diagnostic?.nativeTurnOutcome,'unknown');
  assert.ok(diagnostic?.pid && diagnostic.pid>0);
  assert.ok(Date.now()-Date.parse(diagnostic!.observedAtUtc)<10_000);
  assert.doesNotMatch(JSON.stringify(diagnostic),/private fixture credential|stderr|user body/);
  assert.deepEqual(events,[]);
  await adapter.close();
  assert.deepEqual(adapter.lastChildDiagnostic(),diagnostic);
});

test('child diagnostics retain only the newest sixteen separate starts',async t=>{
  let exitDone:()=>void=()=>{};
  const adapter=testAdapter({executable:process.execPath,spawnArgs:[fixture,'exit-private-stderr'],
    onExited:()=>exitDone()});
  t.after(()=>adapter.close());
  const starts:string[]=[];
  for(let index=0;index<18;index++){
    const exited=new Promise<void>(resolveExit=>{exitDone=resolveExit;});
    await adapter.open();
    await exited;
    starts.push(adapter.lastChildDiagnostic()!.startId);
  }
  const history=adapter.listChildDiagnostics();
  assert.equal(history.length,16);
  assert.deepEqual(history.map(entry=>entry.startId),starts.slice(2).reverse());
  history[0]!.exitCode=999;
  assert.equal(adapter.lastChildDiagnostic()?.exitCode,23);
  assert.equal(JSON.stringify(history).includes('private fixture credential'),false);
});

test('failed diagnostic persistence cannot be reported as flushed',async t=>{
  let exited!:()=>void;
  const exit=new Promise<void>(resolveExit=>{exited=resolveExit;});
  const adapter=testAdapter({executable:process.execPath,spawnArgs:[fixture,'exit-private-stderr'],
    onExited:()=>exited()});
  t.after(()=>adapter.close().catch(()=>undefined));
  adapter.onChildDiagnostic(async()=>{throw new Error('private observer credential');});
  await adapter.open();await exit;
  await assert.rejects(()=>adapter.flushChildDiagnostics(),error=>
    error instanceof RuntimeUnknownError&&error.method==='child-diagnostic'&&
    !error.message.includes('private observer credential'));
});

for(const expectedVersion of supportedVersions){
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

test('alpha.6 creates only the exact restricted connector receiver and blocks its native Turn',async t=>{
  const adapter=testAdapter({executable:process.execPath,spawnArgs:[fixture,'connector-normal'],
    expectedVersion:'codex-cli 0.166.0-alpha.6'});
  t.after(()=>adapter.close());await adapter.open();
  for(const invalid of [
    {...connectorSpec,authorizationScope:'connector-receiver:other'},
    {...connectorSpec,authorizationScope:'task:fixture'},
    {...connectorSpec,sandbox:'workspace-write' as const},
    {...connectorSpec,approvalPolicy:'on-request' as const},
    {...connectorSpec,sandbox:'danger-full-access' as const},
    {...connectorSpec,actorId:undefined},
  ])await assert.rejects(()=>adapter.create(invalid),RuntimeProtocolError);
  const binding=await adapter.create(connectorSpec);
  assert.equal(binding.authorizationScope,connectorSpec.authorizationScope);
  assert.equal(binding.resumeProfile?.sandbox,'read-only');
  assert.equal(binding.resumeProfile?.approvalPolicy,'never');
  await assert.rejects(()=>adapter.registerBinding({...binding,
    resumeProfile:{...binding.resumeProfile!,sandbox:'danger-full-access'}}),RuntimeProtocolError);
  await assert.rejects(()=>adapter.qualifyConnectorReceiver({...binding,sessionId:'foreign-session'},
    connectorBindingId),RuntimeProtocolError);
  assert.equal((await adapter.resume(binding,connectorSpec)).nativeThreadId,binding.nativeThreadId);
  assert.equal((await adapter.resume(binding,connectorSpec)).nativeThreadId,binding.nativeThreadId);
  const admission=await adapter.qualifyConnectorReceiver(binding,connectorBindingId);
  assert.equal(admission.available,false);
  assert.match(admission.fingerprint??'',/^[a-f0-9]{64}$/);
  await assert.rejects(()=>adapter.startConnectorTurn(binding,'message','op-1',connectorBindingId,
    admission.fingerprint!),/shell disablement is not verified/);
  await assert.rejects(()=>adapter.startConnectorTurn(binding,'message','op-1',connectorBindingId,
    '0'.repeat(64)),RuntimeProtocolError);
  await assert.rejects(()=>adapter.startTurn(binding,'business','run-1'),RuntimeProtocolError);
  await assert.rejects(()=>adapter.startConversationTurn(binding,'message','op-2'),RuntimeProtocolError);
  assert.equal((await adapter.inspect(binding) as {observedTurnStarts:number}).observedTurnStarts,0);
  assert.equal((await adapter.qualifyConnectorReceiver(binding,'123e4567-e89b-42d3-a456-426614174001')).available,false);
});

test('restricted creation is unavailable on older pinned native protocols',async t=>{
  const adapter=testAdapter({executable:process.execPath,spawnArgs:[fixture,'connector-normal'],
    expectedVersion:'codex-cli 0.166.0-alpha.5.1'});
  t.after(()=>adapter.close());await adapter.open();
  await assert.rejects(()=>adapter.create(connectorSpec),RuntimeProtocolError);
});

for(const mode of ['connector-wrong-sandbox','connector-wrong-network','connector-wrong-approval']){
  test(`${mode} cannot register a restricted native creation`,async t=>{
    const adapter=testAdapter({executable:process.execPath,spawnArgs:[fixture,mode],
      expectedVersion:'codex-cli 0.166.0-alpha.6'});
    t.after(()=>adapter.close());await adapter.open();
    await assert.rejects(()=>adapter.create(connectorSpec),RuntimeUnknownError);
  });
}

test('restricted resume rejects native full-policy acknowledgement',async t=>{
  const adapter=testAdapter({executable:process.execPath,spawnArgs:[fixture,'connector-resume-wrong'],
    expectedVersion:'codex-cli 0.166.0-alpha.6'});
  t.after(()=>adapter.close());await adapter.open();
  const binding=await adapter.create(connectorSpec);
  await adapter.resume(binding,connectorSpec); // consume the same-connection thread/start proof
  await assert.rejects(()=>adapter.resume(binding,connectorSpec),RuntimeUnknownError);
});

test('restricted receiver host declines shell tool and approval requests', {timeout:5000},async t=>{
  let invoked=0;
  const adapter=testAdapter({executable:process.execPath,spawnArgs:[fixture,'connector-host-shell'],
    expectedVersion:'codex-cli 0.166.0-alpha.6',
    threadConfig:async()=>{invoked++;return {tools:{shell:true}};},
    dynamicTools:async()=>{invoked++;return [{type:'function',name:'shell',description:'Shell',inputSchema:{type:'object'}}];},
    decideApproval:async()=>{invoked++;return 'accept';},
    callDynamicTool:async()=>{invoked++;return {contentItems:[],success:true};}});
  t.after(()=>adapter.close());await adapter.open();
  const binding=await adapter.create(connectorSpec);
  const tool=new Promise<unknown>(resolveResult=>adapter.onEvent(event=>{
    if(event.method==='fixture/toolDecision')resolveResult((event.params as {result:unknown}).result);
  }));
  const approval=new Promise<unknown>(resolveResult=>adapter.onEvent(event=>{
    if(event.method==='fixture/approvalDecision')resolveResult((event.params as {decision:unknown}).decision);
  }));
  await adapter.qualifyConnectorReceiver(binding,connectorBindingId);
  assert.equal((await tool as {success:boolean}).success,false);
  assert.equal(await approval,'decline');
  assert.equal(invoked,0);
  assert.equal((await adapter.inspect(binding) as {observedTurnStarts:number}).observedTurnStarts,0);
});

for(const expectedVersion of modernVersions){
  test(`${expectedVersion} full Thread can receive an ordinary Turn`,async t=>{
    const adapter=testAdapter({executable:process.execPath,spawnArgs:[fixture,'full-normal'],
      expectedVersion});
    t.after(()=>adapter.close());await adapter.open();const binding=await adapter.create(fullSpec);
    await assert.rejects(()=>adapter.startConversationTurn(binding,'too early','message-op'),RuntimeProtocolError);
    const admission=await adapter.qualifyConversationThread(binding);
    assert.equal(admission.available,true,admission.reason);
    assert.match(admission.fingerprint??'',/^[a-f0-9]{64}$/);
    assert.equal((await adapter.startConversationTurn(binding,'ordinary message','message-op')).id,'turn-1');
    await assert.rejects(()=>adapter.startConversationTurn(binding,'replay','message-op'),RuntimeProtocolError);
    assert.equal((await adapter.inspect(binding) as {observedTurnStarts:number}).observedTurnStarts,1);
  });
}

for(const mode of ['full-network-failed','full-network-lost-resume','full-network-turn-changed',
  'full-network-active','full-network-unsettled','full-network-no-completion',
  'full-network-completed','full-network-unknown-status',
  'full-network-model-mismatch','full-network-model-missing'] as const){
  test(`${mode} admits a failed original Thread only with terminal and fixed-profile proof`,async t=>{
    const adapter=testAdapter({executable:process.execPath,spawnArgs:[fixture,mode],
      expectedVersion:'codex-cli 0.164.0-alpha.11.1',verifyBinding:async()=>true,
      requestTimeoutMs:100});
    t.after(()=>adapter.close());await adapter.open();
    const binding:RuntimeBinding={sessionId:fullSpec.sessionId,roleId:fullSpec.roleId,
      projectId:fullSpec.projectId,nativeThreadId:'thread-owned',nativeSessionId:'thread-owned',
      cwd:fullSpec.cwd,authorizationScope:fullSpec.authorizationScope,owner:'evoloop-codex-app-server',
      resumeProfile:{actorId:'original-actor',model:'gpt-6-sol',sandbox:'danger-full-access',approvalPolicy:'never'}};
    await adapter.registerBinding(binding);
    const admission=await adapter.qualifyConversationThread(binding);
    if(mode==='full-network-failed'){
      assert.equal(admission.available,true,admission.reason);
      assert.equal((await adapter.startConversationTurn(binding,'continue original QA','message-op')).id,'turn-1');
      await assert.rejects(()=>adapter.startConversationTurn(binding,'replay','message-op'),RuntimeProtocolError);
    }else if(mode==='full-network-lost-resume'||mode==='full-network-turn-changed'){
      assert.equal(admission.available,true,admission.reason);
      await assert.rejects(()=>adapter.startConversationTurn(binding,'continue original QA','message-op'),
        error=>error instanceof RuntimeUnknownError&&error.method==='thread/resume');
      await assert.rejects(()=>adapter.startConversationTurn(binding,'replay','message-op'),RuntimeProtocolError);
    }else{
      assert.equal(admission.available,false);
      await assert.rejects(()=>adapter.startConversationTurn(binding,'unsafe','message-op'),RuntimeProtocolError);
    }
    const observed=await adapter.inspect(binding) as {observedResumes:number;observedTurnStarts:number};
    assert.equal(observed.observedResumes,admission.available?1:0);
    assert.equal(observed.observedTurnStarts,mode==='full-network-failed'?1:0);
  });
}

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
  }),{starts:2,resumes:0,model:'gpt-6-sol'});
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
    await adapter.startTurn(binding,'establish existing Turn','existing-turn');
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
  await badResume.startTurn(binding,'establish existing Turn','existing-turn');
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

for (const expectedVersion of modernVersions) test(`${expectedVersion} changed standard or experimental schema stops before App Server startup`, async t => {
  const directory=await mkdtemp(join(tmpdir(),"evoloop-protocol-fingerprint-"));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const executable=join(directory,"fake-codex");
  await writeFile(executable,`#!/bin/sh
if [ "$1" = "--version" ]; then printf '%s\\n' '${expectedVersion}'; exit 0; fi
if [ "$1" = "app-server" ] && [ "$2" = "generate-json-schema" ]; then
  while [ "$#" -gt 0 ]; do if [ "$1" = "--out" ]; then shift; mkdir -p "$1"; printf '{}' > "$1/codex_app_server_protocol.v2.schemas.json"; exit 0; fi; shift; done
fi
printf 'app-server-started' > '${join(directory,"started")}'
exit 1
`,{mode:0o700});
  for(const experimental of [false,true]){
    const adapter=testAdapter({executable,expectedVersion,
      ...(experimental?{dynamicTools:async()=>[],callDynamicTool:async()=>({contentItems:[],success:false})}:{})});
    await assert.rejects(()=>adapter.open(),/schema changed/);
  }
  await assert.rejects(()=>import("node:fs/promises").then(fs=>fs.stat(join(directory,"started"))),{code:"ENOENT"});
});

test("the installed CLI version must exactly match the selected pinned protocol", async t => {
  const directory=await mkdtemp(join(tmpdir(),"evoloop-protocol-version-"));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const executable=join(directory,"fake-codex");
  await writeFile(executable,`#!/bin/sh
if [ "$1" = "--version" ]; then printf '%s\\n' 'codex-cli 0.164.0-alpha.11.1'; exit 0; fi
printf 'unexpected' > '${join(directory,"started")}'
exit 1
`,{mode:0o700});
  const adapter=testAdapter({executable,expectedVersion:"codex-cli 0.166.0-alpha.5.1"});
  await assert.rejects(()=>adapter.open(),/CLI version mismatch/);
  await assert.rejects(()=>import("node:fs/promises").then(fs=>fs.stat(join(directory,"started"))),{code:"ENOENT"});
});

for (const expectedVersion of supportedVersions) {
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
    if (expectedVersion !== "codex-cli 0.154.0") {
      assert.equal(Number.isSafeInteger((own.result as Record<string, unknown>).currentTimeAt), true);
      assert.ok(Math.abs((own.result as {currentTimeAt:number}).currentTimeAt - Math.floor(Date.now()/1000)) < 5);
    } else assert.equal((own.error as {code:number}).code, -32601);
    assert.equal((replies.get(851)!.error as {code:number}).code, expectedVersion === "codex-cli 0.154.0" ? -32601 : -32000);
    assert.equal((replies.get(852)!.error as {code:number}).code, expectedVersion === "codex-cli 0.154.0" ? -32601 : -32000);
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

for (const expectedVersion of supportedVersions) {
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

for(const expectedVersion of ['codex-cli 0.166.0-alpha.5.1','codex-cli 0.166.0-alpha.6','codex-cli 0.167.0-alpha.3.2'] as const)
test(`${expectedVersion} pinned native settings readback confirms both model and effort before a fixed Turn`,async t=>{
  const priorRevisionId='00000000-0000-4000-8000-000000000201';
  const revisionId='00000000-0000-4000-8000-000000000202';
  const operationId='00000000-0000-4000-8000-000000000203';
  const adapter=testAdapter({executable:process.execPath,spawnArgs:[fixture,'model-effort'],
    expectedVersion,authorizeExecutionProfileActivation:async()=>true,
    verifyBinding:async()=>true});
  t.after(()=>adapter.close());await adapter.open();
  const prior:RuntimeBinding={sessionId:spec.sessionId,roleId:spec.roleId,projectId:spec.projectId,
    nativeThreadId:'thread-owned',nativeSessionId:'thread-owned',cwd:spec.cwd,
    authorizationScope:spec.authorizationScope,owner:'evoloop-codex-app-server',
    resumeProfile:{actorId:'original-actor',model:'old-model',reasoningEffort:'high',sandbox:'danger-full-access',
      approvalPolicy:'never',executionProfileRevisionId:priorRevisionId}};
  const target:RuntimeSessionSpec={...spec,model:'new-model',reasoningEffort:'max',
    executionProfileRevisionId:revisionId};
  await adapter.registerBinding(prior);
  const revised=await adapter.activateExecutionProfile(prior,target,revisionId,operationId);
  assert.equal(revised.resumeProfile?.reasoningEffort,'max');
  await adapter.startTurn(revised,'fixed business input','fixed-turn-op',{
    revisionId,version:2,model:'new-model',reasoningEffort:'max',sandbox:'danger-full-access',
    approvalPolicy:'never',cwd:spec.cwd,authorizationScope:spec.authorizationScope,provenance:'revised'});
  assert.equal((await adapter.inspect(revised) as {observedTurnStarts:number}).observedTurnStarts,1);
});

for(const expectedVersion of ['codex-cli 0.166.0-alpha.5.1','codex-cli 0.166.0-alpha.6','codex-cli 0.167.0-alpha.3.2'] as const)
test(`${expectedVersion} a restarted native owner loads the original Thread before updating model and effort`,async t=>{
  const adapter=testAdapter({executable:process.execPath,spawnArgs:[fixture,'model-effort-unloaded'],
    expectedVersion,authorizeExecutionProfileActivation:async()=>true,
    verifyBinding:async()=>true});
  t.after(()=>adapter.close());await adapter.open();
  const prior:RuntimeBinding={sessionId:spec.sessionId,roleId:spec.roleId,projectId:spec.projectId,
    nativeThreadId:'thread-owned',nativeSessionId:'thread-owned',cwd:spec.cwd,
    authorizationScope:spec.authorizationScope,owner:'evoloop-codex-app-server',
    resumeProfile:{actorId:'original-actor',model:'old-model',reasoningEffort:'high',
      sandbox:'danger-full-access',approvalPolicy:'never',executionProfileRevisionId:'prior'}};
  await adapter.registerBinding(prior);
  const revised=await adapter.activateExecutionProfile(prior,{...spec,model:'new-model',
    reasoningEffort:'max',executionProfileRevisionId:'target'},'target','operation');
  assert.equal(revised.nativeThreadId,prior.nativeThreadId);
  assert.equal(revised.resumeProfile?.reasoningEffort,'max');
  assert.equal((await adapter.inspect(revised) as {observedResumes:number}).observedResumes,1);
});

test('a replacement revision can restore the last confirmed model and effort after rejection',async t=>{
  const adapter=testAdapter({executable:process.execPath,spawnArgs:[fixture,'model-effort'],
    expectedVersion:'codex-cli 0.166.0-alpha.5.1',authorizeExecutionProfileActivation:async()=>true,
    verifyBinding:async()=>true});
  t.after(()=>adapter.close());await adapter.open();
  const prior:RuntimeBinding={sessionId:spec.sessionId,roleId:spec.roleId,projectId:spec.projectId,
    nativeThreadId:'thread-owned',nativeSessionId:'thread-owned',cwd:spec.cwd,
    authorizationScope:spec.authorizationScope,owner:'evoloop-codex-app-server',
    resumeProfile:{actorId:'original-actor',model:'old-model',reasoningEffort:'high',
      sandbox:'danger-full-access',approvalPolicy:'never',executionProfileRevisionId:'confirmed'}};
  await adapter.registerBinding(prior);
  const restored=await adapter.activateExecutionProfile(prior,{...spec,model:'old-model',
    reasoningEffort:'high',executionProfileRevisionId:'replacement'},'replacement','operation');
  assert.equal(restored.resumeProfile?.executionProfileRevisionId,'replacement');
  assert.equal(restored.resumeProfile?.model,'old-model');
});

test('explicit settings rejection and lost reply never confirm a new profile',async t=>{
  for(const mode of ['model-effort-reject','model-effort-lost']){
    const adapter=testAdapter({executable:process.execPath,spawnArgs:[fixture,mode],requestTimeoutMs:80,
      expectedVersion:'codex-cli 0.166.0-alpha.5.1',authorizeExecutionProfileActivation:async()=>true,
      verifyBinding:async()=>true});
    t.after(()=>adapter.close());await adapter.open();
    const prior:RuntimeBinding={sessionId:spec.sessionId,roleId:spec.roleId,projectId:spec.projectId,
      nativeThreadId:'thread-owned',nativeSessionId:'thread-owned',cwd:spec.cwd,
      authorizationScope:spec.authorizationScope,owner:'evoloop-codex-app-server',
      resumeProfile:{actorId:'original-actor',model:'old-model',reasoningEffort:'high',
        sandbox:'danger-full-access',approvalPolicy:'never',executionProfileRevisionId:'prior'}};
    await adapter.registerBinding(prior);
    await assert.rejects(()=>adapter.activateExecutionProfile(prior,{...spec,model:'new-model',
      reasoningEffort:'max',executionProfileRevisionId:'target'},'target','operation'),
      error=>mode.endsWith('reject')?error instanceof RuntimeServerError:error instanceof RuntimeUnknownError);
  }
});

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

for (const expectedVersion of modernVersions) {
  test(`${expectedVersion} requests Turn metadata without loading Items`,async t=>{
    const adapter=testAdapter({executable:process.execPath,spawnArgs:[fixture,'history-newest-0164'],
      expectedVersion,verifyBinding:async()=>true});
    t.after(()=>adapter.close());await adapter.open();
    const binding:RuntimeBinding={sessionId:spec.sessionId,roleId:spec.roleId,projectId:spec.projectId,
      nativeThreadId:'thread-owned',nativeSessionId:'thread-owned',cwd:spec.cwd,authorizationScope:spec.authorizationScope,
      owner:'evoloop-codex-app-server'};
    await adapter.registerBinding(binding);
    assert.equal((await adapter.listTurns(binding)).data[0]?.id,'turn-1');
  });
}

for (const expectedVersion of modernVersions) for (const mode of ['turn-cursor-missing', 'turn-cursor-empty', 'turn-cursor-number']) {
  test(`${expectedVersion} rejects ${mode} rather than reporting exhausted Turn history`, async t => {
    const adapter=testAdapter({executable:process.execPath,spawnArgs:[fixture,mode],
      expectedVersion,verifyBinding:async()=>true});
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
  await adapter.startTurn(binding,"establish existing Turn","existing-turn");
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


const zeroTurnAdapter = (options: CodexAppServerOptions = {}) => testAdapter({
  executable:process.execPath,spawnArgs:[fixture,'zero-turn'],
  expectedVersion:'codex-cli 0.166.0-alpha.5.1',...options,
});
const noRollout = (error:unknown) => error instanceof RuntimeServerError &&
  error.method==='thread/resume' && error.code===-32600;

test('zero-turn first dispatch consumes start policy proof exactly once',async t=>{
  const adapter=zeroTurnAdapter({verifyBinding:async()=>true});t.after(()=>adapter.close());await adapter.open();
  const binding=await adapter.create(fullSpec);
  // The runner reconstructs its binding from PostgreSQL, without create-only observations.
  const {observedModel: _model,observedProvider: _provider,...persisted}=binding;
  await adapter.registerBinding(persisted);
  assert.deepEqual(await adapter.resume(persisted,fullSpec),persisted);
  assert.equal((await adapter.inspect(binding) as {observedResumes:number}).observedResumes,0);
  await assert.rejects(()=>adapter.resume(binding,fullSpec),noRollout);
  await adapter.startTurn(binding,'first business Turn','zero-business');
  await assert.rejects(()=>adapter.resume(binding,fullSpec),noRollout);
});

for(const ordinary of [false,true])test(`zero-turn ${ordinary?'ordinary message':'direct Turn'} invalidates first-dispatch proof`,async t=>{
  const adapter=zeroTurnAdapter();t.after(()=>adapter.close());await adapter.open();
  const binding=await adapter.create(fullSpec);
  if(ordinary){
    assert.equal((await adapter.qualifyConversationThread(binding)).available,true);
    await adapter.startConversationTurn(binding,'first message','zero-message');
  }else await adapter.startTurn(binding,'first direct Turn','zero-direct');
  await assert.rejects(()=>adapter.resume(binding,fullSpec),noRollout);
});

for(const change of ['actor','scope','binding','config','tools','invalid-tools','provider-failure'] as const)
test(`zero-turn does not bypass ${change} checks or retain failed admission`,async t=>{
  let changed=false;
  const tool={type:'function' as const,name:'browser_snapshot',description:'Read browser',inputSchema:{type:'object'}};
  const adapter=zeroTurnAdapter({threadConfig:async()=>({reasoning:changed&&change==='config'?'high':'medium'}),
    dynamicTools:async()=>{
      if(changed&&change==='provider-failure')throw new Error('unavailable');
      return changed&&change==='invalid-tools'?[{...tool,description:''}]:
        [{...tool,inputSchema:{type:changed&&change==='tools'?'string':'object'}}];
    },callDynamicTool:async()=>({contentItems:[],success:true})});
  t.after(()=>adapter.close());await adapter.open();const binding=await adapter.create(fullSpec);changed=true;
  const target=change==='actor'?{...fullSpec,actorId:'foreign'}:
    change==='scope'?{...fullSpec,authorizationScope:'foreign'}:fullSpec;
  await assert.rejects(()=>adapter.resume(change==='binding'?{...binding,nativeSessionId:'foreign'}:binding,target),
    change==='config'||change==='tools'?noRollout:RuntimeProtocolError);
  changed=false;
  await assert.rejects(()=>adapter.resume(binding,fullSpec),noRollout);
});

test('zero-turn unknown Turn and restarted adapter always use strict native recovery',async t=>{
  const adapter=zeroTurnAdapter({spawnArgs:[fixture,'zero-turn-timeout'],requestTimeoutMs:100});
  t.after(()=>adapter.close());await adapter.open();const binding=await adapter.create(fullSpec);
  await assert.rejects(()=>adapter.startTurn(binding,'unknown','zero-unknown'),RuntimeUnknownError);
  await assert.rejects(()=>adapter.resume(binding,fullSpec),noRollout);
  await adapter.close();
  const restored=zeroTurnAdapter({verifyBinding:async()=>true});t.after(()=>restored.close());
  await restored.open();await restored.registerBinding(binding);
  await assert.rejects(()=>restored.resume(binding,fullSpec),noRollout);
});


test('zero-turn disconnect clears proof even when the same adapter reopens',async t=>{
  let exited!:()=>void;
  const exit=new Promise<void>(resolveExit=>{exited=resolveExit;});
  const adapter=zeroTurnAdapter({spawnArgs:[fixture,'zero-turn-disconnect'],onExited:()=>exited()});
  t.after(()=>adapter.close());await adapter.open();const binding=await adapter.create(fullSpec);
  await assert.rejects(()=>adapter.setThreadName(binding,'disconnect'),RuntimeUnknownError);
  await exit;await adapter.open();
  await assert.rejects(()=>adapter.resume(binding,fullSpec),noRollout);
});

test('zero-turn provider await cannot reuse proof after a concurrent Turn',async t=>{
  let release!:()=>void,entered!:()=>void;
  const gate=new Promise<void>(resolveGate=>{release=resolveGate;});
  const waiting=new Promise<void>(resolveWaiting=>{entered=resolveWaiting;});
  let creating=true;
  const adapter=zeroTurnAdapter({threadConfig:async()=>{
    if(!creating){entered();await gate;}return {reasoning:'medium'};
  }});
  t.after(()=>adapter.close());await adapter.open();const binding=await adapter.create(fullSpec);creating=false;
  const resuming=adapter.resume(binding,fullSpec);
  await waiting;await adapter.startTurn(binding,'concurrent Turn','concurrent-op');release();
  await assert.rejects(()=>resuming,noRollout);
});


for(const ordinary of [false,true])test(`zero-turn notLoaded read and missing rollout preserve ${ordinary?'message':'Runner'} first dispatch`,async t=>{
  const adapter=zeroTurnAdapter({spawnArgs:[fixture,'zero-turn-not-loaded']});
  t.after(()=>adapter.close());await adapter.open();const binding=await adapter.create(fullSpec);
  const read=await adapter.inspect(binding) as {thread:{status:{type:string}}};
  assert.equal(read.thread.status.type,'notLoaded');
  await assert.rejects(()=>adapter.listTurns(binding),error=>error instanceof RuntimeServerError&&error.code===-32600);
  if(ordinary){
    assert.equal((await adapter.qualifyConversationThread(binding)).available,true);
    await adapter.startConversationTurn(binding,'first ordinary message','not-loaded-message');
  }else{
    await adapter.resume(binding,fullSpec);
    await adapter.startTurn(binding,'first Runner Turn','not-loaded-run');
  }
  const observed=await adapter.inspect(binding) as {observedTurnStarts:number;observedResumes:number};
  assert.equal(observed.observedTurnStarts,1);assert.equal(observed.observedResumes,0);
  await assert.rejects(()=>adapter.resume(binding,fullSpec),noRollout);
});


test('zero-turn native active notification without Turn ID invalidates start proof',async t=>{
  const adapter=zeroTurnAdapter({spawnArgs:[fixture,'zero-turn-active-event']});
  t.after(()=>adapter.close());await adapter.open();const binding=await adapter.create(fullSpec);
  await adapter.setThreadName(binding,'observe active event');
  await assert.rejects(()=>adapter.resume(binding,fullSpec),noRollout);
});

test('zero-turn notLoaded effort change fails before consuming first-start proof',async t=>{
  const adapter=zeroTurnAdapter({spawnArgs:[fixture,'zero-turn-not-loaded'],
    authorizeExecutionProfileActivation:async()=>true});
  t.after(()=>adapter.close());await adapter.open();
  const prior={...fullSpec,executionProfileRevisionId:'prior'};
  const binding=await adapter.create(prior);
  await assert.rejects(()=>adapter.activateExecutionProfile(binding,{...prior,model:'new-model',
    reasoningEffort:'max',executionProfileRevisionId:'next'},'next','change-operation'),
    error=>error instanceof RuntimeProtocolError&&/zero.turn|rollout/i.test(error.message));
  assert.deepEqual(await adapter.resume(binding,prior),binding);
  await adapter.startTurn(binding,'original first Turn','first-operation',{
    revisionId:'prior',version:1,model:prior.model!,reasoningEffort:null,
    sandbox:'danger-full-access',approvalPolicy:'never',cwd:prior.cwd,
    authorizationScope:prior.authorizationScope,provenance:'reserved'});
  assert.equal((await adapter.inspect(binding) as {observedTurnStarts:number}).observedTurnStarts,1);
});

test('first-start proof rejects an effort mismatch and cannot be reused',async t=>{
  const adapter=zeroTurnAdapter();t.after(()=>adapter.close());await adapter.open();
  const prior={...fullSpec,executionProfileRevisionId:'prior'};
  const binding=await adapter.create(prior);
  await assert.rejects(()=>adapter.resume(binding,{...prior,reasoningEffort:'max'}),RuntimeProtocolError);
  await assert.rejects(()=>adapter.resume(binding,prior),noRollout);
});

test('first ordinary message sends the fixed reasoning effort to the native Turn',async t=>{
  const adapter=testAdapter({executable:process.execPath,spawnArgs:[fixture,'model-effort-active'],
    expectedVersion:'codex-cli 0.166.0-alpha.5.1',verifyBinding:async()=>true});
  t.after(()=>adapter.close());await adapter.open();
  const binding:RuntimeBinding={sessionId:spec.sessionId,roleId:spec.roleId,projectId:spec.projectId,
    nativeThreadId:'thread-owned',nativeSessionId:'thread-owned',cwd:spec.cwd,
    authorizationScope:spec.authorizationScope,owner:'evoloop-codex-app-server',
    resumeProfile:{actorId:spec.actorId!,model:'new-model',reasoningEffort:'max',
      sandbox:'danger-full-access',approvalPolicy:'never',executionProfileRevisionId:'active'}};
  await adapter.registerBinding(binding);
  assert.equal((await adapter.qualifyConversationThread(binding)).available,true);
  await adapter.startConversationTurn(binding,'first message','message-operation');
  assert.equal((await adapter.inspect(binding) as {observedTurnStarts:number}).observedTurnStarts,1);
});

test('turn listing waits out the brief -32601 history attach window after turn/start, and only that', async () => {
  const adapter = new CodexAppServerAdapter({expectedVersion:'codex-cli 0.167.0-alpha.3.2'});
  const internals=adapter as unknown as Record<string,unknown>;
  internals.owned=()=>{};
  const binding={nativeThreadId:'thread'} as Parameters<typeof adapter.listTurns>[0];
  let calls=0,failures=2,code=-32601;
  internals.request=async(method:string)=>{
    assert.equal(method,'thread/turns/list');calls++;
    if(failures-->0)throw new RuntimeServerError(method,calls,code,'list_turns is not supported yet');
    return {data:[{id:'turn',status:'inProgress'}],nextCursor:null};
  };
  assert.deepEqual((await adapter.listTurns(binding)).data.map(turn=>turn.id),['turn']);
  assert.equal(calls,3,'two transient rejections then the page');

  calls=0;failures=Infinity;
  await assert.rejects(()=>adapter.listTurns(binding),(error:unknown)=>error instanceof RuntimeServerError&&error.category==='method_not_found');
  assert.equal(calls,6,'the wait is bounded; a persistent rejection still surfaces');

  calls=0;failures=1;code=-32600;
  await assert.rejects(()=>adapter.listTurns(binding),RuntimeServerError);
  assert.equal(calls,1,'other rejections, such as a missing rollout, are never retried');
});

test('effort rides on turn/start where the runtime cannot update a live Thread, and the Thread reports it back', async () => {
  const bare = new CodexAppServerAdapter({expectedVersion:'codex-cli 0.167.0-alpha.3.2'});
  const withUpdate = new CodexAppServerAdapter({expectedVersion:'codex-cli 0.166.0-alpha.6'});
  const anyBinding = {} as Parameters<typeof bare.appliesEffortWithNextTurn>[0];
  assert.equal(bare.appliesEffortWithNextTurn(anyBinding), true, '0.167 has no thread/settings/update');
  assert.equal(withUpdate.appliesEffortWithNextTurn(anyBinding), false, 'a runtime with thread/settings/update activates natively');
  assert.ok(bare.allowedReasoningEfforts(anyBinding).includes('max') && !bare.allowedReasoningEfforts(anyBinding).includes('none'), "Codex's set has the gateway's max; the profile table cannot store none");

  const adapter = bare;
  const internals = adapter as unknown as Record<string, unknown>;
  const sent: Array<{ method: string; params: Record<string, unknown> }> = [];
  internals.owned = () => {};
  let reported: string | undefined = 'max', latest = 'turn-1';
  internals.request = async (method: string, params: Record<string, unknown>) => {
    sent.push({ method, params });
    if (method === 'turn/start') return { turn: { id: 'turn-1', status: 'inProgress', completedAt: null, items: [] } };
    if (method === 'thread/turns/list') return { data: [{ id: latest, status: 'inProgress' }], nextCursor: null };
    if (method === 'thread/read') return { thread: { id: 'thread', reasoningEffort: reported, model: 'deepseek/deepseek-flash-0610' } };
    assert.fail(method);
  };
  const binding = { sessionId: 's', roleId: 'r', projectId: 'p', nativeThreadId: 'thread', nativeSessionId: 'thread', cwd: '/tmp/e', authorizationScope: 'project',
    owner: 'evoloop-codex-app-server', resumeProfile: { actorId: 'a', model: 'deepseek/deepseek-flash', reasoningEffort: 'max', sandbox: 'danger-full-access',
      approvalPolicy: 'never', executionProfileRevisionId: 'rev-1' } } as Parameters<typeof adapter.startTurn>[0];
  const profile = { revisionId: 'rev-1', version: 2, model: 'deepseek/deepseek-flash', reasoningEffort: 'max', sandbox: 'danger-full-access', approvalPolicy: 'never',
    cwd: '/tmp/e', authorizationScope: 'project', provenance: 'revised' } as Parameters<typeof adapter.startTurn>[3];
  const turn = await adapter.startTurn(binding, 'business', 'op-1', profile);
  const start = sent.find(call => call.method === 'turn/start')!;
  assert.equal(start.params.effort, 'max', 'turn/start carries the configured effort');
  assert.equal(turn.observedReasoningEffort, 'max', 'and the Thread reports it back');
  assert.equal(turn.observedModel, 'deepseek/deepseek-flash-0610', 'the model the Thread reports, not the configured one');
  // No effort requested: model and effort are still read back from the Thread.
  const plain = await adapter.startTurn({ ...binding, resumeProfile: { ...binding.resumeProfile!, reasoningEffort: null } } as never, 'business', 'op-plain',
    { ...profile, reasoningEffort: null } as never);
  assert.equal(plain.observedModel, 'deepseek/deepseek-flash-0610');
  // Task f9e0fd58 v7: no effort requested, and the runtime still reports one (its own default): that is the Turn's real effort and is recorded.
  assert.equal(plain.observedReasoningEffort, 'max', 'the Thread reports max although no effort was configured');
  // The Thread's latest Turn is another one: the reported value is not proof for this Turn, so it is not claimed.
  latest = 'someone-elses-turn';
  const foreign = await adapter.startTurn(binding, 'business', 'op-foreign', profile);
  assert.equal(foreign.observedReasoningEffort, null); assert.equal(foreign.observedModel, null, "another Turn's Thread value is not claimed");
  // A readback that fails or reports nothing never fails the Turn that already started.
  internals.request = async (method: string) => {
    if (method === 'turn/start') return { turn: { id: 'turn-2', status: 'inProgress', completedAt: null, items: [] } };
    throw new RuntimeServerError('thread/read', -32000, 'unavailable', 'server_error');
  };
  const second = await adapter.startTurn(binding, 'business', 'op-2', profile);
  assert.equal(second.id, 'turn-2'); assert.equal(second.observedReasoningEffort, null); assert.equal(second.observedModel, null);
});

test('the per-turn effort readback waits out the same -32601 attach window as turn listing, for Run, message and direct-input starts alike', async () => {
  const adapter = new CodexAppServerAdapter({expectedVersion:'codex-cli 0.167.0-alpha.3.2'});
  const internals = adapter as unknown as Record<string, unknown>;
  internals.owned = () => {};
  let listCalls = 0, rejections = 2;
  internals.request = async (method: string) => {
    if (method === 'turn/start') return { turn: { id: 'turn-1', status: 'inProgress', completedAt: null, items: [] } };
    if (method === 'thread/turns/list') {
      listCalls++;
      if (rejections-- > 0) throw new RuntimeServerError(method, listCalls, -32601, 'list_turns is not supported yet');
      return { data: [{ id: 'turn-1', status: 'inProgress' }], nextCursor: null };
    }
    if (method === 'thread/read') return { thread: { id: 'thread', reasoningEffort: 'max' } };
    assert.fail(method);
  };
  const binding = { sessionId: 's', roleId: 'r', projectId: 'p', nativeThreadId: 'thread', nativeSessionId: 'thread', cwd: '/tmp/e', authorizationScope: 'project',
    owner: 'evoloop-codex-app-server', resumeProfile: { actorId: 'a', model: 'deepseek/deepseek-flash', reasoningEffort: 'max', sandbox: 'danger-full-access',
      approvalPolicy: 'never', executionProfileRevisionId: 'rev-1' } } as Parameters<typeof adapter.startTurn>[0];
  const profile = { revisionId: 'rev-1', version: 2, model: 'deepseek/deepseek-flash', reasoningEffort: 'max', sandbox: 'danger-full-access', approvalPolicy: 'never',
    cwd: '/tmp/e', authorizationScope: 'project', provenance: 'revised' } as Parameters<typeof adapter.startTurn>[3];
  // Run start.
  const run = await adapter.startTurn(binding, 'business', 'op-run', profile);
  assert.equal(listCalls, 3, 'two transient rejections, then the page');
  assert.equal(run.observedReasoningEffort, 'max', 'the readback is read, not reported unread');
  // Message / direct-input start (the conversation path both use).
  listCalls = 0; rejections = 2;
  // Admission, resume and idle checks are not under test here: only what happens after turn/start is.
  (internals.conversationQualifications as Map<string, unknown>).set('thread', { observedAt: Date.now(), fingerprint: 'f'.repeat(64), model: 'deepseek/deepseek-flash' });
  internals.qualifyConversationThread = async () => ({ available: true, reason: 'ok', fingerprint: 'f'.repeat(64) });
  internals.resumeBinding = async () => ({ usedStartProof: false });
  internals.nativeThreadIdle = async () => true;
  const conversation = await (adapter as unknown as { startConversationTurn(b: unknown, i: string, o: string): Promise<{ observedReasoningEffort?: string | null }> })
    .startConversationTurn(binding, 'hello', 'op-message');
  assert.equal(listCalls, 3, 'the conversation start retries the same way');
  assert.equal(conversation.observedReasoningEffort, 'max');
  // Persistent rejection: bounded, then honestly unread; the Turn that already started is never failed.
  listCalls = 0; rejections = Infinity;
  const unread = await adapter.startTurn(binding, 'business', 'op-late', profile);
  assert.equal(listCalls, 6, 'the wait is bounded');
  assert.equal(unread.observedReasoningEffort, null);
});

for (const [expectedVersion, replaces] of [["codex-cli 0.167.0-alpha.3.2", true], ["codex-cli 0.166.0-alpha.6", false]] as const) {
  test(`${expectedVersion}: an effort-only revision ${replaces ? "re-registers on the real adapter and starts a Turn" : "still conflicts, because it is activated natively"}`, async t => {
    const adapter = testAdapter({ executable: process.execPath, spawnArgs: [fixture, 'full-normal'], expectedVersion, verifyBinding: async () => true });
    t.after(() => adapter.close()); await adapter.open();
    const created = await adapter.create(fullSpec);
    const withProfile = (b: RuntimeBinding, effort: string, revisionId: string): RuntimeBinding =>
      ({ ...b, resumeProfile: { ...b.resumeProfile!, reasoningEffort: effort, executionProfileRevisionId: revisionId } });
    const first = withProfile(created, 'high', 'rev-1'), second = withProfile(created, 'low', 'rev-2');
    if (!replaces) {
      await assert.rejects(() => adapter.registerBinding(first), /conflicting runtime binding/);
      return;
    }
    await adapter.registerBinding(first);
    // The coordinator re-registers after the revision became active; no stubbed ownership check.
    await adapter.registerBinding(second);
    const profile = { revisionId: 'rev-2', version: 2, model: second.resumeProfile!.model, reasoningEffort: 'low', sandbox: 'danger-full-access', approvalPolicy: 'never',
      cwd: second.cwd, authorizationScope: second.authorizationScope, provenance: 'revised' } as Parameters<typeof adapter.startTurn>[3];
    assert.equal((await adapter.startTurn(second, 'business', 'op-effort', profile)).status !== undefined, true);
    // The old registration is gone and a different model is still a conflict.
    await assert.rejects(() => adapter.startTurn(first, 'again', 'op-old', { ...profile, revisionId: 'rev-1', reasoningEffort: 'high' } as typeof profile), /not registered to this adapter and scope/);
    await assert.rejects(() => adapter.registerBinding({ ...second, resumeProfile: { ...second.resumeProfile!, model: 'another-model' } }), /conflicting runtime binding/);
  });
}

test('defect 3d30f7ac: observeTurnEffort reads the Thread effort and model for a Turn that is already running or settled, only while it is the Thread\'s latest, and never throws', async () => {
  const adapter = new CodexAppServerAdapter({expectedVersion:'codex-cli 0.167.0-alpha.3.2'});
  const internals = adapter as unknown as Record<string, unknown>;
  internals.owned = () => {};
  let latest = 'turn-1', failList = false;
  internals.request = async (method: string) => {
    if (method === 'thread/turns/list') { if (failList) throw new RuntimeServerError(method, 1, -32000, 'unavailable'); return { data: [{ id: latest, status: 'completed' }], nextCursor: null }; }
    if (method === 'thread/read') return { thread: { id: 'thread', reasoningEffort: 'max', model: 'deepseek/deepseek-flash' } };
    assert.fail(method);
  };
  const binding = { sessionId: 's', roleId: 'r', projectId: 'p', nativeThreadId: 'thread', nativeSessionId: 'thread', cwd: '/tmp/e', authorizationScope: 'project', owner: 'evoloop-codex-app-server' } as Parameters<typeof adapter.observeTurnEffort>[0];
  assert.deepEqual(await adapter.observeTurnEffort(binding, 'turn-1'), { reasoningEffort: 'max', model: 'deepseek/deepseek-flash' }, 'the latest Turn: the Thread\'s values');
  latest = 'turn-2';
  assert.deepEqual(await adapter.observeTurnEffort(binding, 'turn-1'), { reasoningEffort: null, model: null }, 'a newer Turn exists: the value is not claimed for the older one');
  latest = 'turn-1'; failList = true;
  assert.deepEqual(await adapter.observeTurnEffort(binding, 'turn-1'), { reasoningEffort: null, model: null }, 'a failed read is not recorded, and does not throw');
  await assert.rejects(adapter.observeTurnEffort(binding, ''), /turn ID required/);
});
