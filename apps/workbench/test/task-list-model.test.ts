import assert from "node:assert/strict";
import { test } from "node:test";
import type { Task } from "@evoloop/contracts";
import type { LeaderWorkTask } from "@evoloop/contracts/work-index";
import { isMine, matchesFilters, rowMeta, sortTasks, sortValue } from "../src/features/workflow/taskListModel.ts";
import { rowStatus } from "../src/shared/taskStatus.ts";
import { agentFacts } from "../src/features/workflow/taskAgentPresentation.ts";
import { taskTabHref } from "../src/shared/taskNavigation.ts";

const task = (id: string, overrides: Partial<Task> = {}): Task => ({ projectId: "p", id, version: 1, currentRevisionId: `${id}-r1`, title: `任务 ${id}`,
  content: "正文", contentDocumentId: "d", contentRevisionId: "dr", kind: "implementation", acceptance: "核对", owner: "role", state: "todo", ...overrides });
const projection = (item: Task, overrides: Partial<LeaderWorkTask> = {}): LeaderWorkTask => ({
  kind: "task", taskId: item.id, version: item.version, currentRevisionId: item.currentRevisionId, workChangeSequence: 1, title: item.title,
  taskKind: item.kind, taskState: item.state, phase: "ready", nextAction: "开始", responsible: { kind: "role", id: "role", label: "负责职责" },
  assignment: null, latestRun: null, delivery: null, pendingImpactCount: 0, queueHold: null, goal: null, stage: null, plan: null,
  dependencies: [], dependencyVersion: 0, review: null,
  dates: { createdAt: "2026-11-01T00:00:00Z", businessChangedAt: "2026-11-01T00:00:00Z", startedAt: null, completedAt: null, observedAt: "2026-11-09T00:00:00Z" },
  timing: null as never, actionKey: "k", ...overrides,
});

test("filters: open means todo or in progress; kind and search narrow further", () => {
  const view = { query: "", filter: "open", kind: "all" };
  assert.equal(matchesFilters(task("a", { state: "done" }), view), false);
  assert.equal(matchesFilters(task("a", { state: "in_progress" }), view), true);
  assert.equal(matchesFilters(task("a"), { ...view, kind: "research" }), false);
  assert.equal(matchesFilters(task("a", { title: "核对产品文档" }), { ...view, query: "产品" }), true);
  assert.equal(matchesFilters(task("a", { state: "cancelled" }), { ...view, filter: "cancelled" }), true);
});

test("我的承接 is only the current recipient of a live assignment on the same task version", () => {
  const item = task("a", { state: "in_progress" });
  const mine = projection(item, { taskState: "in_progress", assignment: { state: "accepted", targetKind: "owned", targetId: "s", recipientActorId: "me" } });
  assert.equal(isMine(item, mine, "me"), true);
  assert.equal(isMine(item, mine, "someone"), false);
  assert.equal(isMine({ ...item, version: 2 }, mine, "me"), false, "a projection of another version is not current");
  assert.equal(isMine(item, { ...mine, assignment: { ...mine.assignment!, state: "released" } }, "me"), false);
});

test("sorts order by projection facts; tasks without the fact keep list order at the end", () => {
  const [a, b, c, d] = ["a", "b", "c", "d"].map(id => task(id));
  const projections = {
    a: projection(a!, { plan: { priority: 3, dueAt: "2026-11-20T00:00:00Z", plannedStartAt: null } }),
    b: projection(b!, { plan: { priority: 1, dueAt: null, plannedStartAt: null }, latestProgress: { sequence: 1, entityKind: "task", entityId: "b", eventName: "开始", changedAt: "2026-11-02T00:00:00Z" } }),
    c: projection(c!, { plan: { priority: null, dueAt: "2026-11-10T00:00:00Z", plannedStartAt: null }, phase: "rework", latestProgress: { sequence: 2, entityKind: "delivery", entityId: "c", eventName: "交付", changedAt: "2026-11-05T00:00:00Z" } }),
  };
  const ids = (sort: Parameters<typeof sortTasks>[1]) => sortTasks([a!, b!, c!, d!], sort, projections).map(item => item.id);
  assert.deepEqual(ids("priority"), ["b", "a", "c", "d"]);
  assert.deepEqual(ids("due"), ["c", "a", "b", "d"]);
  assert.deepEqual(ids("progress"), ["c", "b", "a", "d"], "most recent progress first; no recorded progress last");
  assert.deepEqual(ids("phase"), ["c", "a", "b", "d"], "rework comes before ready");
  assert.deepEqual(ids("default"), ["a", "b", "c", "d"]);
});

test("default order keeps work in progress first, then to-do, then closed", () => {
  const items = [task("done", { state: "done" }), task("todo"), task("doing", { state: "in_progress" }), task("cancelled", { state: "cancelled" })];
  assert.deepEqual(sortTasks(items, "default", {}).map(item => item.id), ["doing", "todo", "done", "cancelled"]);
});

test("a stale projection gives no sort value and no status", () => {
  const item = task("a");
  const stale = projection({ ...item, version: 0 }, { plan: { priority: 1, dueAt: null, plannedStartAt: null } });
  assert.equal(sortValue(item, "priority", stale), null);
  assert.equal(rowMeta(item, "priority", stale), "待办 · 优先级未设");
});

test("row status: an open task shows its phase, a closed one its state, never an old phase", () => {
  assert.deepEqual(rowStatus("in_progress", "awaiting_acceptance"), { tone: "waiting", label: "待验收" });
  assert.deepEqual(rowStatus("done", "awaiting_acceptance"), { tone: "done", label: "已完成" });
  assert.deepEqual(rowStatus("todo", null), { tone: "idle", label: "待办" });
});

test("assigned, accepted and running stay three separate facts", () => {
  const current = { state: "in_progress" as const, currentRevisionId: "r2" };
  const base = { projectId: "p", taskId: "t", version: 1, taskRevisionId: "r2", target: { kind: "owned" as const, sessionId: "s" }, recipientActorId: null,
    ack: null, actorId: "lead", reason: "分派", updatedAt: "2026-11-09T00:00:00Z" };
  const values = (assignment: Parameters<typeof agentFacts>[1], run: Parameters<typeof agentFacts>[2] = null, known = true) =>
    agentFacts(current, assignment, run, known).map(fact => fact.value);
  assert.deepEqual(values(null), ["未分派", "未接受", "没有运行"]);
  assert.deepEqual(values({ ...base, state: "assigned" }), ["已分派", "待接受", "没有运行"]);
  assert.deepEqual(values({ ...base, state: "accepted", ack: { method: "direct", actorId: "me", observerActorId: "me", evidence: "e", sourceRef: null, at: "x" } },
    { runId: "r", state: "running" }), ["已分派", "已接受 · 本人确认", "正在运行"]);
  assert.deepEqual(values({ ...base, state: "accepted", taskRevisionId: "r1" }), ["分派属于旧修订", "接受属于旧修订", "没有运行"]);
  assert.deepEqual(values({ ...base, state: "assigned" }, null, false)[2], "运行状态未读回");
  assert.deepEqual(agentFacts({ state: "done", currentRevisionId: "r2" }, { ...base, state: "accepted" }, { runId: "r", state: "completed" }, true).map(fact => fact.value),
    ["历史分派", "当时已接受", "任务已关闭 · 最近一轮已结束"], "a closed task's assignment is history");
});

test("tab links keep the list view and the verified agent return, and drop the rest", () => {
  const path = "/p/p1/tasks/t1?state=all&sort=priority&tab=runtime&run=x&return=%2Fp%2Fp1%2Fsessions%3Fsession%3Downed%3A00000000-0000-4000-8000-000000000001&actor=me&returnTitle=A";
  const next = new URLSearchParams(taskTabHref(path, "p1", "t1", "delivery", "me").split("?")[1]);
  assert.equal(next.get("tab"), "delivery");
  assert.equal(next.get("state"), "all");
  assert.equal(next.get("sort"), "priority");
  assert.equal(next.get("actor"), "me");
  assert.equal(next.get("run"), null);
  assert.equal(taskTabHref("/p/p1/tasks/t1", "p1", "t1", "runtime"), "/p/p1/tasks/t1?tab=runtime", "a plain task keeps a plain tab address");
});
