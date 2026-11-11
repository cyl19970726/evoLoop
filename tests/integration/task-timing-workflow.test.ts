// Refuses a live or shared PostgreSQL server before this file opens TEST_DATABASE_URL (scripts/lib/database-target.mjs).
import "../../scripts/test-database-guard.mjs";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";
import { WorkflowService } from "../../packages/core/src/index.ts";
import { migrate, PostgresUnitOfWork } from "../../packages/adapter-postgres/src/index.ts";
import { PgTaskTimingStore } from "../../packages/adapter-postgres/src/task-timing.ts";
import { taskTimingScopeId } from "@evoloop/contracts/task-timing";
import { seedFixtureRole } from "./role-fixture.test.ts";

const url = process.env.TEST_DATABASE_URL;
if (!url || !/\/evoloop_[a-z0-9_]*test(?:\?|$)/.test(url))
  throw new Error("Task timing workflow needs a dedicated evoloop_*test database");

test("ordinary Task create and start enforce once and serial daily timing", async t => {
  await migrate(url);
  const pool = new pg.Pool({ connectionString: url, max: 4 });
  t.after(() => pool.end());
  const projectId = randomUUID(), owner = randomUUID();
  await pool.query("INSERT INTO project(project_id,title,created_at) VALUES($1,'Timing workflow fixture',now())", [projectId]);
  await seedFixtureRole(pool, projectId, owner);
  const principal = { actorId: "timing-reviewer", projectIds: [projectId], permissions: ["read", "write", "review"] as const };
  let now = "2026-11-06T00:00:00.000Z";
  const once = randomUUID(), daily = randomUUID();
  const workflow = new WorkflowService({ uow: new PostgresUnitOfWork(pool), clock: { now: () => now },
    ids: { next: randomUUID }, hasher: { hash: value => createHash("sha256").update(value).digest("hex") },
    taskTimingAuthority: async (_project, _actor, _role, scope) => scope === taskTimingScopeId(daily) });
  const act = (command: Parameters<typeof workflow.execute>[1]) => workflow.execute({ ...principal, permissions: [...principal.permissions] }, command);
  const noGrant = new WorkflowService({ uow: new PostgresUnitOfWork(pool), clock: { now: () => now },
    ids: { next: randomUUID }, hasher: { hash: value => createHash("sha256").update(value).digest("hex") } });
  const denied = await noGrant.execute({ ...principal, permissions: [...principal.permissions] }, {
    type: "task.create", projectId, operationId: randomUUID(), taskId: randomUUID(), title: "Unauthorized daily",
    content: "Do work", acceptance: "Record result", owner,
    timing: { executeAtUtc: "2026-11-07T00:00:00.000Z", timezone: "Asia/Taipei", repeat: "daily" },
  });
  assert.equal(denied.status, "rejected"); assert.equal(denied.code, "TIMING_AUTHORITY_REQUIRED");
  const create = (taskId: string, repeat: "none" | "daily") => act({ type: "task.create", projectId,
    operationId: randomUUID(), taskId, title: "Review architecture", content: "Review current architecture",
    acceptance: "Record findings", owner, consumer: "independent-reviewer", acceptanceMode: "independent_agent",
    timing: { executeAtUtc: "2026-11-07T00:00:00.000Z", timezone: "Asia/Taipei", repeat } });
  assert.equal((await create(once, "none")).status, "applied");
  assert.equal((await create(daily, "daily")).status, "applied");
  const wrongScope = await act({ type: "task.timing.set", projectId, operationId: randomUUID(), taskId: once,
    expectedTaskVersion: 1, expectedTimingVersion: 1, executeAtUtc: "2026-11-07T00:00:00.000Z",
    timezone: "Asia/Taipei", repeat: "daily", scope: "this_and_future", reason: "Try another grant" });
  assert.equal(wrongScope.status, "rejected"); assert.equal(wrongScope.code, "TIMING_AUTHORITY_REQUIRED");
  const staleFuture = await act({ type: "task.update", projectId, operationId: randomUUID(), taskId: daily,
    expectedVersion: 1, title: "Changed", content: "Changed prompt", acceptance: "Record findings",
    owner, repeatScope: "this_and_future", expectedTimingVersion: 99, reason: "Stale future edit" });
  assert.equal(staleFuture.status, "rejected"); assert.equal(staleFuture.code, "VERSION_CONFLICT");
  assert.equal((await workflow.getTask({ ...principal, permissions: [...principal.permissions] }, projectId, daily)).task.version, 1);
  const start = (taskId: string, expectedVersion: number) => act({ type: "task.start", projectId, operationId: randomUUID(), taskId, expectedVersion, reason: "Time reached" });
  const early = await start(once, 1);
  assert.equal(early.status, "rejected"); assert.equal(early.code, "TASK_NOT_DUE");
  now = "2026-11-07T00:00:00.000Z";
  assert.equal((await start(once, 1)).status, "applied");
  assert.equal((await start(daily, 1)).status, "applied");
  const tick = new PgTaskTimingStore(pool);
  await tick.tick(projectId, now, principal.actorId, owner, taskTimingScopeId(daily));
  now = "2026-11-08T00:00:00.000Z";
  const copies = await tick.tick(projectId, now, principal.actorId, owner, taskTimingScopeId(daily));
  assert.equal(copies.filter(item => item.created).length, 1);
  const b = copies.find(item => item.created)!.taskId;
  const blocked = await start(b, 1);
  assert.equal(blocked.status, "rejected"); assert.equal(blocked.code, "TASK_SERIES_WAITING");
  const a = await workflow.getTask({ ...principal, permissions: [...principal.permissions] }, projectId, daily);
  assert.equal((await act({ type: "task.cancel", projectId, operationId: randomUUID(), taskId: daily,
    expectedVersion: a.task.version, reason: "Close this fixture occurrence" })).status, "applied");
  assert.equal((await start(b, 1)).status, "applied");
  assert.equal((await tick.tick(projectId, now, principal.actorId, owner, taskTimingScopeId(daily))).length, 0);
  const all = await pool.query("SELECT count(*)::int AS n FROM task_timing_occurrence WHERE project_id=$1", [projectId]);
  assert.equal(all.rows[0].n, 3, "one existing Task per first slot plus one daily successor");
});
