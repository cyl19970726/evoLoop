import type { ContextPressure, UsageBudget } from "@evoloop/contracts";

export interface OrdinaryTurnAdmission {
  allowed: boolean;
  /** Persisted on the blocked message; null when the notice may start. */
  reason: string | null;
  /** A maintainer should see this before the ceiling is reached. */
  warning: boolean;
}

/**
 * Ordinary result notices are the non-essential turns: a business Task Run and a person's own message
 * are never stopped by the daily spend or context guards. Exhausted guards leave the notice blocked
 * with a recoverable reason instead of silently dropping responsibility.
 */
export function ordinaryTurnAdmission(input: {
  isNotice: boolean;
  budget: UsageBudget;
  context: ContextPressure;
}): OrdinaryTurnAdmission {
  if (!input.isNotice) return { allowed: true, reason: null, warning: false };
  if (input.budget.state === "exhausted" && input.budget.pauseOrdinaryTurns)
    return { allowed: false, warning: true,
      reason: "DAILY_BUDGET_EXHAUSTED：今日普通结果通知已暂停；业务 Task Run 不受影响，明日或维护者调整上限后继续。" };
  if (input.context.state === "handoff_required" && input.context.pauseOrdinaryTurns)
    return { allowed: false, warning: true,
      reason: `CONTEXT_HANDOFF_REQUIRED：本 Session 上下文 ${input.context.inputTokens ?? "未报告"} 个词元已达到 ${input.context.limit ?? "?"}；请交接到新线程并保留交接摘要，业务 Task Run 不受影响。` };
  return { allowed: true, reason: null,
    warning: ["warning", "exhausted"].includes(input.budget.state) ||
      ["warning", "handoff_required"].includes(input.context.state) };
}
