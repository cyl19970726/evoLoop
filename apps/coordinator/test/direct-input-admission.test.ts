import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { RuntimeSessionRecord } from "@evoloop/contracts/runtime";
import type { UnitOfWork } from "@evoloop/contracts/ports";
import { DomainError } from "@evoloop/contracts/ports";
import { loadIntegrations } from "../src/configuration.js";
import { createDirectInputAdmission } from "../src/direct-input/integration.js";

const projectId=randomUUID(),sessionId=randomUUID(),roleId=randomUUID(),cwd="/tmp/direct-input-admission";
const bookingActor="session-booking-agent",businessActor="session-business-agent",senderActor="human-sender";

const session:RuntimeSessionRecord={
  projectId,id:sessionId,roleId,cwd,authorizationScope:"test-scope",model:"gpt-6-sol",
  sandbox:"danger-full-access",approvalPolicy:"never",state:"ready",version:1,
  nativeThreadId:"thread-fixture",nativeSessionId:"thread-fixture",operationId:randomUUID(),
  actorId:bookingActor,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),
  executionProfile:{activationState:"active",revision:{revisionId:randomUUID(),reasoningEffort:null},
    activeRevisionId:null,activationOperationId:null,attemptedAt:null,activationEvidence:null} as never,
};
const principal={actorId:senderActor,projectIds:[projectId],permissions:["read","write"] as Array<"read"|"write">};

function configuration(receiverActorId:string){
  return {
    runtime:{enabled:true,grants:[],materialCli:[{projectId,sessionId,sessionActorId:bookingActor,
      cliActorId:businessActor,command:"/bin/true"}]},
    residentQueue:{enabled:true,roleActors:[{projectId,roleId,actorId:businessActor}]},
    sessionMessages:{enabled:true,grants:[{projectId,sessionId,senderActorId:senderActor,
      receiverActorId,receiverRoleId:roleId,cwd,enabled:true}]},
    directInputs:{enabled:true,grants:[{projectId,sessionId,senderActorId:senderActor,
      canSteer:true,canStart:true}]},
  };
}

async function admissionFor(value:ReturnType<typeof configuration>){
  const root=await mkdtemp(join(tmpdir(),"direct-input-admission-")),file=join(root,"integrations.json");
  await writeFile(file,JSON.stringify(value));
  const uow={read:async(_projectId:string,run:(reader:{getRuntimeSession(id:string):Promise<RuntimeSessionRecord|null>})=>unknown)=>
    run({getRuntimeSession:async id=>id===sessionId?session:null})} as unknown as UnitOfWork;
  const pool={query:async()=>({rows:[{binding:1}],rowCount:1})};
  const result=createDirectInputAdmission({uow,pool,configuration:()=>loadIntegrations(file),
    currentProjectWriter:async(_project,actor)=>actor===businessActor||actor===senderActor,
    currentSessionExecutionAuthority:async()=>true,allowedCwd:async(_project,value)=>value===cwd});
  return {result,cleanup:()=>rm(root,{recursive:true,force:true})};
}

test("a grant written with the Session business identity is admitted although another actor booked it", async()=>{
  const {result,cleanup}=await admissionFor(configuration(businessActor));
  try{
    const admitted=await result.admission(principal,projectId,sessionId);
    assert.equal(admitted.grant.receiverActorId,businessActor);
    assert.equal(admitted.grant.canSteer,true);
    assert.equal(admitted.grant.canStart,true);
    assert.equal(admitted.binding.sessionId,sessionId);
  }finally{await cleanup();}
});

test("a grant still written with the booking identity is refused", async()=>{
  const {result,cleanup}=await admissionFor(configuration(bookingActor));
  try{
    await assert.rejects(result.admission(principal,projectId,sessionId),(error:unknown)=>
      error instanceof DomainError&&error.code==="DIRECT_GRANT_MISSING");
  }finally{await cleanup();}
});
