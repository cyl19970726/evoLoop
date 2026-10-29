import type { ObservedSession, ObservedTask, SessionResult } from "@evoloop/contracts/session-observation";

type StatusSource = Pick<ObservedSession, "kind" | "runtimeState" | "busy"> & {
  latestBusinessRun?: { state: string } | null;
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
    if (session.runtimeState !== "ready") return sessionLifecycleLabel(session);
    if (session.busy === true) {
      const state = session.latestBusinessRun?.state;
      if (state === "running") return "运行中";
      if (state === "dispatching") return "启动中";
      if (state === "requested") return "待启动";
      return "结果待核对";
    }
    return session.busy === false ? "空闲" : "活动状态未知";
  }
  return session.busy === true ? "有活动" : session.busy === false ? "空闲" : "状态未知";
}

export function sessionHeaderStatusLabel(session: StatusSource, messageRunning: boolean): string {
  return session.kind === "owned" && session.runtimeState === "ready" && session.busy === true && messageRunning
    ? "消息处理中" : sessionStatusLabel(session);
}

export function currentWorkRelationLabel(work: ObservedTask, session: StatusSource & Pick<ObservedSession, "latestBusinessRun">,
  recoveryPhase?: string): string {
  if (work.relation === "accepted") return "具体 Session 已接手";
  if (work.relation === "assigned") return "已分派，待确认接手";
  if (work.relation === "run") return "有 Run 关联；不表示具体分派已接受";
  if (work.relation !== "claimed") return "角色责任，不代表已接手";
  const run = session.latestBusinessRun?.taskId === work.id ? session.latestBusinessRun : null;
  if (!run) return "Run／队列已认领或占用；当前运行待核对";
  if (run.state === "requested") return "Run 已认领，本次运行待启动";
  if (run.state === "dispatching") return "Run 已认领，本次运行启动中";
  if (run.state === "running") return "Run 已认领，本次运行中";
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
  return "当前空闲";
}
