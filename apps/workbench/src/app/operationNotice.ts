// The notice after an unknown operation is checked (结果未知的操作, docs/frontend/pages/operations.md): what the check
// found, the original object by name and a link back to it, since the receipt and its card are gone once checked. The
// operation ID is never in the notice: it stays in the receipt's 完整标识. Pure, so the notice and its tests agree.
import type { CheckedOrigin } from "../features/settings/operationsPresentation";

export interface CheckedOutcome {
  /** The refusal in Chinese, or null when the operation was applied. */
  refusal: string | null;
  /** What the check could not compare (a dedicated endpoint without a command digest), or "". */
  scope: string;
}

/** “已核对：任务「名称」上的原操作已应用；正在回读当前数据。” or “…被拒绝：<原因>。”, without any identifier. */
export function checkedNoticeText(outcome: CheckedOutcome, origin: CheckedOrigin | null | undefined): string {
  const operation = origin?.name ? `${origin.name}上的原操作` : "原操作";
  const said = outcome.refusal ? `已核对：${operation}被拒绝：${outcome.refusal}。` : `已核对：${operation}已应用；正在回读当前数据。`;
  return `${said} ${outcome.scope}`.trim();
}
