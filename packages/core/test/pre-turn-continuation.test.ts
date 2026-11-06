import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import type { Principal, RuntimeRunRecord, RuntimeSessionRecord } from '@evoloop/contracts';
import type { SessionMessageProcessing, SessionMessageRecord } from '@evoloop/contracts/session-messages';
import type { UnitOfWork } from '@evoloop/contracts/ports';
import { RuntimeWorkflowService } from '../src/runtime/service.ts';
import { SessionMessageService } from '../src/session-messages/index.ts';

const now='2026-11-06T08:00:00.000Z';
const projectId=randomUUID(),threadId=randomUUID(),sessionId=randomUUID();
const principal:Principal={actorId:'reviewer',projectIds:[projectId],permissions:['read','write','review']};
const profileId=randomUUID();
const session={projectId,id:sessionId,nativeThreadId:threadId,nativeSessionId:randomUUID(),state:'ready',cwd:'/tmp',roleId:'role',
  executionProfile:{activationState:'active',revision:{revisionId:profileId}}} as RuntimeSessionRecord;
const gate=(kind:'run'|'message',id:string)=>({version:3,phase:'blocked',causeKind:kind,causeId:id});
const proof=(operationId:string)=>({threadId,operationId,requestId:7,code:-32600 as const,inputHash:'a'.repeat(64)});

test('only an exact recorded pre-turn Run refusal can receive and consume one reviewed continuation',async()=>{
  let run={projectId,id:randomUUID(),sessionId,operationId:randomUUID(),state:'dispatching',version:4,
    nativeTurnId:null,executionProfile:{revisionId:profileId}} as RuntimeRunRecord;
  let currentGate=gate('run',run.id),events:unknown[]=[];
  const tx={getRuntimeRun:async()=>run,getRuntimeSession:async()=>session,
    updateRuntimeRun:async(value:RuntimeRunRecord,version:number)=>{assert.equal(run.version,version);run=value;},
    appendRuntimeEvent:async(value:unknown)=>{events.push(value);},
    recovery:{lockRecoveryGate:async()=>currentGate}};
  const uow={transaction:async(_p:string,fn:(value:typeof tx)=>Promise<unknown>)=>fn(tx)} as unknown as UnitOfWork;
  const service=new RuntimeWorkflowService({uow,clock:{now:()=>now},ids:{next:randomUUID}});
  await service.markRunUnknown(projectId,run.id,'writer conflict',proof(run.operationId));
  assert.equal(run.state,'unknown');assert.equal(run.preTurnProof?.status,'observed');
  await assert.rejects(service.approvePreTurnContinuation(projectId,run.id,principal,{
    operationId:randomUUID(),sessionId,originalOperationId:run.operationId,expectedVersion:4,
    expectedGateVersion:3,evidenceRef:'handoff:1',reason:'writer released'}),/changed/);
  const decision=randomUUID();
  await service.approvePreTurnContinuation(projectId,run.id,principal,{
    operationId:decision,sessionId,originalOperationId:run.operationId,expectedVersion:run.version,
    expectedGateVersion:3,evidenceRef:'handoff:1',reason:'writer released'});
  assert.equal(run.preTurnProof?.status,'approved');
  assert.equal((await service.claimPreTurnContinuation(projectId,run.id))?.preTurnProof?.status,'attempting');
  assert.equal(await service.claimPreTurnContinuation(projectId,run.id),null);
  await service.bindTurn(projectId,run.id,{id:randomUUID(),status:'inProgress',completedAtUtc:null},
    {kind:'startReply',operationId:run.operationId});
  assert.equal(run.state,'running');assert.equal(run.preTurnProof?.status,'consumed');
  assert.ok(events.length>=2);
  currentGate={...currentGate,version:4};
});

test('a lost Run start reply cannot be approved as a pre-turn refusal',async()=>{
  const run={projectId,id:randomUUID(),sessionId,operationId:randomUUID(),state:'unknown',version:2,
    nativeTurnId:null,executionProfile:{revisionId:profileId}} as RuntimeRunRecord;
  const tx={getRuntimeRun:async()=>run,getRuntimeSession:async()=>session,
    recovery:{lockRecoveryGate:async()=>gate('run',run.id)}};
  const service=new RuntimeWorkflowService({uow:{transaction:async(_p:string,fn:(value:typeof tx)=>Promise<unknown>)=>fn(tx)} as unknown as UnitOfWork,
    clock:{now:()=>now},ids:{next:randomUUID}});
  assert.equal(await service.claimPreTurnContinuation(projectId,run.id),null);
  await assert.rejects(service.approvePreTurnContinuation(projectId,run.id,principal,{
    operationId:randomUUID(),sessionId,originalOperationId:run.operationId,expectedVersion:run.version,
    expectedGateVersion:3,evidenceRef:'history:missing',reason:'try again'}),/changed/);
});

test('ordinary message continuation retains its message and processing IDs and rejects a second claim',async()=>{
  let message={projectId,id:randomUUID(),operationId:randomUUID(),target:{kind:'owned',sessionId},
    senderActorId:'sender',state:'processing',version:3} as SessionMessageRecord;
  let processing={projectId,id:randomUUID(),messageId:message.id,sessionId,operationId:randomUUID(),state:'dispatching',
    nativeTurnId:null,version:2,receiverActorId:'receiver',readOnlyPolicyFingerprint:'b'.repeat(64)} as SessionMessageProcessing;
  const store={getSessionMessage:async()=>message,getSessionMessageProcessing:async()=>processing,
    updateSessionMessage:async(value:SessionMessageRecord,version:number)=>{assert.equal(message.version,version);message=value;},
    updateSessionMessageProcessing:async(value:SessionMessageProcessing,version:number)=>{assert.equal(processing.version,version);processing=value;}};
  const tx={getRuntimeSession:async()=>session,sessionMessages:store,
    appendRuntimeEvent:async()=>{},
    recovery:{lockRecoveryGate:async()=>gate('message',message.id)}};
  const service=new SessionMessageService({uow:{transaction:async(_p:string,fn:(value:typeof tx)=>Promise<unknown>)=>fn(tx)} as unknown as UnitOfWork,
    clock:{now:()=>now},ids:{next:randomUUID},grantFor:async()=>({projectId,sessionId,senderActorId:'sender',receiverActorId:'receiver',
      receiverRoleId:'role',cwd:'/tmp',maxTurns:1,enabled:true})});
  await service.markUnknown(projectId,message.id,'writer conflict',proof(processing.operationId));
  const originalId=processing.id,originalOperation=processing.operationId;
  await service.approvePreTurnContinuation(projectId,message.id,principal,{
    operationId:randomUUID(),sessionId,originalOperationId:originalOperation,
    expectedVersion:processing.version,expectedMessageVersion:message.version,expectedGateVersion:3,
    evidenceRef:'handoff:1',reason:'released'});
  assert.equal((await service.claimPreTurnContinuation(projectId,message.id))?.preTurnProof?.status,'attempting');
  assert.equal(await service.claimPreTurnContinuation(projectId,message.id),null);
  await service.bindTurn(projectId,message.id,{id:randomUUID(),status:'inProgress',completedAtUtc:null});
  assert.equal(processing.id,originalId);assert.equal(processing.operationId,originalOperation);
  assert.equal(processing.preTurnProof?.status,'consumed');assert.equal(message.state,'processing');
});
