import assert from "node:assert/strict";
import { test } from "node:test";
import { currentWorkRelationLabel, idleSessionResult, latestSessionResult, runStateLabel, sessionHeaderStatusLabel, sessionIdleSummary, sessionLifecycleLabel, sessionResultUseLabel, sessionStatusLabel } from "../src/sessions/sessionStatusPresentation.ts";
import type { SessionResult } from "@evoloop/contracts/session-observation";

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
    assert.notEqual(sessionIdleSummary({ kind: "owned", runtimeState: state, busy: false }), "当前空闲");
  }
  assert.equal(sessionIdleSummary({ kind: "owned", runtimeState: "ready", busy: false }), "当前空闲");
  assert.equal(sessionIdleSummary({ kind: "external", runtimeState: null, busy: null }), "外部会话状态需核对");
});

test("latest fixed Delivery, not an older observation for the same Task, drives the idle summary", () => {
  const result = (deliveryId: string, submittedAt: string, use: "used" | "failed" | "notUsed" | null) => ({
    deliveryId, taskId: "task-1", taskTitle: "从用户视角审核 Session 协作总体计划", technicalResult: "passed", submittedAt,
    latestUse: use ? { result: use, createdAt: submittedAt, observer: "reviewer", observerKind: "human", source: {} } : null,
  }) as SessionResult;
  const older = result("old", "2026-10-27T05:32:41Z", null);
  const recent = result("new", "2026-10-27T05:34:07Z", "used");
  assert.equal(latestSessionResult([older, recent]), recent, "source order cannot make the old null observation current");
  assert.equal(sessionResultUseLabel(latestSessionResult([older, recent])!), "已记录使用");
  assert.equal(latestSessionResult([recent, older]), recent);
  assert.equal(latestSessionResult([result("older-failed", "2026-10-27T05:33:00Z", "failed"), recent]), recent);
  assert.equal(sessionResultUseLabel(latestSessionResult([recent, result("newer", "2026-10-27T06:00:00Z", "failed")])!), "使用观察失败");
  assert.equal(sessionResultUseLabel(latestSessionResult([recent, result("newest", "2026-10-27T07:00:00Z", null)])!), "尚无实际使用观察");
  assert.equal(sessionResultUseLabel(result("not-used", "2026-10-27T07:00:00Z", "notUsed")), "已记录未使用");
  assert.equal(sessionResultUseLabel(older), "尚无实际使用观察");
  assert.equal(latestSessionResult([]), null);
  const ready = { kind: "owned" as const, runtimeState: "ready", busy: false };
  assert.equal(idleSessionResult(ready, null, [older, recent]), recent);
  assert.equal(idleSessionResult(ready, null, []), null);
  assert.equal(idleSessionResult(ready, { id: "task-1" } as Parameters<typeof idleSessionResult>[1], [recent]), null);
  for (const runtimeState of ["closing", "closed", "unknown"])
    assert.equal(idleSessionResult({ ...ready, runtimeState }, null, [recent]), null);
  assert.equal(idleSessionResult({ ...ready, busy: true }, null, [recent]), null);
  assert.equal(idleSessionResult({ kind: "external", runtimeState: null, busy: false }, null, [recent]), null);
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
  assert.equal(currentWorkRelationLabel(work, session("task-1", "running"), "reworking"), "Run 已认领，本次运行中");
  assert.equal(currentWorkRelationLabel(work, { ...session("task-1", "unknown"), busy: true }), "最近一次执行结果未知，待核对");
  assert.equal(currentWorkRelationLabel(work, session("other-task", "completed")), "Run／队列已认领或占用；当前运行待核对");
  assert.equal(currentWorkRelationLabel(work, { kind: "owned", runtimeState: "ready", busy: false, latestBusinessRun: null }), "Run／队列已认领或占用；当前运行待核对");
  assert.equal(currentWorkRelationLabel({ ...work, relation: "run" }, session("task-1", "running")), "有 Run 关联；不表示具体分派已接受");
  assert.equal(currentWorkRelationLabel({ ...work, relation: "accepted" }, session("task-1", "running")), "具体 Session 已接手");
});

test("recent Run states are readable without implying assignment acceptance", () => {
  assert.equal(runStateLabel("completed"), "已结束");
  assert.equal(runStateLabel("failed"), "失败");
  assert.equal(runStateLabel("unknown"), "结果未知");
  assert.equal(runStateLabel("unrecognized"), "状态待核对（unrecognized）");
});
