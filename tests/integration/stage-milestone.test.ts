// Refuses a live or shared PostgreSQL server before this file opens TEST_DATABASE_URL (scripts/lib/database-target.mjs).
import "../../scripts/test-database-guard.mjs";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import pg from "pg";
import { migrate, PostgresUnitOfWork } from "@evoloop/adapter-postgres";
import { WorkflowService } from "@evoloop/core";
import type { Principal } from "@evoloop/contracts";
import { fixtureRoleId, seedFixtureRole } from "./role-fixture.test.js";

const database = process.env.TEST_DATABASE_URL;
if (!database || !/^\/evoloop(?:_[a-z0-9]+)*_test$/.test(new URL(database).pathname)) throw new Error("A dedicated evoloop_*_test database is required");

const setup = async (t: test.TestContext, prefix: string) => {
  const schema = `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  await migrate(database!, schema);
  const pool = new pg.Pool({ connectionString: database, options: `-c search_path=${schema}` });
  t.after(async () => { await pool.end(); const admin = new pg.Client({ connectionString: database }); await admin.connect(); try { await admin.query(`DROP SCHEMA "${schema}" CASCADE`); } finally { await admin.end(); } });
  const projectId = randomUUID();
  const decider: Principal = { actorId: "decider", projectIds: [projectId], permissions: ["read", "write", "task", "document", "session", "management"], decisions: true };
  const writer: Principal = { actorId: "writer", projectIds: [projectId], permissions: ["read", "write", "task", "document", "session"] };
  const workflow = new WorkflowService({ uow: new PostgresUnitOfWork(pool), clock: { now: () => new Date().toISOString() }, ids: { next: randomUUID },
    hasher: { hash: (s: string) => createHash("sha256").update(s).digest("hex") } });
  const issue = (who: Principal, command: Record<string, unknown>) => workflow.execute(who, { ...command, projectId, operationId: randomUUID() } as never);
  const applied = async (who: Principal, command: Record<string, unknown>) => { const r = await issue(who, command); assert.equal(r.status, "applied", JSON.stringify(r)); return r; };
  const refused = async (who: Principal, command: Record<string, unknown>, code: string) => { const r = await issue(who, command); assert.equal(r.status, "rejected", JSON.stringify(r)); assert.equal(r.status === "rejected" ? r.code : null, code); };
  await applied(decider, { type: "project.create", title: "Milestones" });
  const owner = fixtureRoleId("milestone-owner"); await seedFixtureRole(pool, projectId, owner);
  const goalId = randomUUID();
  await applied(decider, { type: "goal.create", goalId, outcome: "One goal", constraints: "none", consumer: owner, authority: owner, scope: "test", owner });
  const stage = async (extra: Record<string, unknown> = {}, accept = false) => {
    const stageId = randomUUID();
    await applied(decider, { type: "stage.propose", stageId, goalId, deliverable: "Deliver", learningQuestion: "Learn", shortName: "第一期", checkMethod: "验收人用样本核对", reason: "propose", ...extra });
    if (accept) await applied(decider, { type: "stage.accept", stageId, expectedVersion: 1, reason: "accept" });
    return stageId;
  };
  const task = async (stageId?: string) => {
    const taskId = randomUUID();
    await applied(decider, { type: "task.create", taskId, title: "T", content: "Body", acceptance: "Check", owner, ...(stageId ? { stageId, consumer: "decider", evidence: "seen", stopCondition: "reviewed" } : {}) });
    return taskId;
  };
  const rows = async (table: string) => Number((await pool.query(`SELECT count(*) AS n FROM ${table}`)).rows[0].n);
  return { pool, schema, projectId, decider, writer, workflow, issue, applied, refused, stage, task, rows, owner, goalId };
};

test("stage.propose needs a short name and a check method and records them with the first history row", async t => {
  const f = await setup(t, "ms_propose");
  const base = { type: "stage.propose", stageId: randomUUID(), goalId: f.goalId, deliverable: "D", learningQuestion: "L", reason: "r" };
  await assert.rejects(f.issue(f.decider, { ...base, checkMethod: "how" }), /shortName/, "no short name");
  await assert.rejects(f.issue(f.decider, { ...base, shortName: "x" }), /checkMethod/, "no check method");
  await assert.rejects(f.issue(f.decider, { ...base, shortName: "x".repeat(41), checkMethod: "how" }), /shortName/, "short name over 40 characters");
  await assert.rejects(f.issue(f.decider, { ...base, shortName: "x", checkMethod: "how", ladderKeys: ["X1"] }), /ladderKeys/, "ladder level must look like M1 or M0.5");
  await assert.rejects(f.issue(f.decider, { ...base, shortName: "x", checkMethod: "how", dueOn: "2026-02-30" }), /dueOn/, "a day that does not exist");
  assert.equal(await f.rows("stage_milestone"), 0, "nothing was written by the refused proposals");
  const stageId = await f.stage({ shortName: "里程碑一", checkMethod: "三人各查一次", dueOn: "2026-12-02", ladderKeys: ["M1", "M0.5"] });
  const read = await f.workflow.getStageMilestone(f.decider, f.projectId, stageId);
  assert.deepEqual({ ...read.milestone, updatedAt: undefined }, { projectId: f.projectId, stageId, version: 1, shortName: "里程碑一", dueOn: "2026-12-02", checkMethod: "三人各查一次", ladderKeys: ["M1", "M0.5"], actorId: "decider", reason: "propose", updatedAt: undefined });
  assert.equal(read.history.length, 1);
  const bare = await f.stage();
  const bareRead = await f.workflow.getStageMilestone(f.decider, f.projectId, bare);
  assert.deepEqual([bareRead.milestone?.dueOn, bareRead.milestone?.ladderKeys], [null, []], "due date and ladder levels may stay empty");
});

test("stage.milestone.set: two permission tiers, reason, version, format, reviewed stage keeps its due date, every change is in the history", async t => {
  const f = await setup(t, "ms_set");
  const set = (who: Principal, stageId: string, extra: Record<string, unknown>) => f.issue(who, { type: "stage.milestone.set", stageId, expectedVersion: 1, shortName: "名", checkMethod: "法", dueOn: "2026-12-02", ladderKeys: ["M1"], reason: "改", ...extra });
  const open = await f.stage({ shortName: "名", checkMethod: "法", dueOn: "2026-12-02", ladderKeys: ["M1"] });
  // Not yet accepted: task permission is enough, all four fields may change.
  let r = await set(f.writer, open, { shortName: "改后", checkMethod: "新办法", dueOn: "2026-12-09", ladderKeys: ["M1", "M4"] }); assert.equal(r.status, "applied", JSON.stringify(r));
  let read = await f.workflow.getStageMilestone(f.writer, f.projectId, open);
  assert.deepEqual([read.milestone?.version, read.milestone?.shortName, read.milestone?.checkMethod, read.milestone?.dueOn, read.milestone?.ladderKeys], [2, "改后", "新办法", "2026-12-09", ["M1", "M4"]]);
  assert.deepEqual(read.history.map(h => [h.version, h.shortName, h.dueOn]), [[1, "名", "2026-12-02"], [2, "改后", "2026-12-09"]], "the history keeps the value before and after");
  // Required fields and formats.
  await assert.rejects(set(f.writer, open, { expectedVersion: 2, reason: "" }), /reason/, "no reason");
  await assert.rejects(set(f.writer, open, { expectedVersion: 2, ladderKeys: ["bad"] }), /ladderKeys/, "ladder format");
  await assert.rejects(set(f.writer, open, { expectedVersion: 2, shortName: "" }), /shortName/);
  await f.refused(f.writer, { type: "stage.milestone.set", stageId: open, expectedVersion: 1, shortName: "a", checkMethod: "b", dueOn: null, ladderKeys: [], reason: "stale" }, "VERSION_CONFLICT");
  await f.refused(f.writer, { type: "stage.milestone.set", stageId: randomUUID(), expectedVersion: 0, shortName: "a", checkMethod: "b", dueOn: null, ladderKeys: [], reason: "nowhere" }, "NOT_FOUND");
  // Accepted: dueOn and checkMethod need decision authority; shortName and ladderKeys do not.
  await f.applied(f.decider, { type: "stage.accept", stageId: open, expectedVersion: 1, reason: "accept" });
  await f.refused(f.writer, { type: "stage.milestone.set", stageId: open, expectedVersion: 2, shortName: "改后", checkMethod: "新办法", dueOn: "2026-12-20", ladderKeys: ["M1", "M4"], reason: "later" }, "FORBIDDEN");
  await f.refused(f.writer, { type: "stage.milestone.set", stageId: open, expectedVersion: 2, shortName: "改后", checkMethod: "另一个办法", dueOn: "2026-12-09", ladderKeys: ["M1", "M4"], reason: "later" }, "FORBIDDEN");
  r = await set(f.writer, open, { expectedVersion: 2, shortName: "只改名", checkMethod: "新办法", dueOn: "2026-12-09", ladderKeys: ["M2"] }); assert.equal(r.status, "applied", JSON.stringify(r));
  r = await set(f.decider, open, { expectedVersion: 3, shortName: "只改名", checkMethod: "新办法", dueOn: "2026-12-20", ladderKeys: ["M2"] }); assert.equal(r.status, "applied", JSON.stringify(r));
  r = await set(f.decider, open, { expectedVersion: 4, shortName: "只改名", checkMethod: "决定者改办法", dueOn: "2026-12-20", ladderKeys: ["M2"] }); assert.equal(r.status, "applied", JSON.stringify(r));
  read = await f.workflow.getStageMilestone(f.writer, f.projectId, open);
  assert.equal(read.history.length, 5, "one history row per successful change, none for the refused ones");
  // Reviewed: the due date stays.
  await f.applied(f.decider, { type: "stage.review", stageId: open, expectedVersion: 2, adopted: "a", rejected: "r", gap: "g", nextChoice: "continue", evidence: "e", reason: "review" });
  await f.refused(f.decider, { type: "stage.milestone.set", stageId: open, expectedVersion: 5, shortName: "只改名", checkMethod: "决定者改办法", dueOn: "2027-01-01", ladderKeys: ["M2"], reason: "late" }, "STAGE_REVIEWED");
  r = await set(f.decider, open, { expectedVersion: 5, shortName: "回看后改名", checkMethod: "决定者改办法", dueOn: "2026-12-20", ladderKeys: ["M2"] }); assert.equal(r.status, "applied", JSON.stringify(r));
  // A stage with no row yet (version 0) can be registered.
  const legacy = await f.stage();
  await f.pool.query("DELETE FROM stage_milestone_history WHERE stage_id=$1", [legacy]); await f.pool.query("DELETE FROM stage_milestone WHERE stage_id=$1", [legacy]);
  r = await f.issue(f.writer, { type: "stage.milestone.set", stageId: legacy, expectedVersion: 0, shortName: "补登", checkMethod: "法", dueOn: null, ladderKeys: [], reason: "补" }); assert.equal(r.status, "applied", JSON.stringify(r));
  assert.equal((await f.workflow.getStageMilestone(f.writer, f.projectId, legacy)).milestone?.version, 1);
});

test("a Task's stage ownership follows task.create and task.update in the side table and no other Task gets a row", async t => {
  const f = await setup(t, "ms_owner");
  const a = await f.stage({}, true), b = await f.stage({}, true);
  const owned = await f.task(a), free = await f.task();
  const read = async (taskId: string) => (await f.workflow.getTaskStage(f.decider, f.projectId, taskId)).taskStage;
  assert.deepEqual([(await read(owned))?.stageId, (await read(owned))?.version, await read(free)], [a, 1, null], "a created stage Task has its row; one without a stage has none");
  const revisionsBefore = await f.rows("task_revision");
  let version = (await f.workflow.getTask(f.decider, f.projectId, owned)).task.version;
  await f.applied(f.decider, { type: "task.update", taskId: owned, expectedVersion: version, title: "T", content: "Body", acceptance: "Check", owner: f.owner, stageId: b, reason: "move" });
  assert.deepEqual([(await read(owned))?.stageId, (await read(owned))?.version], [b, 2], "the side table follows a stage change on a todo Task");
  assert.equal(await f.rows("task_revision"), revisionsBefore + 1, "only the update itself added a revision");
  version = (await f.workflow.getTask(f.decider, f.projectId, owned)).task.version;
  await f.applied(f.decider, { type: "task.update", taskId: owned, expectedVersion: version, title: "T2", content: "Body", acceptance: "Check", owner: f.owner, reason: "no stage field" });
  assert.deepEqual([(await read(owned))?.stageId, (await read(owned))?.version], [b, 2], "an update that does not touch the stage leaves the row alone");
  version = (await f.workflow.getTask(f.decider, f.projectId, owned)).task.version;
  await f.applied(f.decider, { type: "task.update", taskId: owned, expectedVersion: version, title: "T2", content: "Body", acceptance: "Check", owner: f.owner, stageId: null, reason: "detach" });
  assert.equal(await read(owned), null, "detached: back to unassigned");
  const history = (await f.pool.query("SELECT version, stage_id, reason FROM task_stage_history WHERE task_id=$1 ORDER BY version", [owned])).rows;
  assert.deepEqual(history.map(row => [row.version, row.stage_id]), [[1, a], [2, b], [3, null]], "creation, move and removal are all in the history");
  assert.equal(Number((await f.pool.query("SELECT count(*) AS n FROM task_stage WHERE task_id=$1", [free])).rows[0].n), 0);
});

test("migration 118 over existing data: old tables unchanged, ladder keys and ownership backfilled with their source, then forward rollback leaves the old reads working", async t => {
  const f = await setup(t, "ms_migrate");
  // Existing data, written the way it was before the migration: stages with phase keys, tasks whose proposals name a stage (one moved, one cancelled), one with none.
  const a = await f.stage({}, true), b = await f.stage({}, true), c = await f.stage();
  await f.applied(f.decider, { type: "stage.phaseKey.set", stageId: a, phaseKey: "M1", reason: "map a" });
  await f.applied(f.decider, { type: "stage.phaseKey.set", stageId: b, phaseKey: "M0.5", reason: "map b" });
  const inA = await f.task(a), inB = await f.task(b), moved = await f.task(a), none = await f.task(), cancelled = await f.task(b);
  const version = (await f.workflow.getTask(f.decider, f.projectId, moved)).task.version;
  await f.applied(f.decider, { type: "task.update", taskId: moved, expectedVersion: version, title: "T", content: "Body", acceptance: "Check", owner: f.owner, stageId: b, reason: "move" });
  await f.applied(f.decider, { type: "task.cancel", taskId: cancelled, expectedVersion: 1, reason: "no longer needed" });
  await f.applied(f.decider, { type: "stage.review", stageId: a, expectedVersion: 2, adopted: "a", rejected: "r", gap: "g", nextChoice: "continue", evidence: "e", reason: "review" });
  // Put the database back to how it was before 118: drop its tables and forget it ran.
  await f.pool.query("DROP TABLE task_stage_history; DROP TABLE task_stage; DROP TABLE stage_milestone_history; DROP TABLE stage_milestone; DELETE FROM pgmigrations WHERE name >= '118'");
  const watched = ["project_stage", "stage_revision", "stage_review", "stage_phase_key", "task", "task_revision", "task_proposal", "task_revision"];
  const before = await Promise.all(watched.map(table => f.pool.query(`SELECT md5(string_agg(t::text, '|' ORDER BY t::text)) AS h, count(*) AS n FROM ${table} t`).then(r => `${r.rows[0].n}:${r.rows[0].h}`)));
  await migrate(database!, f.schema);
  const after = await Promise.all(watched.map(table => f.pool.query(`SELECT md5(string_agg(t::text, '|' ORDER BY t::text)) AS h, count(*) AS n FROM ${table} t`).then(r => `${r.rows[0].n}:${r.rows[0].h}`)));
  assert.deepEqual(after, before, "no existing row of the stage, review, phase key, Task, revision or proposal tables changed");
  const ladder = (await f.pool.query("SELECT stage_id, short_name, due_on, check_method, ladder_keys, reason FROM stage_milestone ORDER BY ladder_keys")).rows;
  assert.deepEqual(ladder.map(row => [row.stage_id, row.short_name, row.due_on, row.check_method, row.ladder_keys]), [[b, null, null, null, ["M0.5"]], [a, null, null, null, ["M1"]]], "ladder keys copied, nothing else guessed; the unmapped stage has no row");
  assert.ok(ladder.every(row => row.reason.startsWith("迁移自 stage_phase_key")));
  assert.equal(Number((await f.pool.query("SELECT count(*) AS n FROM stage_milestone_history")).rows[0].n), 2);
  assert.equal((await f.pool.query("SELECT 1 FROM stage_milestone WHERE stage_id=$1", [c])).rowCount, 0);
  const owned = new Map((await f.pool.query("SELECT task_id, stage_id, reason FROM task_stage")).rows.map(row => [row.task_id, row]));
  assert.deepEqual([...owned.keys()].sort(), [inA, inB, moved, cancelled].sort(), "every Task whose latest proposal names a stage (the cancelled one too) and no other");
  assert.equal(owned.get(moved).stage_id, b, "the latest proposal decides: the moved Task belongs to its new stage");
  assert.equal(owned.get(cancelled).stage_id, b);
  assert.ok([...owned.values()].every(row => row.reason === "迁移自 task_proposal"));
  assert.equal(owned.has(none), false);
  assert.equal(Number((await f.pool.query("SELECT count(*) AS n FROM task_stage_history")).rows[0].n), 4);
  // Forward rollback (docs/development/local-run.md): drop the four tables; the old milestone read and the old tables keep working.
  await f.pool.query(readFileSync(new URL("../../packages/adapter-postgres/rollback/118_drop_stage_milestone_task_stage.sql", import.meta.url), "utf8"));
  const gone = await f.pool.query("SELECT count(*) AS n FROM information_schema.tables WHERE table_schema=$1 AND table_name IN ('stage_milestone','stage_milestone_history','task_stage','task_stage_history')", [f.schema]);
  assert.equal(Number(gone.rows[0].n), 0);
  const links = await f.pool.query("SELECT phase_key FROM stage_phase_key WHERE project_id=$1 ORDER BY phase_key", [f.projectId]);
  assert.deepEqual(links.rows.map(row => row.phase_key), ["M0.5", "M1"], "the old phase-key rows still read");
  assert.equal((await f.workflow.getStage(f.decider, f.projectId, a)).state, "reviewed");
  const finalAfter = await Promise.all(watched.map(table => f.pool.query(`SELECT md5(string_agg(t::text, '|' ORDER BY t::text)) AS h, count(*) AS n FROM ${table} t`).then(r => `${r.rows[0].n}:${r.rows[0].h}`)));
  assert.deepEqual(finalAfter, before, "the old tables are unchanged after the rollback too");
});
