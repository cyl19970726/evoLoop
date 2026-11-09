// 分工讨论 (docs/frontend/pages/team.md): the inner rail lists discussions, the center shows the selected one as
// 准备 → 交接 → 决定, and the right column holds what it fixed and the tasks, roles and documents linked after it.
// `?discussion=` selects one and `?new=1` opens the prepare form; without either the first listed one is shown.
import { useEffect, useState } from "react";
import { Plus, RefreshCw } from "lucide-react";
import { Button, EmptyState, ErrorState, LoadingState, Notice, cn } from "@evoloop/ui";
import { errorText } from "../../shared/api";
import type { MutationContext } from "../../shared/ActionForm";
import { currentPath, navigate, onNavigate } from "../../shared/navigation";
import { useProjectQuery } from "../../shared/query";
import { ContextRailContent } from "../../shared/ui/ContextRail";
import { href } from "../../shared/ui/shared";
import { canWrite, control, muted } from "./CommandForm";
import { readChoices, readDiscussion, readDiscussions, type Choices } from "./discussionClient";
import { DiscussionDetail } from "./DiscussionDetail";
import { PrepareForm } from "./DiscussionForms";
import { discussionAddress, discussionHref, listRow, prepareHref, scopeOptions, type ListScope } from "./discussionPresentation";

function PrepareView({ context, choices }: { context: MutationContext; choices: ReturnType<typeof useProjectQuery<Choices>> }) {
  if (!canWrite(context, "write")) return <Notice tone="waiting">当前身份没有写入权限，不能准备讨论。</Notice>;
  if (choices.isPending) return <LoadingState lines={4} label="正在读取可固定的目标与来源" />;
  if (choices.isError) return <ErrorState title="可选的目标与来源没有读全" happened={errorText(choices.error)}
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
  const [pages, setPages] = useState(1);
  const [prepareOpened, setPrepareOpened] = useState(address.preparing);
  useEffect(() => { if (address.preparing) setPrepareOpened(true); }, [address.preparing]);
  const list = useProjectQuery(projectId, ["discussions", "list", scope, pages], signal => readDiscussions(projectId, scope, pages, signal), { keepPrevious: true });
  // A changed scope keeps the old answer only until the new one arrives; it is never shown as the new scope's list.
  const listed = list.data?.scope === scope ? list.data : undefined;
  const choices = useProjectQuery(projectId, ["discussions", "choices"], () => readChoices(projectId));
  const selectedId = address.discussionId || (address.preparing ? "" : listed?.items[0]?.id ?? "");
  const detail = useProjectQuery(projectId, ["discussions", "detail", selectedId], signal => readDiscussion(projectId, selectedId, signal), { enabled: !!selectedId });
  const items = listed?.items ?? [];
  const taskName = (id: string | undefined) => choices.data?.tasks.find(task => task.id === id)?.title;
  const changeScope = (next: ListScope) => { setScope(next); setPages(1); if (address.discussionId) navigate(discussionHref(projectId)); };

  return <div className="flex flex-col gap-5">
    <ContextRailContent>
      <nav aria-label="讨论列表" className="flex flex-col gap-0.5 pt-2">
        <div className="flex items-center justify-between gap-2 px-3 pb-1.5 pt-2">
          <span className="text-caption text-muted-foreground">{listed ? `讨论 · ${items.length}${listed.nextCursor ? "+" : ""}` : "讨论"}</span>
          {canWrite(context, "write") && <a href={prepareHref(projectId)} aria-current={address.preparing ? "page" : undefined}
            className={cn("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-caption text-text-secondary outline-none hover:bg-selected focus-visible:shadow-[var(--focus-ring)]", address.preparing && "bg-selected text-foreground")}>
            <Plus size={12} aria-hidden="true" />准备讨论</a>}
        </div>
        <label className="px-3 pb-2"><span className="sr-only">讨论范围</span>
          <select value={scope} onChange={event => changeScope(event.target.value as ListScope)} className={cn(control, "h-8 text-label")}>
            {scopeOptions.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}
          </select></label>
        {!listed && list.isFetching && <span className="px-3 py-2 text-caption text-muted-foreground">正在读取讨论…</span>}
        {list.isError && <span className="px-3 py-2 text-caption text-destructive">讨论列表没有读全，见中间说明。</span>}
        {listed && !items.length && <span className="px-3 py-2 text-caption text-muted-foreground">这个范围还没有讨论。</span>}
        {items.map(item => {
          const row = listRow(item, taskName(item.task?.id), scope === "all", choices.isPending);
          const selected = !address.preparing && item.id === selectedId;
          return <a key={item.id} href={discussionHref(projectId, item.id)} aria-current={selected ? "page" : undefined}
            className={cn("flex flex-col rounded-lg px-3 py-1.5 outline-none focus-visible:shadow-[var(--focus-ring)]", selected ? "bg-raised shadow-sm" : "hover:bg-selected")}>
            <span className="truncate text-small text-foreground">{row.title}</span>
            {row.meta && <span className="truncate text-caption text-muted-foreground">{row.meta}</span>}
          </a>;
        })}
        {listed?.nextCursor && <button type="button" disabled={list.isFetching} onClick={() => setPages(value => value + 1)}
          className="mx-3 my-1 self-start rounded-full px-2 py-0.5 text-caption text-text-secondary hover:bg-selected disabled:opacity-50">{list.isFetching ? "正在读取…" : "加载更多讨论"}</button>}
      </nav>
    </ContextRailContent>

    <div className="flex flex-wrap items-center justify-between gap-3">
      <p className="min-w-0 max-w-[620px] flex-[1_1_320px] text-small leading-[1.6] text-text-secondary">从固定材料理解问题、取舍和后续关系。准备、交接、决定和实际接手各有独立记录，没有新的取舍时不必制造讨论。</p>
      <div className="flex shrink-0 items-center gap-2">
        {canWrite(context, "write") && !address.preparing && <Button asChild><a href={prepareHref(projectId)}><Plus aria-hidden="true" />准备讨论</a></Button>}
        <Button variant="ghost" disabled={list.isFetching || detail.isFetching} onClick={context.onChanged}><RefreshCw aria-hidden="true" className={list.isFetching || detail.isFetching ? "animate-spin motion-reduce:animate-none" : undefined} />重新读取</Button>
      </div>
    </div>

    {items.length > 1 && <label className="flex flex-col gap-1 desktop:hidden"><span className={muted}>切换讨论</span>
      <select className={cn(control, "h-9")} value={address.preparing ? "" : selectedId} onChange={event => navigate(event.target.value ? discussionHref(projectId, event.target.value) : prepareHref(projectId))}>
        {address.preparing && <option value="">正在准备新的讨论</option>}
        {items.map(item => <option key={item.id} value={item.id}>{listRow(item, taskName(item.task?.id), scope === "all", choices.isPending).title}</option>)}
      </select></label>}

    {list.isError && <Notice tone="error" title="讨论列表没有读全">{errorText(list.error)}。{listed ? "左侧仍是上次读到的列表。" : "请重新读取。"}</Notice>}

    {prepareOpened && <section aria-label="准备讨论" hidden={!address.preparing} className="flex max-w-[760px] flex-col gap-3">
      <h2 className="text-heading font-semibold text-foreground">准备讨论</h2>
      <PrepareView context={context} choices={choices} />
    </section>}

    {!address.preparing && <>
      {selectedId && detail.isPending && <LoadingState lines={5} label="正在读取讨论" />}
      {selectedId && detail.isError && <ErrorState title="这条讨论没有读回" happened={errorText(detail.error)} previousContentKept={!!detail.data}
        next="讨论详情或记录不可读时，不能据列表状态继续登记。请重新读取。" action={<Button size="compact" onClick={() => void detail.refetch()}>重新读取</Button>} />}
      {selectedId && detail.data && <DiscussionDetail key={detail.data.record.id} context={context} record={detail.data.record} events={detail.data.events}
        choices={choices.data} choicesLoading={choices.isPending} refresh={refresh} checking={detail.checking} />}
      {!selectedId && listed && !items.length && !list.isError && <EmptyState title={scope === "all" ? "还没有讨论" : "这个范围还没有讨论"}
        reason="准备讨论会固定目标版本、所读依据和要回答的问题，生成一份交接包。没有新的取舍时不必制造任务或常设职责。"
        action={scope !== "all" ? <Button size="compact" variant="ghost" onClick={() => changeScope("all")}>查看全部讨论</Button> : undefined} />}
      {!selectedId && !listed && list.isPending && <LoadingState lines={4} label="正在读取讨论" />}
    </>}
    {choices.isError && !address.preparing && selectedId && <Notice tone="waiting">目标、任务、职责和文档的清单没有读全：{errorText(choices.error)}。名称可能显示为“暂不可读”，链接后续对象暂不可用。</Notice>}
  </div>;
}
