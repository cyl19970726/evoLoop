import assert from "node:assert/strict";
import { test } from "node:test";
import type { Task } from "@evoloop/contracts";
import type { LeaderWorkTask } from "@evoloop/contracts/work-index";
import { isMine, matchesFilters, rowMeta, sortTasks, sortValue } from "../src/features/workflow/taskListModel.ts";
import { rowStatus } from "../src/shared/taskStatus.ts";
import { agentFacts, phaseFact } from "../src/features/workflow/taskFactsPresentation.ts";
import { submissionRefusal } from "../src/features/workflow/useCommand.ts";
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
  assert.equal(rowMeta(item, "priority", stale), "待办 · 优先级未读回", "a stale projection is not read, so nothing is concluded");
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
  const ready = <T,>(value: T) => ({ state: "ready" as const, value });
  const values = (assignment: Parameters<typeof agentFacts>[1]["value"], run: Parameters<typeof agentFacts>[2]["value"] = null) =>
    agentFacts(current, ready(assignment), ready(run)).map(fact => fact.value);
  assert.deepEqual(values(null), ["未分派", "未接受", "没有运行"]);
  assert.deepEqual(values({ ...base, state: "assigned" }), ["已分派", "待接受", "没有运行"]);
  assert.deepEqual(values({ ...base, state: "accepted", ack: { method: "direct", actorId: "me", observerActorId: "me", evidence: "e", sourceRef: null, at: "x" } },
    { runId: "r", state: "running" }), ["已分派", "已接受 · 本人确认", "正在运行"]);
  assert.deepEqual(values({ ...base, state: "accepted", taskRevisionId: "r1" }), ["分派属于旧修订", "接受属于旧修订", "没有运行"]);
  assert.deepEqual(agentFacts({ state: "done", currentRevisionId: "r2" }, ready({ ...base, state: "accepted" }), ready({ runId: "r", state: "completed" })).map(fact => fact.value),
    ["历史分派", "当时已接受", "任务已关闭 · 最近一轮已结束"], "a closed task's assignment is history");
});

test("while a read runs or after it fails, the agent facts never conclude 未分派 or 没有运行", () => {
  const current = { state: "in_progress" as const, currentRevisionId: "r2" };
  const facts = (assignment: "loading" | "failed" | "ready", run: "loading" | "checking" | "failed" | "ready") =>
    agentFacts(current, { state: assignment, value: null }, { state: run, value: null }).map(fact => fact.value);
  assert.deepEqual(facts("loading", "loading"), ["正在读取", "正在读取", "正在读取"]);
  assert.deepEqual(facts("failed", "failed"), ["无法判断", "无法判断", "无法判断"]);
  assert.deepEqual(facts("ready", "checking"), ["未分派", "未接受", "正在核对"]);
  assert.deepEqual(facts("failed", "ready"), ["无法判断", "无法判断", "没有运行"]);
  for (const state of ["loading", "failed"] as const)
    assert.equal(facts(state, "ready").some(value => value === "未分派" || value === "未接受"), false, state);
});

test("the phase fact only says 未登记 after an answered read; failures say 无法判断", () => {
  assert.deepEqual(pick(phaseFact({ state: "loading", value: null })), ["正在读取", "正在读取当前工作安排…"]);
  assert.deepEqual(pick(phaseFact({ state: "checking", value: null })), ["正在核对", "当前工作安排正在重新核对…"]);
  assert.equal(phaseFact({ state: "failed", value: null }).label, "无法判断");
  assert.equal(phaseFact({ state: "ready", value: null }).label, "未登记");
  const item = task("a", { state: "in_progress" });
  const read = phaseFact({ state: "ready", value: projection(item, { phase: "awaiting_acceptance", nextAction: "先按原 Run 与 operation 对账" }) });
  assert.deepEqual(pick(read), ["待验收", "等验收者核对交付与实际使用"], "the next step is the workbench's own words, not the server's");
});
const pick = (fact: { label: string; next: string }) => [fact.label, fact.next];

test("a form refuses to submit once what it was opened with has changed, or the service says the version moved", () => {
  const base = { busy: false, blocked: false, stale: false };
  assert.equal(submissionRefusal({ ...base, recorded: "3:1:owned:a", current: "3:1:owned:a" }), null);
  assert.equal(submissionRefusal({ ...base, recorded: "3:1:owned:a", current: "3:2:owned:b" }), "baseline", "someone else changed the assignment");
  assert.equal(submissionRefusal({ ...base, recorded: "3:1:", current: "4:1:" }), "baseline", "the task moved to a new version");
  assert.equal(submissionRefusal({ ...base, stale: true, recorded: "3:1:", current: "3:1:" }), "baseline", "a version conflict answer");
  assert.equal(submissionRefusal({ ...base, busy: true }), "busy");
  assert.equal(submissionRefusal({ ...base, blocked: true }), "blocked");
  assert.equal(submissionRefusal(base), null, "a form without a baseline only checks busy and blocked");
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
