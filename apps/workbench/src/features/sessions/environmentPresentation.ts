// 运行环境 in the agent's right column (its 配置记录 rows and its main line): target model, reasoning effort and execution permission. They come from the
// execution profile in the recovery read, which only a project-run agent has. Three states stay apart
// (docs/frontend/principles.md 只说记录能证明的事): reading (正在读取), not applicable to an external agent
// (外部接入不提供), and a read that failed (无法判断, never “没有”).
import { permissionLabel, type RecoveryRead } from "./recoveryPresentation";

export const notProvidedByExternal = "外部接入不提供";
export type EnvironmentRow = [label: string, value: string];

export function environmentRows({ kind, recovery, configuredModel, modelLabelOf = (model: string) => model }: {
  kind: "owned" | "external";
  /** The recovery read; ignored for an external agent, whose recovery is never read. */
  recovery: RecoveryRead;
  /** The configured model the agent's snapshot records, if any (a project-run agent's launch, or a value an external host reported). */
  configuredModel: string | number | null;
  /** How a model ID is said (the catalog's display name in front of the exact ID); the ID itself by default. */
  modelLabelOf?: (model: string) => string;
}): EnvironmentRow[] {
  const recorded = configuredModel === null || configuredModel === "" ? null : String(configuredModel);
  if (kind === "external") return [
    ["运行方式", "外部接入"],
    ["目标模型", recorded ?? notProvidedByExternal],
    ["思考强度", notProvidedByExternal],
    ["执行权限", notProvidedByExternal],
  ];
  const pending = recovery.status === "loading" ? "正在读取" : recovery.status !== "ready" ? "无法判断（读取失败）" : null;
  const profile = recovery.status === "ready" ? recovery.view.executionProfile : null;
  const revision = profile?.revision ?? null;
  return [
    ["运行方式", "项目受管"],
    ["目标模型", revision?.model ? modelLabelOf(revision.model) : recorded ? modelLabelOf(recorded) : pending ?? (profile ? "未配置" : "未登记执行配置")],
    ["思考强度", revision?.reasoningEffort ?? pending ?? (profile ? "未配置" : "未登记执行配置")],
    ["执行权限", revision ? permissionLabel(revision.sandbox, revision.approvalPolicy) : pending ?? "未登记执行配置"],
  ];
}

/**
 * One value on the 运行环境 card's main line: what is shown and where it comes from — a Turn reported it (actual), it is the
 * configured target, or, while a newer target waits to be applied, the configuration last confirmed as in effect.
 */
export interface EnvironmentValue { text: string; source: "actual" | "target" | "confirmed" | null }
export interface RuntimeEnvironment {
  runtime: string;
  /** Null while the configuration is read, cannot be read or does not exist; `note` then says which. */
  model: EnvironmentValue | null;
  effort: EnvironmentValue | null;
  /** One short sentence for the main line when there is no model to show. */
  note: string | null;
  /** “权限：完整权限”, or null when it is not known. */
  permission: string | null;
  /** A target that is not (yet) what runs: pending, being applied, unknown or refused. Null when nothing is in between. */
  change: { tone: "waiting" | "progress" | "unknown" | "blocked"; label: string } | null;
}

const sandboxShort: Record<string, string> = { "read-only": "只读", "workspace-write": "可写工作目录", "danger-full-access": "完整权限" };

/**
 * 运行环境 (docs/frontend/pages/sessions.md 右栏): what the agent runs on, in one line. A model a Turn reported is shown as
 * actual; otherwise the configured target is shown and marked as such. Reasoning effort is never reported per Turn, so it is
 * always configured. While a newer target waits (pending, being applied, unknown, refused) the line keeps what is still in
 * effect — the last confirmed configuration — and the tag says what comes next. The values are the same reads as 配置记录.
 */
export function runtimeEnvironment({ kind, provider, recovery, configuredModel, actualModel, modelLabelOf = (model: string) => model }: {
  kind: "owned" | "external";
  provider: "codex" | "claude" | null | undefined;
  recovery: RecoveryRead;
  configuredModel: string | number | null;
  /** The model the latest Turn reported (snapshot resources.actualModel). */
  actualModel: string | number | null;
  modelLabelOf?: (model: string) => string;
}): RuntimeEnvironment {
  const actual = actualModel === null || actualModel === "" ? null : String(actualModel);
  const recorded = configuredModel === null || configuredModel === "" ? null : String(configuredModel);
  if (kind === "external") return {
    runtime: "外部接入",
    model: actual ? { text: modelLabelOf(actual), source: "actual" } : recorded ? { text: modelLabelOf(recorded), source: "target" } : null,
    // What the host does not report is said in 配置记录, which an external agent's card shows open (外部接入不提供).
    effort: null, note: null, permission: null, change: null,
  };
  const runtime = provider === "claude" ? "Claude" : provider === "codex" ? "Codex" : "运行时未记录";
  if (recovery.status === "loading") return { runtime, model: null, effort: null, note: "正在读取运行配置…", permission: null, change: null };
  const profile = recovery.status === "ready" ? recovery.view.executionProfile : null;
  const revision = profile?.revision ?? null;
  const waiting = !!profile?.activeRevisionId && profile.activationState !== "active";
  const confirmedModel = waiting ? profile!.activeModel ?? null : null, confirmedEffort = waiting ? profile!.activeReasoningEffort ?? null : null;
  const targetModel = revision?.model ?? recorded;
  const model: EnvironmentValue | null = actual ? { text: modelLabelOf(actual), source: "actual" }
    : confirmedModel ? { text: modelLabelOf(confirmedModel), source: "confirmed" }
      : targetModel ? { text: modelLabelOf(targetModel), source: "target" } : null;
  const effort: EnvironmentValue | null = confirmedEffort ? { text: confirmedEffort, source: "confirmed" }
    : revision?.reasoningEffort ? { text: revision.reasoningEffort, source: "target" } : null;
  const note = model ? null : recovery.status !== "ready" ? "运行配置暂不可读取" : profile ? "没有配置目标模型" : "未登记执行配置";
  const permission = revision ? `权限：${sandboxShort[revision.sandbox] ?? "待核对"}` : null;
  const target = revision ? `${revision.model ? modelLabelOf(revision.model) : "默认模型"} / ${revision.reasoningEffort ?? "默认强度"}` : "";
  const change: RuntimeEnvironment["change"] = !profile ? null
    : profile.activationState === "pending" ? { tone: "waiting", label: `下一轮改为 ${target}` }
      : profile.activationState === "attempting" ? { tone: "progress", label: `正在改为 ${target}` }
        : profile.activationState === "unknown" ? { tone: "unknown", label: "激活结果未知，需核对" }
          : profile.activationState === "rejected" ? { tone: "blocked", label: `改为 ${target} 被拒绝` }
            : profile.activeRevisionId && profile.activeRevisionId !== profile.revision.revisionId ? { tone: "waiting", label: "激活记录待核对" } : null;
  return { runtime, model, effort, note, permission, change };
}

/** Why “调整模型与强度” cannot be used, in one short line, with where to fix it when there is such a place. */
export interface AdjustBlocked { text: string; link: { label: string; place: "operations" | "runtime" } | null }

/** The first reason that applies, or null when the button can be used (or is only waiting for a read). */
export function adjustBlocked({ permitted, pendingOperation, runtimeReady, fullAccess, catalog, viewMismatch }: {
  permitted: boolean; pendingOperation: boolean; runtimeReady: boolean | null; fullAccess: boolean | null;
  catalog: "available" | "empty" | "unavailable" | null; viewMismatch: boolean;
}): AdjustBlocked | null {
  if (!permitted) return { text: "需要写入与复核权限", link: null };
  if (pendingOperation) return { text: "有结果未确认的操作", link: { label: "去核对", place: "operations" } };
  if (runtimeReady === false) return { text: "智能体还没有就绪", link: null };
  if (fullAccess === false) return { text: "不是完整权限", link: { label: "去分工与运行", place: "runtime" } };
  if (catalog === "empty" || catalog === "unavailable") return { text: catalog === "empty" ? "模型目录为空" : "模型目录读不到", link: null };
  if (viewMismatch) return { text: "两次读取的修订不一致，请重新读取", link: null };
  return null;
}
