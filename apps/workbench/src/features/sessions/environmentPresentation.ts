// 环境与用量 in the agent's right column: target model, reasoning effort and execution permission. They come from the
// execution profile in the recovery read, which only a project-run agent has. Three states stay apart
// (docs/frontend/principles.md 只说记录能证明的事): reading (正在读取), not applicable to an external agent
// (外部接入不提供), and a read that failed (无法判断, never “没有”).
import { permissionLabel, type RecoveryRead } from "./recoveryPresentation";

export const notProvidedByExternal = "外部接入不提供";
export type EnvironmentRow = [label: string, value: string];

export function environmentRows({ kind, recovery, configuredModel }: {
  kind: "owned" | "external";
  /** The recovery read; ignored for an external agent, whose recovery is never read. */
  recovery: RecoveryRead;
  /** The configured model the agent's snapshot records, if any (a project-run agent's launch, or a value an external host reported). */
  configuredModel: string | number | null;
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
    ["目标模型", revision?.model ?? recorded ?? pending ?? (profile ? "未配置" : "未登记执行配置")],
    ["思考强度", revision?.reasoningEffort ?? pending ?? (profile ? "未配置" : "未登记执行配置")],
    ["执行权限", revision ? permissionLabel(revision.sandbox, revision.approvalPolicy) : pending ?? "未登记执行配置"],
  ];
}
