import assert from "node:assert/strict";
import { test } from "node:test";
import { holdText, scheduledEmptyText, timingWaitText, unsettledRunText } from "../src/features/overview/overviewPresentation.ts";

test("a held queue entry is described by its code; the free-text reason is not part of the line", () => {
  assert.equal(holdText("awaiting_acceptance"), "等待消费者使用与验收");
  assert.equal(holdText("dependency"), "依赖尚未放行");
  assert.equal(holdText(null), "队列已暂停，原因待核对");
  assert.doesNotMatch(holdText("session_unready"), /[A-Za-z]/);
});

test("an unsettled run reads as words, never as its state code", () => {
  assert.equal(unsettledRunText("dispatching"), "执行正在派发");
  assert.equal(unsettledRunText("requested"), "执行已请求，尚未开始");
  assert.equal(unsettledRunText("unknown"), "上次执行结果未知");
  assert.equal(unsettledRunText("paused-by-host"), "执行状态待核对");
  assert.equal(unsettledRunText(null), null);
  assert.doesNotMatch(timingWaitText, /[A-Za-z0-9]/);
});

test("scheduled work is only called absent after a complete, current read", () => {
  const base = { hasSnapshot: true, stale: false, timingReadFailed: 0, timingScanLimited: false };
  assert.equal(scheduledEmptyText(base), "已读范围内没有约定执行的未结束任务。");
  const failed = scheduledEmptyText({ ...base, timingReadFailed: 3 });
  assert.match(failed, /3 项任务的执行时间未能读回，无法判断/);
  assert.doesNotMatch(failed, /没有约定执行/);
  assert.doesNotMatch(scheduledEmptyText({ ...base, timingReadFailed: 1, stale: true }), /没有约定执行/);
  assert.equal(scheduledEmptyText({ ...base, hasSnapshot: false }), "约定执行任务待读回。");
  assert.match(scheduledEmptyText({ ...base, stale: true }), /上次读回.*当前待核对/);
  assert.match(scheduledEmptyText({ ...base, timingScanLimited: true }), /其余任务未核对/);
});
