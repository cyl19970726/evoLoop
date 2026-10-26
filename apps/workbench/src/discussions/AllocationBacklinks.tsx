import { useEffect, useRef, useState } from "react";
import { errorText } from "../api";
import type { MutationContext } from "../workflow/ActionForm";
import { allocationRelations, type AllocationFilter, type AllocationTrace } from "./allocationClient";
import { useAllocationChanges } from "./useAllocationChanges";
import { date } from "../ui/shared";
import { groupAllocationBacklinks, loadedBacklinkSummary } from "./allocationBacklinkGroups";
import { AllocationTraceCard } from "./AllocationRelationsPanel";
import { useAllocationNames, type AllocationKnownNames } from "./useAllocationNames";

const noKnownNames: AllocationKnownNames = { tasks: [], roles: [], documents: [] };

export function AllocationBacklinks({ context, filter, refresh }: { context: MutationContext; filter: AllocationFilter; refresh: number }) {
  const [items, setItems] = useState<AllocationTrace[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [partial, setPartial] = useState(false);
  const [limitations, setLimitations] = useState<string[]>([]);
  const [observedAt, setObservedAt] = useState<string | null>(null);
  const [readAgain, setReadAgain] = useState(0);
  const epoch = useRef(0);
  const root = useRef<HTMLElement>(null);
  const loadedScope = useRef("");
  const key = JSON.stringify(filter);
  const names = useAllocationNames(context.token, context.projectId, items, noKnownNames, !loading && !error,
    `${key}\0${refresh}\0${readAgain}`);
  const groups = groupAllocationBacklinks(items);
  const changesError = useAllocationChanges(context.token, context.projectId, root, () => setReadAgain(value => value + 1));
  useEffect(() => {
    const current = ++epoch.current, controller = new AbortController();
    const scope = `${context.token}\0${context.projectId}\0${key}`;
    if (loadedScope.current !== scope) {
      loadedScope.current = scope; setItems([]); setCursor(null); setPartial(false); setLimitations([]); setObservedAt(null);
    }
    setError(""); setLoading(true); setBusy(false); setCursor(null);
    allocationRelations(context.token, context.projectId, filter, undefined, controller.signal)
      .then(page => {
        if (epoch.current !== current) return;
        if (page.resetRequired) throw new Error("来源读取范围已变化，请重新读取。");
        setItems(page.items); setCursor(page.nextCursor); setPartial(page.metadata.partial); setLimitations(page.metadata.limitations);
        setObservedAt(page.metadata.generatedAt);
      })
      .catch(cause => { if (epoch.current === current) setError(errorText(cause)); })
      .finally(() => { if (epoch.current === current) setLoading(false); });
    return () => { controller.abort(); if (epoch.current === current) epoch.current++; };
  }, [context.token, context.projectId, key, refresh, readAgain]);
  async function more() {
    if (!cursor || busy || loading) return;
    const current = epoch.current, previous = cursor;
    setBusy(true); setError("");
    try {
      const page = await allocationRelations(context.token, context.projectId, filter, previous);
      if (epoch.current !== current) return;
      if (page.resetRequired) { setReadAgain(value => value + 1); return; }
      if (page.nextCursor === previous) throw new Error("来源游标没有前进，请重新读取。");
      setItems(before => [...new Map([...before, ...page.items].map(item => [item.id, item])).values()]);
      setCursor(page.nextCursor); setPartial(before => before || page.metadata.partial); setObservedAt(page.metadata.generatedAt);
      setLimitations(before => [...new Set([...before, ...page.metadata.limitations])]);
    } catch (cause) { if (epoch.current === current) setError(errorText(cause)); }
    finally { if (epoch.current === current) setBusy(false); }
  }
  return <section ref={root} className="allocation-backlinks" aria-label="正式分工讨论来源"><h3>正式分工讨论来源</h3>
    <p className="muted">仅按正式行动链接及同修订接受记录反查；相同职责下的其他会话不会自动计入。</p>
    <button type="button" disabled={loading} onClick={() => setReadAgain(value => value + 1)}>重新读取来源</button>
    {observedAt && <p className="muted">来源读于 {date(observedAt)}；变化检查失败时保留此读数。</p>}
    {loading && <p>正在读取来源…{observedAt && "下方为上次读数。"}</p>}
    {changesError && <p role="status">{changesError}</p>}
    {error && <p role="alert">来源暂不可读：{error}。不能据此判断没有关联。</p>}
    {partial && <p role="status">来源读取不完整，以下仅为已见部分。</p>}
    {limitations.length > 0 && <details><summary>来源限制 · {limitations.length} 项</summary><ul>{limitations.map(item => <li key={item}>{item}</li>)}</ul></details>}
    {!loading && !error && !items.length && <p className="muted">{partial
      ? "来源读取不完整，暂不能判断是否有关联。"
      : cursor ? "当前页没有来源；后续页面尚未读完。" : "尚无可确认的正式分工讨论来源。"}</p>}
    <ul className="allocation-backlink-groups">{groups.map(group => <li key={group.discussion.id}>
      <a href={`#/p/${encodeURIComponent(context.projectId)}/discussions?discussion=${encodeURIComponent(group.discussion.id)}`}>{group.discussion.title || "分工讨论"}</a>
      <small>{loadedBacklinkSummary(group, Boolean(cursor || partial))}</small>
      <details><summary>展开 {group.traces.length} 条具体关系</summary>
        <p className="muted">讨论 ID <code>{group.discussion.id}</code> · 当前读到版本 v{group.discussion.version}；下列关系各有固定来源。</p>
        <div className="allocation-backlink-relations">{group.traces.map(trace => <AllocationTraceCard key={trace.id} trace={trace} projectId={context.projectId} names={names} />)}</div>
      </details>
    </li>)}</ul>
    {cursor && <button type="button" disabled={busy || loading} onClick={() => void more()}>{busy ? "读取中…" : "加载更多来源"}</button>}
  </section>;
}
