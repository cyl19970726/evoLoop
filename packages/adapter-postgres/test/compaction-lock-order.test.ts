// Lock order between owner compaction (coordinator CompactionMaintenance.start, its own transaction)
// and native-start admission. A direct input start holds the project lock and the Session row, then
// its processing insert takes the Session slot lock and the recovery gate. Compaction locked the gate
// and then the Session row, so the two waited on each other.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import pg from "pg";
import type { Principal } from "@evoloop/contracts";
import { migrate } from "../src/index.ts";
import { PgDirectInputs } from "../src/direct-input.ts";
import { CompactionMaintenance } from "../../../apps/coordinator/src/runtime/compaction.ts";
import type { RuntimeRunner } from "../../../apps/coordinator/src/runtime/runner.ts";
import { interleave } from "./lock-order-fixture.ts";

const url = process.env.TEST_DATABASE_URL;
if (!url || !/^evoloop(?:_[a-z0-9]+)*_test$/.test(decodeURIComponent(new URL(url).pathname.slice(1))))
  throw new Error("Compaction lock tests require a dedicated evoloop test database");
const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
const schema = `el_compact_lock_${suffix}`;
const options = `-c search_path=${schema} -c lock_timeout=20000`;
const otherApplication = `el_compact_lock_other_${suffix}`;
const pool = new pg.Pool({ connectionString: url, options });
const otherPool = new pg.Pool({ connectionString: url, options, application_name: otherApplication });
const projectId = randomUUID(), roleId = randomUUID(), model = "gpt-lock-test";
const maintainer: Principal = { actorId: "maintainer", projectIds: [projectId], permissions: ["read", "write", "review"] };

/** A ready full-profile Session whose gate is blocked by a failed message Turn, as compaction requires. */
async function blockedSession(): Promise<{ sessionId: string; threadId: string; gateVersion: number }> {
  const sessionId = randomUUID(), threadId = randomUUID(), messageId = randomUUID();
  await pool.query(`INSERT INTO runtime_session(project_id,session_id,role_id,cwd,authorization_scope,model,sandbox,
    approval_policy,state,version,native_thread_id,native_session_id,operation_id,actor_id,created_at,updated_at)
    VALUES($1,$2,$3,'/tmp/compact-lock','project',$4,'danger-full-access','never','ready',1,$5,$6,$7,'agent',now(),now())`,
    [projectId, sessionId, roleId, model, threadId, `native-${sessionId}`, randomUUID()]);
  await pool.query(`UPDATE session_execution_profile SET activation_state='active',active_revision_id=revision_id
    WHERE project_id=$1 AND session_id=$2`, [projectId, sessionId]);
  await pool.query(`INSERT INTO session_message(project_id,message_id,operation_id,target_kind,session_id,
    sender_actor_id,content,state,version,created_at,updated_at)
    VALUES($1,$2,$3,'owned',$4,'sender','terminal error','failed',1,now(),now())`, [projectId, messageId, randomUUID(), sessionId]);
  await pool.query(`INSERT INTO session_message_processing(project_id,processing_id,message_id,session_id,
    operation_id,receiver_actor_id,state,native_turn_id,read_only_policy_fingerprint,version,started_at,updated_at)
    VALUES($1,$2,$3,$4,$5,'agent','failed','old-turn',$6,1,now(),now())`,
    [projectId, randomUUID(), messageId, sessionId, randomUUID(), "a".repeat(64)]);
  await pool.query(`UPDATE session_recovery_gate SET phase='blocked',cause_kind='message',cause_id=$3,
    cause_state='failed',version=version+1 WHERE project_id=$1 AND session_id=$2`, [projectId, sessionId, messageId]);
  const gate = await pool.query(`SELECT version FROM session_recovery_gate WHERE project_id=$1 AND session_id=$2`,
    [projectId, sessionId]);
  return { sessionId, threadId, gateVersion: gate.rows[0].version };
}
/** A runtime that observes the failed Turn and accepts the compaction request. */
const runner = (threadId: string) => ({
  nativeAdapter: () => ({}),
  compactionBinding: async () => ({ owner: "evoloop-codex-app-server", resumeProfile: { model } }),
  observeCompaction: async () => ({ threadId, threadStatus: "idle", model, reasoningEffort: "max", latestTurnId: "old-turn",
    latestTurnStatus: "failed", latestTurnCompletedAtUtc: new Date().toISOString(), compactionItemId: null,
    compactionItemCompleted: false }),
  compactThread: async (_binding: unknown, _baseline: string, beforeSend: (id: number) => Promise<void>,
    afterAccepted: (connectionId: string) => Promise<void>) => {
    await beforeSend(1); await afterAccepted("lock-test-connection"); return "compact-turn";
  },
}) as unknown as RuntimeRunner;

before(async () => {
  await migrate(url!, schema);
  await pool.query(`INSERT INTO project(project_id,title,created_at) VALUES($1,'Compaction lock',now())`, [projectId]);
});
after(async () => {
  await pool.end(); await otherPool.end();
  const client = new pg.Client({ connectionString: url! }); await client.connect();
  try { await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } finally { await client.end(); }
});

test("owner compaction does not deadlock a direct input start on the same Session", async () => {
  const { sessionId, threadId, gateVersion } = await blockedSession();
  const command = { inputId: randomUUID(), operationId: randomUUID(), content: "Additional detail", expectedTurnId: null };
  const grant = { projectId, sessionId, senderActorId: "user", receiverRoleId: roleId, receiverActorId: "agent",
    cwd: "/tmp/compact-lock", maxTurns: 2, enabled: true, canSteer: true, canStart: true };
  // The direct input is stopped holding the Session row, before the processing insert that takes the
  // slot lock and the gate. The gate stays blocked, so once it gets there the start is refused.
  const [started, compacted] = await interleave({ connectionString: url!, options, observer: pool, otherApplication,
    projectId, labels: ["direct input start", "owner compaction"],
    stopBefore: text => /INSERT INTO session_message_processing\(/.test(text),
    stopped: gated => new PgDirectInputs(gated).reserve(projectId, sessionId, "user", command, grant, "a".repeat(64))
      .then(() => "started", (error: Error) => /gate blocks native startup/.test(error.message)
        ? "refused by the blocked gate" : Promise.reject(error)),
    other: () => new CompactionMaintenance(otherPool, runner(threadId)).start(maintainer, projectId, sessionId,
      { operationId: randomUUID(), threadId, expectedSessionVersion: 1, expectedGateVersion: gateVersion,
        evidenceRef: "handoff:lock-test", reason: "context near limit" }) });
  assert.equal(started, "refused by the blocked gate");
  assert.equal(compacted.state, "accepted");
  assert.equal(compacted.nativeTurnId, "compact-turn");
});
