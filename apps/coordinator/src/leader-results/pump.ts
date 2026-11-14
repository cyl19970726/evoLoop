import type { Operation, Principal, RuntimeSessionRecord } from "@evoloop/contracts";
import { createHash } from "node:crypto";
import type { RoleRecord } from "@evoloop/contracts/roles";
import type { SessionMessageRecord } from "@evoloop/contracts/session-messages";
import { leaderNoticePostCommand } from "@evoloop/contracts/leader-notices";
import type { WorkflowService } from "@evoloop/core";
import { canonicalJson } from "@evoloop/core";
import type { SessionMessageService } from "@evoloop/core/session-messages";
import { randomUUID } from "node:crypto";
import type { LeaderNoticeCandidate } from "@evoloop/contracts/leader-notice-packets";
import type { LeaderPacketPorts } from "./packet-ports.js";

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
  kind: "task_todo"|"delivery"|"observation"|"observation_used"|"observation_failed"|"line_entry_suspended"|"line_confirmation_returned"|"direct_dispatch_blocked"|"direct_circuit_open"|"schedule_skips_escalated"|"task_question"|"task_blocker"|
    "run_without_submission"|"run_submission_blocked"|"task_attention"|"acceptance_blocked";
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
  disposeStalePendingTodo(projectId:string,noticeId:string):Promise<"disposed"|"current"|"posted"|"linked">;
  disposeStaleTodo(projectId:string,noticeId:string,messageId:string):Promise<"disposed"|"in_flight"|"current">;
  attentionSourceCurrent(projectId:string,noticeId:string):Promise<"current"|"unknown"|"expired">;
  disposeStaleAttention(projectId:string,noticeId:string):Promise<"current"|"unknown"|"expired">;
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
  /** Notices created from now on travel in packets (private configuration, default off). */
  packets?: boolean;
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
  /** Packet delivery (DEC-045 W1). Absent: notices keep the one-notice-one-message path only. */
  packets?: LeaderPacketPorts;
  /** The earliest waiting notice must have waited this long (database time) before a packet is built. */
  packetDebounceSeconds?: number;
}

const noticeLabel: Record<string,string> = {task_todo:"新 Task 待分诊",delivery:"已记录固定交付",observation:"已记录独立使用观察",observation_used:"独立使用观察：已使用",observation_failed:"独立使用观察：失败或未使用（需要处理）",line_entry_suspended:"Session 队伍项挂起（无法开始）",line_confirmation_returned:"Session 退回了执行确认",direct_dispatch_blocked:"定时直派受阻或等待过久",direct_circuit_open:"定时直派熔断，已退回交 Leader",schedule_skips_escalated:"定时任务连续跳过",
  task_question:"Task 接收者提了问题",task_blocker:"Task 接收者报告阻塞",run_without_submission:"终态 Run 没有已签提交",
  run_submission_blocked:"已签提交无法封存",task_attention:"Task 关注项需要 Leader 跟进",acceptance_blocked:"验收交接受阻"};
/** One packet message carries at most this many bytes (design: 8 KB) and this many items. */
const PACKET_BYTE_BUDGET = 8192, PACKET_ITEMS = 20, SCAN_PAGE = 50, SCAN_PAGES = 10;
export function packetContent(projectId:string, packetId:string, items:Array<LeaderNoticeCandidate & {readBefore:boolean}>):string{
  const head=`Leader 通知包 ${packetId}（${items.length} 项）。每一项是一条历史来源事件，可能已被后续情况取代：先读当前 Task、固定来源和已有安排，再给出下一步决定。`+
    `\n处理方式：读 get /api/projects/${projectId}/leader-notice-packets/${packetId} 取得每项的版本，再用 command run 提交 leader.notice.handle（noticeId、expectedVersion、disposition=handled 或 deferred，deferred 要写 notBefore）。读到这包的这一轮正常结束只算“已看到”，用这条命令处置或延后后才算“已处理”。`;
  const mark=(item:{readBefore:boolean})=>item.readBefore?"（上一轮已读到过）":"";
  // Three renderings of one item, richest first: full, a summary line, and the id alone. Every item has at least its id; the "read before" mark is never dropped.
  const forms=items.map((item,index)=>[
    `${index+1}. [${item.level==="immediate"?"立即·":""}${noticeLabel[item.kind]??item.kind}] 通知 ${item.noticeId}${mark(item)}\n   Task ${item.taskId}@${item.taskRevisionId}；来源 ${item.sourceRef}；事件 ${item.sourceEventId}，发生于 ${item.occurredAt}；操作者 ${item.sourceActorId??"未核实"}`,
    `${index+1}. ${item.kind} 通知 ${item.noticeId}${mark(item)} Task ${item.taskId}（摘要，详情读通知）`,
    `${index+1}. 通知 ${item.noticeId}${mark(item)}（仅编号，详情读通知）`]);
  const size=(text:string)=>Buffer.byteLength(text,"utf8")+1;
  const chosen=forms.map(form=>form[2]!);
  let bytes=Buffer.byteLength(head,"utf8")+chosen.reduce((sum,line)=>sum+size(line),0);
  // Upgrade items in order while the whole text still fits the budget.
  forms.forEach((form,index)=>{
    for(const candidate of [form[0]!,form[1]!]){
      const next=bytes-size(chosen[index]!)+size(candidate);
      if(next<=PACKET_BYTE_BUDGET){chosen[index]=candidate;bytes=next;break;}
    }
  });
  return `${head}\n${chosen.join("\n")}`;
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
    return (await this.messageAdmission(message)).allowed;
  }

  /** Whether this exact queued message came from a durable Leader result notice, one by one or in a packet. */
  async isNoticeMessage(projectId: string, messageId: string): Promise<boolean> {
    return !!(await this.deps.store.getByMessageId(projectId, messageId)) ||
      !!(await this.deps.packets?.packetByMessage(projectId, messageId));
  }

  /** Separate a superseded source from a changed Leader target. A linked
   * message is retired only by the store's transactional native-start guard. */
  async messageAdmission(message:SessionMessageRecord):Promise<{allowed:boolean;reason:string|null}> {
    const notice=await this.deps.store.getByMessageId(message.projectId,message.id);
    if(!notice){
      // A packet message. The message pump asks the same questions the packet pump does: is this still the Leader's Session, are notices on and
      // the target usable, and is no person's message waiting (that goes first; the packet pump then withdraws the unstarted packet).
      const packet=await this.deps.packets?.packetByMessage(message.projectId,message.id);
      if(packet){
        if(message.target.kind!=="owned"||message.target.sessionId!==packet.sessionId)return {allowed:false,reason:"PACKET_IDENTITY_CHANGED"};
        const config=await this.deps.configuration();
        if(!config?.enabled)return {allowed:false,reason:"LEADER_NOTICES_DISABLED"};
        const current=await this.eligibleRecipient(message.projectId,config,await this.deps.principals());
        if(!current.recipient)return {allowed:false,reason:current.reason};
        if(current.recipient.sessionId!==packet.sessionId)return {allowed:false,reason:"LEADER_TARGET_CHANGED"};
        const state=await this.deps.packets!.leaderState(message.projectId,packet.sessionId,message.id);
        if(state.humanMessageQueued)return {allowed:false,reason:"HUMAN_MESSAGE_FIRST"};
      }
      return {allowed:true,reason:null};
    }
    if(notice.state==="blocked"||!notice.recipient||notice.messageId!==message.id||
      message.target.kind!=="owned"||message.target.sessionId!==notice.recipient.sessionId||
      message.senderActorId!==notice.recipient.senderActorId)
      return {allowed:false,reason:"NOTICE_IDENTITY_OR_RECIPIENT_CHANGED"};
    if(notice.kind==="task_todo"){
      const task=await this.deps.readTaskFacts(message.projectId,notice.taskId);
      if(!task)return {allowed:false,reason:"TODO_SOURCE_UNKNOWN"};
      if(notice.stale||task.currentRevisionId!==notice.taskRevisionId||
        task.state!=="todo"||task.assigned){
        if(message.state==="queued"&&notice.state==="linked"&&this.deps.canWrite()){
          const result=await this.deps.store.disposeStaleTodo(message.projectId,notice.id,message.id);
          if(result==="disposed")return {allowed:false,reason:null};
          if(result==="in_flight")return {allowed:false,reason:"TODO_MESSAGE_IN_FLIGHT"};
        }
        return {allowed:false,reason:"TODO_SOURCE_SUPERSEDED"};
      }
    }
    if(notice.kind==="task_attention"){
      const state=await this.deps.store.attentionSourceCurrent(message.projectId,notice.id);
      if(state!=="current"){
        if(state==="expired"&&this.deps.canWrite())
          await this.deps.store.disposeStaleAttention(message.projectId,notice.id);
        return {allowed:false,reason:state==="unknown"?"ATTENTION_SOURCE_UNKNOWN":"ATTENTION_SOURCE_EXPIRED"};
      }
    }
    const config=await this.deps.configuration();
    if(!config?.enabled)return {allowed:false,reason:"LEADER_NOTICES_DISABLED"};
    const current=await this.eligibleRecipient(message.projectId,config,await this.deps.principals());
    if(!current.recipient)return {allowed:false,reason:current.reason};
    if(!sameRecipient(current.recipient,notice.recipient))
      return {allowed:false,reason:"LEADER_TARGET_CHANGED"};
    if(await this.deps.store.hasInFlightOnOtherSession(message.projectId,notice.recipient.sessionId))
      return {allowed:false,reason:"OLD_LEADER_NOTICE_IN_FLIGHT"};
    return {allowed:true,reason:null};
  }

  /**
   * Packets (DEC-045 W1). Every open packet of the project is reconciled with what its message did (also after a Leader Session change, a
   * disabled switch or a lost recipient). Stale notices are withdrawn whatever the Leader is doing. When the Leader is idle, no person's
   * message waits, the recovery gate is open and the earliest waiting notice has waited out the debounce, the waiting notices become one packet.
   */
  private async packetCycle(projectId: string, config: LeaderResultNoticeConfig | undefined, principals: Principal[]): Promise<void> {
    const ports=this.deps.packets;
    if(!ports||!this.deps.canWrite())return;
    const enabled=!!config?.enabled;
    await ports.syncMode(projectId,enabled&&config!.packets===true);
    const eligibility:Eligibility=enabled?await this.eligibleRecipient(projectId,config!,principals):{recipient:null,reason:"LEADER_NOTICES_DISABLED"};
    const target=config?.targets.find(value=>value.projectId===projectId);
    const service=target?this.sender(principals,projectId,target.senderActorId):null;
    for(const packet of await ports.openPackets(projectId)){
      try{await this.reconcilePacket(projectId,packet,principals,eligibility,service);}
      catch(error){this.deps.onError(error);}
    }
    if(!eligibility.recipient||!service)return;
    const recipient=eligibility.recipient;
    const { chosen, withdraw } = await this.scanCandidates(projectId);
    // Stale items are withdrawn (recorded, never read) whether or not a packet can be sent now; each batch is judged again in its transaction.
    for(let at=0;at<withdraw.length&&at<5*PACKET_ITEMS;at+=PACKET_ITEMS){
      const packetId=randomUUID();
      const built=await this.deps.workflow.execute(service,{type:"leader.noticePacket.build",projectId,operationId:randomUUID(),sessionId:recipient.sessionId,
        packetId,messageId:randomUUID(),messageOperationId:randomUUID(),content:`Leader 通知包 ${packetId}：${Math.min(PACKET_ITEMS,withdraw.length-at)} 项通知已过时，已撤回，未送达。`,
        recipient:{receiverRoleId:recipient.receiverRoleId,receiverActorId:recipient.receiverActorId,senderActorId:recipient.senderActorId},
        noticeIds:[],debounceSeconds:0,withdraw:withdraw.slice(at,at+PACKET_ITEMS)} as never);
      if(built.status==="rejected"){this.noteBuildRejection(built);break;}
    }
    if(!chosen.length||!this.deps.canStartNative())return;
    if((await ports.openPackets(projectId)).length)return;
    const state=await ports.leaderState(projectId,recipient.sessionId);
    if(state.busy||state.humanMessageQueued||!state.gateOpen)return;
    // An immediate notice (W5) does not wait out the debounce: the Leader is idle, no person's message waits and the gate is open, so this is the
    // next moment it can be delivered. The candidates come immediate first, so it is at the front of the packet and the waiting digest notices follow.
    const immediate=chosen.some(item=>item.level==="immediate");
    const debounce=immediate?0:this.deps.packetDebounceSeconds??60;
    if(!immediate&&Math.max(...chosen.map(item=>item.waitedSeconds))<debounce)return;
    const packetId=randomUUID(),messageId=randomUUID(),operationId=randomUUID();
    const content=packetContent(projectId,packetId,chosen);
    const built=await this.deps.workflow.execute(service,{type:"leader.noticePacket.build",projectId,operationId:randomUUID(),sessionId:recipient.sessionId,
      packetId,messageId,messageOperationId:operationId,content,
      recipient:{receiverRoleId:recipient.receiverRoleId,receiverActorId:recipient.receiverActorId,senderActorId:recipient.senderActorId},
      noticeIds:chosen.map(item=>item.noticeId),debounceSeconds:debounce,withdraw:[]} as never);
    if(built.status==="rejected"){this.noteBuildRejection(built);return;}
    await this.postPacket(projectId,packetId,principals,service,recipient);
  }

  private noteBuildRejection(built:{code:string;message:string}):void{
    // Expected races (another step won, a notice changed): the next cycle looks again.
    if(!["PACKET_NOT_DUE","PACKET_IN_FLIGHT","NOTICE_NOT_PENDING","NOTICE_STALE","NOTICE_CURRENT"].includes(built.code))
      this.deps.onError(new Error(`leader packet build ${built.code}: ${built.message}`));
  }

  /** Read waiting notices page by page (stale or undecidable ones in front never hide the later ones) until a packet is full. */
  private async scanCandidates(projectId:string):Promise<{chosen:Array<LeaderNoticeCandidate>;withdraw:Array<{noticeId:string;reason:string}>}>{
    const chosen:LeaderNoticeCandidate[]=[], withdraw:Array<{noticeId:string;reason:string}>=[];
    for(let page=0;page<SCAN_PAGES&&chosen.length<PACKET_ITEMS;page++){
      const { items } = await this.deps.packets!.candidates(projectId,{limit:SCAN_PAGE,offset:page*SCAN_PAGE});
      for(const item of items){
        if(chosen.length>=PACKET_ITEMS)break;
        const reason=await this.staleReason(projectId,item);
        if(reason==="unknown")continue;
        if(reason)withdraw.push({noticeId:item.noticeId,reason});else chosen.push(item);
      }
      if(items.length<SCAN_PAGE)break;
    }
    return {chosen,withdraw};
  }

  /** Why a waiting notice no longer needs to be read ("unknown": decide later), or null when it is still current. */
  private async staleReason(projectId:string,item:LeaderNoticeCandidate):Promise<string|null|"unknown">{
    if(item.kind==="task_attention"){
      const state=await this.deps.store.attentionSourceCurrent(projectId,item.noticeId);
      return state==="current"?null:state==="expired"?"ATTENTION_SOURCE_EXPIRED":"unknown";
    }
    const task=await this.deps.readTaskFacts(projectId,item.taskId);
    if(!task)return "unknown";
    if(item.kind==="task_todo"&&(task.currentRevisionId!==item.taskRevisionId||task.state!=="todo"||task.assigned))return "TODO_SOURCE_SUPERSEDED";
    return null;
  }

  /** Post the packet's message (the same text and ids every time) and record that it was sent. */
  private async postPacket(projectId:string,packetId:string,principals:Principal[],service:Principal,recipient:LeaderResultRecipient):Promise<void>{
    const ports=this.deps.packets!;
    const packet=(await ports.openPackets(projectId,recipient.sessionId)).find(p=>p.id===packetId);
    if(!packet)return;
    const sender=this.sender(principals,projectId,recipient.senderActorId);
    if(!sender)return;
    const posted=await this.deps.workflow.execute(sender,{type:"session.message.post",projectId,operationId:packet.messageOperationId,messageId:packet.messageId,
      target:{kind:"owned",sessionId:recipient.sessionId},content:packet.content});
    if(posted.status==="rejected"){
      // The post was refused: nothing was read, the items wait for the next packet.
      await this.deps.workflow.execute(service,{type:"leader.noticePacket.observe",projectId,operationId:randomUUID(),packetId,outcome:"withdrawn",evidence:`MESSAGE_POST_REJECTED:${posted.code}`});
      return;
    }
    await this.deps.workflow.execute(service,{type:"leader.noticePacket.sent",projectId,operationId:randomUUID(),packetId});
  }

  private async reconcilePacket(projectId:string,packet:{id:string;state:string;sessionId:string;messageId:string},principals:Principal[],
    eligibility:Eligibility,service:Principal|null):Promise<void>{
    const ports=this.deps.packets!;
    const observe=(outcome:"delivered"|"seen"|"failed"|"unknown"|"withdrawn",extra:Record<string,unknown>={})=>this.deps.workflow.execute(service!,
      {type:"leader.noticePacket.observe",projectId,operationId:randomUUID(),packetId:packet.id,outcome,...extra} as never);
    const recipient=eligibility.recipient;
    const here=!!recipient&&recipient.sessionId===packet.sessionId;
    if(packet.state==="building"){
      // The build committed but the post (or its record) did not.
      const existing=await ports.message(projectId,packet.messageId);
      if(!existing){
        if(here&&service)await this.postPacket(projectId,packet.id,principals,service,recipient!);
        else if(service)await observe("withdrawn",{evidence:here?"LEADER_NOTICES_UNAVAILABLE":(recipient?"LEADER_SESSION_CHANGED":eligibility.reason!)});
        return;
      }
      // The message exists: only the record of it is missing.
      if(!service)return;
      await this.deps.workflow.execute(service,{type:"leader.noticePacket.sent",projectId,operationId:randomUUID(),packetId:packet.id});
    }
    const attempt=await ports.attempt(projectId,packet.id);
    if(!attempt?.messageId)return;
    const message=await ports.message(projectId,attempt.messageId);
    if(!message)return;
    const leader=await ports.leaderState(projectId,packet.sessionId,attempt.messageId);
    switch(message.state){
      case "queued": {
        // An unstarted packet gives way: to a person's message, to a different Leader Session, to notices being switched off or the
        // recipient becoming unusable. It is withdrawn only when the message was really cancelled; otherwise the message's own state decides next cycle.
        const reason=leader.humanMessageQueued?"HUMAN_MESSAGE_FIRST":!recipient?eligibility.reason!:!here?"LEADER_SESSION_CHANGED":null;
        if(!reason)return;
        const poster=this.sender(principals,projectId,message.senderActorId);
        if(!poster)return;
        const cancelled=await this.deps.workflow.execute(poster,{type:"session.message.cancel",projectId,operationId:randomUUID(),messageId:message.id,
          expectedVersion:message.version,reason:`A notice packet gives way: ${reason}`});
        if(cancelled.status!=="applied")return;
        if(service)await observe("withdrawn",{evidence:reason});
        return;
      }
      case "processing":
        if(!service)return;
        if(message.nativeTurnId&&packet.state!=="delivered")await observe("delivered",{turnId:message.nativeTurnId});
        return;
      case "replied": case "completed_without_reply":
        if(service)await observe("seen",message.nativeTurnId?{turnId:message.nativeTurnId}:{});return;
      case "failed": case "cancelled":
        // The recovery gate that holds a packet is the one of the Session it was sent to; after a Leader Session change it no longer guards anything.
        if(service)await observe("failed",{turnStarted:!!message.nativeTurnId,gateBlocked:here&&leader.gateBlocked,evidence:`MESSAGE_${message.state.toUpperCase()}`,
          ...(message.nativeTurnId?{turnId:message.nativeTurnId}:{})});return;
      case "unknown": case "manual_pending":
        // Never resent: the packet waits for the message to settle, and a read-only look decides.
        if(service&&packet.state!=="unknown")await observe("unknown",{evidence:"MESSAGE_RESULT_UNKNOWN"});
        return;
    }
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
    const principals=await this.deps.principals();
    for(const projectId of new Set(principals.flatMap(principal=>principal.projectIds))){
      if(!this.deps.canWrite())return;
      if(config?.enabled){
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
      // Also with notices disabled: open packets still have to settle and the switch is copied.
      try { await this.packetCycle(projectId,config,principals); }
      catch(error){this.deps.onError(error);}
    }
  }

  private async process(notice: LeaderResultNotice, config: LeaderResultNoticeConfig,
    principals: Principal[]): Promise<void> {
    if(notice.state!=="pending")return;
    if(notice.kind==="task_attention"){
      const state=await this.deps.store.attentionSourceCurrent(notice.projectId,notice.id);
      if(state!=="current"){
        if(state==="expired")await this.deps.store.disposeStaleAttention(notice.projectId,notice.id);
        else await this.reason(notice,"ATTENTION_SOURCE_UNKNOWN");
        return;
      }
    }
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
      const result=await this.deps.store.disposeStalePendingTodo(notice.projectId,notice.id);
      if(result==="posted")await this.reason(notice,"MESSAGE_POST_UNCONFIRMED");
      return;
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
    return leaderNoticePostCommand(notice,recipient.sessionId);
  }

  private async reconcile(notice:LeaderResultNotice,recipient:LeaderResultRecipient,operation:Operation):Promise<void>{
    const command=this.command(notice,recipient);
    const commandHash=createHash("sha256").update(canonicalJson({actorId:recipient.senderActorId,command})).digest("hex");
    if(operation.actorId!==recipient.senderActorId||operation.commandHash!==commandHash||
      operation.commandType!==command.type||operation.result.status!=="applied"||
      operation.result.entityId!==notice.messageId){
      const code=operation.result.status==="rejected"&&/^[A-Z][A-Z0-9_]{0,100}$/.test(operation.result.code)
        ? operation.result.code:"UNKNOWN";
      await this.deps.store.block(notice.projectId,notice.id,
        operation.actorId===recipient.senderActorId&&operation.commandHash===commandHash&&
        operation.commandType===command.type&&operation.result.status==="rejected"
          ?`MESSAGE_POST_REJECTED:${code}`:"MESSAGE_OPERATION_MISMATCH");
      return;
    }
    const saved:SessionMessageRecord=await this.deps.messages.get(notice.projectId,notice.messageId);
    if(saved.operationId!==notice.operationId||saved.senderActorId!==recipient.senderActorId||
      saved.target.kind!=="owned"||saved.target.sessionId!==recipient.sessionId||
      saved.content!==command.content||saved.context?.taskId!==notice.taskId||
      saved.context?.taskRevisionId!==notice.taskRevisionId){
      await this.deps.store.block(notice.projectId,notice.id,"MESSAGE_IDENTITY_MISMATCH");return;
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
