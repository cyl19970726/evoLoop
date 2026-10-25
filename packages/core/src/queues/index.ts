import type { Principal } from '@evoloop/contracts';
import { queueCommandSchema } from '@evoloop/contracts/queues';
import type { QueueCommand,QueueTransaction,ResidentQueue,ResidentQueueEntry,QueueSourceFacts,QueueReleaseEvidence,QueueHoldCode } from '@evoloop/contracts/queues';
import { canonicalTaskInputJson,taskInputSignature } from '../task-input.js';
import type { Reader } from '@evoloop/contracts/ports';

export type { ResidentQueueEntry,QueueSourceFacts,QueueReleaseEvidence } from '@evoloop/contracts/queues';
export interface QueueDecision {ready:boolean;code:QueueHoldCode|null;reason:string|null}
const held=(code:QueueHoldCode,reason:string):QueueDecision=>({ready:false,code,reason});
export function evaluateQueueEntry(entry:ResidentQueueEntry,facts:QueueSourceFacts,dependencyReleased:boolean):QueueDecision{
  if(!dependencyReleased)return held('dependency','a prerequisite entry is not accepted');
  if(!facts.currentTaskRevisionId||!['todo','in_progress'].includes(facts.taskState))return held('task_unavailable','Task is not executable');
  if(facts.currentInputJson!==entry.sourceInputJson)return held('task_changed','business input changed from fixed source');
  if(!facts.sessionReady||!facts.nativeThreadId)return held('session_unready','owned Session is not ready');
  if(!facts.bindingCurrent)return held('binding_changed','Role binding is not current');
  if(!facts.grantCurrent)return held('grant_revoked','current exact grant does not authorize start');
  if(facts.conflictingRun)return held('run_in_flight','Task or Session has an active or unknown Run');
  return {ready:true,code:null,reason:null};
}
export function evaluateQueueRelease(entry:ResidentQueueEntry,e:QueueReleaseEvidence):QueueDecision{
  if(e.currentInputJson!==entry.sourceInputJson)return held('task_changed','business input changed from fixed source');
  if(e.closureCurrent&&e.closureId&&e.taskState==='done'&&e.deliveryCurrent&&e.deliveryPassed&&e.deliveryId&&(!entry.useRequired||(e.observationId&&e.observationUsed&&e.observationConsumerId===entry.consumerId)))return {ready:true,code:null,reason:null};
  if(entry.releaseRule==='bounded_decision'&&e.boundedDecisionId&&e.boundedDecisionActorId&&e.boundedDecisionReason?.trim()&&e.nextResponsibility?.trim()&&e.taskState==='in_progress')return {ready:true,code:null,reason:null};
  return held('awaiting_acceptance','current delivery, consumer use and Task closure or bounded Lead decision are not verified');
}
export interface QueueContext {nowUtc:string;nextId():string}
export interface QueueResult {queueId:string;version:number;claimId:string|null;runId:string|null;held:QueueHoldCode|null}
const fail=(code:string,message:string):never=>{throw Object.assign(new Error(message),{code});};
const terminal=new Set(['completed','failed','interrupted']);
/** Business checks run inside the caller's journalled transaction. The PG adapter still locks authority rows atomically. */
export function applyQueue(tx:QueueTransaction & Reader,principal:Principal,input:QueueCommand,ctx:QueueContext):Promise<QueueResult>;
export function applyQueue(tx:QueueTransaction,reader:Reader,principal:Principal,input:QueueCommand,ctx:QueueContext):Promise<QueueResult>;
export async function applyQueue(tx:QueueTransaction,readerOrPrincipal:Reader|Principal,principalOrInput:Principal|QueueCommand,
  inputOrContext:QueueCommand|QueueContext,context?:QueueContext):Promise<QueueResult>{
  const reader=context?readerOrPrincipal as Reader:tx as QueueTransaction & Reader;
  const principal=(context?principalOrInput:readerOrPrincipal) as Principal;
  const input=(context?inputOrContext:principalOrInput) as QueueCommand;
  const ctx=(context??inputOrContext) as QueueContext;
  const parsed=queueCommandSchema.safeParse(input);if(!parsed.success)return fail('INVALID_COMMAND',parsed.error.message);
  const c=parsed.data;
  if(!principal.actorId||!principal.projectIds.includes(c.projectId)||!principal.permissions.includes('review'))return fail('FORBIDDEN','project review permission required');
  if(!await tx.queueControllerCurrent(principal.actorId))return fail('QUEUE_AUTHORIZATION','current queue controller authority required');
  const leadOnly=['queue.create','queue.reorder','queue.amend','queue.adopt','queue.release','queue.hold','queue.unhold'];
  if(leadOnly.includes(c.type)&&!principal.permissions.includes('write'))return fail('FORBIDDEN','Lead write permission required');
  const result=(queue:ResidentQueue|null,claimId:string|null=null,runId:string|null=null,hold:QueueHoldCode|null=null):QueueResult=>({queueId:c.queueId,version:queue?.version??0,claimId,runId,held:hold});
  if(c.type==='queue.create'){
    const entries:ResidentQueueEntry[]=[];
    for(const [position,item] of c.entries.entries()){
      if(item.dependsOn.some(d=>!entries.some(x=>x.id===d)))return fail('INVALID_DEPENDENCY','dependencies must precede the entry');
      const task=await reader.getTask(item.taskId);
      if(!task||task.projectId!==c.projectId||task.state!=='in_progress'||task.currentRevisionId!==item.taskRevisionId)
        return fail('TASK_UNAVAILABLE','queue requires the current in-progress Task revision and sealed fixed input');
      const sourceInputJson=canonicalTaskInputJson(await taskInputSignature(reader,task,item.taskRevisionId));
      entries.push({projectId:c.projectId,queueId:c.queueId,id:item.id,taskId:item.taskId,taskRevisionId:item.taskRevisionId,sourceInputJson,sessionId:item.sessionId,roleId:item.roleId,position,dependsOn:item.dependsOn,consumerId:item.consumerId,useRequired:item.useRequired,releaseRule:item.releaseRule,state:'queued',holdCode:null,holdReason:null,claimId:null,version:1});
    }
    const queue:ResidentQueue={projectId:c.projectId,id:c.queueId,version:1,adoptedVersion:null,maxRuns:c.maxRuns,reason:c.reason,actorId:principal.actorId,entries};
    await tx.createResidentQueue(queue);return result(queue);
  }
  const queue=await tx.getResidentQueue(c.queueId);if(!queue)return fail('NOT_FOUND','queue missing');
  if((c.type==='queue.claim'||c.type==='queue.continue')&&principal.actorId!==queue.actorId)
    return fail('QUEUE_ACTOR_MISMATCH','only the adopted queue controller may reserve its Run');
  if(c.type==='queue.reorder'){if(queue.version!==c.expectedVersion)return fail('VERSION_CONFLICT','queue revision changed');const version=await tx.reorderResidentQueue(c.queueId,c.expectedVersion,c.entryIds,principal.actorId,c.reason);return {...result(queue),version};}
  if(c.type==='queue.amend'){
    if(queue.version!==c.expectedVersion)return fail('VERSION_CONFLICT','queue revision changed');
    const entry=queue.entries.find(x=>x.id===c.entryId);if(!entry)return fail('NOT_FOUND','entry missing');
    const task=await reader.getTask(entry.taskId);if(!task||task.currentRevisionId!==c.taskRevisionId||task.state!=='in_progress')return fail('TASK_REVISION_CONFLICT','amendment requires current in-progress Task revision');
    const attempts=entry.claimId?await tx.listResidentQueueAttempts(entry.claimId):[];const last=attempts.at(-1);const run=last?await reader.getRuntimeRun(last.runId):null;
    if(last&&(!run||!terminal.has(run.state)))return fail('RUN_UNSETTLED','unknown or active Run cannot amend input');
    const sourceInputJson=canonicalTaskInputJson(await taskInputSignature(reader,task));
    const version=await tx.amendResidentQueueEntry(c.queueId,c.entryId,c.expectedVersion,c.taskRevisionId,sourceInputJson,principal.actorId,c.reason);
    return {...result(queue),version};
  }
  if(c.type==='queue.adopt'){if(queue.version!==c.expectedVersion)return fail('VERSION_CONFLICT','queue revision changed');await tx.adoptResidentQueue(c.queueId,c.expectedVersion,principal.actorId);return result(queue);}
  const entry=queue.entries.find(x=>x.id===c.entryId);if(!entry)return fail('NOT_FOUND','entry missing');
  if(c.type==='queue.hold'){
    if(entry.state==='released')return fail('ENTRY_UNAVAILABLE','released entry cannot be held');
    await tx.holdResidentQueueEntry(c.queueId,c.entryId,'manual_review',c.reason);return result(queue,null,null,'manual_review');
  }
  if(c.type==='queue.unhold'){
    if(entry.version!==c.expectedEntryVersion)return fail('VERSION_CONFLICT','entry changed');
    if(!entry.holdCode||entry.holdCode==='budget_exhausted')return fail('HOLD_NOT_LIFTABLE','entry is not held or adopted budget is exhausted');
    await tx.unholdResidentQueueEntry(c.queueId,c.entryId,c.expectedEntryVersion,c.operationId,principal.actorId,c.reason);
    return result(queue);
  }
  if(c.type==='queue.claim'||c.type==='queue.continue'){
    if(entry.holdCode)return fail('HOLD_REQUIRES_DECISION','Lead must explicitly unhold this entry');
    if(c.type==='queue.claim'&&queue.version!==c.expectedVersion)return fail('VERSION_CONFLICT','queue order changed');
    if(queue.adoptedVersion!==queue.version)return fail('QUEUE_NOT_ADOPTED','Lead must adopt current order');
    const claim=c.type==='queue.continue'?await tx.getResidentQueueClaim(c.claimId):null;
    if(c.type==='queue.continue'&&(!claim||claim.entryId!==entry.id||claim.releasedAt))return fail('CLAIM_MISMATCH','active Task claim required');
    if(c.type==='queue.claim'&&entry.state!=='queued')return fail('ENTRY_UNAVAILABLE','entry is not queued');
    const attempts=claim?await tx.listResidentQueueAttempts(claim.claimId):[];
    if(c.type==='queue.claim'&&await tx.countResidentQueueAttempts(c.queueId)>=queue.maxRuns){
      await tx.holdResidentQueueEntry(c.queueId,entry.id,'budget_exhausted','adopted queue run budget exhausted');
      return result(queue,null,null,'budget_exhausted');
    }
    if(attempts.length){const previous=await reader.getRuntimeRun(attempts.at(-1)!.runId);if(!previous||!terminal.has(previous.state))return fail('RUN_UNSETTLED','previous Run must be confirmed terminal; unknown requires original operation reconciliation');}
    const task=await reader.getTask(entry.taskId),session=await reader.getRuntimeSession(entry.sessionId);
    const dependencyFacts=await Promise.all(entry.dependsOn.map(async id=>{const d=queue.entries.find(x=>x.id===id);const c=d?.claimId?await tx.getResidentQueueClaim(d.claimId):null;return d?.state==='released'&&c?.releaseKind==='accepted';}));
    const dependencies=dependencyFacts.every(Boolean);
    const currentInputJson=task?canonicalTaskInputJson(await taskInputSignature(reader,task)):null;
    if(c.type==='queue.continue'&&c.answeredQuestions.length===0){
      const previousAttempt=attempts.at(-1);
      if(!task||!previousAttempt)return fail('CONTINUATION_SOURCE_MISSING','previous fixed Task input is required');
      const previousInputJson=canonicalTaskInputJson(await taskInputSignature(reader,task,
        previousAttempt.actualRunTaskRevisionId??previousAttempt.taskRevisionId));
      if(currentInputJson===previousInputJson)
        return fail('CONTINUATION_INPUT_UNCHANGED','continuation without an answer requires amended, readopted business input');
    }
    if(c.type==='queue.continue'&&await tx.countResidentQueueAttempts(c.queueId)>=queue.maxRuns){
      await tx.holdResidentQueueEntry(c.queueId,entry.id,'budget_exhausted','adopted queue run budget exhausted');
      return result(queue,claim!.claimId,null,'budget_exhausted');
    }
    const grantCurrent=await tx.exactQueueGrant(entry.roleId,entry.sessionId,entry.taskId);
    const bindingCurrent=await tx.queueBindingCurrent(entry.roleId,entry.sessionId);
    const runBusy=(await reader.listRuntimeRuns()).some(r=>(r.taskId===entry.taskId||r.sessionId===entry.sessionId)&&!terminal.has(r.state)) || session?.state==='unknown';
    const gate=evaluateQueueEntry(entry,{currentTaskRevisionId:task?.currentRevisionId??null,taskState:task?.state??'other',sessionReady:session?.state==='ready',nativeThreadId:session?.nativeThreadId??null,bindingCurrent,grantCurrent,conflictingRun:runBusy,currentInputJson},dependencies);
    // Exact input is supplied separately to avoid treating lifecycle revisions as input changes.
    if(!gate.ready){await tx.holdResidentQueueEntry(c.queueId,entry.id,gate.code!,gate.reason!);return result(queue,claim?.claimId??null,null,gate.code);}
    const attempt={runId:c.runId,operationId:c.runOperationId,taskRevisionId:task!.currentRevisionId};
    if(c.type==='queue.claim'){
      const claimed=await tx.claimResidentQueue(c.queueId,entry.id,c.expectedVersion,c.claimId,attempt);return result(queue,claimed?.claimId??null,claimed?c.runId:null,claimed?null:'occupied');
    }
    const next=await tx.appendResidentQueueAttempt(c.claimId,attempt,queue.maxRuns);return result(queue,c.claimId,next?c.runId:null,next?null:'budget_exhausted');
  }
  if(c.type==='queue.release'){
    if(entry.holdCode)return fail('HOLD_REQUIRES_DECISION','Lead must explicitly unhold before release');
    const claim=await tx.getResidentQueueClaim(c.claimId);if(!claim||claim.entryId!==entry.id||claim.releasedAt)return fail('CLAIM_MISMATCH','active claim required');
    const attempts=await tx.listResidentQueueAttempts(claim.claimId);const last=attempts.at(-1);const run=last?await reader.getRuntimeRun(last.runId):null;
    if(!run||!terminal.has(run.state))return fail('RUN_UNSETTLED','unknown or active Run cannot release');
    const task=await reader.getTask(entry.taskId);if(!task)return fail('TASK_UNAVAILABLE','Task missing');
    if(canonicalTaskInputJson(await taskInputSignature(reader,task))!==entry.sourceInputJson)return fail('TASK_CHANGED','business input changed');
    if(c.decisionId){if(entry.releaseRule!=='bounded_decision'||!c.reason||!c.nextResponsibility)return fail('BOUNDED_DECISION_REQUIRED','explicit bounded Lead decision required');
      const ok=await tx.releaseResidentQueueBounded(c.claimId,c.decisionId,principal.actorId,c.reason,c.nextResponsibility);return result(queue,ok?c.claimId:null);}
    const ok=await tx.releaseResidentQueueAccepted(c.claimId);return result(queue,ok?c.claimId:null,null,ok?null:'awaiting_acceptance');
  }
  return fail('INVALID_COMMAND','unsupported queue command');
}
