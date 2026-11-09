import assert from "node:assert/strict";
import { test } from "node:test";
import type { NativeProgressView } from "../src/features/sessions/NativeSessionPanel";
import { executionSourceNote, nativeExecutionLabel } from "../src/features/sessions/executionStatusPresentation";

const progress = (status: NonNullable<NativeProgressView["turn"]>["status"],
  freshness: NativeProgressView["freshness"] = "live"): NativeProgressView => ({
  projectId: "p", sessionId: "s", threadId: "thread", observedAt: "2026-11-03T03:42:00Z",
  lastEventAt: "2026-11-02T16:54:15Z", freshness, staleReason: freshness === "stale" ? "disconnected" : null,
  status: "active", turn: { id: "turn", status, source: { kind: "message", id: "message", taskId: null, processingId: "processing" } },
  items: [], plan: null, diff: null, usage: null,
});

test("live binding with old activity reports native status without asserting useful progress or failure", () => {
  const observed = progress("inProgress");
  assert.equal(nativeExecutionLabel(observed, true), "原生宿主回报 Turn 进行中");
  assert.match(executionSourceNote(observed, true, "processing"), /不能据此认定仍在有效推进/);
  assert.equal(nativeExecutionLabel(observed, false), "原生观察已过期，当前状态待核对");
  assert.equal(nativeExecutionLabel(progress("inProgress", "stale"), true), "原生观察已过期，当前状态待核对");
  assert.match(executionSourceNote(progress("inProgress", "stale"), true, "processing"), /按原 Session、Turn 和消息核对/);
});

test("exact Turn and persisted message conflict stays unresolved", () => {
  assert.match(executionSourceNote(progress("inProgress"), true, "replied"), /不一致/);
  assert.match(executionSourceNote(progress("completed"), true, "processing"), /不一致/);
  assert.match(executionSourceNote(progress("unknown"), true, "unknown"), /结果未知/);
  assert.equal(nativeExecutionLabel(progress("completed"), true), "原生宿主回报 Turn 已结束");
  const conflictingNative = { ...progress("inProgress"), status: "idle" as const };
  assert.equal(nativeExecutionLabel(conflictingNative, true), "原生状态与 Turn 状态不一致，待核对");
  assert.match(executionSourceNote(conflictingNative, true, "processing"), /同一原生观察内状态冲突/);
});
