import assert from "node:assert/strict";
import { test } from "node:test";
import type { WorkspaceMessage, WorkspaceTurn } from "@evoloop/contracts/session-timeline";
import type { SessionConversationItem } from "../src/shared/sessionClient";
import { buildRounds, coordinationSummary, isCoordinationRound, roundEntries, timelineRows, type MessageFact } from "../src/features/sessions/timelineRounds";
import { timelineAssistant, timelineMessage, timelineTool } from "./session-timeline-fixtures";

const ME = "reader";
const at = (hour: number, minute = 0) => `2026-11-20T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00.000Z`;
const turn = (id: string, startedAt: string | null, origin: WorkspaceTurn["origin"] = null): WorkspaceTurn => ({ id, state: "completed", startedAt, completedAt: null, origin });
const messageOrigin = (id: string, taskId: string | null = null): WorkspaceTurn["origin"] => ({ kind: "message", id, taskId, taskRevisionId: null, initiatingActorId: "leader-1" });
const fact = (id: string, overrides: Partial<SessionConversationItem> = {}): MessageFact => ({
  projectId: "p", id, operationId: id, target: { kind: "owned", sessionId: "s" } as never, senderActorId: "leader-1", senderClass: "leader",
  content: `body ${id}`, context: null, replyToMessageId: null, state: "replied", version: 1, blockedReason: null, readReceipt: null,
  createdAt: at(9), updatedAt: at(9), ...overrides });
const leaderInput = (id: string, turnId: string | null, overrides: Partial<WorkspaceMessage> = {}) => timelineMessage(id, `body ${id}`, {
  turnId, nativeItemId: turnId ? `in-${id}` : null, nativeKind: turnId ? "userMessage" : null,
  author: { kind: "actor", id: "leader-1", label: "leader-1" }, origin: { kind: "message", id, taskId: null, taskRevisionId: null, initiatingActorId: "leader-1" },
  occurredAt: at(9), ...overrides });
const facts = (...items: MessageFact[]) => ({ messages: new Map(items.map(item => [item.id, item])), me: ME });

test("a saved message with no native Turn sorts between the native rounds by its send time", () => {
  const rounds = buildRounds(
    [leaderInput("m1", "t1", { occurredAt: at(8) }), timelineAssistant("a1", "reply 1", { turnId: "t1" }), leaderInput("m3", "t3", { occurredAt: at(12) }), timelineAssistant("a3", "reply 3", { turnId: "t3" })],
    [leaderInput("m2", null, { occurredAt: at(10) })],
    [turn("t1", at(8), messageOrigin("m1")), turn("t3", at(12), messageOrigin("m3"))], facts(fact("m1", { createdAt: at(8) }), fact("m2", { createdAt: at(10) }), fact("m3", { createdAt: at(12) })));
  assert.deepEqual(rounds.map(round => round.messageId ?? round.turnId), ["m1", "m2", "m3"]);
  assert.deepEqual(roundEntries(rounds).map(entry => entry.id), ["message:m1", "a1", "message:m2", "message:m3", "a3"]);
});

test("a Turn with no time takes the time of the message's processing start; native order is never reordered", () => {
  const rounds = buildRounds(
    [leaderInput("m1", "t1"), timelineAssistant("a1", "reply 1", { turnId: "t1", occurredAt: null }), leaderInput("m2", "t2"), timelineAssistant("a2", "reply 2", { turnId: "t2", occurredAt: null })],
    [leaderInput("m0", null, { occurredAt: at(8) })],
    [turn("t1", null, messageOrigin("m1")), turn("t2", null, messageOrigin("m2"))],
    facts(fact("m1", { createdAt: at(7), processing: { startedAt: at(9) } as never }), fact("m2", { createdAt: at(7), processing: { startedAt: at(10) } as never }), fact("m0", { createdAt: at(8) })));
  // m0 (sent 08:00) comes before the Turns that began at 09:00 and 10:00 even though m1 and m2 were sent earlier.
  assert.deepEqual(rounds.map(round => round.messageId), ["m0", "m1", "m2"]);
});

test("the send time stays when processing starts, and the start is kept apart", () => {
  const [round] = buildRounds([leaderInput("m1", "t1", { occurredAt: at(11) })], [], [turn("t1", at(11), messageOrigin("m1"))],
    facts(fact("m1", { createdAt: at(9), processing: { startedAt: at(11), updatedAt: at(12) } as never })));
  assert.equal(round!.sentAt, at(9));
  assert.equal(round!.startedAt, at(11));
});

test("without a message record the send time is not guessed from the native item's time", () => {
  const [round] = buildRounds([leaderInput("m1", "t1", { occurredAt: at(11) })], [], [turn("t1", at(11), messageOrigin("m1"))], facts());
  assert.equal(round!.sentAt, null);
  assert.equal(round!.startedAt, at(11));
});

test("a reply the record holds comes back to the round; one the timeline shows is not repeated", () => {
  const processing = { startedAt: at(9), updatedAt: at(10), response: "回复全文", responseKind: "native" } as never;
  const noEntries = buildRounds([], [leaderInput("m1", null)], [], facts(fact("m1", { processing })));
  assert.equal(noEntries[0]!.replyRecord?.body, "回复全文");
  assert.equal(noEntries[0]!.replyRecord?.at, at(10));
  const shown = buildRounds([leaderInput("m1", "t1"), timelineAssistant("a1", "时间线里的回复", { turnId: "t1" })], [], [turn("t1", at(9), messageOrigin("m1"))], facts(fact("m1", { processing })));
  assert.equal(shown[0]!.replyRecord, null);
  const note = buildRounds([], [leaderInput("m1", null)], [], facts(fact("m1", { processing: { ...(processing as object), responseKind: "bounded_unread" } as never })));
  assert.equal(note[0]!.replyRecord, null, "a bounded-read note is not the agent's words");
});

test("a Run's Turn is a dispatch round; who sent a message comes from the record, then the protocol text, never from guesswork", () => {
  const run = timelineMessage("run-1", "", { turnId: "t1", nativeItemId: "i1", origin: { kind: "run", id: "run-1", taskId: "task-1", taskRevisionId: null, initiatingActorId: "leader-1" } });
  const [dispatch] = buildRounds([run, timelineAssistant("a1", "x", { turnId: "t1" })], [], [turn("t1", at(9), { kind: "run", id: "run-1", taskId: "task-1", taskRevisionId: null, initiatingActorId: "leader-1" })], facts());
  assert.deepEqual(dispatch!.source, { kind: "run", runId: "run-1", taskId: "task-1", by: "leader" });
  assert.equal(dispatch!.taskId, "task-1");

  const rounds = buildRounds([], [
    leaderInput("a", null, { body: "Session 队伍轮到任务「做事」（x），请先做执行确认" }),
    leaderInput("b", null, { body: "随便一句话" }),
    timelineMessage("c", "我的话", { author: { kind: "actor", id: ME, label: ME }, origin: { kind: "message", id: "c", taskId: null, taskRevisionId: null, initiatingActorId: ME } }),
  ], [], facts(fact("a", { senderClass: undefined, content: "Session 队伍轮到任务「做事」（x），请先做执行确认" }), fact("b", { senderClass: "requirements", senderActorId: "req" }), fact("c", { senderActorId: ME, senderClass: "user" })));
  assert.deepEqual(rounds.map(round => round.source.kind === "message" ? round.source.from : "-"), ["leader", "other", "me"]);
});

test("three or more Leader messages in a row with nothing after them group; a reply between them breaks the run", () => {
  const bare = (id: string, hour: number) => leaderInput(id, null, { occurredAt: at(hour) });
  const all = buildRounds([], ["m1", "m2", "m3"].map((id, index) => bare(id, 8 + index)), [], facts(...["m1", "m2", "m3"].map((id, index) => fact(id, { createdAt: at(8 + index) }))));
  const rows = timelineRows(all);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.kind, "coordination-group");
  const two = timelineRows(all.slice(0, 2));
  assert.deepEqual(two.map(row => row.kind), ["round", "round"]);
  const answered = buildRounds([leaderInput("m2", "t2", { occurredAt: at(9) }), timelineAssistant("a2", "好", { turnId: "t2" })], [bare("m1", 8), bare("m3", 10), bare("m4", 11), bare("m5", 12)], [turn("t2", at(9), messageOrigin("m2"))],
    facts(fact("m1", { createdAt: at(8) }), fact("m2", { createdAt: at(9) }), fact("m3", { createdAt: at(10) }), fact("m4", { createdAt: at(11) }), fact("m5", { createdAt: at(12) })));
  assert.deepEqual(timelineRows(answered).map(row => row.kind), ["round", "round", "coordination-group"]);
  assert.ok(isCoordinationRound(answered[0]!));
});

test("the folded line says kind, task title and time; the task title from the records wins over the text", () => {
  const [round] = buildRounds([], [leaderInput("m1", null, { body: "Session 队伍轮到任务「文字里的名」（t），请先做执行确认" })], [],
    facts(fact("m1", { content: "Session 队伍轮到任务「文字里的名」（t），请先做执行确认", context: { taskId: "task-9", taskRevisionId: "r" }, createdAt: at(9, 30) })));
  assert.deepEqual(coordinationSummary(round!, id => id === "task-9" ? "记录里的名" : null), { type: "执行确认请求", title: "记录里的名", at: at(9, 30) });
  assert.equal(coordinationSummary(round!, () => null).title, "文字里的名");
});

test("tools stay inside the Turn they belong to and a Turn's input is not repeated in its body", () => {
  const [round] = buildRounds([leaderInput("m1", "t1"), timelineTool("tool-1", "Bash", "ls", "completed", { turnId: "t1" }), timelineAssistant("a1", "ok", { turnId: "t1" })], [], [turn("t1", at(9), messageOrigin("m1"))], facts());
  assert.equal(round!.input?.id, "message:m1");
  assert.deepEqual(round!.body.map(entry => entry.id), ["tool-1", "a1"]);
});
