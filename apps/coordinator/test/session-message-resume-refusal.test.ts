import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import type { RuntimeSessionRecord } from '@evoloop/contracts';
import type { SessionMessageRecord } from '@evoloop/contracts/session-messages';
import type { SessionMessageService } from '@evoloop/core/session-messages';
import { RuntimeServerError } from '@evoloop/adapter-codex-app-server';
import { SessionMessagePump, type ResumeRefusal, type ResumeRemedy } from '../src/session-messages/pump.ts';

// Defect 548712ac: Codex refused `thread/resume` (-32600) for a Thread it still had loaded. The method comes before turn/start, so nothing was sent.
const projectId=randomUUID();
const session=(id:string):RuntimeSessionRecord=>({projectId,id,roleId:'role',cwd:'/tmp/resume-refusal',authorizationScope:'project',
  model:null,sandbox:'danger-full-access',approvalPolicy:'never',state:'ready',version:1,nativeThreadId:`thread-${id}`,nativeSessionId:`native-${id}`,
  operationId:randomUUID(),actorId:'receiver',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()});
const queued=(sessionId:string):SessionMessageRecord=>({projectId,id:randomUUID(),operationId:randomUUID(),target:{kind:'owned',sessionId},senderActorId:'sender',
  content:'Hello',context:null,replyToMessageId:null,state:'queued',version:2,blockedReason:null,readReceipt:null,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()});
const PRIVATE_TEXT='cannot resume running thread 01a1befd with stale path: requested /Users/someone/private/rollout.jsonl, active /Users/someone/other.jsonl';

function harness(options:{refusals:number;policyDelays?:number[];remedy?:ResumeRemedy|'absent';withPolicy?:boolean}){
  const target=randomUUID(),m=queued(target);
  const clock={now:1_000_000};
  const log={dispatches:0,starts:0,failed:[] as string[],unknown:0,blocked:[] as string[],operations:[] as string[],records:[] as ResumeRefusal[],remedies:0,bound:0};
  const processRecord={operationId:randomUUID(),nativeTurnId:null as string|null,state:'dispatching',readOnlyPolicyFingerprint:'a'.repeat(64),roleContext:null};
  let dispatched=false;
  const service={pending:async()=>m.state==='failed'?[]:[m],session:async()=>session(target),processing:async()=>dispatched?processRecord:null,preflightDispatch:async()=>{},
    beginDispatch:async()=>{log.dispatches++;dispatched=true;m.state='processing';return processRecord;},
    bindTurn:async()=>{log.bound++;processRecord.state='running';processRecord.nativeTurnId='turn-after-retry';},
    noteBlocked:async(_p:string,_id:string,reason:string|null)=>{log.blocked.push(reason??'');m.blockedReason=reason;},
    markUnknown:async()=>{log.unknown++;},
    failBeforeStart:async(_p:string,_id:string,reason:string)=>{log.failed.push(reason);m.state='failed';}} as unknown as SessionMessageService;
  const runtime={isReady:()=>true,registerBinding:async()=>{},qualifyConversationThread:async()=>({available:true,reason:'ready',fingerprint:'a'.repeat(64)}),
    startConversationTurn:async(_binding:unknown,_input:string,operationId:string)=>{
      log.starts++;log.operations.push(operationId);
      if(log.starts<=options.refusals)throw new RuntimeServerError('thread/resume',7,-32600,PRIVATE_TEXT,`thread-${target}`);
      return{id:'turn-after-retry',status:'inProgress',completedAtUtc:null};},
    listTurns:async()=>({data:[],nextCursor:null}),listItems:async()=>({data:[],nextCursor:null})};
  const remedy=options.remedy??'replaced';
  const pump=new SessionMessagePump({service,runtime:()=>runtime,projects:async()=>[projectId],canStart:async()=>true,canWrite:()=>true,pollIntervalMs:1000,
    now:()=>clock.now,onError:error=>{throw error;},
    ...(options.withPolicy===false?{}:{resumeRefusal:{delaysMs:options.policyDelays??[5_000,30_000,120_000],record:refusal=>{log.records.push(refusal);},
      ...(remedy==='absent'?{}:{remedy:async()=>{log.remedies++;return remedy;}})}})});
  return{pump,m,log,clock,processRecord,target};
}

test('a refused resume keeps the message and its operation, does not fail it or close the gate, and the retry that works settles it',async()=>{
  const h=harness({refusals:1});
  await h.pump.tick();
  assert.equal(h.log.starts,1);assert.deepEqual(h.log.failed,[],'the message did not fail');assert.equal(h.log.unknown,0);
  assert.equal(h.m.state,'processing');assert.equal(h.processRecord.state,'dispatching','nothing was sent, so the intent stays reserved');
  assert.match(h.log.blocked.at(-1)!,/^RESUME_REJECTED_RETRY: thread\/resume refused \(server_rejected, code -32600\) before any Turn start; nothing was sent; attempt 1 of 4; retry in 5 s/);
  assert.doesNotMatch(h.log.blocked.join('\n'),/stale path|\/Users\//,'the public reason carries the category and code, never the native text');
  // Before its backoff has passed the message is left alone.
  h.clock.now+=4_000;await h.pump.tick();assert.equal(h.log.starts,1,'no retry on every tick');
  h.clock.now+=2_000;await h.pump.tick();
  assert.equal(h.log.starts,2);assert.equal(h.log.dispatches,1,'the same reserved dispatch, not a new one');
  assert.equal(new Set(h.log.operations).size,1,'the same operation ID every time: nothing is duplicated');
  assert.equal(h.log.bound,1);assert.equal(h.processRecord.nativeTurnId,'turn-after-retry');assert.deepEqual(h.log.failed,[]);
  assert.equal(h.log.remedies,0,'a refusal that clears on the first retry needs no remedy');
});

test('the Codex child is replaced once, before the second retry; the backoff grows; a cap ends it and only then does the message fail',async()=>{
  const h=harness({refusals:99});
  const waits:number[]=[];
  for(let round=0;round<8&&h.m.state!=='failed';round++){
    await h.pump.tick();
    const reason=h.log.blocked.at(-1)??'';
    const wait=/retry in (\d+) s/.exec(reason)?.[1];
    if(wait&&h.m.blockedReason?.startsWith('RESUME_REJECTED_RETRY')){waits.push(Number(wait));h.clock.now+=Number(wait)*1000+1;}
  }
  assert.deepEqual(waits,[5,30,120],'5 s, 30 s, 2 min');
  assert.equal(h.log.starts,4,'one try and three retries, then it stops');
  assert.equal(h.log.remedies,1,'the child is replaced once per message, not on every refusal');
  assert.equal(h.log.failed.length,1);
  assert.match(h.log.failed[0]!,/^Native pre-turn rejection after 4 attempts: thread\/resume: native runtime rejected request \(server_rejected, code -32600\)$/,'the attempts are in the reason, not the native text');
  assert.equal(h.m.state,'failed');
  assert.match(h.log.blocked.find(reason=>/attempt 2 of 4/.test(reason))!,/Codex child replaced/);
  const before=h.log.starts;await h.pump.tick();assert.equal(h.log.starts,before,'a failed message is not retried again');
  assert.equal(h.log.unknown,0,'it is a refusal before any start, never an unknown outcome');
});

test('every refusal is recorded privately with the native method, code and original text, and none of that reaches the public reason',async()=>{
  const h=harness({refusals:2,remedy:'skipped'});
  for(let round=0;round<3;round++){await h.pump.tick();h.clock.now+=200_000;}
  assert.equal(h.log.records.length,2);
  const first=h.log.records[0]!;
  assert.deepEqual([first.method,first.code,first.category,first.attempt,first.maxAttempts],['thread/resume',-32600,'server_rejected',1,4]);
  assert.equal(first.nativeMessage,PRIVATE_TEXT,'the private record has the original text');
  assert.match(h.log.blocked.find(reason=>/attempt 2 of 4/.test(reason))!,/not replaced \(other work is running on it\)/);
  assert.doesNotMatch(JSON.stringify([h.log.blocked,h.log.failed]),/stale path|Users/);
  assert.equal(h.log.bound,1,'and the message went through on the third try');
});

test('without the policy, or for a message whose resume is a writer conflict or another method, nothing changes',async()=>{
  const plain=harness({refusals:1,withPolicy:false});
  await plain.pump.tick();
  assert.equal(plain.log.failed.length,1,'no policy: a refusal fails the message at once, as before');
  assert.match(plain.log.failed[0]!,/^Native pre-turn rejection: thread\/resume/);
  // A refusal of another method, or a different code, is not a resume refusal and keeps the old behaviour.
  for(const [method,code] of [['turn/start',-32600],['thread/resume',-32602]] as const){
    const target=randomUUID(),m=queued(target);let failed=0,blocked=0;
    const service={pending:async()=>[m],session:async()=>session(target),processing:async()=>null,preflightDispatch:async()=>{},beginDispatch:async()=>({operationId:randomUUID()}),
      failBeforeStart:async()=>{failed++;},noteBlocked:async()=>{blocked++;},markUnknown:async()=>{}} as unknown as SessionMessageService;
    const runtime={isReady:()=>true,registerBinding:async()=>{},qualifyConversationThread:async()=>({available:true,reason:'ok',fingerprint:'a'.repeat(64)}),
      startConversationTurn:async()=>{throw new RuntimeServerError(method,7,code,'rejected');},listTurns:async()=>({data:[],nextCursor:null}),listItems:async()=>({data:[],nextCursor:null})};
    const pump=new SessionMessagePump({service,runtime:()=>runtime,projects:async()=>[projectId],canStart:async()=>true,canWrite:()=>true,pollIntervalMs:1000,
      onError:error=>{throw error;},resumeRefusal:{delaysMs:[1]}});
    await pump.tick();
    assert.deepEqual([failed,blocked],[1,0],`${method} ${code}`);
  }
});

test('the native text is private on the error object: not in its message, its JSON or its enumerable fields',()=>{
  const error=new RuntimeServerError('thread/resume',3,-32600,PRIVATE_TEXT,'thread-x',{detail:'private data'});
  assert.doesNotMatch(error.message,/stale path|Users/);
  assert.doesNotMatch(JSON.stringify(error),/stale path|Users|private data/);
  assert.doesNotMatch(JSON.stringify(Object.entries(error)),/stale path|Users|private data/);
  assert.equal(error.privateNative.message,PRIVATE_TEXT);
  assert.deepEqual(error.privateNative.data,{detail:'private data'});
  assert.equal(error.category,'server_rejected');
});
