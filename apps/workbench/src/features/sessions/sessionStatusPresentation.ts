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
    if (session.runtimeState !== "ready") return `PG记录：${sessionLifecycleLabel(session)} · 原生状态待核`;
    return session.busy === true ? "PG记录：有在途占用 · 原生状态待核"
      : session.busy === false ? "PG记录：无在途占用 · 原生状态待核"
        : "PG记录：占用状态未知 · 原生状态待核";
  }
  return session.busy === true ? "有活动" : session.busy === false ? "空闲" : "状态未知";
}

/** The header may describe an exact native Turn, but never promote the latest PG Run to live work. */
export function sessionHeaderStatusLabel(session: StatusSource, progress: NativeProgressView | null,
  currentRead: boolean, runtimeAvailable: boolean | null): string {
  if (session.kind !== "owned") return sessionStatusLabel(session);
  if (session.runtimeState !== "ready") return sessionLifecycleLabel(session);
  if (runtimeAvailable === false) return session.busy === true
    ? "原生连接不可用 · PG有在途记录" : "原生连接不可用 · PG状态待核";
  if (!currentRead || runtimeAvailable !== true || progress?.freshness !== "live") return sessionStatusLabel(session);
  const turn = progress.turn;
  if (progress.status === "active" && turn?.status === "inProgress") {
    if (session.busy !== true) return "原生 Turn 与 PG 占用不一致，待核对";
    if (turn.source?.kind === "message") return "原生宿主回报消息 Turn 进行中";
    if (turn.source?.kind === "run") return turn.source.id === session.latestBusinessRun?.id
      && session.latestBusinessRun.state === "running"
      ? "原生宿主回报 Run Turn 进行中" : "原生 Turn 进行中 · Run 记录待核";
    return "原生 Turn 进行中 · 来源待核";
  }
  if (session.busy === true) return "PG有在途记录 · 原生执行待核";
  if (progress.status === "idle" && turn?.status !== "inProgress" && session.busy === false) return "原生活动空闲 · writer待核";
  return "原生执行状态待核对";
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
  if (work.relation === "accepted") return "具体 Session 已接手";
  if (work.relation === "assigned") return "已分派，待确认接手";
  if (work.relation === "run") return "有 Run 关联；不表示具体分派已接受";
  if (work.relation !== "claimed") return "角色责任，不代表已接手";
  const run = session.latestBusinessRun?.taskId === work.id ? session.latestBusinessRun : null;
  if (!run) return "Run／队列已认领或占用；当前运行待核对";
  if (run.state === "requested") return "最近 Run 记录待启动；当前执行待核";
  if (run.state === "dispatching") return "最近 Run 记录启动中；当前执行待核";
  if (run.state === "running") return "最近 Run 记录运行中；当前执行待核";
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
  return "PG记录无在途占用，原生状态待核";
}
