/** Context admission for long-lived Sessions; independent of the daily spend ledger. */
export type ContextPressureState = "unconfigured" | "unknown" | "ok" | "warning" | "handoff_required";

export interface ContextBudgetConfig {
  enabled: boolean;
  /** Absolute context size at which ordinary result notices stop. */
  maxInputTokens: number;
  warningRatio: number;
  pauseOrdinaryTurns: boolean;
}

export interface ContextObservation {
  /** The newest native Turn's input+output tokens, when the runtime reported it. */
  inputTokens: number | null;
  modelContextWindow: number | null;
  observedAt: string | null;
}

export interface ContextPressure {
  configured: boolean;
  state: ContextPressureState;
  inputTokens: number | null;
  limit: number | null;
  ratio: number | null;
  warningRatio: number;
  pauseOrdinaryTurns: boolean;
  observedAt: string | null;
  reason: string | null;
}

export interface ContextHandoffSummaryInput {
  roleId: string;
  sessionId: string;
  nativeThreadId: string | null;
  pressure: ContextPressure;
  generatedAt: string;
  /** What the successor must read or decide first; never copied from private native content. */
  nextResponsibility: string;
}
