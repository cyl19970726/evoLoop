import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";
import { runner } from "node-pg-migrate";
import { fileURLToPath } from "node:url";
import { RuntimeWorkflowService, WorkflowService } from "@evoloop/core";
import { OrchestrationService, OrchestrationError } from "@evoloop/core/orchestration";
import { migrate, PostgresUnitOfWork } from "@evoloop/adapter-postgres";
import { PgOrchestrationStore } from "@evoloop/adapter-postgres/orchestration";
const url=process.env.TEST_DATABASE_URL;
if(!url||!/evoloop.*test/.test(new URL(url).pathname))throw new Error("dedicated test database required");
const schema=`el_orch_${randomUUID().replaceAll("-","").slice(0,16)}`;
const pool=new pg.Pool({connectionString:url,options:`-c search_path=${schema}`});
const projectId=randomUUID(),actor="cognitive-actor",worker="worker-actor",cognitiveRole="cognitive-role",businessRole="business-role",scopeId="test-worker-scope",cognitiveScope="test-cognitive-scope";
const principal=(actorId:string)=>({actorId,projectIds:[projectId],permissions:["read","write","review"] as Array<"read"|"write"|"review">});
const sha=(s:string)=>createHash("sha256").update(s).digest("hex");
const workflow=new WorkflowService({uow:new PostgresUnitOfWork(pool),clock:{now:()=>new Date().toISOString()},ids:{next:randomUUID},hasher:{hash:sha}});
const runtime=new RuntimeWorkflowService({uow:new PostgresUnitOfWork(pool),clock:{now:()=>new Date().toISOString()},ids:{next:randomUUID}});
const store=new PgOrchestrationStore(pool,{getAuthorizationFact:async(project,scope)=>project===projectId&&scope===scopeId?{projectId,scopeId,actorId:worker,roleId:businessRole,active:true}:project===projectId&&scope===cognitiveScope?{projectId,scopeId:cognitiveScope,actorId:actor,roleId:cognitiveRole,active:true}:null,
  canActAsRole:async(project,who,role)=>project===projectId&&(who===actor&&role===cognitiveRole||who===worker&&role===businessRole)});
const orchestrator=new OrchestrationService({store,now:()=>new Date().toISOString(),nextId:randomUUID,hash:sha});
const issue=(who:string,command:Record<string,unknown>)=>orchestrator.execute(principal(who),{projectId,operationId:randomUUID(),...command} as never);
const fails=async(p:Promise<unknown>,code:string)=>assert.rejects(p,e=>e instanceof OrchestrationError&&e.code===code);
test("PG orchestration enrolls only new sources, deduplicates inbox and preserves claims, budget and journal",async t=>{
  await migrate(url!,schema);
  t.after(async()=>{await pool.end();const c=new pg.Client({connectionString:url});await c.connect();try{await c.query(`DROP SCHEMA "${schema}" CASCADE`);}finally{await c.end();}});
  const goalId=randomUUID(),stageId=randomUUID(),taskId=randomUUID(),cognitiveTaskId=randomUUID(),loopId=randomUUID();
  for(const command of [{type:"project.create",title:"Orchestration"},{type:"goal.create",goalId,outcome:"A verified task",constraints:"Local",consumer:"owner",authority:"reviewer",scope:"pilot",owner:actor},
    {type:"stage.propose",stageId,goalId,deliverable:"One delivery",learningQuestion:"What changed?",reason:"Bounded trial"},
    {type:"stage.accept",stageId,expectedVersion:1,reason:"Start bounded trial"},
    {type:"task.create",taskId,stageId,title:"Worker task",content:"# Do one bounded task",acceptance:"Deliver",owner:businessRole,
      consumer:"owner",evidence:"Pending",stopCondition:"One result"},
    {type:"task.start",taskId,expectedVersion:1,reason:"Seal worker Task"},
    {type:"task.create",taskId:cognitiveTaskId,stageId,title:"Cognitive review",content:"# Review one event",acceptance:"Propose next action",owner:cognitiveRole,
      consumer:"owner",evidence:"Pending",stopCondition:"One review"},
    {type:"task.start",taskId:cognitiveTaskId,expectedVersion:1,reason:"Seal cognitive Task"}]) {
    const r=await workflow.execute(principal(actor),{projectId,operationId:randomUUID(),...command} as never);assert.equal(r.status,"applied",JSON.stringify(r));
  }
  const last=(await pool.query("SELECT created_at,event_id FROM outbox_event WHERE project_id=$1 ORDER BY created_at DESC,event_id DESC LIMIT 1",[projectId])).rows[0];
  const enroll={type:"loop.enroll",loopId,goalId,stageId,cognitiveRoleId:cognitiveRole,allowedBusinessRoleIds:[businessRole],
    sourceAfter:{createdAtUtc:last.created_at.toISOString(),eventId:last.event_id},maxRuns:2,maxConcurrent:1,reason:"Finite local pilot"};
  const op=randomUUID(),enrolled=await orchestrator.execute(principal(actor),{projectId,operationId:op,...enroll} as never);
  assert.equal(enrolled.version,1);assert.equal((await orchestrator.execute(principal(actor),{projectId,operationId:op,...enroll} as never)).replayed,true);
  await fails(orchestrator.execute(principal(actor),{projectId,operationId:op,...enroll,maxRuns:3} as never),"OPERATION_CONFLICT");
  const loop=(await orchestrator.getLoop(principal(actor),projectId,loopId))!;
  assert.equal((await orchestrator.listSourceFacts(principal(actor),projectId,loopId)).items.some(x=>x.id===last.event_id),false);
  assert.equal((await orchestrator.listSourceFacts(principal(actor),projectId,loopId)).items.some(x=>x.id===loop.bootstrapEventId),true);
  const newSourceOperation=randomUUID();
  const newSource=await workflow.execute(principal(actor),{type:"document.create",projectId,
    operationId:newSourceOperation,documentId:randomUUID(),title:"New source after enrollment",body:"# Newly observed"});
  assert.equal(newSource.status,"applied");
  const irrelevantSourceId=(await pool.query("SELECT event_id FROM outbox_event WHERE project_id=$1 AND operation_id=$2 LIMIT 1",
    [projectId,newSourceOperation])).rows[0]?.event_id;
  assert.ok(irrelevantSourceId);
  assert.equal((await orchestrator.listSourceFacts(principal(actor),projectId,loopId)).items.some(x=>x.id===irrelevantSourceId),false);
  await fails(issue(actor,{type:"inbox.accept",loopId,sourceEventId:irrelevantSourceId,recipientRoleId:cognitiveRole,purpose:"cognitive_review"}),"SOURCE_UNAVAILABLE");
  await fails(issue(actor,{type:"inbox.accept",loopId,sourceEventId:last.event_id,recipientRoleId:cognitiveRole,purpose:"cognitive_review"}),"SOURCE_UNAVAILABLE");
  const first=await issue(actor,{type:"inbox.accept",loopId,sourceEventId:loop.bootstrapEventId,recipientRoleId:cognitiveRole,purpose:"cognitive_review"});
  const duplicate=await issue(actor,{type:"inbox.accept",loopId,sourceEventId:loop.bootstrapEventId,recipientRoleId:cognitiveRole,purpose:"cognitive_review"});
  assert.equal(duplicate.entityId,first.entityId);
  await issue(actor,{type:"inbox.ack",inboxId:first.entityId,expectedVersion:1,reason:"Read verified seed"});
  const cognition=await issue(actor,{type:"dispatch.request",inboxId:first.entityId,expectedInboxVersion:2,dispatchId:randomUUID(),
    parentDispatchId:null,taskId:cognitiveTaskId,expectedTaskVersion:2,recipientRoleId:cognitiveRole,purpose:"cognition",
    authorizationScopeId:cognitiveScope,reason:"Review verified seed"});
  const cognitionToken=randomUUID();
  await issue(actor,{type:"dispatch.claim",dispatchId:cognition.entityId,claimToken:cognitionToken,leaseUntilUtc:new Date(Date.now()+60_000).toISOString()});
  await issue(actor,{type:"dispatch.start",dispatchId:cognition.entityId,claimToken:cognitionToken});
  const cognitiveSession=randomUUID(),cognitiveRun=randomUUID();
  assert.equal((await workflow.execute(principal(actor),{type:"runtime.session.reserve",projectId,operationId:randomUUID(),
    sessionId:cognitiveSession,roleId:cognitiveRole,cwd:"/tmp/evoloop-orchestration-test",authorizationScope:cognitiveScope,
    model:"test-model",sandbox:"read-only",approvalPolicy:"on-request"})).status,"applied");
  await runtime.beginSessionCreate(projectId,cognitiveSession);
  await runtime.bindSession(projectId,cognitiveSession,{owner:"evoloop-codex-app-server",projectId,sessionId:cognitiveSession,
    roleId:cognitiveRole,cwd:"/tmp/evoloop-orchestration-test",authorizationScope:cognitiveScope,
    nativeThreadId:`fixture-${cognitiveSession}`,nativeSessionId:`fixture-${cognitiveSession}`});
  const cognitiveRunResult=await workflow.execute(principal(actor),{type:"runtime.run.reserve",projectId,operationId:randomUUID(),
    runId:cognitiveRun,taskId:cognitiveTaskId,sessionId:cognitiveSession,expectedVersion:2,input:"Review source"});
  assert.equal(cognitiveRunResult.status,"applied");
  await issue(actor,{type:"dispatch.resolve",dispatchId:cognition.entityId,claimToken:cognitionToken,result:"accepted",
    runtimeRunId:cognitiveRun,reason:"Bound cognitive Run"});
  const cognitiveSubmission=randomUUID(),cognitiveDeliveryOp=randomUUID();
  const cognitiveIntent={artifactRef:"artifact:cognitive-review",artifactRevision:"v1",contentHash:sha("cognitive-review"),
    technicalResult:"failed",technicalEvidence:"Fixture retained review output",reason:"Record cognitive output"};
  const cognitiveSubmitOperation=randomUUID(),cognitiveSubmit={type:"worker.submit",submissionId:cognitiveSubmission,dispatchId:cognition.entityId,runId:cognitiveRun,
    taskRevisionId:cognitiveRunResult.revisionId,runInputHash:sha("Review source"),deliveryOperationId:cognitiveDeliveryOp,
    deliveryIntent:cognitiveIntent,agentObservation:"One bounded review",evidenceRefs:[]};
  await orchestrator.execute(principal(actor),{projectId,operationId:cognitiveSubmitOperation,...cognitiveSubmit} as never);
  await runtime.rejectDispatch(projectId,cognitiveRun,"Fixture preflight completed without native turn");
  assert.equal((await orchestrator.execute(principal(actor),{projectId,operationId:cognitiveSubmitOperation,...cognitiveSubmit} as never)).replayed,true);
  await issue(actor,{type:"worker.beginSeal",submissionId:cognitiveSubmission,expectedVersion:1,expectedTaskVersion:3,sealToken:randomUUID()});
  const cognitiveSeal=(await store.read(projectId,r=>r.getSubmission(cognitiveSubmission)))!;
  const cognitiveDelivery=await workflow.execute(principal(actor),{type:"delivery.record",projectId,operationId:cognitiveDeliveryOp,
    taskId:cognitiveTaskId,runId:cognitiveRun,expectedVersion:3,...cognitiveIntent});
  assert.equal(cognitiveDelivery.status,"applied");
  await issue(actor,{type:"worker.finishSeal",submissionId:cognitiveSubmission,sealToken:cognitiveSeal.sealToken,
    result:"sealed",deliveryId:cognitiveDelivery.revisionId,reason:"Verified cognitive delivery"});
  await issue(actor,{type:"worker.outcome",dispatchId:cognition.entityId,outcome:"delivered",deliveryId:cognitiveDelivery.revisionId,decisionId:null,
    evidenceRef:"delivery:cognitive-review",reason:"Cognition completed"});
  const deliverySourceId=(await pool.query("SELECT event_id FROM outbox_event WHERE project_id=$1 AND operation_id=$2 AND kind='delivery.record' LIMIT 1",
    [projectId,cognitiveDeliveryOp])).rows[0]?.event_id;
  assert.ok(deliverySourceId);
  assert.equal((await orchestrator.listSourceFacts(principal(actor),projectId,loopId)).items.some(x=>x.id===deliverySourceId),false);
  await fails(issue(actor,{type:"inbox.accept",loopId,sourceEventId:deliverySourceId,recipientRoleId:cognitiveRole,purpose:"cognitive_review"}),"SOURCE_UNAVAILABLE");
  const nextInbox=await issue(actor,{type:"inbox.accept",loopId,sourceEventId:loop.bootstrapEventId,recipientRoleId:cognitiveRole,purpose:"next_action"});
  await issue(actor,{type:"inbox.ack",inboxId:nextInbox.entityId,expectedVersion:1,reason:"Select next action"});
  const requested=await issue(actor,{type:"dispatch.request",inboxId:nextInbox.entityId,expectedInboxVersion:2,dispatchId:randomUUID(),
    parentDispatchId:cognition.entityId,taskId,expectedTaskVersion:2,recipientRoleId:businessRole,purpose:"Execute one bounded task",
    authorizationScopeId:scopeId,reason:"Reviewed task"});
  assert.equal((await orchestrator.listDispatches(principal(actor),projectId,loopId)).items.length,2);
  await fails(issue(actor,{type:"dispatch.claim",dispatchId:requested.entityId,claimToken:randomUUID(),
    leaseUntilUtc:new Date(Date.now()+60_000).toISOString()}),"FORBIDDEN");
  await fails(issue(worker,{type:"dispatch.claim",dispatchId:requested.entityId,claimToken:randomUUID(),
    leaseUntilUtc:new Date(Date.now()-1000).toISOString()}),"INVALID_LEASE");
  const candidateTokens=[randomUUID(),randomUUID()];
  const races=await Promise.allSettled(candidateTokens.map(claimToken=>issue(worker,{type:"dispatch.claim",
    dispatchId:requested.entityId,claimToken,leaseUntilUtc:new Date(Date.now()+60_000).toISOString()})));
  assert.equal(races.filter(x=>x.status==="fulfilled").length,1,"one transaction wins concurrent claim");
  assert.equal(races.filter(x=>x.status==="rejected"&&(x.reason as OrchestrationError).code==="DISPATCH_NOT_PENDING").length,1);
  const claimToken=candidateTokens[races.findIndex(x=>x.status==="fulfilled")]!;
  const claim=races.find(x=>x.status==="fulfilled") as PromiseFulfilledResult<Awaited<ReturnType<typeof issue>>>;
  assert.equal(claim.value.version,2);
  await fails(issue(worker,{type:"dispatch.claim",dispatchId:requested.entityId,claimToken:randomUUID(),leaseUntilUtc:new Date(Date.now()+60_000).toISOString()}),"DISPATCH_NOT_PENDING");
  await issue(actor,{type:"loop.state",loopId,expectedVersion:3,state:"paused",reason:"Pause bounded work"});
  await fails(issue(worker,{type:"dispatch.start",dispatchId:requested.entityId,claimToken:randomUUID()}),"LOOP_PAUSED");
  await issue(actor,{type:"loop.state",loopId,expectedVersion:4,state:"active",reason:"Resume bounded work"});
  await fails(issue(worker,{type:"dispatch.start",dispatchId:requested.entityId,claimToken:randomUUID()}),"CLAIM_MISMATCH");
  await issue(worker,{type:"dispatch.start",dispatchId:requested.entityId,claimToken});
  const sessionId=randomUUID(),runId=randomUUID();
  const session=await workflow.execute(principal(worker),{type:"runtime.session.reserve",projectId,operationId:randomUUID(),
    sessionId,roleId:businessRole,cwd:"/tmp/evoloop-orchestration-test",authorizationScope:scopeId,
    model:"test-model",sandbox:"read-only",approvalPolicy:"on-request"});
  assert.equal(session.status,"applied",JSON.stringify(session));
  await runtime.beginSessionCreate(projectId,sessionId);
  await runtime.bindSession(projectId,sessionId,{owner:"evoloop-codex-app-server",projectId,sessionId,
    roleId:businessRole,cwd:"/tmp/evoloop-orchestration-test",authorizationScope:scopeId,
    nativeThreadId:`fixture-${sessionId}`,nativeSessionId:`fixture-${sessionId}`});
  const run=await workflow.execute(principal(worker),{type:"runtime.run.reserve",projectId,operationId:randomUUID(),
    runId,taskId,sessionId,expectedVersion:2,input:"Execute bounded task"});
  assert.equal(run.status,"applied",JSON.stringify(run));
  await issue(worker,{type:"dispatch.resolve",dispatchId:requested.entityId,claimToken,result:"accepted",runtimeRunId:runId,
    reason:"Bound to durable failed Run"});
  const submissionId=randomUUID(),deliveryOperationId=randomUUID();
  const deliveryIntent={artifactRef:"artifact:failed-preflight",artifactRevision:"v1",contentHash:sha("failed-preflight"),
    technicalResult:"failed",technicalEvidence:"Native preflight failure retained",reason:"Record failed output"};
  const businessSubmitOperation=randomUUID(),businessSubmit={type:"worker.submit",submissionId,dispatchId:requested.entityId,runId,
    taskRevisionId:run.revisionId,runInputHash:sha("Execute bounded task"),deliveryOperationId,deliveryIntent,
    agentObservation:"No external turn started",evidenceRefs:["runtime:preflight"]};
  await orchestrator.execute(principal(worker),{projectId,operationId:businessSubmitOperation,...businessSubmit} as never);
  await runtime.rejectDispatch(projectId,runId,"Native fixture preflight rejected, no external turn attempted");
  assert.equal((await orchestrator.execute(principal(worker),{projectId,operationId:businessSubmitOperation,...businessSubmit} as never)).replayed,true);
  await issue(actor,{type:"worker.beginSeal",submissionId,expectedVersion:1,expectedTaskVersion:3,sealToken:randomUUID()});
  const submission=(await store.read(projectId,r=>r.getSubmission(submissionId)))!;
  const delivery=await workflow.execute(principal(worker),{type:"delivery.record",projectId,operationId:deliveryOperationId,
    taskId,runId,expectedVersion:3,...deliveryIntent});
  assert.equal(delivery.status,"applied",JSON.stringify(delivery));
  await issue(actor,{type:"worker.finishSeal",submissionId,sealToken:submission.sealToken,result:"sealed",
    deliveryId:delivery.revisionId,reason:"Matched authoritative Delivery"});
  assert.equal((await store.read(projectId,r=>r.getSubmission(submissionId)))?.state,"sealed");
  await issue(worker,{type:"worker.outcome",dispatchId:requested.entityId,outcome:"delivered",deliveryId:delivery.revisionId,decisionId:null,
    evidenceRef:"delivery:failed-preflight",reason:"Failed artifact retained as Delivery"});
  const feedback=(await orchestrator.listSourceFacts(principal(actor),projectId,loopId)).items.find(x=>x.kind==="worker.outcome");
  assert.ok(feedback);
  assert.equal(feedback.sourceLoopId,loopId);
  assert.equal(feedback.originDispatchId,requested.entityId);
  assert.equal(feedback.subjectId,taskId);
  const firstSourcePage=await orchestrator.listSourceFacts(principal(actor),projectId,loopId,1);
  assert.deepEqual(firstSourcePage.items.map(x=>x.id),[loop.bootstrapEventId]);
  assert.ok(firstSourcePage.nextCursor);
  const secondSourcePage=await orchestrator.listSourceFacts(principal(actor),projectId,loopId,1,firstSourcePage.nextCursor);
  assert.deepEqual(secondSourcePage.items.map(x=>x.id),[feedback.id]);
  const budgetInbox=await issue(actor,{type:"inbox.accept",loopId,sourceEventId:feedback.id,recipientRoleId:cognitiveRole,purpose:"next_action"});
  await issue(actor,{type:"inbox.ack",inboxId:budgetInbox.entityId,expectedVersion:1,reason:"Review bounded feedback"});
  await fails(issue(actor,{type:"dispatch.request",inboxId:budgetInbox.entityId,expectedInboxVersion:2,dispatchId:randomUUID(),parentDispatchId:cognition.entityId,taskId,expectedTaskVersion:2,
    recipientRoleId:businessRole,purpose:"Another task",authorizationScopeId:scopeId,reason:"Budget test"}),"RUN_LIMIT");
  const lateTaskId=randomUUID(),lateLoopId=randomUUID(),lateRunId=randomUUID();
  assert.equal((await workflow.execute(principal(actor),{type:"task.create",projectId,operationId:randomUUID(),taskId:lateTaskId,
    stageId,title:"Late intent boundary",content:"# Observe terminal boundary",acceptance:"One refusal",owner:cognitiveRole,
    consumer:"owner",evidence:"Pending",stopCondition:"One run"})).status,"applied");
  assert.equal((await workflow.execute(principal(actor),{type:"task.start",projectId,operationId:randomUUID(),taskId:lateTaskId,
    expectedVersion:1,reason:"Freeze late Task"})).status,"applied");
  const lateLast=(await pool.query("SELECT created_at,event_id FROM outbox_event WHERE project_id=$1 ORDER BY created_at DESC,event_id DESC LIMIT 1",[projectId])).rows[0];
  await issue(actor,{type:"loop.enroll",loopId:lateLoopId,goalId,stageId,cognitiveRoleId:cognitiveRole,
    allowedBusinessRoleIds:[businessRole],sourceAfter:{createdAtUtc:lateLast.created_at.toISOString(),eventId:lateLast.event_id},
    maxRuns:1,maxConcurrent:1,reason:"Terminal first-intent rejection"});
  const lateLoop=(await orchestrator.getLoop(principal(actor),projectId,lateLoopId))!;
  const lateInbox=await issue(actor,{type:"inbox.accept",loopId:lateLoopId,sourceEventId:lateLoop.bootstrapEventId,
    recipientRoleId:cognitiveRole,purpose:"cognitive_review"});
  await issue(actor,{type:"inbox.ack",inboxId:lateInbox.entityId,expectedVersion:1,reason:"Read late seed"});
  const lateDispatch=await issue(actor,{type:"dispatch.request",inboxId:lateInbox.entityId,expectedInboxVersion:2,
    dispatchId:randomUUID(),parentDispatchId:null,taskId:lateTaskId,expectedTaskVersion:2,
    recipientRoleId:cognitiveRole,purpose:"cognition",authorizationScopeId:cognitiveScope,reason:"Check terminal intent"});
  const lateClaim=randomUUID();
  await issue(actor,{type:"dispatch.claim",dispatchId:lateDispatch.entityId,claimToken:lateClaim,leaseUntilUtc:new Date(Date.now()+60_000).toISOString()});
  await issue(actor,{type:"dispatch.start",dispatchId:lateDispatch.entityId,claimToken:lateClaim});
  const lateRun=await workflow.execute(principal(actor),{type:"runtime.run.reserve",projectId,operationId:randomUUID(),runId:lateRunId,
    taskId:lateTaskId,sessionId:cognitiveSession,expectedVersion:2,input:"Reject late first submission"});
  assert.equal(lateRun.status,"applied");
  await issue(actor,{type:"dispatch.resolve",dispatchId:lateDispatch.entityId,claimToken:lateClaim,result:"accepted",
    runtimeRunId:lateRunId,reason:"Bound late Run"});
  await runtime.rejectDispatch(projectId,lateRunId,"Fixture terminal before first intent");
  await fails(issue(actor,{type:"worker.submit",submissionId:randomUUID(),dispatchId:lateDispatch.entityId,runId:lateRunId,
    taskRevisionId:lateRun.revisionId,runInputHash:sha("Reject late first submission"),deliveryOperationId:randomUUID(),
    deliveryIntent:cognitiveIntent,agentObservation:"Late intent",evidenceRefs:[]}),"RUN_NOT_ACTIVE");
  assert.equal((await orchestrator.listDispatches(principal(actor),projectId,loopId)).items.find(x=>x.id===requested.entityId)?.runtimeRunId,runId);
  await issue(actor,{type:"loop.state",loopId,expectedVersion:5,state:"stopped",reason:"Stop bounded work"});
  await fails(issue(actor,{type:"inbox.accept",loopId,sourceEventId:loop.bootstrapEventId,recipientRoleId:cognitiveRole,purpose:"cognitive_review"}),"LOOP_STOPPED");
  assert.equal((await pool.query("SELECT count(*)::int n FROM orchestration_operation WHERE project_id=$1 AND operation_id=$2",[projectId,op])).rows[0].n,1);
});
test("016 upgrades nonempty preexisting project facts without rewriting them",async()=>{
  const oldSchema=`el_orch_upgrade_${randomUUID().replaceAll("-","").slice(0,12)}`;
  const migrations=fileURLToPath(new URL("../../packages/adapter-postgres/migrations/",import.meta.url));
  const client=new pg.Client({connectionString:url,options:`-c search_path=${oldSchema}`});
  try{
    await runner({databaseUrl:url!,dir:migrations,migrationsTable:"pgmigrations",schema:oldSchema,
      createSchema:true,createMigrationsSchema:true,direction:"up",singleTransaction:true,count:15,log:()=>{}});
    await client.connect();
    const oldProject=randomUUID(),oldGoal=randomUUID(),created="2026-10-22T00:00:00.000Z";
    await client.query("INSERT INTO project(project_id,title,created_at) VALUES($1,'Existing project',$2)",[oldProject,created]);
    await client.query(`INSERT INTO project_goal(project_id,goal_id,version,outcome,constraints,consumer,authority,scope,owner,actor_id,created_at)
      VALUES($1,$2,1,'Original outcome','Original constraints','owner','reviewer','project','owner','migration-test',$3)`,[oldProject,oldGoal,created]);
    const oldPool=new pg.Pool({connectionString:url,options:`-c search_path=${oldSchema}`});
    try{
      const oldUow=new PostgresUnitOfWork(oldPool);
      const oldWorkflow=new WorkflowService({uow:oldUow,clock:{now:()=>created},ids:{next:randomUUID},hasher:{hash:sha}});
      const oldRuntime=new RuntimeWorkflowService({uow:oldUow,clock:{now:()=>created},ids:{next:randomUUID}});
      const oldPrincipal={actorId:"migration-worker",projectIds:[oldProject],permissions:["read","write","review"] as Array<"read"|"write"|"review">};
      const stageId=randomUUID(),taskId=randomUUID(),sessionId=randomUUID(),runId=randomUUID();
      for(const command of [{type:"stage.propose",stageId,goalId:oldGoal,deliverable:"Legacy output",learningQuestion:"What changed?",reason:"Legacy"},
        {type:"stage.accept",stageId,expectedVersion:1,reason:"Legacy active"},
        {type:"task.create",taskId,stageId,title:"Legacy Task",content:"# Legacy",acceptance:"Check",owner:"migration-worker",
          consumer:"owner",evidence:"Pending",stopCondition:"One result"},
        {type:"task.start",taskId,expectedVersion:1,reason:"Legacy start"},
        {type:"runtime.session.reserve",sessionId,roleId:"migration-worker",cwd:"/tmp/evoloop-orchestration-test",
          authorizationScope:"legacy-test",model:"test-model",sandbox:"read-only",approvalPolicy:"on-request"}]) {
        const result=await oldWorkflow.execute(oldPrincipal,{projectId:oldProject,operationId:randomUUID(),...command} as never);
        assert.equal(result.status,"applied",JSON.stringify(result));
      }
      await oldRuntime.beginSessionCreate(oldProject,sessionId);
      await oldRuntime.bindSession(oldProject,sessionId,{owner:"evoloop-codex-app-server",projectId:oldProject,
        sessionId,roleId:"migration-worker",cwd:"/tmp/evoloop-orchestration-test",authorizationScope:"legacy-test",
        nativeThreadId:`fixture-${sessionId}`,nativeSessionId:`fixture-${sessionId}`});
      assert.equal((await oldWorkflow.execute(oldPrincipal,{type:"runtime.run.reserve",projectId:oldProject,operationId:randomUUID(),
        runId,taskId,sessionId,expectedVersion:2,input:"Legacy input"})).status,"applied");
      await oldRuntime.rejectDispatch(oldProject,runId,"Legacy terminal fixture");
    }finally{await oldPool.end();}
    const snapshot=async()=>{const rows=[];for(const table of ["project_goal","task","runtime_session","runtime_run"])
      rows.push((await client.query(`SELECT * FROM ${table} WHERE project_id=$1 ORDER BY 1,2`,[oldProject])).rows);
      return rows;};
    const before=await snapshot();
    await migrate(url!,oldSchema);
    const after=await snapshot();
    assert.deepEqual(after,before);
    assert.equal((await client.query("SELECT count(*)::int n FROM pgmigrations")).rows[0].n,16);
  }finally{
    await client.end().catch(()=>{});
    const cleanup=new pg.Client({connectionString:url});await cleanup.connect();
    try{await cleanup.query(`DROP SCHEMA IF EXISTS "${oldSchema}" CASCADE`);}finally{await cleanup.end();}
  }
});
