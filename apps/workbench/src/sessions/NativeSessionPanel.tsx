import { useEffect, useState } from "react";
import { isUnconfirmed } from "../api";
import { date, href } from "../ui/shared";

/** A bounded display model. The API adapter supplies only verified, project-owned facts. */
export interface NativeQuestionView {
  id: string;
  version: number;
  sessionId: string;
  threadId: string | null;
  turnId: string | null;
  itemId: string | null;
  sourceKind: "run" | "message" | "unbound";
  sourceId: string | null;
  taskId: string | null;
  requestedAt: string;
  isBlocking: boolean;
  state: "pending" | "response_saved" | "resolved" | "unavailable";
  canReply: boolean;
  unavailableReason: string | null;
  respondedBy: string | null;
  respondedAt: string | null;
  responseOutcome: "pending" | "attempted" | "submitted" | "unknown" | null;
  questions: Array<{ id: string; header: string; prompt: string; secret: boolean; allowOther: boolean;
    options: Array<{ label: string; description: string; value: string }> }>;
}

export interface NativeProgressView {
  projectId: string;
  sessionId: string;
  threadId: string;
  observedAt: string;
  lastEventAt: string;
  freshness: "live" | "stale";
  staleReason: string | null;
  status: "notLoaded" | "idle" | "systemError" | "active" | null;
  turn: null | { id: string; status: "inProgress" | "completed" | "interrupted" | "failed" | "unknown";
    source: null | { kind: "run" | "message"; id: string; taskId: string | null } };
  items: Array<{ id: string; kind: string; name: string; status: "inProgress" | "completed" | "failed" | "declined";
    summary: string; truncated: boolean }>;
  plan: null | { turnId: string; steps: Array<{ step: string; status: "pending" | "inProgress" | "completed" }>;
    explanation: string | null; truncated: boolean; observedAt: string };
  diff: null | { turnId: string; hasContent: boolean; truncated: boolean; observedAt: string };
  usage: null | { turnId: string; total: { inputTokens: number | null; cachedInputTokens: number | null;
    outputTokens: number | null; reasoningOutputTokens: number | null; totalTokens: number | null };
    last: { inputTokens: number | null; cachedInputTokens: number | null; outputTokens: number | null;
      reasoningOutputTokens: number | null; totalTokens: number | null };
    modelContextWindow: number | null; observedAt: string };
}

function NativeQuestionCard({ request, projectId, readHealthy, onAnswer }: {
  request: NativeQuestionView;
  projectId: string;
  readHealthy: boolean;
  onAnswer(requestId: string, expectedVersion: number, answers: Record<string, string[]>): Promise<void>;
}) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [other, setOther] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const [uncertain, setUncertain] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  useEffect(() => { setAnswers({}); setOther({}); setProblem(""); setUncertain(false); setSubmitted(false); }, [projectId, request.sessionId, request.id]);
  const complete = request.questions.length > 0 && request.questions.every(item => !!answers[item.id]?.trim());
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || uncertain || submitted || !readHealthy || request.state !== "pending" || !request.canReply || !complete) return;
    setBusy(true); setProblem("");
    try {
      const payload = Object.fromEntries(request.questions.map(item => {
        const value = answers[item.id] ?? "";
        return [item.id, [!other[item.id] && item.options.some(option => option.value === value) ? value : value.trim()]];
      }));
      await onAnswer(request.id, request.version, payload); setSubmitted(true);
    }
    catch (cause) {
      setProblem(cause instanceof Error ? cause.message : "回答结果未能确认；请按原请求回读。");
      setUncertain(isUnconfirmed(cause));
    } finally { setBusy(false); }
  }
  return <article className="native-question-card">
    <div className="native-panel-heading"><div><span className="native-panel-kicker">原生执行请求</span><h3>{request.state === "pending" ? "等待回答" : "原生提问记录"}</h3></div><span className="native-panel-state">{request.state === "response_saved" ? request.responseOutcome === "submitted" ? "已发送，待结果" : request.responseOutcome === "unknown" ? "发送结果未确认" : "答复已保存" : request.state === "resolved" ? "原生请求已结束" : request.state === "unavailable" ? "请求不可用" : submitted ? "已保存，待回读" : request.canReply && readHealthy && !uncertain ? "当前可回答" : "需回读确认"}</span></div>
    <p className="native-panel-context">{request.sourceKind === "run" ? "关联 Run" : request.sourceKind === "message" ? "关联普通消息" : "暂未绑定业务来源"}{request.sourceId && <> <code>{request.sourceId.slice(0, 8)}</code></>} · 请求于 {date(request.requestedAt)} · {request.isBlocking ? "阻塞当前 Turn" : "非阻塞提问"}{request.taskId && <> · <a href={href(projectId, "task", request.taskId)}>关联任务</a></>}</p>
    <details className="native-panel-ids"><summary>原生请求身份</summary><dl><div><dt>请求</dt><dd><code>{request.id}</code></dd></div>{request.threadId && <div><dt>Thread</dt><dd><code>{request.threadId}</code></dd></div>}{request.turnId && <div><dt>Turn</dt><dd><code>{request.turnId}</code></dd></div>}{request.itemId && <div><dt>Item</dt><dd><code>{request.itemId}</code></dd></div>}</dl></details>
    {request.respondedBy && <p className="native-panel-context">答复者 {request.respondedBy} · {date(request.respondedAt ?? undefined)}；此记录不表示模型已采用答案。</p>}
    {request.responseOutcome === "unknown" && <p className="native-panel-warning">原生发送结果未确认。请核对原请求状态，不要重复回答。</p>}
    <form onSubmit={event => void submit(event)}>{request.questions.map(item => <fieldset key={item.id} disabled={request.state !== "pending" || !request.canReply || !readHealthy || uncertain || submitted || busy}>
      <legend>{item.header || "需要你的回答"}</legend><p>{item.prompt}</p>
      {item.options.length ? <><div className="native-question-options">{item.options.map(choice => <label key={choice.value}><input type="radio" name={`${request.id}:${item.id}`} value={choice.value} checked={!other[item.id] && answers[item.id] === choice.value} onChange={() => { setOther(old => ({ ...old, [item.id]: false })); setAnswers(old => ({ ...old, [item.id]: choice.value })); }} /><span>{choice.label}{choice.description && <small>{choice.description}</small>}</span></label>)}
        {item.allowOther && <label><input type="radio" name={`${request.id}:${item.id}`} checked={!!other[item.id]} onChange={() => { setOther(old => ({ ...old, [item.id]: true })); setAnswers(old => ({ ...old, [item.id]: "" })); }} />其他回答</label>}</div>
        {item.allowOther && other[item.id] && (item.secret
          ? <input type="password" aria-label={`${item.header || item.prompt}的其他回答`} autoComplete="off" value={answers[item.id] ?? ""} maxLength={4000} onChange={event => setAnswers(old => ({ ...old, [item.id]: event.target.value }))} />
          : <textarea aria-label={`${item.header || item.prompt}的其他回答`} value={answers[item.id] ?? ""} maxLength={4000} onChange={event => setAnswers(old => ({ ...old, [item.id]: event.target.value }))} />)}</>
        : item.secret ? <input type="password" aria-label={item.header || item.prompt} autoComplete="off" value={answers[item.id] ?? ""} maxLength={4000} onChange={event => setAnswers(old => ({ ...old, [item.id]: event.target.value }))} />
          : <textarea aria-label={item.header || item.prompt} value={answers[item.id] ?? ""} maxLength={4000} onChange={event => setAnswers(old => ({ ...old, [item.id]: event.target.value }))} />}
    </fieldset>)}
      {request.unavailableReason && (request.state === "unavailable" || request.state === "resolved" || request.state === "pending" && !request.canReply) && <p className="native-panel-warning">{request.unavailableReason}</p>}
      {submitted && <p className="native-panel-warning">回答已保存；请回读原请求状态，不重复发送。</p>}
      {problem && <p className="native-panel-warning" role="alert">{problem}</p>}
      <div className="native-panel-footer"><small>回答会先保存，再尝试返回原生请求；以回读状态为准。</small>{request.state === "pending" && <button type="submit" className="primary" disabled={!request.canReply || !readHealthy || uncertain || submitted || busy || !complete}>{busy ? "保存中…" : submitted ? "等待回读" : "确认回答"}</button>}</div>
    </form>
  </article>;
}

const itemStateLabel = { inProgress: "进行中", completed: "已结束", failed: "失败", declined: "已拒绝" } as const;
const stepStateLabel = { pending: "待进行", inProgress: "进行中", completed: "已完成" } as const;
const staleReasonLabel: Record<string, string> = { disconnected: "原生连接已断开", connection_unavailable: "当前原生连接不可用",
  projection_unavailable: "进度记录暂不可读取", restart: "原生连接已重启" };
const tokens = (value: number | null) => value === null ? "未提供" : value.toLocaleString("zh-CN");

function NativeProgressCard({ progress, projectId, currentRead, waiting }: {
  progress: NativeProgressView; projectId: string; currentRead: boolean; waiting: boolean;
}) {
  const fresh = currentRead && progress.freshness === "live";
  const turn = progress.turn;
  const stateLabel = !fresh ? "观察待核对" : progress.status === "notLoaded" ? "原生会话尚未加载"
    : progress.status === "systemError" ? "原生观察异常" : waiting ? "等待回答"
    : turn?.status === "completed" ? "Turn 已结束" : turn?.status === "failed" ? "Turn 执行失败"
    : turn?.status === "interrupted" ? "Turn 已中断"
    : progress.status === "active" && turn?.status === "inProgress" ? "运行中"
    : progress.status === "idle" && turn?.status !== "inProgress" ? "当前空闲" : "状态待核对";
  const tool = fresh && progress.status === "active" && turn?.status === "inProgress"
    ? progress.items.filter(item => item.status === "inProgress").at(-1) ?? progress.items.at(-1)
    : progress.items.at(-1);
  const partial = progress.items.length === 10 || progress.items.some(item => item.truncated)
    || !!progress.plan?.truncated || !!progress.diff?.truncated;
  const planDone = progress.plan?.steps.filter(step => step.status === "completed").length ?? 0;
  const itemState = (status: keyof typeof itemStateLabel) => fresh ? itemStateLabel[status]
    : status === "inProgress" ? "当时进行中，当前待核对" : `上次记录：${itemStateLabel[status]}`;
  const stepState = (status: keyof typeof stepStateLabel) => fresh ? stepStateLabel[status]
    : status === "inProgress" ? "当时进行中，当前待核对" : `上次记录：${stepStateLabel[status]}`;
  const staleReason = progress.staleReason ? staleReasonLabel[progress.staleReason] ?? "原因待核对" : null;
  return <section className="native-progress-card">
    <div className="native-panel-heading"><div><span className="native-panel-kicker">原生事件的有界观察</span><h2>原生执行进度</h2></div><span className="native-panel-state">{stateLabel}</span></div>
    <p className="native-panel-context">最近事件 {date(progress.lastEventAt)} · 记录于 {date(progress.observedAt)} · {partial ? "仅展示最近有界范围" : "仅展示已观察到的事件"}</p>
    {!fresh && <p className="native-panel-warning">{!currentRead ? "当前工作区尚未重新读到进度。" : "原生连接的观察已过期。"}{staleReason ? ` 原因：${staleReason}。` : ""}以下是上次记录，不能代表当前仍在执行。</p>}
    {fresh && progress.status === "systemError" && <p className="native-panel-warning">原生状态报告异常；请结合固定 Run 和原生终态核对。</p>}
    <div className="native-progress-facts"><div><small>{fresh && stateLabel === "运行中" && tool?.status === "inProgress" ? "当前工具" : "最近工具活动"}</small><strong>{tool ? `${tool.name} · ${itemState(tool.status)}` : "暂无可确认的工具活动"}</strong></div>
      <div><small>计划进展</small><strong>{progress.plan ? `${fresh ? "" : "上次记录："}${planDone}/${progress.plan.steps.length} 步已完成${progress.plan.truncated ? " · 已截断" : ""}` : "暂无可确认的计划变化"}</strong></div>
      <div><small>{fresh ? "变更通知" : "上次变更通知"}</small><strong>{progress.diff ? progress.diff.hasContent ? "已观察到变更；内容需在受权原生历史核对" : "已观察到变更通知" : "暂无可确认的变更"}{progress.diff?.truncated ? " · 已截断" : ""}</strong></div></div>
    {progress.items.length > 0 && <details className="native-progress-detail"><summary>最近工具活动 · {progress.items.length} 项</summary><ol>{progress.items.map(item => <li key={item.id}><strong>{item.name}</strong> · {itemState(item.status)}{item.truncated && " · 名称已截断"}</li>)}</ol></details>}
    {progress.plan && <details className="native-progress-detail"><summary>计划步骤 · Turn {progress.plan.turnId}</summary><ol>{progress.plan.steps.map((step, index) => <li key={`${index}:${step.step}`}>{stepState(step.status)} · {step.step}</li>)}</ol>{progress.plan.explanation && <p>{progress.plan.explanation}</p>}<small>观察于 {date(progress.plan.observedAt)}{progress.plan.truncated && " · 原生内容已截断"}</small></details>}
    {progress.diff && <details className="native-progress-detail"><summary>变更通知来源 · Turn {progress.diff.turnId}</summary><p>工作区只展示通知，不展示原生变更文本；请在受权的原生历史中核对内容。</p><small>观察于 {date(progress.diff.observedAt)}{progress.diff.truncated && " · 原生通知文本已截断"}</small></details>}
    <p className="native-progress-usage">{fresh ? "累计 Token" : "上次记录的累计 Token"}：输入 {tokens(progress.usage?.total.inputTokens ?? null)} · 输出 {tokens(progress.usage?.total.outputTokens ?? null)} · 总计 {tokens(progress.usage?.total.totalTokens ?? null)}。{progress.usage && <>其中缓存输入 {tokens(progress.usage.total.cachedInputTokens)}、推理输出 {tokens(progress.usage.total.reasoningOutputTokens)} 是子项，不重复相加；用量观察于 {date(progress.usage.observedAt)}。</>}未提供实际费用。原生事件不代替 Turn 终态、Run 结果或交付验收。</p>
    <details className="native-panel-ids"><summary>原生进度来源</summary><p>Thread <code>{progress.threadId}</code>{turn && <> · Turn <code>{turn.id}</code>{turn.source && <> · {turn.source.kind === "run" ? "Run" : "普通消息"} <code>{turn.source.id}</code>{turn.source.taskId && <> · <a href={href(projectId, "task", turn.source.taskId)}>关联任务</a></>}</>}</>}</p></details>
  </section>;
}

export function NativeSessionPanel({ projectId, sessionId, questions, progress, progressError, progressCurrentRead, readError, replyBlockedReason, onAnswer }: {
  projectId: string;
  sessionId: string;
  questions: NativeQuestionView[];
  progress: NativeProgressView | null;
  progressError: string | null;
  progressCurrentRead: boolean;
  readError: string | null;
  replyBlockedReason: string | null;
  onAnswer(requestId: string, expectedVersion: number, answers: Record<string, string[]>): Promise<void>;
}) {
  const visibleQuestions = questions.filter(request => request.sessionId === sessionId);
  const openQuestions = visibleQuestions.filter(request => request.state === "pending" || request.state === "response_saved");
  const closedQuestions = visibleQuestions.filter(request => request.state === "resolved" || request.state === "unavailable");
  const visibleProgress = progress?.sessionId === sessionId && progress.projectId === projectId ? progress : null;
  return <div className="native-session-panel">
    {openQuestions.map(request => <NativeQuestionCard key={`${projectId}:${request.sessionId}:${request.id}`} request={request} projectId={projectId} readHealthy={!readError && !replyBlockedReason} onAnswer={onAnswer} />)}
    {readError && <p className="native-panel-warning" role="alert">原生状态暂不可读取：{readError}。保留上次内容仅供核对，请重新读取后再回答。</p>}
    {replyBlockedReason && openQuestions.length > 0 && <p className="native-panel-warning">{replyBlockedReason}</p>}
    {progressError && <p className="native-panel-warning" role="alert">原生进度暂不可显示：{progressError}</p>}
    {visibleProgress && <NativeProgressCard progress={visibleProgress} projectId={projectId} currentRead={progressCurrentRead} waiting={!!visibleProgress.turn && openQuestions.some(request => request.state === "pending" && request.isBlocking && request.turnId === visibleProgress.turn?.id)} />}
    {closedQuestions.length > 0 && <details className="native-question-history"><summary>已结束的原生提问 · {closedQuestions.length}</summary>
      {closedQuestions.map(request => <NativeQuestionCard key={`${projectId}:${request.sessionId}:${request.id}`} request={request} projectId={projectId} readHealthy={!readError && !replyBlockedReason} onAnswer={onAnswer} />)}
    </details>}
  </div>;
}
