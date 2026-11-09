const prefix = "evoloop-preflight-v1:";

type PreflightReport = {
  version: 1;
  code: string;
  category: string;
  actualBytes: number | null;
  limitBytes: number | null;
  source: { kind: string; id: string; revisionId: string | null } | null;
  modelStarted: false;
  nextAction: string;
};

export function preflightPresentation(summary: string): PreflightReport | null {
  if (!summary.startsWith(prefix)) return null;
  try {
    const value: unknown = JSON.parse(summary.slice(prefix.length));
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const report = value as Partial<PreflightReport>;
    if (report.version !== 1 || typeof report.code !== "string" || typeof report.category !== "string" ||
      report.modelStarted !== false || typeof report.nextAction !== "string") return null;
    return report as PreflightReport;
  } catch { return null; }
}

// What a reader sees for a refused dispatch. The service's `nextAction` is written for agents (it names Runs,
// Sessions, CLI entries); the page says the same per code in plain words. A shared mapping lands with #262
// (`shared/workPresentation.ts`); until then this local one is the only place.
const preflightText: Record<string, { title: string; next: string }> = {
  INPUT_LIMIT: { title: "首次输入超过大小上限", next: "这次运行的输入需要缩减或拆分；原运行和尝试记录会保留，由负责人按恢复流程重新安排。" },
  FIXED_SOURCE_INVALID: { title: "固定资料校验没通过", next: "核对所引用资料的固定版本是否完整；修正来源后重新固定任务依据。" },
  FIXED_SOURCE_UNAVAILABLE: { title: "读不到固定资料", next: "用这次运行的执行身份核对能否读到资料；恢复缺失的来源，或由负责人重新选定依据。" },
  AUTHORIZATION: { title: "没有读取授权", next: "核对执行身份和资料读取授权；不要换用其他身份代读。" },
  RECIPIENT_UNBOUND: { title: "验收接收者没有固定", next: "启动前先固定真实的执行接收者；这次失败会保留，不会推测成果的作者。" },
  TASK_CHANGED: { title: "任务已有新版本", next: "任务在派发后改了版本；由负责人按返工流程处理。" },
  CLI_ENTRY_UNAVAILABLE: { title: "业务命令行入口不可用", next: "为这个智能体配置可用的业务命令行入口，再按恢复流程处理。" },
  CLI_HANDOFF_UNAVAILABLE: { title: "业务命令行交接检查没通过", next: "升级业务命令行入口并核对身份后，按原运行的恢复流程处理；不要另起一轮。" },
  CLI_SUBMISSION_UNAVAILABLE: { title: "业务命令行提交检查没通过", next: "升级实际绑定的业务命令行入口，确认身份与写权限后，按原运行的恢复流程处理。" },
  PREFLIGHT_UNAVAILABLE: { title: "派发前检查没能完成", next: "读取原运行与回执，核对服务连接和固定资料；不要重发结果未知的操作。" },
};
const sourceKind: Record<string, string> = { task: "任务", document: "文档", external: "外部来源" };

export interface PreflightView { title: string; next: string; source: string | null; size: string | null; ids: Array<[string, string]> }

/** Title, next step, source kind and size in words; the code and the source's full IDs go to 完整标识. */
export function preflightView(report: PreflightReport): PreflightView {
  const known = preflightText[report.code];
  return {
    title: known?.title ?? "原因未识别",
    next: known?.next ?? "按运行回执核对原因；不要重发结果未知的操作。",
    source: report.source ? `来源是一份${sourceKind[report.source.kind] ?? "资料"}${report.source.revisionId ? "的固定修订" : ""}` : null,
    size: report.actualBytes !== null && report.limitBytes !== null ? `大小 ${report.actualBytes} / ${report.limitBytes} 字节` : null,
    ids: [["检查代码", report.code], ...report.source ? [["来源", report.source.id] as [string, string]] : [],
      ...report.source?.revisionId ? [["来源修订", report.source.revisionId] as [string, string]] : []],
  };
}
