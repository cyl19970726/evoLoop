import type { CommandResult } from "@evoloop/contracts";
import { errorText, isStaleConflict, isUnconfirmed } from "./api";

/** What the form shows and keeps after one submission: only an applied result discards the draft. */
export interface SubmissionOutcome { applied: boolean; message: string; failed: boolean; stale: boolean; unconfirmed: boolean }

export function resultOutcome(result: CommandResult): SubmissionOutcome {
  return result.status === "rejected"
    ? { applied: false, message: result.message, failed: true, stale: isStaleConflict(result.code), unconfirmed: false }
    : { applied: true, message: "已保存，正在读取持久记录。", failed: false, stale: false, unconfirmed: false };
}

export function errorOutcome(cause: unknown): SubmissionOutcome {
  const unconfirmed = isUnconfirmed(cause), changed = isStaleConflict(cause);
  return {
    applied: false, failed: true, unconfirmed, stale: !unconfirmed && changed,
    message: `${errorText(cause)}${unconfirmed ? "。请在上方按原操作 ID 核对，确认前不要再次提交。" : changed
      ? "。所见版本或固定指针已变化；先保存草稿，再回读当前状态。" : "。这次请求已被明确拒绝；草稿保留，可修改选择后以新操作提交。"}`,
  };
}
