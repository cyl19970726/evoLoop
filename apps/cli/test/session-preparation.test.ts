import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalJson } from "@evoloop/core";
import { CliApiError, type ApiClient } from "../src/client.js";
import { ReceiptStore, ReceiptError } from "../src/receipts.js";
import { prepareSession } from "../src/session-preparation.js";

const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
const [projectId,sessionId,roleId,operationId]=[1,2,3,4].map(id);
const spec={projectId,sessionId,roleId,operationId,mode:"create",cwd:"/private/project",
  authorizationScope:"project",model:"gpt-6-sol",displayName:"功能开发",purpose:"持续承接已分派任务"};
const actor={actorId:"lead",projectIds:[projectId]};
const origin="http://localhost:4318",token="private-token";
const config={runtimeAvailable:true,grantReady:true,cwdReady:true,
  materialCli:{actorId:"recipient",command:"/private/cli",ready:true},roleActorId:"recipient",
  skills:[{path:".agents/skills/evoloop-workflow/SKILL.md",commit:"a".repeat(40),contentHash:"b".repeat(64),readSubcommand:"get /fixed"}]};
const snapshot=(session:Record<string,unknown>|null,profile:Record<string,unknown>|null=null,bound=false)=>({
  projectId,sessionId,roleId,roleVersion:2,session:session?{model:spec.model,...session}:null,profile,bound,config,
  missing:[...(!profile&&session?.state==="ready"?["display_profile"]:[]),...(!bound&&session?.state==="ready"?["role_binding"]:[])],
  readyForTasks:!!session&&session.state==="ready"&&!!profile&&bound});
async function oldPreparation(store:ReceiptStore,dir:string){
  const legacy={...spec,model:undefined};
  const frozen={...legacy,actorId:actor.actorId,apiUrl:origin};
  const body={type:"runtime.session.reserve",projectId,operationId,sessionId,roleId,cwd:spec.cwd,
    authorizationScope:spec.authorizationScope,sandbox:"danger-full-access",approvalPolicy:"never"};
  await store.prepare(origin,token,{id:operationId,operationId,projectId,kind:body.type,path:"/api/commands",
    body,confirmation:"command",recovery:{kind:"core",path:`/api/projects/${projectId}/operations/${operationId}`}},actor);
  await writeFile(join(dir,`.prepare-${operationId}.json`),JSON.stringify(frozen,Object.keys(frozen).sort()));
  return {legacy,body};
}

test("preparation reserves once, waits for native binding, then names and binds without assigning work",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"evoloop-prepare-"));
  try {
    let view=snapshot(null),posts:Record<string,unknown>[]=[];
    const api={get:async()=>view,post:async(_path:string,body:unknown)=>{
      const command=body as Record<string,unknown>;posts.push(command);
      if(command.type==="runtime.session.reserve")view=snapshot({state:"reserved",operationId,roleId,actorId:"lead",model:spec.model});
      if(command.type==="session.profile.set")view=snapshot({state:"ready",operationId,roleId,actorId:"lead",cwd:spec.cwd,authorizationScope:spec.authorizationScope},
        {version:1,displayName:spec.displayName,purpose:spec.purpose});
      if(command.type==="role.bindSession")view=snapshot({state:"ready",operationId,roleId,actorId:"lead",cwd:spec.cwd,authorizationScope:spec.authorizationScope},
        {version:1,displayName:spec.displayName,purpose:spec.purpose},true);
      return {status:"applied",operationId:command.operationId,entityId:sessionId,version:1};
    }} as ApiClient;
    const store=new ReceiptStore(dir),diagnostic=()=>{};
    const first=await prepareSession(spec,api,store,"http://localhost:4318","private-token",actor,diagnostic);
    assert.equal(first.status,"waiting_for_native_thread");
    assert.deepEqual(posts.map(value=>value.type),["runtime.session.reserve"]);
    view=snapshot({state:"ready",operationId,roleId,actorId:"lead",cwd:spec.cwd,authorizationScope:spec.authorizationScope,model:spec.model});
    const second=await prepareSession(spec,api,store,"http://localhost:4318","private-token",actor,diagnostic);
    assert.equal(second.status,"ready");
    assert.deepEqual(posts.map(value=>value.type),["runtime.session.reserve","session.profile.set","role.bindSession"]);
    const third=await prepareSession({...spec,mode:"reuse",model:undefined,operationId:id(5)},api,store,"http://localhost:4318","private-token",actor,diagnostic);
    assert.equal(third.status,"ready");
    assert.equal(posts.length,3,"reuse does not reserve another Session or assign a Task");
  } finally {await rm(dir,{recursive:true,force:true});}
});

test("old model-less preparation reconciles a committed reservation without a second POST",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"evoloop-prepare-legacy-"));
  try{
    const store=new ReceiptStore(dir),{legacy,body}=await oldPreparation(store,dir);
    let posts=0;
    const result={status:"applied",operationId,entityId:sessionId,version:1};
    const api={get:async(path:string)=>path.includes("/operations/")
      ? {id:operationId,projectId,actorId:actor.actorId,commandType:body.type,
        commandHash:createHash("sha256").update(canonicalJson({actorId:actor.actorId,command:body})).digest("hex"),result}
      : snapshot({state:"reserved",operationId,roleId,actorId:actor.actorId,cwd:spec.cwd,
        authorizationScope:spec.authorizationScope,model:null}),
      post:async()=>{posts++;throw Error("unexpected replay");}} as ApiClient;
    const recovered=await prepareSession(legacy,api,store,origin,token,actor,()=>{});
    assert.equal(recovered.status,"waiting_for_native_thread");
    assert.equal((await store.get(operationId)).state,"confirmed");
    assert.equal(posts,0);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test("old pending preparation with operation GET 404 stays unknown and names reviewer action",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"evoloop-prepare-legacy-unknown-"));
  try{
    const store=new ReceiptStore(dir),{legacy}=await oldPreparation(store,dir);
    let posts=0;
    const api={get:async()=>{throw new CliApiError(404,"OPERATION_NOT_FOUND",{code:"OPERATION_NOT_FOUND"},false);},
      post:async()=>{posts++;throw Error("unexpected replay");}} as ApiClient;
    await assert.rejects(prepareSession(legacy,api,store,origin,token,actor,()=>{}),error=>{
      assert.ok(error instanceof ReceiptError);
      assert.equal(error.code,"RESULT_UNCONFIRMED");
      assert.equal((error.data as {nextAction:string}).nextAction,"review_original_operation_and_session");
      return true;
    });
    assert.equal((await store.get(operationId)).state,"pending");
    assert.equal(posts,0);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test("a frozen legacy preparation without its reservation receipt cannot create a Session",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"evoloop-prepare-legacy-no-receipt-"));
  try{
    const store=new ReceiptStore(dir),{legacy}=await oldPreparation(store,dir);
    await rm(join(dir,`${operationId}.json`));
    let requests=0;
    const api={get:async()=>{requests++;return snapshot(null);},post:async()=>{requests++;return {};}} as ApiClient;
    const result=await prepareSession(legacy,api,store,origin,token,actor,()=>{});
    assert.equal(result.status,"recovery_required");
    assert.equal(result.reason,"legacy_reservation_receipt_missing");
    assert.equal(requests,0);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test("new CLI preparation requires an exact model before freezing or making a request",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"evoloop-prepare-no-model-"));
  try{
    let requests=0;
    const api={get:async()=>{requests++;return snapshot(null);},post:async()=>{requests++;return {};}} as ApiClient;
    await assert.rejects(prepareSession({...spec,model:undefined},api,new ReceiptStore(dir),
      "http://localhost:4318","private-token",actor,()=>{}),/exact model slug/);
    assert.equal(requests,0);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test("an unknown reserve keeps its original receipt and blocks another native start",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"evoloop-prepare-unknown-"));
  try {
    let posts=0;
    const api={get:async()=>snapshot(null),post:async()=>{posts++;throw new Error("connection lost");}} as ApiClient;
    const store=new ReceiptStore(dir),diagnostic=()=>{};
    await assert.rejects(prepareSession(spec,api,store,"http://localhost:4318","private-token",actor,diagnostic),
      (error:unknown)=>error instanceof ReceiptError&&error.code==="RESULT_UNCONFIRMED");
    await assert.rejects(prepareSession(spec,api,store,"http://localhost:4318","private-token",actor,diagnostic),
      (error:unknown)=>error instanceof ReceiptError&&error.code==="RESULT_UNCONFIRMED");
    assert.equal(posts,1);
    assert.equal((await store.get(operationId)).state,"pending");
  } finally {await rm(dir,{recursive:true,force:true});}
});

test("a confirmed reservation cannot be silently reused with changed inputs",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"evoloop-prepare-changed-"));
  try {
    let posts=0,view=snapshot(null);
    const api={get:async()=>view,post:async(_path:string,body:unknown)=>{
      posts++;
      view=snapshot({state:"reserved",operationId,roleId,actorId:"lead",cwd:spec.cwd,
        authorizationScope:spec.authorizationScope});
      return {status:"applied",operationId:(body as Record<string,unknown>).operationId,entityId:sessionId,version:1};
    }} as ApiClient;
    const store=new ReceiptStore(dir);
    await prepareSession(spec,api,store,"http://localhost:4318","private-token",actor,()=>{});
    await assert.rejects(prepareSession({...spec,cwd:"/other/project"},api,store,
      "http://localhost:4318","private-token",actor,()=>{}),/different saved intent/);
    assert.equal(posts,1);
  } finally {await rm(dir,{recursive:true,force:true});}
});

test("the complete preparation intent is frozen before native readiness and on reuse",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"evoloop-prepare-intent-"));
  try {
    let posts=0,view=snapshot(null);
    const api={get:async()=>view,post:async(_path:string,body:unknown)=>{
      posts++;
      const kind=(body as Record<string,unknown>).type;
      if(kind==="runtime.session.reserve")view=snapshot({state:"reserved",operationId,roleId,actorId:"lead",cwd:spec.cwd,
        authorizationScope:spec.authorizationScope});
      if(kind==="session.profile.set")view=snapshot({state:"ready",operationId,roleId,actorId:"lead",cwd:spec.cwd,
        authorizationScope:spec.authorizationScope},{version:1,displayName:spec.displayName,purpose:spec.purpose});
      if(kind==="role.bindSession")view=snapshot({state:"ready",operationId,roleId,actorId:"lead",cwd:spec.cwd,
        authorizationScope:spec.authorizationScope},{version:1,displayName:spec.displayName,purpose:spec.purpose},true);
      return {status:"applied",operationId:(body as Record<string,unknown>).operationId,entityId:sessionId,version:1};
    }} as ApiClient;
    const store=new ReceiptStore(dir);
    const first=await prepareSession(spec,api,store,"http://localhost:4318","private-token",actor,()=>{});
    assert.equal(first.status,"waiting_for_native_thread");
    await assert.rejects(prepareSession({...spec,displayName:"改名"},api,store,
      "http://localhost:4318","private-token",actor,()=>{}),/different saved intent/);
    await assert.rejects(prepareSession({...spec,mode:"reuse"},api,store,
      "http://localhost:4318","private-token",actor,()=>{}),/different saved intent/);
    assert.equal(posts,1);
    view=snapshot({state:"ready",operationId,roleId,actorId:"lead",cwd:spec.cwd,
      authorizationScope:spec.authorizationScope});
    await assert.rejects(prepareSession({...spec,purpose:"new purpose"},api,store,
      "http://localhost:4318","private-token",actor,()=>{}),/different saved intent/);
    const next={...spec,mode:"reuse" as const,operationId:id(8)};
    const reused=await prepareSession(next,api,store,"http://localhost:4318","private-token",actor,()=>{});
    assert.equal(reused.status,"ready");
    await assert.rejects(prepareSession({...next,displayName:"other"},api,store,
      "http://localhost:4318","private-token",actor,()=>{}),/different saved intent/);
  } finally {await rm(dir,{recursive:true,force:true});}
});
