// Lock order between legacy Schedule materialization (PgSchedulingStore.materialize, its own
// transaction) and project writers. Materialization shares the Role, Stage and Loop rows it
// re-checks, then inserts rows whose project foreign key and leader-work trigger lock the project.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import pg from "pg";
import type { ScheduleDefinition } from "@evoloop/contracts/scheduling";
import { migrate, PostgresUnitOfWork } from "../src/index.ts";
import { PgOrchestrationStore } from "../src/orchestration.ts";
import { PgSchedulingStore } from "../src/scheduling.ts";
import { interleave } from "./lock-order-fixture.ts";

const url = process.env.TEST_DATABASE_URL;
if (!url || !/^evoloop(?:_[a-z0-9]+)*_test$/.test(decodeURIComponent(new URL(url).pathname.slice(1))))
  throw new Error("Scheduling lock tests require a dedicated evoloop test database");
const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
const schema = `el_schedule_lock_${suffix}`;
const options = `-c search_path=${schema} -c lock_timeout=20000`;
const otherApplication = `el_schedule_lock_other_${suffix}`;
const pool = new pg.Pool({ connectionString: url, options });
const otherPool = new pg.Pool({ connectionString: url, options, application_name: otherApplication });
const core = new PostgresUnitOfWork(otherPool);
const orchestration = new PgOrchestrationStore(otherPool, {
  getAuthorizationFact: async () => null, canActAsRole: async () => false, wasActorRole: async () => false,
} as unknown as ConstructorParameters<typeof PgOrchestrationStore>[1]);
const projectId = randomUUID(), goalId = randomUUID(), roleId = randomUUID();
const setupAt = "2026-11-06T00:00:00.000Z", due = "2026-11-07T08:00:00.000Z";

async function inTransaction<T>(run: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try { await client.query("BEGIN"); const result = await run(client); await client.query("COMMIT"); return result; }
  catch (e) { await client.query("ROLLBACK"); throw e; } finally { client.release(); }
}
/** An active Stage, a Loop allowed to use the Role, and a daily managed Schedule targeting both. */
async function managedSchedule(): Promise<{ definition: ScheduleDefinition; stageId: string; loopId: string }> {
  const stageId = randomUUID(), loopId = randomUUID(), policyId = randomUUID();
  await inTransaction(async client => {
    await client.query(`INSERT INTO project_stage(project_id,stage_id,goal_id,version,deliverable,learning_question,state,actor_id,created_at)
      VALUES($1,$2,$3,1,'Deliverable','Question','active','author',$4)`, [projectId, stageId, goalId, setupAt]);
    const loop = { projectId, id: loopId, version: 1, goalId, stageId, bootstrapEventId: randomUUID(), cognitiveRoleId: roleId,
      allowedBusinessRoleIds: [roleId], sourceAfter: null, maxRuns: 10, maxConcurrent: 1, dispatchCount: 0, state: "active",
      enrolledBy: "author", createdAtUtc: setupAt, updatedAtUtc: setupAt, currentPolicyRevisionId: policyId };
    await client.query(`INSERT INTO orchestration_loop(project_id,loop_id,version,state,data,current_policy_revision_id)
      VALUES($1,$2,1,'active',$3::jsonb,$4)`, [projectId, loopId, JSON.stringify(loop), policyId]);
    await client.query(`INSERT INTO loop_policy_revision(project_id,policy_id,loop_id,version,previous_policy_id,
      allowed_business_role_ids,binding_by_role,changed_binding_id,decision_operation_id,actor_id,created_at_utc,data)
      VALUES($1,$2,$3,1,NULL,$4::jsonb,'{}'::jsonb,NULL,NULL,'author',$5::timestamptz,
        jsonb_build_object('projectId',$1::uuid,'id',$2::uuid,'loopId',$3::uuid,'version',1,'previousId',NULL,
          'allowedBusinessRoleIds',$4::jsonb,'bindingByRole','{}'::jsonb,'changedBindingId',NULL,
          'decisionOperationId',NULL,'actorId','author','createdAtUtc',$6::text))`,
      [projectId, policyId, loopId, JSON.stringify([roleId]), setupAt, setupAt]);
  });
  const scheduleId = randomUUID(), revisionId = randomUUID();
  const definition: ScheduleDefinition = { projectId, id: scheduleId, version: 1, currentRevisionId: revisionId,
    state: "active", watermarkUtc: setupAt, revision: { projectId, scheduleId, id: revisionId, version: 1, timezone: "UTC",
      rule: { kind: "daily", localTime: "08:00" }, misfire: { kind: "latest" }, overlap: "queue",
      template: { title: "Managed review", content: "Review the stage", acceptance: "accept", owner: roleId,
        managedTarget: { loopId, stageId } },
      authorization: { scopeId: `schedule:${scheduleId}`, roleId, authorizedBy: "reviewer", expiresAtUtc: null },
      reason: "test", actorId: "reviewer", createdAtUtc: setupAt } };
  await new PgSchedulingStore(pool).create(definition);
  return { definition, stageId, loopId };
}
const materialize = (gated: pg.Pool, definition: ScheduleDefinition) =>
  new PgSchedulingStore(gated).materialize(definition, due, due, "created", "due");
const run = <B>(stopBefore: RegExp, definition: ScheduleDefinition, other: () => Promise<B>, label: string) =>
  interleave({ connectionString: url!, options, observer: pool, otherApplication, labels: ["materialize", label],
    stopBefore: text => stopBefore.test(text), stopped: gated => materialize(gated, definition), other });
async function assertCreated(definition: ScheduleDefinition): Promise<void> {
  const occurrence = await new PgSchedulingStore(pool).getOccurrence(projectId, definition.id, due);
  assert.equal(occurrence?.state, "created");
  const task = await pool.query(`SELECT state FROM task WHERE project_id=$1 AND task_id=$2`, [projectId, occurrence!.taskId]);
  assert.equal(task.rows[0]?.state, "todo");
}

before(async () => {
  await migrate(url!, schema);
  await inTransaction(async client => {
    await client.query(`INSERT INTO project(project_id,title,created_at) VALUES($1,'Schedule lock',$2)`, [projectId, setupAt]);
    await client.query(`INSERT INTO project_goal(project_id,goal_id,version,outcome,constraints,consumer,authority,scope,owner,actor_id,created_at)
      VALUES($1,$2,1,'Outcome','None','consumer','authority','scope','owner','author',$3)`, [projectId, goalId, setupAt]);
    const roleRevision = randomUUID();
    await client.query(`INSERT INTO role_definition(project_id,role_id,version,current_revision_id,state,
      proposed_by,created_at_utc,review_at_utc) VALUES($1,$2,1,$3,'active','author',$4,'2026-12-06T00:00:00.000Z')`,
      [projectId, roleId, roleRevision, setupAt]);
    await client.query(`INSERT INTO role_revision(project_id,role_id,revision_id,version,state,proposal,
      actor_id,reason,created_at_utc,review_at_utc) VALUES($1,$2,$3,1,'active','{}'::jsonb,'author','test',$4,
      '2026-12-06T00:00:00.000Z')`, [projectId, roleId, roleRevision, setupAt]);
  });
});
after(async () => {
  await pool.end(); await otherPool.end();
  const client = new pg.Client({ connectionString: url! }); await client.connect();
  try { await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } finally { await client.end(); }
});

test("materialize sharing the target Loop does not deadlock an Orchestration Loop update", async () => {
  // Orchestration transactions lock the project row FOR UPDATE, then update the Loop. Materialization
  // already shares that Loop row and next needs a key share on the project row for its first insert.
  const { definition, loopId } = await managedSchedule();
  await run(/INSERT INTO process_document/, definition, () => orchestration.transaction(projectId, async tx => {
    const loop = (await tx.getLoop(loopId))!;
    await tx.updateLoop({ ...loop, version: loop.version + 1, updatedAtUtc: due }, loop.version);
  }), "orchestration Loop update");
  await assertCreated(definition);
  const loop = await pool.query(`SELECT version FROM orchestration_loop WHERE project_id=$1 AND loop_id=$2`, [projectId, loopId]);
  assert.equal(loop.rows[0].version, 2);
});

test("materialize sharing the target Stage does not deadlock a core Stage revision", async () => {
  const { definition, stageId } = await managedSchedule();
  await run(/INSERT INTO process_document/, definition, () => core.transaction(projectId, async tx => {
    const stage = (await tx.getStage(stageId))!;
    await tx.updateStage({ ...stage, version: stage.version + 1, actorId: "core", createdAt: due },
      { projectId, stageId, id: randomUUID(), version: stage.version + 1, state: stage.state, deliverable: stage.deliverable,
        learningQuestion: stage.learningQuestion, actorId: "core", reason: "core revise", createdAt: due }, stage.version);
  }), "core Stage revision");
  await assertCreated(definition);
});

test("materialize sharing the owner Role does not deadlock a core Role revision", async () => {
  const { definition } = await managedSchedule();
  await run(/INSERT INTO process_document/, definition, () => core.transaction(projectId, async tx => {
    const role = (await tx.getRole(roleId))!;
    const next = { ...role, version: role.version + 1, currentRevisionId: randomUUID() };
    await tx.advanceRole(next, role.version, { projectId, roleId, id: next.currentRevisionId, version: next.version,
      state: next.state, proposal: role.proposal, actorId: "core", reason: "core revise", createdAtUtc: due,
      reviewAtUtc: role.reviewAtUtc, mergeTargetRoleId: role.mergeTargetRoleId });
  }), "core Role revision");
  await assertCreated(definition);
});

test("materialize holding leader-work does not deadlock a core write that needs it", async () => {
  // Stopped after the trigger-held leader-work lock was taken by its Task document inserts.
  const { definition } = await managedSchedule();
  const documentId = randomUUID(), revisionId = randomUUID();
  await run(/INSERT INTO task\(/, definition, () => core.transaction(projectId, async tx => {
    await tx.insertDocument({ projectId, id: documentId, title: "Core", version: 1, currentRevisionId: revisionId,
      adoptedRevisionId: null, kind: "spec", status: "draft" });
    await tx.insertDocumentRevision({ projectId, documentId, id: revisionId, body: "core", format: "markdown",
      mediaType: "text/markdown", originalName: "core.md", payloadRef: null, entrypoint: null, assetsManifest: [],
      contentHash: "0".repeat(64), author: "core", createdAt: due, previousRevisionId: null, reason: "core" });
  }), "core Document write");
  await assertCreated(definition);
});
