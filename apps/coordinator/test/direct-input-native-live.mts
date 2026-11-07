/** Opt-in candidate exercise: real HTTP, dedicated PG and a private alpha.6 native Thread.
 * Run only with an evoloop_*_test database and an explicit LIVE_CODEX_BIN.
 */
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import Fastify from "fastify";
import { migrate, PostgresUnitOfWork } from "@evoloop/adapter-postgres";
import { PgDirectInputs } from "@evoloop/adapter-postgres/direct-input";
import { CodexAppServerAdapter } from "@evoloop/adapter-codex-app-server";
import { SessionMessageService } from "@evoloop/core/session-messages";
import { DirectInputService } from "../src/direct-input/service.js";
import { registerDirectInputRoutes } from "../src/direct-input/routes.js";
import { SessionMessagePump } from "../src/session-messages/pump.js";
import type {} from "../src/server.js";

const url = process.env.TEST_DATABASE_URL;
const executable = process.env.LIVE_CODEX_BIN;
const actorId = process.env.LIVE_DIRECT_ACTOR ?? "candidate-consumer";
if (!url || !/^evoloop(?:_[a-z0-9]+)*_test$/.test(new URL(url).pathname.slice(1)) || !executable)
  throw new Error("Dedicated evoloop_*_test database and LIVE_CODEX_BIN are required");
const schema = `el_live_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
const projectId = randomUUID(), sessionId = randomUUID(), roleId = randomUUID();
const cwd = await realpath(await mkdtemp(join(tmpdir(), "evoloop-direct-live-")));
const rows = Array.from({length:36}, (_, i) => {
  const group = ["amber", "blue", "copper"][i % 3];
  const amount = (i * 7) % 29 + 2;
  return `C${String(i+1).padStart(2,"0")},${group},${amount},${i % 7 === 0 ? "hold" : "ready"}`;
});
await writeFile(join(cwd,"cases.csv"),`id,group,amount,status\n${rows.join("\n")}\n`);
const pool = new pg.Pool({connectionString:url,options:`-c search_path=${schema}`});
const native = new CodexAppServerAdapter({executable,expectedVersion:"codex-cli 0.166.0-alpha.6",
  workspaceExperimental:true,requestTimeoutMs:30000,initializationTimeoutMs:30000,
  verifyBinding:async candidate=>{
    const result=await pool.query(`SELECT 1 FROM runtime_session WHERE project_id=$1 AND session_id=$2
      AND role_id=$3 AND cwd=$4 AND native_thread_id=$5 AND native_session_id=$6
      AND authorization_scope=$7 AND state='ready'`,[candidate.projectId,candidate.sessionId,candidate.roleId,
      candidate.cwd,candidate.nativeThreadId,candidate.nativeSessionId,candidate.authorizationScope]);
    return result.rowCount===1;
  }});
const app = Fastify();
const token = randomUUID();
const events:string[] = [];
let binding:Awaited<ReturnType<typeof native.create>>;
let address = "";
try {
  await migrate(url,schema);
  await pool.query("INSERT INTO project(project_id,title,created_at) VALUES($1,'Isolated direct input',now())",[projectId]);
  await pool.query(`INSERT INTO runtime_session(project_id,session_id,role_id,cwd,authorization_scope,
    sandbox,approval_policy,model,state,version,operation_id,actor_id,created_at,updated_at)
    VALUES($1,$2,$3,$4,'isolated-direct-input','danger-full-access','never','gpt-6-sol','creating',1,$5,
    'isolated-agent',now(),now())`,[projectId,sessionId,roleId,cwd,randomUUID()]);
  const profile=(await pool.query("SELECT revision_id FROM session_execution_profile WHERE project_id=$1 AND session_id=$2",[projectId,sessionId])).rows[0];
  assert.ok(profile?.revision_id,"stored Session profile revision is required before native creation");
  await native.open();
  binding = await native.create({actorId:"isolated-agent",sessionId,roleId,projectId,cwd,
    authorizationScope:"isolated-direct-input",model:"gpt-6-sol",sandbox:"danger-full-access",approvalPolicy:"never",
    executionProfileRevisionId:profile.revision_id});
  await pool.query("UPDATE runtime_session SET state='ready',native_thread_id=$3,native_session_id=$4,version=version+1,updated_at=now() WHERE project_id=$1 AND session_id=$2",
    [projectId,sessionId,binding.nativeThreadId,binding.nativeSessionId]);
  native.onEvent(event => {if (event.sessionId===sessionId && ["turn/started","turn/completed","item/started","item/completed"].includes(event.method)) events.push(event.method);});
  const grant={projectId,sessionId,senderActorId:actorId,receiverRoleId:roleId,receiverActorId:"isolated-agent",
    cwd,maxTurns:1,enabled:true,canStart:true,canSteer:true};
  const store=new PgDirectInputs(pool);
  const service=new DirectInputService({store,runtime:()=>native,canWrite:()=>true,
    admission:async principal=>{
      if(principal.actorId!==actorId)throw new Error("isolated actor mismatch");
      return {grant,binding};
    },bindingFor:async()=>binding});
  const messageService=new SessionMessageService({uow:new PostgresUnitOfWork(pool),
    clock:{now:()=>new Date().toISOString()},ids:{next:randomUUID},grantFor:async()=>grant});
  const pumpErrors:unknown[]=[];
  const pump=new SessionMessagePump({service:messageService,runtime:()=>native,projects:async()=>[projectId],
    canWrite:()=>true,canStart:async()=>false,pollIntervalMs:1000,onError:error=>pumpErrors.push(error)});
  app.decorateRequest("principal",null);
  app.addHook("onRequest",async request=>{
    if(request.headers.authorization===`Bearer ${token}`)
      request.principal={actorId,projectIds:[projectId],permissions:["read","write"]} as never;
  });
  app.setErrorHandler((error,_request,reply)=>reply.code(error instanceof Error&&error.message==="isolated actor mismatch"?403:409).send({error:error instanceof Error?error.message:"unknown"}));
  registerDirectInputRoutes(app,service);
  // Candidate-only readback for an independent reviewer. Never return tool payloads.
  app.get("/candidate/evidence",async(request,reply)=>{
    if(!request.principal)return reply.code(403).send({error:"fixture token required"});
    const inputs=(await store.list(projectId,sessionId,50)).items;
    const turnId=inputs.find(input=>input.mode==="start")?.actualTurnId??null;
    const turns=turnId?(await native.listTurns(binding)).data.filter(turn=>turn.id===turnId):[];
    const items=turnId?(await native.listItems(binding,turnId)).data as Array<Record<string,unknown>>:[];
    const processing=(await pool.query("SELECT processing_id,message_id,native_turn_id,state FROM session_message_processing WHERE project_id=$1 AND session_id=$2",[projectId,sessionId])).rows;
    return {inputs:inputs.map(({inputId,operationId,mode,state,source,actualTurnId,nativeItemId})=>({inputId,operationId,mode,state,source,actualTurnId,nativeItemId})),
      turns,processing,userItems:items.filter(item=>item.type==="userMessage").map(item=>({id:item.id,clientId:item.clientId})),
      publicReplies:items.filter(item=>item.type==="agentMessage"&&item.phase==="final_answer").map(item=>({id:item.id,text:item.text}))};
  });
  address=await app.listen({host:"127.0.0.1",port:Number(process.env.LIVE_DIRECT_PORT??0)});
  const endpoint=`${address}/api/projects/${projectId}/sessions/${sessionId}/direct-inputs`;
  if(process.env.LIVE_DIRECT_SERVE==="1"){
    pump.start();
    const manifestPath=process.env.LIVE_DIRECT_MANIFEST??join(cwd,"access.json");
    await writeFile(manifestPath,JSON.stringify({kind:"isolated-fixture-auth",address,endpoint,
      capabilityUrl:`${address}/api/projects/${projectId}/sessions/${sessionId}/direct-input-capability`,
      evidenceUrl:`${address}/candidate/evidence`,
      actorId,token,projectId,sessionId,cwd,threadId:binding.nativeThreadId,
      databaseSchema:schema,exampleInput:"Read cases.csv; write report.md with counts and sums by group, every hold ID, and all tied maximum ready IDs. Verify the report against the CSV."},null,2),{mode:0o600});
    console.log(JSON.stringify({state:"ready",manifestPath,address,projectId,sessionId,actorId,schema}));
    await new Promise<void>(resolve=>{process.once("SIGINT",()=>resolve());process.once("SIGTERM",()=>resolve());});
    pump.stop();
  }else{
  const post=async(content:string,expectedTurnId:string|null)=>{
    const body={inputId:randomUUID(),operationId:randomUUID(),content,expectedTurnId};
    const response=await fetch(endpoint,{method:"POST",headers:{authorization:`Bearer ${token}`,"content-type":"application/json"},body:JSON.stringify(body)});
    const receipt=await response.json();
    assert.equal(response.status,200,JSON.stringify(receipt));
    return {body,receipt};
  };
  const started=await post("Read cases.csv in this private directory. Write report.md with the count and sum by group, and list every hold ID. Then check each result against the CSV before your final reply.",null);
  const turnId=started.receipt.actualTurnId as string;
  assert.equal(started.receipt.state,"accepted");
  for(let attempt=0;attempt<20;attempt++){
    const read=await native.inspect(binding) as {thread?:{status?:{type?:string}}};
    if(read.thread?.status?.type==="active")break;
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  const first=await post("Also include the maximum ready amount, listing all tied IDs.",turnId);
  const second=await post("Add a separate sentence giving the total count of hold rows and confirm the report path.",turnId);
  for(const entry of [first,second]){
    assert.equal(entry.receipt.state,"accepted",JSON.stringify({receipt:entry.receipt,events}));
    assert.equal(entry.receipt.actualTurnId,turnId);
    assert.equal(entry.receipt.source.id,started.body.inputId);
  }
  const deadline=Date.now()+120000;
  let turn:{status:string}|undefined;
  while(Date.now()<deadline){
    turn=(await native.listTurns(binding)).data.find(item=>item.id===turnId);
    if(turn?.status!=="inProgress")break;
    await new Promise(resolve=>setTimeout(resolve,1000));
  }
  assert.ok(turn && turn.status!=="inProgress","native Turn did not settle within bound");
  const reconciled=[];
  for(const entry of [started,first,second]){
    const response=await fetch(`${endpoint}/${entry.body.inputId}/reconcile`,{method:"POST",headers:{authorization:`Bearer ${token}`}});
    assert.equal(response.status,200);
    reconciled.push(await response.json());
  }
  const nativeItems=(await native.listItems(binding,turnId)).data as Array<Record<string,unknown>>;
  for(const entry of reconciled){
    assert.equal(entry.state,"accepted");
    assert.ok(nativeItems.some(item=>item.type==="userMessage"&&item.clientId===entry.inputId&&item.id===entry.nativeItemId));
  }
  await pump.tick();
  assert.deepEqual(pumpErrors,[],"direct primary terminal settlement must succeed");
  const processing=(await pool.query("SELECT processing_id,message_id,native_turn_id,state FROM session_message_processing WHERE project_id=$1 AND session_id=$2",[projectId,sessionId])).rows;
  assert.equal(processing.length,1);
  assert.equal(processing[0]?.state,"completed");
  const publicReplies=nativeItems.filter(item=>item.type==="agentMessage").map(item=>({id:item.id,text:typeof item.text==="string"?item.text:null}));
  const result={kind:"isolated-http-pg-native-author-selftest",schema,cwd,address,projectId,sessionId,
    threadId:binding.nativeThreadId,turnId,turnStatus:turn.status,inputs:reconciled.map(({inputId,operationId,mode,source,actualTurnId,nativeItemId,state})=>({inputId,operationId,mode,source,actualTurnId,nativeItemId,state})),
    processing,events,publicReplies,reportPath:join(cwd,"report.md")};
  const resultPath=process.env.LIVE_DIRECT_RESULT??join(cwd,"result.json");
  await writeFile(resultPath,JSON.stringify(result,null,2));
  console.log(JSON.stringify({resultPath,resultSha256:createHash("sha256").update(JSON.stringify(result,null,2)).digest("hex"),address,projectId,sessionId,turnId,turnStatus:turn.status}));
  }
} finally {
  await app.close();
  await native.close();
  await pool.end();
}
