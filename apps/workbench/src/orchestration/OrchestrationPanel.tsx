import { useEffect, useState } from "react";
import type { TaskDetail } from "@evoloop/contracts";
import type { OrchestrationDispatch, OrchestrationEvent, OrchestrationInbox, OrchestrationLoop, OrchestrationSourceFact, OrchestrationSubmission, OrchestrationWorkerDecision } from "@evoloop/contracts/orchestration";
import { errorText } from "../api";
import { Notice } from "../workflow/ActionForm";
import { mergePage, orchestrationClient, type LoopPart, type LoopPartItem, type OrchestrationStatus, type ResultPage, type TaskLoopContext } from "./client";
import { deliveryMeaning, dispatchStateLabel, inboxStateLabel, sealReasonLabel, sourceTriggerLabel, submissionStateLabel } from "./presentation";
import { inTaskContext, nextAction, readableOutcome } from "./summary";
import { taskSectionHref } from "./navigation";
import "./orchestration.css";

interface LoopData {
  inbox: ResultPage<OrchestrationInbox>; dispatches: ResultPage<OrchestrationDispatch>;
  submissions: ResultPage<OrchestrationSubmission>; events: ResultPage<OrchestrationEvent>;
  sources: ResultPage<OrchestrationSourceFact>;
  tasks: ResultPage<TaskDetail>; decisions: Record<string, OrchestrationWorkerDecision>;
  revisionIds: Record<string, Record<number, string>>;
}
const empty = <T,>(): ResultPage<T> => ({ items: [], nextCursor: null });
const short = (id: string) => id.slice(0, 8);
const taskHref = (projectId: string, taskId: string) => `#/p/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}`;
const statusLabel = (value: string) => ({ active: "运行中", paused: "已暂停新派发", stopped: "已停止新派发" }[value] ?? value);
const dispositionLabel = (value: string | null) => ({ no_action: "无后续动作", waiting: "等待", failed: "处理失败", stop: "停止", dispatch: "已请求派发" }[value ?? ""] ?? "未登记");
const outcomeLabel = (value: string) => ({ delivered: "已登记交付结果", no_action: "无后续动作", waiting: "等待", failed: "处理失败" }[value] ?? value);

async function revisionIdsFor(client: ReturnType<typeof orchestrationClient>, dispatches: OrchestrationDispatch[]) {
  const ids: Record<string, Record<number, string>> = {};
  await Promise.all([...new Set(dispatches.map(item => item.taskId))].map(async taskId => {
    try { ids[taskId] = Object.fromEntries((await client.taskRevisions(taskId)).map(item => [item.revision.version,item.revision.id])); }
    catch { /* Fixed link stays visibly unavailable rather than claiming today's Task is the old revision. */ }
  }));
  return ids;
}

async function scopeTitles(client: ReturnType<typeof orchestrationClient>, loops: OrchestrationLoop[]) {
  const labels: Record<string, string> = {};
  await Promise.all(loops.map(async loop => {
    const [goal, stage] = await Promise.allSettled([client.goal(loop.goalId),
      loop.stageId ? client.stage(loop.stageId) : Promise.resolve(null)]);
    const outcome = goal.status === "fulfilled" ? goal.value.outcome : null;
    const deliverable = stage.status === "fulfilled" ? stage.value?.deliverable : null;
    labels[loop.id] = [outcome,deliverable].filter(Boolean).join(" · ") || `判断职责 ${loop.cognitiveRoleId}`;
  }));
  return labels;
}

export function OrchestrationPanel({ token, projectId, refresh, taskId }: { token: string; projectId: string; refresh: number; taskId?: string }) {
  const [status, setStatus] = useState<OrchestrationStatus | null>(null);
  const [loops, setLoops] = useState<ResultPage<OrchestrationLoop>>(empty);
  const [selected, setSelected] = useState<string | null>(null);
  const [overviewError, setOverviewError] = useState("");
  const [loading, setLoading] = useState(true);
  const [epoch, setEpoch] = useState(0);
  const [moreLoops, setMoreLoops] = useState(false);
  const [taskContexts, setTaskContexts] = useState<ResultPage<TaskLoopContext>>(empty);
  const [titles, setTitles] = useState<Record<string,string>>({});
  useEffect(() => {
    let active = true;
    const client = orchestrationClient(token, projectId);
    setLoading(true); setSelected(null); setLoops(empty()); setTaskContexts(empty()); setTitles({}); setStatus(null); setOverviewError("");
    void (async () => {
      if (!taskId) return client.overview();
      const [nextStatus, context] = await Promise.all([client.status(), client.taskContext(taskId)]);
      const related = await Promise.all(context.items.map(item => client.loop(item.loopId)));
      return {status:nextStatus,loops:{items:related,nextCursor:null},context};
    })().then(async ({ status: nextStatus, loops: page, ...rest }) => {
      const labels = await scopeTitles(client,page.items);
      if (!active) return;
      if ("context" in rest && rest.context) setTaskContexts(rest.context);
      setStatus(nextStatus); setLoops(page); setTitles(labels); setSelected(page.items[0]?.id ?? null); setLoading(false);
    }).catch(cause => { if (active) { setOverviewError(errorText(cause)); setLoading(false); } });
    return () => { active = false; };
  }, [token, projectId, refresh, epoch]);
  async function loadMoreLoops() {
    if (taskId) {
      const cursor=taskContexts.nextCursor; if (!cursor || moreLoops) return;
      setMoreLoops(true);
      try {
        const client=orchestrationClient(token,projectId), page=await client.taskContext(taskId,cursor);
        const related=await Promise.all(page.items.map(item=>client.loop(item.loopId)));
        const labels=await scopeTitles(client,related);
        setTaskContexts(current=>({items:[...current.items,...page.items],nextCursor:page.nextCursor}));
        setLoops(current=>mergePage(current,{items:related,nextCursor:null}));setTitles(current=>({...current,...labels}));setOverviewError("");
      } catch (cause) {setOverviewError(errorText(cause));}
      finally {setMoreLoops(false);}
      return;
    }
    const cursor = loops.nextCursor; if (!cursor || moreLoops) return;
    setMoreLoops(true);
    try { const client=orchestrationClient(token,projectId), page = await client.loops(cursor);
      const labels=await scopeTitles(client,page.items);
      setLoops(current => mergePage(current, page)); setTitles(current=>({...current,...labels})); setOverviewError(""); }
    catch (cause) { setOverviewError(errorText(cause)); }
    finally { setMoreLoops(false); }
  }
  return <section className="panel orchestration-panel" aria-label="自动循环观察">
    <div className="panel-head"><h2>自动循环观察</h2><button onClick={() => setEpoch(value => value + 1)}>重新读取</button></div>
    <p className="muted">这里展示受管循环的入站、派发和交付证据。事件是审计记录；Run 完成不表示交付已封存、已使用或 Task 已验收。</p>
    {overviewError && <Notice error>自动循环读取未完成：{overviewError}。当前记录可能不完整。</Notice>}
    {loading && <p>正在读取循环状态…</p>}
    {status && <div className="orch-status">
      <strong>{status.state === "disabled" ? "自动循环未配置／尚未启用" : status.running === false ? "自动循环当前未运行" : "自动循环状态"}</strong>
      <span>{status.state && status.state !== "disabled" ? statusLabel(status.state) : status.running ? "读取器运行中" : "不声称正在自动处理"}</span>
      {status.busy && <span>当前正在核对入站</span>}
      {status.lastError && <p>最近错误：{status.lastError}</p>}
      {status.faults?.map((fault, index) => <p key={index}>运行故障：{typeof fault === "string" ? fault : fault.code}</p>)}
    </div>}
    {!loading && loops.items.length === 0 && !overviewError && <p className="empty">{taskId ? "当前任务没有读到关联的受管循环。" : status?.state === "disabled" ? "自动循环未配置或尚未启用；没有可观察的受管循环。" : "尚未登记受管循环。"}</p>}
    {loops.items.length > 0 && <><div className="orch-loop-picker" role="group" aria-label="选择循环">
      {loops.items.map(loop => <button className={selected === loop.id ? "selected" : ""} key={loop.id} onClick={() => setSelected(loop.id)}>
        {titles[loop.id] ?? `判断职责 ${loop.cognitiveRoleId}`} · {statusLabel(loop.state)}
      </button>)}
    </div>{(taskId ? taskContexts.nextCursor : loops.nextCursor) && <button disabled={moreLoops} onClick={loadMoreLoops}>{moreLoops ? "读取中…" : `继续读取关联循环（已载入 ${loops.items.length}，还有更多）`}</button>}
      {selected && <LoopObservation key={`${projectId}:${selected}:${refresh}:${epoch}`} token={token} projectId={projectId}
        loop={loops.items.find(item => item.id === selected)!} title={titles[selected]} taskId={taskId} context={taskContexts.items.find(item => item.loopId === selected)} />}
    </>}
  </section>;
}

function LoopObservation({ token, projectId, loop, title, taskId, context }: { token: string; projectId: string; loop: OrchestrationLoop; title?: string; taskId?: string; context?: TaskLoopContext }) {
  const [data, setData] = useState<LoopData | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [more, setMore] = useState<LoopPart | "tasks" | null>(null);
  useEffect(() => {
    let active = true;
    setData(null); setError(""); setLoading(true);
    const client = orchestrationClient(token, projectId);
    void Promise.all([client.part(loop.id, "inbox"), client.part(loop.id, "dispatches"),
      client.part(loop.id, "submissions"), client.part(loop.id, "events"), client.part(loop.id, "sources"), client.tasks(loop.id)]).then(async ([inbox, dispatches, submissions, events, sources, tasks]) => {
      const decisions: Record<string, OrchestrationWorkerDecision> = {};
      await Promise.all(events.items.filter(item => item.kind === "worker.decision").map(async item => {
        try { decisions[item.entityId] = await client.decision(item.entityId); } catch { /* The summary states when a decision could not be read back. */ }
      }));
      const revisionIds=await revisionIdsFor(client,dispatches.items);
      if (active) { setData({ inbox, dispatches, submissions, events, sources, tasks, decisions, revisionIds }); setLoading(false); }
    }).catch(cause => { if (active) { setError(errorText(cause)); setLoading(false); } });
    return () => { active = false; };
  }, [token, projectId, loop.id]);
  async function loadMore<K extends LoopPart>(kind: K) {
    const cursor = data?.[kind].nextCursor; if (!cursor || more) return;
    setMore(kind);
    try {
      const client = orchestrationClient(token, projectId);
      const page = await client.part(loop.id, kind, cursor);
      const revisionIds = kind === "dispatches" ? await revisionIdsFor(client,page.items as OrchestrationDispatch[]) : {};
      const decisions: Record<string, OrchestrationWorkerDecision> = {};
      if (kind === "events") await Promise.all((page.items as OrchestrationEvent[]).filter(item => item.kind === "worker.decision").map(async item => {
        try { decisions[item.entityId] = await client.decision(item.entityId); } catch { /* Keep the unread reason visibly unknown. */ }
      }));
      setData(current => current ? { ...current, [kind]: mergePage(current[kind] as ResultPage<LoopPartItem[K]>, page),
        decisions:{...current.decisions,...decisions},revisionIds:{...current.revisionIds,...revisionIds} } as LoopData : current);
      setError("");
    } catch (cause) { setError(errorText(cause)); }
    finally { setMore(null); }
  }
  async function loadMoreTasks() {
    const cursor = data?.tasks.nextCursor; if (!cursor || more) return;
    setMore("tasks");
    try {
      const page = await orchestrationClient(token, projectId).tasks(loop.id, cursor);
      setData(current => current ? { ...current, tasks: {items:[...current.tasks.items,
        ...page.items.filter(item => !current.tasks.items.some(previous => previous.task.id === item.task.id))],nextCursor:page.nextCursor} } : current);
      setError("");
    } catch (cause) { setError(errorText(cause)); }
    finally { setMore(null); }
  }
  const moreButton = (kind: LoopPart, count: number) => data?.[kind].nextCursor &&
    <button disabled={more !== null} onClick={() => { void loadMore(kind); }}>{more === kind ? "读取中…" : `继续读取（已载入 ${count}，还有更多）`}</button>;
  const related = (item: OrchestrationDispatch) => !taskId || !!context && inTaskContext(item,context);
  const relatedSource = (sourceEventId: string) => !taskId || !!context && context.sourceEventIds.includes(sourceEventId);
  const relatedDispatchId = (dispatchId: string) => !taskId || !!context &&
    (context.dispatchIds.includes(dispatchId) || context.parentDispatchIds.includes(dispatchId));
  return <div className="orch-loop">
    <div className="orch-loop-head"><div><h3>{title ?? `判断职责 ${loop.cognitiveRoleId}`} · {statusLabel(loop.state)}</h3><p>判断职责 {loop.cognitiveRoleId} · 执行职责 {loop.allowedBusinessRoleIds.join("、")}</p></div></div>
    <details className="orch-technical"><summary>固定范围、预算与技术标识</summary><p>派发预算 {loop.dispatchCount}/{loop.maxRuns} · 同时上限 {loop.maxConcurrent}</p><dl className="orch-facts"><div><dt>Loop ID</dt><dd><code>{loop.id}</code></dd></div><div><dt>目标 / 阶段</dt><dd><code>{loop.goalId}</code>{loop.stageId && <> / <code>{loop.stageId}</code></>}</dd></div>
      <div><dt>授权人 / 初始事件</dt><dd>{loop.enrolledBy} / <code>{loop.bootstrapEventId}</code></dd></div></dl>
    <p className="muted">入站起点 {loop.sourceAfter.createdAtUtc} · 事件 <code>{loop.sourceAfter.eventId ?? "起始时间点"}</code>。派发预算记录请求次数，不等于成功 Run 数。</p></details>
    {taskId && <p className="muted">这里只展示与当前任务 <a href={taskHref(projectId, taskId)}>{short(taskId)}</a> 同来源或父子派发的已读回记录；不是全项目循环清单。</p>}
    {loading && <p>正在读取本循环记录…</p>}{error && <Notice error>本循环记录未完整读回：{error}。不要据此认定没有后续处理。</Notice>}
    {data && <><section className="orch-readable" aria-label="工作与结果">
      <h3>为什么做、交给谁、现在怎样</h3>
      <p className="muted">以下只依据已读回的任务、决定、派发和交付记录。运行结束不代表交付合格；没有人类使用记录时不推定已使用。</p>
      {data.dispatches.nextCursor || data.tasks.nextCursor || data.inbox.nextCursor || data.submissions.nextCursor || data.events.nextCursor || data.sources.nextCursor ?
        <Notice>仍有记录未载入；以下摘要只覆盖已读回的部分，不能据此判断全循环完成。</Notice> : null}
      {data.dispatches.items.filter(related).length === 0 && <p className="empty">当前读取范围还没有相关的已派发工作。{data.inbox.items.some(item => relatedSource(item.sourceEventId) && item.state === "pending") ? "已有入站等待处理。" : "可展开下方记录核对入站情况。"}</p>}
      {data.dispatches.items.filter(related).map(item => {
        const detail = data.tasks.items.find(value => value.task.id === item.taskId);
        const inbox = data.inbox.items.find(value => value.id === item.inboxId);
        const source = data.sources.items.find(value => value.id === item.sourceEventId);
        const submission = data.submissions.items.find(value => value.dispatchId === item.id);
        const decisionEvent = data.events.items.find(value => value.kind === "worker.decision" && value.detail.dispatchId === item.id);
        const decision = decisionEvent ? data.decisions[decisionEvent.entityId] : undefined;
        const intentGap = !submission && !decision && data.events.items.some(value =>
          value.kind === "dispatch.gap" && value.entityId === item.id);
        return <article className="orch-story" key={item.id}>
          <div className="orch-story-head"><h4><a href={taskHref(projectId,item.taskId)}>{detail?.task.title ?? `任务 ${short(item.taskId)}`}</a>{detail && detail.task.version !== item.taskVersion && <small>现名称；派发时为任务 v{item.taskVersion}</small>}</h4><span>{intentGap ? "运行已结束，缺少提交" : dispatchStateLabel[item.state]}</span></div>
          <dl><div><dt>为什么做</dt><dd>{sourceTriggerLabel(source)}{item.parentDispatchId && " · 接续上游派发"}</dd></div>
            <div><dt>交给谁</dt><dd>{item.recipientRoleId}{item.requestedBy ? ` · 由 ${item.requestedBy} 发起` : ""}</dd></div>
            <div><dt>结果</dt><dd>{intentGap ? "已确认运行结束，尚无署名提交或决定，不能视作交付。" : readableOutcome(item,submission,detail)}</dd></div>
            <div><dt>下一步</dt><dd>{intentGap ? "缺口已保留；核因与后续处理见关联工作记录。" : nextAction(inbox,item,submission)}</dd></div>
            <div><dt>署名判断</dt><dd>{decision ? `${dispositionLabel(decision.kind)} · ${decision.actorId}` : inbox?.acknowledgedBy ? `${dispositionLabel(inbox.disposition)} · ${inbox.acknowledgedBy}` : "尚未读回署名决定"}</dd></div></dl>
          <p className="orch-story-links">{data.revisionIds[item.taskId]?.[item.taskVersion] ?
            <a href={taskSectionHref(projectId,item.taskId,{revisionId:data.revisionIds[item.taskId]![item.taskVersion]})}>派发请求时任务修订 v{item.taskVersion}</a> :
            <span>派发请求时任务修订 v{item.taskVersion} 暂不可核实；<a href={taskHref(projectId,item.taskId)}>查看现任务</a></span>}
            {item.runtimeRunId && <> · <a href={taskSectionHref(projectId,item.taskId,{tab:"runtime"})}>实际运行（{short(item.runtimeRunId)}）</a></>}
            {submission?.deliveryId && <> · <a href={taskSectionHref(projectId,item.taskId,{tab:"delivery"})}>交付与使用记录</a></>}
            {item.parentDispatchId && <> · 上游派发见下方记录</>}</p>
          <details><summary>完整理由、固定标识与核对</summary>
            <p><strong>派发理由：</strong>{item.reason || item.purpose}</p>
            {inbox?.reason && <p><strong>入站处理理由：</strong>{inbox.reason}</p>}
            {decision?.reason && <p><strong>署名决定理由：</strong>{decision.reason}</p>}
            {detail?.task.content && <details><summary>任务现正文</summary><p>{detail.task.content}</p></details>}
            <p>派发 <code>{item.id}</code> · 来源事件 <code>{item.sourceEventId}</code> · 入站 <code>{item.inboxId}</code></p>
            {item.parentDispatchId && <p>上游派发 <code>{item.parentDispatchId}</code></p>}
            {submission && <p>提交 <code>{submission.id}</code> · Delivery <code>{submission.deliveryId ?? "尚无"}</code></p>}</details>
        </article>;
      })}
      {data.sources.nextCursor && moreButton("sources", data.sources.items.length)}
      {data.tasks.nextCursor && <button disabled={more !== null} onClick={() => { void loadMoreTasks(); }}>{more === "tasks" ? "读取中…" : `继续读取任务标题与交付（已载入 ${data.tasks.items.length}，还有更多）`}</button>}
    </section><details className="orch-records"><summary>查看入站、派发、提交与审计原记录</summary><div className="orch-columns">
      <section><h3>入站与决定 <span>{data.inbox.items.length}{data.inbox.nextCursor ? "+" : ""}</span></h3>
        {data.inbox.items.length === 0 && <p className="empty">当前读取范围没有入站。</p>}
        {data.inbox.items.filter(item => relatedSource(item.sourceEventId)).map(item => <article className="orch-item" key={item.id}><div className="orch-item-title"><strong>{item.purpose}</strong><span>{inboxStateLabel[item.state]}</span></div>
          <p>接收职责 {item.recipientRoleId} · {dispositionLabel(item.disposition)}</p>
          <p>来源事件 <code>{item.sourceEventId}</code></p>
          {item.reason && <p>处理理由：{item.reason}</p>}{item.evidenceRef && <p>证据：{item.evidenceRef}</p>}
          <details><summary>固定标识与署名</summary><p>入站 <code>{item.id}</code> · 处理人 {item.acknowledgedBy ?? "尚未署名"}</p>
            {item.dispatchId && <p>后续派发 <code>{item.dispatchId}</code></p>}</details></article>)}
        {moreButton("inbox", data.inbox.items.length)}</section>
      <section><h3>派发与实际运行 <span>{data.dispatches.items.length}{data.dispatches.nextCursor ? "+" : ""}</span></h3>
        {data.dispatches.items.length === 0 && <p className="empty">当前读取范围没有派发。</p>}
        {data.dispatches.items.filter(related).map(item => <article className="orch-item" key={item.id}><div className="orch-item-title"><strong><a href={taskHref(projectId, item.taskId)}>任务 {short(item.taskId)}</a></strong><span>{dispatchStateLabel[item.state]}</span></div>
          <p>{item.purpose} · 承接职责 {item.recipientRoleId}</p>
          {item.parentDispatchId && <p>承接上游派发 <code>{item.parentDispatchId}</code></p>}
          <p>来源入站 <code>{item.inboxId}</code> · Task v{item.taskVersion}</p>
          {item.runtimeRunId ? <p>实际 Run <code>{item.runtimeRunId}</code>；Run 终态需在运行记录中核对。</p> : <p>尚无已绑定 Run。</p>}
          {item.outcome && <p>Worker 后续结果：{outcomeLabel(item.outcome)}{item.deliveryId ? <> · Delivery <code>{item.deliveryId}</code></> : ""}</p>}
          {item.state === "unknown" && <Notice error>派发结果未知；不能从本页认定外部没有执行。</Notice>}
          <details><summary>派发证据</summary><p>ID <code>{item.id}</code> · 来源事件 <code>{item.sourceEventId}</code></p><p>请求人 {item.requestedBy}</p>
            {item.evidenceRef && <p>证据：{item.evidenceRef}</p>}<p>原因：{item.reason}</p></details></article>)}
        {moreButton("dispatches", data.dispatches.items.length)}</section>
      <section><h3>Worker 提交与封存 <span>{data.submissions.items.length}{data.submissions.nextCursor ? "+" : ""}</span></h3>
        {data.submissions.items.length === 0 && <p className="empty">当前读取范围没有 Worker 提交。</p>}
        {data.submissions.items.filter(item => relatedDispatchId(item.dispatchId)).map(item => <article className="orch-item" key={item.id}><div className="orch-item-title"><strong><a href={taskHref(projectId, item.taskId)}>任务 {short(item.taskId)}</a></strong><span>{submissionStateLabel[item.state]}</span></div>
          <p>{deliveryMeaning(item)}</p><p>提交人 {item.submittedBy}；封存人 {item.sealedBy ?? "尚无"}</p>
          <p>Run <code>{item.runId}</code> · 执行修订 <a href={`${taskHref(projectId, item.taskId)}?revision=${encodeURIComponent(item.taskRevisionId)}`}><code>{item.taskRevisionId}</code></a></p>
          {item.deliveryId && <p>正式 Delivery <code>{item.deliveryId}</code></p>}
          <details><summary>固定提交依据</summary><p>提交 <code>{item.id}</code> · 派发 <code>{item.dispatchId}</code></p>
            <p>输入 hash <code>{item.runInputHash}</code> · 交付操作 <code>{item.deliveryOperationId}</code></p>
            <p>拟登记产物：{item.deliveryIntent.artifactRef} · {item.deliveryIntent.artifactRevision}</p>
            <p>技术结果：{item.deliveryIntent.technicalResult} · {item.deliveryIntent.technicalEvidence}</p>
            {item.agentObservation && <p>提交时拟记录的 Agent 观察：{item.agentObservation}</p>}
            {item.evidenceRefs.length > 0 && <p>附带证据：{item.evidenceRefs.join("、")}</p>}{item.reason && <p>封存结果：{sealReasonLabel(item.reason)}{sealReasonLabel(item.reason) !== item.reason && <small> · 原记录码 {item.reason}</small>}</p>}</details></article>)}
        {moreButton("submissions", data.submissions.items.length)}</section>
      <section className="orch-audit"><details><summary>审计事件 · 已载入 {data.events.items.length}{data.events.nextCursor ? "，仍有更多" : ""}</summary>
        <p className="muted">事件记录只说明曾登记状态变化，不证明消费者实际使用或 Task 验收。</p>
        {data.events.items.filter(item => !taskId || relatedDispatchId(String(item.detail.dispatchId ?? item.entityId)) ||
          relatedSource(String(item.detail.sourceEventId ?? "")) || item.entityType === "decision" && data.decisions[item.entityId] && relatedDispatchId(data.decisions[item.entityId].dispatchId)).map(item => <article className="orch-event" key={item.id}><strong>{item.kind === "worker.decision" ? `Worker 判定：${dispositionLabel(typeof item.detail.kind === "string" ? item.detail.kind : null)}` : item.kind}</strong><p>{item.entityType} <code>{item.entityId}</code> · 操作 <code>{item.operationId}</code></p>
          <small>{item.actorId} · {item.createdAtUtc}</small><details><summary>事件细节</summary><pre>{JSON.stringify(item.detail, null, 2)}</pre></details></article>)}
        {moreButton("events", data.events.items.length)}</details></section>
    </div></details></>}
  </div>;
}
