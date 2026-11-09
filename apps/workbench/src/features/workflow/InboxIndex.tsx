// 待我处理 › 待我验收与判断 (tasks.md 收件页, layout.md 待我处理): acceptance arranged for me and basis changes waiting
// for review, each linked to its task. Reading and observing an acceptance is recorded by the person through the CLI;
// a basis change is decided on the task's 依据与影响. Open to-do tasks are in the task table, filtered to 待办.
// While a list is being read or cannot be read, the page never says there is nothing waiting.
import type { ReactNode } from "react";
import { RefreshCw } from "lucide-react";
import type { AcceptanceHumanItem } from "@evoloop/contracts/acceptance-relay";
import type { Impact } from "@evoloop/contracts";
import { Button, ErrorState, ListRow, LoadingState, Notice, RefreshingIndicator } from "@evoloop/ui";
import { api, errorText } from "../../shared/api";
import type { MutationContext } from "../../shared/ActionForm";
import { useProjectQuery } from "../../shared/query";
import { FullIdentifiers } from "../../shared/ui/FullIdentifiers";
import { PageSection, mutedText } from "../../shared/ui/PageParts";
import { useTaskName } from "../../shared/ui/RecordName";
import { date, href } from "../../shared/ui/shared";
import { nameOnly } from "../../shared/workPresentation";
import { defaultTaskListView, taskListRoute } from "./taskExperience";

type Read<T> = { data: T | undefined; error: unknown; isPending: boolean; isFetching: boolean; refetch(): unknown };

/** The state of one list: first read, failure, a failed reread over the last answer, or a reread in progress. */
function ReadState<T>({ read, what }: { read: Read<T>; what: string }): ReactNode {
  const retry = <Button size="compact" disabled={read.isFetching} onClick={() => void read.refetch()}>重新读取</Button>;
  if (read.isPending && !read.error) return <LoadingState lines={2} label={`正在读取${what}`} />;
  if (read.error && read.data === undefined) return <ErrorState title={`${what}暂不可读取`} happened={errorText(read.error)}
    next="可以重新读取；读取失败不代表没有等你处理的事项。" action={retry} />;
  if (read.error) return <Notice tone="waiting" title="上次读回，当前待核对" action={retry}>重新读取{what}失败：{errorText(read.error)}。下面是上次读回的内容。</Notice>;
  if (read.isFetching) return <RefreshingIndicator label={`正在核对${what}`} />;
  return null;
}

const countText = (read: Read<unknown>, count: number | undefined) => read.data !== undefined ? `${count ?? 0} 项` : read.error ? "暂不可读取" : "正在读取";

export function InboxIndex({ context }: { context: MutationContext; refresh: number }) {
  const { projectId } = context;
  const mine = useProjectQuery(projectId, ["acceptance", "mine"], async () => {
    const value = await api().acceptanceMine(projectId);
    if (!Array.isArray(value?.items) || value.items.some(item => item.projectId !== projectId)) throw new Error("待验收列表响应与当前项目不符");
    return value;
  });
  // Same key and answer as the count on 待我处理 in the shell (App.tsx).
  const acceptance = mine.data?.items;
  const impacts = useProjectQuery(projectId, ["impacts"], async () => {
    const value = await api().impacts(projectId);
    if (!Array.isArray(value)) throw new Error("依据变化响应不完整");
    return value;
  });
  const pending = impacts.data?.filter(item => item.state === "pending");
  const reading = mine.isFetching || impacts.isFetching;
  return <div data-ui="" className="mx-auto flex w-full max-w-[880px] flex-col gap-6 px-4 py-5 compact:px-8 compact:py-7" data-inbox="">
    <header className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h1 tabIndex={-1} className="text-title font-semibold text-foreground outline-none">待我验收与判断</h1>
        <p className="mt-1 text-small text-text-secondary">分配给我的验收安排和待复核的依据变化。每项打开它的任务，在那里核对并决定下一步。</p>
      </div>
      <Button variant="ghost" disabled={reading} onClick={context.onChanged}><RefreshCw aria-hidden="true" className={reading ? "animate-spin" : undefined} />重新读取</Button>
    </header>
    <PageSection title="待我验收" action={<span className={mutedText}>{countText(mine, acceptance?.length)}</span>}
      description="阅读与观察由本人在命令行里记录（work acceptance read / observe）；这里只列出安排与当前进度。">
      <ReadState read={mine} what="待验收事项" />
      {acceptance?.length === 0 && <p className="text-small text-text-secondary">当前没有分配给我的验收事项。</p>}
      {!!acceptance?.length && <ul aria-label="待我验收" className="flex flex-col">{acceptance.map(item => <li key={item.relayId}><AcceptanceRow projectId={projectId} item={item} /></li>)}</ul>}
    </PageSection>
    <PageSection title="依据变化" action={<span className={mutedText}>{countText(impacts, pending?.length)}</span>}
      description="任务固定的依据出现新版。在任务的“依据与影响”里决定采用新版还是保留原依据。">
      <ReadState read={impacts} what="依据变化" />
      {pending?.length === 0 && <p className="text-small text-text-secondary">当前没有待复核的依据变化。</p>}
      {!!pending?.length && <ul aria-label="依据变化" className="flex flex-col">{pending.map(item => <li key={item.id}><ImpactRow projectId={projectId} item={item} /></li>)}</ul>}
    </PageSection>
    <p className={mutedText}>待办任务在任务表格里按“待办”筛选查看。<a className="ml-1 text-primary hover:underline" href={taskListRoute(projectId, { ...defaultTaskListView, filter: "todo" })}>打开待办任务</a></p>
  </div>;
}

function AcceptanceRow({ projectId, item }: { projectId: string; item: AcceptanceHumanItem }) {
  const task = nameOnly("任务", useTaskName(projectId, item.taskId));
  const progress = `${item.readAt ? `读于 ${date(item.readAt)}` : "尚未读取"} · ${item.observationId ? "已有使用观察" : "尚未留使用观察"}`;
  return <div className="flex flex-col gap-1 border-t border-border py-1 first:border-t-0">
    <ListRow href={href(projectId, "task", item.taskId)} title={`${item.stage === "formal" ? "正式复验" : "候选验收"} · ${item.scopeDescription}`}
      meta={`${task} · 第 ${item.version} 次安排 · ${progress}`} />
    <p className={`${mutedText} px-3`}>{item.entrypoint ? `入口：${item.entrypoint}` : "按当前固定交付读取"} · 安排于 {date(item.createdAt)}</p>
    <FullIdentifiers className="px-3" rows={[{ label: "验收安排", value: item.relayId }, { label: "固定交付", value: item.deliveryId },
      { label: "任务修订", value: item.taskRevisionId }, { label: "验收范围", value: item.scopeKey }]} />
  </div>;
}

function ImpactRow({ projectId, item }: { projectId: string; item: Impact }) {
  const task = nameOnly("任务", useTaskName(projectId, item.taskId));
  return <div className="flex flex-col gap-1 border-t border-border py-1 first:border-t-0">
    <ListRow href={`${href(projectId, "task", item.taskId)}?tab=basis`} title={task} meta={`依据有新版待复核 · 发现于 ${date(item.createdAt)}`}
      trailing={<span className="text-primary">查看影响</span>} />
    <FullIdentifiers className="px-3" rows={[{ label: "依据文档", value: item.documentId }, { label: "固定修订", value: item.fromRevisionId },
      { label: "新采纳修订", value: item.toRevisionId }]} />
  </div>;
}
