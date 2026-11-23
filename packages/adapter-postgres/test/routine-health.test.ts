// 例行健康 facts from real rows (packages/adapter-postgres/src/routine-health.ts): the last trigger with its Task, the skips at the tail counted from the
// records, and one read for every schedule. Refuses a live or shared PostgreSQL server before this file opens TEST_DATABASE_URL (scripts/lib/database-target.mjs).
import "../../../scripts/test-database-guard.mjs";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import pg from "pg";
import type { ScheduleDefinition } from "@evoloop/contracts/scheduling";
import { buildRoutineHealth } from "../../core/src/scheduling/health.ts";
import { migrate } from "../src/index.ts";
import { PgRoutineHealth } from "../src/routine-health.ts";
import { PgSchedulingStore } from "../src/scheduling.ts";

const url = process.env.TEST_DATABASE_URL;
if (!url || !/^evoloop(?:_[a-z0-9]+)*_test$/.test(decodeURIComponent(new URL(url).pathname.slice(1))))
  throw new Error("Routine health tests require a dedicated evoloop test database");
const schema = `el_routine_health_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
const pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}` });
const projectId = randomUUID(), roleId = randomUUID();
const setupAt = "2026-11-20T00:00:00.000Z";
const at = (hour: number) => `2026-11-22T${String(hour).padStart(2, "0")}:00:00.000Z`;

const schedule = async (title: string, watermarkUtc = setupAt): Promise<ScheduleDefinition> => {
  const id = randomUUID(), revisionId = randomUUID();
  const definition: ScheduleDefinition = { projectId, id, version: 1, currentRevisionId: revisionId, state: "active", watermarkUtc,
    revision: { projectId, scheduleId: id, id: revisionId, version: 1, timezone: "UTC", rule: { kind: "interval", anchorUtc: setupAt, everyMinutes: 60 },
      misfire: { kind: "latest" }, overlap: "skip", template: { title, content: "Check", acceptance: "accept", owner: roleId },
      authorization: { scopeId: `schedule:${id}`, roleId, authorizedBy: "reviewer", expiresAtUtc: null }, reason: "test", actorId: "reviewer", createdAtUtc: setupAt } };
  await new PgSchedulingStore(pool).create(definition);
  return definition;
};
/** Trigger at an hour; the store takes the watermark forward itself. */
const fire = async (definition: ScheduleDefinition, hour: number) => {
  const current = (await new PgSchedulingStore(pool).get(projectId, definition.id))!;
  return new PgSchedulingStore(pool).materialize(current, at(hour), at(hour), "created", "due");
};
/** Close a Task the way the page sees it (its `state`); the workflow's own transition is not what is under test, so its head-version trigger is stepped around. */
const closeTask = async (taskId: string | null) => {
  const client = await pool.connect();
  try { await client.query("SET session_replication_role = replica"); await client.query(`UPDATE task SET state='done' WHERE project_id=$1 AND task_id=$2`, [projectId, taskId]); }
  finally { await client.query("RESET session_replication_role"); client.release(); }
};
const facts = async () => { const client = await pool.connect(); try { return await new PgRoutineHealth(client, projectId).scheduleHealthFacts(); } finally { client.release(); } };

before(async () => {
  await migrate(url!, schema);
  await pool.query(`INSERT INTO project(project_id,title,created_at) VALUES($1,'Routine health',$2)`, [projectId, setupAt]);
  const revision = randomUUID();
  const client = await pool.connect();
  try { await client.query("BEGIN");
  await client.query(`INSERT INTO role_definition(project_id,role_id,version,current_revision_id,state,proposed_by,created_at_utc,review_at_utc)
    VALUES($1,$2,1,$3,'active','author',$4,'2026-12-20T00:00:00.000Z')`, [projectId, roleId, revision, setupAt]);
  await client.query(`INSERT INTO role_revision(project_id,role_id,revision_id,version,state,proposal,actor_id,reason,created_at_utc,review_at_utc)
    VALUES($1,$2,$3,1,'active','{}'::jsonb,'author','test',$4,'2026-12-20T00:00:00.000Z')`, [projectId, roleId, revision, setupAt]);
  await client.query("COMMIT"); } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
});
after(async () => {
  await pool.end();
  const client = new pg.Client({ connectionString: url! }); await client.connect();
  try { await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } finally { await client.end(); }
});

test("one read gives every schedule its last trigger and Task, the skips at the tail, and nothing for one that never triggered", async () => {
  const closed = await schedule("上次的任务已关闭"), open = await schedule("上次的任务还开着"), skipping = await schedule("连续跳过两次"), never = await schedule("从未触发");
  const first = await fire(closed, 1); await closeTask(first.taskId);
  const second = await fire(open, 1);
  const made = await fire(skipping, 1);
  assert.equal((await fire(skipping, 2)).state, "skipped"); assert.equal((await fire(skipping, 3)).state, "skipped");

  const read = new Map((await facts()).map(fact => [fact.scheduleId, fact]));
  assert.equal(read.size, 4, "every schedule of the project, in one query");
  assert.equal(read.get(closed.id)!.last!.task!.state, "done");
  assert.equal(read.get(closed.id)!.consecutiveSkips, 0);
  assert.equal(read.get(open.id)!.last!.task!.taskId, second.taskId);
  assert.equal(read.get(open.id)!.last!.task!.state, "todo");
  const skip = read.get(skipping.id)!;
  assert.equal(skip.consecutiveSkips, 2);
  assert.equal(skip.last!.state, "skipped"); assert.equal(skip.last!.task, null);
  assert.equal(skip.lastTask!.taskId, made.taskId, "the Task made before the skips is still found, and it is open");
  assert.equal(skip.lastTask!.state, "todo");
  assert.deepEqual(read.get(never.id), { scheduleId: never.id, last: null, lastTask: null, consecutiveSkips: 0 });

  // A trigger that made a Task ends the run of skips.
  await closeTask(made.taskId);
  assert.equal((await fire(skipping, 4)).state, "created");
  assert.equal((await facts()).find(fact => fact.scheduleId === skipping.id)!.consecutiveSkips, 0);
});

test("a lagging active schedule with no record reads as overdue, ahead of a healthy one", async () => {
  const lagging = await schedule("水位落后", "2026-11-22T00:00:00.000Z"), onTime = await schedule("按时", "2026-11-22T07:30:00.000Z");
  const schedules = await Promise.all([lagging, onTime].map(async item => (await new PgSchedulingStore(pool).get(projectId, item.id))!));
  const health = buildRoutineHealth({ projectId, schedules, facts: (await facts()).filter(fact => schedules.some(item => item.id === fact.scheduleId)), series: [], now: "2026-11-22T08:00:00.000Z", complete: true });
  assert.deepEqual(health.items.map(item => item.title), ["水位落后", "按时"]);
  assert.equal(health.items[0]!.overdue?.expectedAtUtc, "2026-11-22T01:00:00.000Z");
  assert.equal(health.items[0]!.lastTrigger, null);
  assert.equal(health.items[1]!.overdue, null);
});
