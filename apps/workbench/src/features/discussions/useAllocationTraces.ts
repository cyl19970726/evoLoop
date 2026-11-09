// The relation reads that AllocationRelationsPanel and AllocationBacklinks shared line for line before #229 PR9h:
// one filter, page by page, rereading when the project change watcher (useAllocationChanges) says so. A reread keeps
// the last answer on screen; only a new filter or project starts empty.
import { useEffect, useRef, useState, type RefObject } from "react";
import { errorText } from "../../shared/api";
import type { MutationContext } from "../../shared/ActionForm";
import { allocationRelations, type AllocationFilter, type AllocationTrace } from "./allocationClient";
import { useAllocationChanges } from "./useAllocationChanges";

export function useAllocationTraces(context: MutationContext, filter: AllocationFilter, refresh: number,
  root: RefObject<HTMLElement | null>, noun: "关系" | "来源") {
  const [items, setItems] = useState<AllocationTrace[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [moreBusy, setMoreBusy] = useState(false);
  const [error, setError] = useState("");
  const [partial, setPartial] = useState(false);
  const [limitations, setLimitations] = useState<string[]>([]);
  const [observedAt, setObservedAt] = useState<string | null>(null);
  const [readAgain, setReadAgain] = useState(0);
  const epoch = useRef(0);
  const loadedScope = useRef("");
  const key = JSON.stringify(filter);
  const changesError = useAllocationChanges(context.token, context.projectId, root, () => setReadAgain(value => value + 1));
  useEffect(() => {
    const current = ++epoch.current, controller = new AbortController();
    const scope = `${context.token}\0${context.projectId}\0${key}`;
    if (loadedScope.current !== scope) {
      loadedScope.current = scope; setItems([]); setCursor(null); setPartial(false); setLimitations([]); setObservedAt(null);
    }
    setError(""); setLoading(true); setMoreBusy(false); setCursor(null);
    allocationRelations(context.token, context.projectId, filter, undefined, controller.signal)
      .then(page => {
        if (epoch.current !== current) return;
        if (page.resetRequired) throw new Error(`${noun}读取范围已变化，请重新读取。`);
        setItems(page.items); setCursor(page.nextCursor); setPartial(page.metadata.partial); setLimitations(page.metadata.limitations);
        setObservedAt(page.metadata.generatedAt);
      })
      .catch(cause => { if (epoch.current === current) setError(errorText(cause)); })
      .finally(() => { if (epoch.current === current) setLoading(false); });
    return () => { controller.abort(); if (epoch.current === current) epoch.current++; };
  }, [context.token, context.projectId, key, refresh, readAgain]); // `filter` is followed through `key`, its serialised form.
  async function more() {
    if (!cursor || moreBusy || loading) return;
    const current = epoch.current, previous = cursor;
    setMoreBusy(true); setError("");
    try {
      const page = await allocationRelations(context.token, context.projectId, filter, previous);
      if (epoch.current !== current) return;
      if (page.resetRequired) { setReadAgain(value => value + 1); return; }
      if (page.nextCursor === previous) throw new Error(`${noun}游标没有前进，请重新读取。`);
      setItems(before => [...new Map([...before, ...page.items].map(item => [item.id, item])).values()]);
      setCursor(page.nextCursor); setPartial(before => before || page.metadata.partial); setObservedAt(page.metadata.generatedAt);
      setLimitations(before => [...new Set([...before, ...page.metadata.limitations])]);
    } catch (cause) { if (epoch.current === current) setError(errorText(cause)); }
    finally { if (epoch.current === current) setMoreBusy(false); }
  }
  return { items, cursor, loading, moreBusy, error, partial, limitations, observedAt, readAgain, changesError, key,
    reread: () => setReadAgain(value => value + 1), more };
}
