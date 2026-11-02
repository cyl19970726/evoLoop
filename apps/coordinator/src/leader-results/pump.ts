import type { Operation, Principal, RuntimeSessionRecord } from "@evoloop/contracts";
import type { RoleRecord } from "@evoloop/contracts/roles";
import type { SessionMessageRecord } from "@evoloop/contracts/session-messages";
import type { WorkflowService } from "@evoloop/core";
import type { SessionMessageService } from "@evoloop/core/session-messages";

export interface LeaderResultRecipient {
  sessionId: string;
  receiverRoleId: string;
  receiverActorId: string;
  senderActorId: string;
}

/** Only the PG source triggers below can create an inbox row. */
export interface LeaderResultNotice {
  projectId: string;
  id: string;
  kind: "task_todo"|"delivery"|"observation"|"task_question"|"task_blocker"|
    "run_without_submission"|"run_submission_blocked";
  sourceEventId: string;
  sourceSessionId: string | null;
  sourceActorId: string | null;
  occurredAt: string;
  sourceRef: string;
  taskId: string;
  taskRevisionId: string;
  stale: boolean;
  state: "pending"|"linked"|"blocked";
  messageId: string;
  operationId: string;
  recipient: LeaderResultRecipient | null;
}

export interface LeaderResultNoticeStore {
  /** Blocked rows require an explicit source/operation review and requeue; they are never retried by this pump. */
  listPending(projectId: string, query: {limit:number;cursor?:string}): Promise<{items:LeaderResultNotice[];nextCursor:string|null}>;
  getByMessageId(projectId: string, messageId: string): Promise<LeaderResultNotice | null>;
  hasInFlightOnOtherSession(projectId: string, sessionId: string): Promise<boolean>;
  /** Pending reasons are diagnostic and retryable; null clears a resolved reason. */
  notePendingReason(projectId: string, noticeId: string, reason: string | null): Promise<void>;
  block(projectId: string, noticeId: string, reason: string): Promise<void>;
  /** First successful pin wins; later calls return that exact pin. */
  pinRecipient(projectId: string, noticeId: string, recipient: LeaderResultRecipient): Promise<LeaderResultNotice | null>;
  markPosted(projectId: string, noticeId: string, messageId: string, sessionId:string): Promise<void>;
}

export interface LeaderResultNoticeConfig {
  enabled: boolean;
  targets: Array<{projectId:string;sessionId:string;receiverRoleId:string;receiverActorId:string;senderActorId:string}>;
}

export interface LeaderResultNoticePumpDeps {
  store: LeaderResultNoticeStore;
  workflow: Pick<WorkflowService,"listRoles"|"listRuntimeSessions"|"execute"|"getOperation">;
  messages: Pick<SessionMessageService,"get">;
  configuration(): Promise<LeaderResultNoticeConfig | undefined>;
  principals(): Promise<Principal[]>;
  canExecuteSession(session: RuntimeSessionRecord): Promise<boolean>;
  hasMessageGrant(input: {projectId:string;session:RuntimeSessionRecord;senderActorId:string;receiverActorId:string}): Promise<boolean>;
  readTaskFacts(projectId:string,taskId:string):Promise<{currentRevisionId:string;state:string;assigned:boolean}|null>;
  canWrite(): boolean;
  canStartNative(): boolean;
  pollIntervalMs: number;
  onError(error: unknown): void;
  onDiagnostic?(projectId: string, noticeId: string, reason: string): void;
}

function contentOf(notice: LeaderResultNotice): string {
  const label:Record<LeaderResultNotice["kind"],string>={task_todo:"A Task was created for Leader triage",
    delivery:"A fixed Delivery was recorded",observation:"An independent use observation was recorded",
    task_question:"A Task recipient asked a question",task_blocker:"A Task recipient reported a blocker",
    run_without_submission:"A terminal Run has no signed submission",
    run_submission_blocked:"A signed Run submission cannot be sealed"};
  return `${label[notice.kind]}.\nSource event: ${notice.sourceEventId} at ${notice.occurredAt}\nSource Task revision: ${notice.taskId}@${notice.taskRevisionId}\nSource actor: ${notice.sourceActorId ?? "unverified"}; source Session: ${notice.sourceSessionId ?? "unverified"}\nSource: ${notice.sourceRef}\nThis is a historical source event that may have been superseded. Next responsibility: Leader reads the current Task, fixed source and any existing arrangement, then saves the next decision. This notice is not current acceptance, consumer use, or Task closure.`;
}

type Eligibility={recipient:LeaderResultRecipient;reason:null}|{recipient:null;reason:string};

function sameRecipient(a: LeaderResultRecipient, b: LeaderResultRecipient): boolean {
  return a.sessionId===b.sessionId && a.receiverRoleId===b.receiverRoleId &&
    a.receiverActorId===b.receiverActorId && a.senderActorId===b.senderActorId;
}

export class LeaderResultNoticePump {
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy: Promise<void> | null = null;
  private cursors=new Map<string,string>();
  private diagnosed=new Set<string>();
  constructor(private readonly deps: LeaderResultNoticePumpDeps) {}

  start(): void {
    if(this.timer)return;
    this.timer=setInterval(()=>{void this.tick();},this.deps.pollIntervalMs);
    this.timer.unref();
    void this.tick();
  }
  stop(): void { if(this.timer)clearInterval(this.timer);this.timer=null; }
  tick(): Promise<void> {
    if(this.busy)return this.busy;
    this.busy=this.cycle().catch(this.deps.onError).finally(()=>{this.busy=null;});
    return this.busy;
  }

  /** Called by the existing message pump immediately before a queued notice can start. */
  async canStartMessage(message: SessionMessageRecord): Promise<boolean> {
    const notice=await this.deps.store.getByMessageId(message.projectId,message.id);
    if(!notice)return true;
    if(notice.state==="blocked"||!notice.recipient||notice.messageId!==message.id||
      message.target.kind!=="owned"||message.target.sessionId!==notice.recipient.sessionId||
      message.senderActorId!==notice.recipient.senderActorId)return false;
    if(notice.kind==="task_todo"){
      const task=await this.deps.readTaskFacts(message.projectId,notice.taskId);
      if(!task||notice.stale||task.currentRevisionId!==notice.taskRevisionId||
        task.state!=="todo"||task.assigned)return false;
    }
    const config=await this.deps.configuration();
    if(!config?.enabled)return false;
    const current=await this.eligibleRecipient(message.projectId,config,await this.deps.principals());
    return !!current.recipient&&sameRecipient(current.recipient,notice.recipient)&&
      !await this.deps.store.hasInFlightOnOtherSession(message.projectId,notice.recipient.sessionId);
  }

  private async roles(principal: Principal, projectId: string): Promise<RoleRecord[]> {
    const roles: RoleRecord[]=[];
    let cursor: string | undefined;
    do {
      const page=await this.deps.workflow.listRoles(principal,projectId,100,cursor);
      roles.push(...page.items);
      cursor=page.nextCursor??undefined;
    } while(cursor);
    return roles;
  }

  private async eligibleRecipient(projectId: string, config: LeaderResultNoticeConfig,
    principals: Principal[]): Promise<Eligibility> {
    const target=config.targets.find(value=>value.projectId===projectId);
    if(!target)return {recipient:null,reason:"LEADER_TARGET_UNCONFIGURED"};
    if(target.senderActorId===target.receiverActorId)return {recipient:null,reason:"LEADER_ACTORS_IDENTICAL"};
    const sender=principals.find(p=>p.actorId===target.senderActorId&&p.projectIds.includes(projectId)&&
      p.permissions.includes("read")&&p.permissions.includes("write"));
    const receiver=principals.find(p=>p.actorId===target.receiverActorId&&p.projectIds.includes(projectId)&&
      p.permissions.includes("read")&&p.permissions.includes("write")&&p.permissions.includes("review"));
    if(!sender)return {recipient:null,reason:"NOTICE_SENDER_UNAVAILABLE"};
    if(!receiver)return {recipient:null,reason:"LEADER_RECEIVER_UNAVAILABLE"};
    const roles=(await this.roles(sender,projectId)).filter(role=>role.proposal.templateKey==="lead"&&
      role.proposal.roleClass==="system"&&(role.state==="trial"||role.state==="active"));
    if(roles.length!==1)return {recipient:null,reason:roles.length?"LEADER_ROLE_AMBIGUOUS":"LEADER_ROLE_UNAVAILABLE"};
    if(roles[0]!.id!==target.receiverRoleId)return {recipient:null,reason:"LEADER_ROLE_MISMATCH"};
    const sessions=(await this.deps.workflow.listRuntimeSessions(sender,projectId)).filter(session=>
      session.roleId===target.receiverRoleId&&session.state==="ready"&&
      !!session.nativeThreadId&&!!session.nativeSessionId);
    if(sessions.length!==1)return {recipient:null,reason:sessions.length?"LEADER_SESSION_AMBIGUOUS":"LEADER_SESSION_UNAVAILABLE"};
    if(sessions[0]!.id!==target.sessionId)return {recipient:null,reason:"LEADER_SESSION_MISMATCH"};
    const session=sessions[0]!;
    if(!await this.deps.canExecuteSession(session))return {recipient:null,reason:"LEADER_EXECUTION_AUTHORITY_MISSING"};
    if(!await this.deps.hasMessageGrant({projectId,session,senderActorId:sender.actorId,receiverActorId:receiver.actorId}))
      return {recipient:null,reason:"MESSAGE_GRANT_MISSING"};
    return {recipient:{sessionId:session.id,receiverRoleId:session.roleId,receiverActorId:receiver.actorId,
      senderActorId:sender.actorId},reason:null};
  }

  private async cycle(): Promise<void> {
    if(!this.deps.canWrite())return;
    const config=await this.deps.configuration();
    if(!config?.enabled)return;
    const principals=await this.deps.principals();
    for(const projectId of new Set(principals.flatMap(principal=>principal.projectIds))){
      if(!this.deps.canWrite())return;
      let page=await this.deps.store.listPending(projectId,{limit:50,...(this.cursors.has(projectId)?{cursor:this.cursors.get(projectId)!}:{})});
      if(!page.items.length&&this.cursors.has(projectId)){
        this.cursors.delete(projectId);
        page=await this.deps.store.listPending(projectId,{limit:50});
      }
      if(page.nextCursor)this.cursors.set(projectId,page.nextCursor);
      else this.cursors.delete(projectId);
      for(const notice of page.items){
        if(!this.deps.canWrite())return;
        try { await this.process(notice,config,principals); }
        catch(error){this.deps.onError(error);}
      }
    }
  }

  private async process(notice: LeaderResultNotice, config: LeaderResultNoticeConfig,
    principals: Principal[]): Promise<void> {
    if(notice.state!=="pending")return;
    if(notice.recipient){
      const originalSender=this.sender(principals,notice.projectId,notice.recipient.senderActorId);
      if(originalSender){
        const original=await this.deps.workflow.getOperation(originalSender,notice.projectId,notice.operationId);
        if(original){await this.reconcile(notice,notice.recipient,original);return;}
      }
    }
    const task=await this.deps.readTaskFacts(notice.projectId,notice.taskId);
    if(!task){await this.reason(notice,"TASK_UNAVAILABLE");return;}
    if(notice.kind==="task_todo"&&(notice.stale||task.currentRevisionId!==notice.taskRevisionId||
      task.state!=="todo"||task.assigned)){
      await this.deps.store.block(notice.projectId,notice.id,"TODO_ALREADY_ARRANGED_OR_SUPERSEDED");return;
    }
    const eligibility=await this.eligibleRecipient(notice.projectId,config,principals);
    if(!eligibility.recipient){await this.reason(notice,eligibility.reason);return;}
    const eligible=eligibility.recipient;
    if(!this.deps.canStartNative()){
      await this.reason(notice,"NATIVE_RUNTIME_UNAVAILABLE");return;
    }
    if(notice.recipient&&!sameRecipient(notice.recipient,eligible)){
      await this.reason(notice,"PINNED_RECIPIENT_CHANGED");return;
    }
    if(await this.otherLeaderBusy(notice,eligible.sessionId)){
      await this.reason(notice,"OLD_LEADER_NOTICE_IN_FLIGHT");return;
    }
    await this.reason(notice,null);
    let fixed=notice;
    if(!fixed.recipient){
      const pinned=await this.deps.store.pinRecipient(notice.projectId,notice.id,eligible);
      if(pinned?.state!=="pending"||!pinned.recipient)return;
      fixed=pinned;
    }
    const recipient=fixed.recipient!;
    if(!sameRecipient(recipient,eligible)){
      await this.reason(notice,"PINNED_RECIPIENT_CHANGED");return;
    }
    const sender=this.sender(principals,notice.projectId,recipient.senderActorId);
    if(!sender){await this.reason(notice,"NOTICE_SENDER_UNAVAILABLE");return;}
    const command=this.command(notice,recipient);
    // The fixed operation may have committed before a response was lost.
    let operation=await this.deps.workflow.getOperation(sender,notice.projectId,notice.operationId);
    if(!operation&&this.deps.canWrite()){
      try{await this.deps.workflow.execute(sender,command);}catch{ /* Read the original journal below. */ }
      operation=await this.deps.workflow.getOperation(sender,notice.projectId,notice.operationId);
    }
    if(!operation){await this.reason(notice,"MESSAGE_POST_UNCONFIRMED");return;}
    await this.reconcile(notice,recipient,operation);
  }

  private sender(principals:Principal[],projectId:string,actorId:string):Principal|null{
    return principals.find(p=>p.actorId===actorId&&p.projectIds.includes(projectId)&&
      p.permissions.includes("read")&&p.permissions.includes("write"))??null;
  }

  private command(notice:LeaderResultNotice,recipient:LeaderResultRecipient){
    return {type:"session.message.post" as const,projectId:notice.projectId,
      operationId:notice.operationId,messageId:notice.messageId,
      target:{kind:"owned" as const,sessionId:recipient.sessionId},
      context:{taskId:notice.taskId,taskRevisionId:notice.taskRevisionId},content:contentOf(notice)};
  }

  private async reconcile(notice:LeaderResultNotice,recipient:LeaderResultRecipient,operation:Operation):Promise<void>{
    const command=this.command(notice,recipient);
    if(operation.commandType!==command.type||operation.result.status!=="applied"||
      operation.result.entityId!==notice.messageId){
      await this.reason(notice,operation.result.status==="rejected"?`MESSAGE_POST_REJECTED:${operation.result.code}`:
        "MESSAGE_OPERATION_MISMATCH");
      return;
    }
    const saved:SessionMessageRecord=await this.deps.messages.get(notice.projectId,notice.messageId);
    if(saved.operationId!==notice.operationId||saved.senderActorId!==recipient.senderActorId||
      saved.target.kind!=="owned"||saved.target.sessionId!==recipient.sessionId||
      saved.content!==command.content||saved.context?.taskId!==notice.taskId||
      saved.context?.taskRevisionId!==notice.taskRevisionId){
      await this.reason(notice,"MESSAGE_IDENTITY_MISMATCH");return;
    }
    await this.reason(notice,null);
    await this.deps.store.markPosted(notice.projectId,notice.id,notice.messageId,recipient.sessionId);
  }

  private async reason(notice:LeaderResultNotice,reason:string|null):Promise<void>{
    await this.deps.store.notePendingReason(notice.projectId,notice.id,reason);
  }

  private async otherLeaderBusy(notice:LeaderResultNotice,sessionId:string):Promise<boolean>{
    const busy=await this.deps.store.hasInFlightOnOtherSession(notice.projectId,sessionId);
    const key=`${notice.projectId}:${notice.id}`;
    if(busy&&!this.diagnosed.has(key)){
      this.diagnosed.add(key);
      this.deps.onDiagnostic?.(notice.projectId,notice.id,"OLD_LEADER_NOTICE_IN_FLIGHT");
    }
    if(!busy)this.diagnosed.delete(key);
    return busy;
  }
}
