import { useEffect, useState, useRef } from "react";
import type { Document, Goal, Page, Stage, TaskDetail } from "@evoloop/contracts";
import { api, errorText } from "../api";
import { ActionForm, Notice, option, reasonField, type Field, type MutationContext } from "./ActionForm";
import { RevisionHistory } from "./RevisionHistory";

const goalFields: Field[] = [
  { name: "outcome", label: "想达成的结果", kind: "textarea" }, { name: "constraints", label: "必须遵守的约束", kind: "textarea" },
  { name: "consumer", label: "谁会实际使用成果" }, { name: "authority", label: "已授权的工作与需另行取舍的边界", kind: "textarea" },
  { name: "scope", label: "可投入范围与资源" }, { name: "owner", label: "承接责任者" },
];
async function loadComplete<T>(label: string, load: (cursor?: string) => Promise<Page<T>>): Promise<T[]> {
  const items: T[] = [], seen = new Set<string>();
  let cursor: string | undefined;
  for (;;) {
    const page = await load(cursor);
    items.push(...page.items);
    if (items.length > 1000 || (items.length === 1000 && page.nextCursor)) throw new Error(`${label}超过 1000 条，当前选择列表无法完整展示；请缩小项目范围后重试。`);
    if (!page.nextCursor) return items;
    if (seen.has(page.nextCursor)) throw new Error(`${label}分页游标重复，无法确认列表完整。`);
    seen.add(page.nextCursor); cursor = page.nextCursor;
  }
}
async function loadTaskDetails(token: string, projectId: string): Promise<TaskDetail[]> {
  const client = api(token);
  const tasks = await loadComplete("任务", cursor => client.tasks(projectId, cursor));
  const details = new Array<TaskDetail>(tasks.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(6, tasks.length) }, async () => {
    while (next < tasks.length) {
      const index = next++;
      details[index] = await client.task(projectId, tasks[index]!.id);
    }
  }));
  return details;
}
function nextAction(stage: Stage, tasks: TaskDetail[]): string {
  if (stage.state === "proposed") return "先判断并接受阶段，再建立所属任务。";
  if (stage.state === "reviewed") return "阅读最新阶段回看和后续选择；新证据可追加纠正。";
  if (!tasks.length) return "明确交付与学习问题后，建立首项待办任务。";
  if (tasks.some(detail => detail.task.state === "in_progress" && (detail.deliveries ?? []).length)) return "核对本次交付与使用观察，按验收条件决定能否关闭。";
  if (tasks.some(detail => detail.task.state === "in_progress")) return "继续执行并登记可核对的交付。";
  if (tasks.some(detail => detail.task.state === "todo")) return "核对任务正文与来源，明确开始或取消。";
  return "核对交付和使用结果，再作阶段回看。";
}
export function JourneyBoard({ context, refresh, propose = false }: { context: MutationContext; refresh: number; propose?: boolean }) {
  const hasLoaded = useRef(false);
  const readPending = useRef(true);
  const [goals, setGoals] = useState<Goal[]>([]);
  const [stages, setStages] = useState<Stage[]>([]);
  const [documents, setDocuments] = useState<Document[]>([]);
  const [taskDetails, setTaskDetails] = useState<TaskDetail[] | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [readRequest, setReadRequest] = useState(0);
  const [readVersion, setReadVersion] = useState(0);
  useEffect(() => {
    let active = true; setLoading(true); setError("");
    const client = api(context.token);
    Promise.all([loadComplete("目标", cursor => client.goals(context.projectId, cursor)), client.stages(context.projectId),
      loadComplete("过程文档", cursor => client.documents(context.projectId, cursor)), loadTaskDetails(context.token, context.projectId)])
      .then(([g, s, d, tasks]) => { if (active) {
        setGoals(g); setStages(s); setDocuments(d); setTaskDetails(tasks);
        hasLoaded.current = true; setReadVersion(value => value + 1);
      } })
      .catch(cause => { if (active) setError(errorText(cause)); })
      .finally(() => { if (active) { readPending.current = false; setLoading(false); } });
    return () => { active = false; };
  }, [context.token, context.projectId, refresh, readRequest]);
  const readCurrent = () => {
    if (loading || readPending.current) return;
    readPending.current = true;
    setReadRequest(value => value + 1);
  };
  if (loading && !hasLoaded.current) return <section className="panel"><p>正在读取目标与阶段…</p></section>;
  if (error && !hasLoaded.current) return <section className="panel"><Notice error>回读失败：{error}。当前状态尚未读全，不能据此判断进度。</Notice><button type="button" onClick={readCurrent}>重试回读当前状态</button></section>;
  context = { ...context, blocked: context.blocked || loading || !!error };
  return <div className="journey-board">
    <div className="actions"><button type="button" onClick={readCurrent} disabled={loading}>{loading ? "回读中…" : "回读当前状态"}</button></div>
    {loading && <Notice>正在回读目标、阶段及任务关联；旧读取和草稿保留，完成前不能据此判断当前进度。</Notice>}
    {error && <Notice error>回读失败：{error}。下方是上次读取，不能据此判断当前进度；草稿保留，请重试回读。</Notice>}
    <div hidden={propose}>
    <section className="panel"><div className="panel-head"><h2>目标 → 阶段 → 任务</h2><span>当前项目真实对象；不以工程里程碑推算完成百分比</span></div>
      <p className="muted">这里的“阶段”来自本项目的 Goal/Stage/Task 数据。产品旅程 J1–J6 见仓库 <code>docs/product/definition.md</code>；实施路线 M0–M4 见 <code>docs/roadmap.md</code>，两套编号不自动映射到本项目。</p>
      {taskDetails !== null && goals.map(goal => {
        const relatedStages = stages.filter(stage => stage.goalId === goal.id);
        return <div className="journey-goal" key={goal.id}><h3>{goal.outcome}</h3><p className="muted">目标负责人 {goal.owner} · v{goal.version}</p>
          {!relatedStages.length && <p className="empty">尚无阶段。下一步：提出阶段交付与学习问题。</p>}
          {relatedStages.map(stage => {
            const relatedTasks = taskDetails.filter(detail => detail.proposal?.stageId === stage.id);
            return <div className="journey-stage" key={stage.id}><div className="journey-stage-head"><strong>{stage.deliverable}</strong><span className="pill">{stage.state} · {relatedTasks.length} 项任务</span></div>
              <p>学习问题：{stage.learningQuestion}</p><p><strong>下一动作：</strong>{nextAction(stage, relatedTasks)}</p>
              {relatedTasks.length ? <ul>{relatedTasks.map(detail => <li key={detail.task.id}><a href={`#/p/${context.projectId}/tasks/${detail.task.id}`}>{detail.task.title}</a><span className="muted"> · {detail.task.state}</span></li>)}</ul> : <p className="empty">这个阶段尚无所属任务。</p>}
            </div>;
          })}
        </div>;
      })}
      {taskDetails !== null && taskDetails.some(detail => !detail.proposal?.stageId || !stages.some(stage => stage.id === detail.proposal?.stageId)) &&
        <p className="muted">另有 {taskDetails.filter(detail => !detail.proposal?.stageId || !stages.some(stage => stage.id === detail.proposal?.stageId)).length} 项任务没有可核对的所属阶段，不纳入上述关系。</p>}
    </section>
    <section className="panel"><div className="panel-head"><h2>目标与下一步</h2><span>目标 {goals.length} 项 · 阶段 {stages.length} 项 · 文档 {documents.length} 项已完整读取</span></div>
      {!goals.length && <p className="empty">先留下目标、消费者与授权范围，再形成首阶段。这里不会自动创建示例数据。</p>}
      {goals.map(goal => <details className="workflow-detail" key={goal.id}><summary>{goal.outcome} <span className="pill">v{goal.version}</span></summary>
        <dl>{goalFields.map(field => <div key={field.name}><dt>{field.label}</dt><dd>{goal[field.name as keyof Goal]}</dd></div>)}</dl>
        <RevisionHistory label="阅读目标修订历史" load={async () => (await api(context.token).goalRevisions(context.projectId, goal.id)).map(r => ({ key: String(r.version), title: `目标 v${r.version}`, body: goalFields.map(f => `${f.label}：${r[f.name as keyof typeof r]}`).join("\n"), reason: r.reason, actorId: r.actorId, createdAt: r.createdAt }))} />
        <ActionForm context={{ ...context, draftScope: `goal:${goal.id}`, draftBaseline: String(goal.version) }} title="修订目标" fields={[...goalFields.map(f => ({ ...f, value: String(goal[f.name as keyof Goal]) })), reasonField]} build={v => ({ type: "goal.revise", goalId: goal.id, expectedVersion: goal.version, ...v })} />
      </details>)}
      <details className="workflow-detail" open={!goals.length}><summary>建立一个目标</summary><ActionForm context={{ ...context, draftScope: "new-goal" }} title="保存目标" fields={goalFields} build={v => ({ type: "goal.create", goalId: crypto.randomUUID(), ...v })} /></details>
    </section>
    <section className="panel"><div className="panel-head"><h2>阶段交付与学习问题</h2><span>阶段接受与结果回看分别记录</span></div>
      {!stages.length && <p className="empty">还没有阶段候选。阶段需回答交付什么、想弄清什么。</p>}
      {stages.map(stage => <StageCard key={stage.id} stage={stage} readVersion={readVersion} mainReadStale={loading || !!error} context={{ ...context, draftScope: `stage:${stage.id}`, draftBaseline: String(stage.version) }} />)}
      {goals.length > 0 && <details className="workflow-detail"><summary>提议下一阶段</summary><ActionForm context={context} title="提出阶段" fields={[
        { name: "goalId", label: "对应目标", kind: "select", options: goals.map(g => option(g.id, g.outcome)) },
        { name: "deliverable", label: "阶段交付", kind: "textarea" }, { name: "learningQuestion", label: "学习问题", kind: "textarea" }, reasonField,
      ]} build={v => ({ type: "stage.propose", stageId: crypto.randomUUID(), ...v })} /></details>}
    </section>
    </div>
    <details className="panel proposal-panel" open={propose}><summary>建立任务</summary><p>直接写任务正文与独立验收；主文档随任务自动创建，不需要先保存过程文档。</p>
      <ActionForm context={{ ...context, draftScope: "new-task" }} initiallyOpen={propose} title="创建待办任务" fields={[
        { name: "title", label: "任务名称" }, { name: "stageId", label: "所属阶段（可选）", kind: "select", optional: true, options: stages.filter(s => s.state === "active").map(s => option(s.id, s.deliverable)) },
        { name: "kind", label: "类型（可选）", kind: "select", optional: true, options: [option("implementation", "实施"), option("research", "调研"), option("validation", "验证")] },
        { name: "content", label: "任务正文（Markdown）", kind: "textarea" }, { name: "acceptance", label: "独立验收条件", kind: "textarea" },
        { name: "owner", label: "责任者", value: context.principal.actorId }, { name: "consumer", label: "目标消费者（所属阶段任务必填）", optional: true },
        { name: "useRequired", label: "关闭是否要求实际使用", kind: "select", value: "false", options: [option("true", "需要本次交付的使用证据"), option("false", "按验收条件与技术检查判断")] },
        { name: "documentIds", label: "关联已发布文档（可选）", kind: "multi", options: documents.filter(d => d.status === "published").map(d => option(d.id, d.title)), optional: true },
        { name: "evidence", label: "来源或反馈证据（所属阶段任务必填）", kind: "textarea", optional: true }, { name: "stopCondition", label: "停止条件（所属阶段任务必填）", kind: "textarea", optional: true },
      ]} build={v => ({ type: "task.create", taskId: crypto.randomUUID(), title: v.title, content: v.content, acceptance: v.acceptance, owner: v.owner,
        kind: v.kind || null, documentIds: JSON.parse(v.documentIds || "[]"), ...(v.stageId ? { stageId: v.stageId } : {}), ...(v.consumer ? { consumer: v.consumer } : {}),
        useRequired: v.useRequired === "true", ...(v.evidence ? { evidence: v.evidence } : {}), ...(v.stopCondition ? { stopCondition: v.stopCondition } : {}) })} onApplied={result => { window.location.hash = `/p/${context.projectId}/tasks/${result.entityId}`; }} />
    </details>
  </div>;
}

function StageCard({ stage, context, readVersion, mainReadStale }: { stage: Stage; context: MutationContext; readVersion: number; mainReadStale: boolean }) {
  const [history, setHistory] = useState<Awaited<ReturnType<ReturnType<typeof api>["stageReviews"]>> | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  async function readHistory() {
    if (loading) return;
    setLoading(true); setError("");
    try { setHistory(await api(context.token).stageReviews(context.projectId, stage.id)); }
    catch (cause) { setError(errorText(cause)); }
    finally { setLoading(false); }
  }
  useEffect(() => {
    let active = true; setLoading(true); setError("");
    api(context.token).stageReviews(context.projectId, stage.id)
      .then(value => { if (active) setHistory(value); })
      .catch(cause => { if (active) setError(errorText(cause)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [context.token, context.projectId, stage.id, stage.version, readVersion]);
  const ordered = [...(history ?? [])].sort((a, b) => a.stageVersion - b.stageVersion || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  const latest = ordered.at(-1);
  const reviewFields: Field[] = [
    { name: "adopted", label: "采用的认识与支持证据", kind: "textarea" }, { name: "rejected", label: "被推翻或仍不能成立的解释", kind: "textarea" },
    { name: "gap", label: "目标差距与未知", kind: "textarea" }, { name: "nextChoice", label: "下一选择", kind: "select", options: [option("continue", "继续当前工作"), option("newTask", "提出后续任务"), option("research", "补证再判断"), option("stop", "停止并保留理由")] },
    { name: "evidence", label: "交付、实际使用与反例证据", kind: "textarea" }, reasonField,
  ];
  return <details className="workflow-detail"><summary>{stage.deliverable} <span className="pill">{stage.state} · v{stage.version}</span></summary>
    <p><strong>学习问题：</strong>{stage.learningQuestion}</p>
    <RevisionHistory label="阅读阶段修订历史" load={async () => (await api(context.token).stageRevisions(context.projectId, stage.id)).map(r => ({ key: r.id, title: `阶段 v${r.version} · ${r.state}`, body: `交付：${r.deliverable}\n学习问题：${r.learningQuestion}`, reason: r.reason, actorId: r.actorId, createdAt: r.createdAt }))} />
    {stage.state === "proposed" && <ActionForm context={context} review title="接受阶段" fields={[reasonField]} build={v => ({ type: "stage.accept", stageId: stage.id, expectedVersion: stage.version, ...v })} />}
    {stage.state === "active" && <ActionForm context={context} review title="记录阶段回看" fields={reviewFields} build={v => ({ type: "stage.review", stageId: stage.id, expectedVersion: stage.version, ...v })} />}
    {stage.state === "reviewed" && <>
      <p>阶段已回看。若新证据改变判断，请指明要纠正的最新记录；旧判断会保留。</p>
      {latest && <p className="history">纠正目标：{latest.nextChoice} · {latest.actorId} · {latest.createdAt}<br /><code>{latest.id}</code></p>}
      {loading && <p>正在读取最新回看，读取前不能提交纠正。</p>}
      {history !== null && !latest && <Notice error>没有可纠正的回看记录，请先核对后端历史。</Notice>}
      {latest && <ActionForm key={`correct:${latest.id}:${stage.version}`} context={{ ...context, blocked: context.blocked || loading || !!error }} review title="追加阶段回看纠正" fields={reviewFields.map(field => ({ ...field, value: field.name === "reason" ? "" : String(latest[field.name as keyof typeof latest] ?? "") }))}
        build={v => ({ type: "stage.review.correct", stageId: stage.id, expectedVersion: stage.version, supersedesReviewId: latest.id, ...v })} />}
    </>}
    <button onClick={readHistory} disabled={loading}>阅读回看历史</button>{error && <Notice error>回看历史回读失败：{error}。下方保留旧读取，不能据此判断当前记录。</Notice>}
    {ordered.map(review => <article className="decision" key={review.id}><strong>{review.nextChoice}{review.id === latest?.id ? loading || error || mainReadStale ? " · 上次读取的判断" : " · 当前判断" : " · 已被后续回看替代"}</strong><p>采用：{review.adopted}</p><p>反例：{review.rejected}</p><p>差距：{review.gap}</p><p>依据：{review.evidence}</p><p>理由：{review.reason}</p>{review.supersedesReviewId && <p className="muted">纠正了回看 <code>{review.supersedesReviewId}</code></p>}<small>{review.actorId} · {review.createdAt}</small></article>)}
    {history?.length === 0 && <p>尚无阶段回看记录。</p>}
  </details>;
}
