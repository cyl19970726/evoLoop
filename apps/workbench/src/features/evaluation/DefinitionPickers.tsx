// The choosers of 建立冻结评价: a task by name, and fixed documents, Wiki pages and their versions by name. Each writes
// the plain value the definition form keeps (a task ID, or fixed-reference lines), so drafts, baselines and the command
// stay those of the shared command form; IDs, revisions and hashes are shown only under 完整标识.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { Document, DocumentDetail, DocumentRevision, EvaluationFixedRef, Page, Task } from "@evoloop/contracts";
import type { KnowledgeSummary } from "@evoloop/contracts/knowledge";
import { Button, Input, ListRow, Notice } from "@evoloop/ui";
import { api, errorText } from "../../shared/api";
import { knowledgeClient } from "../../shared/knowledgeClient";
import { useProjectList } from "../../shared/projectList";
import { fixedContent, projectQueryOptions, queryKeys, useProjectQuery } from "../../shared/query";
import { useTaskName } from "../../shared/ui/RecordName";
import { FullIdentifiers } from "../../shared/ui/FullIdentifiers";
import { date } from "../../shared/ui/shared";
import { nameOnly } from "../../shared/workPresentation";
import { documentFixedRef, documentVersionLabel, refRows, typedRef, wikiFixedRef, withRef, withoutRef, type ChoosableKind } from "./fixedRefChoice";
import { fixedRefKindLabels, fixedRefName, labelOf, taskStateLabels, verifiedFixedDocumentTitle } from "./presentation";

type Control = { id: string; "aria-describedby"?: string | undefined; "aria-invalid"?: boolean | undefined };
const muted = "m-0 text-caption text-muted-foreground";
const shown = 8;
const matches = (text: string, query: string) => text.toLocaleLowerCase("zh-CN").includes(query.trim().toLocaleLowerCase("zh-CN"));

/** What a list read so far allows saying about a search with no match. */
function Coverage({ count, noun, more, reading, failed, loadingMore, onMore, onRetry }: {
  count: number | null; noun: string; more: boolean; reading: boolean; failed: string; loadingMore: boolean; onMore(): void; onRetry(): void;
}) {
  if (failed && count === null) return <Notice tone="error">{noun}没有读回：{failed}。读回之前无法判断有哪些可选。<Button size="compact" variant="ghost" onClick={onRetry}>重新读取</Button></Notice>;
  if (count === null) return <p className={muted}>{reading ? `正在读取${noun}…` : `${noun}尚未读取。`}</p>;
  return <p className={`${muted} flex flex-wrap items-center gap-2`}>
    <span>已读 {count} 项{noun}{more ? "，还有后续" : "，已读完"}{failed ? `；后续读取失败：${failed}` : ""}。</span>
    {more && <Button size="compact" variant="ghost" disabled={loadingMore} onClick={onMore}>{loadingMore ? "读取中…" : "继续读取"}</Button>}
  </p>;
}

/** Reads a list again from its first page (a first read that failed). */
function useReread(projectId: string, key: readonly unknown[]) {
  const client = useQueryClient();
  return () => { void client.refetchQueries({ queryKey: queryKeys.project(projectId, ...key) }); };
}

function SearchBox({ control, value, onChange, placeholder }: { control?: Control | undefined; value: string; onChange(value: string): void; placeholder: string }) {
  return <Input {...control} type="search" value={value} placeholder={placeholder} autoComplete="off" onChange={event => onChange(event.target.value)} />;
}

/**
 * A task chosen by name. The loaded task pages are shared with the task list (same key); a search covers the pages
 * read so far and says so. `inProgressOnly`: only tasks in progress can be chosen (the common task of an evaluation).
 */
export function TaskChoice({ projectId, value, onChange, control, label, inProgressOnly = false, emptyText }: {
  projectId: string; value: string; onChange(taskId: string): void; control?: Control | undefined; label: string; inProgressOnly?: boolean; emptyText?: string;
}) {
  const [open, setOpen] = useState(!value);
  const [query, setQuery] = useState("");
  const name = useTaskName(projectId, value || null);
  const reread = useReread(projectId, ["tasks", "list"]);
  const list = useProjectList(projectId, ["tasks", "list"], (cursor, signal) => api().tasks(projectId, cursor, signal) as Promise<Page<Task>>,
    (task: Task) => task.id, { enabled: open });
  if (!open && value) return <div role="group" aria-label={label} className="flex min-w-0 flex-col gap-1">
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <span className="min-w-0 break-words text-small font-medium text-foreground">{nameOnly("任务", name)}</span>
      <Button size="compact" variant="ghost" onClick={() => setOpen(true)}>更换</Button>
    </div>
    <FullIdentifiers summary="完整标识" rows={[{ label: "任务", value }]} />
  </div>;
  const items = (list.items ?? []).filter(task => task.projectId === projectId && (!inProgressOnly || task.state === "in_progress"));
  const found = query.trim() ? items.filter(task => matches(task.title, query)) : items;
  return <div role="group" aria-label={label} className="flex min-w-0 flex-col gap-2">
    <SearchBox control={control} value={query} onChange={setQuery} placeholder="按任务名称搜索" />
    {inProgressOnly && <p className={muted}>只列出进行中的任务。</p>}
    {found.length > 0 && <ul aria-label="可选的任务" className="m-0 flex list-none flex-col gap-0.5 p-0">{found.slice(0, shown).map(task =>
      <li key={task.id}><ListRow title={task.title} meta={labelOf(taskStateLabels, task.state)} selected={task.id === value}
        onSelect={() => { onChange(task.id); setOpen(false); setQuery(""); }} /></li>)}</ul>}
    {found.length > shown && <p className={muted}>还有 {found.length - shown} 项匹配，请输入更多文字缩小范围。</p>}
    {list.items && !found.length && <p className={muted}>{query.trim() ? `已读的任务里没有名称包含“${query.trim()}”的${inProgressOnly ? "进行中" : ""}任务。` : emptyText ?? "已读的任务里没有可选的任务。"}</p>}
    <Coverage count={list.items ? list.items.length : null} noun="任务" more={list.more} reading={list.reading} loadingMore={list.loadingMore}
      failed={list.error ? errorText(list.error) : ""} onMore={list.loadMore} onRetry={reread} />
    {value && <Button size="compact" variant="ghost" className="w-fit" onClick={() => { setOpen(false); setQuery(""); }}>保留原来的任务</Button>}
  </div>;
}

/** A fixed reference by name and version, after the exact revision and hash were read back; never by its identifiers. */
function useRefName(projectId: string, ref: EvaluationFixedRef) {
  return useProjectQuery(projectId, ["evaluation-choice", "ref", ref.kind, ref.id, ref.revision, ref.contentHash], async (): Promise<{ name: string; version: string }> => {
    if (ref.kind === "document") {
      const [detail, fixed] = await Promise.all([api().document(projectId, ref.id), api().documentRevision(projectId, ref.id, ref.revision)]);
      const title = verifiedFixedDocumentTitle(ref, projectId, detail.document, fixed);
      if (!title) throw new Error("文档的固定修订与哈希没有核对上");
      return { name: `《${title}》`, version: documentVersionLabel(detail.document, fixed.id, date(fixed.createdAt)) };
    }
    const page = await knowledgeClient("", projectId).page(ref.id, ref.revision);
    if (!wikiFixedRef(projectId, ref.id, ref.revision, page) || page.contentHash !== ref.contentHash) throw new Error("Wiki 页的固定修订与哈希没有核对上");
    return { name: `《${page.title.trim() || "未命名的 Wiki 页"}》`, version: `${date(page.createdAt)} 的版本` };
  }, { enabled: ref.kind === "document" || ref.kind === "wiki" });
}

function RefRowView({ projectId, ref, onRemove }: { projectId: string; ref: EvaluationFixedRef; onRemove(): void }) {
  const read = useRefName(projectId, ref);
  const named = ref.kind === "document" || ref.kind === "wiki";
  const name = read.data?.name ?? fixedRefName(ref);
  const version = read.data?.version ?? (!named ? "固定修订" : read.isError ? "名称与版本未能核对，标识见完整标识" : "正在核对名称与版本…");
  return <li className="flex min-w-0 flex-col gap-0.5 rounded-lg bg-muted px-3 py-2">
    <div className="flex min-w-0 items-start justify-between gap-2">
      <span className="flex min-w-0 flex-col"><span className="break-words text-small text-foreground">{name}</span><span className={muted}>{version}</span></span>
      <Button size="compact" variant="ghost" onClick={onRemove} aria-label={`移除 ${name}`}>移除</Button>
    </div>
    <FullIdentifiers summary="来源与完整标识" rows={[{ label: "类型", value: labelOf(fixedRefKindLabels, ref.kind, "固定来源"), text: true },
      { label: "标识", value: ref.id }, { label: "固定修订", value: ref.revision }, { label: "SHA-256", value: ref.contentHash }]} />
  </li>;
}

/** Reads one document revision under the key the document page reads fixed revisions with. */
function fixedDocumentRevision(projectId: string, documentId: string, revisionId: string) {
  return projectQueryOptions(projectId, [fixedContent, documentId, revisionId, "revision"], async () => {
    const value = await api().documentRevision(projectId, documentId, revisionId);
    if (value.projectId !== projectId || value.documentId !== documentId || value.id !== revisionId) throw new Error("文档响应与所选的固定修订不符");
    return value;
  });
}

/** Choose a document, then one of its versions: the current one, the adopted one, or earlier ones read one at a time. */
function DocumentAdder({ projectId, control, onAdd }: { projectId: string; control?: Control | undefined; onAdd(ref: EvaluationFixedRef): void }) {
  const client = useQueryClient();
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<string | null>(null);
  const [earlier, setEarlier] = useState<DocumentRevision[]>([]);
  const [problem, setProblem] = useState("");
  const [reading, setReading] = useState(false);
  const reread = useReread(projectId, ["documents", "list", "all"]);
  const list = useProjectList(projectId, ["documents", "list", "all"], (cursor, signal) => api().documents(projectId, cursor, undefined, signal), (document: Document) => document.id);
  const detail = useProjectQuery(projectId, ["document", picked ?? "", "detail"], async (): Promise<DocumentDetail> => {
    const value = await api().document(projectId, picked!);
    if (value.document.projectId !== projectId || value.document.id !== picked || value.current.projectId !== projectId || value.current.documentId !== picked
      || value.adopted && (value.adopted.projectId !== projectId || value.adopted.documentId !== picked)) throw new Error("文档响应与当前项目不符");
    return value;
  }, { enabled: !!picked });
  const choose = (document: DocumentDetail["document"], revision: DocumentRevision) => {
    const ref = documentFixedRef(projectId, document, revision);
    if (!ref) { setProblem("这个版本没有可用的内容哈希，不能作为固定来源。"); return; }
    onAdd(ref); setPicked(null); setEarlier([]); setProblem(""); setQuery("");
  };
  if (picked) {
    const value = detail.data;
    const versions: DocumentRevision[] = value ? [value.current, ...value.adopted && value.adopted.id !== value.current.id ? [value.adopted] : [], ...earlier]
      .filter((item, index, all) => all.findIndex(other => other.id === item.id) === index) : [];
    const oldest = versions.at(-1);
    const readEarlier = async () => {
      if (!oldest?.previousRevisionId) return;
      setReading(true); setProblem("");
      try { const previous = await client.fetchQuery(fixedDocumentRevision(projectId, picked, oldest.previousRevisionId)); setEarlier(current => [...current, previous]); }
      catch (cause) { setProblem(`更早的版本没有读回：${errorText(cause)}`); }
      finally { setReading(false); }
    };
    return <div className="flex min-w-0 flex-col gap-2">
      <p className="m-0 text-small text-foreground">{value ? <>选择《{value.document.title}》的版本</> : detail.isError ? "文档没有读回" : "正在读取文档的版本…"}</p>
      {detail.isError && <Notice tone="error">{errorText(detail.error)}。读回之前不能选择版本。</Notice>}
      {versions.length > 0 && value && <ul aria-label="可选的版本" className="m-0 flex list-none flex-col gap-0.5 p-0">{versions.map(revision =>
        <li key={revision.id}><ListRow title={documentVersionLabel(value.document, revision.id, date(revision.createdAt))} meta={revision.reason || undefined}
          onSelect={() => choose(value.document, revision)} /></li>)}</ul>}
      {problem && <p className="m-0 text-caption text-destructive">{problem}</p>}
      <div className="flex flex-wrap gap-2">
        {oldest?.previousRevisionId && <Button size="compact" variant="ghost" disabled={reading} onClick={() => void readEarlier()}>{reading ? "读取中…" : "读取更早的版本"}</Button>}
        <Button size="compact" variant="ghost" onClick={() => { setPicked(null); setEarlier([]); setProblem(""); }}>换一份文档</Button>
      </div>
    </div>;
  }
  const items = (list.items ?? []).filter(document => document.projectId === projectId && document.status !== "archived");
  const found = query.trim() ? items.filter(document => matches(document.title, query)) : items;
  return <div className="flex min-w-0 flex-col gap-2">
    <SearchBox control={control} value={query} onChange={setQuery} placeholder="按文档名称搜索" />
    {found.length > 0 && <ul aria-label="可选的文档" className="m-0 flex list-none flex-col gap-0.5 p-0">{found.slice(0, shown).map(document =>
      <li key={document.id}><ListRow title={document.title} meta={document.status === "draft" ? "草稿" : "已发布"} onSelect={() => setPicked(document.id)} /></li>)}</ul>}
    {found.length > shown && <p className={muted}>还有 {found.length - shown} 项匹配，请输入更多文字缩小范围。</p>}
    {list.items && !found.length && <p className={muted}>{query.trim() ? `已读的文档里没有名称包含“${query.trim()}”的文档。` : "已读的文档里没有可选的文档。"}</p>}
    <Coverage count={list.items ? list.items.length : null} noun="文档" more={list.more} reading={list.reading} loadingMore={list.loadingMore}
      failed={list.error ? errorText(list.error) : ""} onMore={list.loadMore} onRetry={reread} />
  </div>;
}

/** Choose a Wiki page, then one of its versions (the current one, or one from its history). */
function WikiAdder({ projectId, control, onAdd }: { projectId: string; control?: Control | undefined; onAdd(ref: EvaluationFixedRef): void }) {
  const client = useQueryClient();
  const wiki = knowledgeClient("", projectId);
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<KnowledgeSummary | null>(null);
  const [problem, setProblem] = useState("");
  const [reading, setReading] = useState("");
  // Closed (收起) while a version was read: the version is not added behind the person's back.
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const reread = useReread(projectId, ["knowledge", "pages"]);
  const list = useProjectList(projectId, ["knowledge", "pages"], cursor => wiki.pages(cursor), (page: KnowledgeSummary) => page.knowledgeId);
  const history = useProjectQuery(projectId, ["evaluation-choice", "wiki-history", picked?.knowledgeId ?? ""], () => wiki.history(picked!.knowledgeId), { enabled: !!picked });
  const choose = async (summary: KnowledgeSummary, revision: string) => {
    setReading(revision); setProblem("");
    try {
      const page = await client.fetchQuery(projectQueryOptions(projectId, ["knowledge", "read", summary.knowledgeId, revision], () => wiki.page(summary.knowledgeId, revision)));
      const ref = wikiFixedRef(projectId, summary.knowledgeId, revision, page);
      if (!ref) { setProblem("这一版与所选的 Wiki 页不符，或没有可用的内容哈希。"); return; }
      if (alive.current) { onAdd(ref); setPicked(null); setQuery(""); }
    } catch (cause) { if (alive.current) setProblem(`这一版没有读回：${errorText(cause)}`); }
    finally { if (alive.current) setReading(""); }
  };
  if (picked) {
    const versions = [picked, ...(history.data?.items ?? []).filter(item => item.knowledgeId === picked.knowledgeId)]
      .filter((item, index, all) => all.findIndex(other => other.revision === item.revision) === index);
    return <div className="flex min-w-0 flex-col gap-2">
      <p className="m-0 text-small text-foreground">选择《{picked.title}》的版本</p>
      <ul aria-label="可选的版本" className="m-0 flex list-none flex-col gap-0.5 p-0">{versions.map((item, index) =>
        <li key={item.revision}><ListRow title={index === 0 ? "当前版本" : `历史版本 ${versions.length - index}`} meta={reading === item.revision ? "正在读取这一版…" : item.title}
          onSelect={() => { if (!reading) void choose(picked, item.revision); }} /></li>)}</ul>
      <p className={muted}>{history.isError ? `历史版本没有读回：${errorText(history.error)}；仍可选当前版本。` : history.data ? history.data.nextCursor ? "只列出最近的历史版本。" : "" : "正在读取历史版本…"}</p>
      {problem && <p className="m-0 text-caption text-destructive">{problem}</p>}
      <Button size="compact" variant="ghost" className="w-fit" onClick={() => { setPicked(null); setProblem(""); }}>换一个 Wiki 页</Button>
    </div>;
  }
  const items = list.items ?? [];
  const found = query.trim() ? items.filter(page => matches(page.title, query)) : items;
  return <div className="flex min-w-0 flex-col gap-2">
    <SearchBox control={control} value={query} onChange={setQuery} placeholder="按 Wiki 页名称搜索" />
    {found.length > 0 && <ul aria-label="可选的 Wiki 页" className="m-0 flex list-none flex-col gap-0.5 p-0">{found.slice(0, shown).map(page =>
      <li key={page.knowledgeId}><ListRow title={page.title} onSelect={() => setPicked(page)} /></li>)}</ul>}
    {found.length > shown && <p className={muted}>还有 {found.length - shown} 项匹配，请输入更多文字缩小范围。</p>}
    {list.items && !found.length && <p className={muted}>{query.trim() ? `已读的 Wiki 页里没有名称包含“${query.trim()}”的页面。` : "已读的 Wiki 页里没有可选的页面。"}</p>}
    <Coverage count={list.items ? list.items.length : null} noun=" Wiki 页" more={list.more} reading={list.reading} loadingMore={list.loadingMore}
      failed={list.error ? errorText(list.error) : ""} onMore={list.loadMore} onRetry={reread} />
  </div>;
}

/** 按完整标识添加: a source no list offers (a Git commit), typed as the definition records it. */
function TypedAdder({ allowed, onAdd }: { allowed: readonly ChoosableKind[]; onAdd(ref: EvaluationFixedRef): void }) {
  const [line, setLine] = useState("");
  const [problem, setProblem] = useState("");
  const add = () => {
    try { onAdd(typedRef(line, allowed)); setLine(""); setProblem(""); }
    catch (cause) { setProblem(cause instanceof Error ? cause.message : "无法识别这一项"); }
  };
  return <details className="text-caption text-muted-foreground">
    <summary className="w-fit cursor-pointer hover:text-foreground">按完整标识添加{allowed.includes("git") ? "（例如 Git 来源）" : ""}</summary>
    <div className="mt-2 flex min-w-0 flex-col gap-1.5">
      <p className={muted}>写成一行：{allowed.map(kind => kind).join(" 或 ")} | 标识 | 固定修订 | SHA-256。</p>
      <div className="flex min-w-0 gap-2">
        <Input aria-label="完整标识" value={line} autoComplete="off" onChange={event => setLine(event.target.value)} className="min-w-0 flex-1" />
        <Button size="compact" onClick={add} disabled={!line.trim()}>添加</Button>
      </div>
      {problem && <p className="m-0 text-caption text-destructive">{problem}</p>}
    </div>
  </details>;
}

/**
 * The fixed sources of one field, by name, with an adder. `single`: the field holds exactly one source (the protocol),
 * and choosing another replaces it.
 */
export function FixedRefsChoice({ projectId, value, onChange, control, label, allowed, single = false, addLabel }: {
  projectId: string; value: string; onChange(value: string): void; control?: Control | undefined; label: string; allowed: readonly ChoosableKind[]; single?: boolean; addLabel: string;
}) {
  const rows = refRows(value, allowed);
  const [adding, setAdding] = useState(false);
  // A version is added after its hash is read: it joins the sources as they are then, not as they were when it was clicked.
  const latest = useRef(value);
  latest.current = value;
  const add = (ref: EvaluationFixedRef) => { latest.current = withRef(latest.current, ref, single); onChange(latest.current); setAdding(false); };
  const adder: ReactNode = allowed.includes("wiki") ? <WikiAdder projectId={projectId} control={control} onAdd={add} />
    : <DocumentAdder projectId={projectId} control={control} onAdd={add} />;
  return <div role="group" aria-label={label} className="flex min-w-0 flex-col gap-2">
    {rows.length > 0 && <ul className="m-0 flex list-none flex-col gap-1.5 p-0">{rows.map((row, index) => row.ref
      ? <RefRowView key={`${index}:${row.line}`} projectId={projectId} ref={row.ref} onRemove={() => onChange(withoutRef(value, index))} />
      : <li key={`${index}:${row.line}`} className="flex min-w-0 flex-col gap-0.5 rounded-lg bg-muted px-3 py-2">
        <div className="flex items-start justify-between gap-2"><span className="text-small text-destructive">这一项无法识别：{row.problem}</span>
          <Button size="compact" variant="ghost" onClick={() => onChange(withoutRef(value, index))}>移除</Button></div>
        <FullIdentifiers summary="原文" rows={[{ label: "原文", value: row.line, text: true }]} />
      </li>)}</ul>}
    {adding
      ? <div className="flex min-w-0 flex-col gap-2 rounded-lg border border-border p-3">{adder}<TypedAdder allowed={allowed} onAdd={add} />
        <Button size="compact" variant="ghost" className="w-fit" onClick={() => setAdding(false)}>收起</Button></div>
      : <Button size="compact" variant="ghost" className="w-fit" onClick={() => setAdding(true)}>{single && rows.length ? "更换" : addLabel}</Button>}
  </div>;
}
