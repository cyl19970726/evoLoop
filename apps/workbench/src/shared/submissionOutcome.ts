import type { CommandResult } from "@evoloop/contracts";
import { isStaleConflict, isUnconfirmed } from "./api";
import { describeError, describeFailure } from "./errorPresentation";

/**
 * What the form shows and keeps after one submission: only an applied result discards the draft. `message` is in
 * Chinese (shared/errorPresentation.ts); `detail` is the service's original answer when the message replaced it, for
 * an expandable 诊断信息.
 */
export interface SubmissionOutcome { applied: boolean; message: string; detail?: string | null; failed: boolean; stale: boolean; unconfirmed: boolean }

export function resultOutcome(result: CommandResult): SubmissionOutcome {
  if (result.status !== "rejected")
    return { applied: true, message: "已保存，正在读取持久记录。", detail: null, failed: false, stale: false, unconfirmed: false };
  const refusal = describeFailure(result.message, result.code, 409);
  return { applied: false, message: refusal.text, detail: refusal.detail, failed: true, stale: isStaleConflict(result.code), unconfirmed: false };
}

export function errorOutcome(cause: unknown): SubmissionOutcome {
  const unconfirmed = isUnconfirmed(cause), changed = isStaleConflict(cause);
  const failure = describeError(cause);
  return {
    applied: false, failed: true, unconfirmed, stale: !unconfirmed && changed, detail: failure.detail,
    message: `${failure.text}${unconfirmed ? "。请在上方按原操作 ID 核对，确认前不要再次提交。" : changed
      ? "。先保存草稿，再回读当前状态。" : "。这次请求已被明确拒绝；草稿保留，可修改选择后以新操作提交。"}`,
  };
}
