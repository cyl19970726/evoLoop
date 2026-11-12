import type { RuntimeTurnFailure, RuntimeUsage } from "@evoloop/contracts/runtime";

/** The subset of an SDK result message the adapter reads. Other fields are ignored, never stored. */
export interface ObservedResult {
  subtype: string;
  is_error?: unknown;
  result?: unknown;
  total_cost_usd?: unknown;
  usage?: unknown;
  terminal_reason?: unknown;
  api_error_status?: unknown;
  session_id?: unknown;
  modelUsage?: unknown;
}

export interface TurnObservation {
  /** Error class the SDK stamped on a main-thread assistant message, if any. */
  assistantError: string | null;
  interruptRequested: boolean;
}

export type Classified =
  | { status: "completed" }
  | { status: "interrupted" }
  | { status: "failed"; error: RuntimeTurnFailure };

const SUMMARY: Record<RuntimeTurnFailure["category"], string> = {
  unsupported_model: "Claude rejected the configured model",
  rate_limited: "Claude rate limit reached",
  provider_rejected: "Claude rejected the request",
  provider_unavailable: "Claude service unavailable",
  context_window_exceeded: "Claude context window exceeded",
  budget_exceeded: "Claude Turn stopped at the configured turn or cost limit",
  authentication_failed: "Claude authentication failed",
  quota_exhausted: "Claude account quota or balance exhausted",
  connection_lost: "Connection to Claude was lost",
  native_failure: "Claude Turn failed",
};

const code = (value: unknown): string | null =>
  typeof value === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(value) ? value : null;

export const failure = (category: RuntimeTurnFailure["category"], providerCode: unknown, httpStatus: unknown = null,
  summary = SUMMARY[category]): RuntimeTurnFailure => ({
  category, providerCode: code(providerCode),
  httpStatus: typeof httpStatus === "number" && Number.isInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599 ? httpStatus : null,
  summary,
});

/** Assistant-message error classes from the pinned SDK; unknown values fall back to native_failure. */
function assistantCategory(error: string): RuntimeTurnFailure["category"] {
  switch (error) {
    case "authentication_failed": case "oauth_org_not_allowed": case "account_on_hold":
    case "verification_required": case "cloud_credential_error": return "authentication_failed";
    case "rate_limit": return "rate_limited";
    case "overloaded": case "server_error": return "provider_unavailable";
    case "model_not_found": return "unsupported_model";
    case "billing_error": return "quota_exhausted";
    case "invalid_request": return "provider_rejected";
    default: return "native_failure";
  }
}

/**
 * Classify one Turn from its SDK result. Summaries are fixed text: the result's `errors[]` and `result`
 * strings can carry private paths or session material and are never copied into failure metadata.
 */
export function classifyResult(result: ObservedResult, observed: TurnObservation): Classified {
  const terminal = typeof result.terminal_reason === "string" ? result.terminal_reason : null;
  if (result.subtype === "success" && result.is_error !== true) return { status: "completed" };
  if (observed.interruptRequested && (result.subtype === "error_during_execution" || terminal?.startsWith("aborted_")))
    return { status: "interrupted" };
  if (result.subtype === "error_max_budget_usd" || result.subtype === "error_max_turns")
    return { status: "failed", error: failure("budget_exceeded", result.subtype) };
  if (terminal === "prompt_too_long") return { status: "failed", error: failure("context_window_exceeded", terminal, result.api_error_status) };
  if (terminal === "budget_exhausted" || terminal === "max_turns") return { status: "failed", error: failure("budget_exceeded", terminal) };
  if (observed.assistantError)
    return { status: "failed", error: failure(assistantCategory(observed.assistantError), observed.assistantError, result.api_error_status) };
  return { status: "failed", error: failure("native_failure", terminal ?? result.subtype, result.api_error_status) };
}

const count = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;

/** Main-loop usage the SDK reports per Turn. A missing or malformed count stays null, never zero. */
export function usageOf(value: unknown): RuntimeUsage | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const usage = value as Record<string, unknown>;
  const result: RuntimeUsage = {
    inputTokens: count(usage.input_tokens), outputTokens: count(usage.output_tokens),
    cacheReadInputTokens: count(usage.cache_read_input_tokens),
    cacheCreationInputTokens: count(usage.cache_creation_input_tokens),
  };
  return Object.values(result).every(entry => entry === null) ? null : result;
}

/** A finite, non-negative USD amount, else null. */
export const usd = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;

/**
 * Per-Turn cost from the SDK's cumulative session total. A resumed session continues from the total its
 * transcript saved, so the Turn's own cost is the difference from the previous recorded total. When either
 * total is unknown, or the total went backwards (the transcript kept no total), the Turn cost is unproven.
 */
export function turnCost(cumulative: number | null, previous: number | null): number | null {
  if (cumulative === null || previous === null || cumulative < previous) return null;
  return Math.round((cumulative - previous) * 1e10) / 1e10;
}

/**
 * Cumulative session thinking tokens from the SDK's per-model usage. Every model entry must report the field;
 * an older CLI that omits it leaves the total unknown rather than zero.
 */
export function thinkingTokensOf(modelUsage: unknown): number | null {
  if (!modelUsage || typeof modelUsage !== "object" || Array.isArray(modelUsage)) return null;
  const entries = Object.values(modelUsage as Record<string, unknown>);
  if (!entries.length) return null;
  let total = 0;
  for (const entry of entries) {
    const value = entry && typeof entry === "object" ? count((entry as Record<string, unknown>).thinkingTokens) : null;
    if (value === null) return null;
    total += value;
  }
  return total;
}

/** A Turn's own thinking tokens from cumulative totals, as for cost; unproven when either is unknown or it went back. */
export function turnThinking(cumulative: number | null, previous: number | null): number | null {
  return cumulative === null || previous === null || cumulative < previous ? null : cumulative - previous;
}
