import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import pg from "pg";
import { WorkflowService } from "@evoloop/core";
import type { Principal } from "@evoloop/contracts";
import { migrate, PostgresUnitOfWork } from "../src/index.ts";

const url = process.env.TEST_DATABASE_URL;
if (!url || !/^evoloop(?:_[a-z0-9]+)*_test$/.test(decodeURIComponent(new URL(url).pathname.slice(1))))
  throw new Error("Task close acceptance tests require a dedicated evoloop test database");

const schema = `el_close_accept_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
const pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}` });
const uow = new PostgresUnitOfWork(pool);
const workflow = new WorkflowService({
  uow, clock: { now: () => "2026-11-11T00:00:00.000Z" },
  ids: { next: randomUUID }, hasher: { hash: (value: string) => createHash("sha256").update(value).digest("hex") },
});
const projectId = randomUUID();
const reviewer: Principal = { actorId: "reviewer", projectIds: [projectId], permissions: ["read", "write", "review"] };

before(async () => {
  await migrate(url!, schema);
  await pool.query("INSERT INTO project(project_id,title,created_at) VALUES($1,'Task close acceptance',$2)",
    [projectId, "2026-11-11T00:00:00.000Z"]);
});

after(async () => {
  await pool.end();
  const cleanup = new pg.Client({ connectionString: url });
  await cleanup.connect();
  try { await cleanup.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } finally { await cleanup.end(); }
});

async function closingFixture(options: { linked?: boolean; unlinkedCandidate?: boolean; linkedCandidate?: boolean } = {}): Promise<{
  taskId: string; deliveryId: string; observationId: string; relayId: string;
}> {
  const taskId = randomUUID(), revisionId = randomUUID(), basisId = randomUUID();
  const documentId = randomUUID(), documentRevisionId = randomUUID();
  const sessionId = randomUUID(), runId = randomUUID(), deliveryId = randomUUID();
  const observationId = randomUUID(), relayId = randomUUID(), messageId = randomUUID();
  const consumer = "acceptance-agent";
  const body = "# Close fixture";
  const hash = createHash("sha256").update(body).digest("hex");
  const at = "2026-11-11T00:00:00.000Z";
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`INSERT INTO process_document(project_id,document_id,title,version,current_revision_id,
      kind,status) VALUES($1,$2,'Close fixture',1,$3,'task','draft')`,
      [projectId, documentId, documentRevisionId]);
    await client.query(`INSERT INTO document_revision(project_id,document_id,revision_id,body,format,content_hash,
      author,created_at,reason,media_type,original_name,assets_manifest)
      VALUES($1,$2,$3,$4,'markdown',$5,'author',$6,'fixture','text/markdown','task.md','[]'::jsonb)`,
      [projectId, documentId, documentRevisionId, body, hash, at]);
    await client.query(`INSERT INTO task(project_id,task_id,version,current_revision_id,title,acceptance,owner,state,
      content_document_id,content_revision_id) VALUES($1,$2,1,$3,'Close fixture','accept','worker','in_progress',$4,$5)`,
      [projectId, taskId, revisionId, documentId, documentRevisionId]);
    await client.query(`INSERT INTO task_revision(project_id,task_id,revision_id,version,title,acceptance,owner,
      state,content_document_id,content_revision_id,basis_set_id,actor_id,reason,created_at)
      VALUES($1,$2,$3,1,'Close fixture','accept','worker','in_progress',$4,$5,$6,'worker','started',$7)`,
      [projectId, taskId, revisionId, documentId, documentRevisionId, basisId, at]);
    await client.query(`INSERT INTO basis_set(project_id,task_id,task_revision_id,basis_set_id,sealed)
      VALUES($1,$2,$3,$4,false)`, [projectId, taskId, revisionId, basisId]);
    await client.query(`INSERT INTO basis_member(project_id,task_id,task_revision_id,basis_set_id,document_id,
      document_revision_id) VALUES($1,$2,$3,$4,$5,$6)`,
      [projectId, taskId, revisionId, basisId, documentId, documentRevisionId]);
    await client.query(`UPDATE basis_set SET sealed=true WHERE project_id=$1 AND task_id=$2
      AND task_revision_id=$3 AND basis_set_id=$4`, [projectId, taskId, revisionId, basisId]);
    await client.query(`INSERT INTO task_proposal(project_id,task_id,task_revision_id,consumer,use_required,
      acceptance_mode,acceptance_target,evidence,stop_condition,created_at)
      VALUES($1,$2,$3,$4,true,'independent_agent','business_session','source','stop',$5)`,
      [projectId, taskId, revisionId, consumer, at]);
    await client.query(`INSERT INTO runtime_session(project_id,session_id,role_id,cwd,authorization_scope,
      sandbox,approval_policy,state,version,native_thread_id,native_session_id,operation_id,actor_id,created_at,updated_at)
      VALUES($1,$2,'worker','/tmp/close-fixture','project','danger-full-access','never','ready',1,$3,$4,$5,'worker',$6,$6)`,
      [projectId, sessionId, `thread-${sessionId}`, `native-${sessionId}`, randomUUID(), at]);
    await client.query(`INSERT INTO runtime_run(project_id,run_id,task_id,task_revision_id,basis_set_id,session_id,
      operation_id,input,input_hash,state,version,native_turn_id,actor_id,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,'fixture',$8,'completed',2,$9,'worker',$10,$10)`,
      [projectId, runId, taskId, revisionId, basisId, sessionId, randomUUID(), hash, `turn-${runId}`, at]);
    await client.query(`INSERT INTO delivery(project_id,delivery_id,task_id,task_revision_id,run_id,
      source_run_version,submitted_by_actor_id,artifact_ref,artifact_revision,content_hash,technical_result,
      technical_evidence,reason,actor_id,created_at)
      VALUES($1,$2,$3,$4,$5,2,'worker','repo:fixture','head',$6,'passed','checks','done','worker',$7)`,
      [projectId, deliveryId, taskId, revisionId, runId, hash, at]);
    await client.query(`INSERT INTO task_acceptance_relay(project_id,relay_id,operation_id,request_hash,task_id,
      task_revision_id,delivery_id,stage,scope_key,scope_description,reason,mode,recipient_actor_id,session_id,
      native_thread_id,role_id,sender_actor_id,message_id,message_operation_id,state,arranged_by,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,'formal','fixture-use','Use the fixed result','acceptance','session',$8,$9,$10,
      'acceptance','reviewer',$11,$12,'linked','reviewer',$13,$13)`,
      [projectId, relayId, randomUUID(), "a".repeat(64), taskId, revisionId, deliveryId, consumer, sessionId,
        `thread-${sessionId}`, messageId, randomUUID(), at]);
    if (options.unlinkedCandidate) {
      const candidateRelayId = randomUUID();
      await client.query(`INSERT INTO task_acceptance_relay(project_id,relay_id,operation_id,request_hash,task_id,
        task_revision_id,delivery_id,stage,scope_key,scope_description,reason,mode,recipient_actor_id,session_id,
        native_thread_id,role_id,sender_actor_id,message_id,message_operation_id,state,arranged_by,created_at,updated_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,'candidate','fixture-candidate','Use the candidate result','candidate',
        'session',$8,$9,$10,'acceptance','reviewer',$11,$12,'linked','reviewer',$13,$13)`,
        [projectId, candidateRelayId, randomUUID(), "b".repeat(64), taskId, revisionId, deliveryId, consumer,
          sessionId, `thread-${sessionId}`, randomUUID(), randomUUID(), at]);
      if (options.linkedCandidate) {
        const candidateObservationId = randomUUID();
        await client.query(`INSERT INTO consumer_observation(project_id,observation_id,task_id,delivery_id,observer,
          observer_kind,result,evidence,reason,actor_id,created_at)
          VALUES($1,$2,$3,$4,$5,'agent','used','candidate result','used',$5,$6)`,
          [projectId, candidateObservationId, taskId, deliveryId, consumer, at]);
        await client.query(`INSERT INTO task_acceptance_observation_link(project_id,relay_id,observation_id,
          operation_id,actor_id,evidence_level,linked_at) VALUES($1,$2,$3,$4,$5,'actor_message_turn',$6)`,
          [projectId, candidateRelayId, candidateObservationId, randomUUID(), consumer, at]);
      }
    }
    await client.query(`INSERT INTO consumer_observation(project_id,observation_id,task_id,delivery_id,observer,
      observer_kind,result,evidence,reason,actor_id,created_at)
      VALUES($1,$2,$3,$4,$5,'agent','used','read result','used',$5,$6)`,
      [projectId, observationId, taskId, deliveryId, consumer, at]);
    if (options.linked !== false) await client.query(`INSERT INTO task_acceptance_observation_link(project_id,
      relay_id,observation_id,operation_id,actor_id,evidence_level,linked_at)
      VALUES($1,$2,$3,$4,$5,'actor_message_turn',$6)`,
      [projectId, relayId, observationId, randomUUID(), consumer, at]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  return { taskId, deliveryId, observationId, relayId };
}

test("task.close applies with the latest passed Delivery and linked independent use", async () => {
  const fixture = await closingFixture();
  const close = await workflow.execute(reviewer, {
    type: "task.close", projectId, operationId: randomUUID(), taskId: fixture.taskId,
    expectedVersion: 1, deliveryId: fixture.deliveryId, acceptanceResult: "met",
    acceptanceEvidence: "Current Delivery was independently used", reason: "Accept fixture",
  });
  assert.equal(close.status, "applied", JSON.stringify(close));
  const task = await pool.query("SELECT state FROM task WHERE project_id=$1 AND task_id=$2",
    [projectId, fixture.taskId]);
  assert.equal(task.rows[0].state, "done");
});

test("task.close applies when an earlier candidate arrangement has no observation link", async () => {
  const fixture = await closingFixture({ unlinkedCandidate: true });
  const close = await workflow.execute(reviewer, {
    type: "task.close", projectId, operationId: randomUUID(), taskId: fixture.taskId,
    expectedVersion: 1, deliveryId: fixture.deliveryId, acceptanceResult: "met",
    acceptanceEvidence: "Formal arrangement was independently used", reason: "Accept after formal review",
  });
  assert.equal(close.status, "applied", JSON.stringify(close));
});

test("task.close records a known rejection when the effective formal arrangement is unlinked", async () => {
  const fixture = await closingFixture({ linked: false });
  const operationId = randomUUID();
  const close = await workflow.execute(reviewer, {
    type: "task.close", projectId, operationId, taskId: fixture.taskId,
    expectedVersion: 1, deliveryId: fixture.deliveryId, acceptanceResult: "met",
    acceptanceEvidence: "Unlinked formal arrangement must not close", reason: "Reject fixture",
  });
  assert.equal(close.status, "rejected", JSON.stringify(close));
  assert.equal(close.status === "rejected" ? close.code : null, "STORAGE_REJECTED");
  assert.match(close.status === "rejected" ? close.message : "", /SQLSTATE 23514/);
  const operation = await workflow.getOperation(reviewer, projectId, operationId);
  assert.equal(operation?.result.status, "rejected");
  const task = await pool.query("SELECT state FROM task WHERE project_id=$1 AND task_id=$2",
    [projectId, fixture.taskId]);
  assert.equal(task.rows[0].state, "in_progress");
});

test("a linked candidate does not satisfy an unlinked active formal arrangement", async () => {
  const fixture = await closingFixture({ linked: false, unlinkedCandidate: true, linkedCandidate: true });
  const close = await workflow.execute(reviewer, {
    type: "task.close", projectId, operationId: randomUUID(), taskId: fixture.taskId,
    expectedVersion: 1, deliveryId: fixture.deliveryId, acceptanceResult: "met",
    acceptanceEvidence: "Candidate use cannot replace formal use", reason: "Reject fixture",
  });
  assert.equal(close.status === "rejected" ? close.code : null, "STORAGE_REJECTED");
});
