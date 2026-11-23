// Refuses a live or shared PostgreSQL server before this file opens TEST_DATABASE_URL (scripts/lib/database-target.mjs).
import "../../scripts/test-database-guard.mjs";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";
import { SchedulingService } from "../../packages/core/src/scheduling/index.js";
import { WorkflowService } from "../../packages/core/src/index.js";
import { PgSchedulingStore } from "../../packages/adapter-postgres/src/scheduling.js";
import { migrate, PostgresUnitOfWork } from "../../packages/adapter-postgres/src/index.js";
import type { Principal } from "../../packages/contracts/src/index.js";
import type { ScheduleDefinition } from "../../packages/contracts/src/scheduling.js";
import { fixtureRoleId, seedFixtureRole } from "./role-fixture.test.js";

const url = process.env.TEST_DATABASE_URL;
if (!url || !/\/evoloop_[a-z0-9_]*test(?:\?|$)/.test(url)) throw new Error("TEST_DATABASE_URL must name a dedicated evoloop_*test database");

// Task 3797cbdd on real PG: the report delivery is found by its content hash, and an old template without “关闭后下一步” still makes its Task when it falls due.
test("required lines: report deliveries and Task/schedule bodies are checked by code; fire time is not", async t => {
  await migrate(url);
  const pool = new pg.Pool({ connectionString: url, max: 4 });
  t.after(() => pool.end());
  const projectId = randomUUID();
  const principal: Principal = { actorId: "lead", projectIds: [projectId], permissions: ["task", "document", "session", "management"], decisions: true };
  const clock = { now: () => "2026-10-20T12:01:00.000Z" };
  const workflow = new WorkflowService({ uow: new PostgresUnitOfWork(pool), clock, ids: { next: randomUUID }, hasher: { hash: value => createHash("sha256").update(value).digest("hex") } });
  const run = async (command: Record<string, unknown>) => { const r = await workflow.execute(principal, { ...command, projectId, operationId: randomUUID() } as never); assert.equal(r.status, "applied"); return r; };
  await run({ type: "project.create", title: "required lines" });
  const hashOf = async (body: string, kind = "report") => {
    const documentId = randomUUID();
    await run({ type: "document.create", documentId, title: `doc ${documentId.slice(0, 4)}`, kind, body });
    return (await pool.query("SELECT r.content_hash FROM document_revision r WHERE r.project_id=$1 AND r.document_id=$2", [projectId, documentId])).rows[0].content_hash as string;
  };
  const code = (command: Record<string, unknown>) => workflow.checkRequiredLines({ ...command, projectId }).then(() => "passed", (e: { code?: string }) => e.code);
  const record = (contentHash: string) => ({ type: "delivery.record", contentHash });

  assert.equal(await code(record(await hashOf("# 报告\n无关"))), "REPORT_NEXT_TIME_LINE_REQUIRED");
  assert.equal(await code(record(await hashOf("## 下次同类工作先要知道的事\n"))), "REPORT_NEXT_TIME_LINE_REQUIRED");
  assert.equal(await code(record(await hashOf("下次同类工作先要知道的事：待定"))), "REPORT_NEXT_TIME_LINE_REQUIRED");
  assert.equal(await code(record(await hashOf("下次同类工作先要知道的事：无"))), "passed");
  assert.equal(await code(record(await hashOf("## 下次同类工作先要知道的事\n先看夹具"))), "passed");
  // The original is not a report Document, or no Document at all: not checked.
  assert.equal(await code(record(await hashOf("没有这一行", "spec"))), "passed");
  assert.equal(await code(record("f".repeat(64))), "passed");

  const content = (line: string) => `# 做事\n${line}`;
  const template = (line: string) => ({ title: "t", content: content(line), acceptance: "a", owner: "o" });
  for (const bad of ["", "关闭后下一步：", "关闭后下一步：待定"]) {
    assert.equal(await code({ type: "task.create", content: content(bad) }), "TASK_AFTER_CLOSE_LINE_REQUIRED");
    assert.equal(await code({ type: "schedule.create", template: template(bad) }), "TASK_AFTER_CLOSE_LINE_REQUIRED");
    assert.equal(await code({ type: "schedule.revise", state: "active", template: template(bad) }), "TASK_AFTER_CLOSE_LINE_REQUIRED");
  }
  for (const ok of ["关闭后下一步：无", "关闭后下一步：需求 Session 读回下一次例行交付"]) {
    assert.equal(await code({ type: "task.create", content: content(ok) }), "passed");
    assert.equal(await code({ type: "schedule.create", template: template(ok) }), "passed");
    assert.equal(await code({ type: "schedule.revise", state: "active", template: template(ok) }), "passed");
  }

  // Regression: an old template saved without the line still makes its Task when it falls due (the guard sits at the command entry, not in tick).
  const ownerRoleId = fixtureRoleId("lines-owner");
  await seedFixtureRole(pool, projectId, ownerRoleId);
  const scheduleId = randomUUID(), revisionId = randomUUID();
  const definition: ScheduleDefinition = {
    projectId, id: scheduleId, version: 1, currentRevisionId: revisionId, state: "active", watermarkUtc: "2026-10-20T09:00:00.000Z",
    revision: { projectId, scheduleId, id: revisionId, version: 1, timezone: "Asia/Taipei",
      rule: { kind: "interval", anchorUtc: "2026-10-20T09:00:00.000Z", everyMinutes: 60 }, misfire: { kind: "bounded", maxCatchUp: 3 }, overlap: "queue",
      template: { title: "Old template", content: "# Check new evidence", acceptance: "Record evidence", owner: ownerRoleId },
      authorization: { scopeId: "scope:test", roleId: "role:test", authorizedBy: principal.actorId, expiresAtUtc: null },
      reason: "old template", actorId: principal.actorId, createdAtUtc: "2026-10-20T09:00:00.000Z" },
  };
  const service = new SchedulingService(new PgSchedulingStore(pool));
  await service.create(principal, definition);
  const made = await service.tick(principal, projectId, "2026-10-20T10:00:00.000Z", ["scope:test"]);
  assert.equal(made[0]?.state, "created");
  assert.equal((await pool.query("SELECT state FROM task WHERE project_id=$1 AND task_id=$2", [projectId, made[0]!.taskId])).rows[0]?.state, "todo");
});
