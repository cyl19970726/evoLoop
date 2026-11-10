// One saved operation receipt: check it by its operation ID, or retry with the same ID and content when the
// original command is still in this page. Never creates a new operation. The operation ID itself is only in 完整标识
// (docs/frontend/principles.md 原始标识放在来源层): here, or on 结果未知的操作 in the receipt's own identifier block.
import { useState } from "react";
import { Button } from "@evoloop/ui";
import type { Operation } from "@evoloop/contracts";
import { api, errorText } from "../../shared/api";
import { FullIdentifiers } from "../../shared/ui/FullIdentifiers";
import { date } from "../../shared/ui/shared";
import type { OperationReceipt } from "../recovery";
import { operationNotFound, recoveryIntent, replayRecoveryIntent, verifyRecoveryOperation } from "../recoveryIntent";

export function OperationCheck({ receipt, token, onConfirmed, identifiers = true }: {
  receipt: OperationReceipt; token: string;
  onConfirmed: (result: Operation["result"]) => void;
  /** Show the operation ID under 完整标识 here; false where the page lists it with the receipt's other identifiers. */
  identifiers?: boolean;
}) {
  const [status, setStatus] = useState("这次操作可能已提交。请按原操作 ID 核对，确认前不要重复提交。");
  const [busy, setBusy] = useState(false);
  const [canReplay, setCanReplay] = useState(false);
  async function check() {
    setBusy(true); setCanReplay(false);
    try {
      const operation: Operation = await api(token).operation(receipt.projectId, receipt.operationId);
      const verdict = await verifyRecoveryOperation(receipt, operation);
      if (verdict !== "match" && verdict !== "scoped-match") {
        setStatus(verdict === "unavailable"
          ? "已查到同 ID 记录，但当前页面没有完整原命令，无法核对正文摘要。回执保留，需用原始意图与操作记录人工核对。"
          : "操作记录与原命令摘要不匹配；回执保留，不能据此确认或重发。");
        return;
      }
      onConfirmed(operation.result);
    } catch (cause) {
      if (operationNotFound(cause)) {
        const saved = await recoveryIntent(receipt);
        setCanReplay(!!saved);
        setStatus(saved
          ? "尚未查到操作记录。这不能证明原请求未提交；如服务已恢复，可明确选择按原 ID 和原内容重试。"
          : "尚未查到操作记录，且当前页面没有完整原命令。只能继续按原 ID 核对；如需恢复，请用原身份和原意图在 CLI 精确处理，随后回到此处核对。旧回执或刷新后的正文无法从页面重建。");
      } else setStatus(`暂未核清：${errorText(cause)}`);
    } finally { setBusy(false); }
  }
  async function replay() {
    if (!canReplay || busy) return;
    setBusy(true); setCanReplay(false);
    try {
      const client = api(token);
      const result = await replayRecoveryIntent(receipt,
        () => client.operation(receipt.projectId, receipt.operationId), command => client.command(command));
      onConfirmed(result);
    } catch (cause) {
      setStatus(`同 ID 重试结果仍未确认：${errorText(cause)}。回执保留，请继续核对，勿创建新操作。`);
    } finally { setBusy(false); }
  }
  return <section data-ui="" className="operation-check flex flex-col gap-2 rounded-xl bg-danger-soft px-4 py-3" role="alert" aria-label="提交结果待核对">
    <h2 className="text-label font-semibold text-foreground">提交结果待核对</h2>
    <p className="text-small text-foreground">{status}</p>
    <p className="text-caption text-text-secondary">提交于 {date(receipt.createdAt)}</p>
    {identifiers && <FullIdentifiers summary="完整标识" rows={[{ label: "原操作", value: receipt.operationId }]} />}
    <div className="flex flex-wrap gap-2">
      <Button size="compact" onClick={() => void check()} disabled={busy}>{busy ? "处理中…" : "按操作 ID 核对"}</Button>
      {canReplay && <Button size="compact" variant="ghost" onClick={() => void replay()} disabled={busy}>按原 ID 和原内容重试</Button>}
    </div>
  </section>;
}
