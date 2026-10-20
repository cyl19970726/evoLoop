import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";
import { SchedulingService } from "../../packages/core/src/scheduling/index.js";
import { WorkflowService } from "../../packages/core/src/index.js";
import { PgSchedulingStore, ScheduleStoreConflict } from "../../packages/adapter-postgres/src/scheduling.js";
import { migrate, PostgresUnitOfWork } from "../../packages/adapter-postgres/src/index.js";
import type { Principal } from "../../packages/contracts/src/index.js";
import type { ScheduleDefinition } from "../../packages/contracts/src/scheduling.js";

const url = process.env.TEST_DATABASE_URL;
if (!url || !/\/evoloop_[a-z_]*test(?:\?|$)/.test(url)) throw new Error("TEST_DATABASE_URL must name a dedicated evoloop_*test database");

test("real PG schedule reservation creates one todo Task and survives replay", async t => {
  await migrate(url);
  const pool = new pg.Pool({ connectionString: url, max: 4 });
  t.after(() => pool.end());
  const projectId = randomUUID();
  await pool.query("INSERT INTO project(project_id,title,created_at) VALUES($1,'scheduling fixture',now())", [projectId]);
  const scheduleId = randomUUID(), revisionId = randomUUID();
  const principal: Principal = { actorId: "schedule-owner", projectIds: [projectId], permissions: ["read", "write", "review"] };
  const definition: ScheduleDefinition = {
    projectId, id: scheduleId, version: 1, currentRevisionId: revisionId, state: "active", watermarkUtc: "2026-10-20T09:00:00.000Z",
    revision: { projectId, scheduleId, id: revisionId, version: 1, timezone: "Asia/Taipei",
      rule: { kind: "interval", anchorUtc: "2026-10-20T09:00:00.000Z", everyMinutes: 60 }, misfire: { kind: "bounded", maxCatchUp: 3 }, overlap: "queue",
      template: { title: "Inspect a result", content: "# Check new evidence", acceptance: "Record evidence", owner: "schedule-owner" },
      authorization: { scopeId: "scope:test", roleId: "role:test", authorizedBy: principal.actorId, expiresAtUtc: null },
      reason: "fixture schedule", actorId: principal.actorId, createdAtUtc: "2026-10-20T09:00:00.000Z" },
  };
  const store = new PgSchedulingStore(pool), service = new SchedulingService(store);
  await service.create(principal, definition);
  const now = "2026-10-20T12:00:00.000Z";
  assert.deepEqual(await service.tick(principal, projectId, now, []), []);
  const first = await service.tick(principal, projectId, now, ["scope:test"]);
  assert.equal(first.length, 3);
  assert.deepEqual(first.map(item => item.state), ["created", "queued", "queued"]);
  const created = first[0]!; assert(created.taskId);
  assert.equal((await pool.query("SELECT state FROM task WHERE project_id=$1 AND task_id=$2", [projectId, created.taskId])).rows[0]?.state, "todo");
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM operation_journal WHERE project_id=$1 AND operation_id=$2", [projectId, created.operationId])).rows[0]?.n, 1);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM outbox_event WHERE project_id=$1 AND operation_id=$2", [projectId, created.operationId])).rows[0]?.n, 1);
  assert.deepEqual(await service.tick(principal, projectId, now, ["scope:test"]), []);
  assert.equal((await store.getOccurrence(projectId, scheduleId, created.plannedAtUtc))?.operationId, created.operationId, "stable-key readback supports uncertain commit recovery");
  assert.equal((await store.materialize(definition, created.plannedAtUtc, now, "created", "replayed")).taskId, created.taskId);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM task WHERE project_id=$1", [projectId])).rows[0]?.n, 1);
  const workflow = new WorkflowService({ uow: new PostgresUnitOfWork(pool), clock: { now: () => "2026-10-20T12:01:00.000Z" }, ids: { next: randomUUID }, hasher: { hash: value => createHash("sha256").update(value).digest("hex") } });
  const cancelled = await workflow.execute(principal, { type: "task.cancel", projectId, taskId: created.taskId!, expectedVersion: 1, reason: "fixture work closed", operationId: randomUUID() });
  assert.equal(cancelled.status, "applied");
  const drained = await service.tick(principal, projectId, now, ["scope:test"]);
  assert.equal(drained.length, 1); assert.equal(drained[0]?.state, "created");
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM task WHERE project_id=$1", [projectId])).rows[0]?.n, 2);
  const saved = await store.get(projectId, scheduleId); assert.equal(saved?.watermarkUtc, now);
  const paused: ScheduleDefinition = { ...saved!, version: 2, currentRevisionId: randomUUID(), state: "paused", revision: { ...saved!.revision, id: randomUUID(), version: 2, reason: "pause", createdAtUtc: "2026-10-20T12:01:00.000Z" } };
  paused.revision.id = paused.currentRevisionId;
  await service.revise(principal, paused, 1);
  assert.deepEqual(await service.tick(principal, projectId, "2026-10-20T13:00:00.000Z", ["scope:test"]), []);
  await assert.rejects(() => service.revise(principal, paused, 1), ScheduleStoreConflict);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM schedule_revision WHERE project_id=$1 AND schedule_id=$2", [projectId, scheduleId])).rows[0]?.n, 2);
});

test("concurrent ticks reserve the same UTC occurrence once", async t => {
  await migrate(url);
  const pool = new pg.Pool({ connectionString: url, max: 4 }); t.after(() => pool.end());
  const projectId = randomUUID(), scheduleId = randomUUID(), revisionId = randomUUID();
  await pool.query("INSERT INTO project(project_id,title,created_at) VALUES($1,'concurrent fixture',now())", [projectId]);
  const principal: Principal = { actorId: "owner", projectIds: [projectId], permissions: ["write", "review"] };
  const definition: ScheduleDefinition = { projectId, id: scheduleId, version: 1, currentRevisionId: revisionId, state: "active", watermarkUtc: "2026-10-20T09:00:00.000Z", revision: {
    projectId, scheduleId, id: revisionId, version: 1, timezone: "UTC", rule: { kind: "once", atUtc: "2026-10-20T10:00:00.000Z" }, misfire: { kind: "latest" }, overlap: "skip",
    template: { title: "One task", content: "# Do one check", acceptance: "Evidence exists", owner: "owner" }, authorization: { scopeId: "scope", roleId: "role", authorizedBy: "owner", expiresAtUtc: null },
    reason: "concurrency", actorId: "owner", createdAtUtc: "2026-10-20T09:00:00.000Z" } };
  const service = new SchedulingService(new PgSchedulingStore(pool));
  await service.create(principal, definition);
  const attempts = await Promise.allSettled([service.tick(principal, projectId, "2026-10-20T10:00:00.000Z", ["scope"]), service.tick(principal, projectId, "2026-10-20T10:00:00.000Z", ["scope"])]);
  assert(attempts.every(result => result.status === "fulfilled"));
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM schedule_occurrence WHERE project_id=$1", [projectId])).rows[0]?.n, 1);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM task WHERE project_id=$1", [projectId])).rows[0]?.n, 1);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM outbox_event WHERE project_id=$1", [projectId])).rows[0]?.n, 1);
});
