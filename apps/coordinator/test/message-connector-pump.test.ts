import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import test from "node:test";
import type { ConnectorMessageLink, ConnectorRouteRecord, ConnectorSource,
  ConnectorTrustedAdmission, ConnectorUnhandledEvent } from "@evoloop/contracts/message-connectors";
import { ConnectorIngressPump, type ConnectorIngressPumpDeps } from "../src/message-connectors/pump.ts";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const conversationId = "a".repeat(32);
const sourceUuid=(source:ConnectorSource,purpose:string)=>{
  const bytes=createHash("sha256").update(JSON.stringify([purpose,source.source.provider,
    source.source.connectionId,source.source.conversationId,source.deliveryId,source.eventCursor])).digest();
  bytes[6]=(bytes[6]!&0x0f)|0x40;bytes[8]=(bytes[8]!&0x3f)|0x80;
  const hex=bytes.subarray(0,16).toString("hex");
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
};
const route: ConnectorRouteRecord = {projectId: id(1), bindingId: id(2),
  source: {provider: "wechat", connectionId: "synthetic", conversationId},
  conversationLabel: "Synthetic conversation", conversationKind: "group", targetSessionId: id(3),
  targetThreadId: "synthetic-thread", targetActorId: "receiver", senderActorId: "sender",
  owner: "owner", epoch: 7, sessionRef: "restricted-session", mode: "restricted",
  readScope: "project", sendTargets: [], senderIds: ["peer"], internalTargets: [], state: "active",
  capabilities: {history: true, search: false, subscribe: true, sendText: false,
    sendMedia: false, receipt: "none"}, policyHash: "b".repeat(64), version: 3,
  createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString()};

function fixture(total = 2, alreadyClaimed = false,
  bodyFor:(cursor:number)=>unknown=(cursor)=>`message ${cursor}`,
  senderFor:(cursor:number)=>string=(_cursor)=>"peer") {
  let current = route, qualified = true, enabled = true, write = true;
  let claimed = alreadyClaimed, decision: string | null = null, nextPending = false, nextClaimed = false;
  let decisionRowPatch: Record<string, unknown> = {};
  const calls: string[] = [], admissions: ConnectorTrustedAdmission[] = [], errors: unknown[] = [];
  const unhandled: ConnectorUnhandledEvent[] = [];
  const saved = new Map<number, ConnectorMessageLink>();
  let failAdmission = false, failEvents = false;
  let onCall: ((method: string) => void) | null = null;
  const gateway = {call: async (method: string, params: Record<string, unknown>) => {
    calls.push(method);
    onCall?.(method);
    const common = {method, businessRequestId: null, correlationId: "synthetic"};
    if (method === "binding") return {...common, state: "ok", result: {conversation_id: conversationId,
      owner: "owner", epoch: 7, control: "active", owner_session_ref: route.sessionRef,
      thread_id: route.targetThreadId}};
    if (method === "inbox_status") return {...common, state: "ok", result: {conversation_id: conversationId,
      owner: "owner", epoch: 7, deliveries: [{delivery_id: 12, owner: "owner", epoch: 7,
        cursor_start: 2, cursor_end: total + 1, status: decision ?? (claimed ? "claimed" : "pending"),
        ...(decision ? decisionRowPatch : {})},
      ...(nextPending ? [{delivery_id: 13, owner: "owner", epoch: 7, cursor_start: total + 2,
        cursor_end: total + 2, status: nextClaimed ? "claimed" : "pending"}] : [])]}};
    if (method === "inbox_claim") {
      const next = nextPending && decision !== null;
      if (next) nextClaimed = true; else claimed = true;
      return {...common, state: "ok", result: {conversation_id: conversationId,
        status: "claimed", delivery_id: next ? 13 : 12, owner: "owner", epoch: 7, token: "private",
        cursor_start: next ? total + 2 : 2, cursor_end: next ? total + 2 : total + 1}};
    }
    if (method === "inbox_show") return {...common, state: "ok", result: {conversation_id: conversationId,
      delivery_id: params.delivery_id, owner: "owner", epoch: 7, status: "claimed",
      session_ref: route.sessionRef, cursor_start: params.delivery_id === 13 ? total + 2 : 2,
      cursor_end: params.delivery_id === 13 ? total + 2 : total + 1}};
    assert.equal(method, "events");
    assert.ok(typeof params.after === "number" && params.after >= 1);
    if (failEvents) return {...common, state: "unknown", reason: "response_unknown"};
    if (params.delivery_id === 13) return {...common, state: "ok", result: {
      conversation_id: conversationId, delivery_id: 13,
      events: [{cursor: total + 2, kind: "message_observed", direction: "incoming",
        message: {sender: "peer", content: {Text: "next message"}}}],
      next_cursor: total + 2, has_more: false}};
    const first = (params.after as number) + 1;
    const last = Math.min(total + 1, first + (params.limit as number) - 1);
    return {...common, state: "ok", result: {conversation_id: conversationId, delivery_id: 12,
      events: Array.from({length: Math.max(0, last - first + 1)}, (_, n) => first + n).map(cursor =>
        ({cursor, kind: "message_observed", direction: "incoming",
          message: {sender: senderFor(cursor), content: {Text: bodyFor(cursor)}}})),
      next_cursor: last, has_more: last < total + 1}};
  }};
  const deps: ConnectorIngressPumpDeps = {
    gateway: gateway as unknown as ConnectorIngressPumpDeps["gateway"],
    projects: async () => [route.projectId],
    routes: {list: async () => ({items: [current], nextCursor: null}), get: async () => current},
    links: {getBySource: async (_projectId: string, source: ConnectorSource) => saved.get(source.eventCursor) ?? null,
      getUnhandledBySource:async(_projectId:string,source:ConnectorSource)=>
        unhandled.some(value=>value.source.eventCursor===source.eventCursor),
      recordUnhandled:async input=>{unhandled.push(input);},
      admitTrusted: async input => {
        admissions.push(input);
        if (failAdmission) throw new Error("commit outcome unknown");
        const link = { ...input, decision: "admitted", routeOwner: input.gateway.owner,
          routeEpoch: input.gateway.epoch, routeSessionRef: input.gateway.sessionRef } as unknown as ConnectorMessageLink;
        saved.set(input.source.eventCursor, link);
        return link;
      }},
    canWrite: () => write, enabled: async () => enabled, qualifyReceiver: async () => qualified,
    pollIntervalMs: 1000, onError: error => { errors.push(error); }
  };
  return {pump: new ConnectorIngressPump(deps), calls, admissions, unhandled, errors,
    setRoute: (value: ConnectorRouteRecord) => { current = value; },
    setQualified: (value: boolean) => { qualified = value; },
    setEnabled: (value: boolean) => { enabled = value; },
    setWrite: (value: boolean) => { write = value; },
    setDecision: (value: string) => { decision = value; },
    setDecisionRowPatch: (value: Record<string, unknown>) => { decisionRowPatch = value; },
    setNextPending: () => { nextPending = true; },
    setOnCall: (callback: (method: string) => void) => { onCall = callback; },
    failAdmission: () => { failAdmission = true; }, failEvents: () => { failEvents = true; },
    restoreEvents: () => { failEvents = false; },
    seedLinks: () => { for(let cursor=2;cursor<=total+1;cursor++){
      const source:ConnectorSource={source:route.source,deliveryId:12,cursorStart:2,cursorEnd:total+1,
        eventCursor:cursor,participantId:"peer",replyToEventCursor:null};
      saved.set(cursor,{projectId:route.projectId,bindingId:route.bindingId,routeVersion:route.version,
        source,messageId:sourceUuid(source,"message"),messageOperationId:sourceUuid(source,"operation"),
        decisionId:sourceUuid(source,"decision"),decision:"admitted"} as ConnectorMessageLink);
    }}};
}

test("qualified active ingress uses stable source IDs and the original platform admission", async () => {
  const f = fixture();
  await f.pump.tick();
  assert.deepEqual(f.calls, ["binding", "inbox_status", "inbox_claim", "inbox_show", "events"]);
  assert.equal(f.admissions.length, 2);
  assert.deepEqual(f.admissions.map(x => x.source.eventCursor), [2, 3]);
  assert.deepEqual(f.admissions[0]?.gateway, {owner: "owner", epoch: 7, sessionRef: "restricted-session"});
  assert.equal(f.admissions[0]?.source.participantId, "peer");
  assert.notEqual(f.admissions[0]?.messageId, f.admissions[0]?.messageOperationId);
  await f.pump.tick();
  assert.equal(f.admissions.length, 2, "saved source links prevent a second platform write");
  assert.equal(f.calls.filter(method => method === "inbox_claim").length, 1,
    "without an explicit wx decision the original delivery prevents another claim");
  assert.deepEqual(f.errors, []);
});

test("unsupported incoming events are durably classified instead of disappearing with the cursor", async()=>{
  for(const [body,reason] of [
    [()=>null,"unsupported_content"],
    [()=>"   ","empty_text"],
    [()=>"x".repeat(16_001),"text_too_large"],
  ] as const){
    const f=fixture(1,false,body);
    await f.pump.tick();
    assert.equal(f.admissions.length,0,reason);
    assert.deepEqual(f.unhandled.map(value=>value.reason),[reason]);
    assert.deepEqual(f.errors,[]);
  }
});

test("mixed text and unsupported content preserves both outcomes",async()=>{
  const f=fixture(2,false,cursor=>cursor===3?undefined:`message ${cursor}`);
  await f.pump.tick();
  assert.deepEqual(f.admissions.map(value=>value.source.eventCursor),[2]);
  assert.deepEqual(f.unhandled.map(value=>[value.source.eventCursor,value.reason]),[[3,"unsupported_content"]]);
});

test("an incoming sender outside the reviewed allowlist is recorded and denied",async()=>{
  const f=fixture(1,false,cursor=>`message ${cursor}`,()=> "unapproved-person");
  await f.pump.tick();
  assert.deepEqual(f.admissions,[]);
  assert.deepEqual(f.unhandled.map(value=>[value.source.participantId,value.reason]),
    [["unapproved-person","sender_not_allowed"]]);
});

test("standard delivery reserves one Turn, sends one saved reply, and post-finish readback never replays it", async()=>{
  const standard={...route,mode:'standard' as const,sessionRef:'standard-session',
    sendTargets:[conversationId],capabilities:{...route.capabilities,sendText:true}};
  let currentRoute=standard;
  const calls:string[]=[];let claimed=false,turnState:string|null=null,decisionStatus:string|null=null;
  let messageState='queued',processingState:string|null=null,nativeTurnId:string|null=null,response:string|null=null;
  let savedDecision:Record<string,unknown>|null=null;let sends=0,resultCalls=0;
  let transportAttempt:{routeVersion:number;recordTurnId:string|null;finishStatus:string|null}|null=null;
  let claimAttempt:{routeVersion:number;observed:boolean}|null=null;
  const result=(method:string,value:Record<string,unknown>)=>({state:'ok' as const,method,
    businessRequestId:null,correlationId:'fixture',result:value});
  const gateway={call:async(method:string,params:Record<string,unknown>)=>{
    calls.push(method);
    if(method==='binding')return result(method,{conversation_id:conversationId,control:'active',owner:'owner',epoch:7,
      owner_session_ref:standard.sessionRef,thread_id:standard.targetThreadId});
    if(method==='inbox_status')return result(method,{conversation_id:conversationId,owner:'owner',epoch:7,
      deliveries:[{delivery_id:12,owner:'owner',epoch:7,cursor_start:2,cursor_end:2,
        session_ref:'standard-session',status:decisionStatus??(claimed?'claimed':'pending')}]});
    if(method==='inbox_claim'){assert.equal(claimAttempt?.routeVersion,3);
      assert.equal(claimAttempt?.observed,false);claimed=true;return result(method,{conversation_id:conversationId,
      status:'claimed',delivery_id:12,owner:'owner',epoch:7,token:'claim-token',cursor_start:2,cursor_end:2});}
    if(method==='inbox_show')return result(method,{conversation_id:conversationId,delivery_id:12,
      owner:'owner',epoch:7,status:'claimed',session_ref:'standard-session',
      cursor_start:2,cursor_end:2,token:'claim-token',turn_state:turnState});
    if(method==='transport_status')return result(method,{conversation_id:conversationId,
      deliveries:turnState==='reserved'||turnState==='recorded'?[{delivery_id:12,
        conversation_id:conversationId,owner:'owner',epoch:7,status:'claimed',turn_state:turnState,
        session_ref:'standard-session',thread_id:turnState==='recorded'?'thread':null,
        turn_id:turnState==='recorded'?'native-turn':null,transport_token:'transport-token'}]:[]});
    if(method==='reserve_turn'){turnState='reserved';return result(method,{delivery_id:12,turn_state:'reserved',
      session_ref:'standard-session',already_reserved:false});}
    if(method==='events')return result(method,{conversation_id:conversationId,delivery_id:12,
      events:[{cursor:2,kind:'message_observed',direction:'incoming',message:{sender:'peer',content:{Text:'hello'}}}],
      next_cursor:2,has_more:false});
    if(method==='record_turn'){assert.equal(params.turn_id,'native-turn');turnState='recorded';
      return result(method,{delivery_id:12,turn_state:'recorded',thread_id:'thread',turn_id:'native-turn'});}
    if(method==='finish_turn'){turnState='completed';return result(method,{delivery_id:12,turn_state:'completed'});}
    if(method==='send_text'){sends++;return{state:'unknown' as const,method,businessRequestId:params.request_id,
      correlationId:null,reason:'response_unknown' as const};}
    if(method==='result')return result(method,{application_id:'app',conversation_id:conversationId,
      request_id:`app.${params.request_id}`,status:resultCalls++===0?'pending':'ui_observed',attempt_number:1});
    if(method==='complete'){assert.equal(savedDecision?.state,'complete_attempted');
      decisionStatus='replied';return result(method,{delivery_id:12,status:'replied'});}
    throw new Error(`unexpected ${method}`);
  }};
  const decisions={messages:async()=>messageState==='queued'?[{eventCursor:2,messageId:id(9),
    messageState,processingState,nativeTurnId,response}]:[{eventCursor:2,messageId:id(9),
    messageState,processingState,nativeTurnId,response}],
    claim:async()=>claimAttempt,
    markClaimAttempted:async(_project:string,_binding:string,_delivery:number,routeVersion:number)=>{
      if(claimAttempt)return false;claimAttempt={routeVersion,observed:false};return true;},
    markClaimObserved:async()=>{if(!claimAttempt||claimAttempt.observed)return false;
      claimAttempt={...claimAttempt,observed:true};return true;},
    transport:async()=>transportAttempt,
    markReserve:async()=>{if(transportAttempt)return false;
      transportAttempt={routeVersion:3,recordTurnId:null,finishStatus:null};return true;},
    markRecord:async(_project:string,_binding:string,_delivery:number,_version:number,turnId:string)=>{
      if(!transportAttempt||transportAttempt.recordTurnId)return false;
      transportAttempt.recordTurnId=turnId;return true;},
    markFinish:async(_project:string,_binding:string,_delivery:number,_version:number,status:string)=>{
      if(!transportAttempt||transportAttempt.finishStatus)return false;
      transportAttempt.finishStatus=status;return true;},
    get:async()=>savedDecision,prepare:async(input:Record<string,unknown>)=>{
      savedDecision={...input,state:'prepared'};return savedDecision;},
    markAttempted:async()=>{savedDecision={...savedDecision,state:'attempted'};return true;},
    markObserved:async()=>{savedDecision={...savedDecision,state:'observed'};},
    markCompleteAttempted:async()=>{savedDecision={...savedDecision,state:'complete_attempted'};return true;},
    markCompleteUnknown:async()=>{savedDecision={...savedDecision,state:'complete_unknown'};},
    markCompleted:async(_input:unknown,terminal:Record<string,unknown>)=>{
      if(savedDecision?.routeOwner!==terminal.owner||savedDecision?.routeEpoch!==terminal.epoch||
        savedDecision?.routeSessionRef!==terminal.sessionRef||
        savedDecision?.conversationId!==terminal.conversationId||
        savedDecision?.cursorStart!==terminal.cursorStart||savedDecision?.cursorEnd!==terminal.cursorEnd)
        return false;
      savedDecision={...savedDecision,state:'completed'};return true;}};
  const errors:unknown[]=[];
  const admitted=new Map<number,ConnectorMessageLink>();
  const pump=new ConnectorIngressPump({gateway:gateway as unknown as ConnectorIngressPumpDeps['gateway'],
    projects:async()=>[route.projectId],routes:{list:async()=>({items:[currentRoute],nextCursor:null}),
      get:async()=>currentRoute},
    links:{getBySource:async(_project:string,source:ConnectorSource)=>admitted.get(source.eventCursor)??null,
      admitTrusted:async input=>{const link=input as unknown as ConnectorMessageLink;
        admitted.set(input.source.eventCursor,link);return link;},
      getUnhandledBySource:async()=>false},
    decisions:decisions as unknown as NonNullable<ConnectorIngressPumpDeps['decisions']>,
    canWrite:()=>true,enabled:async()=>true,qualifyReceiver:async()=>true,pollIntervalMs:1000,
    onError:error=>errors.push(error)});
  await pump.tick();assert.equal(calls.filter(value=>value==='reserve_turn').length,1);
  currentRoute={...standard,state:'paused',version:4};
  messageState='replied';processingState='completed';nativeTurnId='native-turn';response='answer';
  for(let index=0;index<6;index++)await pump.tick();
  assert.equal(errors.length,1);assert.equal(sends,1,'unknown send is reconciled by original result, never replayed');
  assert.equal(calls.filter(value=>value==='record_turn').length,1);
  assert.equal(calls.filter(value=>value==='finish_turn').length,1);
  assert.ok(calls.filter(value=>value==='result').length>=2,"pending is polled by the original key");
  assert.equal(calls.filter(value=>value==='complete').length,1);
  assert.equal(savedDecision?.state,'completed');
});

test("disabled route, unavailable qualifier, and lost coordinator lease block wx ingress", async () => {
  const f = fixture();
  f.setRoute({...route, state: "disabled"});
  await f.pump.tick();
  f.setRoute(route);
  f.setQualified(false);
  await f.pump.tick();
  f.setQualified(true);
  f.setEnabled(false);
  await f.pump.tick();
  f.setEnabled(true);
  f.setWrite(false);
  await f.pump.tick();
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.admissions, []);
});

test("a gateway binding pinned to another native Thread cannot ingest",async()=>{
  const f=fixture();
  f.setRoute({...route,targetThreadId:'different-thread'});
  await f.pump.tick();
  assert.deepEqual(f.calls,['binding']);
  assert.deepEqual(f.admissions,[]);
});

test("route deactivation after the original claim freezes and finishes that delivery without a new claim", async () => {
  const f = fixture();
  f.setOnCall(method => { if (method === "inbox_claim") f.setRoute({...route, state: "disabled"}); });
  await f.pump.tick();
  assert.deepEqual(f.calls, ["binding", "inbox_status", "inbox_claim", "inbox_show", "events"]);
  assert.equal(f.admissions.length, 2);
  assert.equal(f.calls.filter(method => method === "inbox_claim").length, 1);
});

test("an unknown event read or admission stalls the binding without replaying the claim or write", async () => {
  for (const failure of ["events", "admission"]) {
    const f = fixture();
    if (failure === "events") f.failEvents(); else f.failAdmission();
    await f.pump.tick();
    const originalCalls = [...f.calls], originalAdmissions = [...f.admissions];
    assert.equal(f.errors.length, 1);
    await f.pump.tick();
    assert.equal(f.calls.filter(method => method === "inbox_claim").length, 1);
    assert.deepEqual(f.admissions, originalAdmissions);
  }
});

test("an explicit decision on the original unknown delivery releases only a later delivery", async () => {
  const f = fixture();
  f.failEvents();
  await f.pump.tick();
  assert.equal(f.calls.filter(method => method === "inbox_claim").length, 1);
  f.restoreEvents();
  f.setDecision("skipped");
  f.seedLinks();
  f.setNextPending();
  await f.pump.tick();
  assert.equal(f.calls.filter(method => method === "inbox_claim").length, 1,
    "observe the original decision before considering the next claim");
  await f.pump.tick();
  assert.equal(f.calls.filter(method => method === "inbox_claim").length, 2);
  assert.deepEqual(f.admissions.map(value => value.source.deliveryId), [13]);
  await f.pump.tick();
  assert.equal(f.calls.filter(method => method === "inbox_claim").length, 2);
});

test("a terminal delivery without every original link never releases the next claim", async()=>{
  const f=fixture();
  f.failEvents();
  await f.pump.tick();
  f.restoreEvents();
  f.setDecision("skipped");
  f.setNextPending();
  await f.pump.tick();
  await f.pump.tick();
  assert.equal(f.calls.filter(method=>method==="inbox_claim").length,1,
    "the original source outcomes must be present before later work can start");
});

test("a terminal row with changed source identity cannot release an unknown claim", async () => {
  for (const changed of [{owner: "other"}, {epoch: 8}, {cursor_start: 3}, {cursor_end: 4}]) {
    const f = fixture();
    f.failEvents();
    await f.pump.tick();
    f.restoreEvents();
    f.setDecision("skipped");
    f.setDecisionRowPatch(changed);
    f.setNextPending();
    await f.pump.tick();
    await f.pump.tick();
    assert.equal(f.calls.filter(method => method === "inbox_claim").length, 1,
      `changed ${Object.keys(changed)[0]} must retain the original uncertainty`);
  }
});

test("large frozen delivery advances across bounded pages and ticks without another claim", async () => {
  const f = fixture(320);
  await f.pump.tick();
  assert.equal(f.admissions.length, 300);
  assert.equal(f.calls.filter(method => method === "events").length, 10);
  await f.pump.tick();
  assert.equal(f.admissions.length, 320);
  assert.equal(f.calls.filter(method => method === "inbox_claim").length, 1);
  assert.deepEqual(f.errors, []);
});

test("restart with an original claimed delivery reconciles its source without a new claim or admission", async () => {
  const f = fixture(320, true);
  f.seedLinks();
  await f.pump.tick();
  assert.equal(f.calls.filter(method => method === "events").length, 10);
  await f.pump.tick();
  assert.equal(f.calls.filter(method => method === "events").length, 11);
  assert.equal(f.admissions.length, 0);
  assert.equal(f.calls.filter(method => method === "inbox_claim").length, 0);
});

test("a config disable observed after status prevents the claim", async () => {
  const f = fixture();
  f.setOnCall(method => { if (method === "inbox_status") f.setEnabled(false); });
  await f.pump.tick();
  assert.equal(f.calls.filter(method => method === "inbox_claim").length, 0);
  assert.equal(f.admissions.length, 0);
});

test("stop during a busy tick prevents its later claim", async () => {
  const f = fixture();
  f.setOnCall(method => { if (method === "inbox_status") f.pump.stop(); });
  await f.pump.tick();
  await f.pump.tick();
  assert.equal(f.calls.filter(method => method === "inbox_claim").length, 0);
  assert.equal(f.admissions.length, 0);
});
