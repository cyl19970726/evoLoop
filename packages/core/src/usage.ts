import type { Principal } from "@evoloop/contracts";
import type { RuntimeUsage } from "@evoloop/contracts/runtime";
import type {
  ContextBudgetConfig, SessionUsage, UsageBudget, UsageBudgetConfig, UsageBucketRow, UsageDay, UsageDelta, UsageOverview, UsageTotals,
} from "@evoloop/contracts";
import type { Clock, UnitOfWork } from "@evoloop/contracts/ports";
import { DomainError } from "@evoloop/contracts/ports";
import { contextPressure } from "./context-budget.js";

const dayPattern = /^\d{4}-\d{2}-\d{2}$/;

/** The local calendar day of an instant in an explicit IANA time zone. */
export function usageDay(at: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date(at));
  const value = (type: string) => parts.find(part => part.type === type)?.value ?? "";
  const day = `${value("year")}-${value("month")}-${value("day")}`;
  if (!dayPattern.test(day)) throw new DomainError("INVALID_USAGE_DAY", "Usage time zone did not produce a calendar day");
  return day;
}

const zero = (): UsageTotals => ({ inputTokens: 0, outputTokens: 0, cachedInputTokens: 0,
  costUsd: 0, costReported: true });
const add = (target: UsageTotals, row: Pick<UsageTotals, "inputTokens" | "outputTokens" |
  "cachedInputTokens" | "costUsd" | "costReported">) => {
  target.inputTokens += row.inputTokens;
  target.outputTokens += row.outputTokens;
  target.cachedInputTokens += row.cachedInputTokens;
  target.costUsd = (target.costUsd ?? 0) + (row.costUsd ?? 0);
  target.costReported = target.costReported && row.costReported;
};
const dayOf = (row: UsageBucketRow): UsageDay => ({ day: row.day, inputTokens: row.inputTokens,
  outputTokens: row.outputTokens, cachedInputTokens: row.cachedInputTokens,
  costUsd: row.costReported ? row.costUsd : null, costReported: row.costReported });

/**
 * Token fields for the daily ledger. Claude's SDK reports `input_tokens` without cache reads or
 * cache creation; both are input the provider processed, so the ledger adds them. Codex native
 * observations already report cached input inside `inputTokens` and do not use this adapter shape.
 */
export function inclusiveRuntimeUsage(usage: RuntimeUsage): Pick<UsageDelta, "inputTokens" | "outputTokens" | "cachedInputTokens"> {
  const cachedInputTokens = (usage.cacheReadInputTokens ?? 0) + (usage.cacheCreationInputTokens ?? 0);
  return {
    inputTokens: (usage.inputTokens ?? 0) + cachedInputTokens,
    outputTokens: usage.outputTokens ?? 0,
    cachedInputTokens,
  };
}

export function usageBudget(config: UsageBudgetConfig | null | undefined, today: UsageDay,
  now = new Date().toISOString()): UsageBudget {
  const maxTokens = config?.maxInputTokens;
  const maxCost = config?.maxCostUsd;
  if (!config?.enabled || !maxTokens && !maxCost) return { configured: false, state: "unconfigured",
    limitKind: null, limit: null, used: null, ratio: null, warningRatio: config?.warningRatio ?? 0.8,
    pauseOrdinaryTurns: config?.pauseOrdinaryTurns ?? true, costComplete: today.costReported,
    reason: "未配置每日用量上限；当前只记录用量与费用。" };
  const tokenRatio = maxTokens ? today.inputTokens / maxTokens : null;
  const costComplete = today.costReported;
  const costRatio = maxCost && costComplete ? (today.costUsd ?? 0) / maxCost : null;
  const candidates = [
    ...(tokenRatio === null ? [] : [{ kind: "input_tokens" as const, ratio: tokenRatio, limit: maxTokens!, used: today.inputTokens }]),
    ...(costRatio === null ? [] : [{ kind: "cost_usd" as const, ratio: costRatio, limit: maxCost!, used: today.costUsd ?? 0 }]),
  ].sort((left, right) => right.ratio - left.ratio);
  const strongest = candidates[0] ?? null;
  const warningRatio = config.warningRatio ?? 0.8;
  if (!strongest) return { configured: true, state: "unknown", limitKind: "cost_usd", limit: maxCost ?? null,
    used: null, ratio: null, warningRatio, pauseOrdinaryTurns: config.pauseOrdinaryTurns ?? true,
    costComplete, reason: "配置了每日费用上限，但当前 Session 没有完整报告费用；不能按美元判定。" };
  const state = strongest.ratio >= 1 ? "exhausted" : strongest.ratio >= warningRatio ? "warning" : "ok";
  return { configured: true, state, limitKind: strongest.kind, limit: strongest.limit,
    used: strongest.used, ratio: strongest.ratio, warningRatio,
    pauseOrdinaryTurns: config.pauseOrdinaryTurns ?? true, costComplete,
    reason: state === "exhausted" ? "今日用量已达到上限；普通结果通知和消息轮次暂停，业务 Task Run 不受影响。"
      : state === "warning" ? `今日用量已达到上限的 ${Math.round(strongest.ratio * 100)}%，请留意。`
        : maxCost && !costComplete ? "费用未完整报告；当前按输入 Token 上限判定。" : null };
}

export class UsageService {
  constructor(private readonly deps: { uow: UnitOfWork; clock: Clock }) {}

  async overview(principal: Principal, projectId: string, from: string, to: string,
    timeZone: string, config: UsageBudgetConfig | null,
    contextConfig?: ContextBudgetConfig | null): Promise<UsageOverview> {
    if (!principal.projectIds.includes(projectId) || !principal.permissions.includes("read"))
      throw new DomainError("FORBIDDEN", "Project read permission is required");
    if (!dayPattern.test(from) || !dayPattern.test(to) || from > to)
      throw new DomainError("INVALID_USAGE_RANGE", "Usage range must be an ordered pair of YYYY-MM-DD days");
    const today = usageDay(this.deps.clock.now(), timeZone);
    const { rows, contexts } = await this.deps.uow.read(projectId, async reader => ({
      rows: await reader.usage?.listUsage(projectId, from, to) ?? [],
      contexts: await reader.usage?.listUsageContext(projectId) ?? [],
    }));
    const bySession = new Map<string, { roleId: string; nativeThreadId: string | null; days: UsageDay[] }>();
    const daily = new Map<string, UsageTotals>();
    for (const row of rows) {
      const bucket = bySession.get(row.sessionId) ?? { roleId: row.roleId, nativeThreadId: row.nativeThreadId, days: [] };
      bucket.days.push(dayOf(row));
      bySession.set(row.sessionId, bucket);
      const total = daily.get(row.day) ?? zero();
      add(total, row);
      daily.set(row.day, total);
    }
    const contextOf = new Map(contexts.map(context => [context.sessionId, context]));
    // A Session with a live observation but no ledger row yet still needs its context pressure shown.
    for (const context of contexts)
      if (!bySession.has(context.sessionId))
        bySession.set(context.sessionId, { roleId: context.roleId, nativeThreadId: context.nativeThreadId, days: [] });
    const sessions: SessionUsage[] = [...bySession.entries()].map(([sessionId, bucket]) => {
      const total = zero();
      for (const day of bucket.days) add(total, day);
      const todayUsage = bucket.days.find(day => day.day === today) ?? { day: today, ...zero() };
      const context = contextOf.get(sessionId);
      return { sessionId, roleId: bucket.roleId, nativeThreadId: bucket.nativeThreadId,
        recorded: bucket.days.length > 0,
        days: bucket.days.sort((left, right) => left.day.localeCompare(right.day)),
        today: todayUsage, total, contextInputTokens: context?.contextInputTokens ?? null,
        observedAt: context?.observedAt ?? null,
        context: contextPressure(contextConfig, context ? {
          inputTokens: context.contextInputTokens,
          modelContextWindow: null,
          observedAt: context.observedAt,
        } : null) };
    }).sort((left, right) => right.today.inputTokens - left.today.inputTokens || left.sessionId.localeCompare(right.sessionId));
    const days: UsageDay[] = [...daily.entries()].sort(([left], [right]) => left.localeCompare(right))
      .map(([day, value]) => ({ day, ...value }));
    const todayUsage = days.find(day => day.day === today) ?? { day: today, ...zero() };
    return { projectId, from, to, timeZone, observedAt: this.deps.clock.now(), sessions, daily: days,
      budget: usageBudget(config, todayUsage) };
  }

  async record(projectId: string, sessionId: string, day: string,
    delta: { inputTokens: number; outputTokens: number; cachedInputTokens: number; costUsd?: number | null }): Promise<void> {
    const inputTokens = Math.max(0, Math.trunc(delta.inputTokens));
    const outputTokens = Math.max(0, Math.trunc(delta.outputTokens));
    const cachedInputTokens = Math.max(0, Math.trunc(delta.cachedInputTokens));
    const cost = delta.costUsd ?? null;
    if (!inputTokens && !outputTokens && !cachedInputTokens && cost === null) return;
    await this.deps.uow.transaction(projectId, async tx => {
      if (!tx.usage) throw new DomainError("USAGE_UNAVAILABLE", "Usage persistence is unavailable");
      await tx.usage.addUsage(projectId, sessionId, day, { inputTokens, outputTokens, cachedInputTokens,
        costUsd: cost !== null && cost > 0 ? cost : 0, costReported: cost !== null });
    });
  }
}
