export type BusinessRun = { id: string; taskId: string | null; state: string; updatedAt: string };
export const terminalRunStates = new Set(["completed", "failed", "interrupted"]);
export const businessRunStateText = (state: string) => ({
  completed: "已完成",
  failed: "失败",
  interrupted: "已中断",
  running: "进行中",
  dispatching: "启动中",
  requested: "待启动",
  unknown: "结果待核对",
} as Record<string, string>)[state] ?? "状态待核对";
export const businessRunReplyEligible = (sessionKind: string, run: Pick<BusinessRun, "taskId"> | null): boolean =>
  sessionKind === "owned" && !!run?.taskId;
export const runReplyScope = (sessionKey: string, runId: string): string => `${sessionKey}\0${runId}`;
export function acceptRunReplyForScope<T>(responseScope: string, activeScope: string, value: T): T | null {
  return responseScope === activeScope ? value : null;
}
