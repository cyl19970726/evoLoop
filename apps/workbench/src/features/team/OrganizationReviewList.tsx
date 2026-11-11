import { useEffect, useState } from "react";
import type { Document } from "@evoloop/contracts";
import { api } from "../../shared/api";
import { Search } from "lucide-react";
import { Button, EmptyState, Notice, cn } from "@evoloop/ui";
import { date, href } from "../../shared/ui/shared";
import type { MutationContext } from "../../shared/ActionForm";
import { failureOf, type Failure } from "../../shared/errorPresentation";
import { ErrorDetails } from "../../shared/ui/ErrorDetails";

const statusLabel = { draft: "草稿", published: "已发布", archived: "已归档" };
export function OrganizationReviewList({ context, refresh }: { context: MutationContext; refresh: number }) {
  const { projectId, token } = context;
  const scope = JSON.stringify([projectId, token]);
  const [stored, setStored] = useState<{ scope: string; items: Document[] }>({ scope, items: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Failure | null>(null);
  const [query, setQuery] = useState("");
  const [readAgain, setReadAgain] = useState(0);
  const items = stored.scope === scope ? stored.items : [];
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    setLoading(true); setError(null); setQuery(""); setStored({ scope, items: [] });
    void (async () => {
      const rows = new Map<string, Document>(), cursors = new Set<string>();
      let cursor: string | undefined;
      do {
        const page = await api(token).documents(projectId, cursor, "organization_review", undefined, controller.signal);
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
    })().catch(cause => { if (active) setError(failureOf(cause)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; controller.abort(); };
  }, [projectId, token, scope, refresh, readAgain]);
  const visible = items.filter(item => item.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
    .sort((a, b) => Date.parse(b.organizationReview?.observedTo ?? b.updatedAt ?? "1970-01-01") -
      Date.parse(a.organizationReview?.observedTo ?? a.updatedAt ?? "1970-01-01") || a.id.localeCompare(b.id));
  const muted = "text-caption text-muted-foreground";
  return <section className="organization-reviews flex flex-col gap-3" aria-label="组织复盘文档" aria-busy={loading}>
    <div className="flex flex-wrap items-center gap-2">
      <label className="flex h-9 min-w-[220px] flex-1 items-center gap-2 rounded-full bg-field px-3 text-muted-foreground">
        <Search size={14} aria-hidden="true" />
        <input aria-label="搜索复盘文档" placeholder="搜索复盘标题" value={query} onChange={event => setQuery(event.target.value)} className="w-full bg-transparent text-small text-foreground outline-none" />
      </label>
      <Button size="compact" variant="ghost" disabled={loading} onClick={() => setReadAgain(value => value + 1)}>重新读取</Button>
      <a href={href(projectId, "documents")} className="text-small text-text-secondary hover:text-foreground">全部文档</a>
      <span className={cn(muted, "ml-auto")}>{loading ? "读取中…" : error ? `已读 ${items.length} 份，尚未完整` : `${items.length} 份文档`}</span>
    </div>
    {error && <Notice tone="error">复盘文档未完整读回：{error.text}<ErrorDetails failure={error} /></Notice>}
    {!loading && !error && !visible.length && (items.length
      ? <p className="text-small text-text-secondary">没有匹配的复盘文档。</p>
      : <EmptyState title="还没有组织复盘" reason="组织复盘保存为文档后会列在这里。报告已保存不等于建议已采纳。" />)}
    {visible.length > 0 && <ul aria-label="复盘文档" className="flex flex-col overflow-hidden rounded-xl bg-raised shadow-sm">{visible.map(item => <li key={item.id} className="border-t border-border first:border-t-0">
      <a href={href(projectId, "document", item.id, item.currentRevisionId)} className="flex flex-col gap-0.5 px-4 py-3 outline-none hover:bg-selected focus-visible:shadow-[var(--focus-ring)]">
        <span className="text-small font-medium text-foreground">{item.title}</span>
        <span className={muted}>{statusLabel[item.status]}
          {item.organizationReview ? ` · 观察 ${new Date(item.organizationReview.observedFrom).toLocaleString("zh-CN", { timeZone: item.organizationReview.timeZone })} 至 ${new Date(item.organizationReview.observedTo).toLocaleString("zh-CN", { timeZone: item.organizationReview.timeZone })}（${item.organizationReview.timeZone}）` : ""}
          {` · 提交 ${date(item.createdAt)} · 最近修订 ${date(item.updatedAt)}`}</span>
      </a>
    </li>)}</ul>}
  </section>;
}
