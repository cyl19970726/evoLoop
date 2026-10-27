import assert from "node:assert/strict";
import test from "node:test";
import type { Principal } from "@evoloop/contracts";
import type { RuntimeSessionRecord } from "@evoloop/contracts/runtime";
import type { ObservedSession } from "@evoloop/contracts/session-observation";
import { createMessageExecutionReader, type MessageExecutionReaderDeps } from "../src/session-messages/execution-capability.js";

const projectId="11111111-1111-4111-8111-111111111111";
const sessionId="22222222-2222-4222-8222-222222222222";
const roleId="receiver-role";
const cwd="/tmp/evoloop-message-receiver";
const at="2026-10-27T10:00:00.000Z";
const principal:Principal={actorId:"lead",projectIds:[projectId],permissions:["read","write"]};
const observed:ObservedSession={key:`owned:${sessionId}`,target:{kind:"owned",sessionId},aliases:[],
  title:"Receiver",profile:null,kind:"owned",roles:[],membership:"current",membershipReason:"assigned",
  runtimeState:"ready",busy:false,currentTask:null,latestBusinessRun:null,lastProgressAt:null,
  capabilities:{observe:{available:true,reason:null},send:{available:true,reason:null,mode:"owned-conversation"},
    open:{available:true,reason:null,ref:null},interrupt:{available:false,reason:null},close:{available:false,reason:null}},
  source:{kind:"session",id:sessionId,revision:null,evidence:"project-record",href:"/session"},
  metadata:{generatedAt:at,sourceObservedAt:null,partial:false,limitations:[]}};
const session:RuntimeSessionRecord={projectId,id:sessionId,roleId,cwd,authorizationScope:"fixed-role",
  model:"gpt-6-sol",sandbox:"danger-full-access",approvalPolicy:"never",state:"ready",version:2,
  nativeThreadId:"owned-thread",nativeSessionId:"owned-native-session",operationId:"reserve-op",
  actorId:"worker",createdAt:at,updatedAt:at};
const grant={projectId,sessionId,senderActorId:"lead",receiverActorId:"worker",receiverRoleId:roleId,
  cwd,maxTurns:2,enabled:true};
function setup(overrides:Partial<MessageExecutionReaderDeps>={}){
  const calls={configuration:0,session:0,writer:0,turns:0,cwd:0,runtime:0};
  const deps:MessageExecutionReaderDeps={
    loadConfiguration:async()=>{calls.configuration++;return{
      runtime:{enabled:true,protocolVersion:"0.164.0-alpha.11.1",grants:[],delegationTemplates:[]},
      sessionMessages:{enabled:true,pollIntervalMs:2000,readOnlyProtocolVerified:true,grants:[grant]},
    };},
    runtimeAvailable:()=>{calls.runtime++;return true;},
    canExecuteSession:async()=>true,
    isProjectWriter:async(_project,actor)=>{calls.writer++;return actor==="lead"||actor==="worker";},
    readSession:async()=>{calls.session++;return session;},
    turnsUsed:async()=>{calls.turns++;return 0;},
    cwdIsCurrent:async()=>{calls.cwd++;return true;},
    now:()=>at,
    ...overrides,
  };
  return{read:createMessageExecutionReader(deps),calls};
}

test("write and project authority fail before any configuration, session or grant probe",async()=>{
  const {read,calls}=setup();
  assert.deepEqual((await read({...principal,permissions:["read"]},projectId,observed)).state,"blocked");
  assert.equal((await read({...principal,permissions:["read"]},projectId,observed)).reasonCode,"WRITE_REQUIRED");
  assert.equal((await read({...principal,projectIds:[]},projectId,observed)).reasonCode,"FORBIDDEN");
  assert.deepEqual(calls,{configuration:0,session:0,writer:0,turns:0,cwd:0,runtime:0});
});

test("external handoff is manual and never probes native readiness",async()=>{
  const {read,calls}=setup();
  const external:ObservedSession={...observed,key:"external:33333333-3333-4333-8333-333333333333",
    kind:"external",target:{kind:"external",linkId:"33333333-3333-4333-8333-333333333333"},
    capabilities:{...observed.capabilities,send:{available:true,reason:"Manual transfer only",mode:"manual-handoff"}}};
  assert.equal((await read(principal,projectId,external)).state,"manual");
  assert.equal((await read(principal,projectId,external)).reasonCode,"MANUAL_HANDOFF");
  assert.equal(calls.configuration,0);assert.equal(calls.session,0);
});

test("revoked or historical external links cannot claim manual handoff",async()=>{
  const {read,calls}=setup();
  const external:ObservedSession={...observed,key:"external:33333333-3333-4333-8333-333333333333",
    kind:"external",target:{kind:"external",linkId:"33333333-3333-4333-8333-333333333333"},
    membership:"historical",capabilities:{...observed.capabilities,
      send:{available:false,reason:"会话已关闭或接入已撤销。",mode:"unavailable"}}};
  const result=await read(principal,projectId,external);
  assert.equal(result.state,"blocked");assert.equal(result.reasonCode,"SESSION_UNAVAILABLE");
  assert.equal(result.reason,external.capabilities.send.reason);
  assert.equal(calls.configuration,0);assert.equal(calls.session,0);
});

test("send can be saveable while automatic execution is disabled or runtime unavailable",async()=>{
  for(const messages of [undefined,{enabled:false,pollIntervalMs:2000,readOnlyProtocolVerified:false,grants:[]}]){
    const {read}=setup({loadConfiguration:async()=>({runtime:{enabled:true,protocolVersion:"0.164.0-alpha.11.1",grants:[],delegationTemplates:[]},
      sessionMessages:messages})});
    const result=await read(principal,projectId,observed);
    assert.equal(observed.capabilities.send.available,true);
    assert.equal(result.state,"disabled");assert.equal(result.reasonCode,"SESSION_MESSAGES_DISABLED");
    assert.equal(result.reason,"普通自动回复未启用；保存后当前不会启动此会话。");
  }
  const runtimeOff=setup({loadConfiguration:async()=>({runtime:{enabled:false,protocolVersion:"0.164.0-alpha.11.1",grants:[],delegationTemplates:[]},
    sessionMessages:{enabled:true,pollIntervalMs:2000,readOnlyProtocolVerified:true,grants:[grant]}})});
  assert.equal((await runtimeOff.read(principal,projectId,observed)).reasonCode,"RUNTIME_DISABLED");
  assert.equal(runtimeOff.calls.runtime,0);
  const runnerOff=setup({runtimeAvailable:()=>false});
  assert.equal((await runnerOff.read(principal,projectId,observed)).reasonCode,"RUNTIME_UNAVAILABLE");
});

test("unsaveable, unready and unbound owned Sessions never gain execution status",async()=>{
  const unavailable={...observed,capabilities:{...observed.capabilities,send:{available:false,reason:"closed",mode:"unavailable" as const}}};
  const noSend=setup();
  assert.equal((await noSend.read(principal,projectId,unavailable)).reasonCode,"SESSION_UNAVAILABLE");
  assert.equal(noSend.calls.configuration,0);
  assert.equal((await noSend.read(principal,projectId,{...observed,runtimeState:"unknown"})).reasonCode,"SESSION_UNAVAILABLE");
  for(const record of [null,{...session,state:"unknown" as const},{...session,nativeThreadId:null}]){
    const {read,calls}=setup({readSession:async()=>record});
    assert.equal((await read(principal,projectId,observed)).reasonCode,"SESSION_UNAVAILABLE");
    assert.equal(calls.configuration,0);
  }
});

test("full execution and exact current grants stay honest, including receiver identity and cwd",async()=>{
  const protocolOff=setup({loadConfiguration:async()=>({runtime:{enabled:true,protocolVersion:"0.164.0-alpha.11.1",grants:[],delegationTemplates:[]},
    sessionMessages:{enabled:true,pollIntervalMs:2000,readOnlyProtocolVerified:false,grants:[grant]}})});
  assert.equal((await protocolOff.read(principal,projectId,observed)).reasonCode,"NATIVE_EXECUTION_UNVERIFIED",
    "the retired readonly switch does not gate ordinary full-permission conversations");
  const oldProfile=setup({readSession:async()=>({...session,sandbox:"read-only",approvalPolicy:"on-request"})});
  assert.equal((await oldProfile.read(principal,projectId,observed)).reasonCode,"EXECUTION_PROFILE_NOT_ACTIVE");
  for(const faulty of [[],[{...grant,enabled:false}],[{...grant,senderActorId:"other"}],
    [{...grant,receiverActorId:"lead"}],[{...grant,receiverRoleId:"other"}],[{...grant,cwd:"/other"}]]){
    const {read}=setup({loadConfiguration:async()=>({runtime:{enabled:true,protocolVersion:"0.164.0-alpha.11.1",grants:[],delegationTemplates:[]},
      sessionMessages:{enabled:true,pollIntervalMs:2000,readOnlyProtocolVerified:true,grants:faulty}})});
    assert.equal((await read(principal,projectId,observed)).reasonCode,"MESSAGE_GRANT_MISSING");
  }
  const runtimeGrantRevoked=setup({canExecuteSession:async()=>false});
  assert.equal((await runtimeGrantRevoked.read(principal,projectId,observed)).reasonCode,"SESSION_EXECUTION_GRANT_MISSING");
  const receiverRevoked=setup({isProjectWriter:async(_project,actor)=>actor==="lead"});
  assert.equal((await receiverRevoked.read(principal,projectId,observed)).reasonCode,"MESSAGE_GRANT_MISSING");
  const staleCwd=setup({cwdIsCurrent:async()=>false});
  assert.equal((await staleCwd.read(principal,projectId,observed)).reasonCode,"SESSION_CWD_UNAVAILABLE");
});

test("budget and busy hold execution, and a fully configured path remains unverified",async()=>{
  const exhausted=setup({turnsUsed:async()=>2});
  assert.equal((await exhausted.read(principal,projectId,observed)).reasonCode,"MESSAGE_BUDGET_EXHAUSTED");
  const busy=setup();
  assert.equal((await busy.read(principal,projectId,{...observed,busy:true})).reasonCode,"SESSION_BUSY");
  const ready=setup();
  const result=await ready.read(principal,projectId,observed);
  assert.equal(result.state,"unverified");assert.equal(result.reasonCode,"NATIVE_EXECUTION_UNVERIFIED");
  assert.equal(result.observedAt,at);assert.match(result.reason,/原生完整执行/);
});

test("dependency failures are sanitized and never expose native or configuration secrets",async()=>{
  for(const key of ["loadConfiguration","readSession","isProjectWriter","turnsUsed","cwdIsCurrent","canExecuteSession"] as const){
    const {read}=setup({[key]:async()=>{throw new Error("secret-token /private/config.toml");}} as Partial<MessageExecutionReaderDeps>);
    const result=await read(principal,projectId,observed);
    assert.equal(result.state,"unknown");assert.equal(result.reasonCode,"EXECUTION_STATUS_UNAVAILABLE");
    assert.doesNotMatch(JSON.stringify(result),/secret-token|private\/config/);
  }
});
