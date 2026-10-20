import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";
import type { Principal } from "@evoloop/contracts";
import type { RoleCommand, RoleProposal } from "@evoloop/contracts/roles";
import { applyRole, RoleRuleError } from "../../packages/core/src/roles/index.js";
import { PgRoleStore } from "../../packages/adapter-postgres/src/roles.js";
import { migrate } from "../../packages/adapter-postgres/src/index.js";

const url = process.env.TEST_DATABASE_URL;
if (!url || !/\/evoloop_[a-z_]*test(?:\?|$)/.test(url)) throw new Error("TEST_DATABASE_URL must name a dedicated evoloop_*test database");
const now = "2026-10-20T09:00:00.000Z";
const proposal = (taskId: string): RoleProposal => ({
  title: "Release stewardship", goal: "Own release health", independentResponsibility: "Judge release readiness independently", ownerScope: "this project's releases",
  inputs: ["release plan"], writableAssets: ["release notes"], deliverables: ["release decision"], triggers: ["candidate release"], workflow: "Inspect, test and decide", handoffBoundary: "handoff to product owner",
  evidence: [
    { kind: "rework", observation: "three repeated release failures", sourceRef: "task:release-history", observedAtUtc: now },
    { kind: "effect", observation: "consumers lost a release", sourceRef: "review:consumer", observedAtUtc: now },
    { kind: "cost", observation: "six hours of recovery", sourceRef: "run:cost", observedAtUtc: now },
  ],
  alternatives: ["method", "knowledge", "another-instance", "temporary-assignment"].map(kind => ({ kind: kind as RoleProposal["alternatives"][number]["kind"], assessment: `${kind} does not own independent release judgement`, estimatedCost: "one day" })),
  firstTaskId: taskId, baseline: "three failures per month", expectedEffect: "fewer failures", costLimit: "two hours per release", trialDays: 14, reviewAtUtc: "2026-10-27T09:00:00.000Z", exitCriteria: "retire without measured improvement",
});

test("PG role trial, immutable review, explicit task handoff and retirement gates", async t => {
  await migrate(url);
  const pool = new pg.Pool({ connectionString: url, max: 3 }); t.after(() => pool.end());
  const projectId = randomUUID(), taskId = randomUUID(), source = randomUUID(), target = randomUUID();
  const principal: Principal = { actorId: "manager", projectIds: [projectId], permissions: ["write", "review"] };
  await pool.query("INSERT INTO project(project_id,title,created_at) VALUES($1,'role fixture',now())", [projectId]);
  const initialRevisionId = randomUUID();
  const initialClient = await pool.connect();
  try {
    await initialClient.query("BEGIN");
    await initialClient.query("INSERT INTO task(project_id,task_id,version,current_revision_id,title,goal,acceptance,owner,state) VALUES($1,$2,1,$3,'Release','Check readiness','Record result',$4,'proposed')", [projectId,taskId,initialRevisionId,source]);
    await initialClient.query("INSERT INTO task_revision(project_id,task_id,revision_id,version,title,goal,acceptance,owner,state,actor_id,reason,created_at) VALUES($1,$2,$3,1,'Release','Check readiness','Record result',$4,'proposed','manager','trial fixture',now())", [projectId,taskId,initialRevisionId,source]);
    await initialClient.query("COMMIT");
  } catch (error) { await initialClient.query("ROLLBACK"); throw error; } finally { initialClient.release(); }
  const store = new PgRoleStore(pool);
  const run = (command: RoleCommand, nowUtc = now) => store.transaction(projectId, tx => applyRole(tx, principal, command, { nowUtc, nextId: randomUUID }));
  const cmd = (type: RoleCommand["type"], roleId: string, rest: Record<string, unknown>): RoleCommand => ({ type, projectId, roleId, operationId: randomUUID(), ...rest } as RoleCommand);
  let sourceResult = await run(cmd("role.propose", source, { proposal: proposal(taskId) }));
  let targetResult = await run(cmd("role.propose", target, { proposal: proposal(taskId) }));
  await assert.rejects(() => run(cmd("role.decide", source, { expectedVersion: 99, decision: "accept-trial", reason: "reviewed" })), (error: unknown) => error instanceof RoleRuleError && error.code === "VERSION_CONFLICT");
  sourceResult = await run(cmd("role.decide", source, { expectedVersion: sourceResult.version, decision: "accept-trial", reason: "trial approved" }));
  targetResult = await run(cmd("role.decide", target, { expectedVersion: targetResult.version, decision: "accept-trial", reason: "trial approved" }));
  targetResult = await run(cmd("role.review", target, { expectedVersion: targetResult.version, decision: "activate", effectEvidence: "readiness improved", effectEvidenceRefs: ["task:release-review"], costEvidence: "one hour", costEvidenceRefs: ["run:cost-report"], baselineComparison: "better than baseline", reason: "retain" }), "2026-10-27T10:00:00.000Z");
  const ownedSessionId = randomUUID();
  await pool.query(`INSERT INTO runtime_session(project_id,session_id,role_id,cwd,authorization_scope,sandbox,approval_policy,state,version,native_thread_id,native_session_id,operation_id,actor_id,created_at,updated_at)
    VALUES($1,$2,$3,'/tmp/fixture','scope','read-only','on-request','ready',1,$4,$5,$6,'manager',now(),now())`, [projectId,ownedSessionId,target,`fixture-thread-${randomUUID()}`,`fixture-session-${randomUUID()}`,randomUUID()]);
  targetResult = await run(cmd("role.bindSession", target, { expectedVersion: targetResult.version, sessionId: ownedSessionId, note: "reserved runtime identity confirmed" }));
  assert.equal((await store.transaction(projectId, tx => tx.listSessionBindings(target))).length, 1);
  assert.equal((await store.transaction(projectId, tx => tx.getRole(source)))?.state, "trial", "review expiry alone does not create a permanent role");
  await assert.rejects(() => run(cmd("role.bindSession", source, { expectedVersion: sourceResult.version, sessionId: randomUUID(), note: "arbitrary desktop" })), (error: unknown) => error instanceof RoleRuleError && error.code === "SESSION_UNOWNED");
  const handoffId = randomUUID();
  sourceResult = await run(cmd("role.handoff", source, { expectedVersion: sourceResult.version, handoffId, kind: "task", sourceRef: taskId, targetRoleId: target, observedTaskVersion: 1, note: "manager reviewed assignment" }));
  sourceResult = await run(cmd("role.review", source, { expectedVersion: sourceResult.version, decision: "retire", effectEvidence: "no improvement", effectEvidenceRefs: ["task:release-review"], costEvidence: "three hours", costEvidenceRefs: ["run:cost-report"], baselineComparison: "worse than baseline", reason: "withdraw" }), "2026-10-27T10:00:00.000Z");
  await assert.rejects(() => run(cmd("role.retire", source, { expectedVersion: sourceResult.version, reason: "close", knowledgeDisposition: "knowledge awaiting handoff", runtimeDisposition: "runtime status unknown" })), (error: unknown) => error instanceof RoleRuleError && error.code === "RETIREMENT_BLOCKED");
  await assert.rejects(() => run(cmd("role.ackHandoff", source, { expectedVersion: sourceResult.version, handoffId, note: "claimed" })), (error: unknown) => error instanceof RoleRuleError && error.code === "TASK_TRANSFER_UNCONFIRMED");
  // Simulate a separate, reviewed Task workflow revision. Role command never changes Task owner.
  const taskRevisionId = randomUUID();
  const transferClient = await pool.connect();
  try {
    await transferClient.query("BEGIN");
    await transferClient.query("INSERT INTO task_revision(project_id,task_id,revision_id,version,title,goal,acceptance,owner,state,actor_id,reason,created_at) VALUES($1,$2,$3,2,'Release','Check readiness','Record result',$4,'proposed','manager','reviewed owner transfer',now())", [projectId,taskId,taskRevisionId,target]);
    await transferClient.query("UPDATE task SET version=2,current_revision_id=$3,owner=$4 WHERE project_id=$1 AND task_id=$2", [projectId,taskId,taskRevisionId,target]);
    await transferClient.query("COMMIT");
  } catch (error) { await transferClient.query("ROLLBACK"); throw error; } finally { transferClient.release(); }
  sourceResult = await run(cmd("role.ackHandoff", source, { expectedVersion: sourceResult.version, handoffId, note: "new owner confirmed" }));
  const sessionId = randomUUID();
  await pool.query(`INSERT INTO runtime_session(project_id,session_id,role_id,cwd,authorization_scope,sandbox,approval_policy,state,version,operation_id,actor_id,created_at,updated_at)
    VALUES($1,$2,$3,'/tmp/fixture','scope','read-only','on-request','unknown',1,$4,'manager',now(),now())`, [projectId,sessionId,source,randomUUID()]);
  await assert.rejects(() => run(cmd("role.retire", source, { expectedVersion: sourceResult.version, reason: "close", knowledgeDisposition: "task handoff acknowledged", runtimeDisposition: "runtime remains unknown" })), (error: unknown) => error instanceof RoleRuleError && error.code === "RETIREMENT_BLOCKED");
  await pool.query("UPDATE runtime_session SET state='closed',version=2,updated_at=now() WHERE project_id=$1 AND session_id=$2", [projectId,sessionId]);
  sourceResult = await run(cmd("role.retire", source, { expectedVersion: sourceResult.version, reason: "handoff checked", knowledgeDisposition: "knowledge reviewed with new owner", runtimeDisposition: "all sessions closed" }));
  assert.equal((await store.transaction(projectId, tx => tx.getRole(source)))?.state, "retired");
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM role_revision WHERE project_id=$1 AND role_id=$2", [projectId,source])).rows[0]?.n, sourceResult.version);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM role_trial_review WHERE project_id=$1 AND role_id=$2", [projectId,source])).rows[0]?.n, 1);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM role_handoff_event WHERE project_id=$1 AND handoff_id=$2", [projectId,handoffId])).rows[0]?.n, 2);
  const history = await store.transaction(projectId, async tx => ({ page: await tx.listRoles(1), revisions: await tx.listRevisions(source), reviews: await tx.listReviews(source), handoffs: await tx.listHandoffs(source) }));
  assert.equal(history.page.items.length, 1);
  assert(history.page.nextCursor);
  assert.equal(history.revisions.length, sourceResult.version);
  assert.equal(history.reviews.length, 1);
  assert.equal(history.handoffs[0]?.state, "acknowledged");
  await assert.rejects(() => pool.query("DELETE FROM role_trial_review WHERE project_id=$1 AND role_id=$2", [projectId,source]), /immutable/);
});
