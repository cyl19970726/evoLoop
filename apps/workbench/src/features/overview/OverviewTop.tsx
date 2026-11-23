// The overview's first screen below the header (docs/frontend/pages/overview.md): ① 要你决定或处理的, ② 请你亲自用的, ③ 结果是否有效, and the
// one line ⑤ 组织自己在处理的. ①②'s rows come from the same reads as 待我处理 (features/workflow/inboxReads.ts), so the numbers agree with its entry.
import * as React from "react";
import { useState, type ReactNode } from "react";
import { Button, StatusTag } from "@evoloop/ui";
import { ChevronRight } from "lucide-react";
import { api } from "../../shared/api";
import { useProjectQuery } from "../../shared/query";
import { date, href } from "../../shared/ui/shared";
import { useTaskName } from "../../shared/ui/RecordName";
import { nameOnly } from "../../shared/workPresentation";
import { holdLine, holdSummary, holdTarget } from "../../shared/providerHoldPresentation";
import { decisionKindText, decisionLink, inboxTaskLink, useInboxReads, useRequirementText as requirementText } from "../workflow";
import { latestReview, moreText, outcomeText, priorityLimit, priorityTitle, type StalledTask } from "./overviewFirstScreen";
import type { ProjectOutcome } from "./contextPresentation";

const muted = "text-caption text-muted-foreground";
const block = "flex min-w-0 flex-col gap-0.5 border-t border-border pt-2.5 first:border-t-0 first:pt-0";

function Row({ to, children, tag, when }: { to: string; children: ReactNode; tag?: ReactNode; when?: ReactNode }) {
  return <li className="border-t border-border first:border-t-0">
    <a href={to} className="-mx-2 flex flex-col gap-0.5 rounded-md px-2 py-1.5 hover:bg-field/60 focus-visible:shadow-[var(--focus-ring)] outline-none compact:flex-row compact:items-baseline compact:gap-3">
      <span className="min-w-0 flex-1 text-small text-foreground">{children}</span>
      {tag}
      {when && <span className={`shrink-0 ${muted}`}>{when}</span>}
    </a>
  </li>;
}

function BlockHead({ title, aside }: { title: string; aside?: ReactNode }) {
  return <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5"><h2 className="text-label font-semibold text-foreground">{title}</h2>{aside}</div>;
}

/** Up to three rows; the rest open in place from "还有 K 项". */
function Rows({ label, rows, total, extra }: { label: string; rows: ReactNode[]; total: number; extra?: string }) {
  const [open, setOpen] = useState(false);
  const more = moreText(total);
  return <>
    <ul aria-label={label} className="m-0 flex list-none flex-col p-0">{open ? rows : rows.slice(0, priorityLimit)}</ul>
    {(more || extra) && <p className={`m-0 ${muted}`}>
      {more && <Button variant="ghost" size="compact" aria-expanded={open} onClick={() => setOpen(value => !value)} className="-ml-2">{open ? "收起" : more}</Button>}
      {extra}
    </p>}
  </>;
}

function TaskRow({ projectId, actorId, taskId, lead, tab, when }: { projectId: string; actorId: string; taskId: string; lead: string; tab?: "delivery" | "basis"; when: string }) {
  const task = nameOnly("任务", useTaskName(projectId, taskId));
  return <Row to={inboxTaskLink(projectId, taskId, actorId, tab, "overview")} when={when}>{lead}：{task}</Row>;
}

/** ① 要你决定或处理的: the five kinds of 待我处理 that only the person can act on, then the Tasks stalled for three days or more. */
export function PriorityBlock({ projectId, actorId, enabled, stalled, work }: { projectId: string; actorId: string; enabled: boolean; stalled: StalledTask[]; work: "reading" | "failed" | "ready" }) {
  const reads = useInboxReads(projectId, actorId, enabled);
  const { acceptance, impacts, decisions, alerts, holds } = reads;
  const held = holdSummary(holds.data);
  const rows: ReactNode[] = [];
  for (const hold of held?.holds ?? []) {
    const single = { holds: [hold], sessionIds: hold.sessionIds, queuedMessages: hold.queuedMessages };
    const opened = holds.data?.items.find(item => item.id === hold.id)?.openedAt;
    const target = holdTarget(projectId, single);
    // One affected agent opens that agent; several (or none) open the runtime-problem category of 待我处理, which lists exactly the agents the line counts.
    rows.push(<Row key={`hold:${hold.id}`} to={target === `/p/${projectId}/inbox` ? `${target}#inbox-runtime` : target} tag={<StatusTag tone="blocked" label="受阻" />}
      when={opened ? `自 ${date(opened)}` : undefined}>{holdLine(single, null)}</Row>);
  }
  for (const item of decisions.data?.items ?? []) rows.push(<Row key={`decision:${item.kind}:${item.id}`} to={decisionLink(projectId, item, actorId, "overview") ?? `/p/${projectId}/inbox`}
    when={`${item.proposedBy} 提出 · ${date(item.at)}`}>{decisionKindText[item.kind]}：{item.title}</Row>);
  for (const item of acceptance.data?.items ?? []) rows.push(<TaskRow key={`acceptance:${item.relayId}`} projectId={projectId} actorId={actorId} taskId={item.taskId}
    lead={item.stage === "formal" ? "待你正式复验" : "待你验收"} tab="delivery" when={`安排于 ${date(item.createdAt)}`} />);
  for (const item of impacts.data?.filter(entry => entry.state === "pending") ?? []) rows.push(<TaskRow key={`impact:${item.id}`} projectId={projectId} actorId={actorId} taskId={item.taskId}
    lead="依据有新版待你复核" tab="basis" when={`发现于 ${date(item.createdAt)}`} />);
  (alerts.data ?? []).forEach((item, index) => rows.push(<Row key={`usage:${item.kind}:${item.sessionId ?? "day"}:${index}`}
    to={item.sessionId ? `/p/${projectId}/sessions?session=${encodeURIComponent(`owned:${item.sessionId}`)}` : `/p/${projectId}/inbox#inbox-usage`}>{item.kind === "budget" ? "今日用量" : "智能体上下文"}：{item.text}</Row>));
  for (const task of stalled) rows.push(<Row key={`stalled:${task.taskId}`} to={href(projectId, "task", task.taskId)}
    tag={<StatusTag tone="blocked" label={`卡了 ${task.days} 天`} />}>{task.title}：{task.reason}</Row>);
  const failedKinds = [["运行问题", holds.isError], ["待我决定", decisions.isError], ["待我验收", acceptance.isError], ["依据变化", impacts.isError], ["用量告警", alerts.isError], ["卡住的任务", work === "failed"]]
    .filter(([, failed]) => failed).map(([name]) => name as string);
  // The usage alerts are derived from a source that may be absent without being a failure, so "the whole column" is the four reads that must exist.
  const noneRead = [holds, decisions, acceptance, impacts].every(read => read.isError);
  const unread = [holds, decisions, acceptance, impacts, alerts].some(read => read.data === undefined && !read.isError) || work === "reading";
  const retry = <Button variant="ghost" size="compact" onClick={() => { for (const read of [holds, decisions, acceptance, impacts, alerts]) void read.refetch(); }} className="-ml-2">重试</Button>;
  return <section aria-label="要你决定或处理的" data-overview-block="priority" className={block}>
    <BlockHead title={priorityTitle(failedKinds.length || unread ? null : rows.length)}
      aside={<a href={`/p/${projectId}/inbox`} className={`${muted} text-primary hover:underline`}>全部在待我处理</a>} />
    {rows.length > 0 ? <Rows label="要你决定或处理的" rows={rows} total={rows.length} /> : failedKinds.length ? null
      : unread ? <p className={`m-0 ${muted}`} role="status">正在读取…</p>
        : <p className="m-0 text-small text-text-secondary">现在没有等你决定或处理的事。</p>}
    {failedKinds.length > 0 && <p className={`m-0 ${muted}`} role="status">{rows.length && !noneRead ? `有 ${failedKinds.length} 类没读到（${failedKinds.join("、")}），上面只是读到的部分。`
      : `这一栏读不到：读取失败不代表没有事。${rows.length ? "上面只有卡住的任务，是从任务列表读到的。" : ""}`}{retry}</p>}
  </section>;
}

/** ② 请你亲自用的: the deliveries that name the signed-in person as their consumer and wait for their use. */
export function UseBlock({ projectId, actorId, enabled }: { projectId: string; actorId: string; enabled: boolean }) {
  const { deliveries } = useInboxReads(projectId, actorId, enabled);
  const items = deliveries.data?.items ?? [];
  const rows = items.map(item => <Row key={item.deliveryId} to={inboxTaskLink(projectId, item.taskId, actorId, "delivery", "overview")}
    when={`${item.deliveredAt ? `交付于 ${date(item.deliveredAt)}` : "交付时间未读回"} · ${requirementText(item.useRequired)}`}>{item.title}</Row>);
  const partial = deliveries.data && !deliveries.data.complete;
  return <section aria-label="请你亲自用的" data-overview-block="use" className={block}>
    <BlockHead title="请你亲自用的" aside={deliveries.data && !!items.length ? <span className={muted}>{partial ? `至少 ${items.length}` : items.length} 项</span> : undefined} />
    {rows.length > 0 ? <Rows label="请你亲自用的" rows={rows} total={rows.length}
      extra={partial ? `只读了前 ${deliveries.data!.tasksRead} 项未关闭的任务，后面的还没有读到。` : undefined} />
      : deliveries.isError ? <p className={`m-0 ${muted}`} role="status">这一栏读不到：读取失败不代表没有要你用的交付。<Button variant="ghost" size="compact" onClick={() => void deliveries.refetch()}>重试</Button></p>
        : deliveries.data === undefined ? <p className={`m-0 ${muted}`} role="status">正在读取…</p>
          : partial ? <p className={`m-0 ${muted}`}>只读了前 {deliveries.data.tasksRead} 项未关闭的任务，读到的里面没有；后面的还没有读到，不能说没有。</p>
            : <p className="m-0 text-small text-text-secondary">现在没有等你亲自用的交付。</p>}
  </section>;
}

/** ③ 结果是否有效: the latest recorded use of the current deliveries, three at most. */
export function OutcomeBlock({ projectId, outcomes, state }: { projectId: string; outcomes: ProjectOutcome[]; state: "reading" | "failed" | "ready" }) {
  const rows = outcomes.slice(0, priorityLimit).map(item => <Row key={item.delivery.id} to={`${href(projectId, "task", item.taskId)}?tab=delivery`} when={date(item.observation.createdAt)}>
    {outcomeText(item.title, item.observation.observerKind, item.observation.observer, item.observation.result)}</Row>);
  return <section aria-label="结果是否有效" data-overview-block="outcome" className={block}>
    <BlockHead title="结果是否有效" />
    {rows.length ? <ul aria-label="结果是否有效" className="m-0 flex list-none flex-col p-0">{rows}</ul>
      : state === "reading" ? <p className={`m-0 ${muted}`} role="status">正在读取…</p>
        : state === "failed" ? <p className={`m-0 ${muted}`} role="status">这一栏读不到：使用反馈的来源没有读全，读取失败不代表没有使用。</p>
          : <p className="m-0 text-small text-text-secondary">最近没有使用反馈。</p>}
  </section>;
}

/** ⑤ One line about what the organisation handles itself; it opens to the 调度动态 (where it is stuck now, the latest events). Folded by default. */
export function OrganisationLine({ text, children }: { text: string; children: ReactNode }) {
  return <details className="group border-t border-border pt-2 text-small" data-overview-block="organisation">
    <summary className="flex cursor-pointer list-none items-center gap-1.5 text-text-secondary hover:text-foreground [&::-webkit-details-marker]:hidden">
      <ChevronRight aria-hidden="true" className="size-3.5 shrink-0 transition-transform group-open:rotate-90" /><span>{text}</span></summary>
    <div className="mt-2">{children}</div>
  </details>;
}

/** A folded line (⑥): one sentence, the original card inside, nothing deleted. */
export function FoldLine({ label, summary, children, ...rest }: { label: string; summary: string; children: ReactNode } & React.HTMLAttributes<HTMLDetailsElement>) {
  return <details className="group text-small" aria-label={label} {...rest}>
    <summary className="flex cursor-pointer list-none items-center gap-1.5 text-text-secondary hover:text-foreground [&::-webkit-details-marker]:hidden">
      <ChevronRight aria-hidden="true" className="size-3.5 shrink-0 transition-transform group-open:rotate-90" /><span className="min-w-0 truncate">{summary}</span></summary>
    <div className="mt-2">{children}</div>
  </details>;
}

/**
 * 最新复盘 in the header: opens the newest 组织复盘 document itself. When none can be read it opens the list of 复盘 (never a guess). The 每日简报 entry waits
 * for the document list to take a search term from the address (and for the briefing to have a type): it is not here yet (pages/overview.md).
 */
export function LatestReviewLink({ projectId, active }: { projectId: string; active: boolean }) {
  const read = useProjectQuery(projectId, ["overview", "latest-review"], async signal => {
    const items = []; let cursor: string | undefined;
    for (let page = 0; page < 4; page++) {
      const result = await api().documents(projectId, cursor, "organization_review", undefined, signal);
      if (result.items.some(item => item.projectId !== projectId || item.kind !== "organization_review")) throw new Error("复盘列表返回了其他范围的文档");
      items.push(...result.items);
      if (!result.nextCursor) return { latest: latestReview(items), whole: true };
      cursor = result.nextCursor;
    }
    return { latest: latestReview(items), whole: false };
  }, { enabled: active, retry: false });
  const latest = read.data?.latest;
  const to = latest && read.data?.whole ? href(projectId, "document", latest.id) : `/p/${projectId}/documents?kind=organization_review`;
  return <a href={to} data-overview-latest-review="" className="text-small text-primary hover:underline">最新复盘</a>;
}
