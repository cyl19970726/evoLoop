import { useEffect, useState } from "react";
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
  if (stage.state === "proposed") return "先判断并接受阶段，再提出所属任务。";
  if (stage.state === "reviewed") return "阅读最新阶段回看和后续选择；新证据可追加纠正。";
  if (!tasks.length) return "明确交付与学习问题后，提出首项任务。";
  if (tasks.some(detail => detail.task.state === "review")) return "核对本次交付、使用观察与任务验收。";
  if (tasks.some(detail => detail.task.state === "active")) return "继续执行并登记可核对的交付。";
  if (tasks.some(detail => detail.task.state === "ready")) return "核对固定依据，开始可做任务。";
  if (tasks.some(detail => detail.task.state === "blocked" || detail.task.state === "deferred")) return "阅读阻塞或暂缓理由，决定补证或恢复。";
  if (tasks.some(detail => detail.task.state === "proposed")) return "判断任务提议；拒绝或待补证不等于已接受。";
  return "核对交付和使用结果，再作阶段回看。";
}
export function JourneyBoard({ context, refresh }: { context: MutationContext; refresh: number }) {
  const [goals, setGoals] = useState<Goal[]>([]);
  const [stages, setStages] = useState<Stage[]>([]);
  const [documents, setDocuments] = useState<Document[]>([]);
  const [taskDetails, setTaskDetails] = useState<TaskDetail[] | null>(null);
  const [relationError, setRelationError] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let active = true; setLoading(true); setError("");
    const client = api(context.token);
    Promise.all([loadComplete("目标", cursor => client.goals(context.projectId, cursor)), client.stages(context.projectId),
      loadComplete("过程文档", cursor => client.documents(context.projectId, cursor))])
      .then(([g, s, d]) => { if (active) { setGoals(g); setStages(s); setDocuments(d); } })
      .catch(cause => { if (active) setError(errorText(cause)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [context.token, context.projectId, refresh]);
  useEffect(() => {
    let active = true; setTaskDetails(null); setRelationError("");
    loadTaskDetails(context.token, context.projectId)
      .then(value => { if (active) setTaskDetails(value); })
      .catch(cause => { if (active) setRelationError(errorText(cause)); });
    return () => { active = false; };
  }, [context.token, context.projectId, refresh]);
  if (loading) return <section className="panel"><p>正在读取目标与阶段…</p></section>;
  if (error) return <section className="panel"><Notice error>{error}</Notice><button onClick={context.onChanged}>重试读取目标</button></section>;
  return <div className="journey-board">
    <section className="panel"><div className="panel-head"><h2>目标 → 阶段 → 任务</h2><span>当前项目真实对象；不以工程里程碑推算完成百分比</span></div>
      <p className="muted">这里的“阶段”来自本项目的 Goal/Stage/Task 数据。产品旅程 J1–J6 见仓库 <code>docs/product/definition.md</code>；实施路线 M0–M4 见 <code>docs/roadmap.md</code>，两套编号不自动映射到本项目。</p>
      {relationError && <Notice error>任务关联未完整读取：{relationError}。不能据此判断进度；请回读。</Notice>}
      {taskDetails === null && !relationError && <p>正在核对任务与所属阶段…</p>}
      {taskDetails !== null && goals.map(goal => {
        const relatedStages = stages.filter(stage => stage.goalId === goal.id);
        return <div className="journey-goal" key={goal.id}><h3>{goal.outcome}</h3><p className="muted">目标负责人 {goal.owner} · v{goal.version}</p>
          {!relatedStages.length && <p className="empty">尚无阶段。下一步：提出阶段交付与学习问题。</p>}
          {relatedStages.map(stage => {
            const relatedTasks = taskDetails.filter(detail => detail.proposal?.stageId === stage.id);
            return <div className="journey-stage" key={stage.id}><div className="journey-stage-head"><strong>{stage.deliverable}</strong><span className="pill">{stage.state} · {relatedTasks.length} 项任务</span></div>
              <p>学习问题：{stage.learningQuestion}</p><p><strong>下一动作：</strong>{nextAction(stage, relatedTasks)}</p>
              {relatedTasks.length ? <ul>{relatedTasks.map(detail => {
                const judgement = (detail.judgements ?? []).filter(item => item.taskRevisionId === detail.revision.id)
                  .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)).at(-1);
                return <li key={detail.task.id}><a href={`#/p/${context.projectId}/tasks/${detail.task.id}`}>{detail.task.title}</a>
                  <span className="muted"> · {detail.task.state}{detail.task.state === "proposed" && ` · 判断：${judgement?.decision ?? "待判断"}`}</span></li>;
              })}</ul> : <p className="empty">这个阶段尚无所属任务。</p>}
            </div>;
          })}
        </div>;
      })}
      {taskDetails !== null && taskDetails.some(detail => !detail.proposal?.stageId || !stages.some(stage => stage.id === detail.proposal?.stageId)) &&
        <p className="muted">另有 {taskDetails.filter(detail => !detail.proposal?.stageId || !stages.some(stage => stage.id === detail.proposal?.stageId)).length} 项任务没有可核对的所属阶段，不纳入上述关系。</p>}
    </section>
    <section className="panel"><div className="panel-head"><h2>目标与下一步</h2><span>目标 {goals.length} 项 · 阶段 {stages.length} 项 · 文档 {documents.length} 项已完整读取</span></div>
      {!goals.length && <p className="empty">先留下目标、消费者与授权范围，再形成首阶段。这里不会自动创建示例数据。</p>}
      {goals.map(goal => <details className="workflow-detail" key={`${goal.id}:${goal.version}`}><summary>{goal.outcome} <span className="pill">v{goal.version}</span></summary>
        <dl>{goalFields.map(field => <div key={field.name}><dt>{field.label}</dt><dd>{goal[field.name as keyof Goal]}</dd></div>)}</dl>
        <RevisionHistory label="阅读目标修订历史" load={async () => (await api(context.token).goalRevisions(context.projectId, goal.id)).map(r => ({ key: String(r.version), title: `目标 v${r.version}`, body: goalFields.map(f => `${f.label}：${r[f.name as keyof typeof r]}`).join("\n"), reason: r.reason, actorId: r.actorId, createdAt: r.createdAt }))} />
        <ActionForm context={context} title="修订目标" fields={[...goalFields.map(f => ({ ...f, value: String(goal[f.name as keyof Goal]) })), reasonField]} build={v => ({ type: "goal.revise", goalId: goal.id, expectedVersion: goal.version, ...v })} />
      </details>)}
      <details className="workflow-detail" open={!goals.length}><summary>建立一个目标</summary><ActionForm context={context} title="保存目标" fields={goalFields} build={v => ({ type: "goal.create", goalId: crypto.randomUUID(), ...v })} /></details>
    </section>
    <section className="panel"><div className="panel-head"><h2>阶段交付与学习问题</h2><span>阶段接受与结果回看分别记录</span></div>
      {!stages.length && <p className="empty">还没有阶段候选。阶段需回答交付什么、想弄清什么。</p>}
      {stages.map(stage => <StageCard key={`${stage.id}:${stage.version}`} stage={stage} context={context} />)}
      {goals.length > 0 && <details className="workflow-detail"><summary>提议下一阶段</summary><ActionForm context={context} title="提出阶段" fields={[
        { name: "goalId", label: "对应目标", kind: "select", options: goals.map(g => option(g.id, g.outcome)) },
        { name: "deliverable", label: "阶段交付", kind: "textarea" }, { name: "learningQuestion", label: "学习问题", kind: "textarea" }, reasonField,
      ]} build={v => ({ type: "stage.propose", stageId: crypto.randomUUID(), ...v })} /></details>}
    </section>
    <section className="panel"><h2>提出工作</h2><p>缺陷、反馈和新需求进入同一任务集合。提议经判断和接受后才能开始。</p>
      <ActionForm context={context} title="提出任务" fields={[
        { name: "title", label: "任务名称" }, { name: "stageId", label: "所属阶段", kind: "select", options: stages.filter(s => s.state === "active").map(s => option(s.id, s.deliverable)) },
        { name: "goal", label: "这项工作要改变什么", kind: "textarea" }, { name: "acceptance", label: "技术与消费者验收", kind: "textarea" },
        { name: "owner", label: "责任者", value: context.principal.actorId }, { name: "consumer", label: "目标消费者" },
        { name: "useRequired", label: "完成是否要求实际使用", kind: "select", value: "true", options: [option("true", "要求，技术检查后还需使用证据"), option("false", "仅技术子任务，阶段效果继续待核")] },
        { name: "documentIds", label: "关联过程文档（可多选）", kind: "multi", options: documents.map(d => option(d.id, d.title)), optional: true },
        { name: "evidence", label: "来源、复现或反馈证据", kind: "textarea" }, { name: "stopCondition", label: "停止条件", kind: "textarea" },
      ]} build={v => ({ ...v, type: "task.propose", taskId: crypto.randomUUID(), useRequired: v.useRequired === "true", documentIds: JSON.parse(v.documentIds || "[]") })} onApplied={result => { window.location.hash = `/p/${context.projectId}/tasks/${result.entityId}`; }} />
      {!stages.some(s => s.state === "active") && <Notice>先提出并接受一个阶段，才能按完整旅程提出任务。</Notice>}
    </section>
  </div>;
}

function StageCard({ stage, context }: { stage: Stage; context: MutationContext }) {
  const [history, setHistory] = useState<Awaited<ReturnType<ReturnType<typeof api>["stageReviews"]>> | null>(null);
  const [error, setError] = useState("");
  async function readHistory() { setError(""); try { setHistory(await api(context.token).stageReviews(context.projectId, stage.id)); } catch (cause) { setError(errorText(cause)); } }
  useEffect(() => {
    let active = true;
    api(context.token).stageReviews(context.projectId, stage.id)
      .then(value => { if (active) setHistory(value); })
      .catch(cause => { if (active) setError(errorText(cause)); });
    return () => { active = false; };
  }, [context.token, context.projectId, stage.id, stage.version]);
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
      {history === null && !error && <p>正在读取最新回看，读取前不能提交纠正。</p>}
      {history !== null && !latest && <Notice error>没有可纠正的回看记录，请先核对后端历史。</Notice>}
      {latest && <ActionForm key={`correct:${latest.id}:${stage.version}`} context={context} review title="追加阶段回看纠正" fields={reviewFields.map(field => ({ ...field, value: field.name === "reason" ? "" : String(latest[field.name as keyof typeof latest] ?? "") }))}
        build={v => ({ type: "stage.review.correct", stageId: stage.id, expectedVersion: stage.version, supersedesReviewId: latest.id, ...v })} />}
    </>}
    <button onClick={readHistory}>阅读回看历史</button>{error && <Notice error>{error}</Notice>}
    {ordered.map(review => <article className="decision" key={review.id}><strong>{review.nextChoice}{review.id === latest?.id ? " · 当前判断" : " · 已被后续回看替代"}</strong><p>采用：{review.adopted}</p><p>反例：{review.rejected}</p><p>差距：{review.gap}</p><p>依据：{review.evidence}</p><p>理由：{review.reason}</p>{review.supersedesReviewId && <p className="muted">纠正了回看 <code>{review.supersedesReviewId}</code></p>}<small>{review.actorId} · {review.createdAt}</small></article>)}
    {history?.length === 0 && <p>尚无阶段回看记录。</p>}
  </details>;
}
