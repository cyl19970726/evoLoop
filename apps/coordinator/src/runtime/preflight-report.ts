import { DomainError } from "@evoloop/contracts/ports";

const prefix = "evoloop-preflight-v1:";
export type PreflightCode = "INPUT_LIMIT" | "FIXED_SOURCE_INVALID" | "FIXED_SOURCE_UNAVAILABLE" |
  "AUTHORIZATION" | "TASK_CHANGED" | "PREFLIGHT_UNAVAILABLE";
export interface PreflightReport {
  version: 1; code: PreflightCode; category: "size" | "integrity" | "unavailable" | "authorization" | "changed";
  actualBytes: number | null; limitBytes: number | null;
  source: { kind: "task" | "document" | "external"; id: string; revisionId: string | null } | null;
  modelStarted: false; nextAction: string;
}
export class PreflightError extends Error {
  constructor(readonly code: PreflightCode,
    readonly source: PreflightReport["source"] = null,
    readonly actualBytes: number | null = null, readonly limitBytes: number | null = null) {
    super(code); this.name = "PreflightError";
  }
}
const nextAction: Record<PreflightCode, string> = {
  INPUT_LIMIT: "核对首包组成；保留原 Run 和尝试记录，修正输入协议后按正式恢复流程创建新尝试。",
  FIXED_SOURCE_INVALID: "按固定修订核对资料元数据与哈希；修正来源后重新封存任务依据。",
  FIXED_SOURCE_UNAVAILABLE: "用本 Run 的执行身份读取固定资料；恢复缺失来源或由负责人正式重选依据。",
  AUTHORIZATION: "核对当前执行身份和固定资料读取授权；不要借其他身份代读。",
  TASK_CHANGED: "核对当前 Task 修订与本 Run 的固定修订；由负责人按正常返工流程处理。",
  PREFLIGHT_UNAVAILABLE: "读取原 Run 与运行事件，核对服务连接和固定资料；不要重发未知操作。",
};

/** Only approved facts enter the durable Run summary/event; never persist raw exceptions or prompt bytes. */
export function safePreflightReport(error: unknown): { report: PreflightReport; summary: string } {
  const source = error instanceof PreflightError ? error.source : null;
  const code: PreflightCode = error instanceof PreflightError ? error.code :
    error instanceof DomainError && error.code === "FORBIDDEN" ? "AUTHORIZATION" :
    error instanceof DomainError && ["TASK_CHANGED", "BASIS_CHANGED", "PENDING_BASIS_REVIEW"].includes(error.code) ? "TASK_CHANGED" :
    error instanceof DomainError && ["BASIS_UNAVAILABLE", "NOT_FOUND", "ORIGINAL_UNAVAILABLE"].includes(error.code) ? "FIXED_SOURCE_UNAVAILABLE" :
    "PREFLIGHT_UNAVAILABLE";
  const category: PreflightReport["category"] = code === "INPUT_LIMIT" ? "size" :
    code === "FIXED_SOURCE_INVALID" ? "integrity" : code === "FIXED_SOURCE_UNAVAILABLE" ? "unavailable" :
    code === "AUTHORIZATION" ? "authorization" : code === "TASK_CHANGED" ? "changed" : "unavailable";
  const safeBytes = (value: number | null) => value !== null && Number.isSafeInteger(value) && value >= 0 ? value : null;
  const report: PreflightReport = { version: 1, code, category,
    actualBytes: error instanceof PreflightError ? safeBytes(error.actualBytes) : null,
    limitBytes: error instanceof PreflightError ? safeBytes(error.limitBytes) : null,
    source, modelStarted: false, nextAction: nextAction[code] };
  return { report, summary: `${prefix}${JSON.stringify(report)}` };
}
