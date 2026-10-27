import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import test from 'node:test';
import type {NativeInputEvent} from '@evoloop/contracts/native-input';
import type {RuntimeBinding,RuntimeEvent,RuntimeSessionSpec} from '@evoloop/contracts/runtime';
import {CodexAppServerAdapter,RuntimeProtocolError,RuntimeUnknownError} from '../src/index.js';

const fixture=resolve(import.meta.dirname,'native-input-fixture.mjs');
const spec:RuntimeSessionSpec={actorId:'owner',sessionId:'session-1',roleId:'role-1',projectId:'project-1',
  cwd:'/tmp/evoloop-fixture',authorizationScope:'task:fixture',model:'gpt-6-sol',
  sandbox:'danger-full-access',approvalPolicy:'never'};
const pending=<T>(subscribe:(resolve:(value:T)=>void)=>void):Promise<T>=>
  new Promise((resolveValue,reject)=>{
    const timer=setTimeout(()=>reject(new Error('fixture event timeout')),2_000);
    subscribe(value=>{clearTimeout(timer);resolveValue(value);});
  });
async function opened(mode:string,version='codex-cli 0.164.0-alpha.11.1',observe=true){
  const adapter=new CodexAppServerAdapter({executable:process.execPath,spawnArgs:[fixture,mode],
    expectedVersion:version,initializationTimeoutMs:5_000,requestTimeoutMs:500});
  const events:NativeInputEvent[]=[];
  if(observe)adapter.onNativeInput(event=>{events.push(event);});
  await adapter.open();
  const binding=await adapter.create(spec);
  return {adapter,binding,events};
}
const requests=(events:NativeInputEvent[])=>events.filter(event=>event.type==='requested').map(event=>event.request);
const closed=(events:NativeInputEvent[])=>events.filter(event=>event.type==='closed');

test('native input launch flag is scoped to the owned 0.164 App Server child',()=>{
  const normal=new CodexAppServerAdapter({expectedVersion:'codex-cli 0.164.0-alpha.11.1'});
  const enabled=new CodexAppServerAdapter({expectedVersion:'codex-cli 0.164.0-alpha.11.1',nativeUserInput:true});
  const args=(adapter:CodexAppServerAdapter)=>(adapter as unknown as {appServerArguments():string[]}).appServerArguments();
  assert.deepEqual(args(normal),['app-server','--stdio']);
  assert.deepEqual(args(enabled),['-c','features.default_mode_request_user_input=true','app-server','--stdio']);
  assert.throws(()=>new CodexAppServerAdapter({expectedVersion:'codex-cli 0.154.0',nativeUserInput:true}),RuntimeProtocolError);
});
async function trigger(adapter:CodexAppServerAdapter,binding:RuntimeBinding,events:NativeInputEvent[],count=1){
  const ready=pending<void>(resolveReady=>{
    const listener=(event:NativeInputEvent)=>{if(event.type==='requested'&&requests(events).length>=count){remove();resolveReady();}};
    const remove=adapter.onNativeInput(listener);
  });
  await adapter.inspect(binding);
  await ready;
  return requests(events);
}
function nativeReply(adapter:CodexAppServerAdapter,count=1){
  const values:RuntimeEvent[]=[];
  const done=pending<RuntimeEvent[]>(resolveDone=>{
    const remove=adapter.onEvent(event=>{
      if(event.method!=='fixture/nativeReply')return;
      values.push(event);if(values.length>=count){remove();resolveDone(values);}
    });
  });
  return done;
}

test('blocking text input preserves typed RPC id and answers only after explicit response',async t=>{
  const {adapter,binding,events}=await opened('blocking');t.after(()=>adapter.close());
  const replies=nativeReply(adapter);
  const [capture]=await trigger(adapter,binding,events);
  assert.equal(capture.supported,true);
  assert.equal(capture.isBlocking,true);
  assert.equal(capture.nativeRequestId,1);
  assert.equal(capture.connectionId,adapter.nativeInputConnectionId());
  assert.equal(capture.questions[0]?.id,'name');
  assert.equal(capture.questions[0]?.options,null);
  assert.equal(adapter.hasPendingInput(capture.id,capture.connectionId),true);
  await adapter.respondToInput(capture.id,capture.connectionId,{name:['Alice']});
  assert.equal(adapter.hasPendingInput(capture.id,capture.connectionId),false);
  const [reply]=await replies;
  assert.deepEqual((reply.params as {result:unknown}).result,{answers:{name:{answers:['Alice']}}});
  await new Promise(resolveWait=>setTimeout(resolveWait,10));
  assert.equal(closed(events)[0]?.reason,'native_resolved');
  assert.equal((await adapter.inspect(binding) as {turnStarts:number}).turnStarts,0);
});

for(const mode of ['nonblocking','options','empty-options'] as const){
  test(`${mode} input retains blocking flag and answer shape`,async t=>{
    const {adapter,binding,events}=await opened(mode);t.after(()=>adapter.close());
    const replies=nativeReply(adapter);
    const [capture]=await trigger(adapter,binding,events);
    assert.equal(capture.supported,true);
    assert.equal(capture.isBlocking,mode!=='nonblocking');
    if(mode==='options')assert.deepEqual(capture.questions[0]?.options?.map(value=>value.label),['Alpha','Beta']);
    if(mode==='empty-options')assert.equal(capture.questions[0]?.options,null);
    await adapter.respondToInput(capture.id,capture.connectionId,mode==='options'?{choice:['Beta']}:{name:['free text']});
    assert.ok((await replies)[0]);
  });
}

test('numeric and string JSON-RPC IDs remain distinct and cannot be replayed',async t=>{
  const {adapter,binding,events}=await opened('numeric-string');t.after(()=>adapter.close());
  const replies=nativeReply(adapter,2);
  const captures=await trigger(adapter,binding,events,2);
  assert.deepEqual(captures.map(value=>value.nativeRequestId),[1,'1']);
  for(const capture of captures)await adapter.respondToInput(capture.id,capture.connectionId,{name:['answer']});
  assert.deepEqual((await replies).map(value=>(value.params as {requestId:unknown}).requestId),[1,'1']);
  await assert.rejects(()=>adapter.respondToInput(captures[0]!.id,captures[0]!.connectionId,{name:['again']}),RuntimeProtocolError);
});

test('duplicate request id yields one capture and serverRequest/resolved closes exact handle',async t=>{
  const {adapter,binding,events}=await opened('duplicate');t.after(()=>adapter.close());
  const replies=nativeReply(adapter);
  const [capture]=await trigger(adapter,binding,events);
  assert.equal(requests(events).length,1);
  await adapter.respondToInput(capture.id,capture.connectionId,{name:['answer']});
  await replies;
  await new Promise(resolveWait=>setTimeout(resolveWait,10));
  assert.equal(requests(events).length,1);
  assert.equal(closed(events).length,1);
});

test('native resolution before a reply closes the captured request',async t=>{
  const {adapter,binding,events}=await opened('resolved');t.after(()=>adapter.close());
  const [capture]=await trigger(adapter,binding,events);
  await new Promise(resolveWait=>setTimeout(resolveWait,10));
  assert.equal(adapter.hasPendingInput(capture.id,capture.connectionId),false);
  assert.equal(closed(events)[0]?.reason,'native_resolved');
  await assert.rejects(()=>adapter.respondToInput(capture.id,capture.connectionId,{name:['late']}),RuntimeProtocolError);
});

test('a foreign Thread resolution cannot close an owned pending request',async t=>{
  const {adapter,binding,events}=await opened('resolved-foreign');t.after(()=>adapter.close());
  const [capture]=await trigger(adapter,binding,events);
  assert.equal(adapter.hasPendingInput(capture.id,capture.connectionId),true);
  const replies=nativeReply(adapter);
  const resolved=pending<void>(resolveDone=>{
    const remove=adapter.onNativeInput(event=>{
      if(event.type==='closed'&&event.id===capture.id){remove();resolveDone();}
    });
  });
  await adapter.respondToInput(capture.id,capture.connectionId,{name:['answer']});
  await replies;
  await resolved;
  assert.equal(closed(events)[0]?.reason,'native_resolved');
});

test('foreign Thread request is denied without an owned capture',async t=>{
  const {adapter,binding,events}=await opened('foreign-thread');t.after(()=>adapter.close());
  const replies=nativeReply(adapter);
  await adapter.inspect(binding);
  const [reply]=await replies;
  assert.equal((reply.params as {error:{code:number}}).error.code,-32601);
  assert.deepEqual(requests(events),[]);
});

test('unsafe numeric JSON-RPC ID disconnects without a pending handle',async t=>{
  const {adapter,binding,events}=await opened('unsafe-id');t.after(()=>adapter.close());
  const stopped=pending<void>(resolveDone=>adapter.onDisconnect(()=>resolveDone()));
  await adapter.inspect(binding).catch(()=>undefined);
  await stopped;
  assert.equal(adapter.nativeInputConnectionId(),null);
  assert.deepEqual(requests(events),[]);
});

test('request before owned binding is denied without capturing or starting a Turn',async t=>{
  const adapter=new CodexAppServerAdapter({executable:process.execPath,spawnArgs:[fixture,'early'],
    expectedVersion:'codex-cli 0.164.0-alpha.11.1',initializationTimeoutMs:5_000});
  const events:NativeInputEvent[]=[];adapter.onNativeInput(event=>{events.push(event);});
  t.after(()=>adapter.close());await adapter.open();
  const binding=await adapter.create(spec);
  assert.equal(requests(events).length,0);
  const [capture]=await trigger(adapter,binding,events);
  assert.equal(capture.supported,true);
});

for(const mode of ['secret','budget','large-budget','duplicate-options','blank-question-id',
  'mcp','mcp-url','mcp-device'] as const){
  test(`${mode} remains readable but unsupported without sensitive payload or selection`,async t=>{
    const {adapter,binding,events}=await opened(mode);t.after(()=>adapter.close());
    const replies=nativeReply(adapter);
    const [capture]=await trigger(adapter,binding,events);
    assert.equal(capture.supported,false);
    assert.deepEqual(capture.questions,[]);
    assert.equal(adapter.hasPendingInput(capture.id,capture.connectionId),false);
    if(mode.startsWith('mcp')){
      assert.equal(capture.turnId,null);
      assert.equal(capture.itemId,null);
    }
    if(mode==='large-budget')assert.equal(capture.unavailableReason,'NATIVE_INPUT_TOO_LARGE');
    assert.equal(JSON.stringify(capture).includes('private'),false);
    const [reply]=await replies;
    if(mode.startsWith('mcp'))assert.deepEqual((reply.params as {result:unknown}).result,{action:'decline'});
    else assert.equal((reply.params as {error:{code:number}}).error.code,-32601);
    await new Promise(resolveWait=>setTimeout(resolveWait,10));
    assert.equal(closed(events)[0]?.reason,'unsupported');
  });
}

test('no observer and pinned 0.154 cannot accept native input',async t=>{
  const noObserver=await opened('no-observer','codex-cli 0.164.0-alpha.11.1',false);
  t.after(()=>noObserver.adapter.close());
  const noReply=nativeReply(noObserver.adapter);
  await noObserver.adapter.inspect(noObserver.binding);
  assert.equal(((await noReply)[0]!.params as {error:{code:number}}).error.code,-32601);
  const legacy=await opened('legacy','codex-cli 0.154.0');t.after(()=>legacy.adapter.close());
  const legacyReply=nativeReply(legacy.adapter);
  const [capture]=await trigger(legacy.adapter,legacy.binding,legacy.events);
  assert.equal(capture.supported,false);
  assert.equal(((await legacyReply)[0]!.params as {error:{code:number}}).error.code,-32601);
});

test('disconnect invalidates handle and a new connection cannot answer it',async t=>{
  const first=await opened('disconnect');t.after(()=>first.adapter.close());
  const [capture]=await trigger(first.adapter,first.binding,first.events);
  const stopped=pending<void>(resolveDone=>first.adapter.onDisconnect(()=>resolveDone()));
  await stopped;
  assert.equal(closed(first.events)[0]?.reason,'disconnected');
  assert.equal(first.adapter.nativeInputConnectionId(),null);
  const oldProcess=(first.adapter as unknown as {ownedProcess:import('node:child_process').ChildProcess}).ownedProcess;
  if(oldProcess.exitCode===null&&oldProcess.signalCode===null)await once(oldProcess,'exit');
  await first.adapter.open();
  assert.notEqual(first.adapter.nativeInputConnectionId(),capture.connectionId);
  await assert.rejects(()=>first.adapter.respondToInput(capture.id,capture.connectionId,{name:['late']}),RuntimeProtocolError);
  const next=(await trigger(first.adapter,first.binding,first.events,2)).at(-1)!;
  assert.notEqual(next.connectionId,capture.connectionId);
});

test('failed response write is attempted once and cannot replay',async t=>{
  const {adapter,binding,events}=await opened('blocking');t.after(()=>adapter.close());
  const [capture]=await trigger(adapter,binding,events);
  const unsafe=adapter as unknown as {send:(value:unknown)=>void};
  const original=unsafe.send.bind(adapter);
  unsafe.send=()=>{throw new Error('fixture write failed');};
  await assert.rejects(()=>adapter.respondToInput(capture.id,capture.connectionId,{name:['Alice']}),
    error=>error instanceof RuntimeUnknownError&&error.method==='item/tool/requestUserInput');
  unsafe.send=original;
  assert.equal(adapter.hasPendingInput(capture.id,capture.connectionId),false);
  await assert.rejects(()=>adapter.respondToInput(capture.id,capture.connectionId,{name:['again']}),RuntimeProtocolError);
});

test('invalid answer shapes leave request pending for a valid explicit answer',async t=>{
  const {adapter,binding,events}=await opened('options');t.after(()=>adapter.close());
  const [capture]=await trigger(adapter,binding,events);
  await assert.rejects(()=>adapter.respondToInput(capture.id,capture.connectionId,{wrong:['x']}),RuntimeProtocolError);
  await assert.rejects(()=>adapter.respondToInput(capture.id,capture.connectionId,{choice:[]}),RuntimeProtocolError);
  assert.equal(adapter.hasPendingInput(capture.id,capture.connectionId),true);
  const replies=nativeReply(adapter);
  await adapter.respondToInput(capture.id,capture.connectionId,{choice:['Beta']});
  await replies;
});

test('input observer chooses pinned experimental schema during fake version probe',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'evoloop-native-input-probe-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const executable=join(directory,'fake-codex');
  const argsFile=join(directory,'args');
  await writeFile(executable,`#!/bin/sh\nif [ "$1" = "--version" ]; then printf '%s\\n' 'codex-cli 0.164.0-alpha.11.1'; exit 0; fi\nprintf '%s\\n' "$@" > '${argsFile}'\nwhile [ "$#" -gt 0 ]; do if [ "$1" = "--out" ]; then shift; printf '{}' > "$1/codex_app_server_protocol.v2.schemas.json"; exit 0; fi; shift; done\nexit 1\n`,{mode:0o700});
  const adapter=new CodexAppServerAdapter({executable,expectedVersion:'codex-cli 0.164.0-alpha.11.1',requestTimeoutMs:500});
  adapter.onNativeInput(()=>undefined);
  await assert.rejects(()=>adapter.open(),/schema changed/);
  assert.match(await readFile(argsFile,'utf8'),/--experimental/);
  assert.equal(adapter.hasProcessHandle(),false);
});
