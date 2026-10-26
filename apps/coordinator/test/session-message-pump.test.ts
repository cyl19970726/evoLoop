import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import type { RuntimeSessionRecord } from '@evoloop/contracts';
import type { SessionMessageRecord } from '@evoloop/contracts/session-messages';
import type { SessionMessageService } from '@evoloop/core/session-messages';
import { DomainError } from '@evoloop/contracts/ports';
import { RuntimeProtocolError } from '@evoloop/adapter-codex-app-server';
import { SessionMessagePump } from '../src/session-messages/pump.ts';

const projectId=randomUUID();
const session=(id:string):RuntimeSessionRecord=>({projectId,id,roleId:'role',cwd:'/tmp/message-pump',authorizationScope:'project',
  model:null,sandbox:'workspace-write',approvalPolicy:'on-request',state:'ready',version:1,
  nativeThreadId:`thread-${id}`,nativeSessionId:`native-${id}`,operationId:randomUUID(),actorId:'receiver',
  createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()});
const message=(id:string,sessionId:string,state:'unknown'|'processing'|'queued'):SessionMessageRecord=>({projectId,id,operationId:randomUUID(),
  target:{kind:'owned',sessionId},senderActorId:'sender',content:'Hello',context:null,replyToMessageId:null,state,
  version:2,blockedReason:null,readReceipt:null,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()});

test('bounded rotating pending pages eventually visit more than thirty unresolved Sessions',async()=>{
  const messages=Array.from({length:80},()=>message(randomUUID(),randomUUID(),'unknown'));
  const seen:string[]=[],offsets:number[]=[];
  const service={pending:async(_p:string,_limit:number,offset:number)=>{offsets.push(offset);return messages.slice(offset,offset+30);},
    session:async(_p:string,id:string)=>session(id),processing:async(_p:string,id:string)=>({operationId:id,nativeTurnId:null,state:'unknown'}),
    markUnknown:async()=>{}} as unknown as SessionMessageService;
  const runtime={isReady:()=>true,registerBinding:async()=>{},markReadOnlyThread:()=>{},
    listTurns:async(binding:{sessionId:string})=>{seen.push(binding.sessionId);return{data:[],nextCursor:null};},
    listItems:async()=>({data:[],nextCursor:null})};
  const failures:unknown[]=[];
  const pump=new SessionMessagePump({service,runtime:()=>runtime,projects:async()=>[projectId],canStart:async()=>true,
    canWrite:()=>true,pollIntervalMs:1000,onError:e=>failures.push(e)});
  await pump.tick();await pump.tick();await pump.tick();
  assert.deepEqual(offsets,[0,30,60]);assert.equal(new Set(seen).size,80);assert.deepEqual(failures,[]);
});

test('known bound Turn settles from one native page without rereading long history',async()=>{
  const id=randomUUID(),target=randomUUID(),m=message(id,target,'processing');
  let reads=0,settled=0;
  const service={pending:async()=>[m],session:async()=>session(target),
    processing:async()=>({operationId:randomUUID(),nativeTurnId:'turn-exact',state:'running'}),
    settle:async()=>{settled++;}} as unknown as SessionMessageService;
  const runtime={isReady:()=>true,registerBinding:async()=>{},markReadOnlyThread:()=>{},
    listTurns:async()=>{reads++;return{data:[{id:'turn-exact',status:'completed',completedAtUtc:new Date().toISOString()}],nextCursor:'older'};},
    listItems:async()=>({data:[{id:'answer',type:'agentMessage',phase:'final_answer',text:'Done'}],nextCursor:null})};
  const pump=new SessionMessagePump({service,runtime:()=>runtime,projects:async()=>[projectId],canStart:async()=>true,
    canWrite:()=>true,pollIntervalMs:1000,onError:e=>{throw e;}});
  await pump.tick();assert.equal(reads,1);assert.equal(settled,1);
});

test('project scan rotates when one project fills the per-cycle budget',async()=>{
  const otherProject=randomUUID(),seen:string[]=[];
  const a=Array.from({length:30},()=>message(randomUUID(),randomUUID(),'unknown'));
  const b=[{...message(randomUUID(),randomUUID(),'unknown'),projectId:otherProject}];
  const service={pending:async(project:string)=>{seen.push(project);return project===projectId?a:b;},
    session:async()=>({...session(randomUUID()),state:'closed'})} as unknown as SessionMessageService;
  const runtime={isReady:()=>true,registerBinding:async()=>{},listTurns:async()=>({data:[],nextCursor:null}),
    listItems:async()=>({data:[],nextCursor:null})};
  const pump=new SessionMessagePump({service,runtime:()=>runtime,projects:async()=>[projectId,otherProject],
    canStart:async()=>true,canWrite:()=>true,pollIntervalMs:1000,onError:e=>{throw e;}});
  await pump.tick();await pump.tick();
  assert.deepEqual(seen.slice(0,2),[projectId,otherProject]);
});

test('an explicit native pre-turn rejection is terminal rather than an uncertain start',async()=>{
  const target=randomUUID(),m=message(randomUUID(),target,'queued');
  let failed=0,unknown=0;
  const service={pending:async()=>[m],session:async()=>session(target),processing:async()=>null,
    preflightDispatch:async()=>{},
    beginDispatch:async()=>({operationId:randomUUID()}),failBeforeStart:async()=>{failed++;},
    markUnknown:async()=>{unknown++;}} as unknown as SessionMessageService;
  const runtime={isReady:()=>true,registerBinding:async()=>{},qualifyReadOnlyThread:async()=>({available:true,
    reason:'safe',fingerprint:'a'.repeat(64)}),startReadOnlyTurn:async()=>{throw new RuntimeProtocolError('native rejected policy');},
    listTurns:async()=>({data:[],nextCursor:null}),listItems:async()=>({data:[],nextCursor:null})};
  const pump=new SessionMessagePump({service,runtime:()=>runtime,projects:async()=>[projectId],canStart:async()=>true,
    canWrite:()=>true,pollIntervalMs:1000,onError:e=>{throw e;}});
  await pump.tick();assert.equal(failed,1);assert.equal(unknown,0);
});

test('admission denial stops scheduling and native qualification before any processing',async()=>{
  for(const reason of ['MESSAGE_GRANT_MISSING','MESSAGE_BUDGET_EXHAUSTED']){
    const target=randomUUID(),m=message(randomUUID(),target,'queued');
    let scheduled=0,registered=0,qualified=0,dispatched=0;let blocked='';
    const service={pending:async()=>[m],session:async()=>session(target),processing:async()=>null,
      preflightDispatch:async()=>{throw new DomainError(reason,'ordinary admission denied');},
      noteBlocked:async(_project:string,_id:string,text:string)=>{blocked=text;},
      beginDispatch:async()=>{dispatched++;throw new Error('must not dispatch');}} as unknown as SessionMessageService;
    const runtime={isReady:()=>true,registerBinding:async()=>{registered++;},
      qualifyReadOnlyThread:async()=>{qualified++;return{available:true,reason:'safe',fingerprint:'a'.repeat(64)};},
      startReadOnlyTurn:async()=>{throw new Error('must not start');},
      listTurns:async()=>({data:[],nextCursor:null}),listItems:async()=>({data:[],nextCursor:null})};
    const pump=new SessionMessagePump({service,runtime:()=>runtime,projects:async()=>[projectId],
      canStart:async()=>{scheduled++;return true;},canWrite:()=>true,pollIntervalMs:1000,onError:e=>{throw e;}});
    await pump.tick();
    assert.equal(scheduled,0,reason);assert.equal(registered,0,reason);
    assert.equal(qualified,0,reason);assert.equal(dispatched,0,reason);
    assert.equal(blocked,'ordinary admission denied');
  }
});
