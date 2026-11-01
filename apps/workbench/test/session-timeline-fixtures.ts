import type { SessionTimelinePage, WorkspaceEntry, WorkspaceMessage, WorkspaceTurn } from "@evoloop/contracts/session-timeline";

export const timelineStamp = "2026-11-01T12:00:00.000Z";

export function timelineMessage(id: string, body: string, overrides: Partial<WorkspaceMessage> = {}): WorkspaceMessage {
  return { id: `message:${id}`, kind: "message", role: "input", phase: "unknown", body, clientId: id,
    state: "completed", turnId: null, nativeItemId: null, nativeKind: null,
    author: { kind: "actor", id: "reader", label: "reader" },
    origin: { kind: "message", id, taskId: null, taskRevisionId: null, initiatingActorId: "reader" },
    occurredAt: timelineStamp, observedAt: timelineStamp, freshness: "persisted", truncated: false, ...overrides };
}

export function timelineAssistant(id: string, body: string, overrides: Partial<WorkspaceMessage> = {}): WorkspaceMessage {
  return { id, kind: "message", role: "assistant", phase: "final_answer", body, clientId: null,
    state: "completed", turnId: "turn-1", nativeItemId: id, nativeKind: "agentMessage",
    author: { kind: "session", id: null, label: "测试 Session" }, origin: null,
    occurredAt: timelineStamp, observedAt: timelineStamp, freshness: "persisted", truncated: false, ...overrides };
}

export function timelineTool(id: string, name: string, summary: string, state: "pending" | "running" | "completed" | "failed" = "completed",
  overrides: Partial<Extract<WorkspaceEntry, { kind: "tool" }>> = {}): Extract<WorkspaceEntry, { kind: "tool" }> {
  return { id, kind: "tool", name, summary, state, turnId: "turn-1", nativeItemId: id, nativeKind: "commandExecution",
    author: { kind: "native", id: null, label: "原生工具" }, origin: null, occurredAt: timelineStamp,
    observedAt: timelineStamp, freshness: "persisted", truncated: false, durationMs: null, exitCode: null,
    detailAvailable: true, detailReason: null, ...overrides };
}

export function timelinePage(key: string, options: {
  title?: string;
  entries?: WorkspaceEntry[];
  pending?: WorkspaceMessage[];
  turns?: WorkspaceTurn[];
  nextCursor?: string | null;
  messagesCursor?: string | null;
  cursor?: string;
  partial?: boolean;
  liveEntries?: WorkspaceEntry[];
  liveTurns?: WorkspaceTurn[];
  activeTurnId?: string | null;
  liveFreshness?: "live" | "stale" | "unavailable";
  history?: boolean;
  live?: boolean;
  originalToolDetail?: boolean;
} = {}): SessionTimelinePage {
  const observedAt = timelineStamp;
  const { entries = [], pending = [], turns = [], nextCursor = null, messagesCursor = null,
    cursor = "0", partial = false, liveEntries = [], liveTurns = [], liveFreshness = "live" } = options;
  const activeTurnId = options.activeTurnId === undefined
    ? liveTurns.find(turn => turn.state === "running")?.id ?? null
    : options.activeTurnId;
  return { sessionKey: key as SessionTimelinePage["sessionKey"], sessionTitle: options.title ?? key,
    entries, pending, turns, nextCursor, messagesCursor, observedAt, partial, limitations: [], unsupportedKinds: [],
    live: { cursor, resetRequired: false, entries: liveEntries, turns: liveTurns, freshness: liveFreshness, limitations: [], activeTurnId },
    capabilities: { history: options.history ?? true, live: options.live ?? true,
      originalToolDetail: options.originalToolDetail ?? true, reason: null } };
}
