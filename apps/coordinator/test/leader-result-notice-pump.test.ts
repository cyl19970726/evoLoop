import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import { canonicalJson } from "@evoloop/core";
import type { Principal, RuntimeSessionRecord } from "@evoloop/contracts";
import type { RoleRecord } from "@evoloop/contracts/roles";
import type { SessionMessageRecord } from "@evoloop/contracts/session-messages";
import { packetContent, LeaderResultNoticePump, type LeaderResultNotice, type LeaderResultNoticeConfig,
  type LeaderResultRecipient } from "../src/leader-results/pump.ts";

const projectId="00000000-0000-4000-8000-000000000001";
const roleId="00000000-0000-4000-8000-000000000002";
const sessionId="00000000-0000-4000-8000-000000000003";
const sender:Principal={actorId:"system:leader-result-notifier",projectIds:[projectId],permissions:["read","write"]};
const receiver:Principal={actorId:"leader-actor",projectIds:[projectId],permissions:["read","write","review"]};
const target={projectId,sessionId,receiverRoleId:roleId,receiverActorId:receiver.actorId,senderActorId:sender.actorId};
const config:LeaderResultNoticeConfig={enabled:true,targets:[target]};
const session:RuntimeSessionRecord={projectId,id:sessionId,roleId,cwd:"/tmp/leader-notice",authorizationScope:"project",
  model:"model",sandbox:"danger-full-access",approvalPolicy:"never",state:"ready",version:1,
  nativeThreadId:"thread",nativeSessionId:"native",operationId:"00000000-0000-4000-8000-000000000004",
  actorId:receiver.actorId,createdAt:"2026-11-02T00:00:00.000Z",updatedAt:"2026-11-02T00:00:00.000Z"};
const role={id:roleId,state:"active",proposal:{templateKey:"lead",roleClass:"system"}} as RoleRecord;
const notice=(kind:LeaderResultNotice["kind"]="delivery"):LeaderResultNotice=>({
  projectId,id:"00000000-0000-4000-8000-000000000005",kind,sourceRef:`${kind}:source`,
  sourceEventId:"00000000-0000-4000-8000-000000000017",sourceSessionId:sessionId,
  sourceActorId:"business-worker",occurredAt:"2026-11-02T00:00:00.000Z",
  taskId:"00000000-0000-4000-8000-000000000006",taskRevisionId:"00000000-0000-4000-8000-000000000007",
  messageId:"00000000-0000-4000-8000-000000000008",operationId:"00000000-0000-4000-8000-000000000009",
  state:"pending",stale:false,recipient:null});

function fixture(initial=notice()){
  let row=initial, configured:LeaderResultNoticeConfig|undefined=config;
  let principals:Principal[]=[sender,receiver];
  let roles=[role],sessions=[session],grant=true,execution=true,write=true,native=true,inFlight=false;
  let taskFacts={currentRevisionId:initial.taskRevisionId,state:"todo",assigned:false};
  let taskReads=0,blocks=0,dispositions=0,pendingDispositions=0,refreshes=0;
  let pendingReason:string|null=null;
  const commands:unknown[]=[],errors:unknown[]=[],diagnostics:string[]=[];
  let saved:SessionMessageRecord|null=null;
  let operation:Record<string,unknown>|null=null;
  let attentionCurrent:"current"|"unknown"|"expired"="current",attentionDispositions=0;
  let loseAcknowledgement=false,linkFails=false,postRejection:string|null=null;
  let firstPage:LeaderResultNotice[]|null=null;
  const cursors:Array<string|undefined>=[];
  const store={
    listPending:async(_project:string,query:{cursor?:string})=>{
      cursors.push(query.cursor);
      return firstPage&&query.cursor!=="second"
        ? {items:firstPage,nextCursor:"second"}
        : {items:row.state==="pending"?[row]:[],nextCursor:null};
    },
    getByMessageId:async(_project:string,messageId:string)=>messageId===row.messageId?row:null,
    disposeStalePendingTodo:async(_project:string,noticeId:string)=>{
      assert.equal(noticeId,row.id);
      pendingDispositions++;
      if(saved)return "posted" as const;
      const refresh=taskFacts.state==="todo"&&!taskFacts.assigned&&
        taskFacts.currentRevisionId!==row.taskRevisionId;
      if(refresh)refreshes++;
      const reason=taskFacts.state!=="todo"?"TODO_SOURCE_NOT_TODO":
        taskFacts.assigned?"TODO_SOURCE_ASSIGNED":refresh?"TODO_SOURCE_SUPERSEDED_REFRESHED":
          "TODO_SOURCE_SUPERSEDED_HANDLED";
      row={...row,state:"blocked"};pendingReason=reason;
      return "disposed" as const;
    },
    disposeStaleTodo:async(_project:string,noticeId:string,messageId:string)=>{
      assert.equal(noticeId,row.id);assert.equal(messageId,row.messageId);
      dispositions++;
      if(saved?.state!=="queued")return "in_flight" as const;
      saved={...saved,state:"cancelled",version:saved.version+1,
        blockedReason:taskFacts.state==="todo"?"TODO_SOURCE_SUPERSEDED_REFRESHED":"TODO_SOURCE_NOT_TODO"};
      if(taskFacts.state==="todo"&&!taskFacts.assigned)refreshes++;
      return "disposed" as const;
    },
    attentionSourceCurrent:async()=>attentionCurrent,
    disposeStaleAttention:async()=>{attentionDispositions++;row={...row,state:"blocked"};return "expired" as const;},
    hasInFlightOnOtherSession:async()=>inFlight,
    notePendingReason:async(_project:string,_id:string,reason:string|null)=>{pendingReason=reason;},
    block:async(_project:string,_id:string,reason:string)=>{blocks++;row={...row,state:"blocked"};pendingReason=reason;},
    pinRecipient:async(_project:string,_id:string,recipient:LeaderResultRecipient)=>{
      if(row.recipient)return row;
      row={...row,recipient};return row;
    },
    markPosted:async(_project:string,_id:string,messageId:string,linkedSessionId:string)=>{
      if(linkFails)throw Error("link response lost");
      assert.equal(messageId,row.messageId);assert.equal(linkedSessionId,row.recipient?.sessionId);
      row={...row,state:"linked"};
    },
  };
  const workflow={
    listRoles:async()=>({items:roles,nextCursor:null}),
    listRuntimeSessions:async()=>sessions,
    execute:async(_principal:Principal,command:Record<string,unknown>)=>{
      commands.push(command);
      const fixed={actorId:sender.actorId,command};
      const commandHash=createHash("sha256").update(canonicalJson(fixed)).digest("hex");
      if(postRejection){
        operation={actorId:sender.actorId,commandHash,commandType:command.type,result:{status:"rejected",code:postRejection}};
        throw Error("recorded post rejection");
      }
      operation={actorId:sender.actorId,commandHash,commandType:command.type,result:{status:"applied",entityId:row.messageId}};
      saved={projectId,id:row.messageId,operationId:row.operationId,target:command.target as SessionMessageRecord["target"],
        senderActorId:sender.actorId,content:command.content as string,
        context:command.context as SessionMessageRecord["context"],replyToMessageId:null,state:"queued",version:1,
        blockedReason:null,readReceipt:null,createdAt:"2026-11-02T00:00:00.000Z",updatedAt:"2026-11-02T00:00:00.000Z"};
      if(loseAcknowledgement)throw Error("command response lost after commit");
      return operation.result;
    },
    getOperation:async()=>operation,
  };
  const pump=new LeaderResultNoticePump({store,workflow,messages:{get:async()=>{if(!saved)throw Error("missing message");return saved;}},
    configuration:async()=>configured,principals:async()=>principals,canExecuteSession:async()=>execution,
    readTaskFacts:async()=>{taskReads++;return taskFacts;},
    hasMessageGrant:async()=>grant,canWrite:()=>write,canStartNative:()=>native,
    pollIntervalMs:1000,onError:error=>errors.push(error),
    onDiagnostic:(_project,_notice,reason)=>diagnostics.push(reason)});
  return {pump,commands,errors,diagnostics,cursors,get row(){return row;},get pendingReason(){return pendingReason;},
    get taskReads(){return taskReads;},get blocks(){return blocks;},
    get dispositions(){return dispositions;},get pendingDispositions(){return pendingDispositions;},
    get refreshes(){return refreshes;},
    get attentionDispositions(){return attentionDispositions;},
    setAttentionCurrent(value:"current"|"unknown"|"expired"){attentionCurrent=value;},
    setConfig(value:LeaderResultNoticeConfig|undefined){configured=value;},
    setPrincipals(value:Principal[]){principals=value;},
    setNotice(value:LeaderResultNotice){row=value;},
    requeue(){row={...row,state:"pending"};},
    setTaskFacts(value:typeof taskFacts){taskFacts=value;},
    setFirstPage(value:LeaderResultNotice[]){firstPage=value;},
    setRoles(value:RoleRecord[]){roles=value;},setSessions(value:RuntimeSessionRecord[]){sessions=value;},
    setGrant(value:boolean){grant=value;},setExecution(value:boolean){execution=value;},setWrite(value:boolean){write=value;},
    setNative(value:boolean){native=value;},
    setInFlight(value:boolean){inFlight=value;},
    loseAcknowledgement(){loseAcknowledgement=true;},failLink(value:boolean){linkFails=value;},
    rejectPost(code:string){postRejection=code;},
    setOperation(value:Record<string,unknown>|null){operation=value;},setMessage(value:SessionMessageRecord|null){saved=value;},
    get message(){return saved;}};
}

test("attention notice checks the current phase and source before dispatch",async()=>{
  const f=fixture(notice("task_attention"));
  f.setAttentionCurrent("expired");
  await f.pump.tick();
  assert.equal(f.commands.length,0);
  assert.equal(f.attentionDispositions,1);
});

test("pending attention notice waits through unknown and posts its original operation once after recovery",async()=>{
  const f=fixture(notice("task_attention"));
  const original={noticeId:f.row.id,messageId:f.row.messageId,operationId:f.row.operationId};
  f.setAttentionCurrent("unknown");
  await f.pump.tick();await f.pump.tick();
  assert.equal(f.row.state,"pending");
  assert.equal(f.attentionDispositions,0);
  assert.equal(f.commands.length,0);
  f.setAttentionCurrent("current");
  await f.pump.tick();await f.pump.tick();
  assert.deepEqual({noticeId:f.row.id,messageId:f.row.messageId,operationId:f.row.operationId},original);
  assert.equal(f.row.state,"linked");
  assert.equal(f.commands.length,1);
  assert.equal(f.attentionDispositions,0);
});

test("linked queued attention message waits through unknown and admits its original message after recovery",async()=>{
  const f=fixture(notice("task_attention"));
  await f.pump.tick();
  const original=f.message!;
  assert.equal(f.row.state,"linked");
  f.setAttentionCurrent("unknown");
  assert.deepEqual(await f.pump.messageAdmission(original),{allowed:false,reason:"ATTENTION_SOURCE_UNKNOWN"});
  assert.equal(f.message?.state,"queued");
  assert.equal(f.attentionDispositions,0);
  f.setAttentionCurrent("current");
  assert.deepEqual(await f.pump.messageAdmission(original),{allowed:true,reason:null});
  assert.deepEqual(await f.pump.messageAdmission(original),{allowed:true,reason:null});
  assert.equal(f.message?.id,original.id);
  assert.equal(f.commands.length,1);
});

test("only an explicitly configured unique ready managed Lead gets a result message",async()=>{
  const f=fixture();
  f.setSessions([]);await f.pump.tick();assert.equal(f.row.state,"pending");
  f.setSessions([session,{...session,id:"00000000-0000-4000-8000-000000000010"}]);
  await f.pump.tick();assert.equal(f.commands.length,0);
  f.setSessions([session]);f.setRoles([role,{...role,id:"00000000-0000-4000-8000-000000000011"}]);
  await f.pump.tick();assert.equal(f.commands.length,0);
  f.setRoles([role]);f.setGrant(false);await f.pump.tick();assert.equal(f.commands.length,0);
  assert.equal(f.pendingReason,"MESSAGE_GRANT_MISSING");
  f.setGrant(true);f.setExecution(false);await f.pump.tick();assert.equal(f.commands.length,0);
  f.setExecution(true);await f.pump.tick();
  assert.equal(f.commands.length,1);assert.equal(f.row.state,"linked");assert.equal(f.pendingReason,null);
  assert.deepEqual(f.errors,[]);
});

test("missing receiver grant stays pending with a reason and publishes after grant recovery",async()=>{
  const f=fixture();f.setGrant(false);
  await f.pump.tick();
  assert.equal(f.row.state,"pending");assert.equal(f.pendingReason,"MESSAGE_GRANT_MISSING");
  assert.equal(f.commands.length,0);
  f.setGrant(true);await f.pump.tick();
  assert.equal(f.row.state,"linked");assert.equal(f.pendingReason,null);
  assert.equal(f.commands.length,1);assert.deepEqual(f.errors,[]);
});

test("a receiver without Leader review authority is not awakened",async()=>{
  const f=fixture();
  f.setPrincipals([sender,{...receiver,permissions:["read","write"]}]);
  await f.pump.tick();
  assert.equal(f.commands.length,0);
  assert.equal(f.pendingReason,"LEADER_RECEIVER_UNAVAILABLE");
  f.setPrincipals([sender,receiver]);
  await f.pump.tick();
  assert.equal(f.commands.length,1);
});

test("notice pins the actual message receiver, not the Session creator",async()=>{
  const creator={...session,actorId:"session-creator"};
  assert.notEqual(creator.actorId,receiver.actorId);
  const f=fixture();f.setSessions([creator]);
  await f.pump.tick();
  assert.equal(f.row.state,"linked");
  assert.equal(f.row.recipient?.receiverActorId,receiver.actorId);
  assert.equal(await f.pump.canStartMessage(f.message!),true);
  const replacement:Principal={...receiver,actorId:"replacement-leader"};
  f.setPrincipals([sender,replacement]);
  f.setConfig({...config,targets:[{...target,receiverActorId:replacement.actorId}]});
  assert.equal(await f.pump.canStartMessage(f.message!),false,
    "an old queued notice cannot start under a new actual receiver on the same Session");
});

test("external-only project remains pending with a target diagnosis",async()=>{
  const f=fixture();f.setConfig({enabled:true,targets:[]});
  await f.pump.tick();
  assert.equal(f.row.state,"pending");assert.equal(f.pendingReason,"LEADER_TARGET_UNCONFIGURED");
  assert.equal(f.commands.length,0);
});

test("native runtime outage remains a diagnosed pending notice",async()=>{
  const f=fixture();f.setNative(false);
  await f.pump.tick();
  assert.equal(f.row.state,"pending");assert.equal(f.pendingReason,"NATIVE_RUNTIME_UNAVAILABLE");
  assert.equal(f.commands.length,0);
  f.setNative(true);await f.pump.tick();
  assert.equal(f.row.state,"linked");assert.equal(f.pendingReason,null);
});

test("a journaled post rejection blocks the original notice and never reuses its operation",async()=>{
  const f=fixture();f.rejectPost("SESSION_NOT_READY");
  await f.pump.tick();
  assert.equal(f.row.state,"blocked");
  assert.equal(f.pendingReason,"MESSAGE_POST_REJECTED:SESSION_NOT_READY");
  assert.equal(f.row.operationId,notice().operationId);
  assert.equal(f.row.messageId,notice().messageId);
  assert.equal(f.commands.length,1);
  await f.pump.tick();
  assert.equal(f.commands.length,1,"confirmed rejection requires a new explicit intent");
  assert.deepEqual(f.errors,[]);
});

test("a rejected operation for different message bytes is never classified as this notice post",async()=>{
  const n=notice();n.recipient={sessionId,receiverRoleId:roleId,
    receiverActorId:receiver.actorId,senderActorId:sender.actorId};
  const f=fixture(n);
  f.setOperation({actorId:sender.actorId,commandHash:"a".repeat(64),commandType:"session.message.post",
    result:{status:"rejected",code:"SESSION_NOT_READY"}});
  await f.pump.tick();
  assert.equal(f.row.state,"blocked");
  assert.equal(f.pendingReason,"MESSAGE_OPERATION_MISMATCH");
  assert.equal(f.commands.length,0);
});

test("pinned original operation is reconciled after lost acknowledgement and target switch",async()=>{
  const f=fixture();
  f.loseAcknowledgement();f.failLink(true);
  await f.pump.tick();
  assert.equal(f.row.state,"pending");
  const previous=f.row.recipient;
  f.failLink(false);
  f.setConfig({...config,targets:[{...target,sessionId:"00000000-0000-4000-8000-000000000012"}]});
  await f.pump.tick();
  assert.equal(f.row.state,"linked");
  assert.equal(f.commands.length,1);assert.deepEqual(f.row.recipient,previous);
  assert.equal(f.errors.length,1);
});

test("unconfirmed pinned message remains pending and never starts on a replacement target",async()=>{
  const n=notice();n.recipient={sessionId,receiverRoleId:roleId,receiverActorId:receiver.actorId,senderActorId:sender.actorId};
  const f=fixture(n);
  f.setConfig({...config,targets:[{...target,sessionId:"00000000-0000-4000-8000-000000000012"}]});
  await f.pump.tick();
  assert.equal(f.row.state,"pending");assert.equal(f.commands.length,0);
  assert.deepEqual(f.errors,[]);
});

test("queued notice on an old Leader cannot start after configuration switches",async()=>{
  const f=fixture();await f.pump.tick();
  const queued=f.message!;
  assert.equal(await f.pump.canStartMessage(queued),true);
  f.setConfig({...config,targets:[{...target,sessionId:"00000000-0000-4000-8000-000000000012"}]});
  assert.equal(await f.pump.canStartMessage(queued),false);
  assert.equal(await f.pump.canStartMessage({...queued,id:"00000000-0000-4000-8000-000000000013"}),true,
    "unrelated ordinary messages keep their existing scheduling path");
});

test("an old Leader notice Turn blocks a new target until its original Turn settles",async()=>{
  const newSessionId="00000000-0000-4000-8000-000000000014";
  const f=fixture();f.setSessions([{...session,id:newSessionId}]);
  f.setConfig({...config,targets:[{...target,sessionId:newSessionId}]});
  f.setInFlight(true);
  await f.pump.tick();await f.pump.tick();
  assert.equal(f.row.state,"pending");assert.equal(f.row.recipient,null);
  assert.equal(f.commands.length,0);
  assert.deepEqual(f.diagnostics,["OLD_LEADER_NOTICE_IN_FLIGHT"]);
  f.setInFlight(false);await f.pump.tick();
  assert.equal(f.commands.length,1);assert.equal(f.row.state,"linked");
  assert.deepEqual(f.errors,[]);
  f.setInFlight(true);
  assert.equal(await f.pump.canStartMessage(f.message!),false,
    "a queued new-target notice still checks old in-flight Turns at native admission");
});

test("receipt and notification changes are not notice sources; disabled mode has no writes",async()=>{
  const f=fixture(notice("observation"));
  f.setConfig({...config,enabled:false});await f.pump.tick();assert.equal(f.commands.length,0);
  f.setConfig(config);f.setWrite(false);await f.pump.tick();assert.equal(f.commands.length,0);
  f.setWrite(true);await f.pump.tick();await f.pump.tick();
  assert.equal(f.commands.length,1);assert.equal(f.row.state,"linked");assert.deepEqual(f.errors,[]);
});

test("blocked notices need explicit requeue; a previous recipient remains pinned",async()=>{
  const n=notice();n.state="blocked";
  n.recipient={sessionId,receiverRoleId:roleId,receiverActorId:receiver.actorId,senderActorId:sender.actorId};
  const f=fixture(n);
  await f.pump.tick();
  assert.equal(f.commands.length,0);
  f.requeue();await f.pump.tick();
  assert.equal(f.commands.length,1);
  assert.deepEqual(f.row.recipient,n.recipient);
  assert.equal(f.row.state,"linked");
});

test("pending cursor reaches newer work behind fifty unresolved old-target notices",async()=>{
  const f=fixture();
  const oldRecipient={sessionId:"00000000-0000-4000-8000-000000000015",
    receiverRoleId:roleId,receiverActorId:receiver.actorId,senderActorId:sender.actorId};
  f.setFirstPage(Array.from({length:50},(_,i)=>({...notice(),id:`old-${i}`,recipient:oldRecipient})));
  await f.pump.tick();assert.equal(f.commands.length,0);
  await f.pump.tick();
  assert.deepEqual(f.cursors,[undefined,"second"]);
  assert.equal(f.commands.length,1);assert.equal(f.row.state,"linked");
});

test("superseded or assigned todo leaves the pending scan as a diagnosed historical notice",async()=>{
  const first=fixture(notice("task_todo"));
  first.setTaskFacts({currentRevisionId:first.row.taskRevisionId,state:"todo",assigned:true});
  await first.pump.tick();
  assert.equal(first.commands.length,0);assert.equal(first.row.state,"blocked");
  assert.equal(first.pendingReason,"TODO_SOURCE_ASSIGNED");
  await first.pump.tick();
  assert.equal(first.taskReads,1,"arranged todo is removed from subsequent pending scans");
  assert.equal(first.pendingDispositions,1,"the historical disposition is written once");
  const old=notice("task_todo");old.stale=true;
  const second=fixture(old);
  second.setTaskFacts({currentRevisionId:"00000000-0000-4000-8000-000000000016",state:"todo",assigned:false});
  await second.pump.tick();
  assert.equal(second.commands.length,0);assert.equal(second.row.state,"blocked");
  assert.equal(second.pendingReason,"TODO_SOURCE_SUPERSEDED_REFRESHED");
  assert.equal(second.refreshes,1);
  await second.pump.tick();
  assert.equal(second.pendingDispositions,1);
  const queued=fixture(notice("task_todo"));await queued.pump.tick();
  assert.equal(await queued.pump.canStartMessage(queued.message!),true);
  queued.setTaskFacts({currentRevisionId:queued.row.taskRevisionId,state:"todo",assigned:true});
  assert.equal(await queued.pump.canStartMessage(queued.message!),false,
    "assignment after message save still prevents an obsolete native wakeup");
});

test("a pending old todo that is no longer todo is retired without a replacement",async()=>{
  const old=notice("task_todo");
  const f=fixture(old);
  f.setTaskFacts({currentRevisionId:"00000000-0000-4000-8000-000000000016",state:"in_progress",assigned:false});
  await f.pump.tick();
  assert.equal(f.row.state,"blocked");
  assert.equal(f.pendingReason,"TODO_SOURCE_NOT_TODO");
  assert.equal(f.refreshes,0);
  assert.equal(f.commands.length,0);
});

test("the pump handles the refreshed current todo on its next scan",async()=>{
  const old=notice("task_todo");
  const currentRevisionId="00000000-0000-4000-8000-000000000016";
  const f=fixture(old);
  f.setTaskFacts({currentRevisionId,state:"todo",assigned:false});
  await f.pump.tick();
  assert.equal(f.pendingDispositions,1);
  assert.equal(f.refreshes,1);
  f.setNotice({...notice("task_todo"),id:"00000000-0000-4000-8000-000000000018",
    messageId:"00000000-0000-4000-8000-000000000019",
    operationId:"00000000-0000-4000-8000-000000000020",
    sourceEventId:currentRevisionId,taskRevisionId:currentRevisionId,stale:false});
  await f.pump.tick();
  assert.equal(f.commands.length,1);
  assert.equal(f.row.state,"linked");
  assert.equal(f.pendingDispositions,1);
});

test("a pending pinned todo with a saved post reconciles before stale disposal",async()=>{
  const f=fixture(notice("task_todo"));
  await f.pump.tick();
  assert.equal(f.row.state,"linked");
  f.setNotice({...f.row,state:"pending",stale:true});
  f.setTaskFacts({currentRevisionId:"00000000-0000-4000-8000-000000000016",state:"todo",assigned:false});
  await f.pump.tick();
  assert.equal(f.row.state,"linked");
  assert.equal(f.pendingDispositions,0);
  assert.equal(f.commands.length,1,"the fixed post is not issued again");
});

test("a saved message without a readable operation keeps its pending notice unresolved",async()=>{
  const n=notice("task_todo");
  n.recipient={sessionId,receiverRoleId:roleId,receiverActorId:receiver.actorId,
    senderActorId:sender.actorId};
  const f=fixture(n);
  f.setMessage({projectId,id:n.messageId,operationId:n.operationId,target:{kind:"owned",sessionId},
    senderActorId:sender.actorId,content:"fixed todo",context:{taskId:n.taskId,taskRevisionId:n.taskRevisionId},
    replyToMessageId:null,state:"queued",version:1,blockedReason:null,readReceipt:null,
    createdAt:"2026-11-02T00:00:00.000Z",updatedAt:"2026-11-02T00:00:00.000Z"});
  f.setTaskFacts({currentRevisionId:"00000000-0000-4000-8000-000000000016",state:"todo",assigned:false});
  await f.pump.tick();
  assert.equal(f.row.state,"pending");
  assert.equal(f.pendingReason,"MESSAGE_POST_UNCONFIRMED");
  assert.equal(f.message?.state,"queued");
  assert.equal(f.refreshes,0);
  assert.equal(f.commands.length,0);
});

test("stale Delivery and Observation point to fixed history without implying current acceptance",async()=>{
  for(const kind of ["delivery","observation"] as const){
    const old=notice(kind);old.stale=true;
    const f=fixture(old);
    f.setTaskFacts({currentRevisionId:"00000000-0000-4000-8000-000000000016",state:"in_progress",assigned:true});
    await f.pump.tick();
    assert.equal(f.commands.length,1,kind);
    const content=(f.commands[0] as {content:string}).content;
    assert.match(content,/historical source event/);
    assert.match(content,/not current acceptance, consumer use, or Task closure/);
    assert.match(content,new RegExp(old.taskRevisionId));
  }
});

test("the original linked queued todo from a changed Task is retired once, freeing its Session queue",async()=>{
  const old={...notice("task_todo"),state:"linked" as const,stale:true,recipient:{
    sessionId,receiverRoleId:roleId,receiverActorId:receiver.actorId,senderActorId:sender.actorId}};
  const f=fixture(old);
  f.setMessage({projectId,id:old.messageId,operationId:old.operationId,target:{kind:"owned",sessionId},
    senderActorId:sender.actorId,content:"historical todo",context:{taskId:old.taskId,taskRevisionId:old.taskRevisionId},
    replyToMessageId:null,state:"queued",version:2,blockedReason:null,readReceipt:null,
    createdAt:"2026-11-02T00:00:00.000Z",updatedAt:"2026-11-02T00:00:00.000Z"});
  f.setTaskFacts({currentRevisionId:"00000000-0000-4000-8000-000000000016",state:"in_progress",assigned:false});
  assert.equal(await f.pump.canStartMessage(f.message!),false);
  assert.equal(f.dispositions,1);
  assert.equal(f.message?.state,"cancelled");
  assert.equal(f.message?.blockedReason,"TODO_SOURCE_NOT_TODO");
  assert.equal(f.refreshes,0);
  assert.equal(await f.pump.canStartMessage(f.message!),false);
  assert.equal(f.dispositions,1,"a repeated pump must not retire or dispatch twice");
});

test("a packet message stays within 8 KB however long its items are, names every item and keeps the read-before mark in every form",()=>{
  const item=(index:number,readBefore:boolean)=>({noticeId:randomUUID(),kind:"delivery",sourceEventId:randomUUID(),taskId:randomUUID(),taskRevisionId:randomUUID(),
    sourceRef:`delivery:${"x".repeat(400)}:${index}`,occurredAt:"2026-11-11T00:00:00.000Z",sourceActorId:"a".repeat(100),sourceSessionId:null,state:"pending" as const,
    readBefore,waitedSeconds:90,version:0});
  const items=Array.from({length:20},(_unused,index)=>item(index,index%2===0));
  const text=packetContent(randomUUID(),randomUUID(),items);
  assert.ok(Buffer.byteLength(text,"utf8")<=8192,`bytes ${Buffer.byteLength(text,"utf8")}`);
  const lines=text.split("\n");
  for(const [index,entry] of items.entries()){
    const line=lines.find(value=>value.includes(entry.noticeId));
    assert.ok(line,"every item is named");
    assert.equal(line!.includes("上一轮已读到过"),entry.readBefore,`item ${index}: the mark follows the item in whatever form it is listed`);
  }
  assert.ok(/摘要|仅编号/.test(text),"items beyond the byte budget are listed in short form");
  // Short items all fit in full form.
  const small=packetContent(randomUUID(),randomUUID(),[{...item(0,false),sourceRef:"s",sourceActorId:"a"}]);
  assert.ok(!/摘要|仅编号/.test(small));
});
