import type { WorkspaceEntry, WorkspaceMessage, WorkspaceTurn } from "@evoloop/contracts/session-timeline";

/** Exact source identity survives sender enrichment; never infer it from text or time. */
export const workspaceEntryKey = (entry: WorkspaceEntry): string => entry.turnId && entry.nativeItemId
  ? `native:${entry.turnId}\0${entry.nativeItemId}` : entry.order?.key ?? entry.id;

function preferredEntry(prior: WorkspaceEntry, next: WorkspaceEntry): WorkspaceEntry {
  const resolved = prior.kind === "message" && prior.role === "input" && prior.nativeItemId !== null && prior.origin !== null;
  const unresolved = next.nativeKind === "userMessage" && (next.kind === "notice" && next.origin === null
    || next.kind === "message" && next.role === "input" && next.author.kind === "native");
  if (resolved && unresolved) return prior;
  const terminal = prior.nativeItemId !== null && (prior.kind === "message" || prior.kind === "tool")
    && ["completed", "failed", "interrupted", "declined"].includes(prior.state);
  if (terminal && next.state === "running") return prior;
  if (prior.kind === "message" && next.kind === "message") {
    if (!prior.truncated && next.truncated && prior.state !== "running" && next.state !== "running" && prior.body.startsWith(next.body))
      return { ...next, body: prior.body, truncated: false };
    if (prior.state === "running" && next.state === "running" && prior.body.length > next.body.length && prior.body.startsWith(next.body))
      return { ...next, body: prior.body, truncated: prior.truncated || next.truncated };
  }
  return next;
}

function uniqueEntries(entries: WorkspaceEntry[]): WorkspaceEntry[] {
  const result = new Map<string, WorkspaceEntry>();
  for (const entry of entries) {
    const key = workspaceEntryKey(entry), prior = result.get(key);
    const repeatedFullMessage = prior?.kind === "message" && entry.kind === "message" && prior.id === entry.id
      && prior.state === entry.state && prior.state !== "running" && !prior.truncated
      && !(prior.origin === null && entry.origin !== null);
    result.set(key, repeatedFullMessage ? prior : prior ? preferredEntry(prior, entry) : entry);
  }
  return [...result.values()];
}

/** Merge canonical pages around shared identities. beforeKey is the requested source cursor's boundary. */
export function mergeWorkspaceEntries(previous: WorkspaceEntry[], incoming: WorkspaceEntry[], older = false,
  beforeKey?: string | null): WorkspaceEntry[] {
  const prior = uniqueEntries(previous), next = uniqueEntries(incoming);
  const replacements = new Map(next.map(entry => [workspaceEntryKey(entry), entry]));
  const result = prior.map(entry => replacements.has(workspaceEntryKey(entry))
    ? preferredEntry(entry, replacements.get(workspaceEntryKey(entry))!) : entry);
  const existing = new Set(prior.map(workspaceEntryKey));
  let pending: WorkspaceEntry[] = [];
  for (const entry of next) {
    const key = workspaceEntryKey(entry);
    if (!existing.has(key)) { pending.push(entry); continue; }
    if (pending.length) {
      const index = result.findIndex(item => workspaceEntryKey(item) === key);
      result.splice(index, 0, ...pending); pending = [];
    }
  }
  if (pending.length) {
    const boundary = beforeKey == null ? -1 : result.findIndex(entry => workspaceEntryKey(entry) === beforeKey);
    const hasOverlap = next.some(entry => existing.has(workspaceEntryKey(entry)));
    const index = boundary >= 0 ? boundary : older && beforeKey === undefined && !hasOverlap ? 0 : result.length;
    result.splice(index, 0, ...pending);
  }
  const originalResponses = new Set(result.filter(entry => entry.kind === "message" && entry.role === "assistant"
    && entry.nativeItemId !== null && entry.origin?.kind === "message").map(entry => entry.origin!.id));
  return result.filter(entry => !entry.id.startsWith("message-response:") || entry.origin?.kind !== "message" || !originalResponses.has(entry.origin.id));
}

export function mergeWorkspaceTurns(previous: WorkspaceTurn[], incoming: WorkspaceTurn[]): WorkspaceTurn[] {
  const next = new Map(previous.map(turn => [turn.id, turn]));
  for (const turn of incoming) {
    const prior = next.get(turn.id);
    const terminal = prior && ["completed", "failed", "interrupted", "declined"].includes(prior.state);
    next.set(turn.id, prior ? { ...prior, ...turn, startedAt: turn.startedAt ?? prior.startedAt,
      completedAt: turn.completedAt ?? prior.completedAt,
      // A later read without usage never erases usage already reported for this Turn.
      usage: turn.usage ?? prior.usage ?? null,
      state: terminal && ["running", "pending", "unknown"].includes(turn.state) ? prior.state : turn.state,
    } : turn);
  }
  return [...next.values()];
}

/** Unbound saved inputs use occurrence time only as an insertion anchor. Native items keep their order. */
export function workspaceReadingOrder(entries: WorkspaceEntry[], pending: WorkspaceMessage[]): WorkspaceEntry[] {
  const inputs = new Set(entries.filter(entry => entry.kind === "message" && entry.role === "input" && entry.origin?.kind === "message")
    .map(entry => entry.origin!.id));
  const ids = new Set(entries.map(entry => entry.id));
  const result = [...entries];
  const saved = [...pending].sort((a, b) => a.occurredAt && b.occurredAt ? a.occurredAt.localeCompare(b.occurredAt) : 0);
  for (const message of saved) {
    if (ids.has(message.id) || message.origin?.kind === "message" && inputs.has(message.origin.id)) continue;
    const sameTurn = message.turnId ? result.findIndex(entry => entry.turnId === message.turnId) : -1;
    const byTime = sameTurn < 0 && message.occurredAt
      ? result.findIndex(entry => entry.occurredAt !== null && entry.occurredAt > message.occurredAt!) : -1;
    const index = sameTurn >= 0 ? sameTurn : byTime;
    if (index >= 0) result.splice(index, 0, message); else result.push(message);
    ids.add(message.id);
  }
  return result;
}

export type WorkspaceReadingGroup = { kind: "entry"; entry: WorkspaceEntry } | { kind: "tools"; id: string; entries: Extract<WorkspaceEntry, { kind: "tool" }>[] }
  | { kind: "reasoning"; id: string; turnId: string | null; entries: Extract<WorkspaceEntry, { kind: "reasoning" }>[] };
/**
 * Reading groups in record order. A Turn's reasoning entries fold into one group at the place of its first entry and
 * keep their native order inside it; reasoning never joins another Turn's group.
 */
export function workspaceReadingGroups(entries: WorkspaceEntry[]): WorkspaceReadingGroup[] {
  const groups: WorkspaceReadingGroup[] = [];
  const reasoning = new Map<string, Extract<WorkspaceReadingGroup, { kind: "reasoning" }>>();
  for (const entry of entries) {
    if (entry.kind === "reasoning") {
      const existing = entry.turnId !== null ? reasoning.get(entry.turnId) : undefined;
      if (existing) { existing.entries.push(entry); continue; }
      const group = { kind: "reasoning" as const, id: entry.id, turnId: entry.turnId, entries: [entry] };
      if (entry.turnId !== null) reasoning.set(entry.turnId, group);
      groups.push(group);
      continue;
    }
    const last = groups.at(-1);
    if (entry.kind === "tool") {
      if (last?.kind === "tools" && entry.turnId !== null && last.entries.at(-1)!.turnId === entry.turnId) last.entries.push(entry);
      else groups.push({ kind: "tools", id: entry.id, entries: [entry] });
    } else groups.push({ kind: "entry", entry });
  }
  return groups;
}
