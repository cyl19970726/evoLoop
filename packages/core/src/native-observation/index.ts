import type { NativeObservationEvent, NativeObservationProjection, NativeObservationRecord, NativeTurnUsage, NativeUsageBreakdown, NativeItemStatus, NativeTurnStatus, NativeStatus } from '@evoloop/contracts/native-observation';
import type { Clock, UnitOfWork } from '@evoloop/contracts/ports';
import { DomainError } from '@evoloop/contracts/ports';

const methods = new Set(['thread/status/changed','turn/started','turn/completed','item/started','item/completed','turn/plan/updated','turn/diff/updated','thread/tokenUsage/updated']);
const object = (x: unknown): Record<string, unknown> | null => x !== null && typeof x === 'object' && !Array.isArray(x) ? x as Record<string, unknown> : null;
const id = (x: unknown): x is string => typeof x === 'string' && x.length > 0 && x.length <= 1024;
const validTime = (x: string): boolean => Number.isFinite(Date.parse(x));
const bytes = (s: string): number => new TextEncoder().encode(s).byteLength;
function clip(value: string, limit: number): { value: string; truncated: boolean } {
  if (bytes(value) <= limit) return { value, truncated: false };
  let used = 0, result = '';
  for (const char of value) { const n = bytes(char); if (used + n > limit) break; result += char; used += n; }
  return { value: result, truncated: true };
}
const status = (x: unknown): NativeStatus | null => ['notLoaded','idle','systemError','active'].includes(String(x)) ? x as NativeStatus : null;
const turnStatus = (x: unknown): NativeTurnStatus => ['inProgress','completed','interrupted','failed'].includes(String(x)) ? x as NativeTurnStatus : 'unknown';
const itemStatus = (x: unknown): NativeItemStatus => ['inProgress','completed','failed','declined'].includes(String(x)) ? x as NativeItemStatus : 'inProgress';
const metric = (x: unknown): number | null => typeof x === 'number' && Number.isSafeInteger(x) && x >= 0 ? x : null;
function usageBreakdown(x: unknown): NativeUsageBreakdown {
  const v = object(x) ?? {};
  return { inputTokens: metric(v.inputTokens), cachedInputTokens: metric(v.cachedInputTokens), outputTokens: metric(v.outputTokens),
    reasoningOutputTokens: metric(v.reasoningOutputTokens), totalTokens: metric(v.totalTokens) };
}
function itemView(input: unknown, completed: boolean): NativeObservationRecord['items'][number] | null {
  const item = object(input); if (!item || !id(item.id) || !id(item.type)) return null;
  // The native item may contain full command text, tool arguments, outputs, or reasoning. Project only safe labels.
  if (!['commandExecution','fileChange','mcpToolCall','dynamicToolCall'].includes(item.type)) return null;
  let name = item.type === 'commandExecution' ? 'Command' : item.type === 'fileChange' ? 'File change' : 'Tool call';
  let truncated = false;
  if (item.type === 'mcpToolCall' || item.type === 'dynamicToolCall') {
    const tool = typeof item.tool === 'string' ? item.tool : '';
    const safeName = clip(tool, 240); name = safeName.value || 'Tool call'; truncated = safeName.truncated;
  }
  const nativeState = itemStatus(item.status);
  return { id: item.id, kind: item.type, name, status: completed && nativeState === 'inProgress' ? 'completed' : nativeState,
    summary: '', truncated };
}
function turnIdFor(method: string, params: Record<string, unknown>): string | null {
  if (method === 'turn/started' || method === 'turn/completed') return id(object(params.turn)?.id) ? object(params.turn)!.id as string : null;
  return id(params.turnId) ? params.turnId : null;
}
const TURN_USAGE_LIMIT = 24;
const usageKeys = ['inputTokens','cachedInputTokens','outputTokens','reasoningOutputTokens','totalTokens'] as const;
/** total - last, per field; null when either side is unknown or the difference is negative. */
function before(total: NativeUsageBreakdown, last: NativeUsageBreakdown): NativeUsageBreakdown {
  const out = {} as NativeUsageBreakdown;
  for (const key of usageKeys) { const a = total[key], b = last[key]; out[key] = a !== null && b !== null && a >= b ? a - b : null; }
  return out;
}
/** One Turn's own usage from its recorded Thread totals; null fields were not provable (no observed start, unknown or regressed totals). */
export function turnUsageOf(entry: NativeTurnUsage): NativeUsageBreakdown {
  const out = {} as NativeUsageBreakdown;
  for (const key of usageKeys) {
    const a = entry.total?.[key] ?? null, b = entry.base?.[key] ?? null;
    out[key] = a !== null && b !== null && a >= b ? a - b : null;
  }
  return out;
}
/**
 * A Turn's base (the Thread total before its first request) is provable only when this same connection saw the Turn's
 * `turn/started` and then its first usage notification: notifications on one connection arrive in order. A Turn whose
 * start was not seen here (restart or reconnect mid-Turn) keeps an unknown base, so its usage stays unknown rather than
 * a smaller, confident number.
 */
function markTurnStart(list: NativeTurnUsage[] | undefined, turnId: string, connectionId: string, at: string): NativeTurnUsage[] {
  const next = [...(list ?? [])];
  if (!next.some(entry => entry.turnId === turnId)) next.push({ turnId, base: null, total: null, startConnectionId: connectionId, observedAt: at });
  while (next.length > TURN_USAGE_LIMIT) next.shift();
  return next;
}
function recordTurnUsage(list: NativeTurnUsage[] | undefined, turnId: string, total: NativeUsageBreakdown, last: NativeUsageBreakdown,
  connectionId: string, at: string): NativeTurnUsage[] {
  const next = [...(list ?? [])];
  const index = next.findIndex(entry => entry.turnId === turnId);
  const entry = index >= 0 ? next[index]! : null;
  if (!entry) next.push({ turnId, base: null, total, startConnectionId: null, observedAt: at });
  else if (entry.total === null && entry.base === null && entry.startConnectionId === connectionId)
    next[index] = { ...entry, base: before(total, last), total, observedAt: at };
  else next[index] = { ...entry, total, observedAt: at };
  while (next.length > TURN_USAGE_LIMIT) next.shift();
  return next;
}
function bounded(value: NativeObservationRecord): NativeObservationRecord {
  // Fields are individually bounded; this guard handles long multibyte identifiers and future additions.
  // Older Turns' usage goes first, down to none: it never displaces the current Turn's item preview.
  while (bytes(JSON.stringify(value)) > 24576 && (value.turnUsage?.length ?? 0) > 0) value.turnUsage!.shift();
  while (bytes(JSON.stringify(value)) > 24576 && value.items.length) value.items.shift();
  if (bytes(JSON.stringify(value)) > 24576 && value.diff) { value.diff = { ...value.diff, ...{ text: '', truncated: true } }; }
  if (bytes(JSON.stringify(value)) > 24576) throw new DomainError('OBSERVATION_TOO_LARGE','Native observation exceeds storage limit');
  return value;
}
/** Pure, ordered-wire reducer for the supported .164 ServerNotification subset. Null means ignored. */
export function reduceNativeObservation(previous: NativeObservationRecord | null, event: NativeObservationEvent): NativeObservationRecord | null {
  if (!methods.has(event.method) || !id(event.threadId) || !id(event.sessionId) || !id(event.connectionId) || !id(event.projectId) || !validTime(event.observedAt)) return null;
  const params = object(event.params); if (!params || params.threadId !== event.threadId) return null;
  if (previous && (previous.projectId !== event.projectId || previous.sessionId !== event.sessionId || previous.threadId !== event.threadId)) return null;
  // A stale child connection cannot replace a new live projection.
  if (previous && previous.connectionId !== event.connectionId && previous.freshness === 'live') return null;
  const next: NativeObservationRecord = previous ? { ...previous, currentTurn: previous.currentTurn ? { ...previous.currentTurn } : null, items: [...previous.items] } : {
    projectId: event.projectId, sessionId: event.sessionId, threadId: event.threadId, connectionId: event.connectionId,
    version: 0, observedAt: event.observedAt, lastEventAt: event.observedAt, freshness: 'live', staleReason: null,
    status: null, currentTurn: null, items: [], plan: null, diff: null, usage: null };
  if (previous?.connectionId !== event.connectionId) {
    // `usage` is the Thread's cumulative reading, not a property of the old
    // connection. Keep it as a baseline so the next connection's first event
    // is recorded as a delta rather than the whole Thread again.
    next.connectionId = event.connectionId; next.currentTurn = null; next.items = []; next.plan = null; next.diff = null; next.status = null;
  }
  const turnId = turnIdFor(event.method, params);
  if (event.method !== 'thread/status/changed') {
    if (!turnId) return null;
    if (event.method === 'turn/started' && next.currentTurn?.id !== turnId) {
      const startedAt = metric(object(params.turn)?.startedAt);
      // .164 carries native Unix seconds when known. Reject only strictly older starts; equal or null is inconclusive.
      if (next.currentTurn?.startedAt != null && startedAt != null && startedAt < next.currentTurn.startedAt) return null;
      next.currentTurn = { id: turnId, status: turnStatus(object(params.turn)?.status), source: null, startedAt, terminalObservedAt: null };
      // The latest cumulative Thread reading remains the baseline for the
      // next notification. It is not reset at a Turn boundary.
      next.items = []; next.plan = null; next.diff = null;
    } else if (!next.currentTurn) {
      next.currentTurn = { id: turnId, status: 'unknown', source: null, startedAt: null, terminalObservedAt: null };
    } else if (next.currentTurn.id !== turnId) return null;
  }
  switch (event.method) {
    case 'thread/status/changed': { const s = status(object(params.status)?.type); if (!s) return null; next.status = s; break; }
    case 'turn/started': next.turnUsage = markTurnStart(previous?.turnUsage, turnId!, event.connectionId, event.observedAt);
      if (next.currentTurn?.status === 'unknown') next.currentTurn.status = turnStatus(object(params.turn)?.status);
      if (next.currentTurn && next.currentTurn.startedAt === null) next.currentTurn.startedAt = metric(object(params.turn)?.startedAt); break;
    case 'turn/completed': {
      const s = turnStatus(object(params.turn)?.status); if (s === 'unknown') return null;
      next.currentTurn!.status = s;
      next.currentTurn!.terminalObservedAt ??= event.observedAt; break;
    }
    case 'item/started': case 'item/completed': {
      const item = itemView(params.item, event.method === 'item/completed'); if (!item) return null;
      const found = next.items.findIndex(x => x.id === item.id);
      if (found >= 0) {
        const existing = next.items[found]!;
        if (existing.status !== 'inProgress' && item.status === 'inProgress') break;
        next.items.splice(found, 1);
      }
      next.items.push(item);
      if (next.items.length > 10) next.items.splice(0, next.items.length - 10);
      break;
    }
    case 'turn/plan/updated': {
      if (!Array.isArray(params.plan)) return null;
      const steps = params.plan.slice(0, 20).flatMap(x => {
        const v = object(x); if (!v || typeof v.step !== 'string' || !['pending','inProgress','completed'].includes(String(v.status))) return [];
        return [{ step: clip(v.step, 240).value, status: v.status as 'pending' | 'inProgress' | 'completed' }];
      });
      const explanation = typeof params.explanation === 'string' ? clip(params.explanation, 500) : null;
      next.plan = { turnId: turnId!, steps, explanation: explanation?.value ?? null,
        truncated: params.plan.length > 20 || !!explanation?.truncated || params.plan.some((x: unknown) => { const v = object(x); return typeof v?.step === 'string' && bytes(v.step) > 240; }), observedAt: event.observedAt };
      break;
    }
    case 'turn/diff/updated': {
      if (typeof params.diff !== 'string') return null;
      const diff = clip(params.diff, 8192);
      next.diff = { turnId: turnId!, text: diff.value, truncated: diff.truncated, observedAt: event.observedAt }; break;
    }
    case 'thread/tokenUsage/updated': {
      const v = object(params.tokenUsage); if (!v) return null;
      next.usage = { turnId: turnId!, total: usageBreakdown(v.total), last: usageBreakdown(v.last),
        modelContextWindow: metric(v.modelContextWindow), observedAt: event.observedAt };
      if (turnId) next.turnUsage = recordTurnUsage(previous?.turnUsage, turnId, next.usage.total, next.usage.last, event.connectionId, event.observedAt);
      break;
    }
  }
  next.lastEventAt = event.observedAt; next.observedAt = event.observedAt; next.freshness = 'live'; next.staleReason = null;
  return bounded(next);
}

export class NativeObservationService {
  constructor(private readonly deps: { uow: UnitOfWork; clock: Clock;
    /** Local day for the usage ledger; absent keeps canonical UTC. */
    usageDay?: (at: string) => string }) {}
  get(projectId: string, sessionId: string): Promise<NativeObservationRecord | null> {
    return this.deps.uow.read(projectId, r => r.nativeObservation?.get(projectId, sessionId) ?? Promise.resolve(null));
  }
  async apply(value: NativeObservationProjection,
    usageObserved: NonNullable<NativeObservationProjection["usage"]>[] = []): Promise<NativeObservationRecord> {
    return this.deps.uow.transaction(value.projectId, async tx => {
      const store = tx.nativeObservation; if (!store) throw new DomainError('NATIVE_OBSERVATION_UNAVAILABLE','Native observation persistence is unavailable');
      const session = await tx.getRuntimeSession(value.sessionId);
      if (!session || session.projectId !== value.projectId || session.state !== 'ready' || session.nativeThreadId !== value.threadId)
        throw new DomainError('SESSION_NOT_READY','Native observation requires an exact ready Session and Thread');
      const old = await store.get(value.projectId, value.sessionId);
      if (old?.freshness === 'live' && old.connectionId !== value.connectionId) throw new DomainError('OBSERVATION_CONNECTION','A newer live connection owns this Session');
      const source = value.currentTurn ? await tx.nativeInputs?.findSource(value.projectId,value.sessionId,value.currentTurn.id) ?? null : null;
      const readings = [...usageObserved];
      const last = readings.at(-1);
      if (value.usage && (!last || !sameReading(last, value.usage))) readings.push(value.usage);
      let prior: UsageSnapshot | null = old ? { threadId: old.threadId, usage: old.usage } : null;
      const delta = zeroUsageCounts();
      for (const usage of readings) {
        const added = usageDelta(prior, { ...value, usage });
        if (added) {
          delta.inputTokens += added.inputTokens;
          delta.outputTokens += added.outputTokens;
          delta.cachedInputTokens += added.cachedInputTokens;
        }
        prior = { threadId: value.threadId, usage };
      }
      if (delta.inputTokens + delta.outputTokens + delta.cachedInputTokens && tx.usage)
        await tx.usage.addUsage(value.projectId, value.sessionId,
          this.deps.usageDay?.(value.observedAt) ?? value.observedAt.slice(0, 10), { ...delta, costUsd: 0, costReported: false });
      // A Thread's cumulative usage is not a property of one connection or
      // event. An event without usage must not erase the last persisted baseline.
      const usage = value.usage ?? (old?.threadId === value.threadId ? old.usage : null);
      const record = bounded({ ...value, usage, currentTurn: value.currentTurn ? { ...value.currentTurn, source } : null,
        version: (old?.version ?? 0) + 1 });
      await store.upsert(record, old?.version ?? null); return record;
    });
  }
  async staleConnection(projectId: string, connectionId: string, reason: string): Promise<number> {
    return this.deps.uow.transaction(projectId, tx => tx.nativeObservation?.staleConnection(projectId, connectionId, clip(reason,240).value, this.deps.clock.now()) ?? Promise.resolve(0));
  }
  async invalidateConnections(projectId: string, currentConnectionId: string): Promise<number> {
    return this.deps.uow.transaction(projectId, tx => tx.nativeObservation?.invalidateConnections(projectId,currentConnectionId,this.deps.clock.now()) ?? Promise.resolve(0));
  }
  async refreshSource(projectId: string, sessionId: string): Promise<NativeObservationRecord | null> {
    return this.deps.uow.transaction(projectId, async tx => {
      const store = tx.nativeObservation; const old = await store?.get(projectId,sessionId);
      if (!old?.currentTurn || old.currentTurn.source) return old ?? null;
      const source = await tx.nativeInputs?.findSource(projectId,sessionId,old.currentTurn.id) ?? null;
      if (!source) return old;
      const next = { ...old, currentTurn: { ...old.currentTurn, source }, version: old.version + 1, observedAt: this.deps.clock.now() };
      await store!.upsert(next, old.version); return next;
    });
  }
}

type UsageSnapshot = Pick<NativeObservationRecord, 'threadId' | 'usage'>;

function sameReading(left: NonNullable<NativeObservationRecord['usage']>,
  right: NonNullable<NativeObservationRecord['usage']>): boolean {
  return left.observedAt === right.observedAt && left.turnId === right.turnId &&
    sameUsage(left.total, right.total) && sameUsage(left.last, right.last);
}

function usageDelta(previous: UsageSnapshot | null,
  next: NativeObservationProjection): import("@evoloop/contracts").UsageDelta | null {
  if (!next.usage) return null;
  const sameThread = previous?.threadId === next.threadId;
  const prior = sameThread ? previous?.usage ?? null : null;
  // The same reading at the same observedAt is one fact. Codex replay uses
  // the receiver time, so this only protects callers that preserve source time.
  if (prior && sameReading(next.usage, prior)) return null;
  // Ignore a caller-preserved older reading. This cannot identify Codex replay,
  // whose observedAt is the receive time rather than the original source time.
  if (prior && Date.parse(next.usage.observedAt) < Date.parse(prior.observedAt)) return null;

  const after = usageCounts(next.usage.total);
  const before = prior ? usageCounts(prior.total) : null;
  if (after && (!sameThread || !previous)) return positiveDelta(after, zeroUsageCounts());
  if (after && before) {
    const delta = subtractUsage(after, before);
    if (delta) return delta.inputTokens + delta.outputTokens + delta.cachedInputTokens === 0
      ? null : positiveDelta(delta, zeroUsageCounts());
    // A newer notification with a smaller cumulative counter is a reset (for
    // example after native compaction), so only this request's `last` is new.
    // Codex 0.167 replays only the latest persisted snapshot on attach
    // (request_processors/token_usage_replay.rs, conversation.token_usage_info);
    // it does not deliver an arbitrary historical TokenCount sequence here.
    const last = usageCounts(next.usage.last);
    return last ? positiveDelta(last, zeroUsageCounts()) : null;
  }
  // Compatibility only: v2 ThreadTokenUsage.total is non-optional
  // (app-server-protocol/src/protocol/v2/thread.rs). A repeated total-less
  // event cannot be distinguished from a new request and can overcount.
  const last = usageCounts(next.usage.last);
  return last ? positiveDelta(last, zeroUsageCounts()) : null;
}

interface UsageCounts {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
}

function usageCounts(value: NativeUsageBreakdown): UsageCounts | null {
  return value.inputTokens !== null && value.outputTokens !== null ? {
    inputTokens: value.inputTokens,
    outputTokens: value.outputTokens,
    cachedInputTokens: value.cachedInputTokens ?? 0,
  } : null;
}

function sameUsage(left: NativeUsageBreakdown, right: NativeUsageBreakdown): boolean {
  return usageKeys.every(key => left[key] === right[key]);
}

const zeroUsageCounts = (): UsageCounts => ({ inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 });

function subtractUsage(after: UsageCounts, before: UsageCounts): UsageCounts | null {
  if (after.inputTokens < before.inputTokens || after.outputTokens < before.outputTokens ||
    after.cachedInputTokens < before.cachedInputTokens) return null;
  return {
    inputTokens: after.inputTokens - before.inputTokens,
    outputTokens: after.outputTokens - before.outputTokens,
    cachedInputTokens: after.cachedInputTokens - before.cachedInputTokens,
  };
}

function positiveDelta(after: UsageCounts, before: UsageCounts): import("@evoloop/contracts").UsageDelta | null {
  const delta = subtractUsage(after, before);
  if (!delta || delta.inputTokens + delta.outputTokens + delta.cachedInputTokens === 0) return null;
  return { ...delta, costUsd: 0, costReported: false };
}
