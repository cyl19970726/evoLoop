import assert from "node:assert/strict";
import { test } from "node:test";
import { api, ApiError, type TaskTimingView } from "../src/api.ts";
import { commandSchema } from "@evoloop/contracts";
import { dailyScheduledInstant, formatScheduled, scheduledInstant, scheduledTimezone, timingSetPayload, timingStopPayload, timingVersion } from "../src/workflow/taskTimingPresentation.ts";

const timing: TaskTimingView = {
  projectId: "project-1", taskId: "task-1", seriesId: "series-1", rootTaskId: "task-1", version: 4,
  executeAtUtc: "2026-11-07T00:00:00.000Z", timezone: "Asia/Taipei", repeat: "daily",
  seriesState: "active", previousTaskId: null, nextTaskId: null,
  nextAtUtc: "2026-11-08T00:00:00.000Z", waitingReason: null, occurrences: [],
  futureTemplate: { title: "Check architecture", content: "Review current architecture", acceptance: "Report" },
};

test("a scheduled local time becomes a fixed UTC instant and displays in its declared zone", () => {
  assert.equal(scheduledInstant("2026-11-07T08:00:00+08:00"), timing.executeAtUtc);
  assert.match(formatScheduled(timing.executeAtUtc, timing.timezone), /2026.*11.*07.*08:00.*Asia\/Taipei/);
  assert.throws(() => scheduledInstant("2026-11-07T08:00"));
  assert.throws(() => scheduledInstant("2026-02-31T08:00:00+08:00"));
  assert.throws(() => scheduledTimezone("Invalid/Zone"));
  assert.throws(() => dailyScheduledInstant("2026-11-07T08:00:30+08:00"));
});

test("timing writes use the timing revision and never treat a missing revision as current", () => {
  assert.equal(timingVersion(null), 0);
  assert.equal(timingVersion(timing), 4);
  assert.throws(() => timingVersion({ ...timing, version: 0 }));
  const once = timingSetPayload("task-1", 2, null, { executeAtUtc: "2026-11-07T08:00:00+08:00",
    timezone: "Asia/Taipei", repeat: "none", scope: "this", reason: "first execution" });
  assert.equal(once.expectedTimingVersion, 0);
  assert.equal(once.executeAtUtc, timing.executeAtUtc);
  const future = timingSetPayload("task-1", 7, timing, { executeAtUtc: timing.executeAtUtc,
    timezone: timing.timezone, repeat: "daily", scope: "future", reason: "new prompt" });
  assert.equal(future.expectedTimingVersion, 4);
  assert.equal(future.expectedTaskVersion, 7);
  assert.equal(future.scope, "future");
  assert.equal(timingStopPayload("task-1", timing, "stop").expectedTimingVersion, 4);
});

test("timing and series prompt payloads match the shared command contract", () => {
  const projectId = crypto.randomUUID(), taskId = crypto.randomUUID(), operationId = crypto.randomUUID();
  const future = timingSetPayload(taskId, 7, timing, { executeAtUtc: timing.executeAtUtc,
    timezone: timing.timezone, repeat: "daily", scope: "future", reason: "new requirement" });
  assert.equal(commandSchema.parse({ ...future, projectId, operationId,
    title: "Review architecture", content: "Inspect current changes", acceptance: "Independent report" }).type, "task.timing.set");
  assert.equal(commandSchema.parse({ ...timingStopPayload(taskId, timing, "stop future copies"), projectId,
    operationId: crypto.randomUUID() }).type, "task.timing.stop");
  assert.throws(() => commandSchema.parse({ ...future, projectId, operationId, expectedTimingVersion: undefined }));
});

test("task timing read accepts absent timing and rejects another task's or incomplete timing", async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async input => {
      assert.equal(input, "/api/projects/project-1/tasks/task-1/timing");
      return Response.json(null);
    };
    assert.equal(await api("token").taskTiming("project-1", "task-1"), null);
    globalThis.fetch = async () => Response.json(timing);
    assert.equal((await api("token").taskTiming("project-1", "task-1"))?.version, 4);
    globalThis.fetch = async () => Response.json({ ...timing, taskId: "task-2" });
    await assert.rejects(api("token").taskTiming("project-1", "task-1"), cause => cause instanceof ApiError && cause.status === 0);
    globalThis.fetch = async () => Response.json({ ...timing, version: undefined });
    await assert.rejects(api("token").taskTiming("project-1", "task-1"), cause => cause instanceof ApiError && cause.status === 0);
  } finally { globalThis.fetch = original; }
});
