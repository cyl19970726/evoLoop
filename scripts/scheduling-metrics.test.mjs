import assert from "node:assert/strict";
import test from "node:test";
import {
  assertReadOnlySql, businessMessages, completeDayWindows, dayWindow, intervalSeconds, mergeIntervals,
  overlapSeconds, parseRolloutLines, percentile, readyToRun, stoppedRuns, subtractIntervals, summary,
  summarizeNotices, summarizeRollout,
} from "./scheduling-metrics.mjs";

const day = dayWindow("2026-11-10");

test("Asia/Tashkent day windows use fixed 00:00+05 boundaries", () => {
  assert.deepEqual(day, {
    date: "2026-11-10",
    startUtc: "2026-11-09T19:00:00.000Z",
    endUtc: "2026-11-10T19:00:00.000Z",
  });
  assert.deepEqual(completeDayWindows(new Date("2026-11-11T13:00:00Z"), 3).map(item => item.date),
    ["2026-11-08", "2026-11-09", "2026-11-10"]);
});

test("percentiles and summaries keep empty values unknown", () => {
  assert.equal(percentile([], 0.5), null);
  assert.equal(percentile([10], 0.9), 10);
  assert.equal(percentile([0, 100], 0.5), 50);
  assert.deepEqual(summary([]), { count: 0, median: null, p90: null, max: null });
  assert.deepEqual(summary([60, 120, 300]), { count: 3, median: 120, p90: 264, max: 300 });
});

test("interval helpers merge overlaps and subtract exclusions", () => {
  const merged = mergeIntervals([{ start: "2026-11-10T00:00:00Z", end: "2026-11-10T01:00:00Z" },
    { start: "2026-11-10T00:30:00Z", end: "2026-11-10T02:00:00Z" }]);
  assert.equal(merged.length, 1);
  assert.equal(intervalSeconds(merged), 7200);
  assert.equal(overlapSeconds({ start: "2026-11-10T01:00:00Z", end: "2026-11-10T03:00:00Z" },
    [{ start: "2026-11-10T01:30:00Z", end: "2026-11-10T02:30:00Z" }]), 3600);
  assert.deepEqual(subtractIntervals([{ start: "2026-11-10T00:00:00Z", end: "2026-11-10T04:00:00Z" }],
    [{ start: "2026-11-10T01:00:00Z", end: "2026-11-10T02:00:00Z" }]), [
    { start: Date.parse("2026-11-10T00:00:00Z"), end: Date.parse("2026-11-10T01:00:00Z") },
    { start: Date.parse("2026-11-10T02:00:00Z"), end: Date.parse("2026-11-10T04:00:00Z") },
  ]);
});

test("only SELECT and WITH statements pass the read-only guard", () => {
  assert.match(assertReadOnlySql("SELECT * FROM runtime_run"), /^select/);
  assert.match(assertReadOnlySql("WITH x AS (SELECT 1) SELECT * FROM x"), /^with/);
  for (const sql of ["UPDATE runtime_run SET state='failed'", "SELECT 1; DELETE FROM task", "CREATE TABLE x(y int)"])
    assert.throws(() => assertReadOnlySql(sql), { code: "SQL_NOT_READ_ONLY" });
});

test("rollout parsing separates turns, context, tokens, and compactions", () => {
  const lines = [
    JSON.stringify({ timestamp: "2026-11-10T01:00:00Z", type: "event_msg", payload: { type: "task_started", turn_id: "t1" } }),
    JSON.stringify({ timestamp: "2026-11-10T01:01:00Z", type: "event_msg", payload: { type: "token_count",
      info: { last_token_usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 5 } } } }),
    JSON.stringify({ timestamp: "2026-11-10T01:02:00Z", type: "event_msg", payload: { type: "token_count",
      info: { last_token_usage: { input_tokens: 300, cached_input_tokens: 200, output_tokens: 7 } } } }),
    JSON.stringify({ timestamp: "2026-11-10T01:03:00Z", type: "event_msg", payload: { type: "task_complete" } }),
    JSON.stringify({ timestamp: "2026-11-10T01:04:00Z", type: "compacted" }),
    JSON.stringify({ timestamp: "2026-11-10T02:00:00Z", type: "event_msg", payload: { type: "task_started", turn_id: "t2" } }),
    JSON.stringify({ timestamp: "2026-11-10T02:01:00Z", type: "event_msg", payload: { type: "token_count",
      info: { last_token_usage: { input_tokens: 500, cached_input_tokens: 450, output_tokens: 11 } } } }),
  ];
  const parsed = parseRolloutLines(lines);
  assert.equal(parsed.turns.length, 2);
  assert.equal(parsed.calls.length, 3);
  assert.equal(parsed.compactions.length, 1);
  const result = summarizeRollout(parsed, day);
  assert.equal(result.turns, 2);
  assert.equal(result.inputTokens, 900);
  assert.equal(result.cachedInputTokens, 690);
  assert.equal(result.outputTokens, 23);
  assert.equal(result.medianContextTokens, 400);
  assert.equal(result.compactions, 1);
});

test("notice waits separate queue, new round, and steer with exclusions", () => {
  const rows = [
    { notice_id: "n1", kind: "delivery", state: "linked", occurred_at: "2026-11-10T01:00:00Z",
      message_id: "m1", message_created_at: "2026-11-10T01:00:10Z",
      processing_started_at: "2026-11-10T01:10:00Z", direct_input_created_at: null },
    { notice_id: "n2", kind: "task_todo", state: "linked", occurred_at: "2026-11-10T02:00:00Z",
      message_id: "m2", message_created_at: "2026-11-10T02:00:10Z",
      processing_started_at: null, direct_input_created_at: null },
    { notice_id: "n3", kind: "delivery", state: "linked", occurred_at: "2026-11-10T03:00:00Z",
      message_id: "m3", message_created_at: "2026-11-10T03:00:10Z",
      processing_started_at: "2026-11-10T03:10:00Z", direct_input_created_at: "2026-11-10T03:05:00Z" },
  ];
  const result = summarizeNotices(rows, day, [{ start: "2026-11-10T01:05:00Z", end: "2026-11-10T01:07:00Z" }]);
  assert.equal(result.total, 3);
  assert.equal(result.pending, 1);
  assert.equal(result.toQueueSeconds.count, 3);
  assert.equal(result.toNewRoundSeconds.count, 2);
  assert.equal(result.toNewRoundSeconds.median, 540);
  assert.equal(result.toSteerSeconds.count, 1);
  assert.equal(result.items[0].rawTurnSeconds, 600);
  assert.equal(result.items[0].excludedSeconds, 120);
});

test("ready-to-run uses Task start and scheduled plan, and subtracts recovery", () => {
  const runs = [
    { run_id: "r1", task_id: "t1", session_id: "s1", state: "completed", created_at: "2026-11-10T02:00:00Z", updated_at: "2026-11-10T02:30:00Z" },
    { run_id: "r2", task_id: "t2", session_id: "s1", state: "completed", created_at: "2026-11-10T10:00:00Z", updated_at: "2026-11-10T10:30:00Z" },
  ];
  const revisions = [
    { task_id: "t1", revision_id: "v1", version: 1, state: "in_progress", created_at: "2026-11-10T01:00:00Z" },
    { task_id: "t2", revision_id: "v2", version: 1, state: "in_progress", created_at: "2026-11-10T09:00:00Z" },
  ];
  const timing = [{ task_id: "t2", planned_at_utc: "2026-11-10T08:00:00Z" }];
  const result = readyToRun(runs, revisions, timing, day,
    [{ sessionId: "s1", start: "2026-11-10T01:30:00Z", end: "2026-11-10T01:45:00Z" }]);
  assert.equal(result.count, 2);
  assert.equal(result.items[0].rawSeconds, 3600);
  assert.equal(result.items[0].excludedSeconds, 900);
  assert.equal(result.items[0].adjustedSeconds, 2700);
  assert.equal(result.items[1].source, "scheduled");
  assert.equal(result.bySource.scheduled.count, 1);
});

test("stopped runs report whether a delivery exists", () => {
  const runs = [
    { run_id: "r1", task_id: "t1", session_id: "s1", state: "interrupted", created_at: "2026-11-10T02:00:00Z", updated_at: "2026-11-10T02:05:00Z", interrupt_requested: true },
    { run_id: "r2", task_id: "t2", session_id: "s1", state: "completed", created_at: "2026-11-10T03:00:00Z", updated_at: "2026-11-10T03:10:00Z", interrupt_requested: true },
    { run_id: "r3", task_id: "t3", session_id: "s1", state: "completed", created_at: "2026-11-10T04:00:00Z", updated_at: "2026-11-10T04:10:00Z", interrupt_requested: false },
  ];
  const result = stoppedRuns(runs, [{ delivery_id: "d1", run_id: "r1" }], [], day);
  assert.equal(result.count, 2);
  assert.equal(result.deliveredCount, 1);
  assert.equal(result.undeliveredCount, 1);
});

test("business messages compare Task context with existing runs", () => {
  const sessions = [
    { session_id: "leader", role_title: "项目 Leader", actor_id: "leader-codex-agent" },
    { session_id: "dev", role_title: "功能开发", actor_id: "dev-agent" },
  ];
  const runs = [{ run_id: "r1", task_id: "t1", session_id: "dev", created_at: "2026-11-10T02:00:00Z" }];
  const messages = [
    { message_id: "m1", sender_actor_id: "leader-codex-agent", session_id: "dev", context_task_id: "t1",
      created_at: "2026-11-10T01:50:00Z", content: "请开始实现这个 Task" },
    { message_id: "m2", sender_actor_id: "leader-codex-agent", session_id: "dev", context_task_id: "t2",
      created_at: "2026-11-10T01:55:00Z", content: "请修复这个 Task" },
    { message_id: "m3", sender_actor_id: "leader-codex-agent", session_id: "leader", context_task_id: "t1",
      created_at: "2026-11-10T01:56:00Z", content: "通知" },
  ];
  const result = businessMessages({ messages, sessions, runs, window: day });
  assert.equal(result.allLeaderMessages, 3);
  assert.equal(result.taskContextMessages, 2);
  assert.equal(result.workLikeMessages, 2);
  assert.equal(result.distinctTasks, 2);
  assert.equal(result.tasksWithoutAnyRun, 1);
});
