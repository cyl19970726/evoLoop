// Refuses a live or shared PostgreSQL server before this file opens TEST_DATABASE_URL (scripts/lib/database-target.mjs).
import "../../scripts/test-database-guard.mjs";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import pg from "pg";
import { migrate, PostgresUnitOfWork } from "@evoloop/adapter-postgres";
import { WorkflowService } from "@evoloop/core";
import type { Principal } from "@evoloop/contracts";
import { fixtureRoleId, seedFixtureRole } from "./role-fixture.test.js";

const database = process.env.TEST_DATABASE_URL;
if (!database || !/^\/evoloop(?:_[a-z0-9]+)*_test$/.test(new URL(database).pathname)) throw new Error("A dedicated evoloop_*_test database is required");

const setup = async (t: test.TestContext, prefix: string) => {
  const schema = `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  await migrate(database!, schema);
  const pool = new pg.Pool({ connectionString: database, options: `-c search_path=${schema}` });
  t.after(async () => { await pool.end(); const admin = new pg.Client({ connectionString: database }); await admin.connect(); try { await admin.query(`DROP SCHEMA "${schema}" CASCADE`); } finally { await admin.end(); } });
  const projectId = randomUUID();
  const decider: Principal = { actorId: "decider", projectIds: [projectId], permissions: ["read", "write", "task", "document", "session", "management"], decisions: true };
  const writer: Principal = { actorId: "writer", projectIds: [projectId], permissions: ["read", "write", "task", "document", "session"] };
  const workflow = new WorkflowService({ uow: new PostgresUnitOfWork(pool), clock: { now: () => new Date().toISOString() }, ids: { next: randomUUID },
    hasher: { hash: (s: string) => createHash("sha256").update(s).digest("hex") }, requireTaskStage: true });
  const issue = (who: Principal, command: Record<string, unknown>) => workflow.execute(who, { ...command, projectId, operationId: randomUUID() } as never);
  const applied = async (who: Principal, command: Record<string, unknown>) => { const r = await issue(who, command); assert.equal(r.status, "applied", JSON.stringify(r)); return r; };
  const refused = async (who: Principal, command: Record<string, unknown>, code: string) => { const r = await issue(who, command); assert.equal(r.status, "rejected", JSON.stringify(r)); assert.equal(r.status === "rejected" ? r.code : null, code); };
  await applied(decider, { type: "project.create", title: "Milestones" });
  const owner = fixtureRoleId("milestone-owner"); await seedFixtureRole(pool, projectId, owner);
  const goalId = randomUUID();
  await applied(decider, { type: "goal.create", goalId, outcome: "One goal", constraints: "none", consumer: owner, authority: owner, scope: "test", owner });
  const stage = async (extra: Record<string, unknown> = {}, accept = false) => {
    const stageId = randomUUID();
    await applied(decider, { type: "stage.propose", stageId, goalId, deliverable: "Deliver", learningQuestion: "Learn", shortName: "第一期", checkMethod: "验收人用样本核对", reason: "propose", ...extra });
    if (accept) await applied(decider, { type: "stage.accept", stageId, expectedVersion: 1, reason: "accept" });
    return stageId;
  };
  const task = async (stageId?: string) => {
    const taskId = randomUUID();
    await applied(decider, { type: "task.create", taskId, title: "T", content: "Body", acceptance: "Check", owner, ...(stageId ? { stageId, consumer: "decider", evidence: "seen", stopCondition: "reviewed" } : { noStage: true, noStageReason: "测试用" }) });
    return taskId;
  };
  const rows = async (table: string) => Number((await pool.query(`SELECT count(*) AS n FROM ${table}`)).rows[0].n);
  return { pool, schema, projectId, decider, writer, workflow, issue, applied, refused, stage, task, rows, owner, goalId };
};


const base = (owner: string) => ({ type: "task.create", title: "T", content: "Body", acceptance: "Check", owner });
const stageRow = async (f: Awaited<ReturnType<typeof setup>>, taskId: string) => (await f.pool.query("SELECT stage_id, no_stage_reason, version, actor_id, reason FROM task_stage WHERE task_id=$1", [taskId])).rows;

test("task.create must choose: a stage (with consumer, evidence, stop condition) or noStage with a reason; the refusal names both choices", async t => {
  const f = await setup(t, "ts_create");
  const stageId = await f.stage({}, true);
  const sample = { ...base(f.owner) };
  const staged = randomUUID(), none = randomUUID();
  await f.applied(f.decider, { ...sample, taskId: staged, stageId, consumer: "decider", evidence: "seen", stopCondition: "reviewed" });
  assert.deepEqual((await stageRow(f, staged)).map(r => [r.stage_id, r.no_stage_reason, r.version]), [[stageId, null, 1]], "a stage Task has one row naming its stage");
  await f.applied(f.decider, { ...sample, taskId: none, noStage: true, noStageReason: "日常杂务" });
  assert.deepEqual((await stageRow(f, none)).map(r => [r.stage_id, r.no_stage_reason, r.version]), [[null, "日常杂务", 1]], "noStage keeps its reason and no stage");
  const refusal = async (extra: Record<string, unknown>, code: string) => {
    const r = await f.issue(f.decider, { ...sample, taskId: randomUUID(), ...extra });
    assert.equal(r.status, "rejected", JSON.stringify(r)); assert.equal(r.status === "rejected" ? r.code : null, code, JSON.stringify(r));
    return r.status === "rejected" ? r.message : "";
  };
  const neither = await refusal({}, "STAGE_CHOICE_REQUIRED");
  assert.match(neither, /stageId/); assert.match(neither, /noStage: true/); assert.match(neither, /noStageReason/, "the message tells the caller what each choice needs");
  await refusal({ stageId, noStage: true, noStageReason: "x", consumer: "decider", evidence: "e", stopCondition: "s" }, "STAGE_CHOICE_INVALID");
  await refusal({ noStage: true }, "STAGE_CHOICE_INVALID");
  await refusal({ noStageReason: "x" }, "STAGE_CHOICE_INVALID");
  await refusal({ stageId }, "INCOMPLETE_PROPOSAL");
  assert.equal(await f.rows("task_stage"), 2, "refused creations wrote nothing");
});

test("task.stage.set assigns without touching the Task: any open state, no stage requirements, no revision, closed Tasks refused, history appended", async t => {
  const f = await setup(t, "ts_set");
  const a = await f.stage({}, true), b = await f.stage({}, true);
  const todo = await f.task(), started = await f.task(), delivered = await f.task(), closed = await f.task();
  // An old Task with no ownership row (made before the rule) and no evidence or stop condition.
  await f.pool.query("DELETE FROM task_stage_history WHERE task_id=$1", [todo]); await f.pool.query("DELETE FROM task_stage WHERE task_id=$1", [todo]);
  for (const id of [started, delivered]) await f.applied(f.decider, { type: "task.start", taskId: id, expectedVersion: 1, reason: "start" });
  // "in progress" is the furthest state driven here; the command reads only whether the Task is closed.
  const snapshot = async (taskId: string) => JSON.stringify([(await f.pool.query("SELECT version, current_revision_id, state, owner FROM task WHERE task_id=$1", [taskId])).rows, await f.rows("task_revision"), await f.rows("task_proposal")]);
  const before = await snapshot(delivered);
  await f.applied(f.writer, { type: "task.stage.set", taskId: delivered, stageId: a, reason: "归到第一期" });
  assert.equal(await snapshot(delivered), before, "version, current revision, state, owner and the revision and proposal counts are the same after assigning");
  await f.applied(f.writer, { type: "task.stage.set", taskId: todo, stageId: a, reason: "补归属" });
  await f.applied(f.writer, { type: "task.stage.set", taskId: started, stageId: b, reason: "进行中也能归" });
  assert.deepEqual((await stageRow(f, todo)).map(r => [r.stage_id, r.version]), [[a, 1]]);
  await f.applied(f.writer, { type: "task.stage.set", taskId: todo, stageId: null, noStageReason: "改为不属于阶段", reason: "更正" });
  await f.applied(f.writer, { type: "task.stage.set", taskId: todo, stageId: b, reason: "再改" });
  const history = (await f.pool.query("SELECT version, stage_id, no_stage_reason, actor_id, reason FROM task_stage_history WHERE task_id=$1 ORDER BY version", [todo])).rows;
  assert.deepEqual(history.map(r => [r.version, r.stage_id, r.no_stage_reason, r.actor_id, r.reason]),
    [[1, a, null, "writer", "补归属"], [2, null, "改为不属于阶段", "writer", "更正"], [3, b, null, "writer", "再改"]], "every change is appended with who and why");
  const refuse = async (command: Record<string, unknown>, code: string) => { const r = await f.issue(f.writer, { type: "task.stage.set", reason: "x", ...command }); assert.equal(r.status, "rejected", JSON.stringify(r)); assert.equal(r.status === "rejected" ? r.code : null, code, JSON.stringify(r)); };
  await refuse({ taskId: todo, stageId: null }, "STAGE_CHOICE_INVALID");
  await refuse({ taskId: todo, stageId: a, noStageReason: "both" }, "STAGE_CHOICE_INVALID");
  await refuse({ taskId: todo, stageId: randomUUID() }, "NOT_FOUND");
  await f.applied(f.decider, { type: "task.cancel", taskId: closed, expectedVersion: 1, reason: "close" });
  await refuse({ taskId: closed, stageId: a }, "INVALID_STATE");
  const reader = { ...f.writer, actorId: "reader", permissions: ["read"] } as Principal;
  await assert.rejects(f.issue(reader, { type: "task.stage.set", taskId: todo, stageId: a, reason: "x" }), /Permission task is required/, "writing ownership needs Task write permission");
});
