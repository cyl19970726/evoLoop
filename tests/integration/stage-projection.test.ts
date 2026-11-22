// The stage projection (`GET /api/projects/:id/stages/milestones`, Task 19f0e36a): states, counts, the current stage, the time zone, the entrance and the
// project boundary, on a real PostgreSQL schema with the real migrations. Refuses a live or shared server before opening TEST_DATABASE_URL.
import "../../scripts/test-database-guard.mjs";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";
import { migrate, PostgresUnitOfWork } from "@evoloop/adapter-postgres";
import { WorkflowService } from "@evoloop/core";
import type { Principal } from "@evoloop/contracts";
import { buildServer } from "../../apps/coordinator/src/server.js";
import { fixtureRoleId, seedFixtureRole } from "./role-fixture.test.js";

const database = process.env.TEST_DATABASE_URL;
if (!database || !/^\/evoloop(?:_[a-z0-9]+)*_test$/.test(new URL(database).pathname)) throw new Error("A dedicated evoloop_*_test database is required");

const setup = async (t: test.TestContext) => {
  const schema = `sproj_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  await migrate(database!, schema);
  const pool = new pg.Pool({ connectionString: database, options: `-c search_path=${schema}` });
  t.after(async () => { await pool.end(); const admin = new pg.Client({ connectionString: database }); await admin.connect(); try { await admin.query(`DROP SCHEMA "${schema}" CASCADE`); } finally { await admin.end(); } });
  const clock = { at: "2026-11-22T12:00:00.000Z" };
  const projectId = randomUUID();
  const decider: Principal = { actorId: "decider", projectIds: [projectId], permissions: ["read", "write", "task", "document", "session", "management"], decisions: true };
  const workflow = new WorkflowService({ uow: new PostgresUnitOfWork(pool), clock: { now: () => clock.at }, ids: { next: randomUUID },
    hasher: { hash: (s: string) => createHash("sha256").update(s).digest("hex") } });
  const applied = async (command: Record<string, unknown>, project = projectId, who = decider) => {
    const r = await workflow.execute(who, { ...command, projectId: project, operationId: randomUUID() } as never); assert.equal(r.status, "applied", JSON.stringify(r)); return r;
  };
  await applied({ type: "project.create", title: "Projection" });
  const owner = fixtureRoleId("projection-owner"); await seedFixtureRole(pool, projectId, owner);
  const goalId = randomUUID();
  await applied({ type: "goal.create", goalId, outcome: "One goal", constraints: "none", consumer: owner, authority: owner, scope: "test", owner });
  const stage = async (extra: Record<string, unknown> = {}, accept = true) => {
    const stageId = randomUUID();
    await applied({ type: "stage.propose", stageId, goalId, deliverable: "Deliver", learningQuestion: "Learn", shortName: "阶段", checkMethod: "核对", reason: "propose", ...extra });
    if (accept) await applied({ type: "stage.accept", stageId, expectedVersion: 1, reason: "accept" });
    return stageId;
  };
  const review = async (stageId: string, adopted: string, rejected: string, gap: string) => {
    const version = Number((await pool.query("SELECT version FROM project_stage WHERE stage_id=$1", [stageId])).rows[0].version);
    await applied({ type: "stage.review", stageId, expectedVersion: version, adopted, rejected, gap, nextChoice: "continue", evidence: "e", reason: "r" });
  };
  const task = async (stageId?: string, state?: "in_progress" | "done") => {
    const taskId = randomUUID();
    await applied({ type: "task.create", taskId, title: "T", content: "Body", acceptance: "Check", owner, ...(stageId ? { stageId, consumer: "decider", evidence: "seen", stopCondition: "reviewed" } : {}) });
    // Real commands only: a trigger keeps task.state in step with its revisions. "done" is a cancelled Task, which the projection also counts as closed.
    if (state === "in_progress") await applied({ type: "task.start", taskId, expectedVersion: 1, basis: [], reason: "start" });
    if (state === "done") await applied({ type: "task.cancel", taskId, expectedVersion: 1, reason: "cancel" });
    return taskId;
  };
  const project = (timeZone?: string) => workflow.getStageProjection(decider, projectId, timeZone);
  return { pool, schema, clock, projectId, decider, workflow, applied, stage, review, task, project, owner, goalId };
};

test("all seven states, the task counts agree with the database, and the folded stages stay out of the main table", async t => {
  const f = await setup(t);
  const proposed = await f.stage({ shortName: "未接受", dueOn: "2026-12-20" }, false);
  const noTasks = await f.stage({ shortName: "没任务", dueOn: "2026-12-14" });
  const running = await f.stage({ shortName: "在做", dueOn: "2026-12-07" });
  const overdue = await f.stage({ shortName: "过期", dueOn: "2026-11-10" });
  const achieved = await f.stage({ shortName: "达成", dueOn: "2026-11-01" });
  const partial = await f.stage({ shortName: "部分", dueOn: "2026-11-02" });
  const missed = await f.stage({ shortName: "未达", dueOn: "2026-11-03" });
  const legacy = await f.stage({ shortName: "旧阶段", dueOn: "2026-10-01" });
  // The old stage never had a short name (migration 118 backfills only the ladder level); it is reviewed too.
  await f.pool.query("UPDATE stage_milestone SET short_name=NULL,due_on=NULL,check_method=NULL WHERE stage_id=$1", [legacy]);
  const undated = await f.stage({ shortName: "未定", dueOn: null });
  // Tasks: running has two in progress, one blocked, one not started, one closed; overdue has one in progress.
  const doing1 = await f.task(running, "in_progress"); await f.task(running, "in_progress");
  const stuck = await f.task(running, "in_progress"); const blocker = await f.task();
  await f.pool.query("INSERT INTO task_dependency(project_id,task_id,depends_on_task_id,actor_id,reason,created_at) VALUES ($1,$2,$3,'a','waits',now())", [f.projectId, stuck, blocker]);
  await f.task(running); await f.task(running, "done");
  await f.task(overdue, "in_progress");
  for (const [stageId, adopted, rejected, gap] of [[achieved, "做成了", "无", "没有"], [partial, "做成一半", "没做的一项", "无"], [missed, "无", "全部", "全部"], [legacy, "做成了", "无", "无"]] as const) {
    await f.task(stageId, "done"); await f.review(stageId, adopted, rejected, gap);
  }
  // Open work with no stage: two without a row, one explicitly "not part of any stage", and one closed that is in neither count.
  await f.task(); await f.task();
  const declaredTask = await f.task();
  await f.pool.query("INSERT INTO task_stage(project_id,task_id,version,stage_id,no_stage_reason,actor_id,reason,updated_at) VALUES ($1,$2,1,NULL,'日程例行','a','declared',now())", [f.projectId, declaredTask]);
  await f.task(undefined, "done");

  const view = await f.project();
  assert.deepEqual([view.timeZone, view.today, view.asOf], ["UTC", "2026-11-22", "2026-11-22T12:00:00.000Z"]);
  const byId = new Map(view.stages.map(stage => [stage.id, stage]));
  const status = (id: string) => byId.get(id)!.status;
  assert.deepEqual([proposed, noTasks, running, overdue, achieved, partial, missed, legacy, undated].map(status), [
    "not_accepted", "accepted_no_tasks", "in_progress", "overdue_awaiting_review", "achieved", "partially_achieved", "not_achieved", "achieved", "accepted_no_tasks"]);
  assert.deepEqual([proposed, noTasks, running, overdue, achieved, partial, missed].map(id => byId.get(id)!.statusLabel),
    ["未接受", "已接受还没有任务", "进行中", "已到期待回看", "达成", "部分达成", "未达成"]);
  // No review, no verdict word.
  for (const id of [proposed, noTasks, running, overdue, undated]) assert.ok(!["achieved", "partially_achieved", "not_achieved"].includes(status(id)) && byId.get(id)!.latestReview === null, id);
  assert.equal(byId.get(achieved)!.latestReview?.adopted, "做成了");
  // Counts: the projection against a direct count of the tables (the two numbers an acceptance reader writes down).
  assert.deepEqual(byId.get(running)!.tasks, { inProgress: 2, blocked: 1, notStarted: 1, closed: 1, total: 5 });
  assert.deepEqual(byId.get(overdue)!.tasks, { inProgress: 1, blocked: 0, notStarted: 0, closed: 0, total: 1 });
  assert.deepEqual(byId.get(noTasks)!.tasks, { inProgress: 0, blocked: 0, notStarted: 0, closed: 0, total: 0 }, "a stage with no task says total 0, not 'unowned'");
  const counted = await f.pool.query("SELECT stage_id,count(*)::int AS n FROM task_stage WHERE stage_id IS NOT NULL GROUP BY stage_id");
  for (const row of counted.rows) assert.equal(byId.get(row.stage_id)!.tasks.total, row.n, `database count for ${row.stage_id}`);
  assert.deepEqual(view.tasksNoStage, { unowned: 3, declared: 1 }, "blocker + two plain open tasks have no row; the closed one is in neither");
  void doing1;
  // Main table: a registered short name, not reviewed (or reviewed within 14 days); the old stage without a short name is folded.
  assert.equal(byId.get(legacy)!.shortName, null);
  assert.equal(byId.get(legacy)!.inMainTable, false);
  assert.equal(byId.get(running)!.inMainTable, true);
  assert.equal(byId.get(achieved)!.inMainTable, true, "reviewed a moment ago");
  f.clock.at = "2026-12-20T12:00:00.000Z";
  assert.equal((await f.project()).stages.find(stage => stage.id === achieved)!.inMainTable, false, "reviewed more than 14 days ago");
});

test("the current stage is the earliest accepted unreviewed one, whatever today is, and says why when it cannot", async t => {
  const f = await setup(t);
  f.clock.at = "2026-12-05T12:00:00.000Z";
  const late = await f.stage({ shortName: "十二月二日", dueOn: "2026-12-02" });
  f.clock.at = "2026-12-05T12:00:01.000Z";
  const later = await f.stage({ shortName: "十二月七日", dueOn: "2026-12-07" });
  await f.stage({ shortName: "未接受的更早", dueOn: "2026-11-01" }, false);
  await f.task(late, "in_progress"); await f.task(later, "in_progress");
  let view = await f.project();
  assert.equal(view.currentStageId, late, "overdue and unreviewed is still current");
  assert.equal(view.currentNote, null);
  assert.equal(view.stages.find(stage => stage.id === late)!.status, "overdue_awaiting_review");
  assert.equal(view.stages.find(stage => stage.id === later)!.status, "in_progress", "two stages in progress do not raise 'unregistered'");
  await f.review(late, "做成了", "无", "无");
  view = await f.project();
  assert.equal(view.currentStageId, later, "once the first is reviewed the next one is current");
  // The same due date: the one created first.
  f.clock.at = "2026-12-05T13:00:00.000Z";
  const firstSame = await f.stage({ shortName: "同日先", dueOn: "2026-12-01" });
  f.clock.at = "2026-12-05T13:00:05.000Z";
  await f.stage({ shortName: "同日后", dueOn: "2026-12-01" });
  assert.equal((await f.project()).currentStageId, firstSame);
  // No due date at all: nothing is picked and the note says so.
  const g = await setup(t);
  await g.stage({ shortName: "无日期甲", dueOn: null }); await g.stage({ shortName: "无日期乙" });
  const none = await g.project();
  assert.deepEqual([none.currentStageId, none.currentNote], [null, "当前阶段未登记"]);
  const empty = await (await setup(t)).project();
  assert.deepEqual([empty.stages.length, empty.currentStageId, empty.currentNote], [0, null, "没有已接受且未回看的阶段"]);
});

test("timeZone decides today near the day boundary; no timeZone is UTC; a bad name is refused at the entrance", async t => {
  const f = await setup(t);
  f.clock.at = "2026-12-02T20:00:00.000Z"; // 20:00 UTC on 12-02 is 01:00 on 12-03 in Tashkent (UTC+5)
  const edge = await f.stage({ shortName: "日界", dueOn: "2026-12-02" });
  await f.task(edge, "in_progress");
  const utc = await f.project("UTC"); const tashkent = await f.project("Asia/Tashkent"); const none = await f.project();
  assert.deepEqual([utc.today, utc.timeZone, utc.stages[0]!.status], ["2026-12-02", "UTC", "in_progress"], "due today is not yet overdue");
  assert.deepEqual([tashkent.today, tashkent.timeZone, tashkent.stages[0]!.status], ["2026-12-03", "Asia/Tashkent", "overdue_awaiting_review"]);
  assert.deepEqual([none.today, none.timeZone, none.stages[0]!.status], ["2026-12-02", "UTC", "in_progress"], "no timeZone reads as UTC");
  assert.equal(tashkent.currentStageId, utc.currentStageId, "the current stage does not depend on today");

  const token = "p".repeat(40), outsider = "q".repeat(40);
  const app = await buildServer({ service: f.workflow, credentials: [
    { token, actorId: "reader", identityKind: "agent", projectIds: [f.projectId], permissions: ["task"] },
    { token: outsider, actorId: "outsider", identityKind: "agent", projectIds: [randomUUID()], permissions: ["task"] }] });
  t.after(() => app.close());
  const get = (query: string, bearer = token, project = f.projectId) => app.inject({ url: `/api/projects/${project}/stages/milestones${query}`, headers: { authorization: `Bearer ${bearer}` } });
  const ok = await get("?timeZone=Asia/Tashkent");
  assert.equal(ok.statusCode, 200, ok.body);
  assert.deepEqual(Object.keys(ok.json()).sort(), ["asOf", "currentNote", "currentStageId", "stages", "tasksNoStage", "timeZone", "today"]);
  assert.deepEqual(Object.keys(ok.json().stages[0]).sort(), ["checkMethod", "dueOn", "goalId", "id", "inMainTable", "ladderKeys", "latestReview", "shortName", "state", "status", "statusLabel", "tasks"]);
  assert.equal(ok.json().today, "2026-12-03");
  assert.equal((await get("")).json().timeZone, "UTC");
  for (const bad of ["?timeZone=Mars/Olympus", "?timeZone=", "?timeZone=UTC&extra=1"]) { const r = await get(bad); assert.equal(r.statusCode, 400, `${bad}: ${r.body}`); assert.equal(r.json().code, "INVALID_INPUT"); }
  assert.equal((await get("", outsider)).statusCode, 403, "an identity outside the project reads nothing");
  assert.equal((await get("", "z".repeat(40))).statusCode, 401, "no valid credential");
});

test("another project's stages and tasks never appear, and the stage route is not read as a stage id", async t => {
  const f = await setup(t);
  const mine = await f.stage({ shortName: "我的", dueOn: "2026-12-02" });
  await f.task(mine, "in_progress");
  const other = randomUUID();
  const otherDecider: Principal = { ...f.decider, projectIds: [other] };
  await f.applied({ type: "project.create", title: "Other" }, other, otherDecider);
  await seedFixtureRole(f.pool, other, f.owner);
  const otherGoal = randomUUID();
  await f.applied({ type: "goal.create", goalId: otherGoal, outcome: "Other goal", constraints: "none", consumer: f.owner, authority: f.owner, scope: "test", owner: f.owner }, other, otherDecider);
  const foreign = randomUUID();
  await f.applied({ type: "stage.propose", stageId: foreign, goalId: otherGoal, deliverable: "D", learningQuestion: "L", shortName: "别人的", checkMethod: "法", dueOn: "2026-11-01", reason: "r" }, other, otherDecider);
  await f.applied({ type: "stage.accept", stageId: foreign, expectedVersion: 1, reason: "a" }, other, otherDecider);
  await f.applied({ type: "task.create", taskId: randomUUID(), title: "O", content: "B", acceptance: "A", owner: f.owner }, other, otherDecider);
  const view = await f.project();
  assert.deepEqual(view.stages.map(stage => stage.id), [mine]);
  assert.equal(view.currentStageId, mine, "the other project's earlier due date is not compared");
  assert.deepEqual(view.tasksNoStage, { unowned: 0, declared: 0 }, "the other project's open task is not counted here");
  assert.equal((await f.workflow.getStageProjection(otherDecider, other)).stages[0]!.shortName, "别人的");
  await assert.rejects(f.workflow.getStageProjection(f.decider, other), /FORBIDDEN|membership/i);
});
