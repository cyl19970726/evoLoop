// Business nodes on the conversation timeline (Task 13518ac6): their words, marks, landing places, their place among the rounds, and the delivery sentence of a round.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { BusinessNode, SessionActivity } from "@evoloop/contracts/session-observation";
import type { WorkspaceEntry, WorkspaceTurn } from "@evoloop/contracts/session-timeline";
import { nodeHref, nodeMark, nodeText, rowsWithNodes, type NodeActivity } from "../src/features/sessions/businessNodes";
import { turnSummaries } from "../src/features/sessions/conversationPresentation";
import type { TimelineRow } from "../src/features/sessions/timelineRounds";

const at = (minute: number) => new Date(Date.UTC(2026, 10, 10, 8, minute)).toISOString();
const activity = (id: string, minute: number, node: BusinessNode): NodeActivity => ({ id, sequence: "0", sessionKey: "k", kind: `business_${node.kind}`, summary: "", occurredAt: at(minute), recordedAt: at(minute),
  actorId: null, taskId: node.taskId, importance: "important", source: {} as SessionActivity["source"], node });
const base = { taskId: "task-1", title: "做表格视图" };

test("each node says what happened in the Task's words and lands on the right tab", () => {
  const taskHref = (id: string) => `/p/p/tasks/${id}`;
  const accepted: BusinessNode = { ...base, kind: "accepted", by: "leader-1", method: "leader" };
  const delivered: BusinessNode = { ...base, kind: "delivered", deliveryId: "d1", number: 2, artifact: { kind: "pr", label: "PR #537" }, technicalResult: "passed", by: "dev" };
  const failed: BusinessNode = { ...base, kind: "observed", deliveryId: "d1", deliveryNumber: 1, result: "failed", observer: "acc", reason: "表头没有对齐。" };
  const used: BusinessNode = { ...base, kind: "observed", deliveryId: "d1", deliveryNumber: 2, result: "used", observer: "acc", reason: null };
  const closed: BusinessNode = { ...base, kind: "closed", cancelled: false, by: "acc" };
  assert.match(nodeText(accepted), /^接手了「做表格视图」 · .*分派$/);
  assert.equal(nodeText(delivered), "提交了第 2 份交付 · PR #537");
  assert.equal(nodeText(failed), "验收：使用失败（第 1 份） · acc · 表头没有对齐。");
  assert.equal(nodeText(used), "验收：已使用（第 2 份） · acc");
  assert.equal(nodeText(closed), "任务已关闭 · acc");
  assert.equal(nodeText({ ...closed, cancelled: true }), "任务已取消 · acc");
  assert.deepEqual([accepted, delivered, failed, used, closed].map(node => nodeMark(node).label), ["接手", "交付", "验收", "验收", "已关闭"]);
  assert.notEqual(nodeMark(accepted).tone, "progress", "a past event never turns like work in progress");
  assert.notEqual(nodeMark(failed).tone, nodeMark(used).tone, "the result shows in the mark");
  assert.equal(nodeHref(accepted, taskHref), "/p/p/tasks/task-1");
  assert.equal(nodeHref(closed, taskHref), "/p/p/tasks/task-1");
  assert.equal(nodeHref(delivered, taskHref), "/p/p/tasks/task-1?tab=delivery&delivery=d1");
  assert.equal(nodeHref(used, id => `/p/p/tasks/${id}?run=r1`), "/p/p/tasks/task-1?run=r1&tab=delivery&delivery=d1");
});

test("nodes stand between the rounds by time, never inside a coordination group, and never reorder the rounds", () => {
  const round = (id: string, minute: number) => ({ kind: "round", round: { key: id, at: at(minute), sentAt: null } }) as unknown as TimelineRow;
  const group = { kind: "coordination-group", id: "g", rounds: [round("g1", 20), round("g2", 21), round("g3", 22)].map(row => (row as { round: unknown }).round) } as unknown as TimelineRow;
  const rows = [round("r1", 10), group, round("r2", 40)];
  const node = (id: string, minute: number) => activity(id, minute, { ...base, kind: "closed", cancelled: false, by: "acc" });
  const out = rowsWithNodes(rows, [node("late", 41), node("inside", 21.5), node("early", 5), node("mid", 15)]);
  assert.deepEqual(out.map(row => row.kind === "node" ? row.item.id : row.kind === "round" ? row.round.key : row.id), ["early", "r1", "mid", "g", "inside", "r2", "late"]);
  assert.deepEqual(rowsWithNodes(rows, []), rows);
});

test("a work round ends with the delivery it made or says it made none; a reply round says neither", () => {
  const turn = (id: string, run: boolean, start: number, end: number): WorkspaceTurn => ({ id, state: "completed", startedAt: at(start), completedAt: at(end),
    origin: run ? { kind: "run", id: `run-${id}`, taskId: "task-1", taskRevisionId: null, initiatingActorId: null } : { kind: "message", id: `m-${id}`, taskId: null, taskRevisionId: null, initiatingActorId: "u" } } as WorkspaceTurn);
  const entry = (id: string, turnId: string): WorkspaceEntry => ({ id, kind: "message", role: "assistant", body: "x", state: "completed", turnId, nativeItemId: id, nativeKind: "agentMessage",
    author: { kind: "session", id: null, label: "x" }, origin: null, occurredAt: at(0), observedAt: at(0), freshness: "persisted", truncated: false } as unknown as WorkspaceEntry);
  const entries = [entry("e1", "t1"), entry("e2", "t2"), entry("e3", "t3")];
  const turns = [turn("t1", true, 0, 10), turn("t2", true, 20, 30), turn("t3", false, 40, 50)];
  const deliveries = [{ taskId: "task-1", deliveryId: "d1", number: 1, label: "PR #537", at: at(5) }];
  const lines = turnSummaries(entries, turns, [], new Set(), deliveries);
  const text = (id: string) => JSON.stringify(lines.get(id) ?? null);
  assert.match(text("e1"), /交付了第 1 份/); assert.match(text("e1"), /PR #537/);
  assert.match(text("e2"), /这一轮没有交付/);
  assert.doesNotMatch(text("e3"), /交付/);
  assert.doesNotMatch(JSON.stringify([...turnSummaries(entries, turns, [], new Set(), null).values()]), /没有交付/, "nodes unread: no claim of no delivery");
});
