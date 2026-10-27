import assert from "node:assert/strict";
import { test } from "node:test";
import { currentWorkRelationLabel, sessionHeaderStatusLabel, sessionIdleSummary, sessionLifecycleLabel, sessionStatusLabel } from "../src/sessions/sessionStatusPresentation.ts";

test("owned lifecycle takes priority over activity and only ready can be idle", () => {
  for (const [runtimeState, expected] of [["reserved", "已预留"], ["creating", "创建中"], ["closing", "关闭中"], ["unknown", "生命周期待核对"], ["closed", "已关闭"]] as const) {
    assert.equal(sessionStatusLabel({ kind: "owned", runtimeState, busy: false }), expected);
    assert.equal(sessionStatusLabel({ kind: "owned", runtimeState, busy: true }), expected);
  }
  assert.equal(sessionStatusLabel({ kind: "owned", runtimeState: "ready", busy: false }), "空闲");
  assert.equal(sessionStatusLabel({ kind: "owned", runtimeState: "ready", busy: true }), "结果待核对");
  assert.equal(sessionStatusLabel({ kind: "owned", runtimeState: "ready", busy: true, latestBusinessRun: { state: "running" } }), "运行中");
  assert.equal(sessionStatusLabel({ kind: "owned", runtimeState: "ready", busy: true, latestBusinessRun: { state: "dispatching" } }), "启动中");
  assert.equal(sessionStatusLabel({ kind: "owned", runtimeState: null, busy: false }), "生命周期未知");
  assert.equal(sessionLifecycleLabel({ kind: "owned", runtimeState: "closed", busy: false }), "已关闭");
});

test("external sessions keep unverified activity separate from owned lifecycle", () => {
  assert.equal(sessionStatusLabel({ kind: "external", runtimeState: null, busy: null }), "状态未知");
  assert.match(sessionLifecycleLabel({ kind: "external", runtimeState: null, busy: null }), /需核对/);
});

test("only a ready owned Session with confirmed no activity is called idle", () => {
  for (const state of ["reserved", "creating", "closing", "unknown", "closed", null] as const) {
    assert.notEqual(sessionIdleSummary({ kind: "owned", runtimeState: state, busy: false }, false), "当前空闲");
  }
  assert.equal(sessionIdleSummary({ kind: "owned", runtimeState: "ready", busy: false }, false), "当前空闲");
  assert.equal(sessionIdleSummary({ kind: "owned", runtimeState: "ready", busy: false }, true), "当前空闲 · 已有交付待核对");
  assert.equal(sessionIdleSummary({ kind: "external", runtimeState: null, busy: null }, false), "外部会话状态需核对");
});

test("late message progress cannot mask a closing or closed owned Session", () => {
  for (const state of ["closing", "closed", "unknown"] as const) {
    assert.equal(sessionHeaderStatusLabel({ kind: "owned", runtimeState: state, busy: true }, true), sessionLifecycleLabel({ kind: "owned", runtimeState: state, busy: true }));
  }
  assert.equal(sessionHeaderStatusLabel({ kind: "owned", runtimeState: "ready", busy: true }, true), "消息处理中");
  assert.equal(sessionHeaderStatusLabel({ kind: "owned", runtimeState: "ready", busy: false }, true), "空闲");
});

test("a claimed Task uses its matching Run result before describing the next action", () => {
  const work = { id: "task-1", relation: "claimed", state: "in_progress" } as Parameters<typeof currentWorkRelationLabel>[0];
  const session = (taskId: string, state: string) => ({ kind: "owned" as const, runtimeState: "ready", busy: false,
    latestBusinessRun: { id: "run-1", taskId, state, updatedAt: "2026-10-27T00:00:00Z", source: {} as never } });
  assert.equal(currentWorkRelationLabel(work, { ...session("task-1", "completed"), busy: false }, "awaiting_acceptance"), "执行已结束，等待交付与验收");
  assert.equal(currentWorkRelationLabel(work, session("task-1", "completed")), "最近一次执行已结束，结果待核对");
  assert.equal(currentWorkRelationLabel(work, session("task-1", "completed"), "reworking"), "前次执行已结束，同任务返工待运行");
  assert.equal(currentWorkRelationLabel(work, session("task-1", "running"), "reworking"), "已认领，本次运行中");
  assert.equal(currentWorkRelationLabel(work, { ...session("task-1", "unknown"), busy: true }), "最近一次执行结果未知，待核对");
  assert.equal(currentWorkRelationLabel(work, session("other-task", "completed")), "已认领，待运行");
  assert.equal(currentWorkRelationLabel(work, { kind: "owned", runtimeState: "ready", busy: false, latestBusinessRun: null }), "已认领，待运行");
});
