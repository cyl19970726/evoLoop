import { RuntimeProtocolError, type RuntimeBinding, type RuntimeHistoryItem } from "@evoloop/contracts/runtime";
import type { NativeWorkspacePage, NativeWorkspaceReadOptions, WorkspaceEntry, WorkspaceMessage, WorkspaceState,
  WorkspaceTurn } from "@evoloop/contracts/session-timeline";
import type { LedgerTurn } from "./ledger.js";

/**
 * Session timeline history read from the adapter's own Turn ledger. The ledger is what the adapter observed from the
 * SDK stream for each Turn it started: the prompt, assistant text, tool-call identities, thinking blocks, the final
 * answer and the settled usage. Tool inputs and outputs are not stored, so no original tool detail exists.
 */
const PREVIEW_BYTES = 4096;
const SELECTED_BYTES = 1_000_000;
const marker = /^\[evoloop-(run|message)-operation:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\]\n/;
const safeName = (value: unknown): string | null =>
  typeof value === "string" && value.length <= 120 && /^[\p{L}\p{N}][\p{L}\p{N}._:/-]*$/u.test(value) ? value : null;

function clipped(value: string, max: number): { value: string; truncated: boolean } {
  const bytes = Buffer.from(value, "utf8");
  const truncated = bytes.length > max;
  return { value: new TextDecoder("utf-8").decode(bytes.subarray(0, max), { stream: truncated }), truncated };
}

function turnState(turn: LedgerTurn, live: boolean): WorkspaceState {
  if (turn.settled) return turn.settled.status;
  return live ? "running" : "unknown";
}

function entriesOf(binding: RuntimeBinding, turn: LedgerTurn, live: boolean, observedAt: string, detailItemId?: string): WorkspaceEntry[] {
  const thread = binding.nativeThreadId;
  const state = turnState(turn, live);
  const items: RuntimeHistoryItem[] = [{ id: turn.turnId, type: "userMessage", content: [{ type: "text", text: turn.input }] }, ...turn.items];
  return items.map((item, position): WorkspaceEntry => {
    const id = `native:${thread}:${turn.turnId}:${item.id}`;
    const max = detailItemId === item.id ? SELECTED_BYTES : PREVIEW_BYTES;
    const base = { id, turnId: turn.turnId, nativeItemId: item.id, nativeKind: item.type, origin: null,
      author: item.type === "userMessage" ? { kind: "native" as const, id: null, label: "Native input" }
        : { kind: "session" as const, id: binding.sessionId, label: "Agent" },
      occurredAt: item.type === "userMessage" ? turn.startedAt : null, observedAt, freshness: "persisted" as const, truncated: false,
      order: { kind: "native-item" as const, key: id, position, generation: null } };
    if (item.type === "userMessage") {
      const match = marker.exec(turn.input);
      const message: WorkspaceMessage = { ...base, kind: "message", role: "input", phase: "unknown", body: "",
        clientId: turn.operationId, state: "completed",
        ...(match ? { inputReference: { kind: "operation-marker", source: match[1] as "run" | "message", operationId: match[2]! } } : {}) };
      return message;
    }
    if (item.type === "agentMessage" && typeof item.text === "string") {
      const body = clipped(item.text, max);
      const phase = item.phase === "final_answer" || item.phase === "commentary" ? item.phase : "unknown";
      return { ...base, kind: "message", role: "assistant", phase, body: body.value, clientId: null,
        state: "completed", truncated: body.truncated };
    }
    if (item.type === "reasoning") {
      const text = typeof item.text === "string" && item.text.trim() ? item.text : null;
      const body = clipped(text ?? "", max);
      return { ...base, kind: "reasoning", source: text ? "thinking" : "none", readable: text !== null, body: body.value,
        truncated: body.truncated, state: "completed",
        unavailableReason: text ? null : item.redacted === true
          ? "Claude 返回的是加密的思考内容（redacted_thinking），不可显示。"
          : "这一段思考没有返回可读文字（原生记录只有思考标记）。" };
    }
    if (item.type === "toolCall") {
      const name = safeName(item.name) ?? "Tool";
      return { ...base, kind: "tool", name, summary: name, state: state === "running" ? "running" : state === "completed" ? "completed" : "unknown",
        durationMs: null, exitCode: null, detailAvailable: false,
        detailReason: "Claude 工具的原始输入与输出不保存在运行记录中。" };
    }
    return { ...base, kind: "notice", label: "Unsupported native item", body: "", state: "unknown" };
  });
}

function turnOf(binding: RuntimeBinding, turn: LedgerTurn, live: boolean): WorkspaceTurn {
  const settled = turn.settled;
  return { id: turn.turnId, state: turnState(turn, live), startedAt: turn.startedAt, completedAt: settled?.completedAtUtc ?? null,
    origin: null, order: { kind: "turn-boundary", key: `boundary:${binding.nativeThreadId}:${turn.turnId}:metadata`, position: null, generation: null },
    usage: settled && settled.source === "result" ? { outputTokens: settled.usage?.outputTokens ?? null,
      reasoningOutputTokens: settled.thinkingTokens ?? null, source: "claude-result" } : null };
}

function offset(cursor?: string): number {
  if (cursor === undefined) return 0;
  if (!/^[1-9][0-9]{0,8}$/.test(cursor)) throw new RuntimeProtocolError("invalid workspace cursor");
  return Number(cursor);
}

/** Newest entries first by page; each page keeps native order. A selected Item returns its full readable body. */
export function readLedgerWorkspace(binding: RuntimeBinding, turns: LedgerTurn[], options: NativeWorkspaceReadOptions,
  observedAt: string, isLive: (turnId: string) => boolean): NativeWorkspacePage {
  const limit = options.limit ?? 50;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new RuntimeProtocolError("workspace history: limit must be 1–50");
  if (options.itemId && !options.turnId) throw new RuntimeProtocolError("workspace history: invalid item selection");
  const scoped = options.turnId ? turns.filter(turn => turn.turnId === options.turnId) : turns;
  const page = (entries: WorkspaceEntry[], next: string | null, limitations: string[] = []): NativeWorkspacePage => {
    const ids = new Set(entries.map(entry => entry.turnId));
    const unsupportedKinds = [...new Set(entries.filter(e => e.kind === "notice" && e.label === "Unsupported native item").map(e => e.nativeKind!))];
    return { entries, turns: scoped.filter(turn => ids.has(turn.turnId)).map(turn => turnOf(binding, turn, isLive(turn.turnId))),
      nextCursor: next, observedAt, historyMode: "unknown", method: "items", itemEnumerationComplete: !next && unsupportedKinds.length === 0,
      partial: !!next || limitations.length > 0 || unsupportedKinds.length > 0 || entries.some(e => e.truncated), limitations, unsupportedKinds };
  };
  if (options.itemId) {
    if (options.cursor) throw new RuntimeProtocolError("workspace history: selection has no cursor");
    const turn = scoped[0];
    const entry = turn ? entriesOf(binding, turn, isLive(turn.turnId), observedAt, options.itemId).find(e => e.nativeItemId === options.itemId) : undefined;
    return page(entry ? [entry] : [], null, entry ? [] : ["selected item unavailable"]);
  }
  const all = scoped.flatMap(turn => entriesOf(binding, turn, isLive(turn.turnId), observedAt));
  const skip = offset(options.cursor);
  if (skip > all.length) throw new RuntimeProtocolError("invalid workspace cursor");
  const end = all.length - skip, start = Math.max(0, end - limit);
  return page(all.slice(start, end), start > 0 ? String(skip + (end - start)) : null);
}
