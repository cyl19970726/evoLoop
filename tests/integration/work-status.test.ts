import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";
import { WorkflowService } from "@evoloop/core";
import { OrchestrationService } from "@evoloop/core/orchestration";
import { migrate, PostgresUnitOfWork } from "@evoloop/adapter-postgres";
import { PgOrchestrationStore } from "@evoloop/adapter-postgres/orchestration";
import { buildServer } from "../../apps/coordinator/src/server.js";
import { readWorkStatuses } from "../../apps/coordinator/src/orchestration/work-status.js";
import { fixtureRoleId, seedFixtureRole } from "./role-fixture.test.js";

const database=process.env.TEST_DATABASE_URL;
if (!database || !/\/evoloop_[a-z0-9_]*test$/.test(new URL(database).pathname))
  throw new Error("work status requires the isolated evoloop_journey_eval_test database");

test("paged work status uses exact project facts and separates formal cognition from ordinary research",async t=>{
  const schema=`el_workstatus_${randomUUID().replaceAll("-","").slice(0,16)}`;
  await migrate(database!,schema);
  const pool=new pg.Pool({connectionString:database,options:`-c search_path=${schema}`});
  const uow=new PostgresUnitOfWork(pool),hash=(value:string)=>createHash("sha256").update(value).digest("hex");
  const fixedTime="2026-10-23T12:00:00.000Z";
  let idSequence=0xfffffffffffen;
  const nextId=()=>`00000000-0000-4000-8000-${(idSequence--).toString(16).padStart(12,"0")}`;
  const workflow=new WorkflowService({uow,clock:{now:()=>fixedTime},ids:{next:nextId},hasher:{hash}});
  const projectId=randomUUID(),otherProjectId=randomUUID(),goalId=randomUUID(),stageId=randomUUID();
  const cognitionId=randomUUID(),researchId=randomUUID(),loopId=randomUUID(),ownerId="work-status-owner";
  const plannerRole=fixtureRoleId("planner"), researcherRole=fixtureRoleId("researcher"), builderRole=fixtureRoleId("builder");
  const principal={actorId:ownerId,projectIds:[projectId],permissions:["read","write","review"] as Array<"read"|"write"|"review">};
  const store=new PgOrchestrationStore(pool,{getAuthorizationFact:async(project,scope)=>project===projectId && scope==="fixture-scope" ?
    {projectId,scopeId:scope,actorId:ownerId,roleId:plannerRole,active:true}:null,
    canActAsRole:async()=>true,wasActorRole:async()=>false});
  const orchestration=new OrchestrationService({store,now:()=>new Date().toISOString(),nextId:randomUUID,hash});
  const token=randomUUID()+randomUUID(),otherToken=randomUUID()+randomUUID();
  const app=await buildServer({service:workflow,credentials:[
    {token,actorId:ownerId,projectIds:[projectId],permissions:["read","write","review"]},
    {token:otherToken,actorId:"unrelated",projectIds:[otherProjectId],permissions:["read"]}],
    orchestration:{service:orchestration,workStatuses:(who,p,ids)=>readWorkStatuses(pool,workflow,who,p,ids)}});
  t.after(async()=>{await app.close();await pool.end();const admin=new pg.Client({connectionString:database});
    await admin.connect();try{await admin.query(`DROP SCHEMA "${schema}" CASCADE`);}finally{await admin.end();}});
  const issue=async(command:Record<string,unknown>)=>{
    const result=await workflow.execute(principal,{projectId,operationId:randomUUID(),...command} as never);
    assert.equal(result.status,"applied",JSON.stringify(result));return result as Extract<typeof result,{status:"applied"}>;
  };
  const managed=async(command:Record<string,unknown>)=>orchestration.execute(principal,{projectId,operationId:randomUUID(),...command} as never);
  await issue({type:"project.create",title:"Isolated work status"});
  for (const roleId of [plannerRole,researcherRole,builderRole]) await seedFixtureRole(pool,projectId,roleId);
  await issue({type:"goal.create",goalId,outcome:"交付可核对报告",constraints:"隔离 fixture",consumer:"声明消费者",
    authority:"owner",scope:"fixture",owner:ownerId});
  await issue({type:"stage.propose",stageId,goalId,deliverable:"固定报告",learningQuestion:"是否有实际使用",reason:"Fixture"});
  await issue({type:"stage.accept",stageId,expectedVersion:1,reason:"Activate"});
  await issue({type:"task.create",taskId:cognitionId,stageId,title:"System source record",kind:"research",
    content:"# Formal cognition",acceptance:"One decision",owner:plannerRole,consumer:"声明消费者",
    evidence:"Formal source",stopCondition:"One decision"});
  await issue({type:"task.start",taskId:cognitionId,expectedVersion:1,reason:"Fix cognition"});
  await issue({type:"task.create",taskId:researchId,stageId,title:"Ordinary research",kind:"research",
    content:"# Research",acceptance:"One report",owner:researcherRole,consumer:"声明消费者",useRequired:true,
    evidence:"Delivery and use",stopCondition:"One report"});
  await issue({type:"task.start",taskId:researchId,expectedVersion:1,reason:"Fix research"});
  const last=(await pool.query("SELECT created_at,event_id FROM outbox_event WHERE project_id=$1 ORDER BY created_at DESC,event_id DESC LIMIT 1",[projectId])).rows[0];
  await managed({type:"loop.enroll",loopId,goalId,stageId,cognitiveRoleId:plannerRole,allowedBusinessRoleIds:[builderRole],
    sourceAfter:{createdAtUtc:last.created_at.toISOString(),eventId:last.event_id},maxRuns:1,maxConcurrent:1,reason:"Fixture"});
  const loop=(await orchestration.getLoop(principal,projectId,loopId))!;
  const inbox=await managed({type:"inbox.accept",loopId,sourceEventId:loop.bootstrapEventId,recipientRoleId:plannerRole,purpose:"cognitive_review"});
  await managed({type:"inbox.ack",inboxId:inbox.entityId,expectedVersion:1,reason:"Read source"});
  await managed({type:"dispatch.request",inboxId:inbox.entityId,expectedInboxVersion:2,dispatchId:randomUUID(),
    parentDispatchId:null,taskId:cognitionId,expectedTaskVersion:2,recipientRoleId:plannerRole,purpose:"cognition",
    authorizationScopeId:"fixture-scope",reason:"Plan"});
  const oldDelivery=await issue({type:"delivery.record",taskId:researchId,expectedVersion:2,artifactRef:"fixture:old-report",
    artifactRevision:"v1",contentHash:hash("old report"),technicalResult:"failed",technicalEvidence:"Superseded fixture",
    reason:"Older delivery with the same timestamp"});
  const delivery=await issue({type:"delivery.record",taskId:researchId,expectedVersion:3,artifactRef:"fixture:report",
    artifactRevision:"v2",contentHash:hash("report"),technicalResult:"passed",technicalEvidence:"Fixture",
    reason:"Latest fixed research report"});
  assert.ok(oldDelivery.revisionId > delivery.revisionId,"older delivery ID sorts after the newer one at the same timestamp");
  const consumer={actorId:"声明消费者",projectIds:[projectId],permissions:["read","write"] as Array<"read"|"write">};
  const use=await workflow.execute(consumer,{type:"observation.record",projectId,operationId:randomUUID(),taskId:researchId,
    deliveryId:delivery.revisionId,observer:consumer.actorId,observerKind:"agent",result:"used",
    evidence:"Actual fixture use",reason:"Observed use"});
  assert.equal(use.status,"applied",JSON.stringify(use));
  const endpoint=`/api/projects/${projectId}/orchestration/work-status?taskIds=${cognitionId},${researchId}`;
  const request=(auth:string,path=endpoint)=>app.inject({method:"GET",url:path,headers:{authorization:`Bearer ${auth}`}});
  const response=await request(token);
  assert.equal(response.statusCode,200,response.body);
  const rows=response.json<{items:Array<{taskId:string;cognition:boolean;sourceKind:string|null;goalOutcome:string|null;deliveryId:string|null;
    stageDeliverable:string|null;readyForAcceptance:boolean}>}>().items;
  assert.equal(rows.length,2);
  assert.deepEqual(rows.find(row=>row.taskId===cognitionId) && {
    cognition:rows.find(row=>row.taskId===cognitionId)!.cognition,
    sourceKind:rows.find(row=>row.taskId===cognitionId)!.sourceKind,
    goalOutcome:rows.find(row=>row.taskId===cognitionId)!.goalOutcome,
    stageDeliverable:rows.find(row=>row.taskId===cognitionId)!.stageDeliverable},
  {cognition:true,sourceKind:"loop.enrolled",goalOutcome:"交付可核对报告",stageDeliverable:"固定报告"});
  assert.equal(rows.find(row=>row.taskId===researchId)?.cognition,false,"ordinary research stays in business work");
  assert.equal(rows.find(row=>row.taskId===researchId)?.deliveryId,delivery.revisionId,
    "latest Delivery follows fixed TaskRevision.version rather than timestamp and ID");
  assert.equal(rows.find(row=>row.taskId===researchId)?.readyForAcceptance,true);
  const sessionId=randomUUID(),runId=randomUUID();
  const basis=(await pool.query(`SELECT t.current_revision_id,b.basis_set_id FROM task t
    JOIN basis_set b ON b.project_id=t.project_id AND b.task_id=t.task_id AND b.task_revision_id=t.current_revision_id
    WHERE t.project_id=$1 AND t.task_id=$2`,[projectId,researchId])).rows[0];
  assert.ok(basis,"current Task has a fixed basis for the isolated Run fixture");
  // This fixture models a previously bound owned Session. A reserved Session has
  // no confirmed launch profile and cannot advance a Run into an unknown Turn.
  await pool.query(`INSERT INTO runtime_session(project_id,session_id,role_id,cwd,authorization_scope,sandbox,approval_policy,
    state,version,native_thread_id,native_session_id,operation_id,actor_id,created_at,updated_at)
    VALUES($1,$2,'researcher','/isolated-fixture','fixture','danger-full-access','never','ready',1,$6,$6,$3,$4,$5,$5)`,
    [projectId,sessionId,randomUUID(),ownerId,fixedTime,`fixture-native-${sessionId}`]);
  await pool.query(`INSERT INTO runtime_run(project_id,run_id,task_id,task_revision_id,basis_set_id,session_id,
    operation_id,input,input_hash,state,version,actor_id,created_at,updated_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,'isolated read-projection fixture',$8,'requested',1,$9,$10,$10)`,
    [projectId,runId,researchId,basis.current_revision_id,basis.basis_set_id,sessionId,randomUUID(),hash("fixture"),ownerId,fixedTime]);
  for (const state of ["requested","unknown"] as const) {
    if (state === "unknown") await pool.query("UPDATE runtime_run SET state='unknown',version=2 WHERE project_id=$1 AND run_id=$2",[projectId,runId]);
    const during=(await request(token)).json<{items:Array<{taskId:string;unsettledRunState:string|null;readyForAcceptance:boolean}>}>().items;
    assert.equal(during.find(row=>row.taskId===researchId)?.unsettledRunState,state);
    assert.equal(during.find(row=>row.taskId===researchId)?.readyForAcceptance,false,
      `a ${state} Run blocks readiness even though the old Delivery and use remain`);
  }
  assert.equal((await pool.query('SELECT phase,cause_id FROM session_recovery_gate WHERE project_id=$1 AND session_id=$2',
    [projectId,sessionId])).rows[0]?.phase,'blocked','unknown native outcome keeps the Session recovery gate closed');
  await pool.query("UPDATE runtime_run SET state='completed',version=3,native_turn_id='isolated-fixture-turn' WHERE project_id=$1 AND run_id=$2",[projectId,runId]);
  assert.equal((await pool.query('SELECT phase FROM session_recovery_gate WHERE project_id=$1 AND session_id=$2',
    [projectId,sessionId])).rows[0]?.phase,'blocked','later Run reconciliation does not silently reopen the Session');
  assert.equal((await request(token)).json<{items:Array<{taskId:string;readyForAcceptance:boolean}>}>().items
    .find(row=>row.taskId===researchId)?.readyForAcceptance,true);
  assert.equal((await request(otherToken)).statusCode,403,"another project cannot read the projection");
  assert.equal((await request(token,`${endpoint},${researchId}`)).statusCode,400,"duplicate IDs are rejected");
  await issue({type:"task.close",taskId:researchId,expectedVersion:4,deliveryId:delivery.revisionId,
    acceptanceResult:"met",acceptanceEvidence:"Fixture acceptance",reason:"Accepted"});
  const after=(await request(token)).json<{items:Array<{taskId:string;hasClosure:boolean;readyForAcceptance:boolean}>}>().items;
  assert.equal(after.find(row=>row.taskId===researchId)?.hasClosure,true);
  assert.equal(after.find(row=>row.taskId===researchId)?.readyForAcceptance,false);
});
