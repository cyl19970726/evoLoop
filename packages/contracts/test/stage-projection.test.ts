import assert from "node:assert/strict";
import test from "node:test";
import { dayIn, deriveStageProjection, isValidTimeZone, stageProjectionQuerySchema, taskBucket } from "../src/stage-projection.js";
import type { Stage, StageMilestone, StageReview } from "../src/workflow.js";

const stage = (id: string, state: Stage["state"], createdAt = "2026-01-01T00:00:00.000Z"): Stage => ({ projectId: "p", id, goalId: "g", version: 1, deliverable: "d", learningQuestion: "q", state, createdAt, actorId: "a" });
const ms = (stageId: string, dueOn: string | null, shortName: string | null = "x"): StageMilestone => ({ projectId: "p", stageId, version: 1, shortName, dueOn, checkMethod: "c", ladderKeys: [], actorId: "a", reason: "r", updatedAt: "2026-01-01T00:00:00.000Z" });
const rv = (stageId: string, adopted: string, gap: string, createdAt: string, id = "r1", supersedesReviewId: string | null = null): StageReview =>
  ({ projectId: "p", id, stageId, stageVersion: 2, supersedesReviewId, adopted, rejected: "无", gap, nextChoice: "continue", evidence: "e", reason: "r", actorId: "a", createdAt });
const base = { asOf: "2026-12-02T20:00:00.000Z", timeZone: "UTC" };

test("task buckets and the day in a time zone", () => {
  assert.equal(taskBucket({ phase: "closed", state: "done" }), "closed");
  assert.equal(taskBucket({ phase: "blocked", state: "in_progress" }), "blocked");
  assert.equal(taskBucket({ phase: "todo", state: "todo" }), "notStarted");
  assert.equal(taskBucket({ phase: "in_progress", state: "in_progress" }), "inProgress");
  assert.equal(dayIn(base.asOf, "UTC"), "2026-12-02");
  assert.equal(dayIn(base.asOf, "Asia/Tashkent"), "2026-12-03");
  assert.equal(isValidTimeZone("Mars/Olympus"), false);
  assert.equal(stageProjectionQuerySchema.safeParse({ timeZone: "Mars/Olympus" }).success, false);
  assert.equal(stageProjectionQuerySchema.safeParse({}).success, true);
});

test("statuses, counts, unowned and the current stage", () => {
  const stages = [stage("a", "proposed"), stage("b", "active"), stage("c", "active"), stage("d", "reviewed"), stage("e", "reviewed")];
  const milestones = new Map([["a", ms("a", "2026-12-30")], ["b", ms("b", "2026-12-03")], ["c", ms("c", "2026-12-01")], ["d", ms("d", "2026-11-01")], ["e", ms("e", "2026-11-02")]]);
  const reviews = new Map([["d", [rv("d", "做了", "无", "2026-12-01T00:00:00.000Z")]], ["e", [rv("e", "无", "无", "2026-12-01T00:00:00.000Z")]]]);
  const tasks = [
    { taskId: "1", phase: "in_progress", state: "in_progress", link: { stageId: "c" } },
    { taskId: "2", phase: "closed", state: "done", link: { stageId: "c" } },
    { taskId: "3", phase: "todo", state: "todo", link: null },
    { taskId: "4", phase: "todo", state: "todo", link: { stageId: null } },
    { taskId: "5", phase: "closed", state: "done", link: null },
  ];
  const p = deriveStageProjection({ ...base, stages, milestones, reviews, tasks });
  const by = Object.fromEntries(p.stages.map(s => [s.id, s]));
  assert.equal(by.a.status, "not_accepted");
  assert.equal(by.b.status, "accepted_no_tasks");
  assert.equal(by.c.status, "overdue_awaiting_review");
  assert.equal(by.d.status, "achieved");
  assert.equal(by.e.status, "not_achieved");
  assert.deepEqual(by.c.tasks, { inProgress: 1, blocked: 0, notStarted: 0, closed: 1, total: 2 });
  assert.deepEqual(p.tasksNoStage, { unowned: 1, declared: 1 });
  assert.equal(p.currentStageId, "c");
  assert.equal(p.today, "2026-12-02");
});

test("no current stage says why; a reviewed stage without a record is not guessed", () => {
  const none = deriveStageProjection({ ...base, stages: [stage("a", "reviewed")], milestones: new Map(), reviews: new Map(), tasks: [] });
  assert.equal(none.stages[0].status, "review_missing");
  assert.equal(none.currentStageId, null);
  assert.equal(none.currentNote, "没有已接受且未回看的阶段");
  const undated = deriveStageProjection({ ...base, stages: [stage("a", "active")], milestones: new Map([["a", ms("a", null)]]), reviews: new Map(), tasks: [] });
  assert.equal(undated.currentNote, "当前阶段未登记");
});
