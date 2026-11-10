// A date and time typed on the clock of a time zone becomes the instant the coordinator would use for that clock
// reading: the same rule as packages/core computeDue (via @evoloop/contracts/scheduling), around daylight saving too.
import assert from "node:assert/strict";
import { test } from "node:test";
import { computeDue } from "@evoloop/core/scheduling";
import { scheduleWallClock, scheduleZoneFormat, type ScheduleRevision } from "@evoloop/contracts/scheduling";
import { localInputIn, localInstant, localInstantPreview, timezoneOptions } from "../src/shared/zonedTime.ts";
import { zonedInstant } from "../src/features/workflow/taskCreate.ts";

/** The instant the scheduler fires a daily rule at `time` on `date` in `zone`, or null when it does not fire that day. */
function coreDaily(zone: string, date: string, time: string): string | null {
  const revision = { projectId: "p", scheduleId: "s", id: "r", version: 1, timezone: zone, rule: { kind: "daily", localTime: time },
    misfire: { kind: "bounded", maxCatchUp: 100 }, overlap: "skip",
    template: { title: "t", content: "c", acceptance: "a", owner: "o" }, authorization: { scopeId: "s", roleId: "o", authorizedBy: "a", expiresAtUtc: null },
    reason: "r", actorId: "a", createdAtUtc: "2026-01-01T00:00:00.000Z" } as ScheduleRevision;
  const midnight = Date.parse(`${date}T00:00:00.000Z`);
  const due = computeDue(revision, new Date(midnight - 2 * 86_400_000).toISOString(), new Date(midnight + 2 * 86_400_000).toISOString()).plannedAtUtc;
  const format = scheduleZoneFormat(zone);
  const [year, month, day] = date.split("-").map(Number);
  return due.find(at => { const p = scheduleWallClock(format, Date.parse(at)); return p.year === year && p.month === month && p.day === day; }) ?? null;
}

const cases: Array<[zone: string, local: string, expected: string | null, later?: string]> = [
  ["Asia/Taipei", "2026-11-12T09:30", "2026-11-12T01:30:00.000Z"],
  ["America/New_York", "2026-11-12T09:30", "2026-11-12T14:30:00.000Z"],
  ["America/New_York", "2026-07-01T09:15", "2026-07-01T13:15:00.000Z"],
  // Spring forward: 02:00–03:00 does not exist.
  ["America/New_York", "2027-03-14T02:30", null],
  ["Europe/Berlin", "2026-03-29T02:30", null],
  // Fall back: 01:00–02:00 happens twice in New York, 02:00–03:00 in Berlin; the earlier one is used.
  ["America/New_York", "2027-11-07T01:30", "2027-11-07T05:30:00.000Z", "2027-11-07T06:30:00.000Z"],
  ["Europe/Berlin", "2026-10-25T02:30", "2026-10-25T00:30:00.000Z", "2026-10-25T01:30:00.000Z"],
  // Lord Howe moves by half an hour.
  ["Australia/Lord_Howe", "2026-10-04T02:15", null],
  ["Australia/Lord_Howe", "2026-04-05T01:45", "2026-04-04T14:45:00.000Z", "2026-04-04T15:15:00.000Z"],
];

test("a local time becomes the instant the coordinator fires the same clock reading, gaps and repeats included", () => {
  for (const [zone, local, expected, later] of cases) {
    const core = coreDaily(zone, local.slice(0, 10), local.slice(11, 16));
    assert.equal(core, expected, `the scheduler's own reading of ${local} in ${zone}`);
    if (expected === null) {
      assert.throws(() => localInstant(local, zone), /夏令时/, `${local} does not exist in ${zone}`);
      assert.throws(() => zonedInstant(local, zone), /夏令时/);
      assert.match(localInstantPreview(local, zone) ?? "", /没有这个时刻/);
    } else {
      assert.deepEqual(localInstant(local, zone), { iso: expected, later: later ?? null }, `${local} in ${zone}`);
      assert.equal(zonedInstant(local, zone), expected, "新建任务 reads the clock the same way");
      if (later) assert.match(localInstantPreview(local, zone) ?? "", /出现两次，按较早的一次/);
    }
  }
});

test("an instant shows on the clock of the record's zone, and reads back to itself", () => {
  assert.equal(localInputIn("2026-11-11T01:00:00.000Z", "Asia/Shanghai"), "2026-11-11T09:00");
  assert.equal(localInputIn("2026-11-12T14:30:00.000Z", "America/New_York"), "2026-11-12T09:30");
  assert.equal(localInputIn("2026-11-12T14:30:05.000Z", "America/New_York"), "2026-11-12T09:30:05", "seconds are kept, never dropped");
  assert.equal(localInputIn("2026-11-12T14:30:00.000Z", "Not/AZone"), "");
  assert.equal(localInputIn("", "UTC"), "");
  for (const iso of ["2026-11-11T01:00:00.000Z", "2027-11-07T05:30:00.000Z", "2026-10-25T00:30:00.000Z", "2026-11-12T14:30:05.000Z"])
    for (const zone of ["Asia/Shanghai", "America/New_York", "Europe/Berlin", "UTC"])
      assert.equal(localInstant(localInputIn(iso, zone), zone).iso, iso, `${iso} in ${zone}`);
});

test("a typed value that cannot be read says why", () => {
  assert.throws(() => localInstant("", "UTC"), /请选择日期和时间/);
  assert.throws(() => localInstant("2026-02-31T09:00", "UTC"), /无效/);
  assert.throws(() => localInstant("2026-11-12T09:00Z", "UTC"), /请选择日期和时间/, "UTC or an offset is not asked for");
  assert.throws(() => localInstant("2026-11-12T09:00", "Mars/Base"), /时区无法识别/);
  assert.equal(localInstantPreview("", "UTC"), null);
  assert.match(localInstantPreview("2026-11-12T09:30", "America/New_York", "Asia/Taipei") ?? "",
    /^按纽约时间 2026\/11\/12 09:30，即你的时间 2026\/11\/12 22:30；记录为 2026-11-12 14:30 UTC。$/);
  assert.match(localInstantPreview("2026-11-12T09:30", "Asia/Taipei", "Asia/Taipei") ?? "", /^按台北时间 2026\/11\/12 09:30；记录为 2026-11-12 01:30 UTC。$/);
});

test("the zone choices put the zone in use first and say which cannot be read", () => {
  const options = timezoneOptions(["Not/AZone", "Asia/Taipei"]);
  assert.deepEqual(options[0], { value: "Not/AZone", label: "Not/AZone（无法识别）" });
  assert.deepEqual(options[1], { value: "Asia/Taipei", label: "台北（Asia/Taipei）" });
  assert.equal(new Set(options.map(option => option.value)).size, options.length, "each zone once");
  assert.ok(options.some(option => option.value === "Europe/Berlin"));
});
