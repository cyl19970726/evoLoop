// Refuses a live or shared PostgreSQL server before this file opens TEST_DATABASE_URL (scripts/lib/database-target.mjs).
import "../../../scripts/test-database-guard.mjs";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import pg from "pg";
import { WorkflowService } from "@evoloop/core";
import type { RoleProposal } from "@evoloop/contracts/roles";
import { migrate, PostgresUnitOfWork } from "../src/index.ts";

const url = process.env.TEST_DATABASE_URL;
if (!url || !/^evoloop(?:_[a-z0-9]+)*_test$/.test(decodeURIComponent(new URL(url).pathname.slice(1))))
  throw new Error("role.revise tests require a dedicated evoloop test database");
const schema = `el_role_revise_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
const pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}` });
const uow = new PostgresUnitOfWork(pool);
const now = "2026-11-10T00:00:00.000Z";
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const workflow = new WorkflowService({ uow, clock: { now: () => now }, ids: { next: randomUUID }, hasher: { hash: sha } });
const projectId = randomUUID();
const writer = { actorId: "writer", projectIds: [projectId], permissions: ["read", "write"] as ("read" | "write" | "review")[] };
const reviewer = { actorId: "reviewer", projectIds: [projectId], permissions: ["read", "write", "review"] as ("read" | "write" | "review")[] };

async function task(title: string, owner: string, state = "todo"): Promise<string> {
  const taskId = randomUUID(), revisionId = randomUUID(), documentId = randomUUID(), contentId = randomUUID();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`INSERT INTO process_document(project_id,document_id,title,version,current_revision_id,kind,status) VALUES($1,$2,$3,1,$4,'task','draft')`, [projectId, documentId, title, contentId]);
    await client.query(`INSERT INTO document_revision(project_id,document_id,revision_id,body,format,content_hash,author,created_at,reason,media_type,original_name,assets_manifest)
      VALUES($1,$2,$3,$4,'markdown',$5,'seed',$6,'test','text/markdown','task.md','[]'::jsonb)`, [projectId, documentId, contentId, title, sha(title), now]);
    await client.query(`INSERT INTO task(project_id,task_id,version,current_revision_id,title,acceptance,owner,state,content_document_id,content_revision_id) VALUES($1,$2,1,$3,$4,'accept',$5,$6,$7,$8)`,
      [projectId, taskId, revisionId, title, owner, state, documentId, contentId]);
    await client.query(`INSERT INTO task_revision(project_id,task_id,revision_id,version,title,acceptance,owner,state,content_document_id,content_revision_id,actor_id,reason,created_at)
      VALUES($1,$2,$3,1,$4,'accept',$5,$6,$7,$8,'seed','test',$9)`, [projectId, taskId, revisionId, title, owner, state, documentId, contentId, now]);
    await client.query("COMMIT");
    return taskId;
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
}
const proposal = (firstTaskId: string, over: Partial<RoleProposal> = {}): RoleProposal => ({
  title: "Release stewardship", goal: "Own release health", independentResponsibility: "Judge readiness", ownerScope: "this project releases",
  inputs: ["release plan"], writableAssets: ["release notes"], deliverables: ["release decision"], triggers: ["candidate release"], workflow: "Inspect, test and review", handoffBoundary: "hand off to product",
  evidence: [{ kind: "rework", observation: "repeated failures", sourceRef: "task:f", observedAtUtc: now }, { kind: "effect", observation: "blocked users", sourceRef: "review:c", observedAtUtc: now },
    { kind: "cost", observation: "six hours", sourceRef: "run:c", observedAtUtc: now }],
  alternatives: (["method", "knowledge", "another-instance", "temporary-assignment"] as const).map(kind => ({ kind, assessment: `${kind} does not own it`, estimatedCost: "high" })),
  firstTaskId, baseline: "three failures", expectedEffect: "fewer failures", costLimit: "two hours", trialDays: 14, reviewAtUtc: "2026-11-17T00:00:00.000Z", exitCriteria: "retire if no improvement", ...over });
const rows = <T>(sql: string, params: unknown[]) => pool.query(sql, params).then(result => result.rows as T[]);

before(async () => {
  await migrate(url!, schema);
  await uow.transaction(projectId, async tx => { await tx.insertProject({ id: projectId, title: "Role revise", createdAt: now }); });
});
after(async () => {
  await pool.end(); const client = new pg.Client({ connectionString: url! }); await client.connect();
  try { await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } finally { await client.end(); }
});

test("role.revise appends a candidate revision to a trial Role, keeps history and decisions, and role.decide accepts it", async () => {
  const first = await task("first trial task", "manager"), second = await task("second trial task", "manager");
  const roleId = randomUUID();
  const proposed = await workflow.execute(writer, { type: "role.propose", projectId, operationId: randomUUID(), roleId, proposal: proposal(first) });
  assert.equal(proposed.status, "applied");
  const accepted = await workflow.execute(reviewer, { type: "role.decide", projectId, operationId: randomUUID(), roleId, expectedVersion: 1, decision: "accept-trial", reason: "reviewed" });
  assert.equal(accepted.status, "applied");
  // A Task owned by the Role and the Role's decision exist before the revision.
  const owned = await task("owned by the role", roleId);
  const [decisionBefore] = await rows<{ decision_id: string; revision_id: string }>(`SELECT decision_id,revision_id FROM role_decision WHERE project_id=$1 AND role_id=$2`, [projectId, roleId]);
  const revisionsBefore = await uow.read(projectId, r => r.listRevisions(roleId));
  assert.deepEqual(revisionsBefore.map(item => [item.version, item.state]), [[1, "candidate"], [2, "trial"]]);

  const revised = proposal(second, { title: "Release stewardship v2", goal: "Own release and rollback health", reviewAtUtc: "2026-11-20T00:00:00.000Z" });
  const operationId = randomUUID();
  const command = { type: "role.revise" as const, projectId, operationId, roleId, expectedVersion: 2, proposal: revised, reason: "tighten scope" };
  await assert.rejects(() => workflow.execute(writer, command), (error: unknown) => /review/i.test((error as Error).message), "a writer alone cannot revise a Role");
  const result = await workflow.execute(reviewer, command);
  assert.equal(result.status, "applied", JSON.stringify(result));
  assert.deepEqual([result.status === "applied" && result.entityId, result.status === "applied" && result.version], [roleId, 3]);
  const role = await uow.read(projectId, r => r.getRole(roleId));
  assert.deepEqual([role?.id, role?.version, role?.state, role?.proposal.title, role?.reviewAtUtc], [roleId, 3, "candidate", "Release stewardship v2", "2026-11-20T00:00:00.000Z"]);
  assert.equal(role?.currentRevisionId, result.status === "applied" ? result.revisionId : "", "readback returns the new revision");
  assert.equal((await rows(`SELECT 1 FROM role_definition WHERE project_id=$1 AND role_id=$2`, [projectId, roleId])).length, 1, "no new Role row");
  const history = await uow.read(projectId, r => r.listRevisions(roleId));
  assert.deepEqual(history.map(item => [item.version, item.state]), [[1, "candidate"], [2, "trial"], [3, "candidate"]]);
  assert.deepEqual(history.slice(0, 2).map(item => item.proposal), revisionsBefore.map(item => item.proposal), "earlier revisions are unchanged");
  assert.equal(history[2]!.reason, "tighten scope");
  assert.equal(history[2]!.actorId, "reviewer");
  const [decisionAfter] = await rows<{ decision_id: string; revision_id: string }>(`SELECT decision_id,revision_id FROM role_decision WHERE project_id=$1 AND role_id=$2`, [projectId, roleId]);
  assert.deepEqual(decisionAfter, decisionBefore, "the earlier decision stays on its revision");
  const [taskRow] = await rows<{ owner: string; version: number }>(`SELECT owner,version FROM task WHERE project_id=$1 AND task_id=$2`, [projectId, owned]);
  assert.deepEqual([taskRow!.owner, taskRow!.version], [roleId, 1], "Task owner and revision are not touched");

  // Replaying the same operation with the same body returns the first result and writes nothing; another body is refused.
  const replay = await workflow.execute(reviewer, command);
  assert.deepEqual(replay, result);
  assert.equal((await uow.read(projectId, r => r.listRevisions(roleId))).length, 3);
  await assert.rejects(() => workflow.execute(reviewer, { ...command, proposal: { ...revised, title: "Another title" } }), (error: unknown) => (error as { code?: string }).code === "OPERATION_REUSED");
  assert.equal((await uow.read(projectId, r => r.listRevisions(roleId))).length, 3);

  // A stale version is refused and journaled with the current version; nothing is appended.
  const stale = await workflow.execute(reviewer, { ...command, operationId: randomUUID(), expectedVersion: 2 });
  assert.deepEqual([stale.status, stale.status === "rejected" && stale.code, stale.status === "rejected" && stale.currentVersion], ["rejected", "VERSION_CONFLICT", 3]);
  assert.equal((await uow.read(projectId, r => r.listRevisions(roleId))).length, 3);

  // The revision is a candidate: role.decide accepts it like any proposal, and the new trial starts then.
  const decided = await workflow.execute(reviewer, { type: "role.decide", projectId, operationId: randomUUID(), roleId, expectedVersion: 3, decision: "accept-trial", reason: "reviewed the revision" });
  assert.equal(decided.status, "applied", JSON.stringify(decided));
  const trial = await uow.read(projectId, r => r.getRole(roleId));
  assert.deepEqual([trial?.version, trial?.state, trial?.proposal.title, trial?.trialStartedAtUtc], [4, "trial", "Release stewardship v2", now]);
  const decisions = await rows<{ revision_id: string }>(`SELECT revision_id FROM role_decision WHERE project_id=$1 AND role_id=$2 ORDER BY created_at_utc`, [projectId, roleId]);
  assert.equal(decisions.length, 2);
  assert.notEqual(decisions[0]!.revision_id, decisions[1]!.revision_id);
});

test("role.revise refuses a closed Role and invalid first Task or review date; role.propose still creates a new Role", async () => {
  const open = await task("open first task", "manager"), done = await task("cancelled task", "manager", "cancelled");
  const roleId = randomUUID();
  await workflow.execute(writer, { type: "role.propose", projectId, operationId: randomUUID(), roleId, proposal: proposal(open) });
  const revise = (over: Record<string, unknown>) => workflow.execute(reviewer, { type: "role.revise", projectId, operationId: randomUUID(), roleId, expectedVersion: 1, proposal: proposal(open), ...over } as Parameters<typeof workflow.execute>[1]);
  const code = (result: Awaited<ReturnType<typeof revise>>) => result.status === "rejected" ? result.code : result.status;
  assert.equal(code(await revise({ proposal: proposal(done) })), "INVALID_FIRST_TASK");
  assert.equal(code(await revise({ proposal: proposal(randomUUID()) })), "INVALID_FIRST_TASK");
  assert.equal(code(await revise({ proposal: proposal(open, { reviewAtUtc: "2026-11-09T00:00:00.000Z" }) })), "INVALID_TRIAL");
  assert.equal(code(await revise({ proposal: proposal(open, { reviewAtUtc: "2027-02-01T00:00:00.000Z" }) })), "INVALID_TRIAL");
  assert.equal(code(await revise({ roleId: randomUUID() })), "NOT_FOUND");
  assert.equal((await uow.read(projectId, r => r.listRevisions(roleId))).length, 1, "refused revisions append nothing");
  // Rejected Roles are closed.
  await workflow.execute(reviewer, { type: "role.decide", projectId, operationId: randomUUID(), roleId, expectedVersion: 1, decision: "reject", reason: "no" });
  assert.equal(code(await revise({ expectedVersion: 2 })), "INVALID_STATE");
  // A new Role is still created by role.propose: version 1, candidate, its own row.
  const another = randomUUID();
  const created = await workflow.execute(writer, { type: "role.propose", projectId, operationId: randomUUID(), roleId: another, proposal: proposal(open, { title: "Another role" }) });
  assert.equal(created.status, "applied");
  const role = await uow.read(projectId, r => r.getRole(another));
  assert.deepEqual([role?.version, role?.state, role?.proposal.title], [1, "candidate", "Another role"]);
});
