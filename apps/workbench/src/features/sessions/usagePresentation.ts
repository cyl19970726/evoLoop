// Usage reads stay explicit about what the provider reported: a missing cost is "未报告", never $0,
// and an unavailable token count is "未知", never 0. The same wording serves the Session panel and tests.
import type { ContextPressure, UsageBudget, UsageDay } from "@evoloop/contracts";

export function tokenText(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "未知";
  if (value < 10_000) return String(Math.trunc(value));
  const wan = value / 10_000;
  return `${Number(wan.toFixed(1))} 万`;
}

export function costText(value: Pick<UsageDay, "costUsd" | "costReported"> | null | undefined): string {
  if (!value || !value.costReported || value.costUsd === null || value.costUsd === undefined) return "未报告";
  return `$${value.costUsd.toFixed(4)}`;
}

export function usageDayText(day: Pick<UsageDay, "inputTokens" | "outputTokens" | "cachedInputTokens" | "costUsd" | "costReported">): string {
  return `输入 ${tokenText(day.inputTokens)} · 输出 ${tokenText(day.outputTokens)} · 缓存输入 ${tokenText(day.cachedInputTokens)} · 费用 ${costText(day)}`;
}

export function budgetText(budget: UsageBudget): string {
  if (!budget.configured) return "未配置每日上限（仅记录用量）";
  const cost = budget.limitKind === "cost_usd";
  const amount = (value: number | null) => value === null ? "未知" : cost ? `$${value.toFixed(2)}` : tokenText(value);
  const used = amount(budget.used);
  const limit = budget.limit === null ? "?" : amount(budget.limit);
  const percent = budget.ratio === null ? "?" : `${Math.round(budget.ratio * 100)}%`;
  const state = budget.state === "exhausted" ? "已达上限，普通结果通知已暂停"
    : budget.state === "warning" ? "接近上限" : budget.state === "unknown" ? "无法判定" : "正常";
  return `${state} · ${budget.limitKind === "cost_usd" ? "费用" : "输入词元"} ${used} / ${limit}（${percent}）`;
}

export function contextText(context: ContextPressure): string {
  if (!context.configured) return `未配置交接阈值 · 当前上下文 ${tokenText(context.inputTokens)}`;
  if (context.state === "unknown") return `交接阈值 ${tokenText(context.limit)} · 当前用量未知`;
  const percent = context.ratio === null ? "?" : `${Math.round(context.ratio * 100)}%`;
  const state = context.state === "handoff_required" ? "需交接新线程"
    : context.state === "warning" ? "接近交接阈值" : "正常";
  return `${state} · 上下文 ${tokenText(context.inputTokens)} / ${tokenText(context.limit)}（${percent}）`;
}
