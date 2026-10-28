import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import pg from "pg";
import { fixtureRoleId, seedFixtureRole } from "./role-fixture.test.js";
import { LocalBlobStore } from "@evoloop/adapter-local-blobs";
import { PostgresUnitOfWork, migrate } from "@evoloop/adapter-postgres";
import type { Command, CommandResult, Principal } from "@evoloop/contracts";
import type { RoleProposal } from "@evoloop/contracts/roles";
import { WorkflowService } from "@evoloop/core";
import { importDocumentPayload } from "@evoloop/core/documents";

const url = process.env.TEST_DATABASE_URL;
if (!url || !/\/evoloop_[a-z0-9_]*test(?:\?|$)/.test(url)) throw new Error("Use dedicated evoloop_[a-z0-9_]*test database");
const schema = `facade_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
const now = "2026-10-20T09:00:00.000Z";
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}` });
const uow = new PostgresUnitOfWork(pool);
const service = new WorkflowService({ uow, clock: { now: () => now }, ids: { next: randomUUID }, hasher: { hash } });
const projectId = randomUUID();
const reviewer: Principal = { actorId: "manager", projectIds: [projectId], permissions: ["read", "write", "review"] };
const writer: Principal = { ...reviewer, permissions: ["read", "write"] };
const command = (type: Command["type"], fields: Record<string, unknown>, operationId = randomUUID()): Command =>
  ({ type, projectId, operationId, ...fields }) as Command;
const applied = (result: CommandResult) => { assert.equal(result.status, "applied", JSON.stringify(result)); return result; };
const rejected = (result: CommandResult, code: string) => {
  assert.equal(result.status, "rejected", JSON.stringify(result));
  if (result.status === "rejected") assert.equal(result.code, code);
};
const proposal = (taskId: string): RoleProposal => ({
  title: "Review stewardship", goal: "Own review quality", independentResponsibility: "Judge review outcomes independently",
  ownerScope: "this project", inputs: ["review plan"], writableAssets: ["review log"],
  deliverables: ["review decision"], triggers: ["task completed"], workflow: "Observe and decide",
  handoffBoundary: "handoff to manager",
  evidence: [
    { kind: "rework", observation: "repeated review corrections", sourceRef: "task:prior", observedAtUtc: now },
    { kind: "effect", observation: "consumer delayed", sourceRef: "review:consumer", observedAtUtc: now },
    { kind: "cost", observation: "two days recovery", sourceRef: "run:cost", observedAtUtc: now },
  ],
  alternatives: (["method", "knowledge", "another-instance", "temporary-assignment"] as const).map(kind => ({
    kind, assessment: `${kind} does not own independent judgement`, estimatedCost: "one day",
  })),
  firstTaskId: taskId, baseline: "three corrections", expectedEffect: "fewer corrections",
  costLimit: "one hour", trialDays: 7, reviewAtUtc: "2026-10-27T09:00:00.000Z", exitCriteria: "retire without improvement",
});

test("common facade journals role and schedule decisions and reads external document metadata faithfully", async t => {
  await migrate(url, schema);
  const blobRoot = await mkdtemp(join(tmpdir(), "evoloop-facade-"));
  t.after(async () => {
    await pool.end();
    await rm(blobRoot, { recursive: true, force: true });
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    try { await client.query(`DROP SCHEMA "${schema}" CASCADE`); } finally { await client.end(); }
  });

  applied(await service.execute(reviewer, command("project.create", { title: "Facade integration" })));
  const taskId = randomUUID(), roleId = randomUUID(), scheduleId = randomUUID();
  const managerRoleId=fixtureRoleId("manager");
  await seedFixtureRole(pool,projectId,managerRoleId);
  applied(await service.execute(writer, command("task.create", {
    taskId, title: "Trial review", content: "# Review a report", acceptance: "Record judgement", owner: managerRoleId, documentIds: [],
  })));

  const propose = command("role.propose", { roleId, proposal: proposal(taskId) });
  const first = applied(await service.execute(writer, propose));
  assert.deepEqual(await service.execute(writer, propose), first, "same operation replays one receipt");
  await assert.rejects(() => service.execute(writer, { ...propose, proposal: proposal(randomUUID()) }),
    (error: unknown) => error instanceof Error && error.message.includes("different command"));
  rejected(await service.execute(reviewer, command("role.decide", {
    roleId, expectedVersion: 99, decision: "accept-trial", reason: "stale reviewer",
  })), "VERSION_CONFLICT");
  const trial = applied(await service.execute(reviewer, command("role.decide", {
    roleId, expectedVersion: 1, decision: "accept-trial", reason: "bounded trial",
  })));
  assert.equal(trial.status === "applied" ? trial.version : null, 2);
  const retirement = applied(await service.execute(reviewer, command("role.review", {
    roleId, expectedVersion: 2, decision: "retire", effectEvidence: "No improvement",
    effectEvidenceRefs: ["task:trial"], costEvidence: "Two days", costEvidenceRefs: ["run:cost"],
    baselineComparison: "No better than baseline", reason: "trial did not meet exit condition",
  })));
  assert.equal(retirement.status === "applied" ? retirement.version : null, 3);
  applied(await service.execute(reviewer, command("role.retire", {
    roleId, expectedVersion: 3, reason: "trial closed", knowledgeDisposition: "review retained by manager",
    runtimeDisposition: "no session was opened",
  })));
  assert.equal((await service.getRole(reviewer, projectId, roleId)).state, "retired");
  assert.equal((await service.listRoleRevisions(reviewer, projectId, roleId)).length, 4);
  assert.equal((await service.listRoleReviews(reviewer, projectId, roleId)).length, 1);
  assert.equal((await service.listRoles(reviewer, projectId)).items.filter(item=>item.id===roleId).length, 1);
  rejected(await service.execute(writer, command("task.create", {
    taskId: randomUUID(), title: "Invalid assignment", content: "# Use retired role", acceptance: "No",
    owner: roleId, documentIds: [],
  })), "TASK_OWNER_ROLE_REQUIRED");

  const scheduleFields = {
    scheduleId, revisionId: randomUUID(), timezone: "UTC", rule: { kind: "once", atUtc: "2026-10-21T09:00:00.000Z" },
    misfire: { kind: "skip" }, overlap: "skip",
    template: { title: "Report", content: "# Check report", acceptance: "Record result", owner: managerRoleId },
    authorization: { scopeId: "project", roleId: "manager", authorizedBy: "manager", expiresAtUtc: null },
    reason: "one bounded reminder",
  };
  const createSchedule = command("schedule.create", {
    ...scheduleFields, watermarkUtc: now, state: "active",
  });
  await assert.rejects(() => service.execute(writer, command("schedule.create", {
    ...scheduleFields, scheduleId: randomUUID(), revisionId: randomUUID(), watermarkUtc: now, state: "active",
  })), /Permission review/);
  const scheduled = applied(await service.execute(reviewer, createSchedule));
  assert.deepEqual(await service.execute(reviewer, createSchedule), scheduled);
  rejected(await service.execute(reviewer, command("schedule.revise", {
    ...scheduleFields, revisionId: randomUUID(), expectedVersion: 9, state: "paused",
  })), "VERSION_CONFLICT");
  applied(await service.execute(reviewer, command("schedule.revise", {
    ...scheduleFields, revisionId: randomUUID(), expectedVersion: 1, state: "paused", reason: "pause after review",
  })));
  const schedules = await service.listSchedules(reviewer, projectId);
  assert.equal(schedules.length, 1);
  assert.equal(schedules[0]?.state, "paused", "paused definitions remain visible");
  assert.equal((await service.listScheduleRevisions(reviewer, projectId, scheduleId)).length, 2);
  assert.deepEqual(await service.listScheduleOccurrences(reviewer, projectId, scheduleId), []);
  rejected(await service.execute(reviewer, command("schedule.create", {
    ...scheduleFields, scheduleId: randomUUID(), revisionId: randomUUID(), watermarkUtc: now,
    template: { ...scheduleFields.template, owner: roleId }, state: "active",
  })), "TASK_OWNER_ROLE_REQUIRED");

  const documentId = randomUUID(), revisionId = randomUUID(), blobId = randomUUID();
  const bytes = Buffer.from("<html><body>Archived report</body></html>");
  const blobs = new LocalBlobStore(blobRoot, async () => true,
    async value => !!await uow.read(value.projectId, reader => reader.getRegisteredBlob(value.id)));
  const imported = await importDocumentPayload({ uow, blobs, hashText: hash, nextId: randomUUID, now: () => now }, writer, {
    mode: "create", projectId, operationId: randomUUID(), documentId, revisionId, title: "External report",
    format: "html", mediaType: "text/html", originalName: "index.html", author: "manager", reason: "fixed artifact",
    source: { storage: "blob", payloadRef: blobId, contentHash: hash(bytes), size: bytes.length, entrypoint: "index.html", assets: [] },
  }, new Map([[blobId, bytes]]));
  applied(imported);
  const document = await service.getDocument(reviewer, projectId, documentId);
  assert.equal(document.current.body, null);
  assert.equal(document.current.format, "html");
  assert.equal(document.current.mediaType, "text/html");
  assert.equal(document.current.payloadRef, blobId);
  assert.equal((await service.getDocumentPayloadRevision(reviewer, projectId, documentId, revisionId)).body, null);
  assert.equal((await service.getRegisteredBlob(reviewer, projectId, blobId)).contentHash, hash(bytes));
  rejected(await service.execute(writer, command("document.revise", {
    documentId, expectedVersion: 1, body: "# Mismatched Markdown", reason: "wrong surface",
  })), "FORMAT_CHANGE_REQUIRES_PAYLOAD");
  await assert.rejects(() => service.getDocument({ ...reviewer, projectIds: [] }, projectId, documentId), /Permission read/);

  const client = await pool.connect();
  try {
    const rows = await client.query(`SELECT operation_id,command_type,result->>'status' AS status FROM operation_journal WHERE project_id=$1`, [projectId]);
    const events = await client.query(`SELECT operation_id,kind FROM outbox_event WHERE project_id=$1`, [projectId]);
    const successful = rows.rows.filter(row => row.status === "applied").length;
    const taskCreates = rows.rows.filter(row => row.command_type === "task.create" && row.status === "applied").length;
    assert.equal(events.rowCount, successful + taskCreates,
      "task.create publishes both Task and primary Document effects; rejected commands emit none");
    const createdTaskOperation = rows.rows.find(row => row.command_type === "task.create" && row.status === "applied")?.operation_id;
    assert.deepEqual(events.rows.filter(row => row.operation_id === createdTaskOperation).map(row => row.kind).sort(),
      ["document", "task"], "the primary Document and Task each have an outbox effect");
    assert.equal(rows.rows.filter(row => row.command_type === "role.propose").length, 1, "replay creates no second journal row");
  } finally { client.release(); }
});
