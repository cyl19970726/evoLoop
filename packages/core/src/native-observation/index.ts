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
    next.connectionId = event.connectionId; next.currentTurn = null; next.items = []; next.plan = null; next.diff = null; next.usage = null; next.status = null;
  }
  const turnId = turnIdFor(event.method, params);
  if (event.method !== 'thread/status/changed') {
    if (!turnId) return null;
    if (event.method === 'turn/started' && next.currentTurn?.id !== turnId) {
      const startedAt = metric(object(params.turn)?.startedAt);
      // .164 carries native Unix seconds when known. Reject only strictly older starts; equal or null is inconclusive.
      if (next.currentTurn?.startedAt != null && startedAt != null && startedAt < next.currentTurn.startedAt) return null;
      next.currentTurn = { id: turnId, status: turnStatus(object(params.turn)?.status), source: null, startedAt, terminalObservedAt: null };
      next.items = []; next.plan = null; next.diff = null; next.usage = null;
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
  async apply(value: NativeObservationProjection): Promise<NativeObservationRecord> {
    return this.deps.uow.transaction(value.projectId, async tx => {
      const store = tx.nativeObservation; if (!store) throw new DomainError('NATIVE_OBSERVATION_UNAVAILABLE','Native observation persistence is unavailable');
      const session = await tx.getRuntimeSession(value.sessionId);
      if (!session || session.projectId !== value.projectId || session.state !== 'ready' || session.nativeThreadId !== value.threadId)
        throw new DomainError('SESSION_NOT_READY','Native observation requires an exact ready Session and Thread');
      const old = await store.get(value.projectId, value.sessionId);
      if (old?.freshness === 'live' && old.connectionId !== value.connectionId) throw new DomainError('OBSERVATION_CONNECTION','A newer live connection owns this Session');
      const source = value.currentTurn ? await tx.nativeInputs?.findSource(value.projectId,value.sessionId,value.currentTurn.id) ?? null : null;
      const record = bounded({ ...value, currentTurn: value.currentTurn ? { ...value.currentTurn, source } : null, version: (old?.version ?? 0) + 1 });
      const delta = usageDelta(old, value);
      if (delta && tx.usage) await tx.usage.addUsage(value.projectId, value.sessionId,
        this.deps.usageDay?.(value.observedAt) ?? value.observedAt.slice(0, 10), delta);
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

function usageDelta(previous: NativeObservationRecord | null,
  next: NativeObservationProjection): import("@evoloop/contracts").UsageDelta | null {
  if (!next.usage) return null;
  const after = next.usage.total;
  if (after.inputTokens === null || after.outputTokens === null) return null;
  // A replacement thread starts from zero: its first cumulative observation is a real delta, not a skip.
  const sameThread = previous?.threadId === next.threadId;
  const before = sameThread ? previous?.usage?.total ?? null : null;
  const inputTokens = after.inputTokens - (before?.inputTokens ?? 0);
  const outputTokens = after.outputTokens - (before?.outputTokens ?? 0);
  const cachedInputTokens = Math.max(0, (after.cachedInputTokens ?? 0) - (before?.cachedInputTokens ?? 0));
  if (inputTokens < 0 || outputTokens < 0 || inputTokens + outputTokens + cachedInputTokens === 0) return null;
  return { inputTokens, outputTokens, cachedInputTokens, costUsd: 0, costReported: false };
}
