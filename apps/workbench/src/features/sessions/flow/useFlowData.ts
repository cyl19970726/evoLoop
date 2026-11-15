// The live data of 统筹安排 › 动态: the board snapshot, a window of recent events and the stream after them. Subscribes while the hook is
// mounted (the page is open) and not otherwise; reconnects by sequence number; a repeated or older event is dropped, so a reconnect
// neither loses nor repeats one. When the service says the position is gone, everything is read again.
import { useCallback, useEffect, useRef, useState } from "react";
import type { SchedEvent, WorkBoardSnapshot } from "@evoloop/contracts/work-board";
import { errorText } from "../../../shared/api";
import { readBoard, readWindow, streamEvents } from "./flowClient";

export type FlowConnection = "loading" | "live" | "reconnecting" | "failed";
export interface FlowData {
  board: WorkBoardSnapshot | null;
  /** Oldest first, by sequence number, no duplicates. */
  events: SchedEvent[];
  connection: FlowConnection;
  error: string;
  /** The window held more events than were read; the earliest part is missing. */
  truncated: boolean;
  /** The window the events were read for, in hours. */
  windowHours: number;
  /** The last sequence number applied (what a reconnect resumes after). */
  lastSeq: number;
  /** Reconnections since the page opened. */
  reconnects: number;
  reload(): void;
}
export const WINDOW_HOURS = 6;
const MAX_EVENTS = 5000;
const BOARD_DEBOUNCE_MS = 1500;

/** Merge by sequence number: ascending, one per number, the newest MAX_EVENTS kept. Exported for the tests. */
export function mergeEvents(have: SchedEvent[], incoming: SchedEvent[]): SchedEvent[] {
  if (!incoming.length) return have;
  const bySeq = new Map<number, SchedEvent>();
  for (const e of have) bySeq.set(e.seq, e);
  let changed = false;
  for (const e of incoming) if (!bySeq.has(e.seq)) { bySeq.set(e.seq, e); changed = true; }
  if (!changed) return have;
  const all = [...bySeq.values()].sort((a, b) => a.seq - b.seq);
  return all.length > MAX_EVENTS ? all.slice(all.length - MAX_EVENTS) : all;
}

export function useFlowData(token: string, projectId: string, enabled = true): FlowData {
  const [board, setBoard] = useState<WorkBoardSnapshot | null>(null);
  const [events, setEvents] = useState<SchedEvent[]>([]);
  const [connection, setConnection] = useState<FlowConnection>("loading");
  const [error, setError] = useState("");
  const [truncated, setTruncated] = useState(false);
  const [lastSeq, setLastSeq] = useState(0);
  const [reconnects, setReconnects] = useState(0);
  const [epoch, setEpoch] = useState(0);
  const reload = useCallback(() => setEpoch(value => value + 1), []);
  const seqRef = useRef(0);

  useEffect(() => {
    if (!enabled || !projectId) return;
    const controller = new AbortController(), { signal } = controller;
    let boardTimer: number | undefined;
    seqRef.current = 0; setConnection("loading"); setError(""); setEvents([]); setBoard(null);
    const refreshBoard = () => {
      window.clearTimeout(boardTimer);
      boardTimer = window.setTimeout(() => { void readBoard(token, projectId, signal).then(value => { if (!signal.aborted) setBoard(value); }).catch(() => undefined); }, BOARD_DEBOUNCE_MS);
    };
    const apply = (event: SchedEvent) => {
      if (event.seq <= seqRef.current) return; // already applied: a reconnect repeats nothing
      seqRef.current = event.seq; setLastSeq(event.seq);
      setEvents(list => mergeEvents(list, [event]));
      refreshBoard();
    };
    const run = async () => {
      let attempt = 0;
      for (;;) {
        // Read the whole picture, then follow the stream from where the picture ends.
        try {
          const from = new Date(Date.now() - WINDOW_HOURS * 3600_000).toISOString();
          const snapshot = await readBoard(token, projectId, signal);
          const recent = await readWindow(token, projectId, from, signal);
          if (signal.aborted) return;
          if (recent.resetRequired) { await new Promise(done => window.setTimeout(done, 500)); continue; }
          setBoard(snapshot); setEvents(recent.items); setTruncated(recent.truncated);
          seqRef.current = Math.max(snapshot.eventSeq, recent.items.at(-1)?.seq ?? 0); setLastSeq(seqRef.current);
        } catch (cause) {
          if (signal.aborted) return;
          setConnection("failed"); setError(errorText(cause));
          await new Promise(done => window.setTimeout(done, Math.min(15000, 1000 * 2 ** attempt++)));
          continue;
        }
        let reset = false;
        // Follow the stream; when it drops, resume after the last number applied (the loop below), with a growing pause.
        for (;;) {
          const connectionAbort = new AbortController();
          try {
            await streamEvents(token, projectId, seqRef.current, AbortSignal.any([signal, connectionAbort.signal]), {
              onOpen: () => { setConnection("live"); setError(""); attempt = 0; },
              onEvent: apply, onReady: () => setConnection("live"),
              onReset: () => { reset = true; connectionAbort.abort(); },
            });
          } catch (cause) {
            if (signal.aborted) return;
            if (!reset) setError(errorText(cause)); // a reset aborts the connection on purpose
          }
          if (signal.aborted) return;
          if (reset) break;
          setConnection("reconnecting"); setReconnects(count => count + 1);
          await new Promise(done => window.setTimeout(done, Math.min(15000, 1000 * 2 ** attempt++)));
        }
      }
    };
    void run();
    return () => { controller.abort(); window.clearTimeout(boardTimer); };
  }, [token, projectId, enabled, epoch]);

  return { board, events, connection, error, truncated, windowHours: WINDOW_HOURS, lastSeq, reconnects, reload };
}
