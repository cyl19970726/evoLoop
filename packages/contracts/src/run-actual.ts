import type { RunActual } from "./runtime.js";

/** What a Run detail says about the model and effort of its Turn, in words; the configured value is shown apart and never stands in. */
export interface RunActualView {
  /** The exact model ID the runtime reported, or "未记录". */
  model: string;
  /** The effort the runtime reported, or "未记录". */
  reasoningEffort: string;
  /** How the effort came about: asked for by the Run's configuration (true), left to the runtime's default (false), unknown (null). */
  effortRequested: boolean | null;
  /** Subagent models; empty when none were observed. */
  subagentModels: string[];
  /** The configured profile's values, labelled as configured (null when the Run has no profile or none was set). */
  configuredModel: string | null;
  configuredEffort: string | null;
  /** True when anything about the Turn was observed. */
  recorded: boolean;
}

export const NOT_RECORDED = "未记录";

export function describeRunActual(run: { actual?: RunActual | null; executionProfile?: { model?: string | null; reasoningEffort?: string | null } | null }): RunActualView {
  const actual = run.actual ?? null;
  return {
    model: actual?.model ?? NOT_RECORDED,
    reasoningEffort: actual?.reasoningEffort ?? NOT_RECORDED,
    effortRequested: actual?.effortRequested ?? null,
    subagentModels: actual?.subagentModels ?? [],
    configuredModel: run.executionProfile?.model ?? null,
    configuredEffort: run.executionProfile?.reasoningEffort ?? null,
    recorded: !!actual && (actual.model !== null || actual.reasoningEffort !== null || actual.subagentModels.length > 0),
  };
}
