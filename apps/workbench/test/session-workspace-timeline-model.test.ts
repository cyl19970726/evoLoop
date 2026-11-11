import assert from "node:assert/strict";
import { test } from "node:test";
import type { WorkspaceEntry, WorkspaceMessage, WorkspaceTool } from "@evoloop/contracts/session-timeline";
import { mergeWorkspaceEntries, mergeWorkspaceTurns, workspaceEntryKey, workspaceReadingGroups, workspaceReadingOrder } from "../src/features/sessions/workspaceTimelineModel";
import { pinnedToolIds, turnLabel, turnReasoningTokensText } from "../src/features/sessions/conversationPresentation";

const stamp = "2026-11-01T12:00:00.000Z";
function message(id: string, role: WorkspaceMessage["role"], overrides: Partial<WorkspaceMessage> = {}): WorkspaceMessage {
  return { id, kind: "message", role, phase: role === "input" ? "unknown" : "final_answer", body: id, clientId: null,
    state: "completed", turnId: null, nativeItemId: null, nativeKind: null,
    author: { kind: role === "input" ? "actor" : "session", id: role === "input" ? "reader" : "s1", label: id },
    origin: null, occurredAt: stamp, observedAt: stamp, freshness: "persisted", truncated: false, ...overrides };
}
function tool(id: string, turnId: string | null, overrides: Partial<WorkspaceTool> = {}): WorkspaceTool {
  return { id, kind: "tool", name: id, summary: "", state: "completed", durationMs: null, exitCode: null,
    detailAvailable: false, detailReason: null, turnId, nativeItemId: id, nativeKind: "commandExecution",
    author: { kind: "native", id: null, label: "原生活动" }, origin: null, occurredAt: stamp,
    observedAt: stamp, freshness: "persisted", truncated: false, ...overrides };
}

test("native entry reading order follows the supplied sequence, not observed or occurrence time", () => {
  const lateObserved = message("first", "assistant", { occurredAt: "2026-11-02T00:00:00.000Z", observedAt: "2026-11-02T00:00:00.000Z" });
  const earlyObserved = message("second", "assistant", { occurredAt: "2026-10-01T00:00:00.000Z", observedAt: "2026-10-01T00:00:00.000Z" });
  assert.deepEqual(workspaceReadingOrder([lateObserved, earlyObserved], []).map(entry => entry.id), ["first", "second"]);
});

test("entry merging replaces stable IDs in place and deduplicates repeated incoming entries", () => {
  const prior = [message("a", "assistant"), message("b", "assistant")];
  const replacement = message("a", "assistant", { body: "updated" });
  const merged = mergeWorkspaceEntries(prior, [replacement, message("c", "assistant"), message("c", "assistant", { body: "duplicate" })]);
  assert.deepEqual(merged.map(entry => entry.id), ["a", "b", "c"]);
  assert.equal(merged[0]?.kind === "message" ? merged[0].body : "", "updated");
  assert.equal(merged[2]?.kind === "message" ? merged[2].body : "", "c");
  assert.deepEqual(mergeWorkspaceEntries(prior, [message("older", "assistant")], true).map(entry => entry.id), ["older", "a", "b"]);
});

test("overlapping snapshot windows insert the missing native prefix before their shared anchor", () => {
  const native = (id: string) => message(id, "assistant", { turnId: "turn-B", nativeItemId: id, nativeKind: "agentMessage" });
  const prior = [message("A1", "assistant", { turnId: "turn-A", nativeItemId: "A1" }),
    message("A2", "assistant", { turnId: "turn-A", nativeItemId: "A2" }), native("B8"), native("B9")];
  const incoming = [native("B6"), native("B7"), native("B8"), native("B9")];
  assert.deepEqual(mergeWorkspaceEntries(prior, incoming, true).map(entry => entry.id), ["A1", "A2", "B6", "B7", "B8", "B9"]);
});

test("older cursor pages insert before their requested source boundary", () => {
  const native = (id: string) => message(id, "assistant", { turnId: "turn-B", nativeItemId: id, nativeKind: "agentMessage" });
  const boundary = native("B6");
  const prior = [message("A1", "assistant", { turnId: "turn-A", nativeItemId: "A1" }),
    message("A2", "assistant", { turnId: "turn-A", nativeItemId: "A2" }), boundary, native("B7"), native("B8"), native("B9")];
  assert.deepEqual(mergeWorkspaceEntries(prior, [native("B4"), native("B5")], true, workspaceEntryKey(boundary))
    .map(entry => entry.id), ["A1", "A2", "B4", "B5", "B6", "B7", "B8", "B9"]);
});

test("an older overlapping prefix cannot shorten a public running message", () => {
  const current = message("B8", "assistant", { body: "public reply has continued", state: "running", phase: "partial_answer",
    freshness: "live", turnId: "turn-B", nativeItemId: "B8", nativeKind: "agentMessage" });
  const olderPrefix = message("B8", "assistant", { body: "public reply", state: "running", phase: "partial_answer",
    freshness: "persisted", turnId: "turn-B", nativeItemId: "B8", nativeKind: "agentMessage" });
  const merged = mergeWorkspaceEntries([current], [olderPrefix], true, workspaceEntryKey(current));
  assert.equal(merged.length, 1);
  assert.equal(merged[0]?.kind === "message" ? merged[0].body : "", current.body);
});

test("a native assistant entry removes the paired message-response fallback", () => {
  const fallback = message("message-response:message-1", "assistant", {
    origin: { kind: "message", id: "message-1", taskId: null, taskRevisionId: null, initiatingActorId: "reader" },
  });
  const native = message("native-answer-1", "assistant", {
    nativeItemId: "native-item-1", nativeKind: "agentMessage", turnId: "turn-1",
    origin: { kind: "message", id: "message-1", taskId: null, taskRevisionId: null, initiatingActorId: "reader" },
  });
  assert.deepEqual(mergeWorkspaceEntries([fallback], [native]).map(entry => entry.id), ["native-answer-1"]);
  assert.deepEqual(mergeWorkspaceEntries([native], [fallback]).map(entry => entry.id), ["native-answer-1"]);
});

test("a late authoritative saved input replaces its exact Turn and Item notice in place", () => {
  const before = message("before", "assistant");
  const notice = message("native-input-notice", "input", { phase: "unknown", body: "原生用户输入待核对",
    turnId: "turn-1", nativeItemId: "native-item-1", nativeKind: "userInput", origin: null });
  const after = message("after", "assistant", { turnId: "turn-1" });
  const saved = message("message:pg-input", "input", { body: "用户保存的原始消息", turnId: "turn-1", nativeItemId: "native-item-1",
    nativeKind: "userInput", origin: { kind: "message", id: "pg-input", taskId: null, taskRevisionId: null, initiatingActorId: "reader" } });
  const merged = mergeWorkspaceEntries([before, notice, after], [saved]);
  assert.deepEqual(merged.map(entry => entry.id), ["before", "message:pg-input", "after"]);
  const inputs = merged.filter(entry => entry.kind === "message" && entry.role === "input");
  assert.equal(inputs.length, 1);
  assert.equal(inputs[0]?.kind === "message" ? inputs[0].body : "", "用户保存的原始消息");
  assert.equal(inputs[0]?.kind === "message" ? inputs[0].origin?.kind : undefined, "message");
});

test("the same native Item ID in a different Turn does not bind an authoritative saved input", () => {
  const notice = message("native-input-notice", "input", { phase: "unknown", body: "原生用户输入待核对",
    turnId: "turn-1", nativeItemId: "reused-item", nativeKind: "userInput", origin: null });
  const saved = message("message:pg-input", "input", { body: "用户保存的消息", turnId: "turn-2", nativeItemId: "reused-item",
    nativeKind: "userInput", origin: { kind: "message", id: "pg-input", taskId: null, taskRevisionId: null, initiatingActorId: "reader" } });
  const merged = mergeWorkspaceEntries([notice], [saved]);
  assert.deepEqual(merged.map(entry => entry.id), ["native-input-notice", "message:pg-input"]);
  assert.deepEqual(merged.map(entry => entry.turnId), ["turn-1", "turn-2"]);
});

test("a late unknown native notice cannot downgrade or duplicate an exact saved input", () => {
  const saved = message("message:pg-input", "input", { body: "authoritative saved message", turnId: "turn-1",
    nativeItemId: "native-input", nativeKind: "userMessage",
    origin: { kind: "message", id: "pg-input", taskId: null, taskRevisionId: null, initiatingActorId: "reader" } });
  const lateNotice: WorkspaceEntry = { id: "native-input-notice", kind: "notice", label: "用户输入", body: "待核对",
    state: "unknown", turnId: "turn-1", nativeItemId: "native-input", nativeKind: "userMessage",
    author: { kind: "native", id: null, label: "原生活动" }, origin: null, occurredAt: stamp, observedAt: stamp,
    freshness: "live", truncated: false };
  const merged = mergeWorkspaceEntries([saved], [lateNotice]);
  assert.deepEqual(merged.map(entry => entry.id), ["message:pg-input"]);
  assert.equal(merged[0]?.kind === "message" ? merged[0].body : "", "authoritative saved message");
});

test("a terminal history item wins a delayed running overlay, while a running item accepts completion", () => {
  for (const state of ["completed", "failed", "interrupted", "declined"] as const) {
    const historic = message("stable-item", "assistant", { state, body: `historic ${state}`, freshness: "persisted",
      nativeItemId: "stable-native-item", nativeKind: "agentMessage" });
    const delayedLive = message("stable-item", "assistant", { state: "running", body: "stale running update", freshness: "live",
      nativeItemId: "stable-native-item", nativeKind: "agentMessage" });
    const merged = mergeWorkspaceEntries([historic], [delayedLive]);
    assert.equal(merged.length, 1);
    assert.equal(merged[0]?.kind === "message" ? merged[0].state : null, state);
    assert.equal(merged[0]?.kind === "message" ? merged[0].body : null, `historic ${state}`);
  }
  const running = message("active-item", "assistant", { state: "running", body: "partial", freshness: "live",
    nativeItemId: "active-native-item", nativeKind: "agentMessage" });
  const completed = message("active-item", "assistant", { state: "completed", body: "final", freshness: "persisted",
    nativeItemId: "active-native-item", nativeKind: "agentMessage" });
  const merged = mergeWorkspaceEntries([running], [completed]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0]?.kind === "message" ? merged[0].state : null, "completed");
  assert.equal(merged[0]?.kind === "message" ? merged[0].body : null, "final");
});

test("terminal public plan records can still take later mutable updates", () => {
  const plan: WorkspaceEntry = { id: "plan-item", kind: "plan", label: "执行计划", body: "旧计划", state: "completed",
    turnId: "turn-1", nativeItemId: "plan-item", nativeKind: "plan", author: { kind: "native", id: null, label: "计划" },
    origin: null, occurredAt: stamp, observedAt: stamp, freshness: "persisted", truncated: false };
  const updated: WorkspaceEntry = { ...plan, body: "更新后的计划", state: "running", freshness: "live" };
  const merged = mergeWorkspaceEntries([plan], [updated]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0]?.kind === "plan" ? merged[0].body : "", "更新后的计划");
  assert.equal(merged[0]?.state, "running");
});

test("saved inputs bind to their native message and deduplicate by both saved and native identity", () => {
  const boundNative = message("message:saved-1", "input", { nativeItemId: "native-item", origin: { kind: "message", id: "saved-1", taskId: null, taskRevisionId: null, initiatingActorId: "reader" } });
  const response = message("response", "assistant", { turnId: "turn-1" });
  const unbound = message("saved-2", "input", { turnId: "turn-2", occurredAt: "2026-11-01T13:00:00.000Z" });
  const pendingBound = message("message:saved-1", "input", { origin: { kind: "message", id: "saved-1", taskId: null, taskRevisionId: null, initiatingActorId: "reader" } });
  const reading = workspaceReadingOrder([boundNative, response], [pendingBound, unbound]);
  assert.deepEqual(reading.map(entry => entry.id), ["message:saved-1", "response", "saved-2"]);
  assert.equal(reading.filter(entry => entry.kind === "message" && entry.role === "input" && entry.origin?.kind === "message").length, 1);
});

test("saved inputs with a native turn anchor precede that turn without reordering native entries", () => {
  const native = [message("prior", "assistant"), tool("tool", "turn-1"), message("answer", "assistant", { turnId: "turn-1" })];
  const saved = message("saved", "input", { turnId: "turn-1", occurredAt: "2026-11-01T00:00:00.000Z" });
  assert.deepEqual(workspaceReadingOrder(native, [saved]).map(entry => entry.id), ["prior", "saved", "tool", "answer"]);
});

test("authoritative saved inputs returned in a native-only page remain in reading order", () => {
  const nativeEntries = [message("native-answer", "assistant", { turnId: "turn-1", occurredAt: "2026-11-01T12:01:00.000Z" })];
  const pgInput = message("message:pg-input", "input", { turnId: "turn-1", occurredAt: "2026-11-01T12:00:00.000Z",
    origin: { kind: "message", id: "pg-input", taskId: null, taskRevisionId: null, initiatingActorId: "reader" } });
  assert.deepEqual(workspaceReadingOrder(nativeEntries, [pgInput]).map(entry => entry.id), ["message:pg-input", "native-answer"]);
});

test("tool grouping is contiguous and scoped to one known turn", () => {
  const entries: WorkspaceEntry[] = [tool("a", "turn-1"), tool("b", "turn-1"), message("answer", "assistant", { turnId: "turn-1" }),
    tool("c", "turn-1"), tool("d", "turn-2"), tool("e", null), tool("f", null)];
  const groups = workspaceReadingGroups(entries);
  assert.deepEqual(groups.map(group => group.kind === "tools" ? group.entries.map(entry => entry.id) : group.entry.id),
    [["a", "b"], "answer", ["c"], ["d"], ["e"], ["f"]]);
});

test("a folded group of 100 tools keeps every failure, the step running now and the step being read in sight", () => {
  const entries = Array.from({ length: 100 }, (_, index) => tool(`tool-${index}`, "turn-1"));
  entries[2] = tool("failed-early", "turn-1", { state: "failed" });
  entries[7] = tool("interrupted", "turn-1", { state: "interrupted" });
  entries[40] = tool("running-middle", "turn-1", { state: "running", freshness: "live" });
  entries[50] = tool("running-stale", "turn-1", { state: "running", freshness: "stale" });
  assert.deepEqual([...pinnedToolIds(entries)].sort(), ["failed-early", "interrupted", "running-middle"]);
  assert.ok(pinnedToolIds(entries, "tool-60").has("tool-60"), "the step whose detail is open stays in sight");
  assert.equal(pinnedToolIds(entries, "elsewhere").has("elsewhere"), false);
  assert.equal(pinnedToolIds(entries.slice(10, 20)).size, 0, "a quiet group folds entirely");
});

test("turn merging replaces updates without changing first-seen turn order", () => {
  const first = { id: "turn-1", state: "running" as const, startedAt: stamp, completedAt: null, origin: null };
  const second = { id: "turn-2", state: "pending" as const, startedAt: null, completedAt: null, origin: null };
  const merged = mergeWorkspaceTurns([first, second], [{ ...first, state: "completed" }, { id: "turn-3", state: "failed", startedAt: stamp, completedAt: stamp, origin: null }]);
  assert.deepEqual(merged.map(turn => turn.id), ["turn-1", "turn-2", "turn-3"]);
  assert.equal(merged[0]?.state, "completed");
});

test("partial turn boundaries retain known times and do not reopen terminal turns", () => {
  const completed = { id: "turn-terminal", state: "completed" as const, startedAt: stamp,
    completedAt: "2026-11-01T12:30:00.000Z", origin: null };
  const partialBoundary = { id: "turn-terminal", state: "unknown" as const, startedAt: null, completedAt: null, origin: null };
  const merged = mergeWorkspaceTurns([completed], [partialBoundary]);
  assert.equal(merged[0]?.state, "completed");
  assert.equal(merged[0]?.startedAt, stamp);
  assert.equal(merged[0]?.completedAt, completed.completedAt);
});

test("each Turn's reasoning folds into one group at its first entry, in native order, never across Turns", () => {
  const r = (item: string, turnId: string): WorkspaceEntry => ({ id: `native:t:${turnId}:${item}`, turnId, nativeItemId: item, nativeKind: "reasoning",
    author: { kind: "session", id: "s", label: "Agent" }, origin: null, occurredAt: null, observedAt: "now", freshness: "persisted", truncated: false,
    kind: "reasoning", source: "summary", readable: true, body: item, unavailableReason: null, state: "completed" });
  const tool = (item: string, turnId: string): WorkspaceEntry => ({ id: `native:t:${turnId}:${item}`, turnId, nativeItemId: item, nativeKind: "commandExecution",
    author: { kind: "session", id: "s", label: "Agent" }, origin: null, occurredAt: null, observedAt: "now", freshness: "persisted", truncated: false,
    kind: "tool", name: "Command", summary: "Command", state: "completed", durationMs: null, exitCode: null, detailAvailable: false, detailReason: null });
  const groups = workspaceReadingGroups([r("a1", "A"), tool("t1", "A"), r("a2", "A"), tool("t2", "A"), r("b1", "B"), r("a3", "A")]);
  assert.deepEqual(groups.map(group => group.kind === "reasoning" ? `reasoning:${group.turnId}:${group.entries.map(e => e.nativeItemId).join(",")}`
    : group.kind === "tools" ? `tools:${group.entries.map(e => e.nativeItemId).join(",")}` : "entry"),
  ["reasoning:A:a1,a2,a3", "tools:t1,t2", "reasoning:B:b1"]);
  assert.equal(turnReasoningTokensText(null), "推理 token：原生未报告");
  assert.equal(turnReasoningTokensText({ outputTokens: 1200, reasoningOutputTokens: 300, source: "codex-token-usage" }), "推理 token 300 / 输出 1,200（Codex 用量事件）");
  assert.equal(turnReasoningTokensText({ outputTokens: null, reasoningOutputTokens: null, source: "claude-result" }), "推理 token 原生未报告（Claude 结果用量）");
  assert.match(turnLabel("019a2b3c-dead-beef", null), /^回合 019a2b3c$/);
  assert.equal(turnReasoningTokensText({ outputTokens: null, reasoningOutputTokens: null, source: "codex-token-usage", complete: false }),
    "推理 token 未知（没有观察到这一轮的起点，读数不完整）");
});
