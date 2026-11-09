// One command from a form built on @evoloop/ui, with the same safety as ActionForm: the operation ID is saved as a
// recovery receipt before anything is sent, an unconfirmed result keeps the receipt, and only an applied result
// rereads. The form records what the person saw when it opened (its baseline); if that changes before submitting,
// or the service answers that the version moved, the form refuses until the person has looked at the latest content.
import { useState } from "react";
import { commandSchema, type Command } from "@evoloop/contracts";
import { api, isUnconfirmed } from "../../shared/api";
import type { MutationContext } from "../../shared/ActionForm";
import { errorOutcome, resultOutcome, type SubmissionOutcome } from "../../shared/submissionOutcome";

const refused = (message: string): SubmissionOutcome => ({ applied: false, failed: true, stale: false, unconfirmed: false, message });
export const baselineChangedText = "打开表单后，这里的内容已被更新。请先查看最新内容，再按最新内容重新提交。";

/** Why a submission must not be sent now, or null. A changed baseline or a stale answer always refuses. */
export function submissionRefusal(state: { busy: boolean; blocked: boolean; stale: boolean; recorded?: string | undefined; current?: string | undefined }):
  "busy" | "blocked" | "baseline" | null {
  if (state.busy) return "busy";
  if (state.blocked) return "blocked";
  if (state.stale || state.recorded !== undefined && state.current !== undefined && state.recorded !== state.current) return "baseline";
  return null;
}

export function useCommand(context: MutationContext, baseline?: string) {
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<SubmissionOutcome | null>(null);
  const [recorded, setRecorded] = useState(baseline);
  const [stale, setStale] = useState(false);
  const baselineChanged = submissionRefusal({ busy: false, blocked: false, stale, recorded, current: baseline }) === "baseline";
  async function submit(build: () => Record<string, unknown>): Promise<boolean> {
    const refusal = submissionRefusal({ busy, blocked: context.blocked, stale, recorded, current: baseline });
    if (refusal === "baseline") { setOutcome(refused(baselineChangedText)); return false; }
    if (refusal) return false;
    setOutcome(null);
    let command: Command;
    try { command = commandSchema.parse({ ...build(), projectId: context.projectId, operationId: crypto.randomUUID() }); }
    catch { setOutcome(refused("请补全必需字段并检查输入格式。")); return false; }
    setBusy(true);
    let recordedReceipt = false;
    try { recordedReceipt = await context.onAttempt(command); }
    catch { /* A receipt that could not be saved must never send its command. */ }
    if (!recordedReceipt) { setBusy(false); setOutcome(refused("浏览器不能保存恢复回执，本次尚未提交。")); return false; }
    try {
      const result = await api().command(command);
      context.onKnown(command.operationId);
      const next = resultOutcome(result);
      setOutcome(next);
      if (next.stale) setStale(true);
      if (next.applied) context.onChanged();
      return next.applied;
    } catch (cause) {
      if (!isUnconfirmed(cause)) context.onKnown(command.operationId);
      const next = errorOutcome(cause);
      setOutcome(next);
      if (next.stale) setStale(true);
      return false;
    } finally { setBusy(false); }
  }
  /** The person has looked at the latest content: it becomes the form's new baseline. */
  function rebase() { setRecorded(baseline); setStale(false); setOutcome(null); }
  return { busy, outcome, submit, clear: () => setOutcome(null), baselineChanged, rebase, recordedBaseline: recorded };
}
