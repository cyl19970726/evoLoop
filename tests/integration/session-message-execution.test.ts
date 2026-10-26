import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";
import { WorkflowService } from "@evoloop/core";
import { SessionObservationService } from "@evoloop/core/session-observation";
import { SessionMessageService } from "@evoloop/core/session-messages";
import { migrate, PostgresUnitOfWork } from "@evoloop/adapter-postgres";
import { buildServer } from "../../apps/coordinator/src/server.js";
import { createMessageExecutionReader } from "../../apps/coordinator/src/session-messages/execution-capability.js";

const database=process.env.TEST_DATABASE_URL;
if(!database||!/^evoloop(?:_[a-z0-9]+)*_test$/.test(decodeURIComponent(new URL(database).pathname.slice(1))))
  throw new Error("session message execution requires an isolated evoloop_*_test database");

test("disabled execution keeps ready owned message storage available and snapshot reads leave queued and unknown work intact",async t=>{
  const schema=`el_message_execution_${randomUUID().replaceAll("-","").slice(0,16)}`;
  await migrate(database!,schema);
  const pool=new pg.Pool({connectionString:database,options:`-c search_path=${schema}`});
  const uow=new PostgresUnitOfWork(pool);
  const projectId=randomUUID(),otherProjectId=randomUUID(),sessionId=randomUUID(),roleId=randomUUID();
  const unknownMessageId=randomUUID(),queuedMessageId=randomUUID(),unknownProcessingId=randomUUID(),
    unknownProcessingOperationId=randomUUID();
  const actorId="message-owner",receiverActorId="message-receiver",token=randomUUID()+randomUUID(),readerToken=randomUUID()+randomUUID(),
    foreignToken=randomUUID()+randomUUID(),now="2026-10-27T00:00:00.000Z";
  const principal={actorId,projectIds:[projectId],permissions:["read","write","review"] as Array<"read"|"write"|"review">};
  const hash=(value:string)=>createHash("sha256").update(value).digest("hex");
  const workflow=new WorkflowService({uow,clock:{now:()=>now},ids:{next:randomUUID},hasher:{hash}});
  const messages=new SessionMessageService({uow,clock:{now:()=>now},ids:{next:randomUUID},grantFor:async()=>null});
  const observation=new SessionObservationService({uow});
  let dispatchGrantChecks=0;
  let configurationMode:"missing"|"disabled"|"enabled"="missing";
  let exactGrant=false;
  let runtimeUp=false;
  const countedMessages=new SessionMessageService({uow,clock:{now:()=>now},ids:{next:randomUUID},grantFor:async()=>{
    dispatchGrantChecks++;return null;
  }});
  const execution=createMessageExecutionReader({
    loadConfiguration:async()=>({runtime:configurationMode==="enabled"
      ? {enabled:true,protocolVersion:"0.164.0-alpha.11.1" as const,grants:[],delegationTemplates:[]} : undefined,
    sessionMessages:configurationMode==="missing" ? undefined : {
      enabled:configurationMode==="enabled",pollIntervalMs:2000,readOnlyProtocolVerified:true,
      grants:exactGrant ? [{projectId,sessionId,senderActorId:actorId,receiverActorId,receiverRoleId:roleId,
        cwd:"/tmp/evoloop-message-execution",maxTurns:1,enabled:true}] : [],
    }}),
    runtimeAvailable:()=>runtimeUp,
    isProjectWriter:async(project,actor)=>project===projectId&&(actor===actorId||actor===receiverActorId),
    readSession:(project,session)=>uow.read(project,reader=>reader.getRuntimeSession(session)),
    turnsUsed:(project,session,sender)=>uow.read(project,reader=>reader.sessionMessages!.countSessionMessageTurns(session,sender)),
    cwdIsCurrent:async()=>true,now:()=>now,
  });
  const app=await buildServer({service:workflow,sessionWork:observation,sessionMessages:countedMessages,
    messageExecution:execution,credentials:[
      {token,...principal},
      {token:readerToken,actorId:"reader",projectIds:[projectId],permissions:["read"]},
      {token:foreignToken,actorId:"foreign",projectIds:[otherProjectId],permissions:["read","write"]},
    ]});
  t.after(async()=>{await app.close();await pool.end();const admin=new pg.Client({connectionString:database});
    await admin.connect();try{await admin.query(`DROP SCHEMA "${schema}" CASCADE`);}finally{await admin.end();}});
  await pool.query("INSERT INTO project(project_id,title,created_at) VALUES($1,'Ordinary message execution',$2),($3,'Other project',$2)",
    [projectId,now,otherProjectId]);
  await pool.query(`INSERT INTO runtime_session(project_id,session_id,role_id,cwd,authorization_scope,sandbox,approval_policy,
    state,version,native_thread_id,native_session_id,operation_id,actor_id,created_at,updated_at)
    VALUES($1,$2,$3,'/tmp/evoloop-message-execution','project','read-only','on-request','ready',1,$4,$4,$5,$6,$7,$7)`,
    [projectId,sessionId,roleId,`native-${sessionId}`,randomUUID(),receiverActorId,now]);
  await pool.query(`INSERT INTO session_message(project_id,message_id,operation_id,target_kind,session_id,sender_actor_id,
    content,state,version,created_at,updated_at)
    VALUES($1,$2,$3,'owned',$4,$5,'Earlier uncertain message','unknown',1,$6,$6)`,
    [projectId,unknownMessageId,randomUUID(),sessionId,actorId,now]);
  await pool.query(`INSERT INTO session_message_processing(project_id,processing_id,message_id,session_id,operation_id,
    receiver_actor_id,state,read_only_policy_fingerprint,version,started_at,updated_at)
    VALUES($1,$2,$3,$4,$5,$6,'unknown',$7,1,$8,$8)`,
    [projectId,unknownProcessingId,unknownMessageId,sessionId,unknownProcessingOperationId,receiverActorId,"a".repeat(64),now]);

  const counts=async()=>{
    const result=await pool.query(`SELECT
      (SELECT count(*)::int FROM operation_journal WHERE project_id=$1) AS operations,
      (SELECT count(*)::int FROM runtime_run WHERE project_id=$1) AS runs,
      (SELECT count(*)::int FROM session_message_processing WHERE project_id=$1) AS processing,
      (SELECT count(*)::int FROM outbox_event WHERE project_id=$1) AS outbox,
      (SELECT sequence FROM session_observation_head WHERE project_id=$1) AS observation_head`,[projectId]);
    return result.rows[0];
  };

  const snapshotUrl=`/api/projects/${projectId}/session-work/owned:${sessionId}`;
  const auth=(bearer:string)=>({authorization:`Bearer ${bearer}`});
  const beforeInitialRead=await counts();
  const initial=await app.inject({method:"GET",url:snapshotUrl,headers:auth(token)});
  assert.equal(initial.statusCode,200,initial.body);
  assert.deepEqual(await counts(),beforeInitialRead,"the first snapshot read is also side-effect free");
  const initialCapabilities=initial.json<{session:{capabilities:{send:{available:boolean;mode:string};
    ordinaryExecution:{state:string;reasonCode:string;reason:string;observedAt:string}}}}>().session.capabilities;
  assert.deepEqual({available:initialCapabilities.send.available,mode:initialCapabilities.send.mode},
    {available:true,mode:"owned-read-only"},"ready bound storage remains usable while the executor is disabled");
  assert.equal(initialCapabilities.ordinaryExecution.state,"disabled");
  assert.equal(initialCapabilities.ordinaryExecution.reasonCode,"SESSION_MESSAGES_DISABLED");
  assert.ok(initialCapabilities.ordinaryExecution.reason.length>0);
  assert.equal(initialCapabilities.ordinaryExecution.observedAt,now);
  configurationMode="disabled";
  const disabled=await app.inject({method:"GET",url:snapshotUrl,headers:auth(token)});
  assert.equal(disabled.statusCode,200,disabled.body);
  assert.equal(disabled.json<{session:{capabilities:{ordinaryExecution:{state:string;reasonCode:string}}}}>()
    .session.capabilities.ordinaryExecution.reasonCode,"SESSION_MESSAGES_DISABLED");
  assert.deepEqual(await counts(),beforeInitialRead,"explicitly disabled execution is also a pure read");

  const posted=await app.inject({method:"POST",url:"/api/commands",headers:auth(token),payload:{
    type:"session.message.post",projectId,operationId:randomUUID(),messageId:queuedMessageId,
    target:{kind:"owned",sessionId},content:"Please review this when execution is enabled.",
  }});
  assert.equal(posted.statusCode,200,posted.body);
  assert.equal(posted.json<{status:string}>().status,"applied");
  const saved=await messages.detail(projectId,queuedMessageId);
  assert.equal(saved.message.state,"queued");assert.equal(saved.message.version,1);assert.equal(saved.processing,null);

  const beforeReads=await counts();
  assert.equal(beforeReads.operations,1,"the only new command is the explicit message post");
  assert.equal(beforeReads.runs,0);assert.equal(beforeReads.processing,1,"the earlier unknown remains the only processing record");
  for(let i=0;i<3;i++){
    const response=await app.inject({method:"GET",url:snapshotUrl,headers:auth(token)});
    assert.equal(response.statusCode,200,response.body);
    const capabilities=response.json<{session:{capabilities:{send:{available:boolean};ordinaryExecution:{state:string;reasonCode:string}}}}>()
      .session.capabilities;
    assert.equal(capabilities.send.available,true);
    assert.deepEqual({state:capabilities.ordinaryExecution.state,reasonCode:capabilities.ordinaryExecution.reasonCode},
      {state:"disabled",reasonCode:"SESSION_MESSAGES_DISABLED"});
    const list=await app.inject({method:"GET",url:`${snapshotUrl}/messages`,headers:auth(token)});
    assert.equal(list.statusCode,200,list.body);
  }
  assert.deepEqual(await counts(),beforeReads,"GET projection and message listing must not change durable state");
  assert.equal(dispatchGrantChecks,0,"a read or persisted post never requests a dispatch grant");
  const unknown=await messages.detail(projectId,unknownMessageId);
  assert.equal(unknown.message.state,"unknown");
  assert.deepEqual(unknown.processing && {state:unknown.processing.state,operationId:unknown.processing.operationId},
    {state:"unknown",operationId:unknownProcessingOperationId});
  assert.equal((await messages.detail(projectId,queuedMessageId)).message.state,"queued");
  assert.equal((await messages.detail(projectId,queuedMessageId)).message.version,1);

  assert.equal(await uow.read(projectId,reader=>reader.sessionMessages!.countSessionMessageTurns(sessionId,actorId)),1,
    "the unresolved original processing consumes one durable ordinary-message turn");
  configurationMode="enabled";runtimeUp=true;
  const missingGrant=await app.inject({method:"GET",url:snapshotUrl,headers:auth(token)});
  assert.equal(missingGrant.statusCode,200,missingGrant.body);
  const noGrantCapability=missingGrant.json<{session:{capabilities:{send:{available:boolean};
    ordinaryExecution:{state:string;reasonCode:string}}}}>().session.capabilities;
  assert.equal(noGrantCapability.send.available,true);
  assert.deepEqual({state:noGrantCapability.ordinaryExecution.state,reasonCode:noGrantCapability.ordinaryExecution.reasonCode},
    {state:"blocked",reasonCode:"MESSAGE_GRANT_MISSING"});
  exactGrant=true;
  const exhausted=await app.inject({method:"GET",url:snapshotUrl,headers:auth(token)});
  assert.equal(exhausted.statusCode,200,exhausted.body);
  const exhaustedCapability=exhausted.json<{session:{capabilities:{send:{available:boolean};
    ordinaryExecution:{state:string;reasonCode:string}}}}>().session.capabilities;
  assert.equal(exhaustedCapability.send.available,true,"exhausted execution budget does not revoke message storage");
  assert.deepEqual({state:exhaustedCapability.ordinaryExecution.state,reasonCode:exhaustedCapability.ordinaryExecution.reasonCode},
    {state:"blocked",reasonCode:"MESSAGE_BUDGET_EXHAUSTED"});
  assert.deepEqual(await counts(),beforeReads,"grant and quota projections must not mutate stored work");
  assert.equal((await messages.detail(projectId,unknownMessageId)).processing?.operationId,unknownProcessingOperationId);
  assert.deepEqual({state:(await messages.detail(projectId,queuedMessageId)).message.state,
    version:(await messages.detail(projectId,queuedMessageId)).message.version},{state:"queued",version:1});
  assert.equal(dispatchGrantChecks,0,"capability reads cannot begin native dispatch");

  const readonly=await app.inject({method:"GET",url:snapshotUrl,headers:auth(readerToken)});
  assert.equal(readonly.statusCode,200,readonly.body);
  assert.equal(readonly.json<{session:{capabilities:{send:{available:boolean}}}}>().session.capabilities.send.available,false);
  const forbiddenPost=await app.inject({method:"POST",url:"/api/commands",headers:auth(readerToken),payload:{
    type:"session.message.post",projectId,operationId:randomUUID(),messageId:randomUUID(),
    target:{kind:"owned",sessionId},content:"Read-only writer attempt",
  }});
  assert.equal(forbiddenPost.statusCode,403,forbiddenPost.body);
  const foreignRead=await app.inject({method:"GET",url:snapshotUrl,headers:auth(foreignToken)});
  assert.equal(foreignRead.statusCode,403,foreignRead.body);
  const foreignPost=await app.inject({method:"POST",url:"/api/commands",headers:auth(foreignToken),payload:{
    type:"session.message.post",projectId,operationId:randomUUID(),messageId:randomUUID(),
    target:{kind:"owned",sessionId},content:"Other project attempt",
  }});
  assert.equal(foreignPost.statusCode,403,foreignPost.body);
});
