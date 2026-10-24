import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import pg from "pg";
import { WorkflowService, RuntimeWorkflowService } from "@evoloop/core";
import { OrchestrationService, OrchestrationError } from "@evoloop/core/orchestration";
import { migrate, PostgresUnitOfWork } from "@evoloop/adapter-postgres";
import { PgOrchestrationStore } from "@evoloop/adapter-postgres/orchestration";
import { WorkerCredentialBroker } from "../../apps/coordinator/src/workers/credentials.js";
import { canReadDivisionEvidence } from "../../apps/coordinator/src/workers/guard.js";
import { workerGuardFacts } from "../../apps/coordinator/src/workers/facts.js";
import { buildServer } from "../../apps/coordinator/src/server.js";
import { RuntimeRunner } from "../../apps/coordinator/src/runtime/runner.js";

const url=process.env.TEST_DATABASE_URL;
if(!url||!/evoloop.*test/.test(new URL(url).pathname))throw new Error("dedicated PostgreSQL test database required");
const hash=(value:string)=>createHash("sha256").update(value).digest("hex");
const principal=(actorId:string,projectId:string)=>({actorId,projectIds:[projectId],permissions:["read","write","review"] as Array<"read"|"write"|"review">});
const denied=async(p:Promise<unknown>,code:string)=>assert.rejects(p,error=>error instanceof OrchestrationError&&error.code===code);

test("PG method records a choice, then permits only its original todo Task through ordinary same-source dispatch",async t=>{
  const schema=`el_method_${randomUUID().replaceAll("-","").slice(0,16)}`;
  await migrate(url!,schema);
  const pool=new pg.Pool({connectionString:url,options:`-c search_path=${schema}`});
  const workerRoot=await mkdtemp(join(tmpdir(),"evoloop-method-worker-"));
  t.after(async()=>{await pool.end();await rm(workerRoot,{recursive:true,force:true});
    const admin=new pg.Client({connectionString:url});await admin.connect();
    try{await admin.query(`DROP SCHEMA "${schema}" CASCADE`);}finally{await admin.end();}});
  const projectId=randomUUID(),goalId=randomUUID(),stageId=randomUUID(),loopId=randomUUID();
  const parentTaskId=randomUUID(),firstTaskId=randomUUID(),otherTaskId=randomUUID();
  const owner="owner",cognition="cognition",business="business",other="other-business";
  const uow=new PostgresUnitOfWork(pool),clock={now:()=>new Date().toISOString()},ids={next:randomUUID};
  const workflow=new WorkflowService({uow,clock,ids,hasher:{hash}}),runtime=new RuntimeWorkflowService({uow,clock,ids});
  const broker=new WorkerCredentialBroker({workerRoot,apiUrl:"http://127.0.0.1:1",cliMain:"/unused/cli.js",
    nodeExecutable:process.execPath,ttlMs:60_000});
  const store=new PgOrchestrationStore(pool,{getAuthorizationFact:async(p,scope)=>p===projectId&&scope==="cognition-scope"?
    {projectId,scopeId:scope,actorId:owner,roleId:cognition,active:true}:p===projectId&&scope==="business-scope"?
    {projectId,scopeId:scope,actorId:owner,roleId:business,active:true}:p===projectId&&scope==="other-scope"?
    {projectId,scopeId:scope,actorId:owner,roleId:other,active:true}:null,
    canActAsRole:async(p,actor,role)=>p===projectId&&(actor===owner||
      (await broker.identityForActor(actor))?.scope.roleId===role),wasActorRole:async()=>false});
  const orchestration=new OrchestrationService({store,now:clock.now,nextId:randomUUID,hash,
    getWorkerScope:async actor=>(await broker.identityForActor(actor))?.scope??null,
    canReadDivisionMaterial:async(actor,documentId,revisionId)=>{
      const identity=await broker.identityForActor(actor);
      return !!identity && canReadDivisionEvidence(identity,workerGuardFacts(pool,identity),documentId,revisionId);
    }});
  const wf=async(command:Record<string,unknown>)=>{
    const result=await workflow.execute(principal(owner,projectId),{projectId,operationId:randomUUID(),...command} as never);
    assert.equal(result.status,"applied",JSON.stringify(result));return result;
  };
  const issue=(actor:string,command:Record<string,unknown>)=>orchestration.execute(principal(actor,projectId),
    {projectId,operationId:randomUUID(),...command} as never);
  await wf({type:"project.create",title:"Method continuation"});
  await wf({type:"goal.create",goalId,outcome:"One bounded result",constraints:"Local",consumer:owner,authority:owner,scope:"fixture",owner});
  await wf({type:"stage.propose",stageId,goalId,deliverable:"One result",learningQuestion:"What changed?",reason:"Fixture"});
  await wf({type:"stage.accept",stageId,expectedVersion:1,reason:"Start"});
  for(const [taskId,role] of [[parentTaskId,cognition],[firstTaskId,business],[otherTaskId,other]] as const)
    await wf({type:"task.create",taskId,stageId,title:"Task",content:"# Bounded task",acceptance:"Report",owner:role,
      consumer:owner,evidence:"Fixture",stopCondition:"One result"});
  await wf({type:"task.update",taskId:firstTaskId,expectedVersion:1,title:"Task",
    content:"# Use the existing Role for the revised method",acceptance:"Report",owner:business,
    reason:"Fix the method and consumer before signing its observed Task version"});
  await wf({type:"task.start",taskId:parentTaskId,expectedVersion:1,reason:"Cognition"});
  const last=(await pool.query("SELECT created_at,event_id FROM outbox_event WHERE project_id=$1 ORDER BY created_at DESC,event_id DESC LIMIT 1",[projectId])).rows[0];
  await issue(owner,{type:"loop.enroll",loopId,goalId,stageId,cognitiveRoleId:cognition,
    allowedBusinessRoleIds:[business,other],sourceAfter:{createdAtUtc:last.created_at.toISOString(),eventId:last.event_id},
    maxRuns:2,maxConcurrent:1,reason:"Finite"});
  const loop=(await orchestration.getLoop(principal(owner,projectId),projectId,loopId))!;
  const inbox=await issue(owner,{type:"inbox.accept",loopId,sourceEventId:loop.bootstrapEventId,
    recipientRoleId:cognition,purpose:"cognitive_review"});
  await issue(owner,{type:"inbox.ack",inboxId:inbox.entityId,expectedVersion:1,reason:"Read"});
  const parent=await issue(owner,{type:"dispatch.request",inboxId:inbox.entityId,expectedInboxVersion:2,
    dispatchId:randomUUID(),parentDispatchId:null,taskId:parentTaskId,expectedTaskVersion:2,
    recipientRoleId:cognition,purpose:"cognition",authorizationScopeId:"cognition-scope",reason:"Review"});
  const token=randomUUID();
  await issue(owner,{type:"dispatch.claim",dispatchId:parent.entityId,claimToken:token,
    leaseUntilUtc:new Date(Date.now()+60_000).toISOString()});
  await issue(owner,{type:"dispatch.start",dispatchId:parent.entityId,claimToken:token});
  const sessionId=randomUUID(),runId=randomUUID();
  await wf({type:"runtime.session.reserve",sessionId,roleId:cognition,cwd:join(tmpdir(),"method-fixture"),
    authorizationScope:"cognition-scope",model:"fixture-model",sandbox:"read-only",approvalPolicy:"on-request"});
  await runtime.beginSessionCreate(projectId,sessionId);
  await runtime.bindSession(projectId,sessionId,{owner:"evoloop-codex-app-server",projectId,sessionId,
    roleId:cognition,cwd:join(tmpdir(),"method-fixture"),authorizationScope:"cognition-scope",
    nativeThreadId:`fixture-${sessionId}`,nativeSessionId:`fixture-${sessionId}`});
  const reserved=await wf({type:"runtime.run.reserve",runId,taskId:parentTaskId,sessionId,expectedVersion:2,input:"Review method"});
  await issue(owner,{type:"dispatch.resolve",dispatchId:parent.entityId,claimToken:token,result:"accepted",runtimeRunId:runId,reason:"Bound"});
  await runtime.beginDispatch(projectId,runId);
  await runtime.bindTurn(projectId,runId,{id:`fixture-${runId}`,status:"inProgress"},
    {kind:"startReply",operationId:(await workflow.getRuntimeRun(principal(owner,projectId),projectId,runId)).operationId});
  const worker=await broker.issue({projectId,loopId,taskId:parentTaskId,runId,sessionId,roleId:cognition,
    kind:"cognition",allowedRoleIds:[cognition]});
  const beforeMethod=(await orchestration.getLoop(principal(owner,projectId),projectId,loopId))!;
  const metadataRunner=new RuntimeRunner({runtimeFactory:()=>({isReady:()=>true}) as never,
    workflow,trusted:runtime,principals:[principal(owner,projectId)],canWrite:()=>true,
    allowedCwd:async()=>true,hasGrant:()=>true});
  const app=await buildServer({service:workflow,credentials:[{token:"o".repeat(40),actorId:owner,
    projectIds:[projectId],permissions:["read","write","review"]}] as never,
    documents:{uow,blobsForPrincipal:async()=>({}) as never},runtime:metadataRunner,
    orchestration:{service:orchestration},workers:{authenticate:header=>broker.authenticate(header),
      facts:identity=>workerGuardFacts(pool,identity)}});
  t.after(async()=>app.close());
  const workerToken=(await readFile(join(workerRoot,runId,"credential"),"utf8")).trim();
  const boundRun=await app.inject({method:"GET",url:`/api/projects/${projectId}/runtime/runs/${runId}`,
    headers:{authorization:`Bearer ${workerToken}`}});
  assert.equal(boundRun.statusCode,200,boundRun.body);
  assert.equal(boundRun.json().taskRevisionId,reserved.revisionId);
  const documentId=randomUUID(),reportBody="# This Run's method diagnosis";
  const created=await app.inject({method:"POST",url:"/api/commands",
    headers:{authorization:`Bearer ${workerToken}`},payload:{type:"document.create",projectId,
      operationId:randomUUID(),documentId,kind:"report",title:"Current Run diagnosis",body:reportBody,
      origin:{taskId:parentTaskId,runId}}});
  assert.equal(created.statusCode,200,created.body);
  const initialRevisionId=(created.json() as {revisionId:string}).revisionId;
  const original=await app.inject({method:"GET",url:`/api/projects/${projectId}/documents/${documentId}/revisions/${initialRevisionId}/original`,
    headers:{authorization:`Bearer ${workerToken}`}});
  assert.equal(original.statusCode,200,original.body);
  assert.equal(original.json().body,reportBody);
  const revised=await workflow.execute(worker.principal,{type:"document.revise",projectId,
    operationId:randomUUID(),documentId,expectedVersion:1,body:reportBody,reason:"Confirm exact evidence"} as never);
  assert.equal(revised.status,"applied",JSON.stringify(revised));
  const documentRevisionId=revised.revisionId!;
  const revisedOriginal=await app.inject({method:"GET",url:`/api/projects/${projectId}/documents/${documentId}/revisions/${documentRevisionId}/original`,
    headers:{authorization:`Bearer ${workerToken}`}});
  assert.equal(revisedOriginal.statusCode,200,revisedOriginal.body);
  const wrongWriter=await wf({type:"document.create",documentId:randomUUID(),kind:"report",
    title:"Another author",body:"# Other",origin:{taskId:parentTaskId,runId}});
  const wrongTask=await workflow.execute(worker.principal,{type:"document.create",projectId,
    operationId:randomUUID(),documentId:randomUUID(),kind:"report",title:"Wrong Task",body:"# Other",
    origin:{taskId:otherTaskId}} as never);
  assert.equal(wrongTask.status,"applied",JSON.stringify(wrongTask));
  const noOrigin=await workflow.execute(worker.principal,{type:"document.create",projectId,
    operationId:randomUUID(),documentId:randomUUID(),kind:"report",title:"No origin",body:"# Other"} as never);
  assert.equal(noOrigin.status,"applied",JSON.stringify(noOrigin));
  const beforeState=(await orchestration.getLoop(principal(owner,projectId),projectId,loopId))!;
  await issue(owner,{type:"loop.state",loopId,expectedVersion:beforeState.version,state:"paused",reason:"Owner review"});
  await issue(owner,{type:"loop.state",loopId,expectedVersion:beforeState.version+1,state:"active",reason:"Continue"});
  const methodCommand={type:"division.decide",projectId,operationId:randomUUID(),decisionId:randomUUID(),loopId,
    expectedLoopVersion:(await orchestration.getLoop(principal(owner,projectId),projectId,loopId))!.version,
    sourceEventId:loop.bootstrapEventId,parentDispatchId:parent.entityId,documentId,
    documentRevisionId,documentContentHash:hash(reportBody),firstTaskId,
    expectedFirstTaskVersion:2,choice:"method",roleId:business,templateId:null,templateRevision:null,
    templateHash:null,reason:"Use the existing business Role differently"};
  const attempt=(changes:Record<string,unknown>)=>app.inject({method:"POST",url:"/api/orchestration/commands",
    headers:{authorization:`Bearer ${workerToken}`},payload:{...methodCommand,
      operationId:randomUUID(),decisionId:randomUUID(),...changes}});
  const stale=await attempt({expectedLoopVersion:beforeState.version});
  assert.equal(stale.statusCode,409,stale.body);
  assert.equal(stale.json().code,"VERSION_CONFLICT");
  for(const changes of [
    {documentRevisionId:randomUUID()},
    {documentId:wrongWriter.entityId,documentRevisionId:wrongWriter.revisionId,documentContentHash:hash("# Other")},
    {documentId:wrongTask.entityId,documentRevisionId:wrongTask.revisionId,documentContentHash:hash("# Other")},
    {documentId:noOrigin.entityId,documentRevisionId:noOrigin.revisionId,documentContentHash:hash("# Other")},
    {projectId:randomUUID()},
  ]) {
    const rejected=await attempt(changes);
    assert.equal(rejected.statusCode,403,JSON.stringify({changes,response:rejected.body}));
  }
  const wrongHash=await attempt({documentContentHash:hash("wrong bytes")});
  assert.equal(wrongHash.statusCode,409,wrongHash.body);
  assert.equal(wrongHash.json().code,"MATERIAL_CHANGED");
  const wrongParent=await app.inject({method:"POST",url:"/api/orchestration/commands",
    headers:{authorization:`Bearer ${workerToken}`},payload:{...methodCommand,operationId:randomUUID(),
      decisionId:randomUUID(),parentDispatchId:randomUUID()}});
  assert.equal(wrongParent.statusCode,403,wrongParent.body);
  const methodReply=await app.inject({method:"POST",url:"/api/orchestration/commands",
    headers:{authorization:`Bearer ${workerToken}`},payload:methodCommand});
  assert.equal(methodReply.statusCode,200,methodReply.body);
  const method=methodReply.json() as {entityId:string;status:string};
  assert.equal(method.status,"applied");
  assert.equal(await orchestration.getBinding(principal(owner,projectId),projectId,method.entityId),null);
  const afterMethod=(await orchestration.getLoop(principal(owner,projectId),projectId,loopId))!;
  assert.equal(afterMethod.dispatchCount,beforeMethod.dispatchCount);
  assert.equal(afterMethod.currentPolicyRevisionId,beforeMethod.currentPolicyRevisionId);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM runtime_role_binding WHERE project_id=$1",[projectId])).rows[0].n,0);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM loop_policy_revision WHERE project_id=$1 AND loop_id=$2",[projectId,loopId])).rows[0].n,1);
  const next=await issue(owner,{type:"inbox.accept",loopId,sourceEventId:loop.bootstrapEventId,
    recipientRoleId:cognition,purpose:"next_action"});
  await issue(owner,{type:"inbox.ack",inboxId:next.entityId,expectedVersion:1,reason:"Read method"});
  const request={type:"dispatch.request",inboxId:next.entityId,expectedInboxVersion:2,
    dispatchId:randomUUID(),parentDispatchId:parent.entityId,taskId:firstTaskId,expectedTaskVersion:2,
    recipientRoleId:business,purpose:"Execute",authorizationScopeId:"business-scope",reason:"Method first Task"};
  await denied(issue(worker.principal.actorId,{type:"worker.decision",decisionId:randomUUID(),dispatchId:parent.entityId,
    runId,kind:"waiting",divisionDecisionId:null,reason:"Method alone is not a handoff",evidenceRefs:[]}),"INVALID_CAUSALITY");
  assert.equal(await orchestration.getDecisionForDispatch(principal(owner,projectId),projectId,parent.entityId),null);
  await denied(issue(owner,{...request,taskId:otherTaskId,recipientRoleId:other}),"METHOD_TASK_MISMATCH");
  await denied(issue(owner,{...request,expectedTaskVersion:1}),"METHOD_TASK_MISMATCH");
  await denied(issue(owner,{...request,recipientRoleId:other,authorizationScopeId:"other-scope"}),"TASK_CHANGED");
  const child=await issue(owner,request);
  assert.equal(child.entityType,"dispatch");
  assert.equal((await orchestration.getLoop(principal(owner,projectId),projectId,loopId))?.dispatchCount,2);
  assert.equal((await orchestration.getDispatch(principal(owner,projectId),projectId,child.entityId))?.bindingId,null);
  await denied(issue(worker.principal.actorId,{type:"worker.decision",decisionId:randomUUID(),dispatchId:parent.entityId,
    runId,kind:"waiting",divisionDecisionId:method.entityId,reason:"Wait",evidenceRefs:[]}),"INVALID_CAUSALITY");
  assert.equal(await orchestration.getDecisionForDispatch(principal(owner,projectId),projectId,parent.entityId),null);
  await issue(worker.principal.actorId,{type:"worker.decision",decisionId:randomUUID(),dispatchId:parent.entityId,
    runId,kind:"waiting",divisionDecisionId:null,reason:"Wait for ordinary child",evidenceRefs:[]});
  const afterFinal=await attempt({expectedLoopVersion:
    (await orchestration.getLoop(principal(owner,projectId),projectId,loopId))!.version});
  assert.equal(afterFinal.statusCode,409,afterFinal.body);
  assert.equal(afterFinal.json().code,"PARENT_DECIDED");
  await denied(issue(owner,{...request,dispatchId:randomUUID()}),"VERSION_CONFLICT");
  await runtime.recordTurn(projectId,runId,`fixture-${runId}`,"completed","Fixture cognition Decision complete");
  await issue(owner,{type:"worker.outcome",dispatchId:parent.entityId,outcome:"waiting",deliveryId:null,
    decisionId:(await orchestration.getDecisionForDispatch(principal(owner,projectId),projectId,parent.entityId))!.id,
    evidenceRef:null,reason:"Wait for ordinary child"});
  const childToken=randomUUID();
  await issue(owner,{type:"dispatch.claim",dispatchId:child.entityId,claimToken:childToken,
    leaseUntilUtc:new Date(Date.now()+60_000).toISOString()});
  assert.equal((await orchestration.getDispatch(principal(owner,projectId),projectId,child.entityId))?.state,"claimed");
  await issue(owner,{type:"dispatch.start",dispatchId:child.entityId,claimToken:childToken});
  await wf({type:"task.start",taskId:firstTaskId,expectedVersion:2,reason:"Start fixed method Task"});
  const childSession=randomUUID(),childRun=randomUUID(),childInput="Execute the fixed method Task";
  await wf({type:"runtime.session.reserve",sessionId:childSession,roleId:business,cwd:join(tmpdir(),"method-fixture"),
    authorizationScope:"business-scope",model:"fixture-model",sandbox:"read-only",approvalPolicy:"on-request"});
  await runtime.beginSessionCreate(projectId,childSession);
  await runtime.bindSession(projectId,childSession,{owner:"evoloop-codex-app-server",projectId,sessionId:childSession,
    roleId:business,cwd:join(tmpdir(),"method-fixture"),authorizationScope:"business-scope",
    nativeThreadId:`fixture-${childSession}`,nativeSessionId:`fixture-${childSession}`});
  const childReserved=await wf({type:"runtime.run.reserve",runId:childRun,taskId:firstTaskId,sessionId:childSession,
    expectedVersion:3,input:childInput});
  await issue(owner,{type:"dispatch.resolve",dispatchId:child.entityId,claimToken:childToken,result:"accepted",
    runtimeRunId:childRun,reason:"Bound original-role child Run"});
  const submissionId=randomUUID(),deliveryOperationId=randomUUID();
  const deliveryIntent={artifactRef:"artifact:method-fixture",artifactRevision:"v1",contentHash:hash("method-fixture"),
    technicalResult:"failed",technicalEvidence:"No native Turn in this engineering fixture",reason:"Record bounded result"};
  await issue(owner,{type:"worker.submit",submissionId,dispatchId:child.entityId,runId:childRun,
    taskRevisionId:childReserved.revisionId,runInputHash:hash(childInput),deliveryOperationId,deliveryIntent,
    agentObservation:"Fixture result only",evidenceRefs:[]});
  await runtime.rejectDispatch(projectId,childRun,"Fixture terminal, no native Turn");
  const taskVersion=(await workflow.getTask(principal(owner,projectId),projectId,firstTaskId)).task.version;
  const sealToken=randomUUID();
  await issue(owner,{type:"worker.beginSeal",submissionId,expectedVersion:1,expectedTaskVersion:taskVersion,sealToken});
  const delivery=await workflow.execute(principal(owner,projectId),{type:"delivery.record",projectId,
    operationId:deliveryOperationId,taskId:firstTaskId,runId:childRun,expectedVersion:taskVersion,...deliveryIntent} as never);
  assert.equal(delivery.status,"applied",JSON.stringify(delivery));
  await issue(owner,{type:"worker.finishSeal",submissionId,sealToken,result:"sealed",deliveryId:delivery.revisionId,
    reason:"Fixed method fixture delivery"});
  await issue(owner,{type:"worker.outcome",dispatchId:child.entityId,outcome:"delivered",deliveryId:delivery.revisionId,
    decisionId:null,evidenceRef:null,reason:"Bounded fixture result"});
  assert.equal((await orchestration.getDispatch(principal(owner,projectId),projectId,child.entityId))?.outcome,"delivered");
  assert.equal(reserved.status,"applied");
});

test("PG final cognition decision prevents a late method child before budget or inbox is spent",async t=>{
  const schema=`el_method_late_${randomUUID().replaceAll("-","").slice(0,16)}`;
  await migrate(url!,schema);
  const pool=new pg.Pool({connectionString:url,options:`-c search_path=${schema}`});
  t.after(async()=>{await pool.end();const admin=new pg.Client({connectionString:url});await admin.connect();
    try{await admin.query(`DROP SCHEMA "${schema}" CASCADE`);}finally{await admin.end();}});
  const projectId=randomUUID(),goalId=randomUUID(),stageId=randomUUID(),loopId=randomUUID();
  const parentTaskId=randomUUID(),firstTaskId=randomUUID(),owner="owner",cognition="cognition",business="business";
  const uow=new PostgresUnitOfWork(pool),clock={now:()=>new Date().toISOString()},ids={next:randomUUID};
  const workflow=new WorkflowService({uow,clock,ids,hasher:{hash}}),runtime=new RuntimeWorkflowService({uow,clock,ids});
  const store=new PgOrchestrationStore(pool,{getAuthorizationFact:async(project,scope)=>project===projectId&&
    (scope==="cognition-scope"||scope==="business-scope")?
      {projectId,scopeId:scope,actorId:owner,roleId:scope==="cognition-scope"?cognition:business,active:true}:null,
    canActAsRole:async(project,actor)=>project===projectId&&actor===owner,wasActorRole:async()=>false});
  const orchestration=new OrchestrationService({store,now:clock.now,nextId:randomUUID,hash});
  const wf=async(command:Record<string,unknown>)=>{
    const result=await workflow.execute(principal(owner,projectId),{projectId,operationId:randomUUID(),...command} as never);
    assert.equal(result.status,"applied",JSON.stringify(result));return result;
  };
  const issue=(command:Record<string,unknown>)=>orchestration.execute(principal(owner,projectId),
    {projectId,operationId:randomUUID(),...command} as never);
  await wf({type:"project.create",title:"Method late-child boundary"});
  await wf({type:"goal.create",goalId,outcome:"One bounded result",constraints:"Local",consumer:owner,authority:owner,scope:"fixture",owner});
  await wf({type:"stage.propose",stageId,goalId,deliverable:"One result",learningQuestion:"What changed?",reason:"Fixture"});
  await wf({type:"stage.accept",stageId,expectedVersion:1,reason:"Start"});
  for(const [taskId,role] of [[parentTaskId,cognition],[firstTaskId,business]] as const)
    await wf({type:"task.create",taskId,stageId,title:"Task",content:"# Bounded task",acceptance:"Report",owner:role,
      consumer:owner,evidence:"Fixture",stopCondition:"One result"});
  await wf({type:"task.start",taskId:parentTaskId,expectedVersion:1,reason:"Cognition"});
  const parentFixed=(await workflow.getTask(principal(owner,projectId),projectId,parentTaskId)).revision;
  const last=(await pool.query("SELECT created_at,event_id FROM outbox_event WHERE project_id=$1 ORDER BY created_at DESC,event_id DESC LIMIT 1",[projectId])).rows[0];
  await issue({type:"loop.enroll",loopId,goalId,stageId,cognitiveRoleId:cognition,
    allowedBusinessRoleIds:[business],sourceAfter:{createdAtUtc:last.created_at.toISOString(),eventId:last.event_id},
    maxRuns:3,maxConcurrent:1,reason:"Leave capacity for the late request"});
  const loop=(await orchestration.getLoop(principal(owner,projectId),projectId,loopId))!;
  const cognitiveInbox=await issue({type:"inbox.accept",loopId,sourceEventId:loop.bootstrapEventId,
    recipientRoleId:cognition,purpose:"cognitive_review"});
  await issue({type:"inbox.ack",inboxId:cognitiveInbox.entityId,expectedVersion:1,reason:"Read"});
  const parent=await issue({type:"dispatch.request",inboxId:cognitiveInbox.entityId,expectedInboxVersion:2,
    dispatchId:randomUUID(),parentDispatchId:null,taskId:parentTaskId,expectedTaskVersion:2,
    recipientRoleId:cognition,purpose:"cognition",authorizationScopeId:"cognition-scope",reason:"Review"});
  const claimToken=randomUUID();
  await issue({type:"dispatch.claim",dispatchId:parent.entityId,claimToken,
    leaseUntilUtc:new Date(Date.now()+60_000).toISOString()});
  await issue({type:"dispatch.start",dispatchId:parent.entityId,claimToken});
  const sessionId=randomUUID(),runId=randomUUID(),cwd=join(tmpdir(),"method-late-fixture");
  await wf({type:"runtime.session.reserve",sessionId,roleId:cognition,cwd,authorizationScope:"cognition-scope",
    model:"fixture-model",sandbox:"read-only",approvalPolicy:"on-request"});
  await runtime.beginSessionCreate(projectId,sessionId);
  await runtime.bindSession(projectId,sessionId,{owner:"evoloop-codex-app-server",projectId,sessionId,
    roleId:cognition,cwd,authorizationScope:"cognition-scope",nativeThreadId:`fixture-${sessionId}`,
    nativeSessionId:`fixture-${sessionId}`});
  await wf({type:"runtime.run.reserve",runId,taskId:parentTaskId,sessionId,expectedVersion:2,input:"Review method"});
  await issue({type:"dispatch.resolve",dispatchId:parent.entityId,claimToken,result:"accepted",runtimeRunId:runId,reason:"Bound"});
  await issue({type:"division.decide",decisionId:randomUUID(),loopId,expectedLoopVersion:
    (await orchestration.getLoop(principal(owner,projectId),projectId,loopId))!.version,
    sourceEventId:loop.bootstrapEventId,parentDispatchId:parent.entityId,
    documentId:parentFixed.contentDocumentId,documentRevisionId:parentFixed.contentRevisionId,
    documentContentHash:hash("# Bounded task"),firstTaskId,expectedFirstTaskVersion:1,
    choice:"method",roleId:business,templateId:null,templateRevision:null,templateHash:null,
    reason:"Record an existing-role approach"});
  const next=await issue({type:"inbox.accept",loopId,sourceEventId:loop.bootstrapEventId,
    recipientRoleId:cognition,purpose:"next_action"});
  await issue({type:"inbox.ack",inboxId:next.entityId,expectedVersion:1,reason:"Read method"});
  const lateRequest={type:"dispatch.request",inboxId:next.entityId,expectedInboxVersion:2,
    dispatchId:randomUUID(),parentDispatchId:parent.entityId,taskId:firstTaskId,expectedTaskVersion:1,
    recipientRoleId:business,purpose:"Late method work",authorizationScopeId:"business-scope",
    reason:"Must reject changed or finally decided work"};
  await wf({type:"task.update",taskId:firstTaskId,expectedVersion:1,title:"Task",
    content:"# Revised after method",acceptance:"Report",owner:business,
    reason:"The signed method must not follow later Task content"});
  await denied(issue(lateRequest),"TASK_CHANGED");
  await issue({type:"worker.decision",decisionId:randomUUID(),dispatchId:parent.entityId,runId,
    kind:"no_action",divisionDecisionId:null,reason:"No child needed",evidenceRefs:[]});
  const before=(await orchestration.getLoop(principal(owner,projectId),projectId,loopId))!.dispatchCount;
  await denied(issue(lateRequest),"PARENT_DECIDED");
  assert.equal((await orchestration.getLoop(principal(owner,projectId),projectId,loopId))?.dispatchCount,before);
  assert.equal((await orchestration.getInbox(principal(owner,projectId),projectId,next.entityId))?.state,"acknowledged");
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM orchestration_dispatch WHERE project_id=$1 AND loop_id=$2",[projectId,loopId])).rows[0].n,1);
});
