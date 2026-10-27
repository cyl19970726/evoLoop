import type { Principal, RuntimeSessionRecord } from '@evoloop/contracts';
import { DomainError, type Transaction } from '@evoloop/contracts/ports';
import type { ExecutionProfileRevision, SessionRecoveryCommand } from '@evoloop/contracts/session-recovery';

export interface RecoveryAuthority {
  canRevise(principal:Principal,session:RuntimeSessionRecord,target:{model:string;sandbox:'danger-full-access';approvalPolicy:'never'}):Promise<boolean>;
}
const need=<T>(value:T|null|undefined,label:string):T=>{if(value==null)throw new DomainError('NOT_FOUND',label+' unavailable');return value;};
const active=new Set(['requested','dispatching','running','unknown']);
export async function applySessionRecovery(tx:Transaction,principal:Principal,command:SessionRecoveryCommand,
  now:string,nextId:()=>string,authority?:RecoveryAuthority){
  if(!principal.actorId||!principal.projectIds.includes(command.projectId)||
    !principal.permissions.includes('write')||!principal.permissions.includes('review')||principal.actorId.startsWith('worker-'))
    throw new DomainError('FORBIDDEN','Recovery requires the project reviewer, not a runtime worker');
  const recovery=need(tx.recovery,'Session recovery persistence');
  const session=need(await tx.getRuntimeSession(command.sessionId),'Session');
  if(session.projectId!==command.projectId)throw new DomainError('PROJECT_SCOPE','Session belongs to another project');
  const gate=await recovery.lockRecoveryGate(session.id);
  if(session.state!=='ready'||!session.nativeThreadId||!session.nativeSessionId)
    throw new DomainError('SESSION_NOT_READY','Only a bound ready Session can recover');
  const runs=(await tx.listRuntimeRuns()).filter(r=>r.sessionId===session.id);
  const permittedUnstarted=command.type==='runtime.session.recovery.resume'&&gate.causeKind==='execution_profile'
    ?runs.find(r=>r.id===gate.retryRunId&&r.state==='requested'&&!r.nativeTurnId&&
      r.executionProfile?.revisionId===gate.causeId&&session.executionProfile?.revision.revisionId===gate.causeId):null;
  if(runs.some(r=>active.has(r.state)&&r.id!==permittedUnstarted?.id))throw new DomainError('SESSION_BUSY','Reconcile every active or unknown Run first');
  if(permittedUnstarted){
    if(await tx.sessionMessages?.hasActiveSessionMessage(session.id))throw new DomainError('SESSION_BUSY','Reconcile the active or unknown message first');
  }else await tx.sessionMessages?.assertSessionVacant(session.id);
  if(command.type==='runtime.session.executionProfile.revise'){
    if(session.version!==command.expectedVersion)throw new DomainError('VERSION_CONFLICT','Session changed',session.version);
    const profile=need(session.executionProfile,'Execution profile');
    if(profile.revision.revisionId!==command.expectedExecutionProfileRevisionId)
      throw new DomainError('EXECUTION_PROFILE_CONFLICT','Execution profile changed');
    if(['attempting','unknown'].includes(profile.activationState))
      throw new DomainError('PROFILE_ACTIVATION_UNRESOLVED','Reconcile the original activation before changing its target');
    if(command.sandbox!=='danger-full-access'||command.approvalPolicy!=='never')
      throw new DomainError('EXECUTION_PROFILE_INVALID','The target must use the approved full-access execution policy');
    if(session.model===command.model&&session.sandbox===command.sandbox&&session.approvalPolicy===command.approvalPolicy)
      throw new DomainError('EXECUTION_PROFILE_UNCHANGED','The selected execution profile is unchanged');
    if(await recovery.isDynamicSession(session.id))throw new DomainError('DYNAMIC_PROFILE_FIXED','A delegated Session keeps its fixed template execution profile');
    if(!authority||!await authority.canRevise(principal,session,{model:command.model,sandbox:command.sandbox,approvalPolicy:command.approvalPolicy}))
      throw new DomainError('FORBIDDEN','The exact static Session execution grant is not current');
    const revision:ExecutionProfileRevision={...profile.revision,projectId:session.projectId,sessionId:session.id,
      revisionId:nextId(),previousRevisionId:profile.revision.revisionId,version:profile.revision.version+1,
      model:command.model,sandbox:command.sandbox,approvalPolicy:command.approvalPolicy,
      provenance:'revised',operationId:command.operationId,actorId:principal.actorId,
      reason:command.reason,evidenceRef:command.evidenceRef,createdAt:now};
    await recovery.adoptExecutionProfile(revision,session.version);
    return {result:{status:'applied' as const,operationId:command.operationId,entityId:session.id,version:session.version+1,revisionId:revision.revisionId},
      effects:[{kind:command.type,entityId:session.id,version:session.version+1}]};
  }
  if(gate.version!==command.expectedVersion)throw new DomainError('VERSION_CONFLICT','Recovery gate changed',gate.version);
  if(gate.phase!=='blocked'||gate.causeId!==command.expectedCauseId)
    throw new DomainError('RECOVERY_SOURCE_CHANGED','The selected blocked outcome is no longer current');
  if(gate.queueId){
    const queue=need(await tx.queue?.getResidentQueue(gate.queueId),'Recovery queue');
    if(queue.actorId!==principal.actorId)throw new DomainError('QUEUE_ACTOR_MISMATCH','Only the registered controller may resume its queue Session');
  }
  if(session.executionProfile&&session.executionProfile.activationState!=='active')
    throw new DomainError('PROFILE_NOT_ACTIVE','Reconcile and confirm the registered execution profile first');
  const recordedClaim=gate.claimId?await tx.queue?.getResidentQueueClaim(gate.claimId):null;
  if(gate.claimId&&!recordedClaim)throw new DomainError('CLAIM_MISMATCH','The recorded recovery claim is unavailable');
  const activeClaim=recordedClaim&&!recordedClaim.releasedAt?recordedClaim:null;
  if(gate.causeKind==='run'){
    const source=need(await tx.getRuntimeRun(command.expectedCauseId),'Source Run');
    if(active.has(source.state))throw new DomainError('RUN_UNSETTLED','Unknown results require the original operation reconciliation');
    if(source.state!=='completed'&&activeClaim)
      throw new DomainError('RETRY_DECISION_REQUIRED','An unreleased failed Task claim requires explicit retryFailed');
  }else if(gate.causeKind==='message'){
    const message=need(await tx.sessionMessages?.getSessionMessage(command.expectedCauseId),'Source message');
    if(['queued','processing','unknown'].includes(message.state))throw new DomainError('MESSAGE_UNSETTLED','Reconcile the original message processing first');
  }
  if(command.resumeMessageId!==gate.resumeMessageId)
    throw new DomainError('RECOVERY_MESSAGE_CHANGED','Only the message pinned at the original failure may resume');
  let pendingMessageId=gate.resumeMessageId;
  if(pendingMessageId){
    const message=need(await tx.sessionMessages?.getSessionMessage(pendingMessageId),'Pinned original message');
    const processing=await tx.sessionMessages?.getSessionMessageProcessing(pendingMessageId);
    if(['processing','unknown'].includes(message.state)||processing&&['dispatching','running','unknown'].includes(processing.state))
      throw new DomainError('MESSAGE_UNSETTLED','Reconcile the original pinned message before resuming');
    if(['replied','completed_without_reply','failed','cancelled'].includes(message.state))pendingMessageId=null;
    else if(message.state!=='queued'||processing)
      throw new DomainError('MESSAGE_STATE_MISMATCH','The pinned message and its original processing need reconciliation');
  }
  const phase=permittedUnstarted?'retrying':pendingMessageId?'message_pending':activeClaim?'awaiting_acceptance':'open';
  const decision={projectId:command.projectId,id:command.operationId,sessionId:session.id,kind:'resume' as const,
    expectedGateVersion:gate.version,causeId:command.expectedCauseId,sourceRunId:gate.causeKind==='run'?gate.causeId:null,
    sourceInputHash:null,retryRunId:permittedUnstarted?.id??null,resumeMessageId:pendingMessageId,actorId:principal.actorId,
    reason:command.reason,evidenceRef:command.evidenceRef,createdAt:now};
  await recovery.saveRecoveryDecision(decision,{...gate,phase,version:gate.version+1,
    claimId:activeClaim?.claimId??null,
    resumeMessageId:pendingMessageId,
    reason:command.reason,decisionOperationId:command.operationId,updatedAt:now},gate.version);
  return {result:{status:'applied' as const,operationId:command.operationId,entityId:session.id,version:gate.version+1},
    effects:[{kind:command.type,entityId:session.id,version:gate.version+1}]};
}
