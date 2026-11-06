import assert from "node:assert/strict";
import test from "node:test";
import type { Transaction } from "@evoloop/contracts/ports";
import type { TaskTimingView } from "@evoloop/contracts/task-timing";
import { requireTaskTimingReady } from "../src/task-timing-guard.ts";

const first = "2026-11-07T00:00:00.000Z";
const second = "2026-11-08T00:00:00.000Z";
const timing = (executeAtUtc: string, previousTaskId: string | null): TaskTimingView => ({
  projectId: "project", taskId: "B", seriesId: "series", rootTaskId: "A", version: 1, seriesState: "active",
  executeAtUtc, timezone: "Asia/Taipei", repeat: "daily", previousTaskId,
  nextTaskId: null, nextAtUtc: null, waitingReason: null, occurrences: [],
  futureTemplate: { title: "Check architecture", content: "Review current architecture", acceptance: "Report" },
});

test("a scheduled Task waits for its calendar slot, predecessor and unknown Run", async () => {
  let current = timing(second, "A");
  let priorState: "in_progress" | "done" = "in_progress";
  let unknownRun = false;
  const tx = {
    taskTiming: { get: async () => current },
    getTask: async () => ({ id: "A", state: priorState }),
    listRuntimeRuns: async () => unknownRun ? [{ state: "unknown" }] : [],
  } as unknown as Transaction;
  await assert.rejects(requireTaskTimingReady(tx, "B", first), /scheduled for/);
  await assert.rejects(requireTaskTimingReady(tx, "B", second), /Previous Task A is in_progress/);
  priorState = "done";
  unknownRun = true;
  await assert.rejects(requireTaskTimingReady(tx, "B", second), /unsettled Run/);
  unknownRun = false;
  await requireTaskTimingReady(tx, "B", second);
  current = timing(first, null);
  await requireTaskTimingReady(tx, "A", second);
});
