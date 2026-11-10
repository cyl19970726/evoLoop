// The inner rail's object list on the document pages (docs/frontend/layout.md 内层上下文栏): a 文档 / 知识 switch,
// search and filters, the loaded documents with the open one highlighted, and what the list covers. A document opened
// here is remembered like one opened from the table, so the table puts focus back on that row on return.
import { useEffect, useRef } from "react";
import { ReadingSpaceSwitch } from "../../shared/ui/ReadingSpaceSwitch";
import { Button, ListRow, RefreshingIndicator } from "@evoloop/ui";
import { href } from "../../shared/routes";
import { ContextRailContent } from "../../shared/ui/ContextRail";
import { DocumentFilters } from "./DocumentFilters";
import { coverageText, emptyListText, kindText, lifecycleLabel } from "./documentPresentation";
import { useDocumentListState } from "./documentListState";
import { useDocumentList } from "./useDocumentList";

export function DocumentRail({ projectId, scope, selectedId }: { projectId: string; scope: string; selectedId?: string }) {
  return <ContextRailContent><DocumentRailList projectId={projectId} scope={scope} selectedId={selectedId} /></ContextRailContent>;
}

function DocumentRailList({ projectId, scope, selectedId }: { projectId: string; scope: string; selectedId?: string }) {
  const [state, update] = useDocumentListState(scope);
  const list = useDocumentList(projectId, state, update);
  const listRef = useRef<HTMLUListElement>(null);
  const shown = list.visible.length;
  // Coming back to the list keeps the open document in view.
  useEffect(() => {
    if (!selectedId) return;
    listRef.current?.querySelector<HTMLElement>(`[data-document-id="${CSS.escape(selectedId)}"]`)?.scrollIntoView({ block: "nearest" });
  }, [selectedId, shown]);
  const empty = emptyListText({ filtered: list.filtered, more: list.more });
  return <section data-ui="" aria-label="文档列表" className="flex flex-col gap-2.5 pb-2">
    <ReadingSpaceSwitch projectId={projectId} current="documents" className="mx-1" />
    <DocumentFilters state={state} update={update} />
    {list.error && <p role="alert" className="mx-1 rounded-md bg-danger-soft px-3 py-2 text-caption text-text-secondary">
      列表本次没有读回：{list.error}。{list.stale ? "下面是上次读回的列表，当前待核对。" : ""}
      <Button variant="link" className="ml-1 underline" onClick={() => void list.reread()}>重试</Button></p>}
    {list.pageError && <p role="alert" className="mx-1 rounded-md bg-danger-soft px-3 py-2 text-caption text-text-secondary">
      后面一页没有读回：{list.pageError}。已载入的仍可查看。
      {list.more && <Button variant="link" className="ml-1 underline" onClick={list.loadMore}>重试这一页</Button>}</p>}
    {list.loading && !list.error && <p role="status" className="mx-1 text-caption text-muted-foreground">正在读取文档…</p>}
    {!list.loading && !shown && !list.error && <div className="mx-1 rounded-md bg-muted px-3 py-2.5 text-caption text-text-secondary">
      <p className="font-medium text-foreground">{empty.title}</p><p className="mt-0.5">{empty.reason}</p></div>}
    {shown > 0 && <ul ref={listRef} className="flex flex-col gap-0.5">
      {list.visible.map(document => <li key={document.id} data-document-id={document.id}>
        <ListRow href={href(projectId, "document", document.id)} selected={document.id === selectedId}
          onSelect={() => update({ lastOpened: document.id })}
          title={<span title={document.title}>{document.title}</span>}
          meta={`${kindText(document.kind)} · ${lifecycleLabel[document.status]}`} />
      </li>)}
    </ul>}
    <div className="mx-1 flex flex-col gap-1.5 text-caption text-muted-foreground">
      <span>{coverageText({ loaded: list.items.length, matched: shown, filtered: list.filtered, more: list.more, coverage: list.coverage })}</span>
      {list.checking && <RefreshingIndicator label={list.filtered && state.query.trim() ? "正在搜索后续页面" : "正在核对列表"} />}
      {list.searchLimited && <span>搜索已自动读到上限，结果可能不完整；可以继续载入。</span>}
      {list.more && !list.pageError && <Button variant="secondary" size="compact" className="self-start" disabled={list.checking} onClick={list.loadMore}>载入更多</Button>}
    </div>
  </section>;
}
