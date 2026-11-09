import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import test from 'node:test';
import type {RuntimeBinding,RuntimeSessionSpec} from '@evoloop/contracts/runtime';
import {CodexAppServerAdapter,RuntimeProtocolError,RuntimeServerError,RuntimeUnknownError} from '../src/index.js';

const fixture=resolve(import.meta.dirname,'direct-input-fixture.mjs');
const spec:RuntimeSessionSpec={actorId:'actor',sessionId:'session-1',roleId:'role-1',projectId:'project-1',
  cwd:'/tmp/evoloop-fixture',authorizationScope:'task:109',model:'gpt-6-sol',
  sandbox:'danger-full-access',approvalPolicy:'never'};
async function open(mode:string,timeout=250){
  const adapter=new CodexAppServerAdapter({executable:process.execPath,spawnArgs:[fixture,mode],
    expectedVersion:'codex-cli 0.166.0-alpha.6',requestTimeoutMs:timeout,initializationTimeoutMs:5000});
  await adapter.open();
  const binding=await adapter.create(spec);
  return {adapter,binding};
}

test('idle direct input starts once on the owned full-profile Thread and maps native events',async t=>{
  const {adapter,binding}=await open('start');t.after(()=>adapter.close());
  const events:Array<{method:string;sessionId:string;turnId?:string}>=[];
  const delivered=new Promise<void>(resolveEvent=>adapter.onEvent(event=>{
    events.push({method:event.method,sessionId:event.sessionId,turnId:event.turnId});resolveEvent();
  }));
  const turn=await adapter.startOwnedIdleTurn(binding,'new input','start-id');
  await delivered;
  assert.deepEqual({id:turn.id,status:turn.status},{id:'turn-1',status:'inProgress'});
  await assert.rejects(()=>adapter.startOwnedIdleTurn(binding,'new input','start-id'),RuntimeProtocolError);
  assert.deepEqual(events,[{method:'turn/started',sessionId:'session-1',turnId:'turn-1'}]);
});

test('steer sends the exact alpha.6 shape and accepts only the expected Turn acknowledgement',async t=>{
  const {adapter,binding}=await open('normal');t.after(()=>adapter.close());
  const events:Array<{method:string;projectId:string;sessionId:string;turnId?:string}>=[];
  const delivered=new Promise<void>(resolveEvent=>adapter.onEvent(event=>{
    events.push({method:event.method,projectId:event.projectId,
      sessionId:event.sessionId,turnId:event.turnId});resolveEvent();
  }));
  assert.equal(adapter.capabilities().delivery.midTurnInput,true,'the declaration matches the steer it performs');
  assert.deepEqual(await adapter.steerTurn(binding,'turn-1','follow up','steer-id'),{turnId:'turn-1',itemId:null});
  await delivered;
  await assert.rejects(()=>adapter.steerTurn(binding,'turn-1','follow up','steer-id'),RuntimeProtocolError);
  assert.deepEqual(events,[{method:'item/started',projectId:'project-1',sessionId:'session-1',turnId:'turn-1'}]);
});

for(const mode of ['idle','wrong-turn','settled','wrong-model','foreign-read'] as const)
  test(`steer rejects ${mode} before any native write`,async t=>{
    const {adapter,binding}=await open(mode);t.after(()=>adapter.close());
    await assert.rejects(()=>adapter.steerTurn(binding,'turn-1','follow up','steer-id'),error=>
      error instanceof RuntimeProtocolError&&!(error instanceof RuntimeServerError));
    await assert.rejects(()=>adapter.steerTurn({...binding,nativeThreadId:'foreign'},'turn-1','follow up','steer-id'),error=>
      error instanceof RuntimeProtocolError&&!(error instanceof RuntimeServerError));
  });

for(const [mode,method,invoke] of [
  ['steer-lost','turn/steer',(a:CodexAppServerAdapter,b:RuntimeBinding)=>a.steerTurn(b,'turn-1','follow up','steer-id')],
  ['steer-bad-ack','turn/steer',(a:CodexAppServerAdapter,b:RuntimeBinding)=>a.steerTurn(b,'turn-1','follow up','steer-id')],
  ['steer-missing-result','turn/steer',(a:CodexAppServerAdapter,b:RuntimeBinding)=>a.steerTurn(b,'turn-1','follow up','steer-id')],
  ['start-lost','turn/start',(a:CodexAppServerAdapter,b:RuntimeBinding)=>a.startOwnedIdleTurn(b,'new input','start-id')],
  ['start-bad-ack','turn/start',(a:CodexAppServerAdapter,b:RuntimeBinding)=>a.startOwnedIdleTurn(b,'new input','start-id')],
  ['start-missing-result','turn/start',(a:CodexAppServerAdapter,b:RuntimeBinding)=>a.startOwnedIdleTurn(b,'new input','start-id')],
] as const)test(`${mode} is unknown and its client ID cannot be replayed`,async t=>{
  const {adapter,binding}=await open(mode,80);t.after(()=>adapter.close());
  await assert.rejects(()=>invoke(adapter,binding),error=>error instanceof RuntimeUnknownError&&error.method===method);
  await assert.rejects(()=>invoke(adapter,binding),RuntimeProtocolError);
});

test('explicit native steer rejection retains category and hides private text',async t=>{
  const {adapter,binding}=await open('steer-reject');t.after(()=>adapter.close());
  await assert.rejects(()=>adapter.steerTurn(binding,'turn-1','follow up','steer-id'),error=>
    error instanceof RuntimeServerError&&error.category==='invalid_params'&&!error.message.includes('private'));
});
