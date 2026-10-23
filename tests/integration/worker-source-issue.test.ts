import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import pg from "pg";
import { migrate, PostgresUnitOfWork } from "@evoloop/adapter-postgres";
import { WorkflowService } from "@evoloop/core";
import { authorizeWorkerCommand } from "../../apps/coordinator/src/workers/guard.ts";
import { workerGuardFacts } from "../../apps/coordinator/src/workers/facts.ts";
import type { WorkerIdentity } from "../../apps/coordinator/src/workers/types.ts";

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString || !/evoloop.*test/i.test(new URL(connectionString).pathname))
  throw new Error("worker source Issue PG test requires a dedicated evoloop_*_test database");
const schema = `el_source_issue_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
const pool = new pg.Pool({ connectionString, options: `-c search_path=${schema}` });
const id = randomUUID;
const projectId = id(), goalId = id(), stageId = id(), taskId = id(), taskRevisionId = id();
const taskDocumentId = id(), taskDocumentRevisionId = id(), issueId = id(), issueRevisionId = id();
const loopId = id(), inboxId = id(), dispatchId = id(), runId = id(), sessionId = id();
const operationId = id(), sourceEventId = id(), actorId = "worker-original-business";
const now = "2026-10-23T00:00:00Z";
const identity: WorkerIdentity = { principal: { actorId: "worker-current-cognition", projectIds: [projectId], permissions: ["read", "write"] },
  scope: { projectId, loopId, taskId, runId, sessionId, roleId: "planner", kind: "cognition", allowedRoleIds: ["planner", "builder"] } };

before(async () => {
  await migrate(connectionString, schema);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET CONSTRAINTS ALL DEFERRED");
    await client.query("INSERT INTO project(project_id,title,created_at) VALUES($1,'fixture',$2)", [projectId, now]);
    await client.query(`INSERT INTO project_goal(project_id,goal_id,version,outcome,constraints,consumer,authority,scope,owner,actor_id,created_at)
      VALUES($1,$2,1,'o','c','c','a','s','planner','fixture',$3)`, [projectId, goalId, now]);
    await client.query(`INSERT INTO project_stage(project_id,stage_id,goal_id,version,deliverable,learning_question,state,actor_id,created_at)
      VALUES($1,$2,$3,1,'d','q','active','fixture',$4)`, [projectId, stageId, goalId, now]);
    await client.query(`INSERT INTO process_document(project_id,document_id,title,version,current_revision_id,kind,status)
      VALUES($1,$2,'task',1,$3,'task','draft')`, [projectId, taskDocumentId, taskDocumentRevisionId]);
    await client.query(`INSERT INTO document_revision(project_id,document_id,revision_id,body,format,content_hash,author,created_at,reason)
      VALUES($1,$2,$3,'task','markdown',$4,'fixture',$5,'initial')`, [projectId, taskDocumentId, taskDocumentRevisionId, "a".repeat(64), now]);
    await client.query(`INSERT INTO task(project_id,task_id,version,current_revision_id,title,content_document_id,content_revision_id,
      acceptance,owner,state) VALUES($1,$2,1,$3,'task',$4,$5,'accept','builder','todo')`,
      [projectId, taskId, taskRevisionId, taskDocumentId, taskDocumentRevisionId]);
    await client.query(`INSERT INTO task_revision(project_id,task_id,revision_id,version,title,content_document_id,content_revision_id,
      acceptance,owner,state,actor_id,reason,created_at) VALUES($1,$2,$3,1,'task',$4,$5,'accept','builder','todo','fixture','initial',$6)`,
      [projectId, taskId, taskRevisionId, taskDocumentId, taskDocumentRevisionId, now]);
    await client.query(`INSERT INTO task_proposal(project_id,task_id,task_revision_id,stage_id,consumer,use_required,evidence,stop_condition,created_at)
      VALUES($1,$2,$3,$4,'owner',false,'evidence','stop',$5)`, [projectId, taskId, taskRevisionId, stageId, now]);
    await client.query(`INSERT INTO process_document(project_id,document_id,title,version,current_revision_id,kind,status,
      origin_task_id,origin_task_revision_id) VALUES($1,$2,'issue',1,$3,'issue','draft',$4,$5)`,
      [projectId, issueId, issueRevisionId, taskId, taskRevisionId]);
    await client.query(`INSERT INTO document_revision(project_id,document_id,revision_id,body,format,content_hash,author,created_at,reason)
      VALUES($1,$2,$3,'issue','markdown',$4,$5,$6,'initial')`, [projectId, issueId, issueRevisionId, "b".repeat(64), actorId, now]);
    await client.query(`INSERT INTO operation_journal(project_id,operation_id,actor_id,command_hash,command_type,result,created_at)
      VALUES($1,$2,$3,'hash','document.create',$4,$5)`, [projectId, operationId, actorId,
      JSON.stringify({ status: "applied", entityId: issueId, revisionId: issueRevisionId }), now]);
    await client.query(`INSERT INTO outbox_event(project_id,event_id,operation_id,effect_key,kind,entity_id,version,created_at)
      VALUES($1,$2,$3,'document','document',$4,1,$5)`, [projectId, sourceEventId, operationId, issueId, now]);
    await client.query(`INSERT INTO orchestration_loop(project_id,loop_id,version,state,data) VALUES($1,$2,1,'active',$3)`,
      [projectId, loopId, JSON.stringify({ projectId, id: loopId, state: "active", goalId, stageId,
        cognitiveRoleId: "planner", allowedBusinessRoleIds: ["builder"] })]);
    await client.query(`INSERT INTO orchestration_inbox(project_id,inbox_id,loop_id,source_event_id,recipient_role_id,purpose,version,state,data)
      VALUES($1,$2,$3,$4,'planner','cognitive_review',1,'acknowledged','{}')`, [projectId, inboxId, loopId, sourceEventId]);
    await client.query(`INSERT INTO orchestration_dispatch(project_id,dispatch_id,loop_id,inbox_id,task_id,task_version,version,state,data)
      VALUES($1,$2,$3,$4,$5,1,1,'accepted',$6)`, [projectId, dispatchId, loopId, inboxId, taskId,
      JSON.stringify({ runtimeRunId: runId, recipientRoleId: "planner", sourceEventId })]);
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
});
after(async () => {
  await pool.end();
  const client = new pg.Client({ connectionString });
  await client.connect();
  try { await client.query(`DROP SCHEMA "${schema}" CASCADE`); } finally { await client.end(); }
});

test("only the exact current dispatch source Issue can be linked, even before adoption", async () => {
  const unrelatedIssueId = id(), unrelatedRevisionId = id(), unrelatedOperationId = id();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET CONSTRAINTS ALL DEFERRED");
    await client.query(`INSERT INTO process_document(project_id,document_id,title,version,current_revision_id,kind,status,
      origin_task_id,origin_task_revision_id) VALUES($1,$2,'other issue',1,$3,'issue','draft',$4,$5)`,
      [projectId, unrelatedIssueId, unrelatedRevisionId, taskId, taskRevisionId]);
    await client.query(`INSERT INTO document_revision(project_id,document_id,revision_id,body,format,content_hash,author,created_at,reason)
      VALUES($1,$2,$3,'other issue','markdown',$4,$5,$6,'initial')`,
      [projectId, unrelatedIssueId, unrelatedRevisionId, "c".repeat(64), actorId, now]);
    await client.query(`INSERT INTO operation_journal(project_id,operation_id,actor_id,command_hash,command_type,result,created_at)
      VALUES($1,$2,$3,'hash','document.create',$4,$5)`, [projectId, unrelatedOperationId, actorId,
      JSON.stringify({ status: "applied", entityId: unrelatedIssueId, revisionId: unrelatedRevisionId }), now]);
    await client.query(`INSERT INTO outbox_event(project_id,event_id,operation_id,effect_key,kind,entity_id,version,created_at)
      VALUES($1,$2,$3,'document','document',$4,1,$5)`, [projectId, id(), unrelatedOperationId, unrelatedIssueId, now]);
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  const command = (documentId: string) => ({ type: "task.create", projectId, operationId: id(),
    taskId: id(), owner: "builder", stageId, documentIds: [documentId] });
  const facts = workerGuardFacts(pool, identity);
  assert.equal(await facts.sourceIssueDocumentRevision?.(issueId, issueRevisionId), true);
  assert.equal(await authorizeWorkerCommand(identity, command(issueId), facts), true);
  assert.equal(await authorizeWorkerCommand(identity, { ...command(issueId), type: "task.update", taskId, owner: "builder" }, facts), true);
  assert.equal(await authorizeWorkerCommand(identity, command(unrelatedIssueId), facts), false);
  assert.equal(await facts.sourceIssueDocumentRevision?.(unrelatedIssueId, unrelatedRevisionId), false);
  assert.equal(await authorizeWorkerCommand(identity, command(id()), facts), false);
  assert.equal(await authorizeWorkerCommand({ ...identity, scope: { ...identity.scope, kind: "business", roleId: "builder" } },
    command(issueId), facts), false);
  const otherRun = { ...identity, scope: { ...identity.scope, runId: id() } };
  assert.equal(await authorizeWorkerCommand(otherRun, command(issueId), workerGuardFacts(pool, otherRun)), false);
  assert.equal(await authorizeWorkerCommand({ ...identity, scope: { ...identity.scope, projectId: id() } },
    command(issueId), facts), false);
});

test("core start atomically rejects an older fixed Issue when adoption drifts", async () => {
  const owner = { actorId: "source-test-owner", projectIds: [projectId], permissions: ["read", "write", "review"] as Array<"read" | "write" | "review"> };
  const workflow = new WorkflowService({ uow: new PostgresUnitOfWork(pool),
    clock: { now: () => now }, ids: { next: id },
    hasher: { hash: (body: string) => createHash("sha256").update(body).digest("hex") } });
  const published = await workflow.execute(owner, { type: "document.publish", projectId, operationId: id(),
    documentId: issueId, expectedVersion: 1, revisionId: issueRevisionId, reason: "Accept original source" });
  assert.equal(published.status, "applied");
  const childId = id();
  const created = await workflow.execute(owner, { type: "task.create", projectId, operationId: id(), taskId: childId,
    stageId, title: "Fix source", content: "Use fixed issue", acceptance: "Verify repair", owner: "builder",
    consumer: "owner", evidence: "Check result", stopCondition: "Done", documentIds: [issueId] });
  assert.equal(created.status, "applied");
  const revised = await workflow.execute(owner, { type: "document.revise", projectId, operationId: id(),
    documentId: issueId, expectedVersion: 2, body: "changed issue", reason: "New candidate" });
  assert.equal(revised.status, "applied");
  const candidate = await workflow.getDocument(owner, projectId, issueId);
  const republished = await workflow.execute(owner, { type: "document.publish", projectId, operationId: id(),
    documentId: issueId, expectedVersion: 3, revisionId: candidate.current.id, reason: "New adoption" });
  assert.equal(republished.status, "applied");
  const started = await workflow.execute(owner, { type: "task.start", projectId, operationId: id(),
    taskId: childId, expectedVersion: 1, basis: [{ documentId: issueId, revisionId: issueRevisionId }],
    reason: "Pin original source" });
  assert.equal(started.status === "rejected" ? started.code : null, "BASIS_CHANGED");
  const child = await workflow.getTask(owner, projectId, childId);
  assert.equal(child.task.state, "todo");
  assert.equal(child.basis, null);
});
