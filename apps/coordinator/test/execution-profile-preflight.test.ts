import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { RuntimeSessionSpec } from "@evoloop/contracts/runtime";
import type { Command, Principal, RuntimeSessionRecord } from "@evoloop/contracts";
import { DomainError } from "@evoloop/contracts/ports";
import type { WorkflowService } from "@evoloop/core";
import { CodexAppServerAdapter, RuntimeProtocolError, RuntimeServerError } from "@evoloop/adapter-codex-app-server";
import { RuntimeRunner } from "../src/runtime/runner.js";
import { buildServer } from "../src/server.js";

function fixture() {
  const projectId=randomUUID(),sessionId=randomUUID(),revisionId=randomUUID();
  const principal:Principal={actorId:"reviewer",projectIds:[projectId],permissions:["read","write","review"]};
  const revision={projectId,sessionId,revisionId,version:1,model:"old-model",reasoningEffort:"low",
    sandbox:"danger-full-access" as const,approvalPolicy:"never" as const,cwd:"/tmp/profile-preflight",
    authorizationScope:"bounded",provenance:"reserved" as const,previousRevisionId:null,
    operationId:randomUUID(),actorId:principal.actorId,reason:"initial",evidenceRef:null,createdAt:new Date().toISOString()};
  const session:RuntimeSessionRecord={projectId,id:sessionId,roleId:randomUUID(),cwd:revision.cwd,
    authorizationScope:revision.authorizationScope,model:revision.model,sandbox:revision.sandbox,
    approvalPolicy:revision.approvalPolicy,state:"ready",version:3,nativeThreadId:"owned-thread",
    nativeSessionId:"owned-native-session",operationId:revision.operationId,actorId:principal.actorId,
    createdAt:revision.createdAt,updatedAt:revision.createdAt,executionProfile:{revision,activeRevisionId:revisionId,
      activeModel:revision.model,activeReasoningEffort:"low",activationState:"active",activationOperationId:null,
      attemptedAt:null,activationEvidence:null}};
  const command:Extract<Command,{type:"runtime.session.executionProfile.revise"}>={
    type:"runtime.session.executionProfile.revise",projectId,operationId:randomUUID(),sessionId,
    expectedVersion:3,expectedExecutionProfileRevisionId:revisionId,model:"new-model",reasoningEffort:"high",
    sandbox:"danger-full-access",approvalPolicy:"never",reason:"approved",evidenceRef:"document:approved"};
  let status="notLoaded", failure:Error|null=new RuntimeServerError("thread/turns/list",1,-32600,"rollout not found"),
    grant=true, prior=false, writes=0, conflict=false, empty=false;
  const calls:string[]=[];
  const native={isReady:()=>true,registerBinding:async(binding:{nativeThreadId:string;nativeSessionId:string})=>{
    calls.push("register");assert.equal(binding.nativeThreadId,session.nativeThreadId);
    assert.equal(binding.nativeSessionId,session.nativeSessionId);},
    inspect:async()=>{calls.push("inspect");return {thread:{id:session.nativeThreadId,
      sessionId:session.nativeSessionId,cwd:session.cwd,status:{type:status}}};},
    listTurns:async()=>{calls.push("listTurns");if(failure)throw failure;return {data:empty?[]:[{id:"old-turn",status:"completed"}],nextCursor:null};},
    resume:async()=>{assert.fail("preflight must not resume");},
    activateExecutionProfile:async()=>{assert.fail("preflight must not activate");},
    startTurn:async()=>{assert.fail("preflight must not start a Turn");}};
  const workflow={listRoles:async()=>({items:[],nextCursor:null}),listRoleRevisions:async()=>[],
    listRoleReviews:async()=>[],listRoleHandoffs:async()=>[],listRoleSessionBindings:async()=>[],
    listSchedules:async()=>[],listScheduleRevisions:async()=>[],listScheduleOccurrences:async()=>[],getRuntimeSession:async()=>session,getOperation:async()=>prior?{id:command.operationId}:null,
    execute:async(_p:Principal,c:Command)=>{calls.push("execute");if(conflict)throw new DomainError("OPERATION_REUSED","actor/hash differs");
      if(!prior){writes++;session.version++;session.executionProfile!.activationState="pending";}
      return {status:"applied",operationId:c.operationId,entityId:sessionId,version:4};},
  } as unknown as WorkflowService;
  const runner=new RuntimeRunner({runtimeFactory:()=>native as unknown as ReturnType<RuntimeRunner["nativeAdapter"]>,
    workflow,trusted:{} as never,principals:[principal],canWrite:()=>true,allowedCwd:async()=>true,hasGrant:()=>grant});
  runner.status=()=>({available:true,error:null,faults:[]});
  return {principal,session,command,runner,workflow,calls,native:native as Record<string,unknown>,get writes(){return writes;},
    setEmpty:()=>{empty=true;},setStatus:(s:string)=>{status=s;},setFailure:(e:Error|null)=>{failure=e;},setGrant:(g:boolean)=>{grant=g;},
    setPrior:()=>{prior=true;},setConflict:()=>{conflict=true;}};
}

test("HTTP rejects zero-Turn unloaded profile before persistence and retains the active revision",async()=>{
  const f=fixture(),before=structuredClone(f.session),token="a".repeat(40);
  const app=await buildServer({service:f.workflow,credentials:[{token,...f.principal}],runtime:f.runner,
    listRuntimeModels:async()=>({status:"available",models:["new-model"],options:[{model:"new-model",
      supportedReasoningEfforts:["high"],defaultReasoningEffort:"high"}],error:null,observedAtUtc:new Date().toISOString()})});
  try {
    const result=await app.inject({method:"POST",url:"/api/commands",headers:{authorization:`Bearer ${token}`},payload:f.command});
    assert.equal(result.statusCode,409,result.body);
    assert.equal(result.json().code,"EXECUTION_PROFILE_ZERO_TURN_UNSUPPORTED");
    assert.match(result.json().message,/旧|原/);
    assert.equal(f.writes,0);assert.deepEqual(f.session,before);
    assert.deepEqual(f.calls,["register","inspect","listTurns"]);
  } finally {await app.close();}
});

for(const scenario of ["notLoaded with history","loaded with history","running with history","idle zero Turn","empty history","unrelated RPC rejection","unrelated -32600","transport failure"]){
  test(`read-only profile preflight distinguishes ${scenario}`,async()=>{
    const f=fixture();
    if(scenario==="notLoaded with history")f.setFailure(null);
    if(scenario==="loaded with history"){f.setStatus("idle");f.setFailure(null);}
    if(scenario==="running with history"){f.setStatus("active");f.setFailure(null);}
    if(scenario==="idle zero Turn")f.setStatus("idle");
    if(scenario==="unrelated RPC rejection")f.setFailure(new RuntimeServerError("thread/turns/list",1,-32602,"bad params"));
    if(scenario==="empty history"){f.setFailure(null);f.setEmpty();}
    if(scenario==="unrelated -32600")f.setFailure(new RuntimeServerError("thread/turns/list",1,-32600,"bad request"));
    if(scenario==="transport failure")f.setFailure(new RuntimeProtocolError("connection lost"));
    if(scenario==="empty history"||scenario==="idle zero Turn")
      await assert.rejects(()=>f.runner.preflightExecutionProfileRevision(f.principal,f.command),
        (error:unknown)=>error instanceof DomainError&&error.code==="EXECUTION_PROFILE_ZERO_TURN_UNSUPPORTED");
    else if(scenario==="unrelated RPC rejection"||scenario==="unrelated -32600"||scenario==="transport failure")
      await assert.rejects(()=>f.runner.preflightExecutionProfileRevision(f.principal,f.command),
        (error:unknown)=>error instanceof DomainError&&error.code==="RUNTIME_READ_UNAVAILABLE");
    else await f.runner.preflightExecutionProfileRevision(f.principal,f.command);
    assert.equal(f.writes,0);assert.equal(f.session.executionProfile!.activationState,"active");
    assert.deepEqual(f.calls,["register","inspect","listTurns"]);
  });
}

test("profile preflight checks caller permission, exact binding grant and both versions before native reads",async()=>{
  for(const kind of ["permission","grant","version","revision"]){
    const f=fixture();let p=f.principal,c=f.command;
    if(kind==="permission")p={...p,permissions:["read","review"]};
    if(kind==="grant")f.setGrant(false);
    if(kind==="version")c={...c,expectedVersion:2};
    if(kind==="revision")c={...c,expectedExecutionProfileRevisionId:randomUUID()};
    await assert.rejects(()=>f.runner.preflightExecutionProfileRevision(p,c),(e:unknown)=>e instanceof DomainError&&
      e.code===(kind==="version"?"VERSION_CONFLICT":kind==="revision"?"EXECUTION_PROFILE_CONFLICT":"FORBIDDEN"));
    assert.deepEqual(f.calls,[]);assert.equal(f.writes,0);
  }
});

test("HTTP original operation reaches actor/hash validation without catalog or native preflight after drift",async()=>{
  const f=fixture(),token="a".repeat(40);f.setPrior();f.setGrant(false);
  const app=await buildServer({service:f.workflow,credentials:[{token,...f.principal}],runtime:f.runner,
    listRuntimeModels:async()=>{assert.fail("replay must not read catalog");}});
  try {
    const send=()=>app.inject({method:"POST",url:"/api/commands",headers:{authorization:`Bearer ${token}`},payload:f.command});
    assert.equal((await send()).statusCode,200);assert.deepEqual(f.calls,["execute"]);
    f.setConflict();const reused=await send();assert.equal(reused.statusCode,409);
    assert.equal(reused.json().code,"OPERATION_REUSED");assert.equal(f.writes,0);
  }finally{await app.close();}
});


for(const mode of ["zero-turn-not-loaded","zero-turn","zero-turn-generic-reject"])
test(`coordinator preflight preserves first-start proof for ${mode}`,async t=>{
  const f=fixture();
  f.session.cwd="/tmp/evoloop-fixture";
  f.session.model="gpt-6-sol";
  f.session.executionProfile!.revision={...f.session.executionProfile!.revision,
    cwd:f.session.cwd,model:f.session.model,reasoningEffort:null};
  f.session.executionProfile!.activeModel=f.session.model;
  f.session.executionProfile!.activeReasoningEffort=null;
  const adapter=new CodexAppServerAdapter({executable:process.execPath,
    spawnArgs:[resolve(import.meta.dirname,"../../../packages/adapter-codex-app-server/test/fixture.mjs"),mode],
    expectedVersion:"codex-cli 0.166.0-alpha.6",verifyBinding:async()=>true,initializationTimeoutMs:5000});
  t.after(()=>adapter.close());await adapter.open();
  const spec:RuntimeSessionSpec={actorId:f.session.actorId,sessionId:f.session.id,roleId:f.session.roleId,
    projectId:f.session.projectId,cwd:f.session.cwd,authorizationScope:f.session.authorizationScope,
    model:f.session.model!,sandbox:f.session.sandbox,approvalPolicy:f.session.approvalPolicy,
    executionProfileRevisionId:f.command.expectedExecutionProfileRevisionId};
  const binding=await adapter.create(spec);
  assert.equal(adapter.hasFreshStartProof(binding),true);
  if(mode==="zero-turn-generic-reject"){
    await assert.rejects(()=>adapter.listTurns(binding),(error:unknown)=>
      error instanceof RuntimeServerError&&error.method==="thread/turns/list"&&
      error.code===-32600&&error.category==="server_rejected");
    assert.equal(adapter.hasFreshStartProof(binding),true);
  }
  f.session.nativeThreadId=binding.nativeThreadId;f.session.nativeSessionId=binding.nativeSessionId;
  const runner=new RuntimeRunner({runtimeFactory:()=>adapter,workflow:f.workflow,trusted:{} as never,
    principals:[f.principal],canWrite:()=>true,allowedCwd:async()=>true,hasGrant:()=>true});
  const before=structuredClone(f.session);
  await assert.rejects(()=>runner.preflightExecutionProfileRevision(f.principal,f.command),
    (e:unknown)=>e instanceof DomainError&&e.code==="EXECUTION_PROFILE_ZERO_TURN_UNSUPPORTED");
  assert.deepEqual(f.session,before);assert.equal(f.writes,0);
  if(mode==="zero-turn-generic-reject"){
    const token="b".repeat(40);
    const app=await buildServer({service:f.workflow,credentials:[{token,...f.principal}],runtime:runner,
      listRuntimeModels:async()=>{assert.fail("zero-Turn preflight must run before model catalog");}});
    try{
      const response=await app.inject({method:"POST",url:"/api/commands",
        headers:{authorization:`Bearer ${token}`},payload:f.command});
      assert.equal(response.statusCode,409,response.body);
      assert.equal(response.json().code,"EXECUTION_PROFILE_ZERO_TURN_UNSUPPORTED");
      assert.equal(f.writes,0);
    }finally{await app.close();}
  }
  await adapter.resume(binding,spec);
  await adapter.startTurn(binding,"first authorized Turn under the original profile","first-operation",
    f.session.executionProfile!.revision);
  const observed=await adapter.inspect(binding) as {observedTurnStarts:number;observedResumes:number};
  assert.equal(observed.observedTurnStarts,1);assert.equal(observed.observedResumes,0);
});

for(const denied of [false,true])test(`HTTP historical notLoaded Thread reaches core ${denied?"authorization rejection":"save"}`,async()=>{
  const f=fixture(),token="a".repeat(40);f.setFailure(null);
  const execute=f.workflow.execute.bind(f.workflow);
  f.workflow.execute=async(principal,command)=>{
    if(denied)throw new DomainError("FORBIDDEN","current transactional authority denied");
    return execute(principal,command);
  };
  const app=await buildServer({service:f.workflow,credentials:[{token,...f.principal}],runtime:f.runner,
    listRuntimeModels:async()=>({status:"available",models:["new-model"],options:[{model:"new-model",
      supportedReasoningEfforts:["high"],defaultReasoningEffort:"high"}],error:null,observedAtUtc:new Date().toISOString()})});
  try{
    const result=await app.inject({method:"POST",url:"/api/commands",headers:{authorization:`Bearer ${token}`},payload:f.command});
    assert.equal(result.statusCode,denied?403:200,result.body);assert.equal(f.writes,denied?0:1);
    assert.equal(f.session.executionProfile!.activationState,denied?"active":"pending");
  }finally{await app.close();}
});

test("an effort-only change on a runtime that applies effort with each turn/start needs no native inspection",async()=>{
  const f=fixture(),token="a".repeat(40);
  f.native.appliesEffortWithNextTurn=()=>true;
  const app=await buildServer({service:f.workflow,credentials:[{token,...f.principal}],runtime:f.runner});
  try {
    // Zero-Turn and unloaded: the native checks would refuse, but there is nothing to activate.
    const effortOnly={...f.command,model:"old-model",reasoningEffort:"max"};
    const result=await app.inject({method:"POST",url:"/api/commands",headers:{authorization:`Bearer ${token}`},payload:effortOnly});
    assert.equal(result.statusCode,200,result.body);
    assert.deepEqual(f.calls,["execute"],"no registration, inspection or history read");
    assert.equal(f.runner.effortAppliesNextTurn(f.session),true);
    // A catalog that lists the model is binding; one that is empty or lacks it did not block the change above.
    const listed=await buildServer({service:f.workflow,credentials:[{token,...f.principal}],runtime:f.runner,
      listRuntimeModels:async()=>({status:"available",models:["old-model"],options:[{model:"old-model",supportedReasoningEfforts:["low","high"],
        defaultReasoningEffort:"high"}],error:null,observedAtUtc:new Date().toISOString()})});
    try {
      f.calls.length=0;
      const unsupported=await listed.inject({method:"POST",url:"/api/commands",headers:{authorization:`Bearer ${token}`},
        payload:{...effortOnly,operationId:randomUUID(),expectedVersion:f.session.version}});
      assert.equal(unsupported.statusCode,409,unsupported.body);
      assert.equal(unsupported.json().code,"REASONING_EFFORT_UNSUPPORTED");
    } finally {await listed.close();}
    // Any model change that carries an effort would need the in-place switch this runtime lacks: refused up front and nothing is saved.
    f.calls.length=0;
    const both=await app.inject({method:"POST",url:"/api/commands",headers:{authorization:`Bearer ${token}`},payload:{...f.command,operationId:randomUUID(),expectedVersion:f.session.version}});
    assert.equal(both.statusCode,409,both.body);
    assert.equal(both.json().code,"EXECUTION_PROFILE_MODEL_CHANGE_UNSUPPORTED");
    assert.doesNotMatch(both.json().message??"",/先只改模型/,"the advice no longer points to a two-step route that cannot work");
    assert.match(both.json().message??"",/新建 Session/);
    assert.deepEqual(f.calls,[],"nothing was read or written");
    // A model change alone that keeps the Session's effort is the same thing: it was once saved as a model revision nothing could activate.
    f.calls.length=0;
    const modelOnly=await app.inject({method:"POST",url:"/api/commands",headers:{authorization:`Bearer ${token}`},
      payload:{...f.command,operationId:randomUUID(),expectedVersion:f.session.version,reasoningEffort:f.session.executionProfile!.revision.reasoningEffort}});
    assert.equal(modelOnly.statusCode,409,modelOnly.body);
    assert.equal(modelOnly.json().code,"EXECUTION_PROFILE_MODEL_CHANGE_UNSUPPORTED");
    assert.deepEqual(f.calls,[],"refused before any native read, and nothing was saved");
  } finally {await app.close();}
});
