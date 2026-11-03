import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import type { RuntimeSessionRecord } from '@evoloop/contracts';
import type { NativeObservationRecord } from '@evoloop/contracts/native-observation';
import type { SessionMessageRecord } from '@evoloop/contracts/session-messages';
import type { SessionMessageService } from '@evoloop/core/session-messages';
import { DomainError } from '@evoloop/contracts/ports';
import { RuntimeProtocolError } from '@evoloop/adapter-codex-app-server';
import { SessionMessagePump } from '../src/session-messages/pump.ts';

const projectId=randomUUID();
const session=(id:string):RuntimeSessionRecord=>({projectId,id,roleId:'role',cwd:'/tmp/message-pump',authorizationScope:'project',
  model:null,sandbox:'danger-full-access',approvalPolicy:'never',state:'ready',version:1,
  nativeThreadId:`thread-${id}`,nativeSessionId:`native-${id}`,operationId:randomUUID(),actorId:'receiver',
  createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()});
const message=(id:string,sessionId:string,state:'unknown'|'processing'|'queued'):SessionMessageRecord=>({projectId,id,operationId:randomUUID(),
  target:{kind:'owned',sessionId},senderActorId:'sender',content:'Hello',context:null,replyToMessageId:null,state,
  version:2,blockedReason:null,readReceipt:null,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()});
type ObservedTurn=Pick<NativeObservationRecord,'threadId'|'freshness'|'status'|'currentTurn'|'observedAt'>;
const observedTurn=(sessionId:string):ObservedTurn=>({threadId:`thread-${sessionId}`,freshness:'live',status:'active',
  observedAt:'2026-11-01T13:05:50.000Z',currentTurn:{id:'turn-exact',status:'inProgress',source:null,startedAt:1,
    terminalObservedAt:null}});

test('bounded rotating pending pages eventually visit over ten thousand unresolved Sessions',async()=>{
  const messages=Array.from({length:10080},()=>message(randomUUID(),randomUUID(),'unknown'));
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
  for(let i=0;i<messages.length/30;i++)await pump.tick();
  assert.deepEqual(offsets.slice(0,3),[0,30,60]);assert.equal(offsets.at(-1),10050);
  assert.equal(new Set(seen).size,messages.length);assert.deepEqual(failures,[]);
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
  const runtime={isReady:()=>true,registerBinding:async()=>{},qualifyConversationThread:async()=>({available:true,
    reason:'safe',fingerprint:'a'.repeat(64)}),startConversationTurn:async()=>{throw new RuntimeProtocolError('native rejected policy');},
    listTurns:async()=>({data:[],nextCursor:null}),listItems:async()=>({data:[],nextCursor:null})};
  const pump=new SessionMessagePump({service,runtime:()=>runtime,projects:async()=>[projectId],canStart:async()=>true,
    canWrite:()=>true,pollIntervalMs:1000,onError:e=>{throw e;}});
  await pump.tick();assert.equal(failed,1);assert.equal(unknown,0);
});

test('an exact live bound Turn prevents a transient history miss and settles when history appears',async()=>{
  const target=randomUUID(),m=message(randomUUID(),target,'processing');
  let unknown=0,settled=0,history:[{id:string;status:string;completedAtUtc:string}]|[]=[];
  const service={
    pending:async()=>[m],session:async()=>session(target),
    processing:async()=>({operationId:randomUUID(),nativeTurnId:'turn-exact',state:'running'}),
    markUnknown:async()=>{unknown++;},
    settle:async(_project:string,_message:string,_turn:unknown,response:string)=>{settled++;assert.equal(response,'Done');}
  } as unknown as SessionMessageService;
  const runtime={isReady:()=>true,registerBinding:async()=>{},
    inspect:async()=>({thread:{status:{type:'active'}}}),
    listTurns:async()=>({data:history,nextCursor:null}),
    listItems:async()=>({data:[{id:'answer',type:'agentMessage',phase:'final_answer',text:'Done'}],nextCursor:null})};
  const pump=new SessionMessagePump({service,runtime:()=>runtime,projects:async()=>[projectId],canStart:async()=>true,
    canWrite:()=>true,pollIntervalMs:1000,onError:e=>{throw e;},
    nativeTurn:()=>observedTurn(target),now:()=>Date.parse('2030-01-01T00:00:00.000Z')});
  await pump.tick();
  assert.deepEqual([unknown,settled],[0,0]);
  history=[{id:'turn-exact',status:'completed',completedAtUtc:new Date().toISOString()}];
  await pump.tick();
  assert.deepEqual([unknown,settled],[0,1]);
});

for(const scenario of [
  {name:'no current observation',observed:null},
  {name:'stale observation',observed:'stale'},
  {name:'different Turn',observed:{threadId:'same',freshness:'live' as const}},
  {name:'same Turn with unknown status',observed:{threadId:'same',freshness:'live' as const}}
]){
  test(`${scenario.name} still records unknown when the bound Turn is absent`,async()=>{
    const target=randomUUID(),m=message(randomUUID(),target,'processing');
    let unknown=0;
    const service={
      pending:async()=>[m],session:async()=>session(target),
      processing:async()=>({operationId:randomUUID(),nativeTurnId:'turn-exact',state:'running'}),
      markUnknown:async()=>{unknown++;}
    } as unknown as SessionMessageService;
    const runtime={isReady:()=>true,registerBinding:async()=>{},inspect:async()=>({thread:{status:{type:'active'}}}),
      listTurns:async()=>({data:[],nextCursor:null}),listItems:async()=>({data:[],nextCursor:null})};
    let observed:ObservedTurn|null=scenario.observed==='stale'?{...observedTurn(target),freshness:'stale'}:
      scenario.observed===null?null:observedTurn(target);
    if(scenario.name==='different Turn')observed={...observedTurn(target),currentTurn:{...observedTurn(target).currentTurn!,id:'turn-other'}};
    if(scenario.name==='same Turn with unknown status')observed={...observedTurn(target),currentTurn:{...observedTurn(target).currentTurn!,status:'unknown'}};
    const pump=new SessionMessagePump({service,runtime:()=>runtime,projects:async()=>[projectId],canStart:async()=>true,
      canWrite:()=>true,pollIntervalMs:1000,onError:e=>{throw e;},nativeTurn:()=>observed});
    await pump.tick();
    assert.equal(unknown,1,scenario.name);
  });
}

test('an unbound dispatching message cannot use another live Turn as proof',async()=>{
  const target=randomUUID(),m=message(randomUUID(),target,'processing');
  let unknown=0;
  const service={
    pending:async()=>[m],session:async()=>session(target),
    processing:async()=>({operationId:randomUUID(),nativeTurnId:null,state:'dispatching'}),
    markUnknown:async()=>{unknown++;}
  } as unknown as SessionMessageService;
  const runtime={isReady:()=>true,registerBinding:async()=>{},
    listTurns:async()=>({data:[],nextCursor:null}),listItems:async()=>({data:[],nextCursor:null})};
  const pump=new SessionMessagePump({service,runtime:()=>runtime,projects:async()=>[projectId],canStart:async()=>true,
    canWrite:()=>true,pollIntervalMs:1000,onError:e=>{throw e;},
    nativeTurn:()=>({threadId:`thread-${target}`,freshness:'live',
      currentTurn:{id:'turn-other',status:'inProgress',source:null,startedAt:1}})});
  await pump.tick();
  assert.equal(unknown,1);
});

test('a thread systemError or idle state stops the live-history deferral',async()=>{
  for(const threadStatus of ['systemError','idle']){
    const target=randomUUID(),m=message(randomUUID(),target,'processing');
    let unknown=0;
    const service={pending:async()=>[m],session:async()=>session(target),
      processing:async()=>({operationId:randomUUID(),nativeTurnId:'turn-exact',state:'running'}),
      markUnknown:async()=>{unknown++;}} as unknown as SessionMessageService;
    const runtime={isReady:()=>true,registerBinding:async()=>{},
      inspect:async()=>({thread:{status:{type:threadStatus}}}),
      listTurns:async()=>({data:[],nextCursor:null}),listItems:async()=>({data:[],nextCursor:null})};
    const pump=new SessionMessagePump({service,runtime:()=>runtime,projects:async()=>[projectId],canStart:async()=>true,
      canWrite:()=>true,pollIntervalMs:1000,onError:e=>{throw e;},nativeTurn:()=>observedTurn(target)});
    await pump.tick();
    assert.equal(unknown,1,threadStatus);
  }
});

test('terminal observations defer only for a bounded history visibility window',async()=>{
  for(const status of ['completed','failed','interrupted'] as const){
    const target=randomUUID(),m=message(randomUUID(),target,'processing');
    const terminalAt=Date.parse('2026-11-01T13:05:50.000Z');
    let unknown=0,now=terminalAt+10_000,projectionObservedAt=terminalAt+10_000;
    const service={pending:async()=>[m],session:async()=>session(target),
      processing:async()=>({operationId:randomUUID(),nativeTurnId:'turn-exact',state:'running'}),
      markUnknown:async()=>{unknown++;}} as unknown as SessionMessageService;
    const runtime={isReady:()=>true,registerBinding:async()=>{},
      inspect:async()=>({thread:{status:{type:status==='completed'?'idle':'active'}}}),
      listTurns:async()=>({data:[],nextCursor:null}),listItems:async()=>({data:[],nextCursor:null})};
    const evidence={...observedTurn(target),currentTurn:{...observedTurn(target).currentTurn!,status,
      terminalObservedAt:new Date(terminalAt).toISOString()}};
    const pump=new SessionMessagePump({service,runtime:()=>runtime,projects:async()=>[projectId],canStart:async()=>true,
      canWrite:()=>true,pollIntervalMs:1000,onError:e=>{throw e;},
      nativeTurn:()=>({...evidence,observedAt:new Date(projectionObservedAt).toISOString()}),now:()=>now});
    await pump.tick();
    assert.equal(unknown,0,status);
    now=terminalAt+60_000;
    projectionObservedAt=terminalAt+60_000;
    await pump.tick();
    assert.equal(unknown,1,status);
  }
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
      qualifyConversationThread:async()=>{qualified++;return{available:true,reason:'safe',fingerprint:'a'.repeat(64)};},
      startConversationTurn:async()=>{throw new Error('must not start');},
      listTurns:async()=>({data:[],nextCursor:null}),listItems:async()=>({data:[],nextCursor:null})};
    const pump=new SessionMessagePump({service,runtime:()=>runtime,projects:async()=>[projectId],
      canStart:async()=>{scheduled++;return true;},canWrite:()=>true,pollIntervalMs:1000,onError:e=>{throw e;}});
    await pump.tick();
    assert.equal(scheduled,0,reason);assert.equal(registered,0,reason);
    assert.equal(qualified,0,reason);assert.equal(dispatched,0,reason);
    assert.equal(blocked,'ordinary admission denied');
  }
});

test('reviewed interrupt settles a terminal original Turn without calling native interrupt',async()=>{
  const target=randomUUID(),m=message(randomUUID(),target,'processing');
  let settled=0,attempted=0,interrupted=0;
  const service={pending:async()=>[m],session:async()=>session(target),
    processing:async()=>({operationId:randomUUID(),nativeTurnId:'turn-exact',state:'running',version:3,
      interruptOperationId:randomUUID(),interruptAttemptedAt:null}),
    settle:async()=>{settled++;},markInterruptAttempted:async()=>{attempted++;return true;}} as unknown as SessionMessageService;
  const runtime={isReady:()=>true,registerBinding:async()=>{},
    listTurns:async()=>({data:[{id:'turn-exact',status:'completed',completedAtUtc:new Date().toISOString()}],nextCursor:null}),
    listItems:async()=>({data:[],nextCursor:null}),interruptTurn:async()=>{interrupted++;}};
  await new SessionMessagePump({service,runtime:()=>runtime,projects:async()=>[projectId],canStart:async()=>true,
    canWrite:()=>true,pollIntervalMs:1000,onError:e=>{throw e;}}).tick();
  assert.deepEqual([settled,attempted,interrupted],[1,0,0]);
});

test('reviewed interrupt marks its one native attempt before call and cannot replay after restart',async()=>{
  const target=randomUUID(),m=message(randomUUID(),target,'processing'),operationId=randomUUID();
  let version=3,attemptedAt:string|null=null,calls=0,unknown=0;
  const service={pending:async()=>[m],session:async()=>session(target),
    processing:async()=>({operationId:randomUUID(),nativeTurnId:'turn-exact',state:'running',version,
      interruptOperationId:operationId,interruptAttemptedAt:attemptedAt}),
    markInterruptAttempted:async(_project:string,_message:string,op:string,expected:number)=>{
      assert.equal(op,operationId);assert.equal(expected,version);attemptedAt=new Date().toISOString();version++;return true;},
    markUnknown:async()=>{unknown++;}} as unknown as SessionMessageService;
  const runtime={isReady:()=>true,registerBinding:async()=>{},
    listTurns:async()=>({data:[{id:'turn-exact',status:'inProgress',completedAtUtc:null}],nextCursor:null}),
    listItems:async()=>({data:[],nextCursor:null}),interruptTurn:async()=>{calls++;throw new Error('ack lost');}};
  const deps={service,runtime:()=>runtime,projects:async()=>[projectId],canStart:async()=>true,
    canWrite:()=>true,pollIntervalMs:1000,onError:(e:unknown)=>{throw e;}};
  await new SessionMessagePump(deps).tick();
  await new SessionMessagePump(deps).tick();
  assert.deepEqual([calls,unknown,version],[1,1,4]);
});

test('a Turn finishing between readback and reviewed interrupt is settled without native interrupt',async()=>{
  const target=randomUUID(),m=message(randomUUID(),target,'processing');
  let reads=0,settled=0,attempted=0,interrupted=0;
  const service={pending:async()=>[m],session:async()=>session(target),
    processing:async()=>({operationId:randomUUID(),nativeTurnId:'turn-exact',state:'running',version:3,
      interruptOperationId:randomUUID(),interruptAttemptedAt:null}),
    settle:async()=>{settled++;},markInterruptAttempted:async()=>{attempted++;return true;}} as unknown as SessionMessageService;
  const runtime={isReady:()=>true,registerBinding:async()=>{},listTurns:async()=>{
      reads++;return{data:[{id:'turn-exact',status:reads===1?'inProgress':'completed',
        completedAtUtc:reads===1?null:new Date().toISOString()}],nextCursor:null};},
    listItems:async()=>({data:[],nextCursor:null}),interruptTurn:async()=>{interrupted++;}};
  await new SessionMessagePump({service,runtime:()=>runtime,projects:async()=>[projectId],canStart:async()=>true,
    canWrite:()=>true,pollIntervalMs:1000,onError:e=>{throw e;}}).tick();
  assert.deepEqual([reads,settled,attempted,interrupted],[2,1,0,0]);
});
