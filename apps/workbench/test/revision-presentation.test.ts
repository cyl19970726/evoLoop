// Who made a revision and why, in Chinese, with the service's wording and identifiers kept for 完整标识.
import assert from "node:assert/strict";
import { test } from "node:test";
import { plannedTime, revisionOrigin } from "../src/shared/revisionPresentation";

const roleId = "efd99e72-0000-4000-8000-000000000001";
const scheduleId = "9afc02f7-0000-4000-8000-000000000002";
const seriesId = "11111111-0000-4000-8000-000000000003";
const dispatchId = "22222222-0000-4000-8000-000000000004";
const at = "2026-11-10T02:28:00.000Z";
const uuid = /[0-9a-f]{8}-[0-9a-f]{4}/i;
const reader = "Asia/Shanghai";

test("a planned time is written in the schedule's own zone, and in the reader's zone (saying so) while that is unknown", () => {
  assert.equal(plannedTime(at, "Asia/Shanghai", reader), "2026/11/10 10:28:00 · 上海");
  assert.equal(plannedTime(at, "Asia/Tokyo", reader), "2026/11/10 11:28:00 · 东京（你的时间 2026/11/10 10:28:00）");
  assert.equal(plannedTime(at, null, reader), "2026/11/10 10:28:00（按你的时区 上海）");
  // A zone the browser does not recognise: the reader's clock, in the schedule page's words (scheduleTime).
  assert.equal(plannedTime(at, "Not/AZone", reader), "2026/11/10 10:28:00（你的时间；日程时区无法识别）");
  assert.equal(plannedTime(at, "Not/AZone", reader, "每天重复"), "2026/11/10 10:28:00（你的时间；每天重复时区无法识别）");
});

test("a schedule's task is said as the run it was planned for, not as when it was made; identifiers go to 完整标识", () => {
  const revision = { actorId: `schedule:${roleId}`, reason: `schedule ${scheduleId} at ${at}` };
  const named = revisionOrigin(revision, { schedule: { title: "每日巡检", timezone: "Asia/Tokyo" }, reader });
  assert.equal(named.line, "按日程「每日巡检」生成，计划时间 2026/11/10 11:28:00 · 东京（你的时间 2026/11/10 10:28:00）");
  assert.equal(named.scheduleId, scheduleId);
  assert.equal(named.author, "日程「每日巡检」");
  assert.match(named.reason, /^按日程「每日巡检」自动生成，计划时间 /);
  assert.doesNotMatch(`${named.line}${named.author}${named.reason}`, uuid);
  assert.doesNotMatch(`${named.line}${named.reason}`, /schedule|T02:28|在 .* 生成/, "the planned time is not said as when the revision was made");
  assert.deepEqual(named.identifiers.map(row => [row.label, row.value]), [["日程", scheduleId], ["计划时间（UTC）", at], ["授权职责", roleId],
    ["原始作者", `schedule:${roleId}`], ["原始理由", `schedule ${scheduleId} at ${at}`]]);
  const unread = revisionOrigin(revision, { reader });
  assert.equal(unread.line, "按日程生成，计划时间 2026/11/10 10:28:00（按你的时区 上海）", "while the schedule is reading or cannot be read");
  assert.equal(unread.author, "日程");
  assert.equal(revisionOrigin({ actorId: `schedule:${roleId}`, reason: "odd" }, { reader }).line, "由日程生成", "an unreadable reason still names no identifier");
});

test("the first revision, a daily repetition, dispatches and other service reasons are said in Chinese", () => {
  const first = revisionOrigin({ actorId: "test-owner", reason: "Initial task" });
  assert.equal(first.line, "test-owner · 新建任务");
  assert.deepEqual(first.identifiers, [{ label: "原始理由", value: "Initial task", text: true }]);
  const daily = revisionOrigin({ actorId: "lead", reason: `Task timing series ${seriesId} at ${at}` }, { seriesZone: "Asia/Shanghai", reader });
  assert.equal(daily.line, "按每天重复生成，计划时间 2026/11/10 10:28:00 · 上海");
  assert.equal(daily.series, true);
  assert.equal(daily.identifiers[0]!.value, seriesId);
  assert.match(revisionOrigin({ actorId: "lead", reason: `Task timing series ${seriesId} at ${at}` }, { reader }).line, /计划时间 2026\/11\/10 10:28:00（按你的时区 上海）$/);
  assert.equal(revisionOrigin({ actorId: "lead", reason: "Task content updated for future occurrences" }).reason, "更新了以后各次的任务要求");
  const reserved = revisionOrigin({ actorId: "lead", reason: "Runtime dispatch reserved" });
  assert.equal(reserved.line, "lead · 派发执行时开始任务并固定依据");
  const managed = revisionOrigin({ actorId: "loop", reason: `Managed dispatch ${dispatchId}` });
  assert.equal(managed.reason, "自动循环派发并开始任务");
  assert.doesNotMatch(managed.line, uuid);
  assert.deepEqual(managed.identifiers.map(row => [row.label, row.value]), [["派发记录", dispatchId], ["原始理由", `Managed dispatch ${dispatchId}`]]);
  for (const [raw, said] of [["Initial task content", "新建任务时的正文"], ["Initial draft", "初稿"], ["Task collaboration opened", "开启任务协作"]])
    assert.equal(revisionOrigin({ actorId: "a", reason: raw }).reason, said);
});

test("a document revision a schedule wrote names the schedule, not schedule:<id>", () => {
  const document = revisionOrigin({ actorId: `schedule:${roleId}`, reason: `schedule ${scheduleId} at ${at}` }, { schedule: { title: "每日巡检", timezone: "Asia/Shanghai" }, reader });
  assert.equal(document.author, "日程「每日巡检」");
  assert.doesNotMatch(document.author, /schedule:/);
});

test("a reason a person wrote is shown as written, with nothing replaced", () => {
  const own = revisionOrigin({ actorId: "reader", reason: "按评审意见补充验收" });
  assert.equal(own.line, "reader · 按评审意见补充验收");
  assert.deepEqual(own.identifiers, []);
  assert.equal(revisionOrigin({ actorId: "reader", reason: "Fix the typo in step 2" }).reason, "Fix the typo in step 2", "an unknown reason a person wrote stays as written");
  assert.equal(revisionOrigin({}).line, "作者未记录 · 理由未记录", "a record without author or reason says so");
});
