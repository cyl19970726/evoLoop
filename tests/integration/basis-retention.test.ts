import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";
import { PostgresUnitOfWork, migrate } from "@evoloop/adapter-postgres";
import { WorkflowService } from "@evoloop/core";
import { RuntimeWorkflowService } from "@evoloop/core/runtime";
import type { Command, CommandResult, Principal } from "@evoloop/contracts";


function withPersistedResumeProfile(runtime: RuntimeWorkflowService, uow: PostgresUnitOfWork): RuntimeWorkflowService {
  const bind = runtime.bindSession.bind(runtime);
  runtime.bindSession = async (projectId, sessionId, binding) => {
    const saved = await uow.read(projectId, reader => reader.getRuntimeSession(sessionId));
    const profile = saved?.executionProfile;
    if (!saved || !profile) throw new Error("fixture Session execution profile unavailable");
    return bind(projectId, sessionId, { ...binding, resumeProfile: { actorId: saved.actorId, model: saved.model,
      sandbox: saved.sandbox, approvalPolicy: saved.approvalPolicy, executionProfileRevisionId: profile.revision.revisionId } });
  };
  return runtime;
}
const database = process.env.TEST_DATABASE_URL;
if (!database || !/\/evoloop_[a-z_]*test(?:\?|$)/.test(database))
  throw new Error("Use a dedicated evoloop_*test database");

test("a todo Task can explicitly retain a published older source without an impact", async t => {
  const schema = `basis_retention_${randomUUID().replaceAll("-", "")}`;
  await migrate(database, schema);
  const pool = new pg.Pool({ connectionString: database, options: `-c search_path=${schema}` });
  t.after(async () => {
    await pool.end();
    const admin = new pg.Client({ connectionString: database }); await admin.connect();
    try { await admin.query(`DROP SCHEMA "${schema}" CASCADE`); } finally { await admin.end(); }
  });
  const projectId = randomUUID(), documentId = randomUUID(), taskId = randomUUID();
  const laterTaskId = randomUUID(), staleTaskId = randomUUID();
  const principal: Principal = { actorId: "reviewer", projectIds: [projectId], permissions: ["read", "write", "review"] };
  const clock = { now: () => "2026-10-21T06:00:00.000Z" };
  const uow = new PostgresUnitOfWork(pool);
  const service = new WorkflowService({ uow, clock, ids: { next: randomUUID },
    hasher: { hash: value => createHash("sha256").update(value).digest("hex") } });
  const trusted = new RuntimeWorkflowService({ uow, clock, ids: { next: randomUUID } });
  withPersistedResumeProfile(trusted,uow);
  const issue = (command: Omit<Command, "projectId" | "operationId"> & { operationId?: string }): Promise<CommandResult> =>
    service.execute(principal, { ...command, projectId, operationId: command.operationId ?? randomUUID() } as Command);
  const applied = (result: CommandResult) => {
    assert.equal(result.status, "applied", JSON.stringify(result));
    return result as Extract<CommandResult, { status: "applied" }>;
  };
  const rejected = (result: CommandResult, code: string) => {
    assert.equal(result.status, "rejected", JSON.stringify(result));
    if (result.status === "rejected") assert.equal(result.code, code);
  };
  applied(await issue({ type: "project.create", title: "Retained source test" }));
  const draftDocumentId = randomUUID(), draftTaskId = randomUUID();
  const neverAdopted = applied(await issue({ type: "document.create", documentId: draftDocumentId,
    title: "Never published draft", kind: "spec", body: "Draft r1" }));
  applied(await issue({ type: "task.create", taskId: draftTaskId, title: "Draft-linked work",
    content: "Check source", acceptance: "Check", owner: principal.actorId, documentIds: [draftDocumentId] }));
  const publishedReplacement = applied(await issue({ type: "document.revise", documentId: draftDocumentId,
    expectedVersion: 1, body: "Published r2", reason: "First publication candidate" }));
  applied(await issue({ type: "document.publish", documentId: draftDocumentId,
    expectedVersion: 2, revisionId: publishedReplacement.revisionId!, reason: "First publication" }));
  rejected(await issue({ type: "task.start", taskId: draftTaskId, expectedVersion: 1,
    basis: [{ documentId: draftDocumentId, revisionId: neverAdopted.revisionId! }],
    retentions: [{ documentId: draftDocumentId, revisionId: neverAdopted.revisionId!,
      observedAdoptedRevisionId: publishedReplacement.revisionId!, reason: "Try retaining an unpublished draft" }],
    reason: "Draft may not be retained" }), "BASIS_UNAVAILABLE");
  assert.equal((await service.getTask(principal, projectId, draftTaskId)).task.state, "todo");
  const r1 = applied(await issue({ type: "document.create", documentId, title: "Specification", kind: "spec", body: "Fixed r1" }));
  applied(await issue({ type: "document.publish", documentId, expectedVersion: 1, revisionId: r1.revisionId!, reason: "Publish r1" }));
  applied(await issue({ type: "task.create", taskId, title: "Use r1", content: "Implement fixed r1", acceptance: "Check r1", owner: principal.actorId, documentIds: [documentId] }));
  const r2 = applied(await issue({ type: "document.revise", documentId, expectedVersion: 2, body: "Changed r2", reason: "New scope" }));
  applied(await issue({ type: "document.publish", documentId, expectedVersion: 3, revisionId: r2.revisionId!, reason: "Publish r2" }));
  assert.equal((await service.getTask(principal, projectId, taskId)).impacts.length, 0,
    "todo Tasks do not have an impactId to use with task.reviewBasis");
  const basis = [{ documentId, revisionId: r1.revisionId! }];
  const start = { type: "task.start" as const, taskId, expectedVersion: 1, basis, reason: "Start against checked r1" };
  rejected(await issue(start), "BASIS_CHANGED");
  const retention = { documentId, revisionId: r1.revisionId!, observedAdoptedRevisionId: r2.revisionId!, reason: "r1 remains this Task's accepted scope" };
  rejected(await issue({ ...start, retentions: [{ ...retention, observedAdoptedRevisionId: r1.revisionId! }] }), "INVALID_RETENTION");
  rejected(await issue({ ...start, retentions: [{ ...retention, observedAdoptedRevisionId: randomUUID() }] }), "BASIS_CHANGED");
  rejected(await issue({ ...start, retentions: [{ ...retention, revisionId: r2.revisionId! }] }), "INVALID_RETENTION");
  rejected(await issue({ ...start, retentions: [retention, retention] }), "INVALID_RETENTION");
  rejected(await issue({ ...start, retentions: [{ ...retention, documentId: randomUUID() }] }), "INVALID_RETENTION");
  const writer: Principal = { actorId: "writer", projectIds: [projectId], permissions: ["read", "write"] };
  await assert.rejects(() => service.execute(writer, { ...start, projectId, operationId: randomUUID(),
    retentions: [retention] }), error => (error as { code?: string }).code === "FORBIDDEN");
  const operationId = randomUUID();
  const started = applied(await issue({ ...start, operationId, retentions: [retention] }));
  assert.deepEqual(applied(await issue({ ...start, operationId, retentions: [retention] })), started,
    "same-operation replay returns its original receipt");
  const fixed = await service.getTask(principal, projectId, taskId);
  assert.equal(fixed.task.state, "in_progress");
  assert.deepEqual(fixed.basis?.retentions, [{ ...retention, actorId: principal.actorId, createdAt: clock.now() }]);
  const retainedRow = await pool.query("SELECT retentions FROM basis_set WHERE project_id=$1 AND task_id=$2 AND task_revision_id=$3",
    [projectId, taskId, started.revisionId]);
  assert.deepEqual(retainedRow.rows[0].retentions, fixed.basis?.retentions);
  await assert.rejects(() => pool.query("UPDATE basis_set SET retentions='[]'::jsonb WHERE project_id=$1 AND task_id=$2 AND task_revision_id=$3",
    [projectId, taskId, started.revisionId]), error => (error as { code?: string }).code === "23514");

  const sessionId = randomUUID(), runId = randomUUID();
  applied(await issue({ type: "runtime.session.reserve", sessionId, roleId: principal.actorId, cwd: "/tmp/evoloop-retention-fixture",
    authorizationScope: "task:fixture", sandbox: "danger-full-access", approvalPolicy: "never" }));
  await trusted.beginSessionCreate(projectId, sessionId);
  await trusted.bindSession(projectId, sessionId, { projectId, sessionId, roleId: principal.actorId,
    cwd: "/tmp/evoloop-retention-fixture", authorizationScope: "task:fixture", nativeThreadId: "fixture-owned-thread",
    nativeSessionId: "fixture-owned-thread", owner: "evoloop-codex-app-server" });
  applied(await issue({ type: "runtime.run.reserve", runId, taskId, sessionId, expectedVersion: started.version!, input: "Check fixed r1" }));

  applied(await issue({ type: "task.create", taskId: laterTaskId, title: "Later work", content: "Use fixed r1", acceptance: "Check", owner: principal.actorId, documentIds: [documentId] }));
  const firstLaterStart = applied(await issue({ type: "task.start", taskId: laterTaskId, expectedVersion: 1,
    basis, retentions: [retention], reason: "Start with explicit r1 decision" }));
  const reopened = applied(await issue({ type: "task.reopen", taskId: laterTaskId,
    expectedVersion: firstLaterStart.version!, reason: "Repeat same fixed work" }));
  assert.deepEqual((await service.getTask(principal, projectId, laterTaskId)).basis?.retentions,
    [{ ...retention, actorId: principal.actorId, createdAt: clock.now() }],
    "reopen carries a still-current retention checkpoint into the new basis");
  applied(await issue({ type: "task.start", taskId: laterTaskId, expectedVersion: reopened.version!,
    reason: "Restart with inherited fixed basis and checkpoint" }));
  const r3 = applied(await issue({ type: "document.revise", documentId, expectedVersion: 4, body: "Changed r3", reason: "Newer scope" }));
  applied(await issue({ type: "document.publish", documentId, expectedVersion: 5, revisionId: r3.revisionId!, reason: "Publish r3" }));
  applied(await issue({ type: "task.create", taskId: staleTaskId, title: "Stale observation", content: "Use fixed r1", acceptance: "Check", owner: principal.actorId, documentIds: [documentId] }));
  rejected(await issue({ type: "task.start", taskId: staleTaskId, expectedVersion: 1, basis,
    retentions: [retention], reason: "Stale r2 observation" }), "BASIS_CHANGED");
  assert.deepEqual((await service.getTask(principal, projectId, taskId)).basis?.retentions,
    [{ ...retention, actorId: principal.actorId, createdAt: clock.now() }],
    "new publication does not rewrite the earlier sealed checkpoint");
});
