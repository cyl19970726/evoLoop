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
  await wf({type:"task.start",taskId:parentTaskId,expectedVersion:1,reason:"Cognition"});
  const parentFixed=(await workflow.getTask(principal(owner,projectId),projectId,parentTaskId)).revision;
  const documentId=parentFixed.contentDocumentId,documentRevisionId=parentFixed.contentRevisionId;
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
  const worker=await broker.issue({projectId,loopId,taskId:parentTaskId,runId,sessionId,roleId:cognition,
    kind:"cognition",allowedRoleIds:[cognition]});
  const beforeMethod=(await orchestration.getLoop(principal(owner,projectId),projectId,loopId))!;
  const app=await buildServer({service:workflow,credentials:[{token:"o".repeat(40),actorId:owner,
    projectIds:[projectId],permissions:["read","write","review"]}] as never,
    orchestration:{service:orchestration},workers:{authenticate:header=>broker.authenticate(header),
      facts:identity=>workerGuardFacts(pool,identity)}});
  t.after(async()=>app.close());
  const workerToken=(await readFile(join(workerRoot,runId,"credential"),"utf8")).trim();
  const methodCommand={type:"division.decide",projectId,operationId:randomUUID(),decisionId:randomUUID(),loopId,
    expectedLoopVersion:(await orchestration.getLoop(principal(owner,projectId),projectId,loopId))!.version,
    sourceEventId:loop.bootstrapEventId,parentDispatchId:parent.entityId,documentId,
    documentRevisionId,documentContentHash:hash("# Bounded task"),firstTaskId,
    expectedFirstTaskVersion:1,choice:"method",roleId:business,templateId:null,templateRevision:null,
    templateHash:null,reason:"Use the existing business Role differently"};
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
    dispatchId:randomUUID(),parentDispatchId:parent.entityId,taskId:firstTaskId,expectedTaskVersion:1,
    recipientRoleId:business,purpose:"Execute",authorizationScopeId:"business-scope",reason:"Method first Task"};
  await denied(issue(worker.principal.actorId,{type:"worker.decision",decisionId:randomUUID(),dispatchId:parent.entityId,
    runId,kind:"waiting",divisionDecisionId:null,reason:"Method alone is not a handoff",evidenceRefs:[]}),"INVALID_CAUSALITY");
  assert.equal(await orchestration.getDecisionForDispatch(principal(owner,projectId),projectId,parent.entityId),null);
  await denied(issue(owner,{...request,taskId:otherTaskId,recipientRoleId:other}),"METHOD_TASK_MISMATCH");
  await denied(issue(owner,{...request,expectedTaskVersion:2}),"METHOD_TASK_MISMATCH");
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
  await denied(issue(owner,{...request,dispatchId:randomUUID()}),"VERSION_CONFLICT");
  await runtime.rejectDispatch(projectId,runId,"Fixture terminal, no native Turn");
  await issue(owner,{type:"worker.outcome",dispatchId:parent.entityId,outcome:"waiting",deliveryId:null,
    decisionId:(await orchestration.getDecisionForDispatch(principal(owner,projectId),projectId,parent.entityId))!.id,
    evidenceRef:null,reason:"Wait for ordinary child"});
  const childToken=randomUUID();
  await issue(owner,{type:"dispatch.claim",dispatchId:child.entityId,claimToken:childToken,
    leaseUntilUtc:new Date(Date.now()+60_000).toISOString()});
  assert.equal((await orchestration.getDispatch(principal(owner,projectId),projectId,child.entityId))?.state,"claimed");
  await issue(owner,{type:"dispatch.start",dispatchId:child.entityId,claimToken:childToken});
  await wf({type:"task.start",taskId:firstTaskId,expectedVersion:1,reason:"Start fixed method Task"});
  const childSession=randomUUID(),childRun=randomUUID(),childInput="Execute the fixed method Task";
  await wf({type:"runtime.session.reserve",sessionId:childSession,roleId:business,cwd:join(tmpdir(),"method-fixture"),
    authorizationScope:"business-scope",model:"fixture-model",sandbox:"read-only",approvalPolicy:"on-request"});
  await runtime.beginSessionCreate(projectId,childSession);
  await runtime.bindSession(projectId,childSession,{owner:"evoloop-codex-app-server",projectId,sessionId:childSession,
    roleId:business,cwd:join(tmpdir(),"method-fixture"),authorizationScope:"business-scope",
    nativeThreadId:`fixture-${childSession}`,nativeSessionId:`fixture-${childSession}`});
  const childReserved=await wf({type:"runtime.run.reserve",runId:childRun,taskId:firstTaskId,sessionId:childSession,
    expectedVersion:2,input:childInput});
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
