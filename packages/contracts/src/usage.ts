/** Provider-reported or native-observation usage, grouped for display and daily admission. */
import type { ContextPressure } from "./context-budget.js";

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  /** Provider-reported cost only; null means no provider reported a cost for this bucket. */
  costUsd: number | null;
  /** True only when every token-bearing record in this bucket also carried a provider cost. */
  costReported: boolean;
}

export interface UsageDay extends UsageTotals {
  /** Local calendar day in the project's configured usage time zone, `YYYY-MM-DD`. */
  day: string;
}

export interface SessionUsage {
  sessionId: string;
  roleId: string;
  nativeThreadId: string | null;
  /** False when the Session is known from a native observation but has no ledger row yet. */
  recorded: boolean;
  days: UsageDay[];
  today: UsageDay;
  total: UsageTotals;
  /** The last native observation's context size, when the provider reported it. */
  contextInputTokens: number | null;
  observedAt: string | null;
  /** Context admission state for this Session; independent of the daily spend budget. */
  context: ContextPressure;
}

export type UsageBudgetState = "unconfigured" | "ok" | "warning" | "exhausted" | "unknown";

export interface UsageBudget {
  configured: boolean;
  state: UsageBudgetState;
  /** The strongest configured limit, in the unit that produced `ratio`. */
  limitKind: "input_tokens" | "cost_usd" | null;
  limit: number | null;
  used: number | null;
  ratio: number | null;
  warningRatio: number;
  pauseOrdinaryTurns: boolean;
  /** A configured cost limit cannot be decided while some records lack provider cost. */
  costComplete: boolean;
  reason: string | null;
}

export interface UsageOverview {
  projectId: string;
  from: string;
  to: string;
  timeZone: string;
  observedAt: string;
  sessions: SessionUsage[];
  daily: UsageDay[];
  budget: UsageBudget;
}

/** Private configuration; absent or disabled means no daily admission change. */
export interface UsageBudgetConfig {
  enabled: boolean;
  maxInputTokens?: number | undefined;
  maxCostUsd?: number | undefined;
  warningRatio: number;
  pauseOrdinaryTurns: boolean;
  timeZone: string;
}

/** One stored Session-day bucket. */
export interface UsageBucketRow {
  sessionId: string;
  roleId: string;
  nativeThreadId: string | null;
  day: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  costUsd: number;
  costReported: boolean;
}

export interface UsageContextRow {
  sessionId: string;
  roleId: string;
  nativeThreadId: string | null;
  contextInputTokens: number | null;
  observedAt: string | null;
}

export interface UsageDelta {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  costUsd: number;
  costReported: boolean;
}

export interface UsageReader {
  listUsage(projectId: string, from: string, to: string, sessionId?: string): Promise<UsageBucketRow[]>;
  listUsageContext(projectId: string): Promise<UsageContextRow[]>;
}

export interface UsageTransaction extends UsageReader {
  addUsage(projectId: string, sessionId: string, day: string, delta: UsageDelta): Promise<void>;
}
