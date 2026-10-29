import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkflowService } from "@evoloop/core";
import { DomainError } from "@evoloop/contracts/ports";
import { buildServer } from "../src/server.js";
import { grantAllowsModel, type RuntimeGrant } from "../src/configuration.js";
import type { RuntimeRunner } from "../src/runtime/runner.js";
import { runCli } from "../../cli/src/application.js";

const projectId=randomUUID(),sessionId=randomUUID(),token="m".repeat(40);
const grant:RuntimeGrant={projectId,actorId:"reviewer",roleId:"model-role",authorizationScope:"isolated",
  cwd:process.cwd(),sandbox:"danger-full-access",approvalPolicy:"never",networkAccess:true,
  model:"gpt-6",models:["deepseek/deepseek-flash","kimi-code-cn/k3.1-pro"]};
const headers={authorization:`Bearer ${token}`};
const command=(model?:string)=>({type:"runtime.session.reserve",projectId,operationId:randomUUID(),sessionId:randomUUID(),
  roleId:grant.roleId,authorizationScope:grant.authorizationScope,cwd:grant.cwd,
  sandbox:"danger-full-access",approvalPolicy:"never",...(model?{model}:{})});

test("model catalog and reservation apply the same exact authorization and active directory",async()=>{
  let calls=0;
  let active=["gpt-6","deepseek/deepseek-flash","deepseek/deepseek-v4-pro","kimi-code-cn/k3.1-pro"];
  let state:"available"|"empty"|"unavailable"="available";
  const service={getProject:async()=>({id:projectId}),getOperation:async()=>null,
    execute:async()=>{calls++;return {status:"applied",version:1};},
    getRuntimeSession:async()=>({id:sessionId,projectId,actorId:"reviewer",roleId:grant.roleId,
      authorizationScope:grant.authorizationScope,cwd:grant.cwd,sandbox:grant.sandbox,
      approvalPolicy:grant.approvalPolicy,model:"deepseek/deepseek-flash"}),
    listRoles:async()=>({items:[],nextCursor:null}),listRoleRevisions:async()=>[],listRoleReviews:async()=>[],
    listRoleHandoffs:async()=>[],listRoleSessionBindings:async()=>[],listSchedules:async()=>[],
    listScheduleRevisions:async()=>[],listScheduleOccurrences:async()=>[]} as unknown as WorkflowService;
  const app=await buildServer({service,credentials:[{token,actorId:"reviewer",projectIds:[projectId],permissions:["read","write","review"]}],
    runtime:{status:()=>({available:true,error:null})} as RuntimeRunner,
    runtimeGrants:()=>[grant],hasRuntimeGrant:scope=>scope.roleId===grant.roleId&&scope.cwd===grant.cwd&&
      scope.authorizationScope===grant.authorizationScope&&scope.sandbox===grant.sandbox&&grantAllowsModel(grant,scope.model),
    allowedRuntimeCwd:async()=>true,
    listRuntimeModels:async()=>({status:state,models:active,error:state==="unavailable"?"model_list_timeout":null,observedAtUtc:new Date().toISOString()})});
  try{
    const read=await app.inject({method:"GET",url:`/api/projects/${projectId}/runtime/models`,headers});
    assert.equal(read.statusCode,200);
    assert.deepEqual(JSON.parse(read.body).models,["gpt-6","deepseek/deepseek-flash","kimi-code-cn/k3.1-pro"]);
    assert.deepEqual(JSON.parse(read.body).environments[0].models,JSON.parse(read.body).models);
    const origin=await app.listen({host:"127.0.0.1",port:0});
    let stdout="",stderr="";
    const code=await runCli(["models","--project",projectId],{EVOLOOP_API_URL:origin,EVOLOOP_TOKEN:token},
      {stdout:value=>{stdout+=value;},stderr:value=>{stderr+=value;}});
    assert.equal(code,0,stderr);
    assert.deepEqual(JSON.parse(stdout).models,JSON.parse(read.body).models,"CLI must read the real service route");
    const omitted=await app.inject({method:"POST",url:"/api/commands",headers,payload:command()});
    assert.equal(JSON.parse(omitted.body).code,"MODEL_SELECTION_REQUIRED");
    assert.equal(calls,0,"an omitted slug cannot reach the reservation write");
    const unauthorized=await app.inject({method:"POST",url:"/api/commands",headers,payload:command("deepseek/deepseek-v4-pro")});
    assert.equal(JSON.parse(unauthorized.body).code,"MODEL_NOT_AUTHORIZED");
    active=["gpt-6","kimi-code-cn/k3.1-pro"];
    const inactive=await app.inject({method:"POST",url:"/api/commands",headers,payload:command("deepseek/deepseek-flash")});
    assert.equal(JSON.parse(inactive.body).code,"MODEL_NOT_ACTIVE");
    state="empty";active=[];
    const empty=await app.inject({method:"POST",url:"/api/commands",headers,payload:command("kimi-code-cn/k3.1-pro")});
    assert.equal(JSON.parse(empty.body).code,"MODEL_CATALOG_EMPTY");
    state="unavailable";
    const unavailable=await app.inject({method:"POST",url:"/api/commands",headers,payload:command("gpt-6")});
    assert.equal(JSON.parse(unavailable.body).code,"MODEL_CATALOG_UNAVAILABLE");
    assert.equal(calls,0,"denied or unknown catalog must not reserve a Session");
    state="available";active=["gpt-6","deepseek/deepseek-flash","kimi-code-cn/k3.1-pro"];
    for(const model of active){
      const created=await app.inject({method:"POST",url:"/api/commands",headers,payload:command(model)});
      assert.equal(created.statusCode,200,created.body);
    }
    assert.equal(calls,3);
    const run={type:"runtime.run.reserve",projectId,operationId:randomUUID(),runId:randomUUID(),
      taskId:randomUUID(),sessionId,expectedVersion:1,input:"small fixed turn"};
    active=["gpt-6","kimi-code-cn/k3.1-pro"];
    const stopped=await app.inject({method:"POST",url:"/api/commands",headers,payload:run});
    assert.equal(JSON.parse(stopped.body).code,"MODEL_NOT_ACTIVE","a changed catalog blocks later execution");
    assert.equal(calls,3);
  }finally{await app.close();}
});

test("CLI preparation reaches the coordinator with the exact selected slug",async()=>{
  const directory=await mkdtemp(join(tmpdir(),"evoloop-model-cli-service-"));
  let calls=0,received:Record<string,unknown>|null=null;
  const roleId=randomUUID(),newSessionId=randomUUID(),operationId=randomUUID();
  const service={getProject:async()=>({id:projectId}),getRole:async()=>({version:1,currentRevisionId:randomUUID(),state:"active",
    proposal:{goal:"test",independentResponsibility:"test",workflow:"test",handoffBoundary:"test"}}),
    getRuntimeSession:async()=>{throw new DomainError("NOT_FOUND","missing");},
    listRoleSessionBindings:async()=>[],execute:async(_principal:unknown,body:Record<string,unknown>)=>{
      calls++;received=body;return {status:"applied",operationId,entityId:newSessionId,version:1};},
    listRoles:async()=>({items:[],nextCursor:null}),listRoleRevisions:async()=>[],listRoleReviews:async()=>[],
    listRoleHandoffs:async()=>[],listSchedules:async()=>[],listScheduleRevisions:async()=>[],
    listScheduleOccurrences:async()=>[]} as unknown as WorkflowService;
  const scopedGrant={...grant,roleId};
  const app=await buildServer({service,credentials:[{token,actorId:"reviewer",projectIds:[projectId],permissions:["read","write","review"]}],
    runtime:{status:()=>({available:true,error:null})} as RuntimeRunner,runtimeGrants:()=>[scopedGrant],
    hasRuntimeGrant:scope=>scope.roleId===roleId&&grantAllowsModel(scopedGrant,scope.model),
    allowedRuntimeCwd:async()=>true,
    listRuntimeModels:async()=>({status:"available" as const,models:["deepseek/deepseek-flash"],error:null,observedAtUtc:new Date().toISOString()}),
    sessionPreparation:async()=>({runtimeAvailable:true,grantReady:true,cwdReady:true,
      materialCli:{actorId:"reviewer",command:"/private/cli",ready:true},roleActorId:"reviewer",
      skills:[{path:".agents/skills/evoloop-workflow/SKILL.md",commit:"a".repeat(40),contentHash:"b".repeat(64),readSubcommand:"get /fixed"}]})});
  try{
    const file=join(directory,"prepare.json");
    await writeFile(file,JSON.stringify({projectId,sessionId:newSessionId,operationId,roleId,mode:"create",
      cwd:grant.cwd,authorizationScope:grant.authorizationScope,displayName:"Flash",model:"deepseek/deepseek-flash"}));
    const origin=await app.listen({host:"127.0.0.1",port:0});
    let stdout="",stderr="";
    const code=await runCli(["session","prepare","--file",file],
      {EVOLOOP_API_URL:origin,EVOLOOP_TOKEN:token,EVOLOOP_STATE_DIR:join(directory,"receipts")},
      {stdout:value=>{stdout+=value;},stderr:value=>{stderr+=value;}});
    assert.equal(code,0,stderr);
    assert.equal(JSON.parse(stdout).status,"waiting_for_native_thread");
    assert.equal(calls,1);
    assert.equal(received?.model,"deepseek/deepseek-flash");
  }finally{await app.close();await rm(directory,{recursive:true,force:true});}
});

test("a legacy grant without exact models cannot create a new Session even when the catalog is available",async()=>{
  let calls=0;
  const legacy={...grant,model:undefined,models:undefined};
  const app=await buildServer({
    service:{getProject:async()=>({id:projectId}),getOperation:async()=>null,
      execute:async()=>{calls++;return {status:"applied",version:1};},
      listRoles:async()=>({items:[],nextCursor:null}),listRoleRevisions:async()=>[],listRoleReviews:async()=>[],
      listRoleHandoffs:async()=>[],listRoleSessionBindings:async()=>[],listSchedules:async()=>[],
      listScheduleRevisions:async()=>[],listScheduleOccurrences:async()=>[]} as unknown as WorkflowService,
    credentials:[{token,actorId:"reviewer",projectIds:[projectId],permissions:["read","write","review"]}],
    runtime:{status:()=>({available:true,error:null})} as RuntimeRunner,
    runtimeGrants:()=>[legacy],hasRuntimeGrant:scope=>grantAllowsModel(legacy,scope.model),
    allowedRuntimeCwd:async()=>true,
    listRuntimeModels:async()=>({status:"available" as const,models:["gpt-6","deepseek/deepseek-flash"],
      error:null,observedAtUtc:new Date().toISOString()})});
  try{
    const read=await app.inject({method:"GET",url:`/api/projects/${projectId}/runtime/models`,headers});
    assert.deepEqual(JSON.parse(read.body).models,[]);
    const noSlug=await app.inject({method:"POST",url:"/api/commands",headers,payload:command()});
    assert.equal(JSON.parse(noSlug.body).code,"MODEL_SELECTION_REQUIRED");
    const arbitrary=await app.inject({method:"POST",url:"/api/commands",headers,payload:command("gpt-6")});
    assert.equal(JSON.parse(arbitrary.body).code,"MODEL_NOT_AUTHORIZED");
    assert.equal(calls,0);
  }finally{await app.close();}
});
