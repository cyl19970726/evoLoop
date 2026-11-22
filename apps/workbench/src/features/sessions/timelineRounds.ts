// The timeline read as rounds of work (Task f2d82dfe). A round is one native Turn with what started it: where it came from
// (Leader's dispatch of a Task, a person's message, another agent's message), the agent's reply and the rest of the turn. Saved
// messages that have no native Turn yet (older ones the native page has not reached, queued ones) are rounds of their own.
// Rounds from both sources are merged into one sequence by time; inside a Turn the native order is kept.
//
// Nothing here reads the network or the DOM: the page hands in what the timeline and the saved-message list returned.
import type { WorkspaceEntry, WorkspaceMessage, WorkspaceTurn } from "@evoloop/contracts/session-timeline";
import type { SessionConversationItem } from "../../shared/sessionClient";
import { queuedMessageSummary } from "./queuedMessagePresentation";

/** One saved message as the message list returns it: sender class, send time, and how it was processed. */
export type MessageFact = SessionConversationItem;

/** Who a message is from, in the words the page uses. `unknown` is a message whose sender class this read cannot tell. */
export type MessageFrom = "me" | "leader" | "other" | "unknown";

export type RoundSource =
  /** The Run for a Task started this Turn. `by` is who dispatched it: a person who dispatched it themselves, else the Leader's line. */
  | { kind: "run"; runId: string; taskId: string | null; by: "me" | "leader" }
  | { kind: "message"; messageId: string; from: MessageFrom; classLabel: string | null }
  | { kind: "none" };

export interface ReplyFromRecord {
  body: string;
  truncated: boolean;
  /** When the reply was written (the processing record's last update); null when the record does not say. */
  at: string | null;
}

export interface Round {
  /** Stable across reads: the Turn, or the saved message of a round with no Turn yet. */
  key: string;
  turnId: string | null;
  /** The time the round sorts by (the Turn's start, else the message's processing start, else its send time). */
  at: string | null;
  source: RoundSource;
  messageId: string | null;
  /** The entry that carries the message that started the round (or the dispatch marker of a Run). */
  input: WorkspaceEntry | null;
  /** The rest of the round, in native order. */
  body: WorkspaceEntry[];
  /** When the message was sent. Never replaced by when it began to be processed. Null when no read says. */
  sentAt: string | null;
  /** When processing began, when it is known and says something other than the send time. */
  startedAt: string | null;
  /** The reply the message list holds, for a round whose reply the timeline does not show. */
  replyRecord: ReplyFromRecord | null;
  /** The Task the round is for, when the records name one. */
  taskId: string | null;
  fact: MessageFact | null;
}

export interface RoundFacts {
  /** Saved messages by id, from the message list. May be empty or partial: a round without a fact says less, never something else. */
  messages: ReadonlyMap<string, MessageFact>;
  /** The reader's own actor id. */
  me: string;
}

const isInput = (entry: WorkspaceEntry): entry is WorkspaceMessage => entry.kind === "message" && entry.role === "input";
const isReply = (entry: WorkspaceEntry): boolean => entry.kind === "message" && entry.role === "assistant";
const ms = (value: string | null | undefined): number | null => {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : time;
};

/** Texts the Leader sends the agent as part of its coordination: the confirmation request and the notice kinds the queue summarises. */
export function isCoordinationText(body: string): boolean {
  return body.startsWith("Session 队伍轮到任务「") || body.startsWith("Session 队伍排到了") || queuedMessageSummary(body).label !== null;
}

const classLabels: Record<string, string> = { user: "使用者", leader: "Leader", requirements: "需求 Session", session: "其他智能体", system: "系统", hub: "经 Hub 的身份", service: "Hub 服务身份" };
/** The short name the page gives a message's sender class (the full wording stays in 消息详情). */
export function shortClassLabel(senderClass: string | null | undefined): string | null {
  return senderClass ? classLabels[senderClass] ?? null : null;
}

function classify(input: WorkspaceEntry | null, fact: MessageFact | null, me: string): { from: MessageFrom; classLabel: string | null } {
  const actor = fact?.senderActorId ?? (input?.author.kind === "actor" ? input.author.id : null);
  if (actor !== null && actor === me) return { from: "me", classLabel: null };
  const senderClass = fact?.senderClass ?? null;
  if (senderClass === "leader") return { from: "leader", classLabel: "Leader" };
  if (senderClass) return { from: "other", classLabel: shortClassLabel(senderClass) };
  // No class was read for this message: only the Leader's own protocol texts are taken as Leader's, anything else stays unclassified.
  const body = fact?.content ?? (input && input.kind === "message" ? input.body : "");
  if (isCoordinationText(body)) return { from: "leader", classLabel: "Leader" };
  return { from: "unknown", classLabel: null };
}

function sourceOf(turn: WorkspaceTurn | undefined, input: WorkspaceEntry | null, fact: MessageFact | null, me: string): { source: RoundSource; messageId: string | null; taskId: string | null } {
  const origin = turn?.origin ?? input?.origin ?? null;
  if (origin?.kind === "run") {
    // A Run is project dispatch even when the initiating actor is the reader (the Run record does not say who sent it as a person).
    return { source: { kind: "run", runId: origin.id, taskId: origin.taskId, by: "leader" }, messageId: null, taskId: origin.taskId };
  }
  const messageId = origin?.kind === "message" ? origin.id : input?.origin?.kind === "message" ? input.origin.id : null;
  if (messageId) {
    const { from, classLabel } = classify(input, fact, me);
    return { source: { kind: "message", messageId, from, classLabel }, messageId, taskId: fact?.context?.taskId ?? input?.origin?.taskId ?? null };
  }
  return { source: { kind: "none" }, messageId: null, taskId: null };
}

/** Whether a round's message is the Leader's coordination (folded to one line), as opposed to a person's or another agent's words. */
export const isCoordinationRound = (round: Round): boolean => round.source.kind === "message" && round.source.from === "leader";

function replyRecordOf(round: { body: WorkspaceEntry[]; fact: MessageFact | null }): ReplyFromRecord | null {
  const processing = round.fact?.processing;
  if (!processing || processing.responseKind !== "native" || !processing.response) return null;
  // A reply the timeline already shows is not repeated from the record.
  if (round.body.some(isReply)) return null;
  return { body: processing.response, truncated: round.fact?.responseTruncated === true, at: processing.updatedAt ?? null };
}

/**
 * Rounds in reading order. `entries` are the native entries in their record order (a Turn's entries stay together and in order);
 * `pending` are saved messages the native read did not show as inputs.
 */
export function buildRounds(entries: readonly WorkspaceEntry[], pending: readonly WorkspaceMessage[], turns: readonly Pick<WorkspaceTurn, "id" | "startedAt" | "origin">[], facts: RoundFacts): Round[] {
  const turnById = new Map(turns.map(turn => [turn.id, turn as WorkspaceTurn]));
  type Draft = { key: string; turnId: string | null; input: WorkspaceEntry | null; body: WorkspaceEntry[] };
  const drafts: Draft[] = [];
  const byTurn = new Map<string, Draft>();
  for (const entry of entries) {
    let draft = entry.turnId !== null ? byTurn.get(entry.turnId) : drafts.at(-1);
    if (!draft) {
      draft = { key: entry.turnId !== null ? `turn:${entry.turnId}` : `loose:${entry.id}`, turnId: entry.turnId, input: null, body: [] };
      drafts.push(draft);
      if (entry.turnId !== null) byTurn.set(entry.turnId, draft);
    }
    if (draft.input === null && isInput(entry)) draft.input = entry;
    else draft.body.push(entry);
  }
  const shownMessages = new Set(drafts.flatMap(draft => draft.input?.origin?.kind === "message" ? [draft.input.origin.id] : []));
  const saved: Draft[] = [];
  const entryIds = new Set(entries.map(entry => entry.id));
  for (const message of pending) {
    if (entryIds.has(message.id)) continue;
    const id = message.origin?.kind === "message" ? message.origin.id : null;
    if (id !== null && shownMessages.has(id)) continue;
    const draft = message.turnId !== null ? byTurn.get(message.turnId) : undefined;
    if (draft && draft.input === null) { draft.input = message; if (id !== null) shownMessages.add(id); continue; }
    saved.push({ key: `message:${id ?? message.id}`, turnId: null, input: message, body: [] });
  }

  const toRound = (draft: Draft): Round => {
    const turn = draft.turnId !== null ? turnById.get(draft.turnId) : undefined;
    const originId = turn?.origin?.kind === "message" ? turn.origin.id : draft.input?.origin?.kind === "message" ? draft.input.origin.id : null;
    const fact = originId ? facts.messages.get(originId) ?? null : null;
    const { source, messageId, taskId } = sourceOf(turn, draft.input, fact, facts.me);
    const nativeBound = draft.input?.nativeItemId != null;
    const sentAt = fact?.createdAt ?? (draft.input && !nativeBound && source.kind === "message" ? draft.input.occurredAt : null);
    const processingStart = fact?.processing?.startedAt ?? (nativeBound ? draft.input?.occurredAt ?? null : null);
    const round: Round = { key: draft.key, turnId: draft.turnId, at: null, source, messageId, input: draft.input, body: draft.body, sentAt,
      startedAt: source.kind === "message" ? processingStart : turn?.startedAt ?? null, replyRecord: null, taskId, fact };
    round.replyRecord = replyRecordOf(round);
    const firstTimed = draft.body.find(entry => entry.occurredAt !== null)?.occurredAt ?? null;
    round.at = draft.turnId !== null ? turn?.startedAt ?? processingStart ?? firstTimed ?? sentAt : sentAt ?? draft.input?.occurredAt ?? null;
    return round;
  };

  const nativeRounds = drafts.map(toRound);
  // The native order is the true order; times only place the saved rounds between native ones. Make the native times non-decreasing
  // (a Turn with no time takes its neighbour's) so a merge by time cannot reorder native rounds.
  const times: Array<number | null> = nativeRounds.map(round => ms(round.at));
  let floor = -Infinity;
  const mono = times.map(time => { if (time !== null && time > floor) floor = time; return floor; });
  const firstKnown = times.find(time => time !== null) ?? null;
  const effective = mono.map(time => time === -Infinity ? firstKnown ?? -Infinity : time);
  const savedRounds = saved.map(toRound).map((round, index) => ({ round, index, time: ms(round.at) }))
    .sort((a, b) => a.time === null || b.time === null ? a.index - b.index : a.time - b.time || a.index - b.index);
  const result: Round[] = [];
  let next = 0;
  const timed = savedRounds.filter(item => item.time !== null), untimed = savedRounds.filter(item => item.time === null);
  for (const item of timed) {
    // A native round that starts no later than this saved message came first.
    while (next < nativeRounds.length && effective[next]! <= item.time!) result.push(nativeRounds[next++]!);
    result.push(item.round);
  }
  while (next < nativeRounds.length) result.push(nativeRounds[next++]!);
  for (const item of untimed) result.push(item.round);
  return result;
}

/** Entries of all rounds in display order, for what reads the flat list (queue area, grant notice, turn summaries). */
export const roundEntries = (rounds: readonly Round[]): WorkspaceEntry[] => rounds.flatMap(round => round.input ? [round.input, ...round.body] : round.body);

export type TimelineRow =
  | { kind: "round"; round: Round }
  /** Three or more Leader coordination messages in a row with nothing between them. */
  | { kind: "coordination-group"; id: string; rounds: Round[] };

/** Rows in order: runs of three or more Leader messages with nothing after them (no reply, no work) become one group. */
export function timelineRows(rounds: readonly Round[]): TimelineRow[] {
  const bare = (round: Round) => isCoordinationRound(round) && round.body.length === 0 && round.replyRecord === null;
  const rows: TimelineRow[] = [];
  for (let index = 0; index < rounds.length;) {
    let end = index;
    while (end < rounds.length && bare(rounds[end]!)) end++;
    if (end - index >= 3) { rows.push({ kind: "coordination-group", id: `group:${rounds[index]!.key}`, rounds: rounds.slice(index, end) }); index = end; continue; }
    rows.push({ kind: "round", round: rounds[index]! }); index++;
  }
  return rows;
}

const shorten = (text: string, max: number) => text.length > max ? `${text.slice(0, max - 1)}…` : text;

export interface CoordinationSummary { type: string; title: string; at: string | null }
/** "类型 · 任务标题 · 时间": what the one folded line says. The text behind it is not changed. */
export function coordinationSummary(round: Round, titleOf: (taskId: string) => string | null): CoordinationSummary {
  const body = round.fact?.content ?? (round.input && round.input.kind === "message" ? round.input.body : "");
  const first = body.split("\n")[0]?.trim() ?? "";
  const kind = queuedMessageSummary(body);
  const type = first.startsWith("Session 队伍轮到任务「") ? "执行确认请求" : first.startsWith("Session 队伍排到了") ? "派发通知" : kind.label ?? "Leader 消息";
  const named = /^Session 队伍(?:轮到任务「|排到了：按固定 Task 修订 \S+ 执行「)([^」]+)」/.exec(first)?.[1] ?? null;
  const taskId = round.taskId ?? kind.taskId;
  const title = (taskId ? titleOf(taskId) : null) ?? named ?? (kind.label ? "" : shorten(first, 40));
  return { type, title: title || "（没有任务名）", at: round.sentAt ?? round.at };
}

/** The id of the last reply in reading order (a native reply or one from a record); where opening an agent lands. Null when nothing was answered. */
export function lastReplyId(rounds: readonly Round[]): string | null {
  for (let index = rounds.length - 1; index >= 0; index--) {
    const round = rounds[index]!;
    if (round.replyRecord) return `reply:${round.key}`;
    const reply = [...round.body].reverse().find(isReply);
    if (reply) return reply.id;
  }
  return null;
}
