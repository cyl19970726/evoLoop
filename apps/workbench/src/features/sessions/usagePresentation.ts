// Usage reads stay explicit about what the provider reported: a missing cost is "未报告", never $0,
// and an unavailable token count is "未知", never 0. The same wording serves the Session panel and tests.
import type { ContextPressure, UsageBudget, UsageDay } from "@evoloop/contracts";

export function tokenText(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "未知";
  if (value < 10_000) return String(Math.trunc(value));
  // From 一亿 up the 万 figure has seven or more digits and the unit is lost on a narrow card; 亿 keeps the figure short and the unit in view.
  if (value >= 100_000_000) return `${Number((value / 100_000_000).toFixed(1))} 亿`;
  const wan = value / 10_000;
  return `${Number(wan.toFixed(1))} 万`;
}

/** The exact count for a reader who needs it (a tooltip, a screen reader): digits grouped by thousands, never rounded. */
export function tokenFullText(value: number | null | undefined): string | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  return `${Math.trunc(value).toLocaleString("en-US")} 个令牌`;
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
  /** “正常” is `done` (a check), never `progress`, whose spinning icon would say something is running. */
  tone: "done" | "waiting" | "blocked" | "idle" | "unknown";
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
  return { ratio, tone: "done", status: "正常", detail, handoff: false };
}

/**
 * Today's use in four small figures; null when nothing was recorded today (never shown as 0). The service fills
 * `today` with zeros when there is no ledger row for it, so “recorded today” is whether `days` holds today's day.
 * `full` is the exact figure when `value` is a rounded one (otherwise null); it is offered as a tooltip and to screen readers.
 */
export function todayTiles(session: { recorded: boolean; today: UsageDay; days?: readonly UsageDay[] } | null | undefined): Array<{ label: string; value: string; full: string | null }> | null {
  if (!session?.recorded) return null;
  if (session.days && !session.days.some(day => day.day === session.today.day)) return null;
  const day = session.today;
  const tokens = (label: string, count: number | null | undefined) => {
    const value = tokenText(count), full = tokenFullText(count);
    return { label, value, full: full !== null && String(Math.trunc(count as number)) !== value ? full : null };
  };
  return [
    tokens("输入", day.inputTokens),
    tokens("输出", day.outputTokens),
    tokens("缓存输入", day.cachedInputTokens),
    { label: "费用", value: costText(day), full: null },
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

/** 项目用量 on 统筹安排: today's project use against the daily limit, drawn as the same bar as an agent's context. */
export function projectBudgetGauge(budget: UsageBudget, todayRecorded: boolean | null = null): ContextGauge & { exact: string | null } {
  const gauge = projectGauge(budget, todayRecorded);
  return { ...gauge, exact: projectExactText(budget, gauge) };
}

/**
 * The exact used amount and limit behind a limit line that shows them rounded (33 亿 / 40 亿): for a screen reader and a tooltip.
 * Only where a used amount against a limit is shown; a token count is written in full, a cost limit is already exact to the cent.
 */
function projectExactText(budget: UsageBudget, gauge: ContextGauge): string | null {
  if (!budget.configured || gauge.ratio === null || budget.used === null || budget.limit === null) return null;
  if (budget.limitKind === "cost_usd") return `已用 $${budget.used.toFixed(2)} / 上限 $${budget.limit.toFixed(2)}`;
  const used = tokenFullText(budget.used), limit = tokenFullText(budget.limit);
  return used !== null && limit !== null ? `已用 ${used.replace(" 个令牌", "")} / 上限 ${limit}` : null;
}

function projectGauge(budget: UsageBudget, todayRecorded: boolean | null = null): ContextGauge {
  if (!budget.configured) return { ratio: null, tone: "idle", status: "未设上限", detail: "未配置每日上限，只记录用量", handoff: false };
  // The service counts a day without ledger rows as 0 used; that is not a recorded 0, so no bar and no 0% is drawn.
  if (todayRecorded === false) {
    const limit = budget.limitKind === "cost_usd" ? `$${(budget.limit ?? 0).toFixed(2)}` : tokenText(budget.limit);
    return { ratio: null, tone: "idle", status: "今日没有记录", detail: `今日没有记录，不按 0 计 · 每日上限 ${limit}`, handoff: false };
  }
  if (budget.state === "unknown" || budget.ratio === null || budget.limit === null)
    return { ratio: null, tone: "unknown", status: "无法判定",
      detail: budget.costComplete ? "今日用量暂时无法判定" : "有的记录没有报告费用，费用上限暂时无法判定", handoff: false };
  const cost = budget.limitKind === "cost_usd";
  const amount = (value: number | null) => value === null ? "未知" : cost ? `$${value.toFixed(2)}` : tokenText(value);
  const detail = `${cost ? "费用" : "输入"} ${amount(budget.used)} / ${amount(budget.limit)}（${Math.round(budget.ratio * 100)}%）`;
  const ratio = Math.max(0, Math.min(1, budget.ratio));
  if (budget.state === "exhausted") return { ratio, tone: "blocked", status: "已达上限",
    detail: budget.pauseOrdinaryTurns ? `${detail} · 普通结果通知已暂停` : detail, handoff: false };
  if (budget.state === "warning") return { ratio, tone: "waiting", status: "接近上限", detail, handoff: false };
  return { ratio, tone: "done", status: "正常", detail, handoff: false };
}

export type ProjectDayRow =
  | { day: string; recorded: true; input: string; output: string; cached: string; cost: string; inputFull: string | null; outputFull: string | null; cachedFull: string | null }
  | { day: string; recorded: false };

/** The project's “today” (`YYYY-MM-DD`) in its usage time zone at the time of the read; null when the zone is unusable. */
export function projectToday(observedAt: string, timeZone: string): string | null {
  const at = new Date(observedAt);
  if (!Number.isFinite(at.getTime())) return null;
  try { return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(at); }
  catch { return null; }
}

/**
 * The project's last `count` calendar days ending today, newest first, one row each in 万; a missing cost is 未报告.
 * The service lists only days that have ledger rows, so a day it does not list had no record: it says so and is never
 * shown as 0 (a day recorded as 0 still shows 0). Without a usable today, only the recorded days are listed.
 */
export function recentProjectDays(daily: readonly UsageDay[], today: string | null, count = 7): ProjectDayRow[] {
  // A rounded figure also carries its exact count (a tooltip), as an agent's 今日 figures do.
  const exact = (count: number | null | undefined) => { const full = tokenFullText(count); return full !== null && String(Math.trunc(count as number)) !== tokenText(count) ? full : null; };
  const row = (day: UsageDay): ProjectDayRow => ({ day: day.day, recorded: true, input: tokenText(day.inputTokens),
    output: tokenText(day.outputTokens), cached: tokenText(day.cachedInputTokens), cost: costText(day),
    inputFull: exact(day.inputTokens), outputFull: exact(day.outputTokens), cachedFull: exact(day.cachedInputTokens) });
  if (!today || !/^\d{4}-\d{2}-\d{2}$/.test(today)) return [...daily].sort((a, b) => b.day.localeCompare(a.day)).slice(0, count).map(row);
  const byDay = new Map(daily.map(day => [day.day, day]));
  const end = Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)) - 1, Number(today.slice(8, 10)));
  return Array.from({ length: count }, (_, back) => {
    const day = new Date(end - back * 86_400_000).toISOString().slice(0, 10);
    const found = byDay.get(day);
    return found ? row(found) : { day, recorded: false };
  });
}
