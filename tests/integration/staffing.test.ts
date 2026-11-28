// The team growth rules end to end on real rows (DEC-038, DEC-055): a trial Role past its review date blocks a new business Session and gets one review
// Task through the real `task.create`; a written exception travels into the reservation's event; the recorded review lifts the first block and the
// unproven addition remains the second. Refuses a live or shared PostgreSQL server before this file opens TEST_DATABASE_URL (scripts/lib/database-target.mjs).
import "../../scripts/test-database-guard.mjs";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";
import { migrate, PostgresUnitOfWork } from "@evoloop/adapter-postgres";
import { WorkflowService } from "@evoloop/core";
import type { Principal } from "@evoloop/contracts";
import { DomainError } from "@evoloop/contracts/ports";
import { assertStaffingAllows, type StaffingGateDeps } from "../../apps/coordinator/src/staffing/gate.js";
import { reviewTaskIds, TrialReviewPump } from "../../apps/coordinator/src/staffing/review-pump.js";

const database = process.env.TEST_DATABASE_URL;
if (!database || !/^\/evoloop(?:_[a-z0-9]+)*_test$/.test(new URL(database).pathname)) throw new Error("A dedicated evoloop_*_test database is required");

const day = 86_400_000;
const seedRole = async (pool: pg.Pool, projectId: string, roleId: string, proposal: Record<string, unknown>, reviewInDays: number) => {
  const client = await pool.connect(), revisionId = randomUUID();
  const started = new Date(Date.now() - 20 * day).toISOString(), review = new Date(Date.now() + reviewInDays * day).toISOString();
  try {
    await client.query("BEGIN");
    await client.query(`INSERT INTO role_definition(project_id,role_id,version,current_revision_id,state,proposed_by,created_at_utc,trial_started_at_utc,review_at_utc)
      VALUES($1,$2,1,$3,'trial','fixture',$4,$4,$5)`, [projectId, roleId, revisionId, started, review]);
    await client.query(`INSERT INTO role_revision(project_id,role_id,revision_id,version,state,proposal,actor_id,reason,created_at_utc,review_at_utc)
      VALUES($1,$2,$3,1,'trial',$4::jsonb,'fixture','integration fixture',$5,$6)`, [projectId, roleId, revisionId, JSON.stringify(proposal), started, review]);
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
};

test("a due trial blocks a business Session, becomes one review Task, and stops blocking once the review is recorded", async t => {
  const schema = `el_staffing_it_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  await migrate(database!, schema);
  const pool = new pg.Pool({ connectionString: database, options: `-c search_path=${schema}` });
  t.after(async () => { await pool.end(); const admin = new pg.Client({ connectionString: database }); await admin.connect(); try { await admin.query(`DROP SCHEMA "${schema}" CASCADE`); } finally { await admin.end(); } });
  const projectId = randomUUID(), leader = randomUUID(), dev = randomUUID();
  const decider: Principal = { actorId: "decider", projectIds: [projectId], permissions: ["read", "write", "task", "document", "session", "management"], decisions: true };
  const workflow = new WorkflowService({ uow: new PostgresUnitOfWork(pool), clock: { now: () => new Date().toISOString() }, ids: { next: randomUUID },
    hasher: { hash: (s: string) => createHash("sha256").update(s).digest("hex") }, requireTaskStage: true, requireCompletionBoundary: true });
  const applied = async (command: Record<string, unknown>) => {
    const result = await workflow.execute(decider, { projectId, operationId: randomUUID(), ...command } as never);
    assert.equal(result.status, "applied", JSON.stringify(result));
    return result;
  };
  await applied({ type: "project.create", title: "Staffing" });
  await seedRole(pool, projectId, leader, { title: "Leader", roleClass: "system", templateKey: "lead" }, 30);
  await seedRole(pool, projectId, dev, { title: "功能开发", roleClass: "business" }, -3);
  const tasks = async () => (await pool.query("SELECT task_id,title,owner,state FROM task WHERE project_id=$1 ORDER BY title", [projectId])).rows;

  const first = await workflow.getStaffingCheck(decider, projectId);
  assert.deepEqual(first.trialsDue.map(item => [item.roleId, item.title, item.layer, item.daysOverdue]), [[dev, "功能开发", "business", 3]]);
  assert.deepEqual(first.blockers.map(item => item.code), ["TRIAL_REVIEW_OVERDUE"]);
  assert.equal(first.lastAddition, null);

  const gate: StaffingGateDeps = { configuration: async () => ({ enabled: true, projectIds: [projectId], idleDays: 3 }),
    check: (principal, project, options) => workflow.getStaffingCheck(principal, project, options), dynamicSessionIds: async () => [] };
  await assert.rejects(assertStaffingAllows(gate, decider, { projectId, roleId: dev }), (error: unknown) => error instanceof DomainError && error.code === "TRIAL_REVIEW_OVERDUE");
  await assertStaffingAllows(gate, decider, { projectId, roleId: leader });

  // The pump makes the review Task through the real command, once.
  const refusals: string[] = [];
  const pump = new TrialReviewPump({ canWrite: () => true, grants: async () => [{ projectId, actorId: decider.actorId, owner: leader, consumer: "requirements-agent" }],
    principal: async () => decider, check: (principal, project) => workflow.getStaffingCheck(principal, project),
    taskExists: async (principal, project, taskId) => {
      try { await workflow.getTask(principal, project, taskId); return true; }
      catch (error) { if (error instanceof DomainError && error.code === "NOT_FOUND") return false; throw error; }
    },
    createTask: (principal, command) => workflow.execute(principal, command),
    onRefused: (_project, _task, code) => refusals.push(code), onError: error => { throw error; } }, 60_000);
  await pump.tick(); await pump.tick();
  assert.deepEqual(refusals, []);
  const reviewAt = first.trialsDue[0]!.reviewAtUtc, { taskId } = reviewTaskIds(projectId, dev, reviewAt);
  assert.deepEqual(await tasks(), [{ task_id: taskId, title: `试行回看：功能开发（${reviewAt.slice(0, 10)} 到期）`, owner: leader, state: "todo" }], "one Task, owned by the configured Role");
  assert.deepEqual((await pool.query("SELECT stage_id,no_stage_reason FROM task_stage WHERE task_id=$1", [taskId])).rows.map(row => [row.stage_id, !!row.no_stage_reason]), [[null, true]]);
  assert.deepEqual((await pool.query("SELECT consumer,acceptance_mode,completion_boundary FROM task_proposal WHERE task_id=$1", [taskId])).rows,
    [{ consumer: "requirements-agent", acceptance_mode: "independent_agent", completion_boundary: "delivered" }]);

  // A business Session added with a written exception keeps the reason in its reservation event, and is then the unproven last addition.
  const sessionId = randomUUID();
  await applied({ type: "runtime.session.reserve", sessionId, roleId: dev, cwd: "/tmp/evoloop-staffing", authorizationScope: "project", model: "gpt-6",
    sandbox: "danger-full-access", approvalPolicy: "never", staffingException: "起步配置：先放一个开发" });
  assert.deepEqual((await pool.query("SELECT kind,detail FROM runtime_record_event WHERE project_id=$1 AND session_id=$2", [projectId, sessionId])).rows,
    [{ kind: "session.reserved", detail: "Session reserved before external creation; staffing exception: 起步配置：先放一个开发" }]);
  const second = await workflow.getStaffingCheck(decider, projectId);
  assert.equal(second.lastAddition?.sessionId, sessionId);
  assert.equal(second.lastAddition?.proven, false);
  assert.deepEqual(second.blockers.map(item => item.code), ["TRIAL_REVIEW_OVERDUE", "LAST_ADDITION_UNPROVEN"]);
  assert.deepEqual(second.team.map(row => [row.title, row.layer, row.openSessions]), [["Leader", "system", 0], ["功能开发", "business", 1]]);

  // The review is recorded: the trial is no longer due and no second Task is made; the unproven addition still blocks the next one.
  await applied({ type: "role.review", roleId: dev, expectedVersion: 1, decision: "continue-trial", effectEvidence: "三周里承接 12 件，被接受 9 件", effectEvidenceRefs: [`task:${taskId}`],
    costEvidence: "已记花费 40 美元", costEvidenceRefs: ["ledger:2026-11"], baselineComparison: "比基线多完成 5 件", reason: "继续试行两周",
    nextReviewAtUtc: new Date(Date.now() + 14 * day).toISOString() });
  await pump.tick();
  const third = await workflow.getStaffingCheck(decider, projectId);
  assert.deepEqual(third.trialsDue, []);
  assert.deepEqual(third.blockers.map(item => item.code), ["LAST_ADDITION_UNPROVEN"]);
  assert.equal((await tasks()).length, 1);
  await assert.rejects(assertStaffingAllows(gate, decider, { projectId, roleId: dev }), (error: unknown) => error instanceof DomainError && error.code === "LAST_ADDITION_UNPROVEN");
  await assertStaffingAllows(gate, decider, { projectId, roleId: dev, staffingException: "第二个开发：第一个的任务已排满" });
});
