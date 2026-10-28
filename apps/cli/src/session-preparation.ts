import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { commandSchema } from "@evoloop/contracts";
import { ApiClient } from "./client.js";
import { dispatchMutation, reconcileReceipt, record, ReceiptStore, type VerifiedActor } from "./receipts.js";

const specificationSchema=z.strictObject({
  projectId:z.uuid(),sessionId:z.uuid(),operationId:z.uuid(),roleId:z.uuid(),
  mode:z.enum(["create","reuse"]),cwd:z.string().regex(/^\//).optional(),
  authorizationScope:z.string().min(1).optional(),model:z.string().min(1).optional(),
  displayName:z.string().trim().min(1).max(240).optional(),purpose:z.string().trim().max(4000).optional(),
}).superRefine((value,ctx)=>{
  if(value.mode==="create"&&(!value.cwd||!value.authorizationScope||!value.displayName))
    ctx.addIssue({code:"custom",message:"Create needs cwd, authorizationScope and displayName"});
});
export type SessionPreparationSpec=z.infer<typeof specificationSchema>;

async function freezePreparation(spec:SessionPreparationSpec,store:ReceiptStore,origin:string,actor:VerifiedActor){
  const file=join(store.directory,`.prepare-${spec.operationId}.json`);
  const body={...spec,actorId:actor.actorId,apiUrl:origin};
  const content=JSON.stringify(body,Object.keys(body).sort());
  await mkdir(store.directory,{recursive:true,mode:0o700});
  const temporary=join(store.directory,`.prepare-${spec.operationId}-${randomUUID()}.tmp`);
  try {
    const handle=await open(temporary,"wx",0o600);
    try {await handle.writeFile(content);await handle.sync();} finally {await handle.close();}
    try {await link(temporary,file);}
    catch(error){if((error as NodeJS.ErrnoException).code!=="EEXIST")throw error;}
  } finally {await rm(temporary,{force:true});}
  let saved:unknown;
  try {saved=JSON.parse(await readFile(file,"utf8"));}
  catch {throw new Error("The saved preparation intent is incomplete; preserve this operation ID for recovery");}
  if(JSON.stringify(saved)!==content)
    throw new Error("This preparation operation already has a different saved intent; use a new ID for changed inputs");
}

/** Stage IDs remain stable across process restarts and cannot be reused with altered command bodies. */
function stageId(base:string,stage:string):string {
  const hex=createHash("sha256").update(`session-preparation:${base}:${stage}`).digest("hex");
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-5${hex.slice(13,16)}-8${hex.slice(17,20)}-${hex.slice(20,32)}`;
}
const object=(value:unknown,name:string)=>{
  const result=record(value);
  if(!result)throw new Error(`${name} is invalid`);
  return result;
};

export async function prepareSession(input:unknown,client:ApiClient,store:ReceiptStore,origin:string,token:string,
  actor:VerifiedActor,diagnostic:(value:unknown)=>void) {
  const spec=specificationSchema.parse(input);
  if(!actor.projectIds.includes(spec.projectId))throw new Error("CLI identity does not belong to the selected project");
  await freezePreparation(spec,store,origin,actor);
  const endpoint=`/api/projects/${spec.projectId}/session-preparation/${spec.sessionId}`;
  const query=new URLSearchParams({roleId:spec.roleId});
  if(spec.cwd)query.set("cwd",spec.cwd);
  if(spec.authorizationScope)query.set("authorizationScope",spec.authorizationScope);
  if(spec.model)query.set("model",spec.model);
  const inspect=async()=>object(await client.get(`${endpoint}?${query}`),"Preparation readback");
  const mutate=async(body:unknown)=>{
    const command=commandSchema.parse(body);
    return dispatchMutation(client,store,origin,token,{id:command.operationId,operationId:command.operationId,
      projectId:spec.projectId,kind:command.type,path:"/api/commands",body:command,confirmation:"command",
      recovery:{kind:"core",path:`/api/projects/${spec.projectId}/operations/${command.operationId}`}},diagnostic,actor);
  };
  for(const id of [spec.operationId,stageId(spec.operationId,"profile"),stageId(spec.operationId,"role-binding")]){
    let receipt;
    try { receipt=await store.get(id); }
    catch(error){ if((error as NodeJS.ErrnoException).code==="ENOENT")continue; throw error; }
    store.checkScope(receipt,origin,token,actor);
    if(id===spec.operationId && spec.mode==="create" && receipt.kind==="runtime.session.reserve"){
      const original=record(receipt.body);
      if(original?.sessionId!==spec.sessionId||original?.roleId!==spec.roleId||original?.cwd!==spec.cwd||
        original?.authorizationScope!==spec.authorizationScope||original?.model!==(spec.model??undefined))
        throw new Error("The saved reservation has different inputs; use its original receipt");
    }
    if(receipt.state==="pending")receipt=await reconcileReceipt(client,store,origin,token,id,actor);
    if(receipt.state==="rejected")return {status:"recovery_required",reason:"saved_operation_rejected",operationId:id};
  }
  let snapshot=await inspect();
  const session=record(snapshot.session);
  if(spec.mode==="reuse"&&!session)return {status:"blocked",reason:"session_missing",snapshot};
  if(session&&spec.mode==="create"&&session.operationId!==spec.operationId)
    return {status:"blocked",reason:"session_belongs_to_another_reservation",snapshot};
  if(session&&(spec.cwd&&session.cwd!==spec.cwd||spec.authorizationScope&&session.authorizationScope!==spec.authorizationScope||
    spec.model!==undefined&&session.model!==spec.model))return {status:"blocked",reason:"session_profile_mismatch",snapshot};
  const missing=(snapshot.missing as string[]).filter(code=>!["role_binding","display_profile","session_unknown"].includes(code));
  if(missing.length)return {status:"blocked",reason:"configuration_or_state",missing,snapshot};
  if(!session){
    await mutate({type:"runtime.session.reserve",projectId:spec.projectId,operationId:spec.operationId,
      sessionId:spec.sessionId,roleId:spec.roleId,cwd:spec.cwd,authorizationScope:spec.authorizationScope,
      ...(spec.model?{model:spec.model}:{}),sandbox:"danger-full-access",approvalPolicy:"never"});
    snapshot=await inspect();
    return {status:"waiting_for_native_thread",reserveOperationId:spec.operationId,snapshot};
  }
  if(session.state==="closed"||session.state==="closing")
    return {status:"blocked",reason:"session_closing_or_closed",snapshot};
  if(session.state!=="ready")return {status:session.state==="unknown"?"recovery_required":"waiting_for_native_thread",
    reserveOperationId:session.operationId,snapshot};
  const profile=record(snapshot.profile);
  if(spec.displayName&&(!profile||profile.displayName!==spec.displayName||profile.purpose!==(spec.purpose??""))){
    await mutate({type:"session.profile.set",projectId:spec.projectId,operationId:stageId(spec.operationId,"profile"),
      target:{kind:"owned",sessionId:spec.sessionId},expectedVersion:profile?.version??0,
      displayName:spec.displayName,purpose:spec.purpose??"",membership:"current",tenure:"resident",
      reason:"Set the prepared Session identity without assigning a Task"});
    snapshot=await inspect();
  }
  if(snapshot.bound!==true){
    await mutate({type:"role.bindSession",projectId:spec.projectId,operationId:stageId(spec.operationId,"role-binding"),
      roleId:spec.roleId,expectedVersion:snapshot.roleVersion,sessionId:spec.sessionId,
      note:"Bind the ready owned Session for later Task assignment"});
    snapshot=await inspect();
  }
  return {status:snapshot.readyForTasks===true?"ready":"incomplete",snapshot};
}
