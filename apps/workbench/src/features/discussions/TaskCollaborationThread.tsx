// 当前工作 › 进展与讨论 › 协作与待处理问题 (tasks.md): the task's collaboration channels, each with its messages,
// receipts and engineering action requests in order. Read only: replies and receipts are written by the agents through
// the CLI. Everything here is what the records say; an approval is not an execution and a read receipt is not use.
import { useEffect, useRef, type ReactNode } from "react";
import type { DiscussionEvent, DiscussionRecord, TaskCollaborationPayload } from "@evoloop/contracts/discussions";
import { Button, ErrorState, LoadingState, Notice, RefreshingIndicator } from "@evoloop/ui";
import { errorText } from "../../shared/api";
import { useProjectQuery } from "../../shared/query";
import { FullIdentifiers, type IdentifierRow } from "../../shared/ui/FullIdentifiers";
import { useSessionName } from "../../shared/ui/RecordName";
import { nameOnly } from "../../shared/workPresentation";
import { date, href } from "../../shared/ui/shared";
import {
  actionRequestState, actionTypeLabel, executionStateLabel, isAnswered, messageKindLabel, readTaskCollaboration, receiptStageLabel,
  threadSummary, type CollaborationThread,
} from "./taskCollaborationPresentation";

type DocumentRef = { documentId: string; revisionId: string };
const note = "text-caption text-muted-foreground";
const link = "text-primary hover:underline";

function FixedDocument({ projectId, reference, label }: { projectId: string; reference: DocumentRef; label: string }) {
  return <a className={link} href={href(projectId, "document", reference.documentId, reference.revisionId)}>{label}（固定修订）</a>;
}

function AgentName({ projectId, sessionId }: { projectId: string; sessionId: string }) {
  return <>{nameOnly("智能体", useSessionName(projectId, `owned:${sessionId}`))}</>;
}

function JumpTo({ eventId, children }: { eventId: string; children: ReactNode }) {
  return <button type="button" className={link} onClick={() => document.getElementById(`collaboration-event-${eventId}`)?.scrollIntoView({ block: "center" })}>{children}</button>;
}

export function TaskCollaborationThread({ projectId, taskId, refresh }: { projectId: string; taskId: string; refresh: number }) {
  const read = useProjectQuery(projectId, ["task", taskId, "collaboration"], () => readTaskCollaboration(projectId, taskId));
  const rootRef = useRef<HTMLElement>(null);
  // The page's “重新读取当前任务” moves `refresh`; coming back to the window rereads what is on screen.
  const firstRefresh = useRef(refresh);
  useEffect(() => {
    if (firstRefresh.current === refresh) return;
    firstRefresh.current = refresh;
    void read.refetch();
  }, [refresh]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const reread = () => { if (document.visibilityState === "visible" && rootRef.current?.getClientRects().length) void read.refetch(); };
    window.addEventListener("focus", reread);
    return () => window.removeEventListener("focus", reread);
  }, [read.refetch]); // eslint-disable-line react-hooks/exhaustive-deps
  const data = read.data;
  return <section ref={rootRef} aria-label="任务协作与待处理问题" data-task-collaboration="" className="flex min-w-0 flex-col gap-3">
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <h3 className="text-body font-semibold text-foreground">协作与待处理问题</h3>
      <span className={note}>{data ? `协作读于 ${date(new Date(read.dataUpdatedAt).toISOString())}` : read.isPending ? "正在读取协作…" : "协作尚未读回"}</span>
      <Button size="compact" variant="ghost" className="ml-auto" disabled={read.isFetching} onClick={() => void read.refetch()}>重新读取协作</Button>
    </div>
    {read.isPending && <LoadingState lines={2} label="正在读取协作" />}
    {read.error && !data && <ErrorState title="协作暂不可读取" happened={errorText(read.error)}
      next="可以重新读取；读取失败不代表这项任务没有协作或待答问题。" action={<Button size="compact" onClick={() => void read.refetch()}>重新读取</Button>} />}
    {read.error && data && <Notice tone="waiting" title="上次读回，当前待核对">重新读取协作失败：{errorText(read.error)}。下面是上次读回的协作，不能视为当前状态。</Notice>}
    {read.checking && !read.error && <RefreshingIndicator label="正在核对协作" />}
    {data?.partial && <Notice tone="waiting">协作列表已读到 20 页或 20 个关联频道的上限，结果不完整，不能据此判断没有其他问题。</Notice>}
    {data && !data.partial && data.threads.length === 0 && <p className="text-label text-text-secondary">这项任务还没有登记协作频道。</p>}
    {data && data.threads.length > 0 && <ul className="flex flex-col">
      {data.threads.map(thread => <li key={thread.record.id}><ThreadItem projectId={projectId} thread={thread} /></li>)}
    </ul>}
  </section>;
}

function ThreadItem({ projectId, thread }: { projectId: string; thread: CollaborationThread }) {
  const { record, events } = thread;
  const context = record.collaboration;
  const task = record.task!;
  const shown = events.filter(event => event.collaborationPayload);
  return <details className="group border-t border-border py-3 first:border-t-0">
    <summary className="cursor-pointer text-label font-medium text-foreground [overflow-wrap:anywhere]">{threadSummary(thread)}</summary>
    <div className="mt-2 flex flex-col gap-3 pl-4">
      <p className="text-label text-text-secondary [overflow-wrap:anywhere]">
        <a className={link} href={href(projectId, "task", task.id, task.revisionId)}>频道固定的任务修订</a>
        {context && <> · 派出者 {context.issuerActorId} · 接收者 {context.recipientActorId} · 原智能体 <a className={link}
          href={`${href(projectId, "sessions")}?session=${encodeURIComponent(`owned:${context.sessionId}`)}`}><AgentName projectId={projectId} sessionId={context.sessionId} /></a>
          {" · "}<a className={link} href={`${href(projectId, "task", task.id)}?tab=runtime&run=${encodeURIComponent(context.runId)}`}>发起这次协作的运行</a></>}
      </p>
      {shown.length === 0 && <p className="text-label text-text-secondary">频道已登记，但还没有协作消息或回执。</p>}
      {shown.length > 0 && <ol className="flex flex-col gap-2">{shown.map(event => <li key={event.id} id={`collaboration-event-${event.id}`}
        className="flex min-w-0 scroll-mt-20 flex-col gap-1 border-l-2 border-border py-1 pl-3 text-label text-foreground [overflow-wrap:anywhere]">
        <EventContent projectId={projectId} taskId={task.id} event={event} events={events} />
        <p className={note}>{event.actorId} · {date(event.createdAt)}</p>
      </li>)}</ol>}
      <FullIdentifiers rows={identifiers(record, shown)} />
    </div>
  </details>;
}

function identifiers(record: DiscussionRecord, events: DiscussionEvent[]): IdentifierRow[] {
  const rows: IdentifierRow[] = [{ label: "协作频道", value: record.id }, { label: "固定任务修订", value: record.task?.revisionId }];
  if (record.collaboration) rows.push({ label: "原智能体", value: record.collaboration.sessionId }, { label: "运行", value: record.collaboration.runId });
  for (const event of events) {
    rows.push({ label: "事件", value: event.id });
    const payload = event.collaborationPayload;
    if (payload?.type === "action_execution") rows.push({ label: "外部操作", value: payload.externalOperationId });
    if (payload?.type === "action_request") rows.push({ label: "工作树", value: payload.scope.worktree });
  }
  return rows;
}

function EventContent({ projectId, taskId, event, events }: { projectId: string; taskId: string; event: DiscussionEvent; events: DiscussionEvent[] }) {
  const payload = event.collaborationPayload as TaskCollaborationPayload;
  const title = (text: string) => <p className="font-medium">{text}</p>;
  if (payload.type === "message") {
    const state = payload.kind === "question" ? isAnswered(event, events) ? " · 已答复" : " · 待答复" : "";
    return <>{title(`${messageKindLabel[payload.kind]} · 致 ${payload.recipientActorId}${state}`)}
      <p><FixedDocument projectId={projectId} reference={payload.body} label="阅读消息正文" />
        {payload.replyToEventId && <> · <JumpTo eventId={payload.replyToEventId}>跳到所回复的消息</JumpTo></>}</p></>;
  }
  if (payload.type === "receipt") return <>{title(`${receiptStageLabel[payload.stage]}回执`)}
    <p><FixedDocument projectId={projectId} reference={payload.evidence} label="阅读回执证据" /> · <JumpTo eventId={payload.messageEventId}>跳到对应消息</JumpTo></p>
    {payload.stage === "adopted" && payload.continuation && <p className="text-text-secondary">已记录采用到<a className={link}
      href={`${href(projectId, "task", taskId)}?tab=runtime&run=${encodeURIComponent(payload.continuation.runId)}`}>后续运行</a>；实际运行仍需单独核对。</p>}</>;
  if (payload.type === "action_request") return <>{title(`工程动作请求 · ${actionTypeLabel[payload.actionType] ?? "其他动作"} · ${actionRequestState(event, events)}`)}
    <p className="text-text-secondary">请求执行者 {payload.executorActorId} · 仓库 {payload.scope.repository} · 截止 {date(payload.expiresAt)}</p>
    <p className="text-text-secondary">精确路径：{payload.scope.paths.join("、")}</p>
    <p><FixedDocument projectId={projectId} reference={payload.detail} label="阅读动作范围与理由" /></p></>;
  if (payload.type === "action_decision") return <>{title(`工程动作决定 · ${payload.decision === "approved" ? "批准" : payload.decision === "rejected" ? "拒绝" : "已过期"}`)}
    <p>决定者 {event.actorId} · <JumpTo eventId={payload.requestEventId}>跳到对应请求</JumpTo> · <FixedDocument projectId={projectId} reference={payload.evidence} label="阅读决定依据" /></p></>;
  return <>{title(`工程动作执行回执 · ${executionStateLabel[payload.state]}`)}
    <p>实际执行者 {event.actorId} · <JumpTo eventId={payload.requestEventId}>跳到对应请求</JumpTo> · <JumpTo eventId={payload.decisionEventId}>跳到对应决定</JumpTo></p>
    <p><FixedDocument projectId={projectId} reference={payload.artifact} label="阅读执行产物" /></p></>;
}
