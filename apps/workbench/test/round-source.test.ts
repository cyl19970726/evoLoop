// Task c58b83e2: how a round got into the line, in words: five sources, one wording each; nothing read says so.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { RunDispatch } from "@evoloop/contracts/session-timeline";
import { dispatchLabel, runSourceLabel } from "../src/features/sessions/roundPresentation.ts";

const base: RunDispatch = { source: "leader", actorId: "leader-codex-agent", viaController: true, scheduleId: null, scheduleTitle: null, reworkObservationId: null, reworkDeliveryId: null };
const me = "zuhriddin";

test("the five sources each get their own label", () => {
  assert.equal(dispatchLabel(base, me), "Leader 派发");
  assert.equal(dispatchLabel({ ...base, actorId: "requirements-claude-agent", viaController: false }, me), "requirements-claude-agent 代派");
  assert.equal(dispatchLabel({ ...base, source: "schedule", actorId: "scheduler-actor", viaController: false, scheduleId: "s1", scheduleTitle: "每日评估" }, me), "日程触发 · 每日评估");
  assert.equal(dispatchLabel({ ...base, source: "rework", reworkObservationId: "o1", reworkDeliveryId: "d1" }, me), "验收退回后返工");
  assert.equal(dispatchLabel({ ...base, actorId: me, viaController: false }, me), "你派发");
});

test("a proxy is never written as the Leader, and a source nobody read is not guessed", () => {
  assert.notEqual(dispatchLabel({ ...base, actorId: "requirements-claude-agent", viaController: false }, me), "Leader 派发");
  assert.equal(dispatchLabel(null, me), "来源待核对");
  assert.equal(dispatchLabel(undefined, me), "来源待核对");
  assert.equal(dispatchLabel({ ...base, source: "schedule", scheduleTitle: " " }, me), "日程触发 · 日程名待核对");
  // The reader's identity wins over the controller test only for a leader-source entry; a schedule or a return is never "你派发".
  assert.equal(dispatchLabel({ ...base, source: "schedule", actorId: me, scheduleId: "s1", scheduleTitle: "x" }, me), "日程触发 · x");
});

test("the strip says the label first, then the Task", () => {
  assert.equal(runSourceLabel("日程触发 · 每日评估", "整理接口"), "日程触发 · 每日评估 · 任务「整理接口」");
  assert.equal(runSourceLabel("来源待核对", null), "来源待核对 · 任务「标题待核对」");
});
