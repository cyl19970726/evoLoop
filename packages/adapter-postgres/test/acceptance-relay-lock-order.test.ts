// Lock order between acceptance arrangement (coordinator AcceptanceRelayService.arrange, its own
// transaction) and project writers. Arrangement locks the project row FOR UPDATE and then the Task
// row; a Leader plan update holds the Task row and then key-shares the project row through the
// leader-work change it records.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import pg from "pg";
import type { Principal } from "@evoloop/contracts";
import { migrate } from "../src/index.ts";
import { PgLeaderWorkWriter } from "../src/work-index.ts";
import { AcceptanceRelayService } from "../../../apps/coordinator/src/acceptance-relay/service.ts";
import { interleave } from "./lock-order-fixture.ts";

const url = process.env.TEST_DATABASE_URL;
if (!url || !/^evoloop(?:_[a-z0-9]+)*_test$/.test(decodeURIComponent(new URL(url).pathname.slice(1))))
  throw new Error("Acceptance relay lock tests require a dedicated evoloop test database");
const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
const schema = `el_relay_lock_${suffix}`;
const options = `-c search_path=${schema} -c lock_timeout=20000`;
const otherApplication = `el_relay_lock_other_${suffix}`;
const pool = new pg.Pool({ connectionString: url, options });
const otherPool = new pg.Pool({ connectionString: url, options, application_name: otherApplication });
const relayOn = (relayPool: pg.Pool) => new AcceptanceRelayService({ pool: relayPool, workflow: {} as never,
  messages: {} as never, principals: async () => [], canWrite: () => false, leaderSession: async () => null,
  qualify: async () => null, capabilities: async () => [] } as unknown as ConstructorParameters<typeof AcceptanceRelayService>[0]);
const relay = relayOn(otherPool);
/** The tick's relay writes are private; call them as the tick and message admission do. */
type RelayRecord = Awaited<ReturnType<AcceptanceRelayService["arrange"]>>;
const tickWrites = relay as unknown as {
  note(item: RelayRecord, reason: string): Promise<void>;
  setState(item: RelayRecord, state: RelayRecord["state"], reason: string | null): Promise<void>;
};
const projectId = randomUUID(), roleId = randomUUID(), at = "2026-11-06T00:00:00.000Z";
const reviewer: Principal = { actorId: "reviewer", projectIds: [projectId], permissions: ["read", "write", "review"] };
const hash = (s: string) => createHash("sha256").update(s).digest("hex");

async function inTransaction<T>(run: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try { await client.query("BEGIN"); const result = await run(client); await client.query("COMMIT"); return result; }
  catch (e) { await client.query("ROLLBACK"); throw e; } finally { client.release(); }
}
/** A todo Task with a human acceptance policy and one current Delivery. */
async function deliveredTask(): Promise<{ taskId: string; deliveryId: string }> {
  const taskId = randomUUID(), revisionId = randomUUID(), documentId = randomUUID(), contentId = randomUUID();
  const deliveryId = randomUUID();
  await inTransaction(async client => {
    await client.query(`INSERT INTO process_document(project_id,document_id,title,version,current_revision_id,kind,status)
      VALUES($1,$2,'Delivered',1,$3,'task','draft')`, [projectId, documentId, contentId]);
    await client.query(`INSERT INTO document_revision(project_id,document_id,revision_id,body,format,content_hash,
      author,created_at,reason,media_type,original_name,assets_manifest)
      VALUES($1,$2,$3,'Do it','markdown',$4,'author',$5,'test','text/markdown','task.md','[]'::jsonb)`,
      [projectId, documentId, contentId, hash("Do it"), at]);
    await client.query(`INSERT INTO task(project_id,task_id,version,current_revision_id,title,acceptance,owner,state,
      content_document_id,content_revision_id) VALUES($1,$2,1,$3,'Delivered','accept',$4,'todo',$5,$6)`,
      [projectId, taskId, revisionId, roleId, documentId, contentId]);
    await client.query(`INSERT INTO task_revision(project_id,task_id,revision_id,version,title,acceptance,owner,
      state,content_document_id,content_revision_id,actor_id,reason,created_at)
      VALUES($1,$2,$3,1,'Delivered','accept',$4,'todo',$5,$6,'author','test',$7)`,
      [projectId, taskId, revisionId, roleId, documentId, contentId, at]);
    await client.query(`INSERT INTO task_proposal(project_id,task_id,task_revision_id,consumer,use_required,
      acceptance_mode,acceptance_target,evidence,stop_condition,created_at)
      VALUES($1,$2,$3,'named-human',true,'human_required','human','source','',$4)`, [projectId, taskId, revisionId, at]);
    await client.query(`INSERT INTO delivery(project_id,delivery_id,task_id,task_revision_id,artifact_ref,
      artifact_revision,content_hash,technical_result,technical_evidence,reason,actor_id,created_at)
      VALUES($1,$2,$3,$4,'fixture:report','r1',$5,'passed','fixture','candidate','author',$6)`,
      [projectId, deliveryId, taskId, revisionId, "a".repeat(64), at]);
  });
  return { taskId, deliveryId };
}

before(async () => {
  await migrate(url!, schema);
  await inTransaction(async client => {
    await client.query(`INSERT INTO project(project_id,title,created_at) VALUES($1,'Relay lock',$2)`, [projectId, at]);
    const roleRevision = randomUUID();
    await client.query(`INSERT INTO role_definition(project_id,role_id,version,current_revision_id,state,
      proposed_by,created_at_utc,review_at_utc) VALUES($1,$2,1,$3,'active','author',$4,'2026-12-06T00:00:00.000Z')`,
      [projectId, roleId, roleRevision, at]);
    await client.query(`INSERT INTO role_revision(project_id,role_id,revision_id,version,state,proposal,
      actor_id,reason,created_at_utc,review_at_utc) VALUES($1,$2,$3,1,'active','{}'::jsonb,'author','test',$4,
      '2026-12-06T00:00:00.000Z')`, [projectId, roleId, roleRevision, at]);
  });
});
after(async () => {
  await pool.end(); await otherPool.end();
  const client = new pg.Client({ connectionString: url! }); await client.connect();
  try { await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } finally { await client.end(); }
});

test("acceptance arrangement does not deadlock a Leader plan update on the same Task", async () => {
  const { taskId, deliveryId } = await deliveredTask();
  // The plan writer holds the project lock and the Task row; it is stopped before the plan insert
  // whose leader-work change key-shares the project row.
  const [planned, arranged] = await interleave({ connectionString: url!, options, observer: pool, otherApplication, projectId,
    labels: ["Leader plan update", "acceptance arrangement"], stopBefore: text => /INSERT INTO task_work_plan/.test(text),
    stopped: gated => new PgLeaderWorkWriter(gated).setTaskPlan(reviewer, projectId, { projectId, operationId: randomUUID(),
      taskId, expectedTaskVersion: 1, expectedPlanVersion: 0, plannedStartAt: null, dueAt: null, priority: 1, reason: "plan" }),
    other: () => relay.arrange(reviewer, { projectId, taskId, deliveryId, expectedTaskVersion: 1, operationId: randomUUID(),
      relayId: randomUUID(), stage: "candidate", scopeKey: "human-use", scopeDescription: "Use the fixed report",
      entrypoint: null, publicationRef: null, mode: "human", recipientActorId: "named-human", sessionId: null,
      senderActorId: null, messageId: null, messageOperationId: null, reason: "Task policy" }) });
  assert.equal(planned.status, "applied");
  assert.equal(arranged.state, "pending");
});

// A reassignment holds the project lock and the Task row and then locks the earlier relay row. A tick
// write on that relay row fires leader_result_notice_acceptance_block, whose notice insert key-shares
// the project row; before the tick writes took the project lock, they met the reassignment in a cycle.
for (const [label, write] of [
  ["note", (item: RelayRecord) => tickWrites.note(item, "PUBLICATION_PENDING")],
  ["setState", (item: RelayRecord) => tickWrites.setState(item, "blocked", "ACCEPTANCE_MESSAGE_FAILED")],
] as const) test(`acceptance reassignment does not deadlock the relay tick ${label} on the earlier arrangement`, async () => {
  const { taskId, deliveryId } = await deliveredTask();
  const base = { projectId, taskId, deliveryId, expectedTaskVersion: 1, stage: "candidate" as const, scopeKey: "human-use",
    scopeDescription: "Use the fixed report", entrypoint: null, publicationRef: null, mode: "human" as const,
    recipientActorId: "named-human", sessionId: null, senderActorId: null, messageId: null, messageOperationId: null,
    reason: "Task policy" };
  const earlier = await relayOn(pool).arrange(reviewer, { ...base, operationId: randomUUID(), relayId: randomUUID() });
  const [reassigned] = await interleave({ connectionString: url!, options, observer: pool, otherApplication, projectId,
    labels: ["acceptance reassignment", `relay tick ${label}`],
    stopBefore: text => /FROM task_acceptance_relay WHERE project_id=\$1 AND relay_id=\$2 FOR UPDATE/.test(text),
    stopped: gated => relayOn(gated).arrange(reviewer, { ...base, operationId: randomUUID(), relayId: randomUUID(),
      supersedesRelayId: earlier.relayId, expectedRelayVersion: earlier.version }),
    other: () => write(earlier) });
  assert.equal(reassigned.state, "pending");
  const states = await pool.query(`SELECT state FROM task_acceptance_relay WHERE project_id=$1 AND relay_id=$2`,
    [projectId, earlier.relayId]);
  assert.equal(states.rows[0].state, "superseded");
});
