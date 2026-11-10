// Lock order around one Session: owner compaction (coordinator CompactionMaintenance.start), direct input
// starts, connector admission and execution profile adoption. Each opens its own transaction or runs in a
// core transaction; all now take the project lock first.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import pg from "pg";
import type { Principal } from "@evoloop/contracts";
import type { ConnectorRoute } from "@evoloop/contracts/message-connectors";
import type { ExecutionProfileRevision } from "@evoloop/contracts/session-recovery";
import { migrate, PgConnectorMessageLinks, PgConnectorRoutes, PostgresUnitOfWork } from "../src/index.ts";
import { PgDirectInputs } from "../src/direct-input.ts";
import type { PgSessionRecovery } from "../src/session-recovery.ts";
import { CompactionMaintenance } from "../../../apps/coordinator/src/runtime/compaction.ts";
import type { RuntimeRunner } from "../../../apps/coordinator/src/runtime/runner.ts";
import { interleave } from "./lock-order-fixture.ts";

const url = process.env.TEST_DATABASE_URL;
if (!url || !/^evoloop(?:_[a-z0-9]+)*_test$/.test(decodeURIComponent(new URL(url).pathname.slice(1))))
  throw new Error("Session lock tests require a dedicated evoloop test database");
const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
const schema = `el_session_lock_${suffix}`;
const options = `-c search_path=${schema} -c lock_timeout=20000`;
const otherApplication = `el_session_lock_other_${suffix}`;
const pool = new pg.Pool({ connectionString: url, options });
const otherPool = new pg.Pool({ connectionString: url, options, application_name: otherApplication });
const core = new PostgresUnitOfWork(otherPool);
const projectId = randomUUID(), roleId = randomUUID(), model = "gpt-lock-test";
const maintainer: Principal = { actorId: "maintainer", projectIds: [projectId], permissions: ["read", "write", "review"] };

/** A ready full-profile Session with an active execution profile. */
async function readySession(): Promise<{ sessionId: string; threadId: string }> {
  const sessionId = randomUUID(), threadId = randomUUID();
  await pool.query(`INSERT INTO runtime_session(project_id,session_id,role_id,cwd,authorization_scope,model,sandbox,
    approval_policy,state,version,native_thread_id,native_session_id,operation_id,actor_id,created_at,updated_at)
    VALUES($1,$2,$3,'/tmp/session-lock','project',$4,'danger-full-access','never','ready',1,$5,$6,$7,'agent',now(),now())`,
    [projectId, sessionId, roleId, model, threadId, `native-${sessionId}`, randomUUID()]);
  await pool.query(`UPDATE session_execution_profile SET activation_state='active',active_revision_id=revision_id
    WHERE project_id=$1 AND session_id=$2`, [projectId, sessionId]);
  return { sessionId, threadId };
}
/** Native Turn IDs are unique per project, so each Session's failed Turn has its own. */
const failedTurn = (sessionId: string) => `turn-${sessionId}`;
/** Block the gate with a failed message Turn, as compaction requires. */
async function blockGate(sessionId: string): Promise<number> {
  const messageId = randomUUID();
  await pool.query(`INSERT INTO session_message(project_id,message_id,operation_id,target_kind,session_id,
    sender_actor_id,content,state,version,created_at,updated_at)
    VALUES($1,$2,$3,'owned',$4,'sender','terminal error','failed',1,now(),now())`, [projectId, messageId, randomUUID(), sessionId]);
  await pool.query(`INSERT INTO session_message_processing(project_id,processing_id,message_id,session_id,
    operation_id,receiver_actor_id,state,native_turn_id,read_only_policy_fingerprint,version,started_at,updated_at)
    VALUES($1,$2,$3,$4,$5,'agent','failed',$7,$6,1,now(),now())`,
    [projectId, randomUUID(), messageId, sessionId, randomUUID(), "a".repeat(64), failedTurn(sessionId)]);
  await pool.query(`UPDATE session_recovery_gate SET phase='blocked',cause_kind='message',cause_id=$3,
    cause_state='failed',version=version+1 WHERE project_id=$1 AND session_id=$2`, [projectId, sessionId, messageId]);
  const gate = await pool.query(`SELECT version FROM session_recovery_gate WHERE project_id=$1 AND session_id=$2`,
    [projectId, sessionId]);
  return gate.rows[0].version;
}
/** An active standard connector route to the Session, and a trusted admission for it. */
async function connectorRoute(sessionId: string, threadId: string) {
  const routes = new PgConnectorRoutes(pool);
  const route: ConnectorRoute = { projectId, bindingId: randomUUID(),
    source: { provider: "wechat", connectionId: "lock-connection", conversationId: `lock-${sessionId}` },
    conversationLabel: "Lock conversation", conversationKind: "group", targetSessionId: sessionId, targetThreadId: threadId,
    targetActorId: "receiver", senderActorId: "gateway", owner: "owner-a", epoch: 7, sessionRef: "wx-session-a",
    state: "disabled", mode: "standard", readScope: "project", sendTargets: [`lock-${sessionId}`],
    senderIds: ["participant-a"], internalTargets: [],
    capabilities: { history: true, search: false, subscribe: true, sendText: false, sendMedia: false, receipt: "none" },
    policyHash: "a".repeat(64) };
  await routes.create(route, randomUUID(), "lead");
  await routes.update({ ...route, version: 2, state: "active" }, 1, randomUUID(), "lead");
  return { projectId, bindingId: route.bindingId, routeVersion: 2,
    source: { source: route.source, deliveryId: 41, cursorStart: 10, cursorEnd: 12, eventCursor: 11,
      participantId: "participant-a", replyToEventCursor: null },
    messageId: randomUUID(), messageOperationId: randomUUID(), decisionId: randomUUID(), content: "hello",
    gateway: { owner: route.owner, epoch: route.epoch, sessionRef: route.sessionRef } };
}
/** A runtime that observes the failed Turn and accepts the compaction request. */
const runner = (threadId: string, turnId: string) => ({
  nativeAdapter: () => ({}),
  compactionBinding: async () => ({ owner: "evoloop-codex-app-server", resumeProfile: { model } }),
  observeCompaction: async () => ({ threadId, threadStatus: "idle", model, reasoningEffort: "max", latestTurnId: turnId,
    latestTurnStatus: "failed", latestTurnCompletedAtUtc: new Date().toISOString(), compactionItemId: null,
    compactionItemCompleted: false }),
  compactThread: async (_binding: unknown, _baseline: string, beforeSend: (id: number) => Promise<void>,
    afterAccepted: (connectionId: string) => Promise<void>) => {
    await beforeSend(1); await afterAccepted("lock-test-connection"); return "compact-turn";
  },
}) as unknown as RuntimeRunner;
const compact = (sessionId: string, threadId: string, gateVersion: number) => () =>
  new CompactionMaintenance(otherPool, runner(threadId, failedTurn(sessionId))).start(maintainer, projectId, sessionId,
    { operationId: randomUUID(), threadId, expectedSessionVersion: 1, expectedGateVersion: gateVersion,
      evidenceRef: "handoff:lock-test", reason: "context near limit" });
// Stopped after sharing the route and Session rows, before the queued message takes the slot lock.
const beforeQueuedMessage = (text: string) => /INSERT INTO session_message\(/.test(text);

before(async () => {
  await migrate(url!, schema);
  await pool.query(`INSERT INTO project(project_id,title,created_at) VALUES($1,'Session lock',now())`, [projectId]);
});
after(async () => {
  await pool.end(); await otherPool.end();
  const client = new pg.Client({ connectionString: url! }); await client.connect();
  try { await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } finally { await client.end(); }
});

test("owner compaction does not deadlock a direct input start on the same Session", async () => {
  const { sessionId, threadId } = await readySession(), gateVersion = await blockGate(sessionId);
  const command = { inputId: randomUUID(), operationId: randomUUID(), content: "Additional detail", expectedTurnId: null };
  const grant = { projectId, sessionId, senderActorId: "user", receiverRoleId: roleId, receiverActorId: "agent",
    cwd: "/tmp/session-lock", maxTurns: 2, enabled: true, canSteer: true, canStart: true };
  // The direct input holds the Session row, before the processing insert that takes the slot lock and
  // the gate. The gate stays blocked, so once it gets there the start is refused.
  const [started, compacted] = await interleave({ connectionString: url!, options, observer: pool, otherApplication,
    projectId, labels: ["direct input start", "owner compaction"],
    stopBefore: text => /INSERT INTO session_message_processing\(/.test(text),
    stopped: gated => new PgDirectInputs(gated).reserve(projectId, sessionId, "user", command, grant, "a".repeat(64))
      .then(() => "started", (error: Error) => /gate blocks native startup/.test(error.message)
        ? "refused by the blocked gate" : Promise.reject(error)),
    other: compact(sessionId, threadId, gateVersion) });
  assert.equal(started, "refused by the blocked gate");
  assert.equal(compacted.state, "accepted");
  assert.equal(compacted.nativeTurnId, "compact-turn");
});

test("owner compaction does not deadlock connector admission to the same Session", async () => {
  const { sessionId, threadId } = await readySession(), gateVersion = await blockGate(sessionId);
  const admission = await connectorRoute(sessionId, threadId);
  // Compaction must not hold the slot lock while it waits for the Session row the admission shares.
  const [link, compacted] = await interleave({ connectionString: url!, options, observer: pool, otherApplication,
    projectId, labels: ["connector admission", "owner compaction"], stopBefore: beforeQueuedMessage,
    stopped: gated => new PgConnectorMessageLinks(gated).admitTrusted(admission),
    other: compact(sessionId, threadId, gateVersion) });
  assert.equal(link.messageId, admission.messageId);
  assert.equal(compacted.state, "accepted");
});

test("connector admission does not deadlock an execution profile adoption on the same Session", async () => {
  const { sessionId, threadId } = await readySession();
  const admission = await connectorRoute(sessionId, threadId);
  const current = (await pool.query(`SELECT r.* FROM session_execution_profile p JOIN session_execution_profile_revision r
    ON r.project_id=p.project_id AND r.session_id=p.session_id AND r.revision_id=p.revision_id
    WHERE p.project_id=$1 AND p.session_id=$2`, [projectId, sessionId])).rows[0];
  const revision: ExecutionProfileRevision = { projectId, sessionId, revisionId: randomUUID(), version: current.version + 1,
    previousRevisionId: current.revision_id, model: "gpt-lock-test-next", reasoningEffort: current.reasoning_effort,
    sandbox: "danger-full-access", approvalPolicy: "never", cwd: current.cwd, authorizationScope: current.authorization_scope,
    provenance: "revised", operationId: randomUUID(), actorId: "maintainer", reason: "adopt a new model",
    evidenceRef: null, createdAt: new Date().toISOString() };
  // Adoption (a core transaction) takes the slot lock and the gate, then waits for the Session row the
  // admission shares; the admission then needs the slot lock for its queued message.
  const [link] = await interleave({ connectionString: url!, options, observer: pool, otherApplication, projectId,
    labels: ["connector admission", "execution profile adoption"], stopBefore: beforeQueuedMessage,
    stopped: gated => new PgConnectorMessageLinks(gated).admitTrusted(admission),
    other: () => core.transaction(projectId, tx =>
      (tx as unknown as { recovery: PgSessionRecovery }).recovery.adoptExecutionProfile(revision, 1)) });
  assert.equal(link.messageId, admission.messageId);
  const profile = await pool.query(`SELECT revision_id FROM session_execution_profile WHERE project_id=$1 AND session_id=$2`,
    [projectId, sessionId]);
  assert.equal(profile.rows[0].revision_id, revision.revisionId);
});
