import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ApiClient } from "../src/client.js";
import { ReceiptStore, ReceiptError } from "../src/receipts.js";
import { prepareSession } from "../src/session-preparation.js";

const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
const [projectId,sessionId,roleId,operationId]=[1,2,3,4].map(id);
const spec={projectId,sessionId,roleId,operationId,mode:"create",cwd:"/private/project",
  authorizationScope:"project",model:"gpt-6-sol",displayName:"功能开发",purpose:"持续承接已分派任务"};
const actor={actorId:"lead",projectIds:[projectId]};
const config={runtimeAvailable:true,grantReady:true,cwdReady:true,
  materialCli:{actorId:"recipient",command:"/private/cli",ready:true},roleActorId:"recipient",
  skills:[{path:".agents/skills/evoloop-workflow/SKILL.md",commit:"a".repeat(40),contentHash:"b".repeat(64),readSubcommand:"get /fixed"}]};
const snapshot=(session:Record<string,unknown>|null,profile:Record<string,unknown>|null=null,bound=false)=>({
  projectId,sessionId,roleId,roleVersion:2,session:session?{model:spec.model,...session}:null,profile,bound,config,
  missing:[...(!profile&&session?.state==="ready"?["display_profile"]:[]),...(!bound&&session?.state==="ready"?["role_binding"]:[])],
  readyForTasks:!!session&&session.state==="ready"&&!!profile&&bound});

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
    const third=await prepareSession({...spec,mode:"reuse",operationId:id(5)},api,store,"http://localhost:4318","private-token",actor,diagnostic);
    assert.equal(third.status,"ready");
    assert.equal(posts.length,3,"reuse does not reserve another Session or assign a Task");
  } finally {await rm(dir,{recursive:true,force:true});}
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
