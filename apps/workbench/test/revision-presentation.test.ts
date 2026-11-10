// Who made a task revision and why, in Chinese, with the service's wording and identifiers kept for 完整标识.
import assert from "node:assert/strict";
import { test } from "node:test";
import { revisionOrigin } from "../src/features/workflow/revisionPresentation";

const roleId = "efd99e72-0000-4000-8000-000000000001";
const scheduleId = "9afc02f7-0000-4000-8000-000000000002";
const seriesId = "11111111-0000-4000-8000-000000000003";
const at = "2026-11-10T02:28:00.000Z";
const time = (iso: string) => `本地(${iso.slice(11, 16)})`;
const uuid = /[0-9a-f]{8}-[0-9a-f]{4}/i;

test("a task a schedule generated is said with the schedule's name and local time; identifiers go to 完整标识", () => {
  const revision = { actorId: `schedule:${roleId}`, reason: `schedule ${scheduleId} at ${at}` };
  const named = revisionOrigin(revision, "每日巡检", time);
  assert.equal(named.line, "由日程「每日巡检」在 本地(02:28) 生成");
  assert.equal(named.scheduleId, scheduleId);
  assert.equal(named.author, "日程「每日巡检」");
  assert.doesNotMatch(`${named.line}${named.author}${named.reason}`, uuid);
  assert.doesNotMatch(`${named.line}${named.reason}`, /schedule|T02:28/);
  assert.deepEqual(named.identifiers.map(row => [row.label, row.value]), [["日程", scheduleId], ["计划时间（UTC）", at], ["授权职责", roleId],
    ["原始作者", `schedule:${roleId}`], ["原始理由", `schedule ${scheduleId} at ${at}`]]);
  const unnamed = revisionOrigin(revision, null, time);
  assert.equal(unnamed.line, "由日程生成", "while the name is reading or cannot be read");
  assert.equal(unnamed.author, "日程");
  assert.equal(revisionOrigin({ actorId: `schedule:${roleId}`, reason: "odd" }, "每日巡检", time).line, "由日程生成",
    "an unreadable reason still names no identifier");
});

test("the first revision, a daily repetition and a future update are said in Chinese", () => {
  const first = revisionOrigin({ actorId: "test-owner", reason: "Initial task" }, null, time);
  assert.equal(first.line, "test-owner · 新建任务");
  assert.deepEqual(first.identifiers, [{ label: "原始理由", value: "Initial task", text: true }]);
  const daily = revisionOrigin({ actorId: "lead", reason: `Task timing series ${seriesId} at ${at}` }, null, time);
  assert.equal(daily.line, "由每天重复在 本地(02:28) 生成");
  assert.equal(daily.identifiers[0]!.value, seriesId);
  assert.equal(revisionOrigin({ actorId: "lead", reason: "Task content updated for future occurrences" }, null, time).reason, "更新了以后各次的任务要求");
});

test("a reason a person wrote is shown as written, with nothing replaced", () => {
  const own = revisionOrigin({ actorId: "reader", reason: "按评审意见补充验收" }, null, time);
  assert.equal(own.line, "reader · 按评审意见补充验收");
  assert.deepEqual(own.identifiers, []);
  assert.equal(revisionOrigin({}, null, time).line, "作者未记录 · 理由未记录", "a record without author or reason says so");
});
