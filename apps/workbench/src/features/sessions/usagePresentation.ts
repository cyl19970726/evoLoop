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

/** 上下文 on the agent's card: how far the current context is from the hand-off threshold. */
export interface ContextGauge {
  /** 0–1 for the bar; null when there is no threshold or no current size, so no bar is drawn. */
  ratio: number | null;
  tone: "progress" | "waiting" | "blocked" | "idle" | "unknown";
  /** Two to six characters for the tag. */
  status: string;
  /** “9.6 万 / 20 万（48%）”, or what is known without a threshold. */
  detail: string;
  handoff: boolean;
}

export function contextGauge(context: ContextPressure | null | undefined): ContextGauge {
  if (!context) return { ratio: null, tone: "unknown", status: "没有记录", detail: "这个智能体还没有上下文记录", handoff: false };
  if (!context.configured) return { ratio: null, tone: "idle", status: "未设阈值",
    detail: context.inputTokens === null ? "当前上下文未知 · 未设交接阈值" : `当前上下文 ${tokenText(context.inputTokens)} · 未设交接阈值`, handoff: false };
  if (context.state === "unknown" || context.inputTokens === null || context.limit === null || context.limit <= 0)
    return { ratio: null, tone: "unknown", status: "无法判断", detail: `交接阈值 ${tokenText(context.limit)} · 当前上下文未知`, handoff: false };
  const ratio = Math.max(0, Math.min(1, context.ratio ?? context.inputTokens / context.limit));
  const detail = `${tokenText(context.inputTokens)} / ${tokenText(context.limit)}（${Math.round((context.ratio ?? context.inputTokens / context.limit) * 100)}%）`;
  if (context.state === "handoff_required") return { ratio, tone: "blocked", status: "需交接新线程", detail, handoff: true };
  if (context.state === "warning") return { ratio, tone: "waiting", status: "接近交接", detail, handoff: false };
  return { ratio, tone: "progress", status: "正常", detail, handoff: false };
}

/** Today's use in four small figures; null when nothing was recorded today (never shown as 0). */
export function todayTiles(session: { recorded: boolean; today: UsageDay } | null | undefined): Array<{ label: string; value: string }> | null {
  if (!session?.recorded) return null;
  const day = session.today;
  return [
    { label: "输入", value: tokenText(day.inputTokens) },
    { label: "输出", value: tokenText(day.outputTokens) },
    { label: "缓存输入", value: tokenText(day.cachedInputTokens) },
    { label: "费用", value: costText(day) },
  ];
}

/** A project-wide budget belongs elsewhere; the agent's card says one line only when it is close to or at its limit. */
export function budgetReminder(budget: UsageBudget | null | undefined): { tone: "waiting" | "blocked"; text: string } | null {
  if (!budget?.configured) return null;
  const percent = budget.ratio === null ? "" : `（${Math.round(budget.ratio * 100)}%）`;
  if (budget.state === "exhausted") return { tone: "blocked", text: `项目今日用量已达每日上限${percent}，普通结果通知已暂停` };
  if (budget.state === "warning") return { tone: "waiting", text: `项目今日用量接近每日上限${percent}` };
  return null;
}
