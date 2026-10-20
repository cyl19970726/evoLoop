import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";
import type { ScheduleDefinition } from "@evoloop/contracts/scheduling";
import { migrate } from "../../packages/adapter-postgres/src/index.js";
import { PgSchedulingStore, ScheduleStoreConflict } from "../../packages/adapter-postgres/src/scheduling.js";

const url = process.env.TEST_DATABASE_URL;
if (!url || !/\/evoloop_facade_test(?:\?|$)/.test(url)) throw new Error("Use dedicated evoloop_facade_test database");
const schema = `schedule_guard_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
const projectId = randomUUID(), retiredRoleId = randomUUID();
const at = "2026-10-20T10:00:00.000Z";

test("retired authorizer or owner cannot produce scheduled todo Tasks", async t => {
  await migrate(url, schema);
  const pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}` });
  t.after(async () => {
    await pool.end();
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    try { await client.query(`DROP SCHEMA "${schema}" CASCADE`); } finally { await client.end(); }
  });
  await pool.query("INSERT INTO project(project_id,title,created_at) VALUES($1,'Retirement schedule guard',now())", [projectId]);
  const roleRevisionId = randomUUID();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`INSERT INTO role_definition(project_id,role_id,version,current_revision_id,state,proposed_by,created_at_utc,review_at_utc)
      VALUES($1,$2,1,$3,'retired','manager',$4,$4)`, [projectId, retiredRoleId, roleRevisionId, at]);
    await client.query(`INSERT INTO role_revision(project_id,role_id,revision_id,version,state,proposal,actor_id,reason,created_at_utc,review_at_utc)
      VALUES($1,$2,$3,1,'retired','{}'::jsonb,'manager','fixture',$4,$4)`, [projectId, retiredRoleId, roleRevisionId, at]);
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }

  const store = new PgSchedulingStore(pool);
  const define = (owner: string, authorizer: string, expiresAtUtc: string | null = null): ScheduleDefinition => {
    const scheduleId = randomUUID(), revisionId = randomUUID();
    return { projectId, id: scheduleId, version: 1, currentRevisionId: revisionId, state: "active",
      watermarkUtc: "2026-10-20T09:00:00.000Z",
      revision: { projectId, scheduleId, id: revisionId, version: 1, timezone: "UTC",
        rule: { kind: "once", atUtc: "2026-10-20T09:30:00.000Z" }, misfire: { kind: "latest" },
        overlap: "skip", template: { title: "Review", content: "# Inspect", acceptance: "Record", owner },
        authorization: { scopeId: "scope:review", roleId: authorizer, authorizedBy: "manager", expiresAtUtc },
        actorId: "manager", reason: "fixture", createdAtUtc: "2026-10-20T09:00:00.000Z" } };
  };
  const retiredOwner = define(retiredRoleId, "temporary-authorizer");
  const retiredAuthorizer = define("temporary-owner", retiredRoleId);
  const expired = define("temporary-owner", "temporary-authorizer", at);
  for (const schedule of [retiredOwner, retiredAuthorizer, expired]) {
    await store.create(schedule);
    await assert.rejects(() => store.materialize(schedule, "2026-10-20T09:30:00.000Z", at, "created", "tick"),
      ScheduleStoreConflict);
  }
  const counts = await pool.query(`SELECT
    (SELECT count(*)::int FROM task WHERE project_id=$1) AS tasks,
    (SELECT count(*)::int FROM schedule_occurrence WHERE project_id=$1) AS occurrences,
    (SELECT count(*)::int FROM outbox_event WHERE project_id=$1) AS events`, [projectId]);
  assert.deepEqual(counts.rows[0], { tasks: 0, occurrences: 0, events: 0 });
});
