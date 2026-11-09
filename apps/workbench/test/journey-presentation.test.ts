// 目标与阶段 in words: a stage's next step from its tasks, which tasks belong to which stage, how reviews stand.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { StageReview } from "@evoloop/contracts";
import type { LeaderWorkTask } from "@evoloop/contracts/work-index";
import {
  defaultSelection, goalTree, groupByStage, orderReviews, orderStageTasks, phaseCounts, reviewStanding, stageNextStep, stageStatus,
} from "../src/features/workflow/journeyPresentation.ts";
import { leaderPhaseLabel } from "../src/shared/leaderWorkLoad.ts";

type Row = Pick<LeaderWorkTask, "taskId" | "phase" | "taskState" | "stage" | "dates">;
const row = (taskId: string, phase: LeaderWorkTask["phase"], stageId: string | null, changed = "2026-11-09T00:00:00.000Z"): Row => ({
  taskId, phase, taskState: phase === "closed" ? "done" : phase === "cancelled" ? "cancelled" : phase === "running" ? "in_progress" : "todo",
  stage: stageId ? { stageId, deliverable: "交付" } : null,
  dates: { createdAt: changed, businessChangedAt: changed, startedAt: null, completedAt: null, observedAt: changed },
});

test("a stage's next step follows its state and its tasks, and never concludes from an unread or partial list", () => {
  assert.match(stageNextStep({ state: "proposed" }, []), /接受/);
  assert.match(stageNextStep({ state: "reviewed" }, null), /已回看/);
  assert.match(stageNextStep({ state: "active" }, null), /尚未读全/);
  assert.match(stageNextStep({ state: "active" }, [], false), /尚未读全/);
  assert.match(stageNextStep({ state: "active" }, []), /首项所属任务/);
  assert.match(stageNextStep({ state: "active" }, [row("a", "unknown", "s"), row("b", "awaiting_acceptance", "s")]), /结果未知/);
  assert.match(stageNextStep({ state: "active" }, [row("a", "running", "s"), row("b", "awaiting_acceptance", "s")]), /核对交付与实际使用/);
  assert.match(stageNextStep({ state: "active" }, [row("a", "running", "s"), row("b", "blocked", "s")]), /受阻/);
  assert.match(stageNextStep({ state: "active" }, [row("a", "running", "s")]), /继续执行/);
  assert.match(stageNextStep({ state: "active" }, [row("a", "unassigned", "s")]), /安排承接/);
  assert.match(stageNextStep({ state: "active" }, [row("a", "closed", "s"), row("b", "cancelled", "s")]), /阶段回看/);
  assert.deepEqual(Object.values(stageStatus).map(item => item.label), ["待接受", "推进中", "已回看"]);
});

test("tasks group under the stages that were read; others are counted outside, open work first", () => {
  const tasks = [row("a", "closed", "s1"), row("b", "running", "s1"), row("c", "unknown", "s1"), row("d", "ready", null), row("e", "ready", "gone")];
  const groups = groupByStage(tasks, [{ id: "s1" }, { id: "s2" }]);
  assert.deepEqual(groups.byStage.get("s1")?.map(item => item.taskId), ["a", "b", "c"]);
  assert.equal(groups.byStage.has("s2"), false);
  assert.deepEqual(groups.outside.map(item => item.taskId), ["d", "e"]);
  assert.deepEqual(orderStageTasks(groups.byStage.get("s1")!).map(item => item.taskId), ["c", "b", "a"]);
  assert.equal(phaseCounts(groups.byStage.get("s1")!, phase => leaderPhaseLabel[phase]), "结果未知 1 · 运行中 1 · 已关闭 1");
});

test("the latest review is current only on a fresh read; earlier ones were replaced", () => {
  const review = (id: string, stageVersion: number, createdAt: string): StageReview => ({ projectId: "p", id, stageId: "s", stageVersion, supersedesReviewId: null,
    adopted: "", rejected: "", gap: "", nextChoice: "continue", evidence: "", reason: "", actorId: "a", createdAt });
  const ordered = orderReviews([review("late", 3, "2026-11-09T00:00:00Z"), review("early", 2, "2026-11-10T00:00:00Z"), review("mid", 3, "2026-11-08T00:00:00Z")]);
  assert.deepEqual(ordered.map(item => item.id), ["early", "mid", "late"]);
  assert.equal(reviewStanding(ordered[2]!, "late", true), "当前判断");
  assert.equal(reviewStanding(ordered[2]!, "late", false), "上次读回的判断");
  assert.equal(reviewStanding(ordered[0]!, "late", true), "已被后续回看替代");
});

test("the page opens on the first stage being worked on, lists stages under their goals and keeps orphans apart", () => {
  const goals = [{ id: "g1" }, { id: "g2" }];
  const stages = [{ id: "s1", goalId: "g1", state: "reviewed" as const }, { id: "s2", goalId: "g2", state: "active" as const }, { id: "s3", goalId: "gone", state: "proposed" as const }];
  assert.deepEqual(defaultSelection(goals, stages), { stageId: "s2" });
  assert.deepEqual(defaultSelection(goals, [stages[0]!]), { stageId: "s1" });
  assert.deepEqual(defaultSelection(goals, []), { goalId: "g1" });
  assert.equal(defaultSelection([], []), null);
  const tree = goalTree(goals, stages);
  assert.deepEqual(tree.items.map(item => [item.goal.id, item.stages.map(stage => stage.id)]), [["g1", ["s1"]], ["g2", ["s2"]]]);
  assert.deepEqual(tree.orphans.map(stage => stage.id), ["s3"]);
});
