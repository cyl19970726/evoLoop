import type { ObservedSession, ObservedTask, SessionResult } from "@evoloop/contracts/session-observation";
import type { StatusTone } from "@evoloop/ui";
import type { NativeProgressView } from "./NativeSessionPanel";

type StatusSource = Pick<ObservedSession, "kind" | "runtimeState" | "busy"> & {
  dispatch?: ObservedSession["dispatch"];
  latestBusinessRun?: { id?: string; state: string } | null;
};

/** The words for the header, the bubble and the right rail while the agent answers a message: one phrase, so the three say the same. */
export function replyingPhrase(from: "me" | string | null): string {
  return from === "me" ? "正在回复你的消息" : from ? `正在回复${from}的消息` : "正在回复消息";
}

const lifecycle: Record<string, string> = {
  reserved: "已预留", creating: "创建中", ready: "就绪", closing: "关闭中", unknown: "生命周期待核对", closed: "已关闭",
};
const runStates: Record<string, string> = {
  requested: "待启动", dispatching: "启动中", running: "运行中", completed: "已结束",
  failed: "失败", interrupted: "已中断", unknown: "结果未知",
};
export function runStateLabel(state: string): string {
  return runStates[state] ?? `状态待核对（${state}）`;
}

/**
 * "ready" is the stored lifecycle, not "can take work": a Session the coordinator judged unable to start a Run (no business identity, no native thread,
 * the judgement itself failing) is labelled 不可用 with the first reason, in every place a status is written. Absent `dispatch` is an older server that
 * did not judge: the label is the old one.
 */
export function unusableLabel(session: StatusSource): string | null {
  if (session.kind !== "owned" || session.dispatch?.usable !== false) return null;
  const first = session.dispatch.reasons[0]?.reason ?? "原因待核对";
  return `不可用 · ${first.length > 40 ? `${first.slice(0, 39)}…` : first}`;
}

export function sessionLifecycleLabel(session: StatusSource): string {
  if (session.kind === "external") return "外部接入，原会话状态需核对";
  return session.runtimeState ? lifecycle[session.runtimeState] ?? "生命周期状态未识别" : "生命周期未知";
}

export function sessionStatusLabel(session: StatusSource): string {
  const unusable = unusableLabel(session);
  if (unusable) return `项目记录：${unusable}`;
  if (session.kind === "owned") {
    if (session.runtimeState !== "ready") return `项目记录：${sessionLifecycleLabel(session)} · 原生状态待核`;
    return session.busy === true ? "项目记录：有在途占用 · 原生状态待核"
      : session.busy === false ? "项目记录：无在途占用 · 原生状态待核"
        : "项目记录：占用状态未知 · 原生状态待核";
  }
  return session.busy === true ? "有活动" : session.busy === false ? "空闲" : "状态未知";
}

/** Directory wording for people: what the project record says, without claiming live state it has not checked. */
export function agentStatusLabel(session: StatusSource): string {
  const unusable = unusableLabel(session);
  if (unusable) return unusable;
  if (session.kind === "external") return session.busy === true ? "外部 · 有活动" : session.busy === false ? "外部 · 空闲" : "外部 · 状态未知";
  if (session.runtimeState !== "ready") return lifecycle[session.runtimeState ?? ""] ?? "状态待核对";
  return session.busy === true ? "有在途工作" : session.busy === false ? "无在途工作" : "占用待核对";
}

/** The header may describe an exact native turn, but never promote the latest recorded run to live work. */
export function sessionHeaderStatusLabel(session: StatusSource, progress: NativeProgressView | null,
  currentRead: boolean, runtimeAvailable: boolean | null): string {
  if (session.kind !== "owned") return sessionStatusLabel(session);
  if (session.runtimeState !== "ready") return sessionLifecycleLabel(session);
  if (runtimeAvailable === false) return session.busy === true
    ? "原生连接不可用 · 项目记录有在途工作" : "原生连接不可用 · 项目记录待核";
  if (!currentRead || runtimeAvailable !== true || progress?.freshness !== "live") return sessionStatusLabel(session);
  const turn = progress.turn;
  if (progress.status === "active" && turn?.status === "inProgress") {
    if (session.busy !== true) return "原生这一轮与项目记录的占用不一致，待核对";
    if (turn.source?.kind === "message") return "原生宿主回报：正在回复消息";
    if (turn.source?.kind === "run") return turn.source.id === session.latestBusinessRun?.id
      && session.latestBusinessRun.state === "running"
      ? "原生宿主回报：正在执行任务" : "原生这一轮进行中 · 任务运行记录待核";
    return "原生这一轮进行中 · 来源待核";
  }
  if (session.busy === true) return "项目记录有在途工作 · 原生执行待核";
  if (progress.status === "idle" && turn?.status !== "inProgress" && session.busy === false) return "原生活动空闲 · 写入控制待核";
  return "原生执行状态待核对";
}

/**
 * What the header may add to the status: for whom and for which Task (Task f2d82dfe). Each is read separately and says nothing when
 * it is not read: an unread sender gives "正在回复消息", an unread title gives "正在执行任务", never a guess.
 */
export interface HeaderFacts {
  /** The held provider's cause in words (额度不足或欠费 / 鉴权失败), when the agent's provider is paused. */
  holdReason?: string | null;
  /** Who sent the message being answered: "me", or the sender class's short name; null when not read. */
  replyingTo?: "me" | string | null;
  /** The title of the Task being worked on, when read. */
  taskTitle?: string | null;
  /** How the Run in progress was dispatched, already in words ("Leader 派发"); null when not read. */
  dispatch?: string | null;
  /** How long the agent has been idle, already in words ("3 小时"); null when no time is known. */
  idleFor?: string | null;
}

/** How long, in the largest whole unit: 刚刚 / N 分钟 / N 小时 / N 天. */
export function idleDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 60_000) return "刚刚";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours} 小时` : `${Math.floor(hours / 24)} 天`;
}

/**
 * The one judgement behind an agent's status, for the directory row and the page header alike (Task f1e8829a): which of these the
 * agent is in, and the tone of its mark. Both places derive their words from `kind`; neither decides it again. Only facts the directory
 * read carries are used (busy, current Task, awaiting reader, lifecycle, dispatch) plus the two read at project level (the provider
 * hold and whether the native connection is available); a fact that was not read says 状态未读到 or 状态待核对, never 空闲.
 */
export type AgentStatusKind = "held" | "waiting" | "unusable" | "unread" | "lifecycle" | "unverified" | "working" | "replying" | "idle";
export interface AgentStatusFacts { holdReason?: string | null; runtimeAvailable?: boolean | null }
export interface AgentStatus { kind: AgentStatusKind; tone: StatusTone; waitingOnMe: boolean }
const kindTone: Record<AgentStatusKind, StatusTone> = {
  held: "blocked", waiting: "waiting", unusable: "blocked", unread: "unknown", lifecycle: "blocked", unverified: "unknown",
  working: "progress", replying: "progress", idle: "idle",
};
export function agentStatus(session: StatusSource & Pick<ObservedSession, "currentTask"> & { awaitingReader?: boolean }, facts: AgentStatusFacts = {}): AgentStatus {
  const kind = ((): AgentStatusKind => {
    const owned = session.kind === "owned";
    if (owned && facts.holdReason) return "held";
    if (owned && session.awaitingReader === true) return "waiting";
    if (unusableLabel(session)) return "unusable";
    if (!owned || session.busy === null || session.busy === undefined) return "unread";
    if (session.runtimeState !== "ready") return "lifecycle";
    if (facts.runtimeAvailable === false) return "unverified";
    if (session.busy) return session.currentTask?.title ? "working" : "replying";
    return "idle";
  })();
  return { kind, tone: kindTone[kind], waitingOnMe: kind === "waiting" };
}

/** Header wording for people: the same judgement as the directory row (agentStatus), in the long form; native detail only refines it. */
export function agentHeaderStatus(session: StatusSource & Pick<ObservedSession, "currentTask"> & { awaitingReader?: boolean }, progress: NativeProgressView | null,
  currentRead: boolean, runtimeAvailable: boolean | null, facts: HeaderFacts = {}): string {
  const { kind } = agentStatus(session, { holdReason: facts.holdReason, runtimeAvailable });
  const title = facts.taskTitle ?? session.currentTask?.title ?? null;
  const doing = () => title ? `正在做任务「${title}」（${facts.dispatch ?? "来源待核对"}）` : "正在执行任务";
  switch (kind) {
    case "held": return `已暂停（${facts.holdReason}）`;
    case "waiting": return "等你处理";
    case "unusable": return unusableLabel(session)!;
    case "unread": case "lifecycle": return agentStatusLabel(session);
    case "unverified": return "连接不可用 · 状态待核对";
    default: break;
  }
  if (currentRead && runtimeAvailable === true && progress?.freshness === "live") {
    const turn = progress.turn;
    if (progress.status === "active" && turn?.status === "inProgress") {
      if (session.busy !== true) return "运行记录不一致，待核对";
      if (turn.source?.kind === "message") return replyingPhrase(facts.replyingTo ?? null);
      if (turn.source?.kind === "run") return turn.source.id === session.latestBusinessRun?.id && session.latestBusinessRun.state === "running"
        ? doing() : "正在执行 · 任务记录待核对";
      return "正在运行 · 来源待核对";
    }
  }
  if (kind === "working") return doing();
  if (kind === "replying") return replyingPhrase(facts.replyingTo ?? null);
  return facts.idleFor ? `空闲 · 已 ${facts.idleFor}` : "空闲";
}

/** The activity feed needs an exact live binding; busy and latest Run alone are insufficient. */
export function currentNativeRunId(session: StatusSource, progress: NativeProgressView | null,
  currentRead: boolean, runtimeAvailable: boolean | null): string | null {
  const turn = progress?.turn;
  return currentRead && runtimeAvailable === true && session.kind === "owned" && session.runtimeState === "ready" && session.busy === true
    && progress?.freshness === "live" && progress.status === "active" && turn?.status === "inProgress"
    && turn.source?.kind === "run" && turn.source.id === session.latestBusinessRun?.id
    && session.latestBusinessRun.state === "running"
    ? turn.source.id : null;
}

export function currentWorkRelationLabel(work: ObservedTask, session: StatusSource & Pick<ObservedSession, "latestBusinessRun">,
  recoveryPhase?: string): string {
  if (work.relation === "accepted") return "这个智能体已接手";
  if (work.relation === "assigned") return "已分派，待确认接手";
  if (work.relation === "run") return "有运行关联；不表示分派已被接受";
  if (work.relation !== "claimed") return "职责范围内的任务，不代表已接手";
  const run = session.latestBusinessRun?.taskId === work.id ? session.latestBusinessRun : null;
  if (!run) return "已从执行队列领取或占用；当前运行待核对";
  if (run.state === "requested") return "最近一次运行记录为待启动；当前执行待核";
  if (run.state === "dispatching") return "最近一次运行记录为启动中；当前执行待核";
  if (run.state === "running") return "最近一次运行记录为运行中；当前执行待核";
  if (run.state === "completed") {
    if (recoveryPhase === "reworking") return "前次执行已结束，同任务返工待运行";
    if (recoveryPhase === "retrying") return "前次执行已结束，已批准重试待运行";
    return recoveryPhase === "awaiting_acceptance"
      ? "执行已结束，等待交付与验收" : "最近一次执行已结束，结果待核对";
  }
  if (run.state === "failed") return "最近一次执行失败，待核对";
  if (run.state === "interrupted") return "最近一次执行已中断，待核对";
  return "最近一次执行结果未知，待核对";
}

export function latestSessionResult(results: SessionResult[]): SessionResult | null {
  return results.reduce<SessionResult | null>((latest, result) =>
    !latest || result.submittedAt > latest.submittedAt || result.submittedAt === latest.submittedAt && result.deliveryId > latest.deliveryId
      ? result : latest, null);
}

export function idleSessionResult(session: StatusSource, work: ObservedTask | null, results: SessionResult[]): SessionResult | null {
  return !work && session.kind === "owned" && session.runtimeState === "ready" && session.busy === false
    ? latestSessionResult(results) : null;
}

export function sessionResultUseLabel(result: SessionResult): string {
  if (!result.latestUse) return "尚无实际使用观察";
  return ({ used: "已记录使用", failed: "使用观察失败", notUsed: "已记录未使用" } as Record<string, string>)[result.latestUse.result]
    ?? "使用状态需核对";
}

export function sessionIdleSummary(session: StatusSource): string {
  if (session.kind === "external") return session.busy === false ? "外部观察为空闲" : "外部会话状态需核对";
  if (session.runtimeState !== "ready" || session.busy !== false) return sessionStatusLabel(session);
  return "项目记录无在途占用，原生状态待核";
}

/** The directory row's sentence for an agent: the short form of the judgement agentStatus makes (the header writes the long form). */
export interface RowStatus { tone: StatusTone; text: string; waitingOnMe: boolean }
export function agentRowStatus(session: ObservedSession, facts: AgentStatusFacts = {}): RowStatus {
  const status = agentStatus(session, facts);
  const text = ({
    held: `已暂停（${facts.holdReason}）`, waiting: "等你处理", unusable: unusableLabel(session) ?? "", unread: "状态未读到",
    lifecycle: agentStatusLabel(session), unverified: "状态待核对", working: `正在做 ${session.currentTask?.title}`, replying: "在回复消息", idle: "空闲",
  } satisfies Record<AgentStatusKind, string>)[status.kind];
  return { tone: status.tone, text, waitingOnMe: status.waitingOnMe };
}
