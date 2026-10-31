import { useEffect, useRef, useState } from "react";
import type { DiscussionRecord } from "@evoloop/contracts/discussions";
import { errorText, safeArtifactHref } from "../api";
import { date } from "../ui/shared";
import type { MutationContext } from "../workflow/ActionForm";
import { allocationRelations, type AllocationTrace } from "./allocationClient";
import { useAllocationChanges } from "./useAllocationChanges";
import { allocationSessionKey, useAllocationNames, type AllocationKnownNames } from "./useAllocationNames";

const status = { current: "当前修订", changed: "修订已改变", unavailable: "目标暂不可核实" } as const;
const assignmentStatus = { current: "当前承接", historical: "历史承接", unknown: "当前承接待核" } as const;
const taskAcceptanceGap = {
  "no-assignment": "该 Task 修订尚无分派记录",
  "not-accepted": "该 Task 修订已有分派，尚无接受记录",
  "different-task-revision": "仅其他 Task 修订有分派记录",
  unavailable: "该 Task 固定修订暂不可核实",
} as const;

function stageJourneyHref(projectId: string): string { return `#/p/${encodeURIComponent(projectId)}/journey`; }

export function AllocationTraceCard({ trace, projectId, names }: { trace: AllocationTrace; projectId: string; names: Record<string, string> }) {
  const relation = trace.relation;
  const history = !trace.decisionIsLatest;
  const targetName = relation.kind === "decision-target" && relation.target.kind !== "stage"
    ? names[`${relation.target.kind}:${relation.target.id}`] : undefined;
  const taskName = relation.kind === "task-recipient" ? names[`task:${relation.task.id}`] : undefined;
  const sessionName = relation.kind === "task-recipient"
    ? names[`session:${allocationSessionKey(relation.assignment.target)}`] : undefined;
  return <article className="discussion-relation-card">
    {relation.kind === "decision-target" ? <>
      <strong>{relation.target.kind === "role" ? "正式关联职责" : relation.target.kind === "task" ? "正式关联任务" : relation.target.kind === "document" ? "正式关联文档" : "正式关联阶段"}{targetName && ` · ${targetName}`}</strong>
      <p>{relation.target.kind === "task"
        ? <a href={`#/p/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(relation.target.id)}?revision=${encodeURIComponent(relation.target.revisionId)}`}>{targetName ? "查看该任务固定修订" : "任务名称暂不可读 · 查看固定修订"}</a>
        : relation.target.kind === "role"
          ? <a href={`#/p/${encodeURIComponent(projectId)}/roles?role=${encodeURIComponent(relation.target.id)}`}>{targetName ? "查看该职责档案" : "职责名称暂不可读 · 查看档案"}</a>
          : relation.target.kind === "document"
            ? <a href={`#/p/${encodeURIComponent(projectId)}/documents/${encodeURIComponent(relation.target.id)}?revision=${encodeURIComponent(relation.target.revisionId)}`}>{targetName ? "查看该文档固定修订" : "文档名称暂不可读 · 查看固定修订"}</a>
            : <>阶段 v{relation.target.version} · <a href={stageJourneyHref(projectId)}>查看当前阶段入口</a>（不是固定版本历史）</>} · {status[relation.targetStatus]}</p>
      {relation.target.kind === "task" && relation.taskAcceptanceGap !== undefined && <small>
        {relation.taskAcceptanceGap === null
          ? "该修订存在已接受路径；具体接收者可能在后续页。"
          : taskAcceptanceGap[relation.taskAcceptanceGap]}
      </small>}
    </> : <>
      <strong>{sessionName ?? "Session 名称暂不可读"} 曾接手 {taskName ?? "名称暂不可读的任务"}</strong>
      <p><a href={`#/p/${encodeURIComponent(projectId)}/sessions?session=${encodeURIComponent(allocationSessionKey(relation.assignment.target))}`}>打开该 Session</a>
        {relation.assignment.target.kind === "external" ? " · 外部连接" : " · 项目受管"} · {assignmentStatus[relation.assignmentStatus]}</p>
      <p>对应 <a href={`#/p/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(relation.task.id)}?revision=${encodeURIComponent(relation.task.revisionId)}`}>任务固定修订</a> · {status[relation.taskRevisionStatus]}</p>
      <small>{relation.assignment.method === "direct" ? "指定执行者本人确认" : "负责人观察到接手"} · {date(relation.assignment.acceptedAt)} · 分派 v{relation.assignment.version}</small>
      {relation.assignment.method === "lead-observed" && <small>负责人观察记录；这不是接收者亲签。</small>}
    </>}
    {history && <small>关联历史决定；当前决定已变化，后续关系需重新核对。</small>}
    {trace.decisionDocumentRevisionId && <p><a href={`#/p/${encodeURIComponent(projectId)}/documents/${encodeURIComponent(trace.discussion.document.id)}?revision=${encodeURIComponent(trace.decisionDocumentRevisionId)}`}>阅读这次决定所依据的固定原文</a></p>}
    <details><summary>固定来源与标识</summary><ul>
      <li>关系 ID <code>{trace.id}</code> · 决定事件 <code>{trace.decisionEventId}</code>{trace.decisionDocumentRevisionId && <> · 决定固定修订 <code>{trace.decisionDocumentRevisionId}</code></>}</li>
      {relation.kind === "decision-target"
        ? <li>目标 ID <code>{relation.target.id}</code> · {relation.target.kind === "stage" ? <>固定版本 v{relation.target.version}</> : <>固定修订 <code>{relation.target.revisionId}</code></>} · 行动事件 <code>{relation.actionEventId}</code></li>
        : <li>Session <code>{allocationSessionKey(relation.assignment.target)}</code> · Task ID <code>{relation.task.id}</code> · Task 固定修订 <code>{relation.task.revisionId}</code> · 行动事件 <code>{relation.taskActionEventId}</code>{relation.assignment.method === "lead-observed" && <> · 观察者 <code>{relation.assignment.observerActorId}</code></>}</li>}
      {trace.sources.map((source, index) => {
        const link = source.kind === "stage"
          ? source.href === stageJourneyHref(projectId) ? source.href : null
          : safeArtifactHref(source.href, projectId);
        return <li key={`${source.kind}:${source.id}:${index}`}>{link ? <a href={link}>{source.kind} · {source.id}</a> : <span>{source.kind} · {source.id}</span>}{source.revision && ` · ${source.revision}`}{source.kind === "stage" && " · 链接打开当前阶段入口；固定版本需另行核对"}</li>;
      })}</ul></details>
  </article>;
}

export function AllocationRelationsPanel({ context, record, refresh, known, namesReady }: { context: MutationContext; record: DiscussionRecord;
  refresh: number; known: AllocationKnownNames; namesReady: boolean }) {
  const [items, setItems] = useState<AllocationTrace[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [moreBusy, setMoreBusy] = useState(false);
  const [error, setError] = useState("");
  const [partial, setPartial] = useState(false);
  const [limitations, setLimitations] = useState<string[]>([]);
  const [observedAt, setObservedAt] = useState<string | null>(null);
  const [readAgain, setReadAgain] = useState(0);
  const epoch = useRef(0);
  const root = useRef<HTMLElement>(null);
  const loadedScope = useRef("");
  const changesError = useAllocationChanges(context.token, context.projectId, root, () => setReadAgain(value => value + 1));
  const names = useAllocationNames(context.token, context.projectId, items, known, namesReady && !loading,
    `${record.id}\0${refresh}\0${readAgain}`);
  useEffect(() => {
    const current = ++epoch.current;
    const controller = new AbortController();
    const scope = `${context.token}\0${context.projectId}\0${record.id}`;
    if (loadedScope.current !== scope) {
      loadedScope.current = scope; setItems([]); setCursor(null); setPartial(false); setLimitations([]); setObservedAt(null);
    }
    setLoading(true); setMoreBusy(false); setCursor(null); setError("");
    allocationRelations(context.token, context.projectId, { discussionId: record.id }, undefined, controller.signal)
      .then(page => {
        if (epoch.current !== current) return;
        if (page.resetRequired) throw new Error("关系读取范围已变化，请重新读取。");
        setItems(page.items); setCursor(page.nextCursor); setPartial(page.metadata.partial); setLimitations(page.metadata.limitations);
        setObservedAt(page.metadata.generatedAt);
      })
      .catch(cause => { if (epoch.current === current) setError(errorText(cause)); })
      .finally(() => { if (epoch.current === current) setLoading(false); });
    return () => { controller.abort(); if (epoch.current === current) epoch.current++; };
  }, [context.token, context.projectId, record.id, refresh, readAgain]);
  async function more() {
    if (!cursor || moreBusy || loading) return;
    const current = epoch.current, previous = cursor;
    setMoreBusy(true); setError("");
    try {
      const page = await allocationRelations(context.token, context.projectId, { discussionId: record.id }, previous);
      if (epoch.current !== current) return;
      if (page.resetRequired) { setReadAgain(value => value + 1); return; }
      if (page.nextCursor === previous) throw new Error("关系游标没有前进，请重新读取整条讨论。");
      setItems(before => [...new Map([...before, ...page.items].map(item => [item.id, item])).values()]);
      setCursor(page.nextCursor); setPartial(before => before || page.metadata.partial); setObservedAt(page.metadata.generatedAt);
      setLimitations(before => [...new Set([...before, ...page.metadata.limitations])]);
    } catch (cause) { if (epoch.current === current) setError(errorText(cause)); }
    finally { if (epoch.current === current) setMoreBusy(false); }
  }
  return <aside ref={root} className="discussion-exploration-column discussion-exploration-relations" aria-label="正式关系与具体承接">
    <h2>正式关系与确切承接</h2>
    <p className="muted">只显示决定后的正式链接及相同 Task 修订的接受记录。名称是当前展示线索，固定事实以修订和来源为准；接受不等于运行、交付或实际使用。</p>
    <button type="button" disabled={loading} onClick={() => setReadAgain(value => value + 1)}>重新读取关系</button>
    {observedAt && <p className="muted">关系读于 {date(observedAt)}；变化检查失败时保留此读数。</p>}
    {loading && <p>正在核对关系来源…{observedAt && "下方为上次读数。"}</p>}
    {changesError && <p role="status" className="discussion-relation-error">{changesError}</p>}
    {error && <p role="alert" className="discussion-relation-error">关系读取失败：{error}。不能据此判断没有承接。</p>}
    {partial && <p role="status" className="discussion-relation-error">来源读取不完整，以下关系只能作为已见部分。</p>}
    {limitations.length > 0 && <details><summary>来源限制 · {limitations.length} 项</summary><ul>{limitations.map(item => <li key={item}>{item}</li>)}</ul></details>}
    {!loading && !error && items.length === 0 && <p className="empty">{partial
      ? "来源读取不完整，暂不能判断是否存在正式关系。"
      : cursor ? "当前页没有关系；后续页面尚未读完。" : "尚无正式后续对象链接；讨论上下文和拟交接会话不构成实际承接。"}</p>}
    {items.map(item => <AllocationTraceCard key={item.id} trace={item} projectId={context.projectId} names={names} />)}
    {cursor && <button type="button" disabled={moreBusy || loading} onClick={() => void more()}>{moreBusy ? "正在读取…" : "加载更多关系"}</button>}
  </aside>;
}
