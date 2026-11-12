// 正在做 and 接下来 in the agent's right column (docs/frontend/pages/sessions.md 右栏): every state says something, a missing
// read never turns into 空闲 or 没有排队, and the order of what comes next is the order its sources fix.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionLineEntry } from "@evoloop/contracts/session-line";
import type { SessionQueueItem, SessionResult, SessionSnapshot } from "@evoloop/contracts/session-observation";
import { assignmentLabel, lineEntryCaption, nextWork, nowWork, type LineRead } from "../src/features/sessions/sessionWorkPresentation.ts";

type Assignment = SessionSnapshot["assignments"][number];
const source = { kind: "task", id: "t", revision: null, evidence: "project-record", href: "" } as never;
const task = (id: string, state = "in_progress", relation: "accepted" | "assigned" | "claimed" = "accepted") =>
  ({ id, title: `任务 ${id}`, state, revisionId: `r-${id}`, owner: "role", relation, source });
const assignment = (id: string, state = "in_progress", how: "accepted" | "assigned" | "released" = "accepted", stale = false): Assignment => ({
  assignment: { projectId: "p", taskId: id, version: 1, taskRevisionId: `r-${id}`, target: { kind: "owned", sessionId: "s" }, recipientActorId: "agent",
    state: how, ack: how === "accepted" ? { method: "direct", actorId: "agent", observerActorId: "agent", evidence: "接手", sourceRef: null, at: "2026-11-12T00:00:00Z" } : null,
    actorId: "leader", reason: "安排", updatedAt: "2026-11-12T00:00:00Z" } as never,
  task: task(id, state) as never, stale });
const entry = (taskId: string, position: number, state: SessionLineEntry["state"] = "queued", extra: Partial<SessionLineEntry> = {}) =>
  ({ id: `e-${taskId}`, taskId, position, state, step: null, suspendReason: null, ...extra }) as SessionLineEntry;
const queued = (taskId: string, position: number, state = "queued"): SessionQueueItem =>
  ({ queueId: "q", entryId: `q-${taskId}`, taskId, taskTitle: `队列 ${taskId}`, position, state, holdCode: null, holdReason: null, dependsOn: [], source }) as never;
const owned = { kind: "owned" as const, runtimeState: "ready", busy: false, latestBusinessRun: null };
const none = { titleOf: () => null, messageRunning: false, idleResult: null, questionCount: 0, relationLabel: null, timing: null, assignments: [] as Assignment[] };

test("正在做 names the current Task with its stage, how it was taken on and how long it has run", () => {
  const now = nowWork({ ...none, session: { ...owned, busy: true, latestBusinessRun: { id: "run", taskId: "a", state: "running", updatedAt: "", source } },
    work: task("a") as never, assignments: [assignment("a")], relationLabel: "这个智能体已接手",
    timing: { status: "ready", stage: "运行中", stageKey: "running", line: "已历时 1 小时 · 等待 智能体" } });
  assert.deepEqual([now.badge, now.tone, now.task?.id, now.summary], ["运行中", "progress", "a", null]);
  assert.deepEqual([now.lines, now.timing], [["已接手（本人确认）"], "已历时 1 小时 · 等待 智能体"], "the exact acceptance replaces the generic relation");
  // Before the stage is read, the Run's own state stands in; it never claims more than the record.
  const reading = nowWork({ ...none, session: { ...owned, busy: true, latestBusinessRun: { id: "run", taskId: "a", state: "requested", updatedAt: "", source } },
    work: task("a") as never, relationLabel: "这个智能体已接手", timing: { status: "loading" } });
  assert.deepEqual([reading.badge, reading.tone, reading.lines, reading.timing], ["待启动", "waiting", ["这个智能体已接手"], "正在读取阶段时间…"]);
  const failed = nowWork({ ...none, session: owned, work: task("a", "in_progress", "assigned") as never, relationLabel: "已分派，待确认接手",
    timing: { status: "failed", line: "阶段时间暂不可读：超时" }, questionCount: 2 });
  assert.deepEqual([failed.badge, failed.lines, failed.timing, failed.questions], ["待确认接手", ["已分派，待确认接手"], "阶段时间暂不可读：超时", "有 2 个问题等你回答"]);
});

test("without a Task 正在做 still says something: a reserved Run, a message, 空闲, external or unknown", () => {
  const run = nowWork({ ...none, titleOf: id => id === "b" ? "预留的任务" : null, work: null,
    session: { ...owned, busy: true, latestBusinessRun: { id: "run", taskId: "b", state: "requested", updatedAt: "", source } } });
  assert.deepEqual([run.badge, run.task], ["待启动", { id: "b", title: "预留的任务" }], "a Run that has not ended names its Task");
  assert.match(run.lines[0]!, /没有找到这个智能体的分派或领取/);
  assert.equal(nowWork({ ...none, work: null, messageRunning: true, session: { ...owned, busy: true } }).badge, "回复消息");
  assert.equal(nowWork({ ...none, work: null, messageRunning: true, session: { ...owned, busy: true, latestBusinessRun: { id: "run", taskId: "b", state: "running", updatedAt: "", source } } }).badge,
    "回复消息", "a native message turn is exact; an older Run record still marked running does not override it");
  assert.equal(nowWork({ ...none, work: null, session: { ...owned, busy: true } }).badge, "在途工作");
  const recent = { taskId: "c", taskTitle: "上一项", submittedAt: "2026-11-11T00:00:00Z" } as SessionResult;
  const idle = nowWork({ ...none, work: null, idleResult: recent, session: owned });
  assert.deepEqual([idle.badge, idle.tone, idle.summary, idle.recent], ["空闲", "idle", "没有正在做的任务或消息。", recent]);
  assert.equal(nowWork({ ...none, work: null, session: { ...owned, busy: null } }).badge, "待核对", "unknown occupation is not 空闲");
  assert.equal(nowWork({ ...none, work: null, session: { kind: "external", runtimeState: null, busy: null, latestBusinessRun: null } }).badge, "外部接入");
  const closed = nowWork({ ...none, work: null, session: { ...owned, runtimeState: "closed" } });
  assert.deepEqual([closed.badge, closed.tone], ["已关闭", "history"]);
  // A finished Run is history, not current work.
  assert.equal(nowWork({ ...none, work: null, session: { ...owned, latestBusinessRun: { id: "run", taskId: "b", state: "completed", updatedAt: "", source } } }).badge, "空闲");
});

test("接下来 lists the Session line in order, then the execution queue, then assignments nothing has ordered", () => {
  const line: LineRead = { status: "ready", entries: [entry("l1", 4), entry("l2", 9, "suspended", { suspendReason: "等依赖验收" }), entry("cur", 12)] };
  const view = nextWork({ kind: "owned", currentTaskId: "cur", line, queue: [queued("cur", 0, "claimed"), queued("q1", 1, "held")],
    assignments: [assignment("cur"), assignment("a1", "todo", "assigned"), assignment("l1", "todo"), assignment("a2", "in_progress", "accepted", true)],
    partial: false, titleOf: id => `标题 ${id}` });
  assert.deepEqual(view.items.map(item => [item.taskId, item.order, item.caption, item.flag?.label ?? null]), [
    ["l1", 1, "队伍第 1 位 · 排队中", null],
    ["l2", 2, "队伍第 2 位", "已暂停"],
    ["q1", 2, "执行队列第 2 位", "已暂停"],
    ["a1", null, "已分派，未排进队伍 · 任务待开始", "待确认接手"],
    ["a2", null, "已分派，未排进队伍 · 任务进行中", "需重新确认"],
  ], "line places count live entries, the current Task is never also next, and a Task appears once");
  assert.equal(view.items[1]!.flag?.detail, "等依赖验收");
  assert.equal(view.items[0]!.title, "标题 l1", "a line entry takes its title from what was read");
  assert.equal(view.items[2]!.title, "队列 q1");
  assert.deepEqual([view.empty, view.note], [null, null]);
});

test("an assignment already delivered or finished is kept apart, and a phase says whose move it is", () => {
  const phases: Record<string, "awaiting_acceptance" | "rework" | "ready"> = { done1: "awaiting_acceptance", re: "rework", go: "ready" };
  const view = nextWork({ kind: "owned", currentTaskId: null, line: { status: "ready", entries: [] }, queue: [],
    assignments: [assignment("done1"), assignment("re"), assignment("go", "todo"), assignment("old", "done"), assignment("gone", "cancelled", "released")],
    partial: false, titleOf: () => null, phaseOf: id => phases[id] ?? null });
  assert.deepEqual(view.items.map(item => [item.taskId, item.flag?.label]), [["re", "待返工"], ["go", "可开始"]]);
  assert.deepEqual(view.ended.map(item => [item.item.task.id, item.label]),
    [["done1", "已交付，等验收"], ["old", "任务已完成 · 历史分派（曾直接确认接手）"], ["gone", "任务已取消 · 历史分派（已释放）"]]);
});

test("接下来 never says 没有 while the line is unread, and says why when it is empty", () => {
  const base = { kind: "owned" as const, currentTaskId: null, queue: [], assignments: [], partial: false, titleOf: () => null };
  assert.equal(nextWork({ ...base, line: { status: "ready", entries: [] } }).empty, "没有排队的任务。");
  assert.match(nextWork({ ...base, line: { status: "ready", entries: [] }, partial: true }).empty!, /已读范围内没有排队的任务/);
  const loading = nextWork({ ...base, line: { status: "loading" } });
  assert.match(loading.empty!, /读完前不能说没有排队的任务/); assert.match(loading.note!, /正在读取/);
  const failed = nextWork({ ...base, line: { status: "failed", message: "连接中断" } });
  assert.equal(failed.empty, "接下来做哪项暂时无法判断。"); assert.match(failed.note!, /智能体队伍暂不可读取：连接中断/);
  // What was read still shows beside a failed line read.
  const partly = nextWork({ ...base, line: { status: "failed", message: "超时" }, assignments: [assignment("a1", "todo")] });
  assert.deepEqual([partly.items.length, partly.empty], [1, null]); assert.match(partly.note!, /不能完全确认/);
  assert.equal(nextWork({ ...base, line: { status: "none", reason: "服务还不提供智能体队伍" } }).empty, "没有排队的任务。");
  assert.match(nextWork({ ...base, kind: "external", line: { status: "none", reason: "外部" } }).empty!, /外部接入的智能体没有队伍/);
});

test("a line entry in words, and the assignment labels the rows reuse", () => {
  assert.deepEqual(lineEntryCaption({ state: "starting", step: "confirm", suspendReason: null }, 1),
    { caption: "队伍第 1 位", flag: { tone: "progress", label: "正在开始", detail: "等它确认执行" } });
  assert.deepEqual(lineEntryCaption({ state: "suspended", step: null, suspendReason: null }, 3).flag, { tone: "waiting", label: "已暂停", detail: "原因未记录" });
  assert.equal(assignmentLabel(assignment("x", "in_progress", "accepted", true)), "任务修订已变化，需重新确认");
  assert.equal(assignmentLabel(assignment("x")), "已接手（本人确认）");
  assert.equal(assignmentLabel(assignment("x", "todo", "assigned")), "待确认");
});
