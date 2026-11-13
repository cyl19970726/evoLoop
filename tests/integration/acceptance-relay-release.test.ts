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
 * Closing a Task is guarded by its acceptance arrangements (migration 070). A Delivery that has an arrangement left over from before a fix, or one stuck
 * in blocked, could never be closed. `acceptance.release` moves such an arrangement out of the way, but only while another one still governs the stage.
 */
test("a left-over or stuck arrangement is released with a reason and closure then goes through; the last one, a satisfied one and an unauthorized caller are refused", async t => {
  const schema = `relay_release_${randomUUID().replaceAll("-", "")}`;
  await migrate(database!, schema);
  const pool = new pg.Pool({ connectionString: database, options: `-c search_path=${schema}` });
  t.after(async () => { await pool.end(); const admin = new pg.Client({ connectionString: database }); await admin.connect(); try { await admin.query(`DROP SCHEMA "${schema}" CASCADE`); } finally { await admin.end(); } });
  const projectId = randomUUID();
  const reviewer: Principal = { actorId: "reviewer", projectIds: [projectId], permissions: ["read", "write", "review"] };
  const writer: Principal = { actorId: "writer", projectIds: [projectId], permissions: ["read", "write"] };
  const workflow = new WorkflowService({ uow: new PostgresUnitOfWork(pool), clock: { now: () => new Date().toISOString() }, ids: { next: randomUUID },
    hasher: { hash: (value: string) => createHash("sha256").update(value).digest("hex") } });
  const issue = async (command: Record<string, unknown>) => { const r = await workflow.execute(reviewer, { ...command, projectId, operationId: randomUUID() } as never); assert.equal(r.status, "applied", JSON.stringify(r)); return r; };
  await issue({ type: "project.create", title: "Relay release" });
  const owner = fixtureRoleId("release-owner"); await seedFixtureRole(pool, projectId, owner);
  const relayService = new AcceptanceRelayService({ pool, workflow, messages: {} as never, principals: async () => [], canWrite: () => false, leaderSession: async () => null, qualify: async () => null, capabilities: async () => [] });

  /** A Task with a Delivery, and helpers to put arrangements and recorded observations on it. */
  const fixture = async () => {
    const taskId = randomUUID(), deliveryId = randomUUID();
    await issue({ type: "task.create", taskId, title: "Closure", content: "# Closure", acceptance: "Used", owner, consumer: "named-human", useRequired: true, acceptanceMode: "human_required", acceptanceTarget: "human" });
    const task = (await workflow.getTask(reviewer, projectId, taskId)).task;
    await pool.query(`INSERT INTO delivery(project_id,delivery_id,task_id,task_revision_id,artifact_ref,artifact_revision,content_hash,technical_result,technical_evidence,reason,actor_id,created_at)
      VALUES($1,$2,$3,$4,'fixture:report','r1',$5,'passed','fixture','delivery','author',now())`, [projectId, deliveryId, taskId, task.currentRevisionId, "a".repeat(64)]);
    const relay = async (stage: "candidate" | "formal", scope: string, state: string, result: "used" | "notUsed" | null) => {
      const relayId = randomUUID();
      await pool.query(`INSERT INTO task_acceptance_relay(project_id,relay_id,operation_id,request_hash,task_id,task_revision_id,delivery_id,stage,scope_key,scope_description,publication_ref,reason,
        mode,recipient_actor_id,state,blocked_reason,arranged_by,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'scope',$10,'fixture','human','named-human',$11,$12,'reviewer',now(),now())`,
        [projectId, relayId, randomUUID(), "b".repeat(64), taskId, task.currentRevisionId, deliveryId, stage, scope, stage === "formal" ? "fixture://published" : null, state, state === "blocked" ? "MESSAGE_BINDING_CHANGED" : null]);
      if (result) {
        const observationId = randomUUID();
        await pool.query(`INSERT INTO consumer_observation(project_id,observation_id,task_id,delivery_id,observer,observer_kind,result,evidence,reason,actor_id,created_at)
          VALUES($1,$2,$3,$4,'named-human','human',$5,'checked','recorded','named-human',now())`, [projectId, observationId, taskId, deliveryId, result]);
        await pool.query(`INSERT INTO task_acceptance_observation_link(project_id,relay_id,observation_id,operation_id,actor_id,evidence_level,linked_at) VALUES($1,$2,$3,$4,'named-human','human_credential',now())`,
          [projectId, relayId, observationId, randomUUID()]);
      }
      return relayId;
    };
    const version = async (relayId: string) => Number((await pool.query("SELECT version FROM task_acceptance_relay WHERE project_id=$1 AND relay_id=$2", [projectId, relayId])).rows[0].version);
    const close = () => pool.query(`INSERT INTO task_closure(project_id,closure_id,task_id,task_revision_id,delivery_id,acceptance_result,acceptance_evidence,reason,actor_id,created_at)
      VALUES($1,$2,$3,$4,$5,'met','evidence','close','reviewer',now())`, [projectId, randomUUID(), taskId, task.currentRevisionId, deliveryId]);
    const release = async (relayId: string, who = reviewer, operationId = randomUUID(), reason = "superseded by the later formal check") =>
      relayService.release(who, { projectId, taskId, relayId, operationId, expectedVersion: await version(relayId), reason });
    const refused = async (action: () => Promise<unknown>) => action().then(() => "released", (error: { code?: string; message: string }) => error.code ?? error.message);
    return { taskId, relay, version, close, release, refused };
  };

  // 1. Two formal arrangements: the first recorded notUsed (before a fix was merged), the second used. Before this change nothing could close the Task.
  const one = await fixture();
  const old = await one.relay("formal", "first-check", "linked", "notUsed");
  const current = await one.relay("formal", "second-check", "linked", "used");
  await assert.rejects(one.close(), /effective acceptance arrangement lacks linked consumer use/, "the left-over arrangement blocks closure (the defect)");
  assert.equal(await one.refused(() => one.release(old, writer)), "FORBIDDEN", "only review authority releases");
  assert.equal(await one.refused(() => one.release(current)), "ARRANGEMENT_SATISFIED", "an arrangement whose use was recorded is evidence, not an obstacle");
  const operationId = randomUUID();
  const released = await one.release(old, reviewer, operationId);
  assert.deepEqual([released.state, released.version], ["released", 2]);
  assert.deepEqual((await one.release(old, reviewer, operationId)), released, "the same operation replays");
  const row = (await pool.query("SELECT state, blocked_reason FROM task_acceptance_relay WHERE project_id=$1 AND relay_id=$2", [projectId, old])).rows[0];
  assert.equal(row.state, "released"); assert.match(row.blocked_reason, /superseded by the later formal check/);
  const record = (await pool.query("SELECT actor_id, reason, from_state FROM task_acceptance_relay_release WHERE project_id=$1 AND relay_id=$2", [projectId, old])).rows[0];
  assert.deepEqual([record.actor_id, record.from_state, record.reason], ["reviewer", "linked", "superseded by the later formal check"], "the reason and who released it stay on record");
  await assert.doesNotReject(one.close(), "closure now goes through");
  assert.equal(await one.refused(() => one.release(old)), "ACCEPTANCE_NOT_EFFECTIVE", "a released arrangement is out of effect");

  // 2. A blocked candidate whose message binding no longer matches, and a new candidate that was used.
  const two = await fixture();
  const stuck = await two.relay("candidate", "candidate-a", "blocked", null);
  await two.relay("candidate", "candidate-b", "linked", "used");
  await assert.rejects(two.close(), /lacks linked consumer use/);
  await two.release(stuck, reviewer, randomUUID(), "message binding changed; replaced by candidate-b");
  await assert.doesNotReject(two.close());

  // 3. The rules do not loosen: the last arrangement of a stage, a formal arrangement that is only notUsed, and a candidate use under a formal arrangement.
  const three = await fixture();
  const only = await three.relay("formal", "only", "linked", "notUsed");
  assert.equal(await three.refused(() => three.release(only)), "LAST_ARRANGEMENT", "the last effective arrangement is never released");
  await assert.rejects(three.close(), /lacks linked consumer use/, "and closure is still refused");
  const four = await fixture();
  await four.relay("candidate", "candidate-used", "linked", "used");
  const formalUnused = await four.relay("formal", "formal-open", "pending", null);
  await assert.rejects(four.close(), /lacks linked consumer use/, "a candidate use does not stand in for the formal arrangement");
  assert.equal(await four.refused(() => four.release(formalUnused)), "LAST_ARRANGEMENT");
  const stale = await four.refused(async () => relayService.release(reviewer, { projectId, taskId: four.taskId, relayId: formalUnused, operationId: randomUUID(), expectedVersion: 99, reason: "x" }));
  assert.equal(stale, "ACCEPTANCE_CHANGED", "a stale version is refused");
});
