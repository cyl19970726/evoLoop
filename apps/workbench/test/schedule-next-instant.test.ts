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
