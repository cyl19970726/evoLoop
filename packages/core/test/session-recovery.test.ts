import assert from 'node:assert/strict';
import {test} from 'node:test';
import {randomUUID,createHash} from 'node:crypto';
import {applyQueue} from '../src/queues/index.ts';
import {applySessionRecovery} from '../src/session-recovery.ts';
import {canonicalTaskInputJson,taskInputSignature} from '../src/task-input.ts';
import {WorkflowService} from '../src/index.ts';

const now='2026-10-27T01:00:00.000Z';
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
async function fixture(){
  const projectId=randomUUID(),sessionId=randomUUID(),taskId=randomUUID(),queueId=randomUUID(),entryId=randomUUID(),claimId=randomUUID(),sourceRunId=randomUUID(),messageId=randomUUID();
  const revisionId=randomUUID(),profileId=randomUUID(),basisId=randomUUID();
  const task={projectId,id:taskId,currentRevisionId:revisionId,version:3,state:'in_progress',title:'Read the fixed source',content:'Read the two fixed documents',acceptance:'Report their exact hashes',owner:'role',kind:'implementation',domainId:null,contentDocumentId:randomUUID(),contentRevisionId:randomUUID()};
  const revision={...task,taskId,id:revisionId,basisSetId:basisId};
  const session={projectId,id:sessionId,state:'ready',version:3,model:'approved-model',roleId:'role',actorId:'business',nativeThreadId:'native-thread',nativeSessionId:'native-session',cwd:'/isolated',authorizationScope:'read-only-task',sandbox:'read-only',approvalPolicy:'on-request',
    executionProfile:{revision:{projectId,sessionId,revisionId:profileId,version:1,model:'approved-model',sandbox:'read-only',approvalPolicy:'on-request',cwd:'/isolated',authorizationScope:'read-only-task',provenance:'reserved',previousRevisionId:null,operationId:randomUUID(),actorId:'business',reason:'Original registration',evidenceRef:null,createdAt:now},activationState:'active',activeRevisionId:profileId,activationOperationId:null,attemptedAt:null,activationEvidence:null}};
  const source={projectId,id:sourceRunId,sessionId,taskId,taskRevisionId:revisionId,state:'failed',version:4,input:'Exact prior input including any fixed answers',inputHash:hash('Exact prior input including any fixed answers'),evaluationBinding:null};
  const principal={actorId:'lead',projectIds:[projectId],permissions:['read','write','review']};
  let gate={projectId,sessionId,version:1,phase:'blocked',causeKind:'run',causeId:sourceRunId,causeState:'failed',reason:'Observed native failure',queueId,claimId,retryRunId:null,resumeMessageId:messageId,decisionOperationId:null,updatedAt:now};
  const entry={projectId,queueId,id:entryId,taskId,taskRevisionId:revisionId,sourceInputJson:'',sessionId,roleId:'role',position:0,dependsOn:[],consumerId:'consumer',useRequired:true,releaseRule:'accepted',state:'claimed',holdCode:null,holdReason:null,claimId,version:1};
  const queue={projectId,id:queueId,version:1,adoptedVersion:1,maxRuns:2,reason:'Two tasks',actorId:'lead',entries:[entry]};
  const attempts=[{projectId,claimId,sequence:1,runId:sourceRunId,operationId:randomUUID(),taskRevisionId:revisionId,actualRunTaskRevisionId:revisionId,reservedAt:now}];
  const decisions:any[]=[];
  const message={projectId,id:messageId,state:'queued',target:{kind:'owned',sessionId}};
  const recovery:any={isDynamicSession:async()=>false,getRecoveryGate:async()=>gate,lockRecoveryGate:async()=>structuredClone(gate),
    saveRecoveryDecision:async(d:any,g:any,expected:number)=>{assert.equal(gate.version,expected);decisions.push(d);gate=g;},
    adoptExecutionProfile:async()=>{throw Error('unexpected profile mutation');}};
  const reader:any={recovery,getTask:async()=>task,getRuntimeSession:async()=>session,
    getRuntimeRun:async(id:string)=>id===sourceRunId?source:null,listRuntimeRuns:async()=>[source],
    getTaskRevision:async()=>revision,getBasisSet:async()=>({projectId,taskId,taskRevisionId:revisionId,id:basisId,members:[]}),listTaskExternalSnapshot:async()=>[],
    sessionAssignments:{getTaskSessionAssignment:async()=>null},
    sessionMessages:{getSessionMessage:async()=>message,getSessionMessageProcessing:async()=>null,hasActiveSessionMessage:async()=>false,assertSessionVacant:async()=>{}}};
  entry.sourceInputJson=canonicalTaskInputJson(await taskInputSignature(reader,task as any));
  const tx:any={queueControllerCurrent:async()=>true,getResidentQueue:async()=>queue,
    getResidentQueueClaim:async()=>({projectId,queueId,entryId,claimId,sessionId,taskId,releasedAt:null}),
    listResidentQueueAttempts:async()=>attempts,countResidentQueueAttempts:async()=>attempts.length,
    exactQueueGrant:async()=>true,queueBindingCurrent:async()=>true,
    appendResidentQueueAttempt:async(_claim:string,a:any)=>{const next={...a,projectId,claimId,sequence:attempts.length+1,actualRunTaskRevisionId:null,reservedAt:now};attempts.push(next);return next;}};
  const operationId=randomUUID();
  const command:any={type:'queue.retryFailed',projectId,operationId,queueId,entryId,claimId,runId:randomUUID(),runOperationId:operationId,expectedVersion:1,expectedGateVersion:1,sourceRunId,expectedSourceRunVersion:4,expectedTaskRevisionId:revisionId,expectedExecutionProfileRevisionId:profileId,expectedInputHash:source.inputHash,resumeMessageId:messageId,evidenceRef:'Reviewed original failure',reason:'Explicitly retry once with the same fixed business input'};
  return {projectId,sessionId,profileId,principal,reader,tx,recovery,source,session,task,revision,entry,queue,attempts,decisions,command,message,getGate:()=>gate,run:()=>applyQueue(tx,reader,principal as any,command,{nowUtc:now,nextId:randomUUID,recovery})};
}

test('retry binds one successor to the known failed input without changing Task or original message',async()=>{
  const f=await fixture();const originalTask=structuredClone(f.task),originalMessage=structuredClone(f.message);
  const result=await f.run();assert.equal(result.runId,f.command.runId);
  assert.equal(f.attempts.length,2);assert.equal(f.getGate().phase,'retrying');assert.equal(f.getGate().retryRunId,f.command.runId);
  assert.equal(f.decisions[0].sourceInputHash,f.source.inputHash);assert.equal(f.decisions[0].resumeMessageId,f.message.id);
  assert.deepEqual(f.task,originalTask);assert.deepEqual(f.message,originalMessage);
  await assert.rejects(f.run(),(e:any)=>e.code==='RETRY_SOURCE_MISMATCH');assert.equal(f.decisions.length,1);assert.equal(f.attempts.length,2);
});
test('unknown and completed results never enter the known-failed retry branch',async()=>{
  for(const state of ['unknown','completed']){const f=await fixture();f.source.state=state;
    await assert.rejects(f.run(),(e:any)=>e.code==='RETRY_SOURCE_MISMATCH');assert.equal(f.attempts.length,1);assert.equal(f.decisions.length,0);}
});
test('an explicitly reviewed interrupted terminal outcome can retry without relabelling its history',async()=>{
  const f=await fixture();f.source.state='interrupted';await f.run();assert.equal(f.source.state,'interrupted');assert.equal(f.attempts.length,2);
});
test('fixed input drift, a replacement message or exhausted cumulative budget rejects without a successor',async()=>{
  const changed=await fixture();changed.revision.content='Changed actual business scope';
  await assert.rejects(changed.run(),(e:any)=>e.code==='RETRY_INPUT_CHANGED');
  const replaced=await fixture();replaced.command.resumeMessageId=randomUUID();
  await assert.rejects(replaced.run(),(e:any)=>e.code==='RECOVERY_MESSAGE_CHANGED');
  const exhausted=await fixture();exhausted.queue.maxRuns=1;
  await assert.rejects(exhausted.run(),(e:any)=>e.code==='BUDGET_EXHAUSTED');
  const differentProfile=await fixture();differentProfile.command.expectedExecutionProfileRevisionId=randomUUID();
  await assert.rejects(differentProfile.run(),(e:any)=>e.code==='EXECUTION_PROFILE_CONFLICT');
  for(const f of [changed,replaced,exhausted,differentProfile]){assert.equal(f.attempts.length,1);assert.equal(f.decisions.length,0);}
});
test('budget extension belongs to the registered controller and does not resume the Session',async()=>{
  const f=await fixture();let extensions=0;
  f.tx.extendResidentQueueBudget=async()=>{extensions++;return 2;};
  const c:any={type:'queue.extendBudget',projectId:f.projectId,operationId:randomUUID(),queueId:f.queue.id,expectedVersion:1,expectedMaxRuns:2,maxRuns:3,evidenceRef:'Explicit cost decision',reason:'One reviewed failure retry'};
  const result=await applyQueue(f.tx,f.reader,f.principal as any,c,{nowUtc:now,nextId:randomUUID,recovery:f.recovery});
  assert.equal(result.version,2);assert.equal(extensions,1);assert.equal(f.getGate().phase,'blocked');assert.equal(f.attempts.length,1);
  await assert.rejects(applyQueue(f.tx,f.reader,{...f.principal,actorId:'other'} as any,c,{nowUtc:now,nextId:randomUUID}),/registered controller/);
  await assert.rejects(applyQueue(f.tx,f.reader,f.principal as any,{...c,maxRuns:2},{nowUtc:now,nextId:randomUUID}),/increase/);
});
test('profile revision requires exact authority and cannot bypass unknown native work',async()=>{
  const f=await fixture();const c:any={type:'runtime.session.executionProfile.revise',projectId:f.projectId,operationId:randomUUID(),sessionId:f.sessionId,expectedVersion:3,expectedExecutionProfileRevisionId:f.profileId,model:'reviewed-new-model',evidenceRef:'Provider and exact grant reviewed',reason:'Controlled change'};
  const tx:any={...f.reader,recovery:f.recovery};
  await assert.rejects(applySessionRecovery(tx,f.principal as any,c,now,randomUUID),/exact static/);
  let adopted:any;f.recovery.adoptExecutionProfile=async(r:any,v:number)=>{adopted=r;assert.equal(v,3);};
  await applySessionRecovery(tx,f.principal as any,c,now,randomUUID,{canRevise:async()=>true});
  assert.equal(adopted.previousRevisionId,f.profileId);assert.equal(adopted.model,'reviewed-new-model');assert.equal(f.getGate().phase,'blocked');
  f.recovery.isDynamicSession=async()=>true;
  await assert.rejects(applySessionRecovery(tx,f.principal as any,c,now,randomUUID,{canRevise:async()=>true}),/delegated Session/);
  f.recovery.isDynamicSession=async()=>false;
  f.source.state='unknown';await assert.rejects(applySessionRecovery(tx,f.principal as any,c,now,randomUUID,{canRevise:async()=>true}),/active or unknown/);
});
test('resume cannot clear a failed active claim or substitute a newly posted message',async()=>{
  const f=await fixture();const c:any={type:'runtime.session.recovery.resume',projectId:f.projectId,operationId:randomUUID(),sessionId:f.sessionId,expectedVersion:1,expectedCauseId:f.source.id,resumeMessageId:f.message.id,evidenceRef:'Read original outcome',reason:'Reviewed resumption'};
  await assert.rejects(applySessionRecovery({...f.reader,queue:f.tx,recovery:f.recovery},f.principal as any,c,now,randomUUID),/explicit retryFailed/);
  f.source.state='completed';await applySessionRecovery({...f.reader,queue:f.tx,recovery:f.recovery},f.principal as any,c,now,randomUUID);
  assert.equal(f.getGate().phase,'message_pending');assert.equal(f.decisions.length,1);
});
test('profile readback resumes only its exact unstarted frozen Run after an explicit decision',async()=>{
  const f=await fixture();const gate:any=f.getGate();gate.causeKind='execution_profile';gate.causeId=f.profileId;gate.retryRunId=f.source.id;
  const run:any=f.source;run.state='requested';run.nativeTurnId=null;run.executionProfile={revisionId:f.profileId};
  f.reader.sessionMessages.assertSessionVacant=async()=>{throw Error('Legacy vacancy also counts the already reserved Run');};
  const c:any={type:'runtime.session.recovery.resume',projectId:f.projectId,operationId:randomUUID(),sessionId:f.sessionId,expectedVersion:1,expectedCauseId:f.profileId,resumeMessageId:f.message.id,evidenceRef:'Exact native configuration readback',reason:'Continue original reserved attempt without a new activation'};
  f.session.executionProfile.activationState='unknown';
  await assert.rejects(applySessionRecovery({...f.reader,queue:f.tx},f.principal as any,c,now,randomUUID),/confirm the registered execution profile/);
  f.session.executionProfile.activationState='active';
  await applySessionRecovery({...f.reader,queue:f.tx},f.principal as any,c,now,randomUUID);
  assert.equal(f.getGate().phase,'retrying');assert.equal(f.decisions[0].retryRunId,f.source.id);assert.equal(f.attempts.length,1);
});
test('bounded recovery observation marks the 21st decision as partial and never returns an unbounded audit',async()=>{
  const f=await fixture();let observedLimit=0;
  f.recovery.listRecoveryDecisions=async(_id:string,limit:number)=>{observedLimit=limit;return Array.from({length:21},()=>({id:randomUUID()}));};
  const service=new WorkflowService({uow:{read:async(_p:string,fn:any)=>fn({...f.reader,getProject:async()=>({id:f.projectId}),queue:{listResidentQueues:async()=>[]}})} as any,
    clock:{now:()=>now},ids:{next:randomUUID},hasher:{hash}});
  const view=await service.getSessionRecovery(f.principal as any,f.projectId,f.sessionId);
  assert.equal(observedLimit,21);assert.equal(view.decisions.length,20);assert.equal(view.partial,true);
});
