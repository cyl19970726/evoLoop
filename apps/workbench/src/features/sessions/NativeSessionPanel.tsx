// Native questions and native progress of one owned agent. Questions sit at the end of the conversation (section
// "questions"); progress and finished questions sit in the right column's details (section "diagnostics"). Only what
// the observation proves is said: a stale or unread observation is the last record, never current work.
import { useEffect, useState } from "react";
import { Button, StatusTag, cn, type StatusTone } from "@evoloop/ui";
import { isUnconfirmed } from "../../shared/api";
import { FullIdentifiers } from "../../shared/ui/FullIdentifiers";
import { mutedText } from "../../shared/ui/PageParts";
import { date } from "../../shared/ui/shared";

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
    source: null | { kind: "run" | "message"; id: string; taskId: string | null; processingId: string | null } };
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

const recordId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const warning = "native-panel-warning rounded-md bg-warning-soft px-3 py-2 text-label text-foreground [overflow-wrap:anywhere]";
const heading = "text-label font-semibold text-foreground";

function questionState(request: NativeQuestionView, submitted: boolean, answerable: boolean): { tone: StatusTone; label: string } {
  if (request.state === "response_saved") return request.responseOutcome === "submitted" ? { tone: "waiting", label: "已发送，待结果" }
    : request.responseOutcome === "unknown" ? { tone: "unknown", label: "发送结果未确认" } : { tone: "waiting", label: "答复已保存" };
  if (request.state === "resolved") return { tone: "history", label: "原生请求已结束" };
  if (request.state === "unavailable") return { tone: "history", label: "请求不可用" };
  if (submitted) return { tone: "waiting", label: "已保存，待回读" };
  return answerable ? { tone: "progress", label: "当前可回答" } : { tone: "unknown", label: "需回读确认" };
}

function NativeQuestionCard({ request, projectId, readHealthy, onAnswer, taskHref, compact }: {
  request: NativeQuestionView;
  projectId: string;
  readHealthy: boolean;
  taskHref(id: string): string;
  onAnswer(requestId: string, expectedVersion: number, answers: Record<string, string[]>): Promise<void>;
  /** Finished questions in the right column: a plain record instead of a raised card. */
  compact?: boolean;
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
  const locked = request.state !== "pending" || !request.canReply || !readHealthy || uncertain || submitted || busy;
  const state = questionState(request, submitted, request.canReply && readHealthy && !uncertain);
  const source = request.sourceKind === "run" ? "来源：任务运行" : request.sourceKind === "message" ? "来源：普通消息" : "暂未关联业务来源";
  const responder = request.respondedBy && !recordId.test(request.respondedBy) ? request.respondedBy : null;
  const choice = "group flex w-full cursor-pointer items-center gap-2.5 rounded-md bg-muted px-3 py-2.5 text-left text-small text-text-secondary transition-colors duration-150 hover:bg-field has-[:checked]:bg-accent has-[:checked]:text-foreground has-[:focus-visible]:shadow-[var(--focus-ring)] has-[:disabled]:cursor-default has-[:disabled]:hover:bg-muted";
  const letter = "flex size-[22px] shrink-0 items-center justify-center rounded-[7px] bg-field text-caption font-semibold text-text-secondary group-has-[:checked]:bg-primary group-has-[:checked]:text-primary-foreground";
  const textField = "w-full rounded-md border-0 bg-field px-3 py-2.5 text-small text-foreground outline-none placeholder:text-muted-foreground focus-visible:shadow-[var(--focus-ring)] disabled:opacity-50";
  return <article className={cn("native-question-card flex min-w-0 flex-col gap-3", compact ? "border-t border-border pt-3 first:border-t-0 first:pt-0" : "rounded-xl bg-raised p-4 shadow-md")}>
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h3 className={compact ? heading : "text-body font-semibold text-foreground"}>{request.state === "pending" ? "等待回答" : "原生提问记录"}</h3>
      <StatusTag tone={state.tone} label={state.label} />
    </div>
    <p className={mutedText}>{source} · 请求于 {date(request.requestedAt)} · {request.isBlocking ? "这一轮在等回答" : "不阻塞这一轮"}{request.taskId && <> · <a className="text-primary hover:underline" href={taskHref(request.taskId)}>关联任务</a></>}</p>
    {request.respondedBy && <p className={mutedText}>{responder ? `答复者 ${responder}` : "已有人答复（答复者见完整标识）"} · {date(request.respondedAt ?? undefined)}；此记录不表示模型已采用答案。</p>}
    {request.responseOutcome === "unknown" && <p className={warning}>原生发送结果未确认。请核对原请求状态，不要重复回答。</p>}
    <form className="flex flex-col gap-3" onSubmit={event => void submit(event)}>{request.questions.map((item, questionIndex) => <fieldset key={item.id} disabled={locked} className="m-0 flex min-w-0 flex-col gap-2 border-0 p-0">
      <legend className="mb-1 p-0 text-label font-semibold text-text-secondary">{item.header || "需要你的回答"}</legend>
      <p className="text-small text-foreground [overflow-wrap:anywhere]">{item.prompt}</p>
      {item.options.length ? <><div className="flex flex-col gap-1.5">{item.options.map((choiceItem, index) => <label key={choiceItem.value} className={choice}>
        <input type="radio" className="sr-only" name={`${request.id}:${item.id}`} value={choiceItem.value} checked={!other[item.id] && answers[item.id] === choiceItem.value} onChange={() => { setOther(old => ({ ...old, [item.id]: false })); setAnswers(old => ({ ...old, [item.id]: choiceItem.value })); }} />
        <span aria-hidden="true" className={letter}>{String.fromCharCode(65 + index)}</span>
        <span className="flex min-w-0 flex-col gap-0.5"><span className="[overflow-wrap:anywhere]">{choiceItem.label}</span>{choiceItem.description && <small className={mutedText}>{choiceItem.description}</small>}</span>
      </label>)}
        {item.allowOther && <label className={choice}>
          <input type="radio" className="sr-only" name={`${request.id}:${item.id}`} checked={!!other[item.id]} onChange={() => { setOther(old => ({ ...old, [item.id]: true })); setAnswers(old => ({ ...old, [item.id]: "" })); }} />
          <span aria-hidden="true" className={letter}>{String.fromCharCode(65 + item.options.length)}</span>其他回答
        </label>}</div>
        {item.allowOther && other[item.id] && (item.secret
          ? <input type="password" className={cn(textField, "h-9 py-0")} aria-label={`${item.header || item.prompt}的其他回答`} autoComplete="off" value={answers[item.id] ?? ""} maxLength={4000} onChange={event => setAnswers(old => ({ ...old, [item.id]: event.target.value }))} />
          : <textarea className={cn(textField, "min-h-16")} aria-label={`${item.header || item.prompt}的其他回答`} placeholder="直接写你的回答" value={answers[item.id] ?? ""} maxLength={4000} onChange={event => setAnswers(old => ({ ...old, [item.id]: event.target.value }))} />)}</>
        : item.secret ? <input type="password" className={cn(textField, "h-9 py-0")} aria-label={item.header || item.prompt} autoComplete="off" value={answers[item.id] ?? ""} maxLength={4000} onChange={event => setAnswers(old => ({ ...old, [item.id]: event.target.value }))} />
          : <textarea className={cn(textField, "min-h-16")} aria-label={item.header || item.prompt} placeholder={questionIndex === 0 ? "直接写你的回答" : undefined} value={answers[item.id] ?? ""} maxLength={4000} onChange={event => setAnswers(old => ({ ...old, [item.id]: event.target.value }))} />}
    </fieldset>)}
      {request.unavailableReason && (request.state === "unavailable" || request.state === "resolved" || request.state === "pending" && !request.canReply) && <p className={warning}>{request.unavailableReason}</p>}
      {submitted && <p className={warning}>回答已保存；请回读原请求状态，不重复发送。</p>}
      {problem && <p className={warning} role="alert">{problem}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <small className={mutedText}>回答会先保存，再尝试返回原生请求；以回读状态为准。</small>
        {request.state === "pending" && <Button type="submit" variant="primary" className="ml-auto" disabled={!request.canReply || !readHealthy || uncertain || submitted || busy || !complete}>{busy ? "保存中…" : submitted ? "等待回读" : "确认回答"}</Button>}
      </div>
    </form>
    <FullIdentifiers rows={[
      { label: "请求", value: request.id }, { label: "对话线程", value: request.threadId }, { label: "这一轮", value: request.turnId },
      { label: "条目", value: request.itemId }, { label: request.sourceKind === "run" ? "来源运行" : "来源消息", value: request.sourceId },
      { label: "答复者", value: request.respondedBy && !responder ? request.respondedBy : null },
    ]} />
  </article>;
}

const itemStateLabel = { inProgress: "进行中", completed: "已结束", failed: "失败", declined: "已拒绝" } as const;
const stepStateLabel = { pending: "待进行", inProgress: "进行中", completed: "已完成" } as const;
const staleReasonLabel: Record<string, string> = { disconnected: "原生连接已断开", connection_unavailable: "当前原生连接不可用",
  projection_unavailable: "进度记录暂不可读取", restart: "原生连接已重启" };
const tokens = (value: number | null) => value === null ? "未提供" : value.toLocaleString("zh-CN");
const stateTone = (label: string): StatusTone => label === "运行中" ? "progress" : label === "等待回答" ? "waiting"
  : label === "这一轮执行失败" || label === "原生观察异常" ? "blocked" : label === "这一轮已结束" || label === "这一轮已中断" ? "done"
    : label === "观察待核对" || label === "状态待核对" ? "unknown" : "idle";

function NativeProgressCard({ progress, currentRead, waiting, taskHref }: {
  progress: NativeProgressView; currentRead: boolean; waiting: boolean; taskHref(id: string): string;
}) {
  const fresh = currentRead && progress.freshness === "live";
  const turn = progress.turn;
  const turnEnded = turn !== null && ["completed", "failed", "interrupted"].includes(turn.status);
  const stateLabel = !fresh ? "观察待核对" : progress.status === "notLoaded" ? "原生会话尚未加载"
    : progress.status === "systemError" ? "原生观察异常"
    : turn?.status === "completed" ? "这一轮已结束" : turn?.status === "failed" ? "这一轮执行失败"
    : turn?.status === "interrupted" ? "这一轮已中断"
    : waiting ? "等待回答"
    : progress.status === "active" && turn?.status === "inProgress" ? "运行中"
    : progress.status === "idle" && turn?.status !== "inProgress" ? "原生活动空闲 · 写入控制待核" : "状态待核对";
  const tool = fresh && progress.status === "active" && turn?.status === "inProgress"
    ? progress.items.filter(item => item.status === "inProgress").at(-1) ?? progress.items.at(-1)
    : progress.items.at(-1);
  const partial = progress.items.length === 10 || progress.items.some(item => item.truncated)
    || !!progress.plan?.truncated || !!progress.diff?.truncated;
  const planDone = progress.plan?.steps.filter(step => step.status === "completed").length ?? 0;
  const itemState = (status: keyof typeof itemStateLabel) => turnEnded && status === "inProgress" ? "这一轮结束时结果未确认" : fresh ? itemStateLabel[status]
    : status === "inProgress" ? "当时进行中，当前待核对" : `上次记录：${itemStateLabel[status]}`;
  const stepState = (status: keyof typeof stepStateLabel) => turnEnded && status === "inProgress" ? "这一轮结束时结果未确认" : fresh ? stepStateLabel[status]
    : status === "inProgress" ? "当时进行中，当前待核对" : `上次记录：${stepStateLabel[status]}`;
  const staleReason = progress.staleReason ? staleReasonLabel[progress.staleReason] ?? "原因待核对" : null;
  const fact = (label: string, value: string) => <div className="flex min-w-0 flex-col gap-0.5">
    <small className={mutedText}>{label}</small><strong className="text-small font-medium text-foreground [overflow-wrap:anywhere]">{value}</strong>
  </div>;
  const detail = "min-w-0 text-label text-text-secondary [&>summary]:w-fit [&>summary]:cursor-pointer [&>summary]:text-text-secondary hover:[&>summary]:text-foreground";
  return <section className="native-progress-card flex min-w-0 flex-col gap-2.5" aria-label="原生执行进度">
    <div className="flex flex-wrap items-center justify-between gap-2"><h3 className={heading}>原生执行进度</h3><StatusTag tone={stateTone(stateLabel)} label={stateLabel} /></div>
    <p className={mutedText}>最近事件 {date(progress.lastEventAt)} · 记录于 {date(progress.observedAt)} · {partial ? "仅展示最近有界范围" : "仅展示已观察到的事件"}</p>
    {fresh && progress.status === "idle" && <p className={warning}>此处只确认原生会话当时没有进行中的一轮；当前对话线程的写入控制仍待核对。</p>}
    {fresh && turn?.status === "inProgress" && <p className={warning}>原生宿主回报这一轮进行中，连接与绑定仍匹配；最近事件时间单独列示，不能据此确认仍在有效推进，也不能仅凭无新事件判定失败。</p>}
    {!fresh && <p className={warning}>{!currentRead ? "当前页面尚未重新读到进度。" : "原生连接的观察已过期。"}{staleReason ? ` 原因：${staleReason}。` : ""}以下是上次记录，不能代表当前仍在执行。</p>}
    {fresh && progress.status === "systemError" && <p className={warning}>原生状态报告异常；请结合任务的运行记录和原生终态核对。</p>}
    {turnEnded && (progress.items.some(item => item.status === "inProgress") || progress.plan?.steps.some(step => step.status === "inProgress")) &&
      <p className={warning}>这一轮已结束，部分工具或计划步骤的结果尚未确认；这些记录不代表仍在执行。</p>}
    <div className="native-progress-facts flex flex-col gap-2">
      {fact(fresh && stateLabel === "运行中" && tool?.status === "inProgress" ? "当前工具" : "最近工具活动", tool ? `${tool.name} · ${itemState(tool.status)}` : "暂无可确认的工具活动")}
      {fact("计划进展", progress.plan ? `${fresh ? "" : "上次记录："}${planDone}/${progress.plan.steps.length} 步已完成${progress.plan.truncated ? " · 已截断" : ""}` : "暂无可确认的计划变化")}
      {fact(fresh ? "变更通知" : "上次变更通知", `${progress.diff ? progress.diff.hasContent ? "已观察到变更；内容需在受权原生历史核对" : "已观察到变更通知" : "暂无可确认的变更"}${progress.diff?.truncated ? " · 已截断" : ""}`)}
    </div>
    {turn?.source && <p className={mutedText}>这一轮的来源：{turn.source.kind === "run" ? "任务运行" : "普通消息"}{turn.source.taskId && <> · <a className="text-primary hover:underline" href={taskHref(turn.source.taskId)}>关联任务</a></>}</p>}
    {progress.items.length > 0 && <details className={detail}><summary>最近工具活动 · {progress.items.length} 项</summary><ol className="mt-1.5 flex list-decimal flex-col gap-1 pl-5">{progress.items.map(item => <li key={item.id} className="[overflow-wrap:anywhere]"><strong className="font-medium text-foreground">{item.name}</strong> · {itemState(item.status)}{item.truncated && " · 名称已截断"}</li>)}</ol></details>}
    {progress.plan && <details className={detail}><summary>计划步骤</summary><ol className="mt-1.5 flex list-decimal flex-col gap-1 pl-5">{progress.plan.steps.map((step, index) => <li key={`${index}:${step.step}`} className="[overflow-wrap:anywhere]">{stepState(step.status)} · {step.step}</li>)}</ol>{progress.plan.explanation && <p className="mt-1.5 [overflow-wrap:anywhere]">{progress.plan.explanation}</p>}<small className={mutedText}>观察于 {date(progress.plan.observedAt)}{progress.plan.truncated && " · 原生内容已截断"}</small></details>}
    {progress.diff && <details className={detail}><summary>变更通知来源</summary><p className="mt-1.5">这里只展示通知，不展示原生变更文本；请在受权的原生历史中核对内容。</p><small className={mutedText}>观察于 {date(progress.diff.observedAt)}{progress.diff.truncated && " · 原生通知文本已截断"}</small></details>}
    <p className={mutedText}>{fresh ? "累计用量（token）" : "上次记录的累计用量（token）"}：输入 {tokens(progress.usage?.total.inputTokens ?? null)} · 输出 {tokens(progress.usage?.total.outputTokens ?? null)} · 总计 {tokens(progress.usage?.total.totalTokens ?? null)}。{progress.usage && <>其中缓存输入 {tokens(progress.usage.total.cachedInputTokens)}、推理输出 {tokens(progress.usage.total.reasoningOutputTokens)} 是子项，不重复相加；用量观察于 {date(progress.usage.observedAt)}。</>}未提供实际费用。原生事件不代替这一轮的终态、运行结果或交付验收。</p>
    <FullIdentifiers summary="原生进度来源" rows={[
      { label: "对话线程", value: progress.threadId }, { label: "这一轮", value: turn?.id },
      { label: turn?.source?.kind === "run" ? "来源运行" : "来源消息", value: turn?.source?.id },
      { label: "消息处理记录", value: turn?.source?.processingId },
    ]} />
  </section>;
}

export function NativeSessionPanel({ projectId, sessionId, questions, progress, progressError, progressCurrentRead, readError, replyBlockedReason, onAnswer, taskHref, section = "all" }: {
  projectId: string;
  sessionId: string;
  questions: NativeQuestionView[];
  progress: NativeProgressView | null;
  progressError: string | null;
  progressCurrentRead: boolean;
  readError: string | null;
  replyBlockedReason: string | null;
  onAnswer(requestId: string, expectedVersion: number, answers: Record<string, string[]>): Promise<void>;
  taskHref(id: string): string;
  section?: "all" | "questions" | "diagnostics";
}) {
  const visibleQuestions = questions.filter(request => request.sessionId === sessionId);
  const openQuestions = visibleQuestions.filter(request => request.state === "pending" || request.state === "response_saved");
  const closedQuestions = visibleQuestions.filter(request => request.state === "resolved" || request.state === "unavailable");
  const visibleProgress = progress?.sessionId === sessionId && progress.projectId === projectId ? progress : null;
  return <div className="native-session-panel flex min-w-0 flex-col gap-3">
    {section !== "diagnostics" && openQuestions.map(request => <NativeQuestionCard key={`${projectId}:${request.sessionId}:${request.id}`} request={request} projectId={projectId} readHealthy={!readError && !replyBlockedReason} onAnswer={onAnswer} taskHref={taskHref} />)}
    {section !== "diagnostics" && readError && <p className={warning} role="alert">原生状态暂不可读取：{readError}。保留上次内容仅供核对，请重新读取后再回答。</p>}
    {section !== "diagnostics" && replyBlockedReason && openQuestions.length > 0 && <p className={warning}>{replyBlockedReason}</p>}
    {section !== "questions" && progressError && <p className={warning} role="alert">原生进度暂不可显示：{progressError}</p>}
    {section !== "questions" && visibleProgress && <NativeProgressCard progress={visibleProgress} currentRead={progressCurrentRead} waiting={!!visibleProgress.turn && openQuestions.some(request => request.state === "pending" && request.isBlocking && request.turnId === visibleProgress.turn?.id)} taskHref={taskHref} />}
    {section !== "questions" && closedQuestions.length > 0 && <details className="native-question-history min-w-0 text-label text-text-secondary [&>summary]:w-fit [&>summary]:cursor-pointer hover:[&>summary]:text-foreground"><summary>已结束的原生提问 · {closedQuestions.length}</summary>
      <div className="mt-2 flex flex-col gap-3">{closedQuestions.map(request => <NativeQuestionCard key={`${projectId}:${request.sessionId}:${request.id}`} compact request={request} projectId={projectId} readHealthy={!readError && !replyBlockedReason} onAnswer={onAnswer} taskHref={taskHref} />)}</div>
    </details>}
  </div>;
}
