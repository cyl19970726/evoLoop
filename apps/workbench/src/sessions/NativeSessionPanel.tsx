import { useEffect, useState } from "react";
import { date, href } from "../ui/shared";

/** A bounded display model. The API adapter supplies only verified, project-owned facts. */
export interface NativeQuestionView {
  id: string;
  version: number;
  sessionId: string;
  threadId: string | null;
  turnId: string;
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
  questions: Array<{ id: string; header: string; prompt: string; secret: boolean; allowOther: boolean;
    options: Array<{ label: string; description: string; value: string }> }>;
}

export interface NativeProgressView {
  sessionId: string;
  threadId: string | null;
  turnId: string | null;
  state: "running" | "waiting" | "unknown" | "completed" | "failed";
  observedAt: string | null;
  source: string;
  partial: boolean;
  currentTool: string | null;
  planSummary: string | null;
  changeSummary: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
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
  useEffect(() => { setAnswers({}); setOther({}); setProblem(""); setUncertain(false); setSubmitted(false); }, [request.id]);
  const complete = request.questions.length > 0 && request.questions.every(item => !!answers[item.id]?.trim());
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || uncertain || submitted || !readHealthy || request.state !== "pending" || !request.canReply || !complete) return;
    setBusy(true); setProblem("");
    try { await onAnswer(request.id, request.version, Object.fromEntries(Object.entries(answers).map(([key, value]) => [key, [value.trim()]]))); setSubmitted(true); }
    catch (cause) {
      setProblem(cause instanceof Error ? cause.message : "回答结果未能确认；请按原请求回读。");
      setUncertain(true);
    } finally { setBusy(false); }
  }
  return <article className="native-question-card">
    <div className="native-panel-heading"><div><span className="native-panel-kicker">原生执行请求</span><h3>{request.state === "pending" ? "等待回答" : "原生提问记录"}</h3></div><span className="native-panel-state">{request.state === "response_saved" ? "答复已提交" : request.state === "resolved" ? "原生请求已结束" : request.state === "unavailable" ? "请求不可用" : submitted ? "答复已提交，待回读" : request.canReply && readHealthy && !uncertain ? "当前可回答" : "需回读确认"}</span></div>
    <p className="native-panel-context">{request.sourceKind === "run" ? "关联 Run" : request.sourceKind === "message" ? "关联普通消息" : "暂未绑定业务来源"}{request.sourceId && <> <code>{request.sourceId.slice(0, 8)}</code></>} · 请求于 {date(request.requestedAt)} · {request.isBlocking ? "阻塞当前 Turn" : "非阻塞提问"}{request.taskId && <> · <a href={href(projectId, "task", request.taskId)}>关联任务</a></>}</p>
    <details className="native-panel-ids"><summary>原生请求身份</summary><dl><div><dt>请求</dt><dd><code>{request.id}</code></dd></div>{request.threadId && <div><dt>Thread</dt><dd><code>{request.threadId}</code></dd></div>}<div><dt>Turn</dt><dd><code>{request.turnId}</code></dd></div>{request.itemId && <div><dt>Item</dt><dd><code>{request.itemId}</code></dd></div>}</dl></details>
    {request.respondedBy && <p className="native-panel-context">答复者 {request.respondedBy} · {date(request.respondedAt ?? undefined)}；此记录不表示模型已采用答案。</p>}
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
      {request.unavailableReason && <p className="native-panel-warning">{request.unavailableReason}</p>}
      {submitted && <p className="native-panel-warning">回答已提交；请回读原请求状态，不重复发送。</p>}
      {problem && <p className="native-panel-warning" role="alert">{problem}</p>}
      <div className="native-panel-footer"><small>回答将返回这一原生请求；提交后须回读原生状态。</small>{request.state === "pending" && <button type="submit" className="primary" disabled={!request.canReply || !readHealthy || uncertain || submitted || busy || !complete}>{busy ? "提交中…" : submitted ? "等待回读" : "确认回答"}</button>}</div>
    </form>
  </article>;
}

export function NativeSessionPanel({ projectId, sessionId, questions, progress, readError, onAnswer }: {
  projectId: string;
  sessionId: string;
  questions: NativeQuestionView[];
  progress: NativeProgressView | null;
  readError: string | null;
  onAnswer(requestId: string, expectedVersion: number, answers: Record<string, string[]>): Promise<void>;
}) {
  const visibleQuestions = questions.filter(request => request.sessionId === sessionId);
  const visibleProgress = progress?.sessionId === sessionId ? progress : null;
  return <div className="native-session-panel">
    {visibleQuestions.map(request => <NativeQuestionCard key={request.id} request={request} projectId={projectId} readHealthy={!readError} onAnswer={onAnswer} />)}
    {readError && <p className="native-panel-warning" role="alert">原生状态暂不可读取：{readError}。保留上次内容仅供核对，请重新读取后再回答。</p>}
    {visibleProgress && <section className="native-progress-card"><div className="native-panel-heading"><div><span className="native-panel-kicker">来自原生 Turn 的有界观察</span><h2>原生执行进度</h2></div><span className="native-panel-state">{visibleProgress.state === "running" ? "运行中" : visibleProgress.state === "waiting" ? "等待回答" : visibleProgress.state === "completed" ? "Turn 已结束" : visibleProgress.state === "failed" ? "执行失败" : "状态待核对"}</span></div>
      <p className="native-panel-context">观察于 {date(visibleProgress.observedAt ?? undefined)} · 来源 {visibleProgress.source}{visibleProgress.partial && " · 仅显示已读范围"}</p>
      <div className="native-progress-facts"><div><small>当前工具</small><strong>{visibleProgress.currentTool ?? "暂无可确认的工具活动"}</strong></div><div><small>计划进展</small><strong>{visibleProgress.planSummary ?? "暂无可确认的计划变化"}</strong></div><div><small>变更摘要</small><strong>{visibleProgress.changeSummary ?? "暂无可确认的变更"}</strong></div></div>
      <p className="native-progress-usage">Token 用量：{visibleProgress.inputTokens === null && visibleProgress.outputTokens === null ? "暂无可信用量" : `输入 ${visibleProgress.inputTokens ?? "未提供"} · 输出 ${visibleProgress.outputTokens ?? "未提供"}`}。进度通知不代替最终结果与交付验收。</p>
      {visibleProgress.threadId && visibleProgress.turnId && <details className="native-panel-ids"><summary>原生 Turn 身份</summary><p>Thread <code>{visibleProgress.threadId}</code> · Turn <code>{visibleProgress.turnId}</code></p></details>}
    </section>}
  </div>;
}
