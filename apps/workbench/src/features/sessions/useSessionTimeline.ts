import { useCallback, useEffect, useRef, useState } from "react";
import type { SessionTimelinePage, WorkspaceEntry, WorkspaceLiveRead, WorkspaceMessage, WorkspaceTurn } from "@evoloop/contracts/session-timeline";
import { ApiError, errorText } from "../../shared/api";
import { sessionClient } from "../../shared/sessionClient";
import { mergeWorkspaceEntries, mergeWorkspaceTurns, workspaceEntryKey } from "./workspaceTimelineModel";
import { describeLimitation } from "./readingScopePresentation";

/** A limitation for an error line, in Chinese; `fallback` when the service gave none. */
const limitationSentence = (raw: string | null | undefined, fallback: string) => (raw && describeLimitation(raw).text) || fallback;

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
function rememberRead(read: Read) {
  recentReads.delete(read.scope); recentReads.set(read.scope, read);
  while (recentReads.size > 2) recentReads.delete(recentReads.keys().next().value!);
}
let readCacheGeneration = 0;
export function clearSessionTimelineReads() { readCacheGeneration++; recentReads.clear(); }
const retainedRead = (scope: string) => {
  const saved = recentReads.get(scope);
  return saved ? { ...saved, entries: saved.entries.map(entry => entry.freshness === "live" ? { ...entry, freshness: "stale" as const } : entry),
    live: saved.live ? { ...saved.live, freshness: "stale" as const } : null } : empty(scope);
};

export function useSessionTimeline(token: string, projectId: string, actorId: string, sessionKey: string, refreshVersion = 0, reauthorizeVersion = 0) {
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
  const revoked = useRef(state.scope === scope && state.denied);
  const authorizationEpoch = useRef(0);
  const authorizationScope = useRef(scope);
  const explicitRead = useRef({ scope, version: reauthorizeVersion });
  const cacheGeneration = useRef(readCacheGeneration);
  const stateAuthorizationEpoch = authorizationEpoch.current;
  useEffect(() => { cacheGeneration.current = readCacheGeneration; }, [scope]);
  useEffect(() => {
    if (cacheGeneration.current !== readCacheGeneration || state.scope !== current.current || revoked.current
      || stateAuthorizationEpoch !== authorizationEpoch.current) return;
    if (!state.loaded) return;
    rememberRead(state);
  }, [state]);

  const revoke = useCallback((cause: unknown, requestEpoch: number) => {
    if (current.current !== scope || authorizationEpoch.current !== requestEpoch || cacheGeneration.current !== readCacheGeneration) return;
    const deniedEpoch = ++authorizationEpoch.current;
    revoked.current = true;
    historyEpoch.current++; historyRequest.current?.abort(); setMoreBusy(false);
    const denied = { ...empty(scope), loaded: true, error: errorText(cause), denied: true };
    // Retain an empty denial across remounts; stale queued effects must not refill it.
    rememberRead(denied);
    setState(old => current.current === scope && authorizationEpoch.current === deniedEpoch && revoked.current ? denied : old);
  }, [scope]);

  useEffect(() => {
    const controller = new AbortController();
    const client = sessionClient(token, projectId);
    let disposed = false, latestBusy = false, updatesBusy = false;
    let liveCursor = latest.current.scope === scope ? latest.current.updatesCursor ?? undefined : undefined;
    let resetPending = latest.current.scope === scope && latest.current.reconciling;
    let resetEpoch = 0, updateRevision = 0;
    let mayStream = false;
    if (authorizationScope.current !== scope) {
      authorizationScope.current = scope; revoked.current = retainedRead(scope).denied;
    }
    const explicitlyReread = explicitRead.current.scope === scope && explicitRead.current.version !== reauthorizeVersion;
    const reauthorizing = explicitlyReread && revoked.current;
    explicitRead.current = { scope, version: reauthorizeVersion };
    if (explicitlyReread) { revoked.current = false; if (reauthorizing) recentReads.delete(scope); }
    const requestAuthorizationEpoch = ++authorizationEpoch.current;
    historyEpoch.current++;
    setMoreBusy(false);
    const valid = () => !disposed && !controller.signal.aborted && current.current === scope;
    const authorized = () => valid() && !revoked.current && authorizationEpoch.current === requestAuthorizationEpoch
      && cacheGeneration.current === readCacheGeneration;
    setState(old => {
      if (!valid() || authorizationEpoch.current !== requestAuthorizationEpoch) return old;
      if (reauthorizing) return empty(scope);
      return revoked.current || old.scope !== scope ? retainedRead(scope) : old;
    });
    const failure = (cause: unknown) => {
      if (!authorized()) return;
      const forbidden = cause instanceof ApiError && (cause.status === 401 || cause.status === 403);
      if (forbidden) { revoke(cause, requestAuthorizationEpoch); return; }
      setState(old => authorized() ? ({ ...(old.scope !== scope ? empty(scope) : old), loaded: true, error: errorText(cause), denied: false,
        entries: old.scope !== scope ? [] : old.entries.map(entry => entry.freshness === "live" ? { ...entry, freshness: "stale" } : entry),
        live: old.scope === scope && old.live ? { ...old.live, freshness: "stale" } : null }) : old);
    };
    const readLatest = async (reset = false) => {
      if (!authorized() || latestBusy || document.visibilityState === "hidden") return;
      latestBusy = true;
      const requestEpoch = resetEpoch, requestUpdateRevision = updateRevision;
      let obsolete = false;
      try {
        const page = await client.timeline(sessionKey, {}, controller.signal);
        if (!authorized()) return;
        if (requestEpoch !== resetEpoch) { obsolete = true; return; }
        if (page.sessionKey !== sessionKey || !Array.isArray(page.entries) || !Array.isArray(page.pending)) throw new Error("活动响应与当前智能体不符");
        const rebasing = reset || resetPending;
        const committedReset = rebasing && page.capabilities.history;
        if (committedReset) {
          historyEpoch.current++; historyRequest.current?.abort(); historyRequest.current = null; setMoreBusy(false);
          resetPending = false;
        }
        if (!liveCursor || committedReset && requestUpdateRevision === updateRevision) liveCursor = page.live.cursor;
        mayStream = page.capabilities.live;
        setState(old => {
          if (!authorized() || requestEpoch !== resetEpoch) return old;
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
            error: resetPending ? `历史尚未完成校准：${limitationSentence(page.capabilities.reason || page.limitations[0], "原生历史暂不可读取")}` : "", denied: false };
        });
      } catch (cause) { failure(cause); }
      finally { latestBusy = false; if (obsolete && authorized() && resetPending) void readLatest(true); }
    };
    const readUpdates = async () => {
      if (!authorized() || !mayStream || updatesBusy || document.visibilityState === "hidden") return;
      updatesBusy = true;
      try {
        const live = await client.timelineUpdates(sessionKey, liveCursor, controller.signal);
        if (!authorized()) return;
        updateRevision++;
        liveCursor = live.cursor;
        if (live.resetRequired) {
          resetPending = true; resetEpoch++; historyEpoch.current++;
          historyRequest.current?.abort(); historyRequest.current = null; setMoreBusy(false);
        }
        setState(old => authorized() && old.scope === scope ? { ...old, entries: mergeWorkspaceEntries(old.entries
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
  }, [token, projectId, actorId, sessionKey, scope, reload, refreshVersion, reauthorizeVersion, revoke]);

  const loadMore = useCallback(async () => {
    const prior = latest.current;
    if (moreBusy || prior.reconciling || prior.scope !== scope || revoked.current || !prior.nextCursor && !prior.messagesCursor) return;
    const requestEpoch = historyEpoch.current;
    const requestAuthorizationEpoch = authorizationEpoch.current;
    const controller = new AbortController();
    historyRequest.current = controller;
    setMoreBusy(true);
    const client = sessionClient(token, projectId);
    const reads = [
      prior.nextCursor ? { source: "native" as const, cursor: prior.nextCursor } : null,
      prior.messagesCursor ? { source: "messages" as const, messagesCursor: prior.messagesCursor } : null,
    ].filter((value): value is NonNullable<typeof value> => value !== null);
    const results = await Promise.allSettled(reads.map(options => client.timeline(sessionKey, options, controller.signal)));
    const authorized = () => !controller.signal.aborted && current.current === scope && !revoked.current
      && historyEpoch.current === requestEpoch && authorizationEpoch.current === requestAuthorizationEpoch
      && cacheGeneration.current === readCacheGeneration;
    if (!authorized()) return;
    for (let index = 0; index < results.length; index++) {
      const result = results[index]!;
      if (result.status === "rejected") {
        const forbidden = result.reason instanceof ApiError && (result.reason.status === 401 || result.reason.status === 403);
        if (forbidden) { revoke(result.reason, requestAuthorizationEpoch); break; }
        setState(old => authorized() && old.scope === scope ? { ...old, error: errorText(result.reason) } : old);
        continue;
      }
      const page = result.value;
      if (page.sessionKey !== sessionKey || !Array.isArray(page.entries) || !Array.isArray(page.pending)) {
        setState(old => authorized() && old.scope === scope ? { ...old, error: "活动响应与当前智能体不符" } : old); continue;
      }
      const source = reads[index]!.source;
      if (source === "native" && !page.capabilities.history) {
        setState(old => authorized() && old.scope === scope ? { ...old, error: `历史尚未读完：${limitationSentence(page.limitations[0] || page.capabilities.reason, "原生来源暂不可读取")}` } : old);
        continue;
      }
      setState(old => authorized() && old.scope === scope ? { ...old,
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
  }, [token, projectId, sessionKey, scope, moreBusy, revoke]);

  const renderAuthorizationEpoch = authorizationEpoch.current;
  return { ...(state.scope === scope ? state : empty(scope)), moreBusy, loadMore,
    replaceEntry: (entry: WorkspaceEntry) => setState(old => current.current === scope && old.scope === scope && !old.denied
      && !revoked.current && authorizationEpoch.current === renderAuthorizationEpoch
      && cacheGeneration.current === readCacheGeneration
      ? { ...old, entries: mergeWorkspaceEntries(old.entries, [entry]) } : old),
    refresh: () => setReload(value => value + 1),
    reread: () => { if (current.current !== scope) return; authorizationEpoch.current++; revoked.current = false; recentReads.delete(scope); setState(empty(scope)); setReload(value => value + 1); } };
}
