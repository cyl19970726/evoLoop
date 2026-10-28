import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";
import { fixtureRoleId, seedFixtureRole } from "./role-fixture.test.js";
import { WorkflowService, RuntimeWorkflowService } from "@evoloop/core";
import { migrate, PostgresUnitOfWork } from "@evoloop/adapter-postgres";
import { PgOrchestrationStore } from "@evoloop/adapter-postgres/orchestration";
import { OrchestrationService, OrchestrationError } from "@evoloop/core/orchestration";


function withPersistedResumeProfile(runtime: RuntimeWorkflowService, uow: PostgresUnitOfWork): RuntimeWorkflowService {
  const bind = runtime.bindSession.bind(runtime);
  runtime.bindSession = async (projectId, sessionId, binding) => {
    const saved = await uow.read(projectId, reader => reader.getRuntimeSession(sessionId));
    const profile = saved?.executionProfile;
    if (!saved || !profile) throw new Error("fixture Session execution profile unavailable");
    return bind(projectId, sessionId, { ...binding, resumeProfile: { actorId: saved.actorId, model: saved.model,
      sandbox: saved.sandbox, approvalPolicy: saved.approvalPolicy, executionProfileRevisionId: profile.revision.revisionId } });
  };
  return runtime;
}
const url=process.env.TEST_DATABASE_URL;
if(!url||!/evoloop.*test/.test(new URL(url).pathname))throw new Error("dedicated evoloop test DB required");
const schema=`el_legacy_gap_${randomUUID().replaceAll("-","").slice(0,16)}`;
const pool=new pg.Pool({connectionString:url,options:`-c search_path=${schema}`});
const projectId=randomUUID(),actor="legacy-gap-reviewer",role=fixtureRoleId("legacy-cognition"),scope="legacy-scope";
const principal={actorId:actor,projectIds:[projectId],permissions:["read","write","review"] as Array<"read"|"write"|"review">};
const hash=(text:string)=>createHash("sha256").update(text).digest("hex");
const uow=new PostgresUnitOfWork(pool);
const workflow=new WorkflowService({uow,clock:{now:()=>new Date().toISOString()},ids:{next:randomUUID},hasher:{hash}});
const runtime=new RuntimeWorkflowService({uow,clock:{now:()=>new Date().toISOString()},ids:{next:randomUUID}});
withPersistedResumeProfile(runtime,uow);
const store=new PgOrchestrationStore(pool,{
  getAuthorizationFact:async(project,scopeId)=>project===projectId&&scopeId===scope?{projectId,scopeId:scope,actorId:actor,roleId:role,active:true}:null,
  canActAsRole:async(project,actorId,roleId)=>project===projectId&&actorId===actor&&roleId===role,
  wasActorRole:async()=>false,
});
const orchestration=new OrchestrationService({store,now:()=>new Date().toISOString(),nextId:randomUUID,hash});
const official=async(command:Record<string,unknown>)=>{
  const result=await workflow.execute(principal,{projectId,operationId:randomUUID(),...command} as never);
  assert.equal(result.status,"applied",JSON.stringify(result));
  return result as Extract<typeof result,{status:"applied"}>;
};
const managed=async(command:Record<string,unknown>)=>orchestration.execute(principal,{projectId,operationId:randomUUID(),...command} as never);

test("old dispatch.gap event without run or task version recovers from immutable Dispatch, Run and operation",async t=>{
  await migrate(url!,schema);
  t.after(async()=>{await pool.end();const client=new pg.Client({connectionString:url});await client.connect();try{await client.query(`DROP SCHEMA "${schema}" CASCADE`);}finally{await client.end();}});
  const goalId=randomUUID(),stageId=randomUUID(),otherGoalId=randomUUID(),otherStageId=randomUUID(),taskId=randomUUID(),loopId=randomUUID();
  await official({type:"project.create",title:"Legacy terminal gap fixture"});
  for (const roleId of [role]) await seedFixtureRole(pool,projectId,roleId);
  for(const id of [goalId,otherGoalId]) await official({type:"goal.create",goalId:id,outcome:"One bounded result",constraints:"Preserve historical scope",consumer:"owner",authority:"reviewer",scope:"local",owner:actor});
  for(const [id,goal] of [[stageId,goalId],[otherStageId,otherGoalId]]){
    await official({type:"stage.propose",stageId:id,goalId:goal,deliverable:"One checked result",learningQuestion:"What happened?",reason:"Bounded stage"});
    await official({type:"stage.accept",stageId:id,expectedVersion:1,reason:"Activate stage"});
  }
  await official({type:"task.create",taskId,stageId,title:"Original Task",content:"# Fixed original work",acceptance:"One result",owner:role,
    consumer:"owner",evidence:"Pending",stopCondition:"One Run"});
  await official({type:"task.start",taskId,expectedVersion:1,reason:"Fix initial Task"});
  const last=(await pool.query("SELECT created_at,event_id FROM outbox_event WHERE project_id=$1 ORDER BY created_at DESC,event_id DESC LIMIT 1",[projectId])).rows[0];
  await managed({type:"loop.enroll",loopId,goalId,stageId,cognitiveRoleId:role,allowedBusinessRoleIds:["legacy-business"],
    sourceAfter:{createdAtUtc:last.created_at.toISOString(),eventId:last.event_id},maxRuns:2,maxConcurrent:1,reason:"Legacy recovery boundary"});
  const loop=(await orchestration.getLoop(principal,projectId,loopId))!;
  const inbox=await managed({type:"inbox.accept",loopId,sourceEventId:loop.bootstrapEventId,recipientRoleId:role,purpose:"cognitive_review"});
  await managed({type:"inbox.ack",inboxId:inbox.entityId,expectedVersion:1,reason:"Review bootstrap"});
  const dispatch=await managed({type:"dispatch.request",inboxId:inbox.entityId,expectedInboxVersion:2,dispatchId:randomUUID(),
    parentDispatchId:null,taskId,expectedTaskVersion:2,recipientRoleId:role,purpose:"cognition",authorizationScopeId:scope,
    reason:"Review fixed Task"});
  const claimToken=randomUUID();
  await managed({type:"dispatch.claim",dispatchId:dispatch.entityId,claimToken,leaseUntilUtc:new Date(Date.now()+60_000).toISOString()});
  await managed({type:"dispatch.start",dispatchId:dispatch.entityId,claimToken});
  const sessionId=randomUUID(),runId=randomUUID();
  await official({type:"runtime.session.reserve",sessionId,roleId:role,cwd:"/tmp/evoloop-legacy-gap-test",authorizationScope:scope,
    model:"fixture",sandbox:"danger-full-access",approvalPolicy:"never"});
  await runtime.beginSessionCreate(projectId,sessionId);
  await runtime.bindSession(projectId,sessionId,{owner:"evoloop-codex-app-server",projectId,sessionId,roleId:role,
    cwd:"/tmp/evoloop-legacy-gap-test",authorizationScope:scope,nativeThreadId:`fixture-${sessionId}`,nativeSessionId:`fixture-${sessionId}`});
  await official({type:"runtime.run.reserve",runId,taskId,sessionId,expectedVersion:2,input:"Observe one fixed Task"});
  const accepted=await managed({type:"dispatch.resolve",dispatchId:dispatch.entityId,claimToken,result:"accepted",runtimeRunId:runId,
    reason:"Bind formal Run"});
  assert.equal(accepted.version,4);
  await runtime.rejectDispatch(projectId,runId,"Fixture terminal Run without signed worker intent");

  // Recreate only the old serialized gap shape. The historical release emitted no runId/taskVersion in detail.
  // Workflow, Dispatch, Session and Run above were created through their formal services.
  const legacyOperationId=randomUUID(),legacyEventId=randomUUID(),createdAt=new Date().toISOString();
  const gapResult={entityType:"dispatch",entityId:dispatch.entityId,version:5,replayed:false};
  const gapDetail={reason:"Worker intent gap: absent",evidenceRef:null};
  const fixtureClient=await pool.connect();
  await fixtureClient.query("BEGIN");
  try{
    const previous=(await fixtureClient.query("SELECT data FROM orchestration_dispatch WHERE project_id=$1 AND dispatch_id=$2 FOR UPDATE",[projectId,dispatch.entityId])).rows[0].data;
    assert.equal(previous.version,4);
    const next={...previous,version:5,reason:gapDetail.reason,evidenceRef:null,updatedAtUtc:createdAt};
    await fixtureClient.query("UPDATE orchestration_dispatch SET version=5,data=$3::jsonb WHERE project_id=$1 AND dispatch_id=$2",[projectId,dispatch.entityId,JSON.stringify(next)]);
    await fixtureClient.query("INSERT INTO orchestration_operation(project_id,operation_id,actor_id,command_hash,result,created_at_utc) VALUES($1,$2,$3,$4,$5::jsonb,$6)",
      [projectId,legacyOperationId,actor,hash("legacy gap command"),JSON.stringify(gapResult),createdAt]);
    await fixtureClient.query("INSERT INTO orchestration_event(project_id,event_id,loop_id,entity_type,entity_id,operation_id,kind,actor_id,detail,created_at_utc) VALUES($1,$2,$3,'dispatch',$4,$5,'dispatch.gap',$6,$7::jsonb,$8)",
      [projectId,legacyEventId,loopId,dispatch.entityId,legacyOperationId,actor,JSON.stringify(gapDetail),createdAt]);
    await fixtureClient.query("COMMIT");
  }catch(error){await fixtureClient.query("ROLLBACK");throw error;}finally{fixtureClient.release();}
  const beforeMove=await store.transaction(projectId,tx=>tx.getSourceFact(legacyEventId));
  assert.equal(beforeMove?.kind,"dispatch.gap");
  assert.equal(beforeMove.gapRunId,runId);
  assert.equal(beforeMove.gapTaskVersion,2);
  assert.equal(beforeMove.subjectVersion,5,"gap version comes from immutable operation result");
  assert.equal(beforeMove.subjectId,taskId);
  assert.equal(beforeMove.originDispatchId,dispatch.entityId);
  assert.equal((await orchestration.listSourceFacts(principal,projectId,loopId)).items.some(source=>source.id===legacyEventId),true);

  const current=(await workflow.getTask(principal,projectId,taskId)).task;
  const reopened=await official({type:"task.reopen",taskId,expectedVersion:current.version,reason:"Later work moves to another Goal"});
  const moved=await official({type:"task.update",taskId,expectedVersion:reopened.version,title:current.title,content:current.content,
    acceptance:current.acceptance,owner:current.owner,stageId:otherStageId,reason:"Explicitly rebind future Task work"});
  assert.ok(moved.version>2);
  assert.equal((await workflow.getTask(principal,projectId,taskId)).proposal?.stageId,otherStageId);
  assert.equal((await store.transaction(projectId,tx=>tx.getTaskScopeAtVersion(taskId,2)))?.stageId,stageId);
  const afterMove=await store.transaction(projectId,tx=>tx.getSourceFact(legacyEventId));
  assert.equal(afterMove?.gapRunId,runId);
  assert.equal(afterMove?.gapTaskVersion,2);
  assert.equal((await orchestration.listSourceFacts(principal,projectId,loopId)).items.some(source=>source.id===legacyEventId),true);
  const recovery=await managed({type:"inbox.accept",loopId,sourceEventId:legacyEventId,recipientRoleId:role,purpose:"cognitive_review"});
  assert.ok(recovery.entityId);
  assert.equal((await managed({type:"inbox.accept",loopId,sourceEventId:legacyEventId,recipientRoleId:role,purpose:"cognitive_review"})).entityId,recovery.entityId);
  await assert.rejects(managed({type:"inbox.accept",loopId,sourceEventId:legacyOperationId,recipientRoleId:role,purpose:"cognitive_review"}),
    error=>error instanceof OrchestrationError&&error.code==="SOURCE_UNAVAILABLE");
  await managed({type:"inbox.ack",inboxId:recovery.entityId,expectedVersion:1,reason:"Inspect fixed legacy gap"});
  const recoveryTaskId=randomUUID(),recoveryRunId=randomUUID();
  await official({type:"task.create",taskId:recoveryTaskId,stageId,title:"One recovery review",content:"# Diagnose first missing intent",
    acceptance:"Record one recovery decision",owner:role,consumer:"owner",evidence:"Fixed first gap",stopCondition:"One review"});
  await official({type:"task.start",taskId:recoveryTaskId,expectedVersion:1,reason:"Freeze one recovery attempt"});
  const recoveryDispatch=await managed({type:"dispatch.request",inboxId:recovery.entityId,expectedInboxVersion:2,
    dispatchId:randomUUID(),parentDispatchId:null,taskId:recoveryTaskId,expectedTaskVersion:2,
    recipientRoleId:role,purpose:"cognition",authorizationScopeId:scope,reason:"One bounded recovery review"});
  const recoveryClaim=randomUUID();
  await managed({type:"dispatch.claim",dispatchId:recoveryDispatch.entityId,claimToken:recoveryClaim,
    leaseUntilUtc:new Date(Date.now()+60_000).toISOString()});
  await managed({type:"dispatch.start",dispatchId:recoveryDispatch.entityId,claimToken:recoveryClaim});
  const blockedSession=await workflow.getSessionRecovery(principal,projectId,sessionId);
  assert.equal(blockedSession.gate?.phase,"blocked");
  assert.equal(blockedSession.gate?.causeId,runId);
  assert.equal(blockedSession.gate?.causeState,"failed");
  const knownSessionRuns=(await workflow.listRuntimeRuns(principal,projectId)).filter(run=>run.sessionId===sessionId);
  assert.ok(knownSessionRuns.length>0&&knownSessionRuns.every(run=>["completed","failed","interrupted"].includes(run.state)),
    "explicit recovery is allowed only after every Session Run has a known terminal state");
  assert.equal((await workflow.getRuntimeRun(principal,projectId,runId)).state,"failed");
  const resume=await official({type:"runtime.session.recovery.resume",sessionId,expectedVersion:blockedSession.gate!.version,
    expectedCauseId:blockedSession.gate!.causeId!,resumeMessageId:blockedSession.gate!.resumeMessageId,
    evidenceRef:"fixture://verified-terminal-run",reason:"Explicitly resume after reviewing the failed cognition Run"});
  assert.equal(resume.status,"applied",JSON.stringify(resume));
  assert.equal((await workflow.getSessionRecovery(principal,projectId,sessionId)).gate?.phase,"open");
  await official({type:"runtime.run.reserve",runId:recoveryRunId,taskId:recoveryTaskId,sessionId,expectedVersion:2,
    input:"Inspect the first terminal gap"});
  await managed({type:"dispatch.resolve",dispatchId:recoveryDispatch.entityId,claimToken:recoveryClaim,
    result:"accepted",runtimeRunId:recoveryRunId,reason:"Bound recovery Run"});
  await assert.rejects(managed({type:"dispatch.gap",dispatchId:recoveryDispatch.entityId,expectedVersion:4,
    reason:"Not terminal yet",evidenceRef:null}),error=>error instanceof OrchestrationError&&error.code==="RUN_NOT_TERMINAL");
  await runtime.rejectDispatch(projectId,recoveryRunId,"Fixture terminal recovery Run without signed intent");
  await managed({type:"dispatch.gap",dispatchId:recoveryDispatch.entityId,expectedVersion:4,
    reason:"Recovery Run also lacks signed intent",evidenceRef:null});
  const secondGapId=(await pool.query("SELECT event_id FROM orchestration_event WHERE project_id=$1 AND entity_id=$2 AND kind='dispatch.gap'",
    [projectId,recoveryDispatch.entityId])).rows[0]?.event_id;
  assert.ok(secondGapId);
  const autoSources=(await orchestration.listSourceFacts(principal,projectId,loopId)).items;
  assert.equal(autoSources.some(source=>source.id===legacyEventId),true,"initial cognition gap remains discoverable");
  assert.equal(autoSources.some(source=>source.id===secondGapId),false,"gap-derived recovery does not auto-seed another recovery");
  const explicitSecond=await store.transaction(projectId,tx=>tx.getSourceFact(secondGapId));
  assert.equal(explicitSecond?.gapRunId,recoveryRunId,"exact read retains the second immutable gap");
  assert.equal(explicitSecond?.gapTaskVersion,2);
  assert.ok((await managed({type:"inbox.accept",loopId,sourceEventId:secondGapId,recipientRoleId:role,
    purpose:"cognitive_review"})).entityId,"authorized explicit diagnosis remains available");
});
