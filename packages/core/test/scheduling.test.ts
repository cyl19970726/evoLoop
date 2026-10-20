import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { computeDue, ScheduleRuleError } from "../src/scheduling/index.js";
import type { ScheduleRevision } from "../../contracts/src/scheduling.js";

const revision = (rule: ScheduleRevision["rule"], timezone = "UTC", misfire: ScheduleRevision["misfire"] = { kind: "latest" }): ScheduleRevision => ({
  projectId: randomUUID(), scheduleId: randomUUID(), id: randomUUID(), version: 1, timezone, rule, misfire, overlap: "skip",
  template: { title: "Check", goal: "Check evidence", acceptance: "Record finding", owner: "role" },
  authorization: { scopeId: "scope", roleId: "role", authorizedBy: "human", expiresAtUtc: null },
  reason: "test", actorId: "human", createdAtUtc: "2026-01-01T00:00:00.000Z",
});

test("once and interval use exclusive watermark and bounded catch-up", () => {
  const once = revision({ kind: "once", atUtc: "2026-01-01T10:00:00.000Z" });
  assert.deepEqual(computeDue(once, "2026-01-01T09:00:00.000Z", "2026-01-01T10:00:00.000Z").plannedAtUtc, ["2026-01-01T10:00:00.000Z"]);
  assert.equal(computeDue(once, "2026-01-01T10:00:00.000Z", "2026-01-01T11:00:00.000Z").totalDue, 0);
  const interval = revision({ kind: "interval", anchorUtc: "2026-01-01T00:00:00.000Z", everyMinutes: 60 }, "UTC", { kind: "bounded", maxCatchUp: 2 });
  const due = computeDue(interval, "2026-01-01T00:00:00.000Z", "2026-01-01T05:00:00.000Z");
  assert.equal(due.totalDue, 5); assert.equal(due.skippedCount, 3);
  assert.deepEqual(due.plannedAtUtc, ["2026-01-01T04:00:00.000Z", "2026-01-01T05:00:00.000Z"]);
  const skip = revision(interval.rule, "UTC", { kind: "skip" });
  assert.equal(computeDue(skip, "2026-01-01T00:00:00.000Z", "2026-01-01T05:20:00.000Z").plannedAtUtc.length, 0);
});

test("daily local time skips spring gap and picks first fall duplicate", () => {
  const spring = revision({ kind: "daily", localTime: "02:30" }, "America/New_York", { kind: "bounded", maxCatchUp: 10 });
  const springDue = computeDue(spring, "2026-03-07T00:00:00.000Z", "2026-03-10T00:00:00.000Z");
  assert.deepEqual(springDue.plannedAtUtc, ["2026-03-07T07:30:00.000Z", "2026-03-09T06:30:00.000Z"]);
  const fall = revision({ kind: "daily", localTime: "01:30" }, "America/New_York", { kind: "bounded", maxCatchUp: 10 });
  const fallDue = computeDue(fall, "2026-11-01T00:00:00.000Z", "2026-11-02T00:00:00.000Z");
  assert.deepEqual(fallDue.plannedAtUtc, ["2026-11-01T05:30:00.000Z"]);
});

test("daily long outage and invalid zones require review", () => {
  const daily = revision({ kind: "daily", localTime: "09:00" }, "Asia/Taipei");
  assert.throws(() => computeDue(daily, "2025-01-01T00:00:00.000Z", "2026-10-20T00:00:00.000Z"), ScheduleRuleError);
  assert.throws(() => computeDue({ ...daily, timezone: "Bad/Zone" }, "2026-01-01T00:00:00.000Z", "2026-01-02T00:00:00.000Z"), ScheduleRuleError);
});
