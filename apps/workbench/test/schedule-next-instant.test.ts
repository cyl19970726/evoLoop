import assert from "node:assert/strict";
import test from "node:test";
import { nextRuleInstant } from "../src/features/scheduling/presentation.ts";

const now = Date.parse("2026-11-09T12:00:00.000Z");

test("a one-off rule previews its instant only while it is still ahead", () => {
  assert.equal(nextRuleInstant({ kind: "once", atUtc: "2026-11-10T01:00:00.000Z" }, "UTC", now), "2026-11-10T01:00:00.000Z");
  assert.equal(nextRuleInstant({ kind: "once", atUtc: "2026-11-09T11:59:00.000Z" }, "UTC", now), null);
});

test("an interval rule counts whole steps from its anchor", () => {
  assert.equal(nextRuleInstant({ kind: "interval", anchorUtc: "2026-11-09T11:00:00.000Z", everyMinutes: 45 }, "UTC", now), "2026-11-09T12:30:00.000Z");
  assert.equal(nextRuleInstant({ kind: "interval", anchorUtc: "2026-11-09T12:00:00.000Z", everyMinutes: 30 }, "UTC", now), "2026-11-09T12:30:00.000Z",
    "an instant equal to now is not ahead");
  assert.equal(nextRuleInstant({ kind: "interval", anchorUtc: "2026-11-11T00:00:00.000Z", everyMinutes: 30 }, "UTC", now), "2026-11-11T00:00:00.000Z");
});

test("a daily rule follows the definition's timezone, including daylight saving", () => {
  // 20:30 in Taipei (UTC+8) is 12:30 UTC, still ahead of 12:00 UTC.
  assert.equal(nextRuleInstant({ kind: "daily", localTime: "20:30" }, "Asia/Taipei", now), "2026-11-09T12:30:00.000Z");
  // 09:00 in Taipei has passed today, so tomorrow.
  assert.equal(nextRuleInstant({ kind: "daily", localTime: "09:00" }, "Asia/Taipei", now), "2026-11-10T01:00:00.000Z");
  // New York leaves daylight saving on 2026-11-01; 08:00 is 13:00 UTC afterwards.
  assert.equal(nextRuleInstant({ kind: "daily", localTime: "08:00" }, "America/New_York", now), "2026-11-09T13:00:00.000Z");
  // On 2026-03-08 New York moves to UTC-4, so 08:00 is 12:00 UTC.
  assert.equal(nextRuleInstant({ kind: "daily", localTime: "08:00" }, "America/New_York", Date.parse("2026-03-08T06:00:00.000Z")), "2026-03-08T12:00:00.000Z");
  assert.equal(nextRuleInstant({ kind: "daily", localTime: "08:00" }, "Not/AZone", now), null);
  assert.equal(nextRuleInstant({ kind: "daily", localTime: "24:30" }, "Asia/Taipei", now), null, "an out-of-range time has no instant");
});

test("a daily time skipped by a daylight-saving gap does not fire that day, as the scheduler decides", () => {
  // New York springs forward on 2027-03-14 at 02:00: 02:30 does not exist that day. The scheduler (packages/core
  // computeDue) creates nothing on the 14th, so the preview is the 15th at 02:30 EDT, never 01:30 or 03:30 on the 14th.
  const rule = { kind: "daily", localTime: "02:30" } as const;
  assert.equal(nextRuleInstant(rule, "America/New_York", Date.parse("2027-03-14T05:00:00.000Z")), "2027-03-15T06:30:00.000Z");
  assert.equal(nextRuleInstant(rule, "America/New_York", Date.parse("2027-03-13T08:00:00.000Z")), "2027-03-15T06:30:00.000Z",
    "after the 13th's run the next one is the 15th");
  assert.equal(nextRuleInstant(rule, "America/New_York", Date.parse("2027-03-13T07:00:00.000Z")), "2027-03-13T07:30:00.000Z");
});

test("a daily time that happens twice at fall-back is its earlier instant, as the scheduler decides", () => {
  // New York falls back on 2027-11-07 at 02:00: 01:30 happens at 05:30 UTC (EDT) and again at 06:30 UTC (EST).
  const rule = { kind: "daily", localTime: "01:30" } as const;
  assert.equal(nextRuleInstant(rule, "America/New_York", Date.parse("2027-11-07T04:00:00.000Z")), "2027-11-07T05:30:00.000Z");
  assert.equal(nextRuleInstant(rule, "America/New_York", Date.parse("2027-11-07T06:00:00.000Z")), "2027-11-08T06:30:00.000Z",
    "the second 01:30 is not another run");
});
