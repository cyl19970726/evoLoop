import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import * as ReactModule from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { api, ApiError, type TaskTimingSeriesSummary } from "../src/shared/api.ts";
import { readReturn } from "../src/shared/returnLink.ts";
import { TimedTasksView, type TimedTasksReadView } from "../src/features/scheduling/TimedTasksSection.tsx";
import { copyBlockedByCoordinator, nextTimeText, timedTaskHref, timingFromPath, timingHref } from "../src/features/scheduling/timedTasks.ts";

Object.assign(globalThis, { React: ReactModule });
const projectId = "40000001-0000-4000-8000-000000000001", actorId = "reader";
const id = (n: number) => `40000002-0000-4000-8000-${String(n).padStart(12, "0")}`;
const NOW = Date.parse("2026-11-10T00:00:00.000Z");
const series = (n: number, over: Partial<TaskTimingSeriesSummary> = {}): TaskTimingSeriesSummary => ({
  projectId, seriesId: id(100 + n), rootTaskId: id(n), version: 1, seriesState: "active", title: `系列${n}`, timezone: "Asia/Shanghai",
  repeat: "none", executeAtUtc: "2026-11-12T01:00:00.000Z", nextAtUtc: null, skippedCount: 0, occurrenceCount: 1,
  latestTask: { taskId: id(n), title: `系列${n}`, state: "todo", plannedAtUtc: "2026-11-12T01:00:00.000Z" }, ...over });
const once = series(1);
const daily = series(2, { repeat: "daily", executeAtUtc: "2026-11-09T01:00:00.000Z", nextAtUtc: "2026-11-11T01:00:00.000Z", occurrenceCount: 2, skippedCount: 1,
  latestTask: { taskId: id(22), title: "系列2 今日份", state: "in_progress", plannedAtUtc: "2026-11-10T01:00:00.000Z" } });
const stopped = series(3, { repeat: "daily", seriesState: "stopped", nextAtUtc: null, occurrenceCount: 3,
  latestTask: { taskId: id(33), title: "系列3 末份", state: "done", plannedAtUtc: "2026-11-09T01:00:00.000Z" } });
const view = (over: Partial<TimedTasksReadView> = {}): TimedTasksReadView => ({ items: [once, daily, stopped], loaded: true, error: null,
  hasMore: false, fetching: false, fetchingMore: false, pageFailed: false, readAt: "2026-11-10T00:00:00.000Z", ...over });
const render = (v: TimedTasksReadView, coordinator: string | null = "idle", focus: string | null = null) => renderToStaticMarkup(createElement(TimedTasksView,
  { view: v, projectId, actorId, coordinator, focus, onRefresh() {}, onMore() {}, now: NOW }));

test("the list shows the three timed kinds with next time, state and latest Task, and says nothing of untimed Tasks", () => {
  const html = render(view());
  for (const text of ["系列1", "系列2", "系列3", "一次定时", "每日重复", "进行中", "已停止"]) assert.ok(html.includes(text), text);
  assert.match(html, /系列2 今日份 · 进行中/, "the latest Task and where it stands");
  assert.match(html, /系列3 末份 · 已完成/);
  assert.match(html, /已停止，不再复制后续时点/, "a stopped series stays and says why it has no next time");
  assert.match(html, /漏过 1 个时点/);
  assert.match(html, /定时任务 · 3/);
  assert.doesNotMatch(html, /没有设了执行时间/);
});

test("next time is said in the Task's zone, naming it, for one-time, daily, late and finished series", () => {
  assert.match(nextTimeText(once, NOW, "UTC"), /2026\/11\/12 09:00:00 · 上海（你的时间 2026\/11\/12 01:00:00）/);
  assert.match(nextTimeText(daily, NOW, "Asia/Shanghai"), /2026\/11\/11 09:00:00 · 上海$/);
  assert.match(nextTimeText(daily, Date.parse("2026-11-11T02:00:00.000Z"), "Asia/Shanghai"), /已过，待协调器补上/);
  assert.match(nextTimeText({ ...once, latestTask: { ...once.latestTask, state: "done" } }, NOW, "Asia/Shanghai"), /仅本次，无后续时点（约定 2026\/11\/12 09:00:00 · 上海）/);
  assert.equal(nextTimeText({ ...daily, nextAtUtc: null }, NOW), "下一时点尚未安排");
  assert.equal(nextTimeText(stopped, NOW), "已停止，不再复制后续时点");
});

test("an empty read says there is nothing timed; a failed read says it could not read, never “none”", () => {
  assert.match(render(view({ items: [] })), /本项目没有设了执行时间的任务/);
  const failed = render(view({ items: [], loaded: false, error: "403 无权" }));
  assert.match(failed, /本次没有读到：403 无权。这不表示没有定时任务/);
  assert.doesNotMatch(failed, /本项目没有设了执行时间/);
  assert.match(render(view({ error: "超时" })), /下面保留上次读回，待核对/);
  assert.match(render(view({ items: [], loaded: false })), /正在读取定时任务/);
});

test("a coordinator that does not run says active daily series will not copy by themselves", () => {
  assert.match(render(view(), "disabled"), /协调器当前未启用：进行中的每日重复不会自行复制/);
  assert.match(render(view(), "no-authority"), /没有可运行授权/);
  assert.doesNotMatch(render(view(), "idle"), /不会自行复制/);
  assert.doesNotMatch(render(view({ items: [once, stopped] }), "disabled"), /不会自行复制/, "nothing active and daily, nothing to warn about");
  assert.ok(copyBlockedByCoordinator("error") && !copyBlockedByCoordinator("running") && !copyBlockedByCoordinator(null));
});

test("each item opens its Task with the way back to the same place on 日程, and edits are not offered here", () => {
  const href = timedTaskHref(projectId, daily.latestTask.taskId, daily, actorId);
  const back = readReturn(href.slice(href.indexOf("?")).replace(/^/, `/p/${projectId}/tasks/${daily.latestTask.taskId}`), projectId, actorId);
  assert.ok(back);
  assert.equal(back.href, timingHref(projectId, daily.rootTaskId));
  assert.equal(back.label, "返回日程：系列2");
  assert.equal(timingFromPath(back.href, projectId), daily.rootTaskId);
  assert.equal(timingFromPath(`/p/other/schedules?timing=${daily.rootTaskId}`, projectId), null);
  const html = render(view());
  assert.ok(html.includes(`id="timing-${daily.rootTaskId}"`), "the item the link back names exists on the page");
  assert.match(html, /打开首个任务/, "a series whose latest Task is not the first also opens the first");
  assert.doesNotMatch(html, /<form|<input|<textarea/, "no edit form is copied onto 日程");
  assert.match(render(view(), "idle", daily.rootTaskId), /outline-offset-2/, "the focused item is marked");
});

test("the list read keeps its own project and shape: another project's rows or a malformed page is refused", async () => {
  const realFetch = globalThis.fetch;
  try {
    let url = "";
    const reply = (body: unknown) => { globalThis.fetch = (async (input: RequestInfo | URL) => { url = String(input); return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }); }) as typeof fetch; };
    reply({ items: [once, stopped], nextCursor: "abc" });
    const page = await api("t").taskTimings(projectId, "cur sor");
    assert.equal(page.items.length, 2);
    assert.match(url, /\/api\/projects\/40000001-[^/]+\/task-timings\?limit=50&cursor=cur%20sor$/);
    reply({ items: [{ ...once, projectId: "someone-else" }], nextCursor: null });
    await assert.rejects(api("t").taskTimings(projectId), (error: unknown) => error instanceof ApiError && /与当前项目不符/.test(error.message));
    reply({ nope: true });
    await assert.rejects(api("t").taskTimings(projectId), /与当前项目不符/);
  } finally { globalThis.fetch = realFetch; }
});
