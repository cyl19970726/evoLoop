// Task 9e45cd20: the join of occurrences and dispatch log rows says what each trigger did, and never turns a skip or a fall-back into a success.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Occurrence } from "@evoloop/contracts/scheduling";
import type { ScheduleDispatchLog } from "@evoloop/contracts/schedule-dispatch";
import { dispatchReasonText, triggerRows } from "../src/features/scheduling/dispatch";

const occ = (day: number, state: Occurrence["state"], reason: string, taskId: string | null): Occurrence => ({ projectId: "p", scheduleId: "s", revisionId: "r",
  plannedAtUtc: `2026-11-${day}T01:00:00.000Z`, observedAtUtc: `2026-11-${day}T01:00:00.000Z`, state, taskId, operationId: `o${day}`, reason });
const log = (day: number, state: ScheduleDispatchLog["state"], reason: string, taskId: string | null): ScheduleDispatchLog => ({ scheduleId: "s", plannedAtUtc: `2026-11-${day}T01:00:00.000Z`,
  state, reason, taskId, sessionId: null, entryId: null, templateHash: "h", roleRevisionId: null, executionConfig: {}, decidedAt: "", dispatchedAt: null, escalatedAt: null });

test("trigger rows: newest first, the dispatch decision wins, skips and fall-backs keep their reasons", () => {
  const rows = triggerRows([occ(10, "created", "scheduled", "t1"), occ(11, "created", "scheduled", "t2"), occ(12, "skipped", "overlap skipped", null)],
    [log(10, "dispatched", "", "t1"), log(11, "fell_back", "POLICY_PAUSED", "t2"), log(12, "skipped", "PREVIOUS_STILL_OPEN", "t1")]);
  assert.deepEqual(rows.map(row => row.dispatch?.state), ["skipped", "fell_back", "dispatched"]);
  assert.equal(rows[0].tone, "bad"); assert.match(rows[0].label, /已跳过/); assert.equal(rows[0].taskLabel, "仍未关闭的上一个任务");
  assert.match(rows[1].label, /交回 Leader/); assert.doesNotMatch(rows[1].label, /直派到队伍/); assert.match(rows[1].reasonText, /已暂停/);
  assert.equal(rows[2].reasonCode, "scheduled", "a dispatched row has no reason of its own, so the occurrence's is shown");
});

test("trigger rows: an unread dispatch log leaves the occurrence wording and claims nothing about dispatch", () => {
  const [row] = triggerRows([occ(10, "created", "scheduled", "t1")], null);
  assert.equal(row.label, "已创建待办任务"); assert.equal(row.dispatch, null);
  const [read] = triggerRows([occ(10, "created", "scheduled", "t1")], []);
  assert.match(read.label, /没有直派记录/);
});

test("dispatch reasons: known codes in words, unknown codes say so", () => {
  assert.match(dispatchReasonText("DAILY_BUDGET"), /预算/);
  assert.match(dispatchReasonText("APPEND_REJECTED"), /REJECTED/);
  assert.match(dispatchReasonText("SOMETHING_NEW"), /未收录/);
});
