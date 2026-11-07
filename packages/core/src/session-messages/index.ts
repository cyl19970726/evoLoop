import type { AppliedResult, Principal } from "@evoloop/contracts";
import type { SessionMessageCommand, SessionMessageDispatchGrant, SessionMessageManualStopEvidence, SessionMessageManualStopPreflight, SessionMessageProcessing, SessionMessageRecord } from "@evoloop/contracts/session-messages";
import { preTurnProofSchema, type PreTurnProof, type RuntimeTurn, type RuntimeSessionRecord } from "@evoloop/contracts/runtime";
import type { Clock, IdFactory, Reader, Transaction, UnitOfWork } from "@evoloop/contracts/ports";
import { DomainError } from "@evoloop/contracts/ports";
import { priorReviewDecision, reviewIntentJson } from "../runtime/pre-turn-review.js";

const required = <T>(value:T|null,label:string):T => {if(value===null)throw new DomainError('NOT_FOUND',`${label} not found`);return value;};
const sameTarget = (a:SessionMessageRecord['target'],b:SessionMessageRecord['target']) =>
  a.kind===b.kind && (a.kind==='owned' && b.kind==='owned'?a.sessionId===b.sessionId:a.kind==='external' && b.kind==='external' && a.linkId===b.linkId);
const applied = (op:string,id:string,version:number):AppliedResult => ({status:'applied',operationId:op,entityId:id,version});

/** Called inside the shared command journal transaction; the principal supplies sender identity. */
export async function applySessionMessage(tx:Transaction,principal:Principal,command:SessionMessageCommand,now:string):Promise<{result:AppliedResult;effects:{kind:string;entityId:string;version:number}[]}>{
  const store=tx.sessionMessages;
  if(!store)throw new DomainError('SESSION_MESSAGES_UNAVAILABLE','message persistence is not configured');
  if(command.type==='session.message.post'){
    if(await store.getSessionMessage(command.messageId))throw new DomainError('ALREADY_EXISTS','message ID already exists');
    if(command.target.kind==='owned'){
      const session=required(await tx.getRuntimeSession(command.target.sessionId),'Session');
      if(session.state!=='ready'||!session.nativeThreadId||!session.nativeSessionId)
        throw new DomainError('SESSION_NOT_READY','owned recipient must be a ready bound Session');
    }else{
      const link=required(await tx.getHostLink(command.target.linkId),'host link');
      if(link.host.kind!=='external'||link.state==='revoked')throw new DomainError('MANUAL_TARGET_ONLY','external recipient must be a current manual link');
    }
    if(command.context){
      if(!await tx.getTaskRevision(command.context.taskId,command.context.taskRevisionId))
        throw new DomainError('CONTEXT_NOT_FOUND','fixed Task revision is unavailable in this project');
    }
    if(command.replyToMessageId){
      const prior=required(await store.getSessionMessage(command.replyToMessageId),'reply target');
      if(!sameTarget(prior.target,command.target))throw new DomainError('REPLY_TARGET_MISMATCH','reply target has another recipient');
    }
    const item:SessionMessageRecord={projectId:command.projectId,id:command.messageId,operationId:command.operationId,
      target:command.target,senderActorId:principal.actorId,content:command.content,context:command.context??null,
      replyToMessageId:command.replyToMessageId??null,state:command.target.kind==='owned'?'queued':'manual_pending',
      version:1,blockedReason:null,readReceipt:null,createdAt:now,updatedAt:now};
    await store.insertSessionMessage(item);
    return{result:applied(command.operationId,item.id,1),effects:[{kind:'session.message',entityId:item.id,version:1}]};
  }
  const item=required(await store.getSessionMessage(command.messageId),'message');
  if(command.type==='session.message.cancel'){
    if(item.senderActorId!==principal.actorId)throw new DomainError('MESSAGE_SENDER','only the sender may cancel a pending message');
    if(item.version!==command.expectedVersion)throw new DomainError('VERSION_CONFLICT','message changed',item.version);
    if(item.state!=='queued'&&item.state!=='manual_pending')throw new DomainError('MESSAGE_NOT_PENDING','only an unprocessed message may be cancelled');
    const next={...item,state:'cancelled' as const,version:item.version+1,updatedAt:now};
    await store.updateSessionMessage(next,item.version);
    return{result:applied(command.operationId,item.id,next.version),effects:[{kind:'session.message',entityId:item.id,version:next.version}]};
  }
  if(command.type==='session.message.reconcile'||command.type==='session.message.interrupt'||
    command.type==='session.message.manualStop'){
    if(!principal.permissions.includes('review'))throw new DomainError('FORBIDDEN','message recovery requires project review authority');
    const processing=required(await store.getSessionMessageProcessing(item.id),'processing');
    if(item.target.kind!=='owned'||item.target.sessionId!==command.sessionId||
      processing.sessionId!==command.sessionId||processing.id!==command.processingId||
      processing.nativeTurnId!==command.nativeTurnId)
      throw new DomainError('MESSAGE_BINDING_CHANGED','exact owned Session, processing and native Turn are required');
    if(item.version!==command.expectedMessageVersion||processing.version!==command.expectedProcessingVersion)
      throw new DomainError('VERSION_CONFLICT','message or processing changed',item.version);
    if(item.state!=='processing'&&item.state!=='unknown'||
      !['running','unknown'].includes(processing.state))
      throw new DomainError('MESSAGE_NOT_RUNNING','only an unresolved bound Turn can be reviewed');
    if(command.type==='session.message.manualStop'){
      if(await store.getSessionMessageManualStopEvidence(item.id))
        throw new DomainError('MANUAL_STOP_EXISTS','original manual stop must be read back');
      const anchor=await store.getSessionMessageManualStopPreflight(item.id);
      if(anchor?.capturedByActorId===principal.actorId)
        throw new DomainError('MANUAL_STOP_SELF_ATTESTATION','Stop reviewer must differ from the pre-stop Root actor');
      if(!anchor || anchor.preflightId!==command.preflightId ||
        anchor.processingId!==processing.id || anchor.sessionId!==command.sessionId ||
        anchor.nativeTurnId!==command.nativeTurnId ||
        anchor.oldCoordinatorPid!==command.oldCoordinatorPid || anchor.oldNativePid!==command.oldNativePid ||
        anchor.oldCoordinatorStartIdentity!==command.oldCoordinatorStartIdentity ||
        anchor.oldNativeStartIdentity!==command.oldNativeStartIdentity)
        throw new DomainError('MANUAL_STOP_PREFLIGHT_CHANGED','Original pre-stop owner identity is unavailable or changed');
      await store.insertSessionMessageManualStopEvidence({
        projectId:command.projectId,messageId:item.id,processingId:processing.id,
        sessionId:command.sessionId,nativeTurnId:command.nativeTurnId,preflightId:command.preflightId,
        operationId:command.operationId,actorId:principal.actorId,reason:command.reason,
        oldCoordinatorPid:command.oldCoordinatorPid,oldNativePid:command.oldNativePid,
        oldCoordinatorStartIdentity:command.oldCoordinatorStartIdentity,
        oldNativeStartIdentity:command.oldNativeStartIdentity,
        exitEvidenceRef:command.exitEvidenceRef,exitEvidenceHash:command.exitEvidenceHash,
        observedNativeStatus:command.observedNativeStatus,observedThreadStatus:command.observedThreadStatus,
        observedItemCount:command.observedItemCount,observedItemIdsHash:command.observedItemIdsHash,
        priorFailure:processing.failure,recordedAt:now,
      });
      const stopped={...processing,state:'failed' as const,response:null,
        failure:`Reviewed manual stop after owner handoff; native completion unproven (observed ${command.observedNativeStatus})`,
        version:processing.version+1,updatedAt:now};
      await store.updateSessionMessageProcessing(stopped,processing.version);
      const failed={...item,state:'failed' as const,version:item.version+1,updatedAt:now};
      await store.updateSessionMessage(failed,item.version);
      await store.markSessionMessageSettled(command.sessionId,item.id,now);
      return{result:applied(command.operationId,item.id,failed.version),
        effects:[{kind:'session.message.manualStop',entityId:item.id,version:failed.version}]};
    }
    if(command.type==='session.message.interrupt'){
      if(processing.interruptOperationId)
        throw new DomainError('INTERRUPT_ALREADY_REQUESTED','the original interrupt request must be reconciled');
      const next={...processing,interruptOperationId:command.operationId,interruptActorId:principal.actorId,
        interruptReason:command.reason,interruptRequestedAt:now,version:processing.version+1,updatedAt:now};
      await store.updateSessionMessageProcessing(next,processing.version);
      return{result:applied(command.operationId,item.id,next.version),effects:[{kind:'session.message.interrupt',entityId:item.id,version:next.version}]};
    }
    // The journal records the exact reviewed readback intent. The owner pump reads and
    // settles only the original native Turn; no Turn start or state rewrite occurs here.
    return{result:applied(command.operationId,item.id,processing.version),
      effects:[{kind:'session.message.reconcile',entityId:item.id,version:processing.version}]};
  }
  if(item.target.kind!=='owned')throw new DomainError('MANUAL_PENDING','external message has no automatic recipient read receipt');
  const processing=await store.getSessionMessageProcessing(item.id);
  if(!processing?.receiverActorId||principal.actorId!==processing.receiverActorId)
    throw new DomainError('MESSAGE_RECIPIENT','only the granted receiving actor may record its read');
  const bound=processing.projectId===command.projectId&&processing.messageId===item.id&&
    processing.sessionId===item.target.sessionId&&!!processing.nativeTurnId?.trim();
  const running=item.state==='processing'&&processing.state==='running';
  const settled=['replied','completed_without_reply','failed'].includes(item.state)&&
    ['completed','failed'].includes(processing.state);
  if(!bound||!(running||settled))
    throw new DomainError('MESSAGE_NOT_RECEIVED','a bound running or settled native Turn is required for receipt');
  if(item.readReceipt)throw new DomainError('RECEIPT_EXISTS','read receipt already recorded');
  await store.insertSessionMessageReadReceipt(item.id,principal.actorId,command.evidence,now);
  return{result:applied(command.operationId,item.id,item.version),effects:[{kind:'session.message.read',entityId:item.id,version:item.version}]};
}

export interface SessionMessageServiceDeps {uow:UnitOfWork;clock:Clock;ids:IdFactory;
  grantFor(message:SessionMessageRecord,session:RuntimeSessionRecord):Promise<SessionMessageDispatchGrant|null>;
}
/** Trusted coordinator path. No public command can claim a native turn or change processing evidence. */
export class SessionMessageService {
  async manualStopPreflight(projectId:string,messageId:string):Promise<SessionMessageManualStopPreflight|null>{
    return this.deps.uow.read(projectId,async reader=>
      await reader.sessionMessages?.getSessionMessageManualStopPreflight(messageId)??null);
  }
  constructor(private readonly deps:SessionMessageServiceDeps){}
  private async admission(projectId:string,messageId:string,reader:Reader){
    const store=reader.sessionMessages;
    if(!store)throw new DomainError('SESSION_MESSAGES_UNAVAILABLE','message persistence is not configured');
    const item=required(await store.getSessionMessage(messageId),'message');
    if(item.state!=='queued'||item.target.kind!=='owned')throw new DomainError('MESSAGE_NOT_QUEUED','only an owned queued message may dispatch');
    const session=required(await reader.getRuntimeSession(item.target.sessionId),'Session');
    if(session.state!=='ready'||!session.nativeThreadId||!session.nativeSessionId)
      throw new DomainError('SESSION_NOT_READY','recipient is unavailable');
    if(session.sandbox!=='danger-full-access'||session.approvalPolicy!=='never')
      throw new DomainError('FULL_EXECUTION_REQUIRED','Upgrade the Session execution profile before conversation execution');
    const grant=await this.deps.grantFor(item,session);
    if(!grant||!grant.enabled||grant.projectId!==projectId||grant.sessionId!==session.id||
      grant.senderActorId!==item.senderActorId||grant.receiverRoleId!==session.roleId||grant.cwd!==session.cwd||
      !grant.receiverActorId?.trim()||grant.receiverActorId===item.senderActorId||
      !Number.isInteger(grant.maxTurns)||grant.maxTurns<1)
      throw new DomainError('MESSAGE_GRANT_MISSING','exact ordinary conversation grant is unavailable');
    if(await store.countSessionMessageTurns(session.id,item.senderActorId)>=grant.maxTurns)
      throw new DomainError('MESSAGE_BUDGET_EXHAUSTED','ordinary conversation grant is exhausted');
    return{item,session,grant};
  }
  /** Side-effect-free gate before Task answer scheduling can act on behalf of the sender. */
  async preflightDispatch(projectId:string,messageId:string):Promise<void>{
    await this.deps.uow.read(projectId,async reader=>{await this.admission(projectId,messageId,reader);});
  }
  async get(projectId:string,id:string){return this.deps.uow.read(projectId,async r=>required(await r.sessionMessages?.getSessionMessage(id)??null,'message'));}
  /** Message and processing are read from the same repeatable-read project snapshot. */
  async detail(projectId:string,id:string):Promise<{message:SessionMessageRecord;processing:SessionMessageProcessing|null;
    manualStop:SessionMessageManualStopEvidence|null}>{
    return this.deps.uow.read(projectId,async r=>{
      const store=r.sessionMessages;
      const message=required(await store?.getSessionMessage(id)??null,'message');
      const processing=await store?.getSessionMessageProcessing(id)??null;
      const manualStop=await store?.getSessionMessageManualStopEvidence?.(id)??null;
      return{message,processing,manualStop};
    });
  }
  async list(projectId:string,target:SessionMessageRecord['target'],limit:number,cursor?:string){
    return this.deps.uow.read(projectId,async r=>r.sessionMessages?.listSessionMessages(target,limit,cursor)??{items:[],nextCursor:null});
  }
  /** A single-snapshot conversation page keeps each saved message beside its own processing record. */
  async conversation(projectId:string,target:SessionMessageRecord['target'],limit:number,cursor?:string){
    return this.deps.uow.read(projectId,async r=>{
      const store=r.sessionMessages;
      const page=await store?.listSessionMessages(target,limit,cursor)??{items:[],nextCursor:null};
      const processing=store?.listSessionMessageProcessing
        ? await store.listSessionMessageProcessing(page.items.map(item=>item.id))
        : await Promise.all(page.items.map(async item=>await store?.getSessionMessageProcessing(item.id)??null));
      const byMessage=new Map(processing.filter((item):item is SessionMessageProcessing=>!!item).map(item=>[item.messageId,item]));
      return{...page,items:page.items.map(message=>({...message,processing:byMessage.get(message.id)??null}))};
    });
  }
  async pending(projectId:string,limit=30,offset=0){return this.deps.uow.read(projectId,async r=>r.sessionMessages?.listPendingSessionMessages(limit,offset)??[]);}
  async processing(projectId:string,messageId:string){return this.deps.uow.read(projectId,async r=>r.sessionMessages?.getSessionMessageProcessing(messageId)??null);}
  async markInterruptAttempted(projectId:string,messageId:string,operationId:string,expectedVersion:number):Promise<boolean>{
    return this.deps.uow.transaction(projectId,async tx=>await tx.sessionMessages?.markSessionMessageInterruptAttempted(
      messageId,operationId,expectedVersion,this.deps.clock.now())??false);
  }
  async session(projectId:string,sessionId:string){return this.deps.uow.read(projectId,async r=>required(await r.getRuntimeSession(sessionId),'Session'));}
  async mustYieldBusiness(projectId:string,sessionId:string){return this.deps.uow.read(projectId,async r=>await r.sessionMessages?.mustYieldBusiness(sessionId)??false);}
  async isBusy(projectId:string,sessionId:string){return this.deps.uow.read(projectId,async r=>await r.sessionMessages?.hasActiveSessionMessage(sessionId)??false);}
  async noteBlocked(projectId:string,messageId:string,reason:string|null){await this.deps.uow.transaction(projectId,async tx=>{
    await tx.sessionMessages?.setSessionMessageBlockedReason(messageId,reason);});}
  async beginDispatch(projectId:string,messageId:string,processingId:string,operationId:string,readOnlyPolicyFingerprint:string,
    roleContext:string|null=null):Promise<SessionMessageProcessing>{
    return this.deps.uow.transaction(projectId,async tx=>{
      if(!/^[a-f0-9]{64}$/.test(readOnlyPolicyFingerprint))throw new DomainError('POLICY_PROOF_MISSING','Session execution admission fingerprint is required');
      const {item,session,grant}=await this.admission(projectId,messageId,tx);
      const store=tx.sessionMessages!;
      await store.assertCurrentLeaderSource(messageId);
      await store.assertSessionVacant(session.id);
      await tx.recovery?.assertStartupAllowed(session.id,'message',messageId);
      const now=this.deps.clock.now();
      const processing:SessionMessageProcessing={projectId,id:processingId,messageId,sessionId:session.id,operationId,
        receiverActorId:grant.receiverActorId,
        state:'dispatching',nativeTurnId:null,response:null,failure:null,readOnlyPolicyFingerprint,roleContext,
        version:1,startedAt:now,updatedAt:now};
      await store.insertSessionMessageProcessing(processing);
      await store.updateSessionMessage({...item,state:'processing',blockedReason:null,version:item.version+1,updatedAt:now},item.version);
      return processing;
    });
  }
  async bindTurn(projectId:string,messageId:string,turn:RuntimeTurn):Promise<void>{
    await this.deps.uow.transaction(projectId,async tx=>{
      const store=tx.sessionMessages!;const p=required(await store.getSessionMessageProcessing(messageId),'processing');
      if(!['dispatching','unknown'].includes(p.state)||!turn.id)throw new DomainError('PROCESSING_STATE','message cannot bind Turn');
      if(p.nativeTurnId&&p.nativeTurnId!==turn.id)throw new DomainError('TURN_CONFLICT','message already bound to another Turn');
      await store.updateSessionMessageProcessing({...p,state:'running',nativeTurnId:turn.id,
        preTurnProof:p.preTurnProof?{...p.preTurnProof,status:'consumed'}:null,
        version:p.version+1,updatedAt:this.deps.clock.now()},p.version);
      const m=required(await store.getSessionMessage(messageId),'message');
      if(m.state==='unknown')await store.updateSessionMessage({...m,state:'processing',version:m.version+1,updatedAt:this.deps.clock.now()},m.version);
    });
  }
  async markUnknown(projectId:string,messageId:string,reason:string,
    writerProof?:Pick<PreTurnProof,'threadId'|'operationId'|'requestId'|'code'|'inputHash'>):Promise<void>{
    await this.deps.uow.transaction(projectId,async tx=>{
      const store=tx.sessionMessages!;const p=required(await store.getSessionMessageProcessing(messageId),'processing');
      if(['completed','failed'].includes(p.state))return;
      const m=required(await store.getSessionMessage(messageId),'message');
      if(writerProof){
        const session=required(await tx.getRuntimeSession(p.sessionId),'Session');
        if(writerProof.threadId!==session.nativeThreadId||writerProof.operationId!==p.operationId||
          writerProof.code!==-32600||!Number.isSafeInteger(writerProof.requestId)||writerProof.requestId<1||
          p.nativeTurnId||!(p.state==='dispatching'||p.state==='unknown'&&p.preTurnProof?.status==='attempting'))
          throw new DomainError('PRE_TURN_PROOF_INVALID','writer refusal does not match original message processing');
      }
      if(p.state==='unknown'&&p.failure===reason&&m.state==='unknown'&&!writerProof&&p.preTurnProof?.status!=='attempting')return;
      const now=this.deps.clock.now();
      const preTurnProof:PreTurnProof|null=writerProof?preTurnProofSchema.parse({...writerProof,
        observedAtUtc:now,status:'observed',decisionOperationId:null,reviewerActorId:null,evidenceRef:null}):
        p.preTurnProof?.status==='attempting'?{...p.preTurnProof,status:'consumed'}:p.preTurnProof??null;
      await store.updateSessionMessageProcessing({...p,state:'unknown',failure:reason.slice(0,4000),preTurnProof,
        version:p.version+1,updatedAt:now},p.version);
      if(m.state!=='unknown')await store.updateSessionMessage({...m,state:'unknown',version:m.version+1,updatedAt:now},m.version);
    });
  }
  async approvePreTurnContinuation(projectId:string,messageId:string,principal:Principal,
    command:{operationId:string;sessionId:string;originalOperationId:string;expectedVersion:number;
      expectedMessageVersion:number;expectedGateVersion:number;evidenceRef:string;reason:string}):Promise<SessionMessageProcessing>{
    if(!principal.projectIds.includes(projectId)||!principal.permissions.includes('review')||principal.actorId.startsWith('worker-'))
      throw new DomainError('FORBIDDEN','pre-turn continuation requires project review authority');
    return this.deps.uow.transaction(projectId,async tx=>{
      const intentJson=reviewIntentJson(principal.actorId,'message',messageId,command);
      const prior=await priorReviewDecision<SessionMessageProcessing>(tx,command.operationId,
        principal.actorId,'message',messageId,intentJson);
      if(prior)return prior;
      const store=required(tx.sessionMessages??null,'message store');
      const message=required(await store.getSessionMessage(messageId),'message');
      const processing=required(await store.getSessionMessageProcessing(messageId),'processing');
      const session=required(await tx.getRuntimeSession(processing.sessionId),'Session');
      const gate=required(await tx.recovery?.lockRecoveryGate(session.id)??null,'recovery gate');
      const proof=processing.preTurnProof;
      const grant=await this.deps.grantFor(message,session);
      if(message.version!==command.expectedMessageVersion||processing.version!==command.expectedVersion||
        message.state!=='unknown'||processing.state!=='unknown'||processing.nativeTurnId||
        processing.sessionId!==command.sessionId||processing.operationId!==command.originalOperationId||
        message.target.kind!=='owned'||message.target.sessionId!==session.id||
        !proof||proof.status!=='observed'||proof.threadId!==session.nativeThreadId||proof.operationId!==processing.operationId||
        gate.version!==command.expectedGateVersion||gate.phase!=='blocked'||gate.causeKind!=='message'||gate.causeId!==message.id||
        session.state!=='ready'||session.executionProfile?.activationState!=='active'||
        !grant?.enabled||grant.projectId!==projectId||grant.sessionId!==session.id||grant.cwd!==session.cwd||
        grant.receiverActorId!==processing.receiverActorId||grant.senderActorId!==message.senderActorId)
        throw new DomainError('PRE_TURN_CONTINUATION_CHANGED','original refusal, grant, profile or gate changed');
      const next={...processing,version:processing.version+1,updatedAt:this.deps.clock.now(),
        preTurnProof:preTurnProofSchema.parse({...proof,status:'approved',decisionOperationId:command.operationId,
          reviewerActorId:principal.actorId,evidenceRef:command.evidenceRef,
          decisionReason:command.reason,gateVersionAtApproval:gate.version})};
      await tx.appendRuntimeEvent({projectId,id:this.deps.ids.next(),runId:null,sessionId:session.id,
        kind:'message.preTurnReviewed',detail:JSON.stringify({messageId:message.id,
          decisionOperationId:command.operationId,originalOperationId:processing.operationId,
          requestId:proof.requestId,observedAtUtc:proof.observedAtUtc,
          evidenceRef:command.evidenceRef,reason:command.reason}),
        nativeTurnId:null,cursor:null,itemsDigest:null,actorId:principal.actorId,createdAt:this.deps.clock.now()});
      await store.updateSessionMessageProcessing(next,processing.version);
      await tx.insertPreTurnReviewDecision({operationId:command.operationId,actorId:principal.actorId,
        kind:'message',subjectId:messageId,intentJson,result:next});
      return next;
    });
  }
  async readPreTurnContinuationDecision(projectId:string,messageId:string,principal:Principal,
    command:Parameters<SessionMessageService['approvePreTurnContinuation']>[3]):Promise<SessionMessageProcessing|null>{
    if(!principal.projectIds.includes(projectId)||!principal.permissions.includes('review')||principal.actorId.startsWith('worker-'))
      throw new DomainError('FORBIDDEN','pre-turn continuation requires project review authority');
    return this.deps.uow.read(projectId,reader=>priorReviewDecision<SessionMessageProcessing>(reader,
      command.operationId,principal.actorId,'message',messageId,
      reviewIntentJson(principal.actorId,'message',messageId,command)));
  }
  async claimPreTurnContinuation(projectId:string,messageId:string):Promise<SessionMessageProcessing|null>{
    return this.deps.uow.transaction(projectId,async tx=>{
      const store=required(tx.sessionMessages??null,'message store');
      const p=required(await store.getSessionMessageProcessing(messageId),'processing');
      if(p.state!=='unknown'||p.preTurnProof?.status!=='approved'||p.nativeTurnId)return null;
      const message=required(await store.getSessionMessage(messageId),'message');
      const session=required(await tx.getRuntimeSession(p.sessionId),'Session');
      const gate=required(await tx.recovery?.lockRecoveryGate(session.id)??null,'recovery gate');
      const grant=await this.deps.grantFor(message,session);
      if(message.state!=='unknown'||gate.phase!=='blocked'||gate.causeKind!=='message'||gate.causeId!==message.id||
        gate.version!==p.preTurnProof.gateVersionAtApproval||
        session.state!=='ready'||session.nativeThreadId!==p.preTurnProof.threadId||
        session.executionProfile?.activationState!=='active'||!grant?.enabled||grant.projectId!==projectId||
        grant.cwd!==session.cwd||grant.receiverActorId!==p.receiverActorId||
        grant.senderActorId!==message.senderActorId||grant.sessionId!==session.id)return null;
      const next={...p,version:p.version+1,updatedAt:this.deps.clock.now(),
        preTurnProof:preTurnProofSchema.parse({...p.preTurnProof,status:'attempting'})};
      await store.updateSessionMessageProcessing(next,p.version);
      return next;
    });
  }
  /** An explicit native rejection or pre-turn policy drift proves no Turn was accepted. */
  async failBeforeStart(projectId:string,messageId:string,reason:string):Promise<void>{
    await this.deps.uow.transaction(projectId,async tx=>{
      const store=tx.sessionMessages!;const p=required(await store.getSessionMessageProcessing(messageId),'processing');
      if(p.state!=='dispatching'||p.nativeTurnId)throw new DomainError('PROCESSING_STATE','cannot reject an uncertain or started native Turn');
      const m=required(await store.getSessionMessage(messageId),'message');
      if(m.state!=='processing')throw new DomainError('MESSAGE_STATE','message is not dispatching');
      const now=this.deps.clock.now();
      await store.updateSessionMessageProcessing({...p,state:'failed',failure:reason.slice(0,4000),version:p.version+1,updatedAt:now},p.version);
      await store.updateSessionMessage({...m,state:'failed',version:m.version+1,updatedAt:now},m.version);
    });
  }
  async settle(projectId:string,messageId:string,turn:RuntimeTurn,response:string|null):Promise<void>{
    await this.deps.uow.transaction(projectId,async tx=>{
      const store=tx.sessionMessages!;const p=required(await store.getSessionMessageProcessing(messageId),'processing');
      if(!turn.completedAtUtc||!['completed','failed','interrupted'].includes(turn.status)||p.nativeTurnId!==turn.id)
        throw new DomainError('TURN_NOT_SETTLED','exact native Turn completion is required');
      if(['completed','failed'].includes(p.state))return;
      const now=this.deps.clock.now();const ok=turn.status==='completed';const visible=!!response?.trim();
      await store.updateSessionMessageProcessing({...p,state:ok?'completed':'failed',response:ok&&visible?response!.slice(0,65536):null,
        failure:ok?null:(turn.error?.summary??`Native Turn ${turn.status}`).slice(0,4000),version:p.version+1,updatedAt:now},p.version);
      const m=required(await store.getSessionMessage(messageId),'message');
      await store.updateSessionMessage({...m,state:ok?(visible?'replied':'completed_without_reply'):'failed',version:m.version+1,updatedAt:now},m.version);
      await store.markSessionMessageSettled(p.sessionId,messageId,now);
    });
  }
}
