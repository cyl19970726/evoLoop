import type { ObservedSession, ObservedTask, SessionResult } from "@evoloop/contracts/session-observation";
import type { NativeProgressView } from "./NativeSessionPanel";

type StatusSource = Pick<ObservedSession, "kind" | "runtimeState" | "busy"> & {
  latestBusinessRun?: { id?: string; state: string } | null;
};

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

export function sessionLifecycleLabel(session: StatusSource): string {
  if (session.kind === "external") return "外部接入，原会话状态需核对";
  return session.runtimeState ? lifecycle[session.runtimeState] ?? "生命周期状态未识别" : "生命周期未知";
}

export function sessionStatusLabel(session: StatusSource): string {
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

/** Header wording for people, from the same facts as sessionHeaderStatusLabel; it never promotes a record to live work. */
export function agentHeaderStatus(session: StatusSource, progress: NativeProgressView | null,
  currentRead: boolean, runtimeAvailable: boolean | null): string {
  if (session.kind !== "owned" || session.runtimeState !== "ready") return agentStatusLabel(session);
  if (runtimeAvailable === false) return "连接不可用 · 状态待核对";
  if (!currentRead || runtimeAvailable !== true || progress?.freshness !== "live") return agentStatusLabel(session);
  const turn = progress.turn;
  if (progress.status === "active" && turn?.status === "inProgress") {
    if (session.busy !== true) return "运行记录不一致，待核对";
    if (turn.source?.kind === "message") return "正在回复消息";
    if (turn.source?.kind === "run") return turn.source.id === session.latestBusinessRun?.id && session.latestBusinessRun.state === "running"
      ? "正在执行任务" : "正在执行 · 任务记录待核对";
    return "正在运行 · 来源待核对";
  }
  if (session.busy === true) return "有在途工作 · 执行待核对";
  if (progress.status === "idle" && turn?.status !== "inProgress" && session.busy === false) return "空闲";
  return "执行状态待核对";
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
