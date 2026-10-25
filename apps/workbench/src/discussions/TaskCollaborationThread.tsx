import { useEffect, useRef, useState } from "react";
import type { DiscussionEvent, DiscussionRecord, TaskCollaborationPayload } from "@evoloop/contracts/discussions";
import { api, errorText } from "../api";
import { date, href } from "../ui/shared";
import "./taskCollaboration.css";

type Thread = { record: DiscussionRecord; events: DiscussionEvent[] };
type DocumentRef = { documentId: string; revisionId: string };
const key = encodeURIComponent;
const short = (id: string) => id.slice(0, 8);
const kindLabel = { question: "提问", answer: "答复", progress: "进展", blocker: "阻塞", handoff: "交接", result: "结果" };
const stageLabel = { received: "已收到", read: "已阅读", adopted: "已采用", resolved: "已解决" };
const actionLabel = { started: "已开始", succeeded: "已完成", failed: "执行失败", unknown: "结果未知" };
function fixedDocument(projectId: string, reference: DocumentRef, label: string) {
  return <a href={href(projectId, "document", reference.documentId, reference.revisionId)}>{label} · 固定修订 {short(reference.revisionId)}</a>;
}

export function TaskCollaborationThread({ token, projectId, taskId, refresh }: { token: string; projectId: string; taskId: string; refresh: number }) {
  const [threads, setThreads] = useState<Thread[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [partial, setPartial] = useState(false);
  const [observedAt, setObservedAt] = useState("");
  const [readVersion, setReadVersion] = useState(0);
  const rootRef = useRef<HTMLElement>(null);
  useEffect(() => {
    let active = true;
    const client = api(token);
    setLoading(true); setError(""); setPartial(false);
    void (async () => {
      let cursor: string | undefined;
      const seen = new Set<string>();
      const matches = new Map<string, DiscussionRecord>();
      let pages = 0, truncated = false;
      do {
        const page = await client.discussions(projectId, cursor);
        if (!active) return;
        if (page.items.length > 50 || page.items.some(record => record.projectId !== projectId)) throw new Error("协作分页响应与当前项目不符");
        for (const record of page.items) if (record.kind === "task_collaboration" && record.task?.id === taskId) {
          if (!matches.has(record.id) && matches.size >= 20) { truncated = true; continue; }
          matches.set(record.id, record);
        }
        pages++;
        if (page.nextCursor && (page.nextCursor === cursor || seen.has(page.nextCursor))) throw new Error("协作分页游标重复，读取未完成");
        if (page.nextCursor) seen.add(page.nextCursor);
        cursor = page.nextCursor ?? undefined;
        if (truncated || cursor && (pages >= 20 || matches.size >= 20)) { truncated = true; break; }
      } while (cursor);
      if (!active) return;
      const result: Thread[] = [];
      for (const record of matches.values()) {
        const [current, events] = await Promise.all([client.discussion(projectId, record.id), client.discussionEvents(projectId, record.id)]);
        if (!active) return;
        if (current.projectId !== projectId || current.id !== record.id || current.task?.id !== taskId ||
          events.some(event => event.projectId !== projectId || event.discussionId !== record.id)) throw new Error("任务协作详情响应不匹配");
        result.push({ record: current, events: [...events].sort((a, b) => a.version - b.version) });
        setThreads([...result]);
      }
      if (active) { setThreads(result); setPartial(truncated); setObservedAt(new Date().toLocaleString("zh-CN")); setLoading(false); }
    })().catch(cause => { if (active) { setError(errorText(cause)); setLoading(false); } });
    return () => { active = false; };
  }, [token, projectId, taskId, refresh, readVersion]);
  useEffect(() => {
    const reread = () => { if (document.visibilityState === "visible" && rootRef.current?.getClientRects().length) setReadVersion(value => value + 1); };
    window.addEventListener("focus", reread);
    return () => window.removeEventListener("focus", reread);
  }, []);
  return <section className="task-collaboration" ref={rootRef} aria-label="任务协作与待处理问题">
    <div className="task-collaboration-head"><h3>协作与待处理问题</h3><button type="button" onClick={() => setReadVersion(value => value + 1)}>重新读取协作</button></div>
    <p className="task-collaboration-observed">{loading ? "正在读取协作…" : observedAt ? `协作读于 ${observedAt}` : "协作尚未读回"}</p>
    {error && <p className="task-collaboration-error" role="alert">协作读取未完成：{error}。以下是已读范围或上次读回，不能视为完整当前状态。</p>}
    {partial && <p className="task-collaboration-error" role="status">协作列表已达 20 页或 20 个关联频道上限；结果未完整，不能据此判断没有其他问题。</p>}
    {!loading && !error && !partial && threads.length === 0 && <p className="empty">当前没有已登记的任务协作频道。</p>}
    {threads.map(({ record, events }) => <ThreadCard key={record.id} record={record} events={events} projectId={projectId} />)}
  </section>;
}

function ThreadCard({ record, events, projectId }: { record: DiscussionRecord; events: DiscussionEvent[]; projectId: string }) {
  const context = record.collaboration;
  const messageKind = (event: DiscussionEvent) => event.collaborationPayload?.type === "message" ? event.collaborationPayload.kind : null;
  const openQuestions = events.filter(event => messageKind(event) === "question" && !events.some(reply =>
    reply.collaborationPayload?.type === "message" && reply.collaborationPayload.kind === "answer" && reply.collaborationPayload.replyToEventId === event.id));
  return <details className="task-collaboration-thread">
    <summary>{record.question || "任务协作"} · {openQuestions.length ? `${openQuestions.length} 个问题待答` : "无已读到的待答问题"} · v{record.version}</summary>
    <p>固定任务修订 <a href={href(projectId, "task", record.task!.id, record.task!.revisionId)}>{short(record.task!.revisionId)}</a>
      {context && <> · 派出者 {context.issuerActorId} · 接收者 {context.recipientActorId} · 原 Session <a href={`${href(projectId, "runtime")}?session=${key(context.sessionId)}`}>{short(context.sessionId)}</a> · <a href={`${href(projectId, "task", record.task!.id)}?tab=runtime&run=${key(context.runId)}`}>Run {short(context.runId)}</a></>}</p>
    {events.length === 0 && <p>频道已有记录，但尚无协作消息或回执。</p>}
    <ol>{events.filter(event => event.collaborationPayload).map(event => <li key={event.id} id={`collaboration-event-${event.id}`}>
      <EventContent event={event} events={events} projectId={projectId} />
      <small>{event.actorId} · {date(event.createdAt)} · 事件 {short(event.id)}</small>
    </li>)}</ol>
  </details>;
}

function EventContent({ event, events, projectId }: { event: DiscussionEvent; events: DiscussionEvent[]; projectId: string }) {
  const payload = event.collaborationPayload as TaskCollaborationPayload;
  if (payload.type === "message") {
    const answered = payload.kind === "question" && events.some(reply => reply.collaborationPayload?.type === "message" &&
      reply.collaborationPayload.kind === "answer" && reply.collaborationPayload.replyToEventId === event.id);
    return <><strong>{kindLabel[payload.kind]} · 致 {payload.recipientActorId}{payload.kind === "question" ? answered ? " · 已答复" : " · 待答复" : ""}</strong>
      <p>{fixedDocument(projectId, payload.body, "阅读消息正文")}</p>
      {payload.replyToEventId && <p>回复 <button type="button" className="quiet" onClick={() => document.getElementById(`collaboration-event-${payload.replyToEventId}`)?.scrollIntoView({block:"center"})}>事件 {short(payload.replyToEventId)}</button></p>}</>;
  }
  if (payload.type === "receipt") return <><strong>{stageLabel[payload.stage]} · 消息 {short(payload.messageEventId)}</strong>
    <p>{fixedDocument(projectId, payload.evidence, "阅读回执证据")}</p>
    {payload.stage === "adopted" && payload.continuation && <p>已记录采用至 Run {short(payload.continuation.runId)} · Task 修订 {short(payload.continuation.taskRevisionId)}；实际运行仍需单独核对。</p>}</>;
  if (payload.type === "action_request") {
    const decision = events.find(candidate => candidate.collaborationPayload?.type === "action_decision" && candidate.collaborationPayload.requestEventId === event.id);
    const decisionState = decision?.collaborationPayload?.type === "action_decision" ? decision.collaborationPayload.decision : null;
    const execution = events.find(candidate => candidate.collaborationPayload?.type === "action_execution" && candidate.collaborationPayload.requestEventId === event.id);
    return <><strong>工程动作请求 · {payload.actionType} · {execution ? "有独立执行回执，结果另核" : decisionState === "approved" ? "已批准，未见执行回执" : decisionState === "rejected" ? "已拒绝" : decisionState === "expired" ? "已过期" : "待明确决定"}</strong>
    <p>请求执行者 {payload.executorActorId} · 仓库 {payload.scope.repository} · 工作树 <code>{payload.scope.worktree}</code></p>
    <p>精确路径：{payload.scope.paths.join("、")} · 截止 {date(payload.expiresAt)}</p>
    <p>{fixedDocument(projectId, payload.detail, "阅读动作范围与理由")}</p></>;
  }
  if (payload.type === "action_decision") return <><strong>工程动作决定 · {payload.decision === "approved" ? "批准" : payload.decision === "rejected" ? "拒绝" : "已过期"}</strong>
    <p>针对请求 {short(payload.requestEventId)}；决定者 {event.actorId}。{fixedDocument(projectId, payload.evidence, "阅读决定依据")}</p></>;
  return <><strong>工程动作执行回执 · {actionLabel[payload.state]}</strong>
    <p>实际执行者 {event.actorId}</p>
    <p>请求 {short(payload.requestEventId)} · 决定 {short(payload.decisionEventId)} · 稳定操作 ID <code>{payload.externalOperationId}</code></p>
    <p>{fixedDocument(projectId, payload.artifact, "阅读执行产物")}</p></>;
}
