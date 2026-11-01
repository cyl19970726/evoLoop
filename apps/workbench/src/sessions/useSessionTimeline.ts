import { useCallback, useEffect, useRef, useState } from "react";
import type { SessionTimelinePage, WorkspaceEntry, WorkspaceLiveRead, WorkspaceMessage, WorkspaceTurn } from "@evoloop/contracts/session-timeline";
import { ApiError, errorText } from "../api";
import { sessionClient } from "./client";
import { mergeWorkspaceEntries, mergeWorkspaceTurns, workspaceEntryKey } from "./workspaceTimelineModel";

type Read = {
  scope: string;
  loaded: boolean;
  entries: WorkspaceEntry[];
  pending: WorkspaceMessage[];
  turns: WorkspaceTurn[];
  nextCursor: string | null;
  messagesCursor: string | null;
  live: WorkspaceLiveRead | null;
  page: SessionTimelinePage | null;
  error: string;
  denied: boolean;
  reconciling: boolean;
  updatesCursor: string | null;
  nativeInitialized: boolean;
  nativeBoundary: string | null;
  messagesBoundary: string | null;
};
const empty = (scope: string): Read => ({ scope, loaded: false, entries: [], pending: [], turns: [], nextCursor: null, messagesCursor: null, live: null, page: null, error: "", denied: false, reconciling: false, updatesCursor: null, nativeInitialized: false, nativeBoundary: null, messagesBoundary: null });
const pendingMerge = (previous: WorkspaceMessage[], incoming: WorkspaceMessage[]) => mergeWorkspaceEntries(previous, incoming) as WorkspaceMessage[];
const recentReads = new Map<string, Read>();
let readCacheGeneration = 0;
export function clearSessionTimelineReads() { readCacheGeneration++; recentReads.clear(); }
const retainedRead = (scope: string) => {
  const saved = recentReads.get(scope);
  return saved ? { ...saved, entries: saved.entries.map(entry => entry.freshness === "live" ? { ...entry, freshness: "stale" as const } : entry),
    live: saved.live ? { ...saved.live, freshness: "stale" as const } : null } : empty(scope);
};

export function useSessionTimeline(token: string, projectId: string, actorId: string, sessionKey: string, refreshVersion = 0) {
  const scope = `${token}\0${projectId}\0${actorId}\0${sessionKey}`;
  const [state, setState] = useState<Read>(() => retainedRead(scope));
  const current = useRef(scope);
  current.current = scope;
  const latest = useRef(state);
  latest.current = state;
  const [reload, setReload] = useState(0);
  const [moreBusy, setMoreBusy] = useState(false);
  const historyRequest = useRef<AbortController | null>(null);
  const historyEpoch = useRef(0);
  const revoked = useRef(false);
  const cacheGeneration = useRef(readCacheGeneration);
  useEffect(() => { cacheGeneration.current = readCacheGeneration; }, [scope]);
  useEffect(() => {
    if (cacheGeneration.current !== readCacheGeneration) return;
    if (state.denied) { recentReads.delete(state.scope); return; }
    if (!state.loaded) return;
    recentReads.delete(state.scope); recentReads.set(state.scope, state);
    while (recentReads.size > 2) recentReads.delete(recentReads.keys().next().value!);
  }, [state]);

  useEffect(() => {
    const controller = new AbortController();
    const client = sessionClient(token, projectId);
    let disposed = false, latestBusy = false, updatesBusy = false;
    let liveCursor = latest.current.scope === scope ? latest.current.updatesCursor ?? undefined : undefined;
    let resetPending = latest.current.scope === scope && latest.current.reconciling;
    let resetEpoch = 0, updateRevision = 0;
    let mayStream = false;
    revoked.current = false;
    historyEpoch.current++;
    setMoreBusy(false);
    const valid = () => !disposed && !controller.signal.aborted && current.current === scope;
    setState(old => old.scope === scope ? old : retainedRead(scope));
    const failure = (cause: unknown) => {
      if (!valid()) return;
      const forbidden = cause instanceof ApiError && (cause.status === 401 || cause.status === 403);
      if (forbidden) { revoked.current = true; historyRequest.current?.abort(); }
      setState(old => ({ ...(forbidden || old.scope !== scope ? empty(scope) : old), loaded: true, error: errorText(cause), denied: forbidden,
        entries: forbidden || old.scope !== scope ? [] : old.entries.map(entry => entry.freshness === "live" ? { ...entry, freshness: "stale" } : entry),
        live: old.scope === scope && !forbidden && old.live ? { ...old.live, freshness: "stale" } : null }));
    };
    const readLatest = async (reset = false) => {
      if (!valid() || latestBusy || revoked.current || document.visibilityState === "hidden") return;
      latestBusy = true;
      const requestEpoch = resetEpoch, requestUpdateRevision = updateRevision;
      let obsolete = false;
      try {
        const page = await client.timeline(sessionKey, {}, controller.signal);
        if (!valid()) return;
        if (requestEpoch !== resetEpoch) { obsolete = true; return; }
        if (page.sessionKey !== sessionKey || !Array.isArray(page.entries) || !Array.isArray(page.pending)) throw new Error("活动响应与当前 Session 不符");
        const rebasing = reset || resetPending;
        const committedReset = rebasing && page.capabilities.history;
        if (committedReset) {
          historyEpoch.current++; historyRequest.current?.abort(); historyRequest.current = null; setMoreBusy(false);
          resetPending = false;
        }
        if (!liveCursor || committedReset && requestUpdateRevision === updateRevision) liveCursor = page.live.cursor;
        mayStream = page.capabilities.live;
        setState(old => {
          if (requestEpoch !== resetEpoch || current.current !== scope) return old;
          const prior = old.scope === scope && old.loaded ? old : empty(scope);
          const initializeNative = !prior.nativeInitialized && page.capabilities.history;
          const retained = prior.entries.map(entry => (rebasing || page.live.freshness !== "live") && entry.freshness === "live"
            ? { ...entry, freshness: "stale" as const } : entry);
          return { scope, loaded: true, entries: mergeWorkspaceEntries(mergeWorkspaceEntries(retained, page.entries), page.live.entries),
            pending: pendingMerge(prior.pending, page.pending), turns: mergeWorkspaceTurns(mergeWorkspaceTurns(prior.turns, page.turns), page.live.turns),
            nextCursor: initializeNative || committedReset ? page.nextCursor : prior.nextCursor,
            messagesCursor: !prior.loaded || committedReset ? page.messagesCursor : prior.messagesCursor,
            nativeInitialized: prior.nativeInitialized || page.capabilities.history,
            nativeBoundary: initializeNative || committedReset ? (page.entries[0] ? workspaceEntryKey(page.entries[0]) : null) : prior.nativeBoundary,
            messagesBoundary: !prior.loaded || committedReset ? (page.entries[0] ? workspaceEntryKey(page.entries[0]) : null) : prior.messagesBoundary,
            live: page.live, page, updatesCursor: liveCursor ?? null, reconciling: resetPending,
            error: resetPending ? `历史尚未完成校准：${page.capabilities.reason || page.limitations[0] || "原生历史暂不可读取"}` : "", denied: false };
        });
      } catch (cause) { failure(cause); }
      finally { latestBusy = false; if (obsolete && valid() && resetPending) void readLatest(true); }
    };
    const readUpdates = async () => {
      if (!valid() || !mayStream || updatesBusy || revoked.current || document.visibilityState === "hidden") return;
      updatesBusy = true;
      try {
        const live = await client.timelineUpdates(sessionKey, liveCursor, controller.signal);
        if (!valid()) return;
        updateRevision++;
        liveCursor = live.cursor;
        if (live.resetRequired) {
          resetPending = true; resetEpoch++; historyEpoch.current++;
          historyRequest.current?.abort(); historyRequest.current = null; setMoreBusy(false);
        }
        setState(old => old.scope === scope ? { ...old, entries: mergeWorkspaceEntries(old.entries
          .map(entry => (live.resetRequired || live.freshness !== "live") && entry.freshness === "live" ? { ...entry, freshness: "stale" as const } : entry), live.entries),
          turns: mergeWorkspaceTurns(old.turns, live.turns), live, updatesCursor: live.cursor,
          reconciling: resetPending, error: resetPending ? old.error : "" } : old);
        if (resetPending) await readLatest(true);
      } catch (cause) { failure(cause); }
      finally { updatesBusy = false; }
    };
    void readLatest();
    const updatesTimer = window.setInterval(() => void readUpdates(), 1500);
    const latestTimer = window.setInterval(() => void readLatest(), 15000);
    const visible = () => { if (document.visibilityState === "visible") void readLatest(); };
    document.addEventListener("visibilitychange", visible);
    return () => { disposed = true; controller.abort(); historyRequest.current?.abort(); window.clearInterval(updatesTimer); window.clearInterval(latestTimer); document.removeEventListener("visibilitychange", visible); };
  }, [token, projectId, actorId, sessionKey, scope, reload, refreshVersion]);

  const loadMore = useCallback(async () => {
    const prior = latest.current;
    if (moreBusy || prior.reconciling || prior.scope !== scope || revoked.current || !prior.nextCursor && !prior.messagesCursor) return;
    const requestEpoch = historyEpoch.current;
    const controller = new AbortController();
    historyRequest.current = controller;
    setMoreBusy(true);
    const client = sessionClient(token, projectId);
    const reads = [
      prior.nextCursor ? { source: "native" as const, cursor: prior.nextCursor } : null,
      prior.messagesCursor ? { source: "messages" as const, messagesCursor: prior.messagesCursor } : null,
    ].filter((value): value is NonNullable<typeof value> => value !== null);
    const results = await Promise.allSettled(reads.map(options => client.timeline(sessionKey, options, controller.signal)));
    if (controller.signal.aborted || current.current !== scope || revoked.current || historyEpoch.current !== requestEpoch) return;
    for (let index = 0; index < results.length; index++) {
      const result = results[index]!;
      if (result.status === "rejected") {
        const forbidden = result.reason instanceof ApiError && (result.reason.status === 401 || result.reason.status === 403);
        if (forbidden) { revoked.current = true; setState({ ...empty(scope), loaded: true, error: errorText(result.reason), denied: true }); break; }
        setState(old => old.scope === scope ? { ...old, error: errorText(result.reason) } : old);
        continue;
      }
      const page = result.value;
      if (page.sessionKey !== sessionKey || !Array.isArray(page.entries) || !Array.isArray(page.pending)) {
        setState(old => old.scope === scope ? { ...old, error: "活动响应与当前 Session 不符" } : old); continue;
      }
      const source = reads[index]!.source;
      if (source === "native" && !page.capabilities.history) {
        setState(old => old.scope === scope ? { ...old, error: `历史尚未读完：${page.limitations[0] || page.capabilities.reason || "原生来源暂不可读取"}` } : old);
        continue;
      }
      setState(old => old.scope === scope && historyEpoch.current === requestEpoch ? { ...old,
        entries: mergeWorkspaceEntries(old.entries, page.entries, true, source === "native" ? prior.nativeBoundary : prior.messagesBoundary),
        pending: pendingMerge(old.pending, page.pending),
        turns: mergeWorkspaceTurns(old.turns, page.turns),
        nextCursor: source === "native" ? page.nextCursor : old.nextCursor,
        messagesCursor: source === "messages" ? page.messagesCursor : old.messagesCursor,
        nativeBoundary: source === "native" && page.entries[0] ? workspaceEntryKey(page.entries[0]) : old.nativeBoundary,
        messagesBoundary: source === "messages" && page.entries[0] ? workspaceEntryKey(page.entries[0]) : old.messagesBoundary,
      } : old);
    }
    if (current.current === scope) setMoreBusy(false);
  }, [token, projectId, sessionKey, scope, moreBusy]);

  return { ...(state.scope === scope ? state : empty(scope)), moreBusy, loadMore,
    replaceEntry: (entry: WorkspaceEntry) => setState(old => old.scope === scope && !old.denied
      ? { ...old, entries: mergeWorkspaceEntries(old.entries, [entry]) } : old),
    refresh: () => setReload(value => value + 1),
    reread: () => { revoked.current = false; recentReads.delete(scope); setState(empty(scope)); setReload(value => value + 1); } };
}
