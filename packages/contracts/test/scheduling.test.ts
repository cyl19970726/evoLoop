// The daily wall-clock rule shared by the scheduler (packages/core computeDue) and the workbench preview: a local time
// skipped by a daylight-saving gap does not fire that day, a local time that happens twice is its earlier instant,
// and an unknown zone is refused.
import assert from "node:assert/strict";
import test from "node:test";
import { dailyRuleInstant, scheduleWallClock, scheduleZoneFormat } from "../src/scheduling.js";

const iso = (time: number | null) => time === null ? null : new Date(time).toISOString();
const day = (year: number, month: number, date: number) => ({ year, month, day: date });

test("an unknown zone is refused; a known one reads wall clocks", () => {
  assert.throws(() => scheduleZoneFormat("Mars/Base"), RangeError);
  const format = scheduleZoneFormat("Asia/Taipei");
  assert.deepEqual(scheduleWallClock(format, Date.parse("2026-11-10T01:05:00.000Z")), { year: 2026, month: 11, day: 10, hour: 9, minute: 5 });
  // Midnight is hour 0, never 24.
  assert.equal(scheduleWallClock(format, Date.parse("2026-11-09T16:00:00.000Z")).hour, 0);
});

test("a zone without daylight saving names one instant every day", () => {
  const format = scheduleZoneFormat("Asia/Taipei");
  assert.equal(iso(dailyRuleInstant(format, day(2026, 11, 10), 9, 0)), "2026-11-10T01:00:00.000Z");
  assert.equal(iso(dailyRuleInstant(format, day(2026, 12, 31), 23, 59)), "2026-12-31T15:59:00.000Z");
});

test("a local time skipped by a daylight-saving gap does not fire that day", () => {
  const ny = scheduleZoneFormat("America/New_York");
  // 2027-03-14: 02:00 EST becomes 03:00 EDT.
  assert.equal(dailyRuleInstant(ny, day(2027, 3, 14), 2, 30), null);
  assert.equal(dailyRuleInstant(ny, day(2027, 3, 14), 2, 0), null);
  assert.equal(iso(dailyRuleInstant(ny, day(2027, 3, 14), 1, 59)), "2027-03-14T06:59:00.000Z");
  assert.equal(iso(dailyRuleInstant(ny, day(2027, 3, 14), 3, 0)), "2027-03-14T07:00:00.000Z");
  assert.equal(iso(dailyRuleInstant(ny, day(2027, 3, 15), 2, 30)), "2027-03-15T06:30:00.000Z", "the next day fires as usual");
  // Lord Howe moves by half an hour: 02:00 becomes 02:30 on 2026-10-04.
  const lordHowe = scheduleZoneFormat("Australia/Lord_Howe");
  assert.equal(dailyRuleInstant(lordHowe, day(2026, 10, 4), 2, 15), null);
  assert.notEqual(dailyRuleInstant(lordHowe, day(2026, 10, 4), 2, 30), null);
});

test("a local time that happens twice is its earlier instant", () => {
  const ny = scheduleZoneFormat("America/New_York");
  // 2027-11-07: 02:00 EDT becomes 01:00 EST, so 01:30 happens at 05:30 and again at 06:30 UTC.
  assert.equal(iso(dailyRuleInstant(ny, day(2027, 11, 7), 1, 30)), "2027-11-07T05:30:00.000Z");
  assert.equal(iso(dailyRuleInstant(ny, day(2027, 11, 7), 2, 0)), "2027-11-07T07:00:00.000Z", "02:00 happens once, in EST");
  const london = scheduleZoneFormat("Europe/London");
  assert.equal(iso(dailyRuleInstant(london, day(2026, 10, 25), 1, 30)), "2026-10-25T00:30:00.000Z");
});

test("every local time of a year either names its own earliest instant or does not exist that day", () => {
  for (const zone of ["America/New_York", "Europe/London", "Australia/Lord_Howe"]) {
    const format = scheduleZoneFormat(zone);
    for (let date = Date.UTC(2027, 0, 1); date < Date.UTC(2028, 0, 1); date += 86_400_000) {
      const d = new Date(date);
      const local = day(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
      for (let minutes = 0; minutes < 1440; minutes += 30) {
        const hour = Math.floor(minutes / 60), minute = minutes % 60;
        const at = dailyRuleInstant(format, local, hour, minute);
        const same = (time: number) => {
          const wall = scheduleWallClock(format, time);
          return wall.year === local.year && wall.month === local.month && wall.day === local.day && wall.hour === hour && wall.minute === minute;
        };
        if (at === null) {
          // Nothing within the day's possible offsets shows this wall clock.
          const wall = Date.UTC(local.year, local.month - 1, local.day, hour, minute);
          for (let probe = wall - 15 * 3_600_000; probe <= wall + 15 * 3_600_000; probe += 15 * 60_000)
            assert.equal(same(probe), false, `${zone} ${JSON.stringify(local)} ${hour}:${minute} exists at ${iso(probe)}`);
        } else {
          assert.equal(same(at), true, `${zone} ${iso(at)} is not ${hour}:${minute}`);
          assert.equal(same(at - 30 * 60_000) || same(at - 3_600_000), false, `${zone} ${iso(at)} is not the earlier instant`);
        }
      }
    }
  }
});
