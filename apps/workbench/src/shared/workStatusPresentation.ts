import type { Task } from "@evoloop/contracts";

export interface WorkTaskStatus {
  taskId: string; cognition: boolean; dispatchId: string | null;
  dispatchState: string | null; outcome: string | null; runId: string | null; runState: string | null;
  unsettledRunState: string | null;
  loopState: string | null; goalOutcome: string | null; stageDeliverable: string | null;
  sourceKind: string | null; sourceTaskId: string | null; sourceTaskTitle: string | null;
  decisionKind: string | null; decisionReason: string | null;
  useRequired: boolean | null; deliveryId: string | null; technicalResult: string | null;
  observationResult: string | null; observerKind: string | null;
  hasClosure: boolean; readyForAcceptance: boolean;
}

const sourceNames: Record<string, string> = {
  "loop.enrolled": "首次规划", "worker.outcome": "业务结果反馈",
  "observation.record": "消费者使用反馈", "dispatch.gap": "运行缺少署名结果后的恢复",
};
const outcomeNames: Record<string, string> = {
  waiting: "等待", failed: "处理失败", no_action: "无后续动作", delivered: "有正式交付",
};
const terminalRuns = new Set(["completed", "failed", "interrupted"]);
const internalCognitionTitle = /^Cognition:\s*(?:business result event|worker\.outcome|loop\.enrolled|observation\.record|dispatch\.gap)(?:\s|$)/i;

function readableCognitionSubject(value: string | null | undefined): string | null {
  const text = value?.trim();
  return text && !internalCognitionTitle.test(text) ? text : null;
}

export function cognitionSummary(status: WorkTaskStatus) {
  const source = sourceNames[status.sourceKind ?? ""] ?? "来源待核对";
  const sourceTaskTitle = readableCognitionSubject(status.sourceTaskTitle);
  const subject = sourceTaskTitle ? `${sourceTaskTitle}（源任务现名称）` :
    readableCognitionSubject(status.goalOutcome) ?? readableCognitionSubject(status.stageDeliverable) ?? "当前工作";
  const title = `${source} · ${subject}`;
  if (status.runState === "unknown" || status.dispatchState === "unknown")
    return {title,phase:"运行或派发结果未知",next:"先按原派发和运行记录核对，不推定已结束"};
  if (status.outcome === "delivered" && terminalRuns.has(status.runState ?? ""))
    return {title,phase:"本轮已有正式交付",next:"查看交付、实际使用与任务验收记录"};
  if (status.outcome && status.decisionKind && terminalRuns.has(status.runState ?? "")) {
    const stopped = status.decisionKind === "stop" && status.loopState === "stopped";
    return {title, phase:stopped ? "本轮已停止" : `本轮判断已结束 · ${outcomeNames[status.outcome] ?? "结果待核对"}`,
      next:"查看署名理由及后续接续记录"};
  }
  if (status.decisionKind) return {title,phase:terminalRuns.has(status.runState ?? "") ? "已署名判定 · 待收束" : "已署名判定 · 运行仍在收尾",
    next:"核对署名理由与实际运行状态"};
  if (terminalRuns.has(status.runState ?? "")) return {title,phase:"运行已结束 · 缺署名结果",next:"核对运行与提交记录，勿推定任务已完成"};
  if (["requested","dispatching","running"].includes(status.runState ?? "") ||
    ["claimed","dispatching","accepted"].includes(status.dispatchState ?? ""))
    return {title,phase:"本轮执行中",next:"等待实际运行与署名决定；运行结束不等于验收"};
  return {title,phase:"待派发或确认",next:"查看固定来源及派发状态"};
}

export function businessNextStep(task: Task, status: WorkTaskStatus): string | null {
  if (task.state === "done" || status.hasClosure) return "已登记验收；查看正式交付与使用证据";
  if (task.state === "cancelled") return null;
  if (status.unsettledRunState === "unknown" || status.runState === "unknown" || status.dispatchState === "unknown")
    return "运行或派发结果未知；先按原记录核对，不能依旧交付判断当前验收";
  if (["requested","dispatching","running"].includes(status.unsettledRunState ?? "") ||
    ["requested","dispatching","running"].includes(status.runState ?? ""))
    return "当前有运行在途；等待实际结果与正式交付，不能依旧交付判断当前验收";
  if (status.readyForAcceptance) return "当前交付已通过技术检查且声明消费者已记录使用；待负责人核对验收条件";
  if (status.deliveryId) return "查看最新交付、使用记录与验收条件；尚未确认验收";
  return null;
}

export function partitionWorkTasks(tasks: Task[], statuses: Record<string, WorkTaskStatus>) {
  return {
    business:tasks.filter(task => statuses[task.id] && !statuses[task.id]!.cognition),
    cognition:tasks.filter(task => statuses[task.id]?.cognition),
    unknown:tasks.filter(task => !statuses[task.id]),
  };
}

export function visibleWorkGroups(tasks: Task[], statuses: Record<string, WorkTaskStatus>, classificationUnavailable: boolean) {
  if (classificationUnavailable) return {
    primary: tasks, cognition: [] as Task[], unknown: [] as Task[], primaryKind: "unclassified" as const,
  };
  const { business, cognition, unknown } = partitionWorkTasks(tasks, statuses);
  return { primary: business, cognition, unknown, primaryKind: "business" as const };
}
