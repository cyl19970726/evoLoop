// 分工讨论 (docs/frontend/pages/team.md): the inner rail lists discussions, the center shows the selected one as
// 准备 → 交接 → 决定, and the right column holds what it fixed and the tasks, roles and documents linked after it.
// `?discussion=` selects one and `?new=1` opens the prepare form; without either the first listed one is shown.
// The list reads one page more at a time (useProjectList); a failed reread keeps it as 上次读回.
import { useEffect, useState } from "react";
import type { DiscussionRecord } from "@evoloop/contracts";
import { Plus, RefreshCw } from "lucide-react";
import { Button, EmptyState, ErrorState, LoadingState, Notice, Select, cn } from "@evoloop/ui";
import { errorText } from "../../shared/api";
import type { MutationContext } from "../../shared/ActionForm";
import { currentPath, navigate, onNavigate } from "../../shared/navigation";
import { diagnosticOf } from "../../shared/errorPresentation";
import { listEndText } from "../../shared/listCoverage";
import { useProjectList } from "../../shared/projectList";
import { useProjectQuery } from "../../shared/query";
import { ErrorDetails } from "../../shared/ui/ErrorDetails";
import { ContextRailContent } from "../../shared/ui/ContextRail";
import { href } from "../../shared/ui/shared";
import { canWrite, muted } from "./formParts";
import { readChoices, readDiscussion, readDiscussionPage, type Choices } from "./discussionClient";
import { DiscussionDetail } from "./DiscussionDetail";
import { PrepareForm } from "./DiscussionForms";
import { discussionAddress, discussionHref, listRow, prepareHref, scopeOptions, type ListScope } from "./discussionPresentation";

function PrepareView({ context, choices }: { context: MutationContext; choices: ReturnType<typeof useProjectQuery<Choices>> }) {
  if (!canWrite(context, "write")) return <Notice tone="waiting">当前身份没有写入权限，不能准备讨论。</Notice>;
  if (choices.isPending) return <LoadingState lines={4} label="正在读取可固定的目标与来源" />;
  if (choices.isError) return <ErrorState title="可选的目标与来源没有读全" happened={errorText(choices.error)} diagnostics={diagnosticOf(choices.error)}
    next="交接包要固定完整的选择，读全之前不生成。请重新读取。" action={<Button size="compact" onClick={() => void choices.refetch()}>重新读取</Button>} />;
  if (!choices.data.goals.length) return <EmptyState title="还没有目标" reason="交接包要固定一个目标版本。先在“目标与阶段”建立目标，再回来准备讨论。"
    action={<a href={href(context.projectId, "journey")} className="text-small font-medium text-primary hover:underline">打开目标与阶段</a>} />;
  return <PrepareForm context={context} choices={choices.data} rereading={choices.isFetching} onPrepared={id => navigate(discussionHref(context.projectId, id))}
    onCancel={() => navigate(discussionHref(context.projectId))} />;
}

export function DiscussionPanel({ context, refresh }: { context: MutationContext; refresh: number }) {
  const { projectId } = context;
  const [address, setAddress] = useState(() => discussionAddress(currentPath(), projectId));
  // Only this page's own address moves the selection; leaving the section keeps it for when the reader comes back.
  useEffect(() => onNavigate(() => { const next = discussionAddress(currentPath(), projectId); if (next.onPage) setAddress(next); }), [projectId]);
  const [scope, setScope] = useState<ListScope>("allocation");
  const [prepareOpened, setPrepareOpened] = useState(address.preparing);
  useEffect(() => { if (address.preparing) setPrepareOpened(true); }, [address.preparing]);
  // Each scope is its own list: another scope starts from its own first page and never shows this one's rows.
  const list = useProjectList(projectId, ["discussions", "list", scope], (cursor, signal) => readDiscussionPage(projectId, scope, cursor, signal),
    (item: DiscussionRecord) => item.id);
  const listed = list.items;
  // Only a list just read may say a scope has no discussion.
  const current = list.coverage === "current";
  const choices = useProjectQuery(projectId, ["discussions", "choices"], () => readChoices(projectId));
  const selectedId = address.discussionId || (address.preparing ? "" : listed?.[0]?.id ?? "");
  const detail = useProjectQuery(projectId, ["discussions", "detail", selectedId], signal => readDiscussion(projectId, selectedId, signal), { enabled: !!selectedId });
  const items = listed ?? [];
  const taskName = (id: string | undefined) => choices.data?.tasks.find(task => task.id === id)?.title;
  const changeScope = (next: ListScope) => { setScope(next); if (address.discussionId) navigate(discussionHref(projectId)); };

  return <div className="flex flex-col gap-5">
    <ContextRailContent>
      <nav aria-label="讨论列表" className="flex flex-col gap-0.5 pt-2">
        <div className="flex items-center justify-between gap-2 px-3 pb-1.5 pt-2">
          <span className="text-caption text-muted-foreground">{listed ? `讨论 · ${items.length}${list.more || list.repeatedCursor ? "+" : ""}` : "讨论"}</span>
          {canWrite(context, "write") && <a href={prepareHref(projectId)} aria-current={address.preparing ? "page" : undefined}
            className={cn("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-caption text-text-secondary outline-none hover:bg-selected focus-visible:shadow-[var(--focus-ring)]", address.preparing && "bg-selected text-foreground")}>
            <Plus size={12} aria-hidden="true" />准备讨论</a>}
        </div>
        <label className="px-3 pb-2"><span className="sr-only">讨论范围</span>
          <Select value={scope} onChange={event => changeScope(event.target.value as ListScope)} compact className="w-full">
            {scopeOptions.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}
          </Select></label>
        {list.reading && <span className="px-3 py-2 text-caption text-muted-foreground">正在读取讨论…</span>}
        {list.failed && <span className="px-3 py-2 text-caption text-destructive">讨论列表没有读回，见中间说明。</span>}
        {list.stale && <span className="px-3 py-2 text-caption text-muted-foreground">上次读回，当前待核对</span>}
        {listed && current && !items.length && !list.repeatedCursor && <span className="px-3 py-2 text-caption text-muted-foreground">这个范围还没有讨论。</span>}
        {list.repeatedCursor && <span className="px-3 py-1 text-caption text-muted-foreground" data-repeated-cursor="">{listEndText(list)}</span>}
        {items.map(item => {
          const row = listRow(item, taskName(item.task?.id), scope === "all", choices.isPending);
          const selected = !address.preparing && item.id === selectedId;
          return <a key={item.id} href={discussionHref(projectId, item.id)} aria-current={selected ? "page" : undefined}
            className={cn("flex flex-col rounded-lg px-3 py-1.5 outline-none focus-visible:shadow-[var(--focus-ring)]", selected ? "bg-raised shadow-sm" : "hover:bg-selected")}>
            <span className="truncate text-small text-foreground">{row.title}</span>
            {row.meta && <span className="truncate text-caption text-muted-foreground">{row.meta}</span>}
          </a>;
        })}
        {list.pageFailed && <span className="px-3 py-1 text-caption text-destructive">下一页没有读回，可以再试一次。</span>}
        {list.more && <Button variant="ghost" disabled={list.loadingMore || list.checking} onClick={list.loadMore}
          className="mx-3 my-1 h-auto self-start px-2 py-0.5 text-caption font-normal hover:bg-selected">{list.loadingMore ? "正在读取…" : list.pageFailed ? "再读一次下一页" : "加载更多讨论"}</Button>}
      </nav>
    </ContextRailContent>

    <div className="flex flex-wrap items-center justify-between gap-3">
      <p className="min-w-0 max-w-[620px] flex-[1_1_320px] text-small leading-(--leading-body) text-text-secondary">从固定材料理解问题、取舍和后续关系。准备、交接、决定和实际接手各有独立记录，没有新的取舍时不必制造讨论。</p>
      <div className="flex shrink-0 items-center gap-2">
        {canWrite(context, "write") && !address.preparing && <Button asChild><a href={prepareHref(projectId)}><Plus aria-hidden="true" />准备讨论</a></Button>}
        <Button variant="ghost" disabled={list.reading || list.checking || detail.isFetching} onClick={context.onChanged}><RefreshCw aria-hidden="true" className={list.reading || list.checking || detail.isFetching ? "animate-spin motion-reduce:animate-none" : undefined} />重新读取</Button>
      </div>
    </div>

    {items.length > 1 && <label className="flex flex-col gap-1 desktop:hidden"><span className={muted}>切换讨论</span>
      <Select className="w-full" value={address.preparing ? "" : selectedId} onChange={event => navigate(event.target.value ? discussionHref(projectId, event.target.value) : prepareHref(projectId))}>
        {address.preparing && <option value="">正在准备新的讨论</option>}
        {items.map(item => <option key={item.id} value={item.id}>{listRow(item, taskName(item.task?.id), scope === "all", choices.isPending).title}</option>)}
      </Select></label>}

    {list.failed && <Notice tone="error" title="讨论列表没有读回">{errorText(list.error)}。请重新读取；读回之前不能判断这个范围有没有讨论。<ErrorDetails error={list.error} /></Notice>}
    {list.stale && <Notice tone="waiting" title="上次读回，当前待核对">讨论列表重新读取失败：{errorText(list.error)}。左侧仍是上次读到的列表。<ErrorDetails error={list.error} /></Notice>}
    {list.repeatedCursor && !list.error && <Notice tone="waiting" title={listEndText(list)!}>讨论分页返回了已经读过的位置，读取已停下；左侧只是读到的部分，不能据此判断这个范围只有这些讨论。</Notice>}
    {list.pageFailed && <Notice tone="error" title="下一页讨论没有读回" action={<Button size="compact" onClick={list.loadMore}>再读一次</Button>}>
      {errorText(list.error)}。已列出的讨论是读到的内容，后面的还没读到。<ErrorDetails error={list.error} /></Notice>}

    {prepareOpened && <section aria-label="准备讨论" hidden={!address.preparing} className="flex max-w-[760px] flex-col gap-3">
      <h2 className="text-heading font-semibold text-foreground">准备讨论</h2>
      <PrepareView context={context} choices={choices} />
    </section>}

    {!address.preparing && <>
      {selectedId && detail.isPending && <LoadingState lines={5} label="正在读取讨论" />}
      {selectedId && detail.isError && <ErrorState title="这条讨论没有读回" happened={errorText(detail.error)} previousContentKept={!!detail.data} diagnostics={diagnosticOf(detail.error)}
        next="讨论详情或记录不可读时，不能据列表状态继续登记。请重新读取。" action={<Button size="compact" onClick={() => void detail.refetch()}>重新读取</Button>} />}
      {selectedId && detail.data && <DiscussionDetail key={detail.data.record.id} context={context} record={detail.data.record} events={detail.data.events}
        choices={choices.data} choicesLoading={choices.isPending} refresh={refresh} checking={detail.checking} />}
      {!selectedId && listed && current && !items.length && !list.repeatedCursor && <EmptyState title={scope === "all" ? "还没有讨论" : "这个范围还没有讨论"}
        reason="准备讨论会固定目标版本、所读依据和要回答的问题，生成一份交接包。没有新的取舍时不必制造任务或常设职责。"
        action={scope !== "all" ? <Button size="compact" variant="ghost" onClick={() => changeScope("all")}>查看全部讨论</Button> : undefined} />}
      {!selectedId && list.reading && <LoadingState lines={4} label="正在读取讨论" />}
    </>}
    {choices.isError && !address.preparing && selectedId && <Notice tone="waiting">目标、任务、职责和文档的清单没有读全：{errorText(choices.error)}。名称可能显示为“暂不可读”，链接后续对象暂不可用。<ErrorDetails error={choices.error} /></Notice>}
  </div>;
}
