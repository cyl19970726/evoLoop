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
import type { DelegationTemplate } from "@evoloop/contracts/division";
const url=process.env.TEST_DATABASE_URL;
if(!url||!/evoloop.*test/.test(new URL(url).pathname))throw new Error("dedicated test database required");
const schema=`el_orch_${randomUUID().replaceAll("-","").slice(0,16)}`;
const pool=new pg.Pool({connectionString:url,options:`-c search_path=${schema}`});
const projectId=randomUUID(),actor="cognitive-actor",worker="worker-actor",cognitiveRole="cognitive-role",businessRole="business-role",scopeId="test-worker-scope",cognitiveScope="test-cognitive-scope";
const principal=(actorId:string)=>({actorId,projectIds:[projectId],permissions:["read","write","review"] as Array<"read"|"write"|"review">});
const sha=(s:string)=>createHash("sha256").update(s).digest("hex");
const workflow=new WorkflowService({uow:new PostgresUnitOfWork(pool),clock:{now:()=>new Date().toISOString()},ids:{next:randomUUID},hasher:{hash:sha}});
const runtime=new RuntimeWorkflowService({uow:new PostgresUnitOfWork(pool),clock:{now:()=>new Date().toISOString()},ids:{next:randomUUID}});
let businessGrantActive=true;
const store=new PgOrchestrationStore(pool,{getAuthorizationFact:async(project,scope)=>project===projectId&&scope===scopeId?{projectId,scopeId,actorId:worker,roleId:businessRole,active:businessGrantActive}:project===projectId&&scope===cognitiveScope?{projectId,scopeId:cognitiveScope,actorId:actor,roleId:cognitiveRole,active:true}:null,
  canActAsRole:async(project,who,role)=>project===projectId&&(who===actor&&role===cognitiveRole||who===worker&&role===businessRole),
  wasActorRole:async(project,who,loop,role)=>project===projectId&&who===actor&&role===cognitiveRole});
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
  assert.equal(await store.transaction(projectId,tx=>tx.countCapacityUsed(loopId)),0,"terminal accepted Run releases concurrency before outcome");
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
  // A terminal parent alone cannot authorize a child with a foreign causal edge.
  const parentBefore=await store.transaction(projectId,tx=>tx.getDispatch(cognition.entityId)); assert.ok(parentBefore);
  await store.transaction(projectId,tx=>tx.updateDispatch({...parentBefore,sourceEventId:randomUUID(),version:parentBefore.version+1},parentBefore.version));
  await fails(issue(worker,{type:"dispatch.claim",dispatchId:requested.entityId,claimToken:randomUUID(),
    leaseUntilUtc:new Date(Date.now()+60_000).toISOString()}),"PARENT_NOT_READY");
  const parentChanged=await store.transaction(projectId,tx=>tx.getDispatch(cognition.entityId)); assert.ok(parentChanged);
  await store.transaction(projectId,tx=>tx.updateDispatch({...parentChanged,sourceEventId:loop.bootstrapEventId,version:parentChanged.version+1},parentChanged.version));
  // The original request cannot bypass a revoked child-role grant either.
  businessGrantActive=false;
  await fails(issue(worker,{type:"dispatch.claim",dispatchId:requested.entityId,claimToken:randomUUID(),
    leaseUntilUtc:new Date(Date.now()+60_000).toISOString()}),"SCOPE_NOT_AUTHORIZED");
  businessGrantActive=true;
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
  assert.equal(await store.transaction(projectId,tx=>tx.countCapacityUsed(loopId)),0,"terminal Run frees capacity while seal is pending");
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
  const observationSource=async(who:string,result:"used"|"failed"|"notUsed")=>{
    const operationId=randomUUID();
    const recorded=await workflow.execute(principal(who),{type:"observation.record",projectId,operationId,taskId,
      deliveryId:delivery.revisionId,observer:who,observerKind:"agent",result,evidence:"Independent consumer observation",reason:"Observed fixed delivery"});
    assert.equal(recorded.status,"applied",JSON.stringify(recorded));
    const sourceId=(await pool.query("SELECT event_id FROM outbox_event WHERE project_id=$1 AND operation_id=$2 AND kind='observation.record'",[projectId,operationId])).rows[0]?.event_id;
    assert.ok(sourceId);
    return {operationId,observationId:recorded.revisionId!,sourceId};
  };
  const external=await observationSource("consumer-observer","used");
  const externalFact=(await store.transaction(projectId,tx=>tx.getSourceFact(external.sourceId)))!;
  assert.equal(externalFact.kind,"observation.record");
  assert.equal(externalFact.operationId,external.operationId);
  assert.equal(externalFact.sourceActorId,"consumer-observer");
  assert.equal(externalFact.observationId,external.observationId);
  assert.equal(externalFact.deliveryId,delivery.revisionId);
  assert.equal(externalFact.observationResult,"used");
  assert.equal((await store.transaction(projectId,tx=>tx.getObservationFact(external.observationId)))?.stageId,stageId);
  assert.equal((await store.transaction(projectId,tx=>tx.getDeliveryFact(delivery.revisionId!)))?.taskRevisionId,delivery.revisionId ?
    (await pool.query("SELECT task_revision_id FROM delivery WHERE project_id=$1 AND delivery_id=$2",[projectId,delivery.revisionId])).rows[0].task_revision_id:null);
  assert.equal((await store.transaction(projectId,tx=>tx.getWorkflowOperationFact(external.operationId)))?.resultVersion,externalFact.subjectVersion);
  assert.equal((await orchestrator.listSourceFacts(principal(actor),projectId,loopId)).items.some(x=>x.id===external.sourceId),true);
  const acceptedObservation=await issue(actor,{type:"inbox.accept",loopId,sourceEventId:external.sourceId,recipientRoleId:cognitiveRole,purpose:"cognitive_review"});
  assert.ok(acceptedObservation.entityId);
  const selfObservation=await observationSource(worker,"used");
  assert.equal((await orchestrator.listSourceFacts(principal(actor),projectId,loopId)).items.some(x=>x.id===selfObservation.sourceId),false);
  await fails(issue(actor,{type:"inbox.accept",loopId,sourceEventId:selfObservation.sourceId,recipientRoleId:cognitiveRole,purpose:"cognitive_review"}),"SOURCE_UNAVAILABLE");
  const cognitiveObservation=await observationSource(actor,"used");
  await fails(issue(actor,{type:"inbox.accept",loopId,sourceEventId:cognitiveObservation.sourceId,recipientRoleId:cognitiveRole,purpose:"cognitive_review"}),"SOURCE_UNAVAILABLE");
  const foreignGoalId=randomUUID(),foreignStageId=randomUUID(),foreignTaskId=randomUUID(),foreignDeliveryOp=randomUUID(),foreignObservationOp=randomUUID();
  for(const command of [
    {type:"goal.create",goalId:foreignGoalId,outcome:"Other goal",constraints:"Separate",consumer:"owner",authority:"reviewer",scope:"foreign",owner:actor},
    {type:"stage.propose",stageId:foreignStageId,goalId:foreignGoalId,deliverable:"Other delivery",learningQuestion:"Separate?",reason:"Other scope"},
    {type:"stage.accept",stageId:foreignStageId,expectedVersion:1,reason:"Activate other stage"},
    {type:"task.create",taskId:foreignTaskId,stageId:foreignStageId,title:"Foreign work",content:"# Other work",acceptance:"One artifact",owner:businessRole,consumer:"owner",evidence:"Pending",stopCondition:"One result"},
    {type:"task.start",taskId:foreignTaskId,expectedVersion:1,reason:"Freeze other task"},
  ]) assert.equal((await workflow.execute(principal(actor),{projectId,operationId:randomUUID(),...command} as never)).status,"applied");
  const foreignDelivery=await workflow.execute(principal(worker),{type:"delivery.record",projectId,operationId:foreignDeliveryOp,
    taskId:foreignTaskId,expectedVersion:2,artifactRef:"artifact:other",artifactRevision:"v1",contentHash:sha("other"),
    technicalResult:"passed",technicalEvidence:"Separate artifact",reason:"Other delivery"});
  assert.equal(foreignDelivery.status,"applied");
  const foreignObservation=await workflow.execute(principal("consumer-observer"),{type:"observation.record",projectId,operationId:foreignObservationOp,
    taskId:foreignTaskId,deliveryId:foreignDelivery.revisionId,observer:"consumer-observer",observerKind:"agent",result:"used",evidence:"Separate use",reason:"Other goal"});
  assert.equal(foreignObservation.status,"applied");
  const foreignSourceId=(await pool.query("SELECT event_id FROM outbox_event WHERE project_id=$1 AND operation_id=$2 AND kind='observation.record'",[projectId,foreignObservationOp])).rows[0]?.event_id;
  assert.ok(foreignSourceId);
  assert.equal((await orchestrator.listSourceFacts(principal(actor),projectId,loopId)).items.some(x=>x.id===foreignSourceId),false);
  await fails(issue(actor,{type:"inbox.accept",loopId,sourceEventId:foreignSourceId,recipientRoleId:cognitiveRole,purpose:"cognitive_review"}),"SOURCE_UNAVAILABLE");
  const oldDeliveryStage=(await store.transaction(projectId,tx=>tx.getObservationFact(external.observationId)))?.stageId;
  assert.equal(oldDeliveryStage,stageId);
  const beforeMove=(await workflow.getTask(principal(actor),projectId,taskId)).task;
  const reopened=await workflow.execute(principal(actor),{type:"task.reopen",projectId,operationId:randomUUID(),taskId,
    expectedVersion:beforeMove.version,reason:"Plan a separate goal after the fixed delivery"});
  assert.equal(reopened.status,"applied");
  const moved=await workflow.execute(principal(actor),{type:"task.update",projectId,operationId:randomUUID(),taskId,
    expectedVersion:reopened.version,title:beforeMove.title,content:beforeMove.content,acceptance:beforeMove.acceptance,
    owner:beforeMove.owner,stageId:foreignStageId,reason:"Explicitly bind current Task to another Goal and Stage"});
  assert.equal(moved.status,"applied",JSON.stringify(moved));
  assert.equal((await workflow.getTask(principal(actor),projectId,taskId)).proposal?.stageId,foreignStageId);
  const restarted=await workflow.execute(principal(actor),{type:"task.start",projectId,operationId:randomUUID(),taskId,
    expectedVersion:moved.version,reason:"Continue current Task under the other Goal"});
  assert.equal(restarted.status,"applied",JSON.stringify(restarted));
  const foreignLoopId=randomUUID();
  const beforeHistoricalObservation=(await pool.query("SELECT created_at,event_id FROM outbox_event WHERE project_id=$1 ORDER BY created_at DESC,event_id DESC LIMIT 1",[projectId])).rows[0];
  await issue(actor,{type:"loop.enroll",loopId:foreignLoopId,goalId:foreignGoalId,stageId:foreignStageId,
    cognitiveRoleId:cognitiveRole,allowedBusinessRoleIds:[businessRole],
    sourceAfter:{createdAtUtc:beforeHistoricalObservation.created_at.toISOString(),eventId:beforeHistoricalObservation.event_id},
    maxRuns:1,maxConcurrent:1,reason:"Check historical source stays with original Goal"});
  const afterMoveObservation=await observationSource("consumer-after-move","notUsed");
  const fixedAfterMove=await store.transaction(projectId,tx=>tx.getObservationFact(afterMoveObservation.observationId));
  assert.equal(fixedAfterMove?.taskRevisionId,(await store.transaction(projectId,tx=>tx.getDeliveryFact(delivery.revisionId!)))?.taskRevisionId);
  assert.equal(fixedAfterMove?.stageId,stageId,"observation follows the Delivery's historical Stage");
  assert.equal((await orchestrator.listSourceFacts(principal(actor),projectId,loopId)).items.some(x=>x.id===afterMoveObservation.sourceId),true);
  assert.ok((await issue(actor,{type:"inbox.accept",loopId,sourceEventId:afterMoveObservation.sourceId,
    recipientRoleId:cognitiveRole,purpose:"cognitive_review"})).entityId);
  assert.equal((await orchestrator.listSourceFacts(principal(actor),projectId,foreignLoopId)).items.some(x=>x.id===afterMoveObservation.sourceId),false);
  await fails(issue(actor,{type:"inbox.accept",loopId:foreignLoopId,sourceEventId:afterMoveObservation.sourceId,
    recipientRoleId:cognitiveRole,purpose:"cognitive_review"}),"SOURCE_UNAVAILABLE");
  const unscopedIssueId=randomUUID(),unscopedOp=randomUUID();
  assert.equal((await workflow.execute(principal("issue-reporter"),{type:"document.create",projectId,
    operationId:unscopedOp,documentId:unscopedIssueId,kind:"issue",title:"Unscoped note",body:"# Unscoped issue"})).status,"applied");
  const unscopedEvent=(await pool.query("SELECT event_id FROM outbox_event WHERE project_id=$1 AND operation_id=$2 AND kind='document'",[projectId,unscopedOp])).rows[0]?.event_id;
  assert.ok(unscopedEvent);
  assert.equal((await orchestrator.listSourceFacts(principal(actor),projectId,loopId)).items.some(x=>x.id===unscopedEvent),false);
  await fails(issue(actor,{type:"inbox.accept",loopId,sourceEventId:unscopedEvent,
    recipientRoleId:cognitiveRole,purpose:"cognitive_review"}),"SOURCE_UNAVAILABLE");
  const issueId=randomUUID(),issueOp=randomUUID();
  const issueCreated=await workflow.execute(principal("issue-reporter"),{type:"document.create",projectId,
    operationId:issueOp,documentId:issueId,kind:"issue",title:"Failed preflight report",body:"# Original failed preflight",
    origin:{taskId,runId}});
  assert.equal(issueCreated.status,"applied",JSON.stringify(issueCreated));
  const originalIssue=await workflow.getDocument(principal(actor),projectId,issueId);
  assert.deepEqual(originalIssue.document.origin,{taskId,runId,taskRevisionId:run.revisionId});
  const issueEvent=(await pool.query("SELECT event_id FROM outbox_event WHERE project_id=$1 AND operation_id=$2 AND kind='document'",[projectId,issueOp])).rows[0]?.event_id;
  assert.ok(issueEvent);
  const issueSource=(await store.transaction(projectId,tx=>tx.getSourceFact(issueEvent)))!;
  assert.equal(issueSource.issueRevisionId,issueCreated.revisionId);
  assert.equal(issueSource.issueContentHash,sha("# Original failed preflight"));
  const amendedIssue=await workflow.execute(principal("issue-reporter"),{type:"document.revise",projectId,
    operationId:randomUUID(),documentId:issueId,expectedVersion:1,body:"# Later detail",reason:"Further detail"});
  assert.equal(amendedIssue.status,"applied");
  assert.equal((await store.transaction(projectId,tx=>tx.getIssueFact(issueId,issueCreated.revisionId!)))?.contentHash,
    sha("# Original failed preflight"),"the first issue revision stays fixed after later edits");
  assert.equal((await orchestrator.listSourceFacts(principal(actor),projectId,loopId)).items.some(x=>x.id===issueEvent),true);
  assert.equal((await orchestrator.listSourceFacts(principal(actor),projectId,foreignLoopId)).items.some(x=>x.id===issueEvent),false);
  await fails(issue(actor,{type:"inbox.accept",loopId:foreignLoopId,sourceEventId:issueEvent,
    recipientRoleId:cognitiveRole,purpose:"cognitive_review"}),"SOURCE_UNAVAILABLE");
  const issueInbox=await issue(actor,{type:"inbox.accept",loopId,sourceEventId:issueEvent,
    recipientRoleId:cognitiveRole,purpose:"cognitive_review"});
  assert.equal((await issue(actor,{type:"inbox.accept",loopId,sourceEventId:issueEvent,
    recipientRoleId:cognitiveRole,purpose:"cognitive_review"})).entityId,issueInbox.entityId);
  const reportId=randomUUID(),reportOp=randomUUID();
  assert.equal((await workflow.execute(principal("issue-reporter"),{type:"document.create",projectId,
    operationId:reportOp,documentId:reportId,kind:"report",title:"Delivery report",body:"# Report",origin:{taskId,runId}})).status,"applied");
  const reportEvent=(await pool.query("SELECT event_id FROM outbox_event WHERE project_id=$1 AND operation_id=$2 AND kind='document'",[projectId,reportOp])).rows[0]?.event_id;
  assert.equal((await orchestrator.listSourceFacts(principal(actor),projectId,loopId)).items.some(x=>x.id===reportEvent),false);
  await fails(issue(actor,{type:"inbox.accept",loopId,sourceEventId:reportEvent,
    recipientRoleId:cognitiveRole,purpose:"cognitive_review"}),"SOURCE_UNAVAILABLE");
  const mismatchIssue=await workflow.execute(principal("issue-reporter"),{type:"document.create",projectId,
    operationId:randomUUID(),documentId:randomUUID(),kind:"issue",title:"Wrong Run",body:"# Invalid",
    origin:{taskId:foreignTaskId,runId}});
  assert.equal(mismatchIssue.status,"rejected");
  assert.equal(mismatchIssue.code,"ORIGIN_MISMATCH");
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
    maxRuns:2,maxConcurrent:1,reason:"Terminal first-intent rejection and recovery"});
  const lateLoop=(await orchestrator.getLoop(principal(actor),projectId,lateLoopId))!;
  await fails(issue(actor,{type:"inbox.accept",loopId:lateLoopId,sourceEventId:external.sourceId,recipientRoleId:cognitiveRole,purpose:"cognitive_review"}),"SOURCE_UNAVAILABLE");
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
  await fails(issue(actor,{type:"dispatch.gap",dispatchId:lateDispatch.entityId,expectedVersion:4,
    reason:"Worker intent gap: not terminal",evidenceRef:null}),"RUN_NOT_TERMINAL");
  await runtime.rejectDispatch(projectId,lateRunId,"Fixture terminal before first intent");
  await fails(issue(actor,{type:"worker.submit",submissionId:randomUUID(),dispatchId:lateDispatch.entityId,runId:lateRunId,
    taskRevisionId:lateRun.revisionId,runInputHash:sha("Reject late first submission"),deliveryOperationId:randomUUID(),
    deliveryIntent:cognitiveIntent,agentObservation:"Late intent",evidenceRefs:[]}),"RUN_NOT_ACTIVE");
  const gap=await issue(actor,{type:"dispatch.gap",dispatchId:lateDispatch.entityId,expectedVersion:4,
    reason:"Worker intent gap: absent",evidenceRef:null});
  assert.equal(gap.version,5);
  const gapEvent=(await pool.query("SELECT event_id,detail FROM orchestration_event WHERE project_id=$1 AND operation_id IN (SELECT operation_id FROM orchestration_operation WHERE project_id=$1 AND result->>'entityId'=$2) AND kind='dispatch.gap'",[projectId,lateDispatch.entityId])).rows[0];
  assert.ok(gapEvent);
  assert.equal(gapEvent.detail.runId,lateRunId);
  assert.equal(gapEvent.detail.taskVersion,2);
  const gapSource=(await store.transaction(projectId,tx=>tx.getSourceFact(gapEvent.event_id)))!;
  assert.equal(gapSource.gapRunId,lateRunId);
  assert.equal(gapSource.subjectVersion,5);
  await fails(issue(actor,{type:"dispatch.gap",dispatchId:lateDispatch.entityId,expectedVersion:5,
    reason:"Worker intent gap: duplicate",evidenceRef:null}),"GAP_RECORDED");
  const lateTaskBeforeMove=(await workflow.getTask(principal(actor),projectId,lateTaskId)).task;
  const lateReopen=await workflow.execute(principal(actor),{type:"task.reopen",projectId,operationId:randomUUID(),taskId:lateTaskId,
    expectedVersion:lateTaskBeforeMove.version,reason:"Later work belongs to another Goal"});
  assert.equal(lateReopen.status,"applied",JSON.stringify(lateReopen));
  const lateMove=await workflow.execute(principal(actor),{type:"task.update",projectId,operationId:randomUUID(),taskId:lateTaskId,
    expectedVersion:lateReopen.version,title:lateTaskBeforeMove.title,content:lateTaskBeforeMove.content,
    acceptance:lateTaskBeforeMove.acceptance,owner:lateTaskBeforeMove.owner,stageId:foreignStageId,
    reason:"Move future work without rewriting failed Run scope"});
  assert.equal(lateMove.status,"applied",JSON.stringify(lateMove));
  assert.equal((await store.transaction(projectId,tx=>tx.getTaskScopeAtVersion(lateTaskId,2)))?.stageId,stageId);
  assert.equal((await orchestrator.listSourceFacts(principal(actor),projectId,lateLoopId)).items.some(x=>x.id===gapEvent.event_id),true);
  assert.equal((await orchestrator.listSourceFacts(principal(actor),projectId,foreignLoopId)).items.some(x=>x.id===gapEvent.event_id),false);
  await fails(issue(actor,{type:"inbox.accept",loopId:foreignLoopId,sourceEventId:gapEvent.event_id,
    recipientRoleId:cognitiveRole,purpose:"cognitive_review"}),"SOURCE_UNAVAILABLE");
  const recoveryInbox=await issue(actor,{type:"inbox.accept",loopId:lateLoopId,sourceEventId:gapEvent.event_id,
    recipientRoleId:cognitiveRole,purpose:"cognitive_review"});
  assert.equal((await issue(actor,{type:"inbox.accept",loopId:lateLoopId,sourceEventId:gapEvent.event_id,
    recipientRoleId:cognitiveRole,purpose:"cognitive_review"})).entityId,recoveryInbox.entityId);
  await issue(actor,{type:"inbox.ack",inboxId:recoveryInbox.entityId,expectedVersion:1,reason:"Review real terminal gap"});
  const recoveryTaskId=randomUUID();
  const recoveryTask=await workflow.execute(principal(actor),{type:"task.create",projectId,operationId:randomUUID(),
    taskId:recoveryTaskId,stageId,title:"Review missing signed intent",content:"# Verify original Run and decide next action",
    acceptance:"Record an evidenced next decision",owner:cognitiveRole,consumer:"owner",evidence:`Gap ${gapEvent.event_id}`,
    stopCondition:"A decision is recorded"});
  assert.equal(recoveryTask.status,"applied",JSON.stringify(recoveryTask));
  const recoveryDispatch=await issue(actor,{type:"dispatch.request",inboxId:recoveryInbox.entityId,expectedInboxVersion:2,
    dispatchId:randomUUID(),parentDispatchId:null,taskId:recoveryTaskId,expectedTaskVersion:1,
    recipientRoleId:cognitiveRole,purpose:"cognition",authorizationScopeId:cognitiveScope,reason:"Review fixed terminal gap"});
  assert.equal((await orchestrator.getDispatch(principal(actor),projectId,recoveryDispatch.entityId))?.state,"pending");
  assert.equal((await orchestrator.getDispatch(principal(actor),projectId,lateDispatch.entityId))?.state,"accepted");
  assert.equal((await orchestrator.listDispatches(principal(actor),projectId,loopId)).items.find(x=>x.id===requested.entityId)?.runtimeRunId,runId);
  await issue(actor,{type:"loop.state",loopId,expectedVersion:5,state:"stopped",reason:"Stop bounded work"});
  await fails(issue(actor,{type:"inbox.accept",loopId,sourceEventId:loop.bootstrapEventId,recipientRoleId:cognitiveRole,purpose:"cognitive_review"}),"LOOP_STOPPED");
  assert.equal((await pool.query("SELECT count(*)::int n FROM orchestration_operation WHERE project_id=$1 AND operation_id=$2",[projectId,op])).rows[0].n,1);
  // A new trial Role is proposed through the existing Role contract. The separate
  // delegation template grants only one bounded allocation for this Goal/Loop/Task.
  const newRoleId=randomUUID(),divisionTaskId=randomUUID(),materialId=randomUUID(),materialBody="# Observed division gap";
  assert.equal((await workflow.execute(principal(actor),{type:"task.create",projectId,operationId:randomUUID(),
    taskId:divisionTaskId,stageId,title:"Trial first Task",content:"# One bounded trial",acceptance:"Record one result",
    owner:cognitiveRole,consumer:"owner",evidence:"Observed division gap",stopCondition:"One trial"})).status,"applied");
  assert.equal((await workflow.execute(principal(actor),{type:"task.start",projectId,operationId:randomUUID(),
    taskId:divisionTaskId,expectedVersion:1,reason:"Freeze trial input"})).status,"applied");
  const material=await workflow.execute(principal(actor),{type:"document.create",projectId,operationId:randomUUID(),
    documentId:materialId,kind:"report",title:"Fixed division diagnosis",body:materialBody});
  assert.equal(material.status,"applied");
  const observedAtUtc=new Date().toISOString();
  const proposal={title:"Bounded diagnosis role",goal:"Resolve one observed gap",independentResponsibility:"Diagnose one recurring error",
    ownerScope:"One trial Task",inputs:["Fixed source"],writableAssets:[],deliverables:["Trial result"],
    triggers:["Observed repeat"],workflow:"Inspect fixed materials, then deliver",handoffBoundary:"Return to existing owner",
    evidence:[{kind:"backlog",observation:"One unhandled gap",sourceRef:`task:${divisionTaskId}`,observedAtUtc},
      {kind:"effect",observation:"Current path delayed",sourceRef:`task:${divisionTaskId}`,observedAtUtc},
      {kind:"cost",observation:"One review and handoff",sourceRef:`task:${divisionTaskId}`,observedAtUtc}],
    alternatives:[{kind:"method",assessment:"Could adjust current method",estimatedCost:"One change"},
      {kind:"knowledge",assessment:"Could revise guide",estimatedCost:"One revision"},
      {kind:"another-instance",assessment:"Could add capacity",estimatedCost:"One instance"},
      {kind:"temporary-assignment",assessment:"Could assign a specialist",estimatedCost:"One trial"}],
    firstTaskId:divisionTaskId,baseline:"Current task delayed",expectedEffect:"One bounded result",costLimit:"One trial",
    trialDays:7,reviewAtUtc:new Date(Date.now()+86_400_000).toISOString(),exitCriteria:"Review first result"};
  const proposed=await workflow.execute(principal(actor),{type:"role.propose",projectId,operationId:randomUUID(),roleId:newRoleId,proposal});
  assert.equal(proposed.status,"applied",JSON.stringify(proposed));
  const acceptedRole=await workflow.execute(principal(actor),{type:"role.decide",projectId,operationId:randomUUID(),
    roleId:newRoleId,expectedVersion:1,decision:"accept-trial",reason:"Bounded Role trial"});
  assert.equal(acceptedRole.status,"applied",JSON.stringify(acceptedRole));
  const template:DelegationTemplate={id:randomUUID(),revision:1,projectId,goalId,loopId:lateLoopId,
    existingRoleIds:[],newRoleAllocation:{maxTotal:1,requiredState:"trial"},firstTaskId:divisionTaskId,
    actorId:"trial-worker",authorizationScopeId:"trial-scope",decisionActorIds:[actor],allowedChoices:["new-role"],
    cwd:"/tmp",model:"test-model",sandbox:"read-only",networkAccess:false,approvalPolicy:"on-request",
    expiresAtUtc:new Date(Date.now()+86_400_000).toISOString()};
  const templateHash=sha(JSON.stringify(template));
  let templateCurrent=true;
  const division=new OrchestrationService({store,now:()=>new Date().toISOString(),nextId:randomUUID,hash:sha,
    getDelegationTemplate:async(project,id)=>templateCurrent&&project===projectId&&id===template.id?{template,hash:templateHash}:null});
  const beforeDivision=(await division.getLoop(principal(actor),projectId,lateLoopId))!;
  const decisionOperationId=randomUUID(),decision={type:"division.decide",projectId,operationId:decisionOperationId,
    decisionId:randomUUID(),loopId:lateLoopId,expectedLoopVersion:beforeDivision.version,
    sourceEventId:lateLoop.bootstrapEventId,parentDispatchId:lateDispatch.entityId,
    documentId:materialId,documentRevisionId:material.revisionId,documentContentHash:sha(materialBody),
    firstTaskId:divisionTaskId,expectedFirstTaskVersion:2,choice:"new-role",roleId:newRoleId,
    templateId:template.id,templateRevision:template.revision,templateHash,reason:"One explicitly bounded trial"};
  const decided=await division.execute(principal(actor),decision as never);
  assert.equal(decided.entityType,"binding");
  assert.equal((await division.execute(principal(actor),decision as never)).replayed,true);
  await fails(division.execute(principal(actor),{...decision,reason:"changed"} as never),"OPERATION_CONFLICT");
  const afterDivision=(await division.getLoop(principal(actor),projectId,lateLoopId))!;
  assert.equal(afterDivision.dispatchCount,beforeDivision.dispatchCount);
  assert.equal(afterDivision.maxRuns,beforeDivision.maxRuns);
  assert.equal((await division.getBinding(principal(actor),projectId,decided.entityId))?.grant.newRoleAllocation?.maxTotal,1);
  const divisionPolicy=(await division.getPolicy(principal(actor),projectId,afterDivision.currentPolicyRevisionId!))!;
  assert.equal(divisionPolicy.bindingByRole[newRoleId],decided.entityId);
  const rejectsSql=async(run:(client:pg.PoolClient)=>Promise<unknown>)=>assert.rejects(async()=>{
    const client=await pool.connect();await client.query("BEGIN");
    try { await run(client);await client.query("SET CONSTRAINTS ALL IMMEDIATE"); }
    finally { await client.query("ROLLBACK");client.release(); }
  });
  const unrelatedOperation=(await pool.query("SELECT operation_id FROM orchestration_operation WHERE project_id=$1 AND result->>'entityType'='dispatch' LIMIT 1",[projectId])).rows[0].operation_id;
  await rejectsSql(client=>client.query(`INSERT INTO runtime_role_binding(project_id,binding_id,loop_id,goal_id,role_id,choice,
    template_id,template_revision,template_hash,decision_operation_id,source_event_id,parent_dispatch_id,
    first_task_id,first_task_version,document_id,document_revision_id,document_content_hash,data)
    SELECT project_id,$1,loop_id,goal_id,role_id,choice,template_id,template_revision,template_hash,$2,
      source_event_id,parent_dispatch_id,first_task_id,first_task_version,document_id,document_revision_id,
      document_content_hash,jsonb_set(data,'{id}',to_jsonb($1::text))
    FROM runtime_role_binding WHERE project_id=$3 AND binding_id=$4`,[randomUUID(),unrelatedOperation,projectId,decided.entityId]));
  await rejectsSql(client=>client.query(`INSERT INTO loop_policy_revision(project_id,policy_id,loop_id,version,
    previous_policy_id,allowed_business_role_ids,binding_by_role,changed_binding_id,decision_operation_id,
    actor_id,created_at_utc,data) SELECT project_id,$1,loop_id,version+1,policy_id,
    (SELECT coalesce(jsonb_agg(value),'[]'::jsonb) FROM jsonb_array_elements(allowed_business_role_ids) value WHERE value #>> '{}'<>$2),
    binding_by_role-$2,$3,$4,$5,now(),jsonb_build_object('allowedBusinessRoleIds',to_jsonb(ARRAY[$2]))
    FROM loop_policy_revision WHERE project_id=$6 AND policy_id=$7`,
    [randomUUID(),newRoleId,decided.entityId,decisionOperationId,actor,projectId,divisionPolicy.id]));
  const sqlTaskId=randomUUID();
  assert.equal((await workflow.execute(principal(actor),{type:"task.create",projectId,operationId:randomUUID(),
    taskId:sqlTaskId,stageId,title:"SQL provenance fixture",content:"# Bounded",acceptance:"Check",owner:businessRole,
    consumer:"owner",evidence:"Fixture",stopCondition:"One check"})).status,"applied");
  assert.equal((await workflow.execute(principal(actor),{type:"task.start",projectId,operationId:randomUUID(),
    taskId:sqlTaskId,expectedVersion:1,reason:"Fix observed version"})).status,"applied");
  const otherGoalId=randomUUID();
  assert.equal((await workflow.execute(principal(actor),{type:"goal.create",projectId,operationId:randomUUID(),
    goalId:otherGoalId,outcome:"Unrelated",constraints:"Local",consumer:"owner",authority:"reviewer",scope:"pilot",owner:actor})).status,"applied");
  const originalBinding=(await division.getBinding(principal(actor),projectId,decided.entityId))!;
  const insertSignedFixture=async(client:pg.PoolClient,
    change:(b:typeof originalBinding,op:Record<string,unknown>,event:Record<string,unknown>)=>void=()=>{},
    changeData:(data:typeof originalBinding)=>void=()=>{})=>{
    const id=randomUUID(),operationId=randomUUID(),templateId=randomUUID(),createdAtUtc=new Date().toISOString();
    const binding={...structuredClone(originalBinding),id,choice:"same-role-instance" as const,decisionOperationId:operationId,
      firstTaskId:sqlTaskId,firstTaskVersion:2,template:{...originalBinding.template,id:templateId},
      grant:{...originalBinding.grant,id:templateId,firstTaskId:sqlTaskId,existingRoleIds:[newRoleId],
        newRoleAllocation:null,allowedChoices:["same-role-instance"]},createdAtUtc};
    const operation:Record<string,unknown>={entityType:"binding",entityId:id,version:1,replayed:false};
    const detail:Record<string,unknown>={choice:binding.choice,sourceEventId:binding.sourceEventId,
      parentDispatchId:binding.parentDispatchId,firstTaskId:binding.firstTaskId,firstTaskVersion:binding.firstTaskVersion,
      documentId:binding.documentId,documentRevisionId:binding.documentRevisionId,
      documentContentHash:binding.documentContentHash,roleId:binding.roleId,template:binding.template,
      policyRevisionId:randomUUID()};
    change(binding,operation,detail);
    const bindingData=structuredClone(binding);changeData(bindingData);
    await client.query("INSERT INTO orchestration_operation(project_id,operation_id,actor_id,command_hash,result,created_at_utc) VALUES($1,$2,$3,$4,$5::jsonb,$6)",
      [projectId,operationId,actor,sha(operationId),JSON.stringify(operation),createdAtUtc]);
    await client.query(`INSERT INTO runtime_role_binding(project_id,binding_id,loop_id,goal_id,role_id,choice,
      template_id,template_revision,template_hash,decision_operation_id,source_event_id,parent_dispatch_id,
      first_task_id,first_task_version,document_id,document_revision_id,document_content_hash,data)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18::jsonb)`,
      [projectId,binding.id,binding.loopId,binding.goalId,binding.roleId,binding.choice,binding.template.id,
        binding.template.revision,binding.template.hash,binding.decisionOperationId,binding.sourceEventId,
        binding.parentDispatchId,binding.firstTaskId,binding.firstTaskVersion,binding.documentId,
        binding.documentRevisionId,binding.documentContentHash,JSON.stringify(bindingData)]);
    await client.query(`INSERT INTO orchestration_event(project_id,event_id,loop_id,entity_type,entity_id,operation_id,
      kind,actor_id,detail,created_at_utc) VALUES($1,$2,$3,'binding',$4,$5,'division.decided',$6,$7::jsonb,$8)`,
      [projectId,randomUUID(),binding.loopId,binding.id,operationId,actor,JSON.stringify(detail),createdAtUtc]);
  };
  const allowsSql=async(run:(client:pg.PoolClient)=>Promise<unknown>)=>{
    const client=await pool.connect();await client.query("BEGIN");
    try {await run(client);await client.query("SET CONSTRAINTS ALL IMMEDIATE");}
    finally {await client.query("ROLLBACK");client.release();}
  };
  await allowsSql(client=>insertSignedFixture(client));
  await rejectsSql(client=>insertSignedFixture(client,()=>{},data=>{data.roleId=businessRole;}));
  await rejectsSql(client=>insertSignedFixture(client,b=>{b.runtime.cwd="/tmp/wider";}));
  await rejectsSql(client=>insertSignedFixture(client,(_b,op)=>{op.entityType="dispatch";}));
  await rejectsSql(client=>insertSignedFixture(client,(b)=>{b.decidedBy="forged-actor";}));
  await rejectsSql(client=>insertSignedFixture(client,(b,_op,event)=>{b.parentDispatchId=cognition.entityId;event.parentDispatchId=b.parentDispatchId;}));
  await rejectsSql(client=>insertSignedFixture(client,(b)=>{b.goalId=otherGoalId;b.grant.goalId=b.goalId;}));
  await rejectsSql(client=>insertSignedFixture(client,(b,_op,event)=>{b.firstTaskVersion=99;event.firstTaskVersion=99;}));
  await rejectsSql(client=>insertSignedFixture(client,(b,_op,event)=>{b.documentContentHash="0".repeat(64);event.documentContentHash=b.documentContentHash;}));
  const insertRevokeFixture=async(client:pg.PoolClient,resultType="binding")=>{
    const policyId=randomUUID(),operationId=randomUUID(),createdAtUtc=new Date().toISOString();
    const policy={...divisionPolicy,id:policyId,version:divisionPolicy.version+1,previousId:divisionPolicy.id,
      allowedBusinessRoleIds:divisionPolicy.allowedBusinessRoleIds.filter(role=>role!==newRoleId),
      bindingByRole:{},changedBindingId:decided.entityId,decisionOperationId:operationId,actorId:actor,createdAtUtc};
    await client.query("INSERT INTO orchestration_operation(project_id,operation_id,actor_id,command_hash,result,created_at_utc) VALUES($1,$2,$3,$4,$5::jsonb,$6)",
      [projectId,operationId,actor,sha(operationId),JSON.stringify({entityType:resultType,entityId:decided.entityId,version:2,replayed:false}),createdAtUtc]);
    await client.query(`INSERT INTO loop_policy_revision(project_id,policy_id,loop_id,version,previous_policy_id,
      allowed_business_role_ids,binding_by_role,changed_binding_id,decision_operation_id,actor_id,created_at_utc,data)
      VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9,$10,$11,$12::jsonb)`,
      [projectId,policy.id,policy.loopId,policy.version,policy.previousId,JSON.stringify(policy.allowedBusinessRoleIds),
        JSON.stringify(policy.bindingByRole),policy.changedBindingId,policy.decisionOperationId,policy.actorId,createdAtUtc,JSON.stringify(policy)]);
    await client.query(`INSERT INTO orchestration_event(project_id,event_id,loop_id,entity_type,entity_id,operation_id,
      kind,actor_id,detail,created_at_utc) VALUES($1,$2,$3,'binding',$4,$5,'division.revoked',$6,$7::jsonb,$8)`,
      [projectId,randomUUID(),lateLoopId,decided.entityId,operationId,actor,
        JSON.stringify({policyRevisionId:policyId,reason:"Fixture"}),createdAtUtc]);
  };
  await allowsSql(client=>insertRevokeFixture(client));
  await rejectsSql(client=>insertRevokeFixture(client,"dispatch"));
  const pendingInbox=await division.execute(principal(actor),{type:"inbox.accept",projectId,operationId:randomUUID(),
    loopId:lateLoopId,sourceEventId:lateLoop.bootstrapEventId,recipientRoleId:cognitiveRole,purpose:"next_action"});
  await division.execute(principal(actor),{type:"inbox.ack",projectId,operationId:randomUUID(),
    inboxId:pendingInbox.entityId,expectedVersion:1,reason:"Inspect decision"});
  const dynamicRequest={type:"dispatch.request",projectId,operationId:randomUUID(),inboxId:pendingInbox.entityId,
    expectedInboxVersion:2,dispatchId:randomUUID(),parentDispatchId:lateDispatch.entityId,taskId:divisionTaskId,
    expectedTaskVersion:2,recipientRoleId:newRoleId,purpose:"trial first Task",authorizationScopeId:"trial-scope",reason:"Pending continuation"};
  await fails(division.execute(principal(actor),dynamicRequest as never),"RUN_LIMIT");
  // This sealed SQL fixture models a future controlled child dispatch solely to
  // verify the historical query; this first slice still refuses dynamic dispatch.
  const historicalChildId=randomUUID(),historicalOperationId=randomUUID(),historicalEventId=randomUUID();
  const fixtureClient=await pool.connect();
  await fixtureClient.query("BEGIN");
  try {
    const inboxRow=(await fixtureClient.query("SELECT data FROM orchestration_inbox WHERE project_id=$1 AND inbox_id=$2",
      [projectId,pendingInbox.entityId])).rows[0];
    await fixtureClient.query("UPDATE orchestration_inbox SET version=3,state='disposed',data=$3::jsonb WHERE project_id=$1 AND inbox_id=$2",
      [projectId,pendingInbox.entityId,JSON.stringify({...inboxRow.data,version:3,state:"disposed",disposition:"dispatch",dispatchId:historicalChildId})]);
    const childData={projectId,id:historicalChildId,loopId:lateLoopId,inboxId:pendingInbox.entityId,
      sourceEventId:lateLoop.bootstrapEventId,taskId:divisionTaskId,taskVersion:2,
      parentDispatchId:lateDispatch.entityId,recipientRoleId:newRoleId,purpose:"bounded trial",
      authorizationScopeId:"trial-scope",state:"pending",requestedBy:actor,
      policyRevisionId:divisionPolicy.id,bindingId:decided.entityId};
    await fixtureClient.query(`INSERT INTO orchestration_dispatch(project_id,dispatch_id,loop_id,inbox_id,task_id,task_version,version,state,data,policy_revision_id,binding_id)
      VALUES($1,$2,$3,$4,$5,2,1,'pending',$6::jsonb,$7,$8)`,
      [projectId,historicalChildId,lateLoopId,pendingInbox.entityId,divisionTaskId,JSON.stringify(childData),divisionPolicy.id,decided.entityId]);
    await fixtureClient.query("INSERT INTO orchestration_operation(project_id,operation_id,actor_id,command_hash,result,created_at_utc) VALUES($1,$2,$3,$4,$5::jsonb,now())",
      [projectId,historicalOperationId,actor,sha("historical-fixture"),JSON.stringify({entityType:"dispatch",entityId:historicalChildId,version:1,replayed:false})]);
    await fixtureClient.query("INSERT INTO orchestration_event(project_id,event_id,loop_id,entity_type,entity_id,operation_id,kind,actor_id,detail,created_at_utc) VALUES($1,$2,$3,'dispatch',$4,$5,'dispatch.requested',$6,$7::jsonb,now())",
      [projectId,historicalEventId,lateLoopId,historicalChildId,historicalOperationId,actor,
        JSON.stringify({sourceEventId:lateLoop.bootstrapEventId,taskId:divisionTaskId,recipientRoleId:newRoleId})]);
    await fixtureClient.query("COMMIT");
  } catch(error) { await fixtureClient.query("ROLLBACK"); throw error; }
  finally { fixtureClient.release(); }
  const uow = new PostgresUnitOfWork(pool);
  assert.ok(await uow.read(projectId,reader=>reader.getChildHandoffFact(historicalChildId)));
  await division.execute(principal(actor),{type:"division.revoke",projectId,operationId:randomUUID(),loopId:lateLoopId,
    expectedLoopVersion:afterDivision.version,bindingId:decided.entityId,reason:"Withdraw trial authority"});
  assert.equal((await division.getPolicy(principal(actor),projectId,divisionPolicy.id))?.bindingByRole[newRoleId],decided.entityId);
  assert.ok(await uow.read(projectId,reader=>reader.getChildHandoffFact(historicalChildId)),
    "withdrawal cannot erase proof under the dispatch's pinned policy");
  const revokedPolicyId=(await division.getLoop(principal(actor),projectId,lateLoopId))!.currentPolicyRevisionId!;
  await assert.rejects(pool.query(`UPDATE orchestration_dispatch SET policy_revision_id=$3,
    data=jsonb_set(data,'{policyRevisionId}',to_jsonb($3::text)) WHERE project_id=$1 AND dispatch_id=$2`,
    [projectId,historicalChildId,revokedPolicyId]));
  await assert.rejects(pool.query(`UPDATE orchestration_dispatch SET data=jsonb_set(data,'{policyRevisionId}',
    to_jsonb($3::text)) WHERE project_id=$1 AND dispatch_id=$2`,[projectId,historicalChildId,revokedPolicyId]));
  assert.equal((await division.getPolicy(principal(actor),projectId,
    (await division.getLoop(principal(actor),projectId,lateLoopId))!.currentPolicyRevisionId!))?.allowedBusinessRoleIds.includes(newRoleId),false);
  await fails(division.execute(principal(actor),{...dynamicRequest,operationId:randomUUID()} as never),"VERSION_CONFLICT");
  templateCurrent=false;
  await fails(division.execute(principal(actor),{...decision,operationId:randomUUID()} as never),"DELEGATION_DENIED");
  assert.ok(await uow.read(projectId,reader=>reader.getChildHandoffFact(requested.entityId)));
  const historicalPolicyId = (await orchestrator.getDispatch(principal(actor),projectId,requested.entityId))!.policyRevisionId!;
  assert.equal((await pool.query("SELECT division_historical_role_allowed($1,$2,$3) AS yes",[projectId,requested.entityId,"unlisted-role"])).rows[0].yes,false);
  await assert.rejects(pool.query("UPDATE loop_policy_revision SET allowed_business_role_ids='[]'::jsonb WHERE project_id=$1 AND policy_id=$2",[projectId,historicalPolicyId]));
  await assert.rejects(pool.query(`INSERT INTO loop_policy_revision(project_id,policy_id,loop_id,version,previous_policy_id,
    allowed_business_role_ids,binding_by_role,changed_binding_id,decision_operation_id,actor_id,created_at_utc,data)
    SELECT project_id,$1,loop_id,version+1,policy_id,allowed_business_role_ids||to_jsonb('forged-role'::text),
      binding_by_role,$2,$3,'forger',now(),'{}'::jsonb FROM loop_policy_revision WHERE project_id=$4 AND policy_id=$5`,
    [randomUUID(),decided.entityId,randomUUID(),projectId,revokedPolicyId]));
});
test("017 upgrades nonempty preexisting project facts without rewriting them",async()=>{
  const oldSchema=`el_orch_upgrade_${randomUUID().replaceAll("-","").slice(0,12)}`;
  const migrations=fileURLToPath(new URL("../../packages/adapter-postgres/migrations/",import.meta.url));
  const client=new pg.Client({connectionString:url,options:`-c search_path=${oldSchema}`});
  try{
    await runner({databaseUrl:url!,dir:migrations,migrationsTable:"pgmigrations",schema:oldSchema,
      createSchema:true,createMigrationsSchema:true,direction:"up",singleTransaction:true,count:16,log:()=>{}});
    await client.connect();
    const oldProject=randomUUID(),oldGoal=randomUUID(),created="2026-10-22T00:00:00.000Z";
    await client.query("INSERT INTO project(project_id,title,created_at) VALUES($1,'Existing project',$2)",[oldProject,created]);
    await client.query(`INSERT INTO project_goal(project_id,goal_id,version,outcome,constraints,consumer,authority,scope,owner,actor_id,created_at)
      VALUES($1,$2,1,'Original outcome','Original constraints','owner','reviewer','project','owner','migration-test',$3)`,[oldProject,oldGoal,created]);
    // Seed an actual pre-017 Document using its historical table shape. The
    // current adapter targets 017 and must not be invoked against old DDL.
    const oldDoc=randomUUID(),oldRevision=randomUUID(),body="# Preserved original";
    await client.query("BEGIN");
    try {
      await client.query(`INSERT INTO process_document(project_id,document_id,title,version,current_revision_id,adopted_revision_id,kind,status)
        VALUES($1,$2,'Existing report',1,$3,NULL,'report','draft')`,[oldProject,oldDoc,oldRevision]);
      await client.query(`INSERT INTO document_revision(project_id,document_id,revision_id,body,format,content_hash,author,created_at,previous_revision_id,reason)
        VALUES($1,$2,$3,$4,'markdown',$5,'migration-worker',$6,NULL,'Original report')`,[oldProject,oldDoc,oldRevision,body,sha(body),created]);
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    const snapshot=async()=>{const rows=[];for(const table of ["project_goal","task","runtime_session","runtime_run"])
      rows.push((await client.query(`SELECT * FROM ${table} WHERE project_id=$1 ORDER BY 1,2`,[oldProject])).rows);
      rows.push((await client.query("SELECT project_id,document_id,title,version,current_revision_id,adopted_revision_id,kind,status FROM process_document WHERE project_id=$1 ORDER BY document_id",[oldProject])).rows);
      rows.push((await client.query("SELECT project_id,document_id,revision_id,body,content_hash,author FROM document_revision WHERE project_id=$1 ORDER BY document_id,revision_id",[oldProject])).rows);
      return rows;};
    const before=await snapshot();
    await migrate(url!,oldSchema);
    const after=await snapshot();
    assert.deepEqual(after,before);
    assert.equal((await client.query("SELECT count(*)::int n FROM process_document WHERE project_id=$1 AND (origin_task_id IS NOT NULL OR origin_task_revision_id IS NOT NULL OR origin_run_id IS NOT NULL)",[oldProject])).rows[0].n,0);
    const appliedMigrations=(await client.query("SELECT name FROM pgmigrations ORDER BY id")).rows;
    assert.equal(appliedMigrations.filter(row=>row.name.startsWith("017_")).length,1,
      "017 must be applied exactly once while allowing later migrations");
    assert.ok(appliedMigrations.length>=17);
  }finally{
    await client.end().catch(()=>{});
    const cleanup=new pg.Client({connectionString:url});await cleanup.connect();
    try{await cleanup.query(`DROP SCHEMA IF EXISTS "${oldSchema}" CASCADE`);}finally{await cleanup.end();}
  }
});
