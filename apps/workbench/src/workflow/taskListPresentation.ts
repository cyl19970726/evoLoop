import type { LegacyTaskDecision, Task } from "@evoloop/contracts";

const legacyStates: Record<LegacyTaskDecision["state"], string> = {
  proposed: "待判断", ready: "可做", active: "进行中", review: "待验收", blocked: "受阻", deferred: "暂缓",
};
const legacyJudgements: Record<NonNullable<LegacyTaskDecision["decision"]>, string> = {
  approve: "通过", needsEvidence: "需补证据", defer: "暂缓", reject: "拒绝",
};

export function legacyDecisionLabel(value: LegacyTaskDecision): string {
  return `此前${legacyStates[value.state]}${value.decision ? ` · 旧判断：${legacyJudgements[value.decision]}` : " · 旧判断未记录"}`;
}

/** A list hint, never an authorization or a substitute for the Task history. */
export function taskNextStep(state: Task["state"], legacyDecision?: LegacyTaskDecision | null): string {
  if (legacyDecision) return "先核对旧判断与理由，再确认当前范围和固定依据";
  switch (state) {
    case "todo": return "核对任务范围与固定依据后决定是否开始";
    case "in_progress": return "核对当前交付、使用记录和验收条件";
    case "done": return "查看交付、使用和验收记录";
    case "cancelled": return "查看取消理由；如需继续，先核对再重新打开";
  }
}
