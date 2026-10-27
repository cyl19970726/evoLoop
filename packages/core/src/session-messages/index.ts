import type { AppliedResult, Principal } from "@evoloop/contracts";
import type { SessionMessageCommand, SessionMessageDispatchGrant, SessionMessageProcessing, SessionMessageRecord } from "@evoloop/contracts/session-messages";
import type { RuntimeTurn, RuntimeSessionRecord } from "@evoloop/contracts/runtime";
import type { Clock, IdFactory, Reader, Transaction, UnitOfWork } from "@evoloop/contracts/ports";
import { DomainError } from "@evoloop/contracts/ports";

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
  if(item.target.kind!=='owned')throw new DomainError('MANUAL_PENDING','external message has no automatic recipient read receipt');
  const processing=await store.getSessionMessageProcessing(item.id);
  if(!processing?.receiverActorId||principal.actorId!==processing.receiverActorId)
    throw new DomainError('MESSAGE_RECIPIENT','only the granted receiving actor may record its read');
  if(!processing.nativeTurnId||!['completed','failed'].includes(processing.state)||
    !['replied','completed_without_reply','failed'].includes(item.state))
    throw new DomainError('MESSAGE_NOT_RECEIVED','a real native Turn must settle before receipt');
  if(item.readReceipt)throw new DomainError('RECEIPT_EXISTS','read receipt already recorded');
  await store.insertSessionMessageReadReceipt(item.id,principal.actorId,command.evidence,now);
  return{result:applied(command.operationId,item.id,item.version),effects:[{kind:'session.message.read',entityId:item.id,version:item.version}]};
}

export interface SessionMessageServiceDeps {uow:UnitOfWork;clock:Clock;ids:IdFactory;
  grantFor(message:SessionMessageRecord,session:RuntimeSessionRecord):Promise<SessionMessageDispatchGrant|null>;
}
/** Trusted coordinator path. No public command can claim a native turn or change processing evidence. */
export class SessionMessageService {
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
  async detail(projectId:string,id:string):Promise<{message:SessionMessageRecord;processing:SessionMessageProcessing|null}>{
    return this.deps.uow.read(projectId,async r=>{
      const store=r.sessionMessages;
      const message=required(await store?.getSessionMessage(id)??null,'message');
      const processing=await store?.getSessionMessageProcessing(id)??null;
      return{message,processing};
    });
  }
  async list(projectId:string,target:SessionMessageRecord['target'],limit:number,cursor?:string){
    return this.deps.uow.read(projectId,async r=>r.sessionMessages?.listSessionMessages(target,limit,cursor)??{items:[],nextCursor:null});
  }
  async pending(projectId:string,limit=30,offset=0){return this.deps.uow.read(projectId,async r=>r.sessionMessages?.listPendingSessionMessages(limit,offset)??[]);}
  async processing(projectId:string,messageId:string){return this.deps.uow.read(projectId,async r=>r.sessionMessages?.getSessionMessageProcessing(messageId)??null);}
  async session(projectId:string,sessionId:string){return this.deps.uow.read(projectId,async r=>required(await r.getRuntimeSession(sessionId),'Session'));}
  async mustYieldBusiness(projectId:string,sessionId:string){return this.deps.uow.read(projectId,async r=>await r.sessionMessages?.mustYieldBusiness(sessionId)??false);}
  async isBusy(projectId:string,sessionId:string){return this.deps.uow.read(projectId,async r=>await r.sessionMessages?.hasActiveSessionMessage(sessionId)??false);}
  async noteBlocked(projectId:string,messageId:string,reason:string|null){await this.deps.uow.transaction(projectId,async tx=>{
    await tx.sessionMessages?.setSessionMessageBlockedReason(messageId,reason);});}
  async beginDispatch(projectId:string,messageId:string,processingId:string,operationId:string,readOnlyPolicyFingerprint:string):Promise<SessionMessageProcessing>{
    return this.deps.uow.transaction(projectId,async tx=>{
      if(!/^[a-f0-9]{64}$/.test(readOnlyPolicyFingerprint))throw new DomainError('POLICY_PROOF_MISSING','Session execution admission fingerprint is required');
      const {item,session,grant}=await this.admission(projectId,messageId,tx);
      const store=tx.sessionMessages!;
      await store.assertSessionVacant(session.id);
      await tx.recovery?.assertStartupAllowed(session.id,'message',messageId);
      const now=this.deps.clock.now();
      const processing:SessionMessageProcessing={projectId,id:processingId,messageId,sessionId:session.id,operationId,
        receiverActorId:grant.receiverActorId,
        state:'dispatching',nativeTurnId:null,response:null,failure:null,readOnlyPolicyFingerprint,
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
      await store.updateSessionMessageProcessing({...p,state:'running',nativeTurnId:turn.id,version:p.version+1,updatedAt:this.deps.clock.now()},p.version);
      const m=required(await store.getSessionMessage(messageId),'message');
      if(m.state==='unknown')await store.updateSessionMessage({...m,state:'processing',version:m.version+1,updatedAt:this.deps.clock.now()},m.version);
    });
  }
  async markUnknown(projectId:string,messageId:string,reason:string):Promise<void>{
    await this.deps.uow.transaction(projectId,async tx=>{
      const store=tx.sessionMessages!;const p=required(await store.getSessionMessageProcessing(messageId),'processing');
      if(['completed','failed'].includes(p.state))return;
      const m=required(await store.getSessionMessage(messageId),'message');
      if(p.state==='unknown'&&p.failure===reason&&m.state==='unknown')return;
      const now=this.deps.clock.now();
      await store.updateSessionMessageProcessing({...p,state:'unknown',failure:reason.slice(0,4000),version:p.version+1,updatedAt:now},p.version);
      if(m.state!=='unknown')await store.updateSessionMessage({...m,state:'unknown',version:m.version+1,updatedAt:now},m.version);
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
