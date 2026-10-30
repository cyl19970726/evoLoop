import { useEffect, useState } from "react";
import type { Document } from "@evoloop/contracts";
import { api, errorText } from "../api";
import { Alert, date, href } from "../ui/shared";
import type { MutationContext } from "../workflow/ActionForm";

const statusLabel = { draft: "草稿", published: "已发布", archived: "已归档" };
export function OrganizationReviewList({ context, refresh }: { context: MutationContext; refresh: number }) {
  const { projectId, token } = context;
  const scope = JSON.stringify([projectId, token]);
  const [stored, setStored] = useState<{ scope: string; items: Document[] }>({ scope, items: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [readAgain, setReadAgain] = useState(0);
  const items = stored.scope === scope ? stored.items : [];
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    setLoading(true); setError(""); setQuery(""); setStored({ scope, items: [] });
    void (async () => {
      const rows = new Map<string, Document>(), cursors = new Set<string>();
      let cursor: string | undefined;
      do {
        const page = await api(token).documents(projectId, cursor, "organization_review", controller.signal);
        if (!active) return;
        if (page.items.some(item => item.projectId !== projectId || item.kind !== "organization_review"))
          throw new Error("复盘列表返回了其他范围的文档");
        for (const item of page.items) rows.set(item.id, item);
        setStored({ scope, items: [...rows.values()] });
        if (page.nextCursor && (page.nextCursor === cursor || cursors.has(page.nextCursor)))
          throw new Error("文档分页没有前进，复盘列表尚未读全");
        cursor = page.nextCursor ?? undefined;
        if (cursor) cursors.add(cursor);
      } while (cursor);
    })().catch(cause => { if (active) setError(errorText(cause)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; controller.abort(); };
  }, [projectId, token, scope, refresh, readAgain]);
  const visible = items.filter(item => item.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
    .sort((a, b) => Date.parse(b.organizationReview?.observedTo ?? b.updatedAt ?? "1970-01-01") -
      Date.parse(a.organizationReview?.observedTo ?? a.updatedAt ?? "1970-01-01") || a.id.localeCompare(b.id));
  return <section className="organization-reviews" aria-label="组织复盘文档" aria-busy={loading}>
    <div className="page-title-row"><div><h2>组织复盘</h2><p className="lede">每轮复盘是一份完整文档。选择标题，直接阅读原件。</p></div>
      <a className="button-link" href={href(projectId, "documents")}>全部文档</a></div>
    <div className="list-surface">
      <div className="list-toolbar"><label className="search-field"><input aria-label="搜索复盘文档" placeholder="搜索复盘标题…" value={query} onChange={event => setQuery(event.target.value)} /></label>
        <button type="button" className="quiet" disabled={loading} onClick={() => setReadAgain(value => value + 1)}>重新读取</button>
        <span className="muted">{loading ? "读取中…" : error ? `已读 ${items.length} 份，尚未完整` : `${items.length} 份文档`}</span></div>
      {error && <Alert kind="error">复盘文档未完整读回：{error}</Alert>}
      {!loading && !error && !visible.length && <p className="list-message">{items.length ? "没有匹配的复盘文档。" : "Evo 保存组织复盘文档后，会出现在这里。"}</p>}
      {visible.length > 0 && <div className="table-wrap" role="region" aria-label="复盘文档列表，可横向查看" tabIndex={0}><table><thead><tr><th>复盘文档</th><th>观察期间</th><th>提交时间</th><th>最近修订</th></tr></thead>
        <tbody>{visible.map(item => <tr key={item.id}>
          <td><a className="doc-index-title" href={href(projectId, "document", item.id, item.currentRevisionId)}>{item.title}</a><small>{statusLabel[item.status]}</small></td>
          <td>{item.organizationReview ? <><span>{new Date(item.organizationReview.observedFrom).toLocaleString("zh-CN", { timeZone: item.organizationReview.timeZone })}</span><span>至 {new Date(item.organizationReview.observedTo).toLocaleString("zh-CN", { timeZone: item.organizationReview.timeZone })}</span><small>{item.organizationReview.timeZone}</small></> : "观察期间未登记"}</td>
          <td>{date(item.createdAt)}</td><td>{date(item.updatedAt)}</td>
        </tr>)}</tbody></table></div>}
    </div>
  </section>;
}
