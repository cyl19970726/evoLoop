import assert from "node:assert/strict";
import test from "node:test";
import type { ObservedRole, ObservedSession } from "@evoloop/contracts/session-observation";
import type { LeaderWorkTask } from "@evoloop/contracts/work-index";
import type { ResidentQueue } from "@evoloop/contracts/queues";
import {
  buildArrangement, freeAgents, freeCapacity, dueSoonMs, type ArrangementEvidence,
} from "../src/features/sessions/arrangementModel.ts";

const stamp = "2026-11-09T00:00:00.000Z";
const now = Date.parse(stamp);
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const role = (templateKey: string | null = null): ObservedRole => ({
  id: templateKey ?? "role", title: templateKey === "lead" ? "统筹" : "实现", state: "active", roleClass: "business", templateKey, responsibility: "",
});
const agent = (n: number, busy: boolean | null, roles: ObservedRole[] = [role()]): ObservedSession => ({
  key: `owned:${id(n)}`, target: { kind: "owned", sessionId: id(n) }, aliases: [], title: `智能体${n}`, profile: null,
  kind: "owned", roles, membership: "current", membershipReason: "verified", runtimeState: "ready", busy,
  currentTask: null, latestBusinessRun: null, lastProgressAt: null,
  capabilities: { observe: { available: true, reason: null }, send: { available: true, reason: null, mode: "manual-handoff" },
    open: { available: false, reason: null, ref: null }, interrupt: { available: false, reason: null },
    close: { available: false, reason: null } },
  source: { kind: "session", id: id(n), revision: null, evidence: "project-record", href: "" },
  metadata: { generatedAt: stamp, sourceObservedAt: null, partial: false, limitations: [] },
});
const task = (n: number, fields: Partial<LeaderWorkTask> & { to?: number }): LeaderWorkTask => {
  const { to, ...rest } = fields;
  return {
    kind: "task", taskId: id(100 + n), version: 1, currentRevisionId: id(100 + n), workChangeSequence: 1, title: `任务${n}`,
    taskKind: "implementation", taskState: "in_progress", phase: "ready", nextAction: "",
    responsible: { kind: "role", id: "role", label: "实现" },
    assignment: to === undefined ? null : { state: "accepted", targetKind: "owned", targetId: id(to), recipientActorId: null },
    latestRun: null, delivery: null, pendingImpactCount: 0, queueHold: null, goal: null, stage: null, plan: null,
    dependencies: [], dependencyVersion: 0, review: null,
    dates: { createdAt: stamp, businessChangedAt: stamp, startedAt: null, completedAt: null, observedAt: stamp },
    timing: undefined as unknown as LeaderWorkTask["timing"], actionKey: `task:${n}`,
    ...rest,
  };
};
const complete: ArrangementEvidence = { tasksComplete: true, queuesRead: true, directoryComplete: true };
const queue = (entries: Array<{ session: number; task: number; position: number; state?: "queued" | "held" | "claimed" }>,
  adoptedVersion: number | null = 1): ResidentQueue => ({
  projectId: "p", id: "q", version: 1, adoptedVersion, maxRuns: 5, reason: "", actorId: "lead",
  entries: entries.map((entry, index) => ({
    projectId: "p", queueId: "q", id: `e${index}`, taskId: id(100 + entry.task), taskRevisionId: id(100 + entry.task),
    sourceInputJson: "{}", sessionId: id(entry.session), roleId: "role", position: entry.position, dependsOn: [],
    consumerId: "c", useRequired: false, releaseRule: "accepted" as never, state: entry.state ?? "queued",
    holdCode: entry.state === "held" ? "dependency" : null, holdReason: null, claimId: null, version: 1,
  })),
});

test("the board puts each open Task under its assigned agent and keeps unassigned ones apart", () => {
  const board = buildArrangement([agent(1, true), agent(2, false), agent(3, null)], [
    task(1, { to: 1, phase: "running" }),
    task(2, { to: 1, phase: "awaiting_acceptance", responsible: { kind: "consumer", id: "c", label: "消费者" } }),
    task(3, { phase: "unassigned" }),
    task(4, { to: 1, phase: "closed", taskState: "done" }),
    task(5, { to: 9, phase: "running" }),
    task(6, { assignment: { state: "released", targetKind: "owned", targetId: id(2), recipientActorId: null }, phase: "awaiting_assignment" }),
  ], [queue([{ session: 2, task: 7, position: 2 }, { session: 2, task: 3, position: 1, state: "held" }, { session: 1, task: 1, position: 1 },
    { session: 2, task: 8, position: 3, state: "claimed" }])], now, complete);
  const [first, ...others] = board.rows;
  assert.equal(first!.session.title, "智能体1");
  assert.deepEqual(first!.running.map(item => item.title), ["任务1"]);
  assert.deepEqual(first!.assigned.map(item => item.title), ["任务2"], "closed Tasks are not counted");
  assert.deepEqual(first!.queued, [], "a queued Task already listed under the agent is not repeated");
  const second = others.find(row => row.session.title === "智能体2")!;
  assert.deepEqual(second.queued.map(item => [item.title, item.held]), [["任务3", true], ["任务名称待核对", false]],
    "queue entries keep their order, unknown titles say so, claimed entries are not waiting");
  assert.deepEqual(board.unassigned.map(item => item.title), ["任务3", "任务6"], "a released assignment is unassigned again");
  assert.deepEqual(board.elsewhere.map(group => [group.label, group.tasks.map(item => item.title)]),
    [["受管智能体 · 不在当前目录", ["任务5"]]], "work held by an agent outside the directory stays visible");
  assert.equal(board.rows.find(row => row.session.title === "智能体3")!.load, "unknown", "unknown occupation is never idle");
});

test("risks are only what the records prove", () => {
  const board = buildArrangement([agent(1, true), agent(2, false)], [
    task(1, { to: 1, phase: "running" }),
    task(2, { to: 1, phase: "running" }),
    task(3, { to: 2, phase: "running", dependencies: [
      { taskId: id(201), title: "前置甲", state: "in_progress", currentRevisionId: id(201), acceptanceSatisfied: false },
      { taskId: id(202), title: "前置乙", state: "done", currentRevisionId: id(202), acceptanceSatisfied: true },
    ] }),
    task(4, { phase: "ready", dependencies: [
      { taskId: id(203), title: "前置丙", state: "todo", currentRevisionId: id(203), acceptanceSatisfied: false },
    ] }),
    task(5, { phase: "ready", plan: { plannedStartAt: null, dueAt: "2026-11-08T00:00:00.000Z", priority: 1 } }),
    task(6, { phase: "ready", plan: { plannedStartAt: null, dueAt: new Date(now + dueSoonMs - 1000).toISOString(), priority: 2 } }),
    task(7, { phase: "ready", plan: { plannedStartAt: null, dueAt: new Date(now + dueSoonMs + 1000).toISOString(), priority: 2 } }),
    task(8, { phase: "awaiting_acceptance", responsible: { kind: "unknown", id: null, label: "下一责任未登记" } }),
  ], [], now, complete);
  assert.deepEqual(board.risks.map(risk => [risk.kind, risk.title]), [
    ["parallel", "智能体1 同时有 2 项进行中的任务"],
    ["dependency", "「任务3」已开始，但依赖还没通过验收"],
    ["overdue", "「任务5」已过截止时间"],
    ["no_acceptor", "「任务8」待验收，但下一责任未登记"],
  ], "a ready Task waiting on its dependency is not a conflict");
  assert.equal(board.risks[1]!.detail, "依赖「前置甲」");
  assert.equal(board.rows[0]!.load, "overloaded");
  assert.deepEqual(board.dueSoon.map(item => item.title), ["任务6"], "only open Tasks due within three days");
});

test("free agents exclude the Leader and anyone with assigned or queued work", () => {
  const leader = agent(1, false, [role("lead")]);
  const board = buildArrangement([leader, agent(2, false), agent(3, false), agent(4, false)],
    [task(1, { to: 3, phase: "awaiting_delivery" })], [queue([{ session: 4, task: 2, position: 1 }])], now, complete);
  assert.equal(board.leader?.title, "智能体1");
  assert.deepEqual(freeAgents(board).map(row => row.session.title), ["智能体2"]);
});

test("a dependency counts by the server's acceptance gate, not by its state", () => {
  const board = buildArrangement([agent(1, true)], [
    task(1, { to: 1, phase: "running", dependencies: [
      { taskId: id(201), title: "已完成未验收", state: "done", currentRevisionId: id(201), acceptanceSatisfied: false },
    ] }),
    task(2, { to: 1, phase: "awaiting_delivery", dependencies: [
      { taskId: id(202), title: "队列已放行", state: "in_progress", currentRevisionId: id(202), acceptanceSatisfied: true },
    ] }),
  ], [], now, complete);
  assert.deepEqual(board.risks.map(risk => [risk.kind, risk.detail]), [["dependency", "依赖「已完成未验收」"]]);
});

test("nobody is free while Tasks or queues are unread or incomplete", () => {
  const sessions = [agent(1, false), agent(2, false), agent(3, true)];
  for (const evidence of [
    { ...complete, tasksComplete: false },
    { ...complete, queuesRead: false },
  ]) {
    const board = buildArrangement(sessions, [], [], now, evidence);
    assert.deepEqual(freeAgents(board), [], JSON.stringify(evidence));
    assert.deepEqual(board.rows.map(row => row.load), ["busy", "unknown", "unknown"], "in-flight work is still proven");
    assert.equal(freeCapacity(board).judged, false);
  }
  assert.deepEqual(freeCapacity(buildArrangement(sessions, [], [], now, complete)).free.map(row => row.session.title), ["智能体1", "智能体2"]);
});

test("a managed agent that is closing or whose lifecycle is unchecked is not free", () => {
  const closing = { ...agent(1, false), runtimeState: "closing" };
  const unchecked = { ...agent(2, false), runtimeState: "unknown" };
  const board = buildArrangement([closing, unchecked, agent(3, false)], [], [], now, complete);
  assert.deepEqual(board.rows.map(row => [row.session.title, row.load]),
    [["智能体1", "unknown"], ["智能体2", "unknown"], ["智能体3", "idle"]]);
  assert.deepEqual(freeAgents(board).map(row => row.session.title), ["智能体3"]);
  assert.deepEqual(freeCapacity(board), { judged: true, free: freeAgents(board), others: 3, unknown: 2 });
});

test("entries of a queue that is not adopted are not queued work", () => {
  const board = buildArrangement([agent(1, false)], [], [queue([{ session: 1, task: 1, position: 1 }], null)], now, complete);
  assert.deepEqual(board.rows[0]!.queued, []);
  assert.deepEqual(freeAgents(board).map(row => row.session.title), ["智能体1"]);
});

test("a queue claim places its Task under the claiming agent instead of 没有承接者", () => {
  const board = buildArrangement([agent(1, true)], [task(1, { phase: "running" }), task(2, { phase: "unassigned" })],
    [queue([{ session: 1, task: 1, position: 1, state: "claimed" }], null)], now, complete);
  assert.deepEqual(board.rows[0]!.running.map(item => item.title), ["任务1"]);
  assert.deepEqual(board.unassigned.map(item => item.title), ["任务2"]);
  assert.deepEqual([...board.claimed], [id(101)]);
});

test("work recorded against another attachment of the same agent stays on its row", () => {
  const merged = { ...agent(1, false), aliases: [{ kind: "owned" as const, sessionId: id(11) }] };
  const board = buildArrangement([merged], [task(1, { to: 11, phase: "awaiting_acceptance" })], [], now, complete);
  assert.deepEqual(board.rows[0]!.assigned.map(item => item.title), ["任务1"]);
  assert.deepEqual(board.elsewhere, []);
});

test("an assignee missing from a directory read up to its limit is 未读到, not outside the directory", () => {
  const tasks = [task(1, { to: 9, phase: "running" }), task(2, { phase: "ready",
    assignment: { state: "accepted", targetKind: "external", targetId: "link-1", recipientActorId: null } })];
  assert.deepEqual(buildArrangement([agent(1, false)], tasks, [], now, { ...complete, directoryComplete: false })
    .elsewhere.map(group => group.label), ["受管智能体 · 未读到", "外部接入 · 未读到"]);
  assert.deepEqual(buildArrangement([agent(1, false)], tasks, [], now, complete)
    .elsewhere.map(group => group.label), ["受管智能体 · 不在当前目录", "外部接入 · 不在当前目录"]);
});
