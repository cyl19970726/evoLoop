import assert from "node:assert/strict";
import { test } from "node:test";
import { legacyDecisionLabel, taskNextStep } from "../src/workflow/taskListPresentation.ts";

test("every Task state has a visible next-step hint without claiming authorization", () => {
  assert.match(taskNextStep("todo"), /核对任务范围与固定依据/);
  assert.doesNotMatch(taskNextStep("todo"), /已授权|拒绝|撤回/);
  assert.match(taskNextStep("in_progress"), /交付/);
  assert.match(taskNextStep("done"), /验收/);
  assert.match(taskNextStep("cancelled"), /取消理由/);
});

test("only a current legacy revision gets a factual old-decision cue", () => {
  const legacy = { state: "deferred" as const, decision: "reject" as const, reason: "原证据不足" };
  assert.equal(legacyDecisionLabel(legacy), "此前暂缓 · 旧判断：拒绝");
  assert.match(taskNextStep("todo", legacy), /旧判断与理由/);
  assert.doesNotMatch(taskNextStep("todo"), /此前|拒绝/);
  assert.equal(legacyDecisionLabel({ state: "proposed", decision: null, reason: "初始提议" }), "此前待判断 · 旧判断未记录");
});
