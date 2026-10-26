import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { after, before, test } from "node:test";
import pg from "pg";
import { migrate, PostgresUnitOfWork } from "../src/index.ts";
import { PgSessionAssignments } from "../src/session-assignments.ts";
import { RuntimeWorkflowService, WorkflowService } from "@evoloop/core";
import { canonicalTaskInputJson, taskInputSignature } from "../../core/src/task-input.ts";

const url = process.env.TEST_DATABASE_URL;
if (!url || !/^evoloop(?:_[a-z0-9]+)*_test$/.test(decodeURIComponent(new URL(url).pathname.slice(1))))
  throw new Error("Session assignment storage test requires a dedicated evoloop_*_test database");
const schema = `el_assign_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
const pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}` });
const projectId = randomUUID(), roleId = randomUUID(), taskId = randomUUID(), taskRevisionId = randomUUID();
const link1 = randomUUID(), link2 = randomUUID(), now = "2026-10-26T00:00:00.000Z";
const documentId = randomUUID(), contentRevisionId = randomUUID();

before(async () => {
  await migrate(url, schema);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("INSERT INTO project(project_id,title,created_at) VALUES($1,'Assignment test',$2)", [projectId, now]);
    const roleRevisionId = randomUUID();
    await client.query(`INSERT INTO role_definition(project_id,role_id,version,current_revision_id,state,proposed_by,created_at_utc,review_at_utc)
      VALUES($1,$2,1,$3,'active','lead',$4,$4)`, [projectId, roleId, roleRevisionId, now]);
    await client.query(`INSERT INTO role_revision(project_id,role_id,revision_id,version,state,proposal,actor_id,reason,created_at_utc,review_at_utc)
      VALUES($1,$2,$3,1,'active',$4::jsonb,'lead','fixture',$5,$5)`,
      [projectId, roleId, roleRevisionId, JSON.stringify({ title: "Role", roleClass: "business" }), now]);
    for (const linkId of [link1, link2]) {
      await client.query("INSERT INTO role_host_link(project_id,link_id,role_id,version,state) VALUES($1,$2,$3,1,'registered')",
        [projectId, linkId, roleId]);
      await client.query(`INSERT INTO role_host_link_revision(project_id,link_id,version,role_id,host,claimed_capabilities,
        verified_capabilities,state,actor_id,reason,created_at_utc)
        VALUES($1,$2,1,$3,$4::jsonb,'[]'::jsonb,'[]'::jsonb,'registered','lead','fixture',$5)`,
        [projectId, linkId, roleId, JSON.stringify({ kind: "external", provider: "codex-desktop", ref: `chat:${linkId}` }), now]);
    }
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  await new PostgresUnitOfWork(pool).transaction(projectId, async tx => {
    await tx.insertDocument({ projectId, id: documentId, title: "Task", version: 1,
      currentRevisionId: contentRevisionId, adoptedRevisionId: null, kind: "task", status: "draft" });
    await tx.insertDocumentRevision({ projectId, documentId, id: contentRevisionId, body: "Fixed task", format: "markdown",
      mediaType: "text/markdown", originalName: "task.md", payloadRef: null, entrypoint: null, assetsManifest: [],
      contentHash: "0".repeat(64), author: "lead", createdAt: now, previousRevisionId: null, reason: "fixture" });
    await tx.insertTask({ projectId, id: taskId, version: 1, currentRevisionId: taskRevisionId,
      title: "Task", content: "Fixed task", contentDocumentId: documentId, contentRevisionId,
      kind: null, acceptance: "Accepted", owner: roleId, state: "todo" });
    await tx.insertTaskRevision({ projectId, taskId, id: taskRevisionId, version: 1,
      title: "Task", content: "Fixed task", contentDocumentId: documentId, contentRevisionId,
      kind: null, acceptance: "Accepted", owner: roleId, state: "todo", basisSetId: null,
      actorId: "lead", reason: "fixture", createdAt: now });
  });
});

test("official queue and direct Run commands cannot bypass a concrete external assignment", async () => {
  const uow = new PostgresUnitOfWork(pool, { grant: async () => true, lead: async () => true, binding: async () => true,
    input: async (reader, id) => canonicalTaskInputJson(await taskInputSignature(reader, (await reader.getTask(id))!)) });
  const clock = { now: () => new Date().toISOString() }, ids = { next: randomUUID };
  const workflow = new WorkflowService({ uow, clock, ids, hasher: { hash: value => createHash("sha256").update(value).digest("hex") } });
  const runtime = new RuntimeWorkflowService({ uow, clock, ids });
  const principal = { actorId: "lead", projectIds: [projectId], permissions: ["read", "write", "review"] as Array<"read" | "write" | "review"> };
  const tid = randomUUID(), sid = randomUUID(), qid = randomUUID(), eid = randomUUID();
  const apply = (command: Parameters<typeof workflow.execute>[1]) => workflow.execute(principal, command);
  const accepted = async (command: Parameters<typeof workflow.execute>[1]) => {
    const result = await apply(command); assert.equal(result.status, "applied", JSON.stringify(result)); return result;
  };
  await accepted({ type: "task.create", projectId, operationId: randomUUID(), taskId: tid, title: "Concrete dispatch",
    content: "Check the selected recipient", acceptance: "No other same-Role recipient can start", owner: roleId });
  await accepted({ type: "task.start", projectId, operationId: randomUUID(), taskId: tid, expectedVersion: 1, reason: "Freeze before assignment" });
  const task = (await workflow.getTask(principal, projectId, tid)).task;
  await accepted({ type: "runtime.session.reserve", projectId, operationId: randomUUID(), sessionId: sid, roleId,
    cwd: "/tmp/evoloop-assignment", authorizationScope: "test", sandbox: "read-only", approvalPolicy: "on-request" });
  await runtime.beginSessionCreate(projectId, sid);
  await runtime.bindSession(projectId, sid, { owner: "evoloop-codex-app-server", projectId, sessionId: sid, roleId,
    cwd: "/tmp/evoloop-assignment", authorizationScope: "test", nativeThreadId: `fake-thread-${sid}`, nativeSessionId: `fake-native-${sid}` });
  const assign = (version: number, target: { kind: "owned"; sessionId: string } | { kind: "external"; linkId: string }) => accepted({
    type: "task.assignment.set", projectId, operationId: randomUUID(), taskId: tid, expectedTaskVersion: task.version,
    expectedVersion: version, target, recipientActorId: "worker", reason: "Lead selects this exact recipient" });
  await assign(0, { kind: "external", linkId: link1 });
  const direct = await apply({ type: "runtime.run.reserve", projectId, operationId: randomUUID(), runId: randomUUID(),
    taskId: tid, sessionId: sid, expectedVersion: task.version, input: "Same Role is insufficient" });
  assert.equal(direct.status === "rejected" && direct.code, "TASK_ASSIGNED_ELSEWHERE");
  const entry = { id: eid, taskId: tid, taskRevisionId: task.currentRevisionId, sessionId: sid, roleId,
    dependsOn: [], consumerId: "lead", useRequired: false, releaseRule: "accepted" as const };
  const invalidQueue = await apply({ type: "queue.create", projectId, operationId: randomUUID(), queueId: randomUUID(), maxRuns: 1,
    reason: "Must not take another recipient's assignment", entries: [entry] });
  assert.equal(invalidQueue.status === "rejected" && invalidQueue.code, "TASK_ASSIGNED_ELSEWHERE");
  await assign(1, { kind: "owned", sessionId: sid });
  await accepted({ type: "queue.create", projectId, operationId: randomUUID(), queueId: qid, maxRuns: 1, reason: "Exact target", entries: [entry] });
  await assign(2, { kind: "external", linkId: link2 });
  await accepted({ type: "queue.adopt", projectId, operationId: randomUUID(), queueId: qid, expectedVersion: 1 });
  const operationId = randomUUID();
  const held = await accepted({ type: "queue.claim", projectId, operationId, queueId: qid, entryId: eid,
    expectedVersion: 1, claimId: randomUUID(), runId: randomUUID(), runOperationId: operationId });
  assert.equal(held.status === "applied" && held.queue?.held, "binding_changed");
  assert.equal((await workflow.listRuntimeRuns(principal, projectId, tid)).length, 0);
  await accepted({ type: "task.assignment.release", projectId, operationId: randomUUID(), taskId: tid, expectedVersion: 3,
    reason: "Explicitly release manual assignment before direct execution" });
  const runId = randomUUID();
  await accepted({ type: "runtime.run.reserve", projectId, operationId: randomUUID(), runId,
    taskId: tid, sessionId: sid, expectedVersion: task.version, input: "Authorized legacy direct path after explicit release" });
  await runtime.rejectDispatch(projectId, runId, "Isolated test ends before any native dispatch");
});
after(async () => {
  await pool.end();
  const cleanup = new pg.Client({ connectionString: url });
  await cleanup.connect();
  try { await cleanup.query(`DROP SCHEMA "${schema}" CASCADE`); } finally { await cleanup.end(); }
});

test("exact HostLink profiles and assignment revisions persist; CAS and immutable history hold", async () => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const store = new PgSessionAssignments(client, projectId);
    const first = { kind: "external" as const, linkId: link1 }, second = { kind: "external" as const, linkId: link2 };
    await store.saveSessionProfile({ projectId, target: first, version: 1, displayName: "Session A", purpose: "Design",
      membership: "current", tenure: "temporary", actorId: "lead", reason: "named", updatedAt: now }, 0);
    await store.saveSessionProfile({ projectId, target: second, version: 1, displayName: "Session B", purpose: "Review",
      membership: "current", tenure: "resident", actorId: "lead", reason: "named", updatedAt: now }, 0);
    assert.equal((await store.getSessionProfile(first))?.displayName, "Session A");
    assert.equal((await store.getSessionProfile(second))?.displayName, "Session B");
    await store.saveTaskSessionAssignment({ projectId, taskId, version: 1, taskRevisionId, target: first,
      recipientActorId: "worker", state: "assigned", ack: null, actorId: "lead", reason: "first", updatedAt: now }, 0);
    await store.saveTaskSessionAssignment({ projectId, taskId, version: 2, taskRevisionId, target: second,
      recipientActorId: "worker", state: "accepted", ack: { method: "lead-observed", actorId: null,
        observerActorId: "lead", evidence: "Manual acceptance", sourceRef: "chat:123", at: now },
      actorId: "lead", reason: "observed", updatedAt: now }, 1);
    assert.deepEqual((await store.getTaskSessionAssignment(taskId))?.target, second);
    const old = await store.listTaskSessionAssignmentHistory(taskId, 1);
    assert.equal(old.items[0]?.version, 2);
    assert.equal(old.nextCursor, "2");
    assert.deepEqual((await store.listTaskSessionAssignmentHistory(taskId, 1, "2")).items[0]?.target, first);
    await client.query("COMMIT");
    const targetChanges = await client.query(`SELECT target_id, count(*)::integer AS changes FROM session_observation_change
      WHERE project_id=$1 AND source_table='task_session_assignment' AND task_id=$2 GROUP BY target_id`, [projectId, taskId]);
    assert.equal(targetChanges.rows.find(row => row.target_id === link1)?.changes, 2,
      "moving the Task must also invalidate its previous Session");
    assert.equal(targetChanges.rows.find(row => row.target_id === link2)?.changes, 1);
    await assert.rejects(store.saveSessionProfile({ projectId, target: first, version: 1, displayName: "Bad", purpose: "",
      membership: "current", tenure: "temporary", actorId: "lead", reason: "stale", updatedAt: now }, 0),
      { code: "VERSION_CONFLICT" });
    const history = await store.listSessionProfileHistory(first, 1);
    assert.equal(history.items.length, 1);
    await assert.rejects(client.query("UPDATE session_profile_revision SET display_name='forged' WHERE project_id=$1", [projectId]), /immutable/);
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
});
