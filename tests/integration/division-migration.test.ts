import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { fixtureRoleId, seedFixtureRole } from "./role-fixture.test.js";
import { runner } from "node-pg-migrate";
import { PostgresUnitOfWork, migrate } from "@evoloop/adapter-postgres";
import { WorkflowService } from "@evoloop/core";

const database=process.env.TEST_DATABASE_URL;
if (!database || !/^\/evoloop(?:_[a-z0-9]+)*_test$/.test(new URL(database).pathname))
  throw new Error("dedicated evoloop_*_test database required");

test("021 pins nonempty static Loop and Dispatch to legacy policy without inventing dynamic grants",async t=>{
  const schema=`division_legacy_${randomUUID().replaceAll("-","").slice(0,12)}`;
  const migrations=fileURLToPath(new URL("../../packages/adapter-postgres/migrations/",import.meta.url));
  await runner({databaseUrl:database!,dir:migrations,migrationsTable:"pgmigrations",schema,
    createSchema:true,createMigrationsSchema:true,direction:"up",singleTransaction:true,count:19,log:()=>{}});
  const pool=new pg.Pool({connectionString:database,options:`-c search_path=${schema}`});
  // Seed with the current writer's nullable domain fields, then remove them so
  // the real migration still starts from the complete historical 019 schema.
  await pool.query("ALTER TABLE task ADD COLUMN domain_id uuid; ALTER TABLE task_revision ADD COLUMN domain_id uuid; ALTER TABLE task_proposal ADD COLUMN acceptance_mode text; ALTER TABLE delivery ADD COLUMN submitted_by_actor_id text; ALTER TABLE document_revision ADD COLUMN organization_review jsonb");
  t.after(async()=>{await pool.end();const admin=new pg.Client({connectionString:database});await admin.connect();
    try{await admin.query(`DROP SCHEMA "${schema}" CASCADE`);}finally{await admin.end();}});
  const projectId=randomUUID(),goalId=randomUUID(),stageId=randomUUID(),taskId=randomUUID(),loopId=randomUUID();
  const inboxId=randomUUID(),dispatchId=randomUUID(),role=fixtureRoleId("legacy-business"),cognition="legacy-cognition";
  const principal={actorId:"migration-reviewer",projectIds:[projectId],permissions:["read","write","review"] as Array<"read"|"write"|"review">};
  const workflow=new WorkflowService({uow:new PostgresUnitOfWork(pool),clock:{now:()=>new Date().toISOString()},
    ids:{next:randomUUID},hasher:{hash:value=>createHash("sha256").update(value).digest("hex")}});
  const issue=async(command:Record<string,unknown>)=>{const r=await workflow.execute(principal,
    {projectId,operationId:randomUUID(),...command} as never);assert.equal(r.status,"applied",JSON.stringify(r));};
  await issue({type:"project.create",title:"Legacy Loop"});
  for (const roleId of [role]) await seedFixtureRole(pool,projectId,roleId);
  await issue({type:"goal.create",goalId,outcome:"One result",constraints:"Bounded",consumer:"owner",authority:"reviewer",scope:"pilot",owner:"reviewer"});
  await issue({type:"stage.propose",stageId,goalId,deliverable:"Result",learningQuestion:"What changed?",reason:"Pilot"});
  await issue({type:"stage.accept",stageId,expectedVersion:1,reason:"Start"});
  await issue({type:"task.create",taskId,stageId,title:"Legacy Task",content:"# Task",acceptance:"Result",owner:role,
    consumer:"owner",evidence:"Pilot",stopCondition:"One result"});
  await issue({type:"task.start",taskId,expectedVersion:1,reason:"Seal"});
  const createdAtUtc="2026-10-24T00:00:00.000Z",sourceEventId=randomUUID();
  const oldLoop={projectId,id:loopId,version:3,goalId,stageId,bootstrapEventId:randomUUID(),cognitiveRoleId:cognition,
    allowedBusinessRoleIds:[role],sourceAfter:{createdAtUtc,eventId:null},maxRuns:5,maxConcurrent:2,
    dispatchCount:2,state:"active",enrolledBy:principal.actorId,createdAtUtc,updatedAtUtc:createdAtUtc};
  const oldInbox={projectId,id:inboxId,version:2,loopId,sourceEventId,recipientRoleId:cognition,purpose:"next_action",
    state:"disposed",disposition:"dispatch",dispatchId,createdAtUtc,updatedAtUtc:createdAtUtc};
  const oldDispatch={projectId,id:dispatchId,version:1,loopId,inboxId,sourceEventId,taskId,taskVersion:2,
    parentDispatchId:randomUUID(),recipientRoleId:role,purpose:"old work",authorizationScopeId:"legacy:scope",
    state:"pending",requestedBy:principal.actorId,createdAtUtc,updatedAtUtc:createdAtUtc};
  const client=await pool.connect();await client.query("BEGIN");
  try {
    await client.query("INSERT INTO orchestration_loop(project_id,loop_id,version,state,data) VALUES($1,$2,3,'active',$3::jsonb)",
      [projectId,loopId,JSON.stringify(oldLoop)]);
    await client.query(`INSERT INTO orchestration_inbox(project_id,inbox_id,loop_id,source_event_id,recipient_role_id,purpose,version,state,data)
      VALUES($1,$2,$3,$4,$5,'next_action',2,'disposed',$6::jsonb)`,[projectId,inboxId,loopId,sourceEventId,cognition,JSON.stringify(oldInbox)]);
    await client.query(`INSERT INTO orchestration_dispatch(project_id,dispatch_id,loop_id,inbox_id,task_id,task_version,version,state,data)
      VALUES($1,$2,$3,$4,$5,2,1,'pending',$6::jsonb)`,[projectId,dispatchId,loopId,inboxId,taskId,JSON.stringify(oldDispatch)]);
    await client.query("COMMIT");
  } catch(error) {await client.query("ROLLBACK");throw error;} finally {client.release();}
  assert.equal((await pool.query("SELECT count(*)::int n FROM task_revision WHERE project_id=$1",[projectId])).rows[0].n>0,true);
  await pool.query("ALTER TABLE task_revision DROP COLUMN domain_id; ALTER TABLE task DROP COLUMN domain_id; ALTER TABLE task_proposal DROP COLUMN acceptance_mode; ALTER TABLE delivery DROP COLUMN submitted_by_actor_id; ALTER TABLE document_revision DROP COLUMN organization_review");
  assert.equal((await pool.query("SELECT count(*)::int n FROM information_schema.columns WHERE table_schema=$1 AND table_name='document_revision' AND column_name='organization_review'",[schema])).rows[0].n,0,"seed-only review column is absent before historical upgrade");
  assert.equal((await pool.query(`SELECT count(*)::int n FROM information_schema.columns WHERE table_schema=$1
    AND table_name IN ('task','task_revision') AND column_name='domain_id'`,[schema])).rows[0].n,0);
  await migrate(database!,schema);
  assert.equal((await pool.query("SELECT count(*)::int n FROM task WHERE project_id=$1 AND domain_id IS NOT NULL",[projectId])).rows[0].n,0);
  assert.equal((await pool.query("SELECT count(*)::int n FROM task_revision WHERE project_id=$1 AND domain_id IS NOT NULL",[projectId])).rows[0].n,0);
  const loop=(await pool.query("SELECT data,current_policy_revision_id FROM orchestration_loop WHERE project_id=$1 AND loop_id=$2",[projectId,loopId])).rows[0];
  const dispatch=(await pool.query("SELECT data,policy_revision_id,binding_id FROM orchestration_dispatch WHERE project_id=$1 AND dispatch_id=$2",[projectId,dispatchId])).rows[0];
  const policy=(await pool.query("SELECT * FROM loop_policy_revision WHERE project_id=$1 AND policy_id=$2",[projectId,loop.current_policy_revision_id])).rows[0];
  assert.equal(loop.data.dispatchCount,2);assert.equal(loop.data.maxRuns,5);assert.equal(loop.data.version,3);
  assert.equal(dispatch.data.sourceEventId,sourceEventId);assert.equal(dispatch.data.parentDispatchId,oldDispatch.parentDispatchId);
  assert.equal(dispatch.policy_revision_id,policy.policy_id);assert.equal(dispatch.binding_id,null);
  assert.deepEqual(policy.allowed_business_role_ids,[role]);assert.deepEqual(policy.binding_by_role,{});
  assert.equal(policy.version,1);assert.equal(policy.decision_operation_id,null);
  assert.equal((await pool.query("SELECT count(*)::int n FROM runtime_role_binding WHERE project_id=$1",[projectId])).rows[0].n,0);
});
