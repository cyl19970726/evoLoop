// What a document's revision list covers, under the list (shared/documentRevisions.ts): being read, a failed first read,
// a failed reread kept as 上次读回, a later page that failed (or whose cursor the server refused: start again), more
// pages to read, and a document that changed since the first page (go back to it to see the newer revisions).
import { Button, Notice } from "@evoloop/ui";
import { errorText } from "../api";
import type { DocumentRevisionList } from "../useDocumentRevisions";

export function RevisionListStatus({ list, noun = "修订" }: { list: DocumentRevisionList; noun?: string }) {
  const { model } = list;
  return <>
    {list.reading && <p role="status" className="m-0 text-caption text-muted-foreground">正在读取{noun}列表…</p>}
    {list.failed && <Notice tone="error" action={<Button size="compact" variant="ghost" onClick={list.reread}>重新读取</Button>}>
      {noun}列表没有读回：{errorText(list.error)}。读回之前无法判断有哪些{noun}。</Notice>}
    {list.stale && <Notice tone="waiting" title="上次读回，当前待核对">{noun}列表重新读取失败：{errorText(list.error)}。</Notice>}
    {model?.moved && <Notice tone="waiting" action={<Button size="compact" variant="ghost" onClick={list.fromFirst}>回到第一页</Button>}>
      文档在读取期间有了变化，更新的{noun}在第一页；上面的状态已按最新读回的文档重算。</Notice>}
    {list.cursorRefused ? <Notice tone="waiting" action={<Button size="compact" variant="ghost" onClick={list.fromFirst}>从第一页重读</Button>}>
      后面的{noun}没有读到：读取位置已失效，要从第一页重读。</Notice>
      : list.pageFailed && <Notice tone="error">后面的{noun}没有读到：{errorText(list.error)}。已载入的仍可选。</Notice>}
    {model && <p className="m-0 flex flex-wrap items-center gap-2 text-caption text-muted-foreground">
      <span>共 {model.count} 版，已列出 {model.items.length} 版{list.more ? "" : "，已读完"}。</span>
      {list.more && !list.cursorRefused && <Button size="compact" variant="ghost" disabled={list.loadingMore} onClick={list.loadMore}>
        {list.loadingMore ? "正在读取…" : list.pageFailed ? `重新读取后面的${noun}` : `列出更早的${noun}`}</Button>}
    </p>}
  </>;
}
