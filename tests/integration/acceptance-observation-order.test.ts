// Refuses a live or shared PostgreSQL server before this file opens TEST_DATABASE_URL (scripts/lib/database-target.mjs).
import "../../scripts/test-database-guard.mjs";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";
import { migrate, PostgresUnitOfWork } from "@evoloop/adapter-postgres";
import { WorkflowService } from "@evoloop/core";
import type { Principal } from "@evoloop/contracts";
import { AcceptanceRelayService } from "../../apps/coordinator/src/acceptance-relay/service.js";
import { fixtureRoleId, seedFixtureRole } from "./role-fixture.test.js";

const database = process.env.TEST_DATABASE_URL;
if (!database || !/^\/evoloop(?:_[a-z0-9]+)*_test$/.test(new URL(database).pathname)) throw new Error("A dedicated evoloop_*_test database is required");

/**
 * Defect ba59825a: whether an observation is older than the arrangement it is linked to was compared as Date.parse(<pg Date object>), which goes through
 * the object's string form and drops the milliseconds. An observation 37 ms older than the arrangement, in the same second, passed as "not older".
 * Here the arrangement is created at a fixed instant with a fractional second, observations are stored at exact offsets from it, and the real
 * service (AcceptanceRelayService.linkObservation, over real PostgreSQL rows and real timestamptz precision) is asked to link each.
 *
 * Rule, in the one place it is written (service.ts, linkObservation): an observation is refused when PostgreSQL finds its time strictly earlier than the arrangement's
 * `created_at` (full microsecond precision; the Node driver's Date holds only milliseconds, which is what let 1–999 µs through); an observation made at exactly that instant is not earlier and is accepted. There is no window and no tie-break between two candidates:
 * one observation is linked per arrangement, and the comparison is a total order on the stored microsecond-precision instants.
 */
test("an observation earlier than the arrangement is refused at any offset down to one microsecond; one at or after it is linked", async t => {
  const schema = `obs_order_${randomUUID().replaceAll("-", "")}`;
  await migrate(database!, schema);
  const pool = new pg.Pool({ connectionString: database, options: `-c search_path=${schema}` });
  t.after(async () => { await pool.end(); const admin = new pg.Client({ connectionString: database }); await admin.connect(); try { await admin.query(`DROP SCHEMA "${schema}" CASCADE`); } finally { await admin.end(); } });
  const projectId = randomUUID();
  const reviewer: Principal = { actorId: "leader-reviewer", projectIds: [projectId], permissions: ["read", "write", "review"] };
  const human: Principal = { actorId: "named-human", identityKind: "human", projectIds: [projectId], permissions: ["read", "write"] };
  const workflow = new WorkflowService({ uow: new PostgresUnitOfWork(pool), clock: { now: () => new Date().toISOString() }, ids: { next: randomUUID },
    hasher: { hash: (value: string) => createHash("sha256").update(value).digest("hex") } });
  const service = new AcceptanceRelayService({ pool, workflow, messages: {} as never, principals: async () => [], canWrite: () => false, leaderSession: async () => null,
    qualify: async () => null, capabilities: async () => [] });
  await workflow.execute(reviewer, { type: "project.create", projectId, title: "Observation order", operationId: randomUUID() } as never);
  const owner = fixtureRoleId("obs-order-owner"); await seedFixtureRole(pool, projectId, owner);
  const taskId = randomUUID(), deliveryId = randomUUID();
  await workflow.execute(reviewer, { type: "task.create", projectId, operationId: randomUUID(), taskId, title: "Order", content: "# Order", acceptance: "Used", owner, consumer: "named-human",
    useRequired: true, acceptanceMode: "human_required", acceptanceTarget: "human" } as never);
  await workflow.execute(reviewer, { type: "task.start", projectId, operationId: randomUUID(), taskId, expectedVersion: Number((await workflow.getTask(reviewer, projectId, taskId)).task.version), reason: "start" } as never);
  const task = (await workflow.getTask(reviewer, projectId, taskId)).task;
  await pool.query(`INSERT INTO delivery(project_id,delivery_id,task_id,task_revision_id,artifact_ref,artifact_revision,content_hash,technical_result,technical_evidence,reason,actor_id,created_at)
    VALUES($1,$2,$3,$4,'fixture:report','r1',$5,'passed','fixture','delivery','author',now())`, [projectId, deliveryId, taskId, task.currentRevisionId, "a".repeat(64)]);

  // The arrangement is created at 12:00:00.500500 UTC: 500 microseconds into its millisecond, so offsets of 1 to 500 microseconds stay inside the same millisecond (which a JavaScript Date cannot tell apart) and 501 reaches the previous one.
  // Observations are stored at exact offsets in MICROSECONDS from it, computed by PostgreSQL itself, so what is compared is what timestamptz really holds.
  const arrangedAt = "2026-11-14T12:00:00.500500Z";
  let scope = 0;
  const arrange = async (): Promise<string> => {
    const relayId = randomUUID();
    await pool.query(`INSERT INTO task_acceptance_relay(project_id,relay_id,operation_id,request_hash,task_id,task_revision_id,delivery_id,stage,scope_key,scope_description,publication_ref,reason,
      mode,recipient_actor_id,state,arranged_by,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,'candidate',$8,'scope',NULL,'fixture','human','named-human','pending','leader-reviewer',$9,$9)`,
      [projectId, relayId, randomUUID(), "b".repeat(64), taskId, task.currentRevisionId, deliveryId, `scope-${++scope}`, arrangedAt]);
    await service.humanRead(human, projectId, taskId, relayId, randomUUID(), 1, "read the delivery");
    return relayId;
  };
  const observe = async (offsetUs: number): Promise<string> => {
    const id = randomUUID();
    await pool.query(`INSERT INTO consumer_observation(project_id,observation_id,task_id,delivery_id,observer,observer_kind,result,evidence,reason,actor_id,created_at)
      VALUES($1,$2,$3,$4,'named-human','human','used','checked','used','named-human',$5::timestamptz + ($6::int * interval '1 microsecond'))`, [projectId, id, taskId, deliveryId, arrangedAt, offsetUs]);
    return id;
  };
  const link = async (relayId: string, observationId: string) => {
    const version = Number((await pool.query("SELECT version FROM task_acceptance_relay WHERE project_id=$1 AND relay_id=$2", [projectId, relayId])).rows[0].version);
    return service.linkObservation(human, projectId, taskId, relayId, observationId, randomUUID(), version);
  };
  const refused = async (relayId: string, observationId: string) => {
    try { await link(relayId, observationId); } catch (error) { return (error as { code?: string }).code ?? String(error); }
    return "linked";
  };

  // Older by 1 ms, 37 ms (the reported case), 400 ms, 499 ms (same second as the arrangement), 999 ms and 1 s (earlier second) and 5 s: all refused, and refusal changes nothing.
  // Each offset gets its own arrangement: a wrongly accepted observation would link the arrangement and hide what the next offset does.
  const olderUs = [1, 400, 499, 500, 501, 999, 1000, 37_000, 400_000, 499_999, 500_000, 999_000, 1_000_000, 5_000_000];
  const outcomes: Record<number, string> = {};
  const rejectedRelays: string[] = [];
  for (const older of olderUs) {
    const relay = await arrange(); rejectedRelays.push(relay);
    outcomes[older] = await refused(relay, await observe(-older));
  }
  assert.deepEqual(outcomes, Object.fromEntries(olderUs.map(us => [us, "OBSERVATION_MISMATCH"])), JSON.stringify(outcomes));
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM task_acceptance_observation_link WHERE project_id=$1 AND relay_id=ANY($2::uuid[])", [projectId, rejectedRelays])).rows[0].n, 0, "nothing was linked");
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM task_acceptance_relay WHERE project_id=$1 AND relay_id=ANY($2::uuid[]) AND state='pending'", [projectId, rejectedRelays])).rows[0].n, olderUs.length, "the arrangements stay pending");
  // The stored times are not rewritten by the refusals: every one of them is still exactly its offset before the arrangement.
  assert.deepEqual((await pool.query(`SELECT (extract(epoch FROM ($1::timestamptz - created_at)) * 1000000)::bigint AS us FROM consumer_observation WHERE project_id=$2 AND created_at < $1::timestamptz ORDER BY us`, [arrangedAt, projectId])).rows.map(r => Number(r.us)),
    [...olderUs].sort((x, y) => x - y));

  // At the same instant (the deterministic rule: not earlier, so accepted), 1 microsecond later, 400 us, 1 ms, 37 ms, 500 ms, 1 s later: each links.
  const accepted: Record<number, string> = {};
  const laterUs = [0, 1, 400, 1000, 37_000, 500_000, 1_000_000];
  for (const later of laterUs) {
    const fresh = await arrange();
    accepted[later] = await refused(fresh, await observe(later));
    if (accepted[later] === "linked")
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM task_acceptance_observation_link WHERE project_id=$1 AND relay_id=$2", [projectId, fresh])).rows[0].n, 1, "the observation is linked");
  }
  assert.deepEqual(accepted, Object.fromEntries(laterUs.map(us => [us, "linked"])), JSON.stringify(accepted));

  // The stored precision really is finer than a second (the test would pass for the wrong reason if timestamptz were truncated).
  const stored = (await pool.query("SELECT to_char(created_at AT TIME ZONE 'UTC','HH24:MI:SS.US') AS t FROM task_acceptance_relay WHERE project_id=$1 AND relay_id=$2", [projectId, rejectedRelays[0]])).rows[0].t;
  assert.equal(stored, "12:00:00.500500");
  const sub = (await pool.query("SELECT to_char(created_at AT TIME ZONE 'UTC','HH24:MI:SS.US') AS t FROM consumer_observation WHERE project_id=$1 ORDER BY created_at LIMIT 1", [projectId])).rows[0].t;
  assert.equal(sub, "11:59:55.500500", "the 5 s offset is exact");
});
