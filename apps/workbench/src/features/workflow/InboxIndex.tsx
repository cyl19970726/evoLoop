// 待我处理 › 待我验收与判断 (tasks.md 收件页, layout.md 待我处理): acceptance arranged for me, deliveries that declare me
// as their consumer and wait for my use, and basis changes waiting for review, each linked to its task with the way
// back here (inboxTaskLink). Reading and observing is recorded by the person (the CLI, or the task's 交付与使用), said
// in words, never as the command line; a basis change is decided on the task's 依据与影响. Open to-do tasks are in the
// task table, filtered to 待办. The reads and their keys are shared with the count in the shell (inboxReads.ts). While
// a list is being read or cannot be read, the page never says there is nothing waiting.
import type { ReactNode } from "react";
import { RefreshCw } from "lucide-react";
import type { AcceptanceHumanItem } from "@evoloop/contracts/acceptance-relay";
import type { Impact } from "@evoloop/contracts";
import { Button, ErrorState, ListRow, LoadingState, Notice, RefreshingIndicator } from "@evoloop/ui";
import { errorText } from "../../shared/api";
import type { MutationContext } from "../../shared/ActionForm";
import { FullIdentifiers } from "../../shared/ui/FullIdentifiers";
import { PageSection, mutedText } from "../../shared/ui/PageParts";
import { useTaskName } from "../../shared/ui/RecordName";
import { date } from "../../shared/ui/shared";
import { nameOnly } from "../../shared/workPresentation";
import { decisionKindText, decisionLink, deliveryLink, inboxTaskLink, lastUseText, useRequirementText, type DeliveryForMe } from "./inboxModel";
import type { DecisionItem } from "@evoloop/contracts/decision-requests";
import { ActionForm, option } from "../../shared/ActionForm";
import { useInboxReads, type DeliveriesForMe } from "./inboxReads";
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
  const actorId = context.principal.actorId;
  const { acceptance: mine, impacts, deliveries, decisions } = useInboxReads(projectId, actorId);
  const acceptance = mine.data?.items;
  const pending = impacts.data?.filter(item => item.state === "pending");
  const reading = mine.isFetching || impacts.isFetching || deliveries.isFetching || decisions.isFetching;
  const decide = decisions.data?.items;
  return <div data-ui="" className="mx-auto flex w-full max-w-[880px] flex-col gap-6 px-4 py-5 compact:px-8 compact:py-7" data-inbox="">
    <header className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h1 tabIndex={-1} className="text-title font-semibold text-foreground outline-none">待我验收与判断</h1>
        <p className="mt-1 text-small text-text-secondary">分配给我的验收安排、等我使用的交付和待复核的依据变化。每项打开它的任务，在那里核对并决定下一步。</p>
      </div>
      <Button variant="ghost" disabled={reading} onClick={context.onChanged}><RefreshCw aria-hidden="true" className={reading ? "animate-spin" : undefined} />重新读取</Button>
    </header>
    <PageSection title="待我验收" action={<span className={mutedText}>{countText(mine, acceptance?.length)}</span>}
      description="读过没有、用得怎样，由验收人本人记录：在命令行里记，或在任务的“交付与使用”里记录使用。这里只列出安排与当前进度。">
      <ReadState read={mine} what="待验收事项" />
      {acceptance?.length === 0 && <p className="text-small text-text-secondary">当前没有分配给我的验收事项。</p>}
      {!!acceptance?.length && <ul aria-label="待我验收" className="flex flex-col">{acceptance.map(item => <li key={item.relayId}><AcceptanceRow projectId={projectId} actorId={actorId} item={item} /></li>)}</ul>}
    </PageSection>
    <PageSection title="等我使用的交付" action={<span className={mutedText}>{deliveryCountText(deliveries)}</span>}
      description="任务声明你是这次交付的使用者，你还没有记录“已使用”。打开任务的“交付与使用”读成果，并记录用过的版本和结果。你记过“使用失败”的交付由执行者返工，不在这里列出。">
      <ReadState read={deliveries} what="等我使用的交付" />
      <DeliveryList projectId={projectId} actorId={actorId} value={deliveries.data} />
    </PageSection>
    <PageSection title="待我决定" action={<span className={mutedText}>{countText(decisions, decide?.length)}</span>}
      description="等你决定的事：职责提案、阶段提案、任务讨论里指名问你的问题，以及被明确请你确认的事项。每项写明是什么、谁提的、什么时候；打开它的决定位置，或直接在这里答复，决定后从这里消失。">
      <ReadState read={decisions} what="待我决定" />
      {decide?.length === 0 && <p className="text-small text-text-secondary">当前没有等你决定的事项。</p>}
      {!!decide?.length && <ul aria-label="待我决定" className="flex flex-col">{decide.map(item => <li key={`${item.kind}:${item.id}`}><DecisionRow context={context} item={item} /></li>)}</ul>}
    </PageSection>
    <PageSection title="依据变化" action={<span className={mutedText}>{countText(impacts, pending?.length)}</span>}
      description="任务固定的依据出现新版。在任务的“依据与影响”里决定采用新版还是保留原依据。">
      <ReadState read={impacts} what="依据变化" />
      {pending?.length === 0 && <p className="text-small text-text-secondary">当前没有待复核的依据变化。</p>}
      {!!pending?.length && <ul aria-label="依据变化" className="flex flex-col">{pending.map(item => <li key={item.id}><ImpactRow projectId={projectId} actorId={actorId} item={item} /></li>)}</ul>}
    </PageSection>
    <p className={mutedText}>待办任务在任务表格里按“待办”筛选查看。<a className="ml-1 text-primary hover:underline" href={taskListRoute(projectId, { ...defaultTaskListView, filter: "todo" })}>打开待办任务</a></p>
  </div>;
}

/** 2 项; when not every open task was read, the found ones are a floor, never the whole. */
function deliveryCountText(read: Read<DeliveriesForMe>): string {
  if (read.data === undefined) return read.error ? "暂不可读取" : "正在读取";
  return read.data.complete ? `${read.data.items.length} 项` : `至少 ${read.data.items.length} 项`;
}

function DeliveryList({ projectId, actorId, value }: { projectId: string; actorId: string; value: DeliveriesForMe | undefined }) {
  if (!value) return null;
  const partial = !value.complete && <p className="text-small text-text-secondary">只读了前 {value.tasksRead} 项未关闭的任务，后面的还没有读到，无法判断是否还有等你使用的交付。</p>;
  if (!value.items.length) return partial || <p className="text-small text-text-secondary">当前没有等你使用的交付。</p>;
  return <>
    <ul aria-label="等我使用的交付" className="flex flex-col">{value.items.map(item => <li key={item.deliveryId}><DeliveryRow projectId={projectId} actorId={actorId} item={item} /></li>)}</ul>
    {partial}
  </>;
}

function DeliveryRow({ projectId, actorId, item }: { projectId: string; actorId: string; item: DeliveryForMe }) {
  const delivered = item.deliveredAt ? `交付于 ${date(item.deliveredAt)}` : "交付时间未读回";
  const when = [delivered, ...item.last?.at ? [`你上次记录于 ${date(item.last.at)}`] : [],
    ...item.othersObserved ? ["这次交付最近一条观察来自别人，你的观察按任务记录核对"] : []].join(" · ");
  // What is asked of me and where I stand lead; the time and the note on others' observations wrap below.
  return <div className="flex flex-col gap-1 border-t border-border py-1 first:border-t-0">
    <ListRow href={deliveryLink(projectId, item.taskId, actorId)} title={item.title}
      meta={`${useRequirementText(item.useRequired)} · ${lastUseText(item.last)}`} trailing={<span className="text-primary">去使用</span>} />
    <p className={`${mutedText} px-3`}>{when}</p>
    <FullIdentifiers className="px-3" rows={[{ label: "当前交付", value: item.deliveryId }, { label: "任务修订", value: item.taskRevisionId }]} />
  </div>;
}

function AcceptanceRow({ projectId, actorId, item }: { projectId: string; actorId: string; item: AcceptanceHumanItem }) {
  const task = nameOnly("任务", useTaskName(projectId, item.taskId));
  const progress = `${item.readAt ? `读于 ${date(item.readAt)}` : "尚未读取"} · ${item.observationId ? "已有使用观察" : "尚未留使用观察"}`;
  return <div className="flex flex-col gap-1 border-t border-border py-1 first:border-t-0">
    <ListRow href={inboxTaskLink(projectId, item.taskId, actorId)} title={`${item.stage === "formal" ? "正式复验" : "候选验收"} · ${item.scopeDescription}`}
      meta={`${task} · 第 ${item.version} 次安排 · ${progress}`} />
    <p className={`${mutedText} px-3`}>{item.entrypoint ? `入口：${item.entrypoint}` : "按当前固定交付读取"} · 安排于 {date(item.createdAt)}</p>
    <FullIdentifiers className="px-3" rows={[{ label: "验收安排", value: item.relayId }, { label: "固定交付", value: item.deliveryId },
      { label: "任务修订", value: item.taskRevisionId }, { label: "验收范围", value: item.scopeKey }]} />
  </div>;
}

function ImpactRow({ projectId, actorId, item }: { projectId: string; actorId: string; item: Impact }) {
  const task = nameOnly("任务", useTaskName(projectId, item.taskId));
  return <div className="flex flex-col gap-1 border-t border-border py-1 first:border-t-0">
    <ListRow href={inboxTaskLink(projectId, item.taskId, actorId, "basis")} title={task} meta={`依据有新版待复核 · 发现于 ${date(item.createdAt)}`}
      trailing={<span className="text-primary">查看影响</span>} />
    <FullIdentifiers className="px-3" rows={[{ label: "依据文档", value: item.documentId }, { label: "固定修订", value: item.fromRevisionId },
      { label: "新采纳修订", value: item.toRevisionId }]} />
  </div>;
}

function DecisionRow({ context, item }: { context: MutationContext; item: DecisionItem }) {
  const link = decisionLink(context.projectId, item, context.principal.actorId);
  const meta = `${decisionKindText[item.kind]} · ${item.proposedBy} 提出 · ${date(item.at)}`;
  return <div className="flex flex-col gap-1 border-t border-border py-1 first:border-t-0">
    {link ? <ListRow href={link} title={item.title} meta={meta} trailing={<span className="text-primary">去决定</span>} />
      : <div className="px-3 py-2"><p className="text-body font-medium text-foreground">{item.title}</p><p className={mutedText}>{meta}</p></div>}
    <p className={`${mutedText} px-3`}>{item.detail}</p>
    {item.kind === "decision_request" && <div className="px-3">
      <ActionForm context={context} embedded title="答复" fields={[
        item.options.length ? { name: "answer", label: "你的决定", kind: "select" as const, options: item.options.map(value => option(value, value)) } : { name: "answer", label: "你的决定", kind: "textarea" as const },
        { name: "reason", label: "理由", kind: "textarea" as const }]}
        build={values => ({ type: "decision.request.answer", requestId: item.id, expectedVersion: item.version, answer: values.answer, reason: values.reason })} />
    </div>}
    <FullIdentifiers className="px-3" rows={[{ label: item.kind === "task_question" ? "问题事件" : "编号", value: item.id }]} />
  </div>;
}
