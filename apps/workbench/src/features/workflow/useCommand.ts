// One command from a form built on @evoloop/ui, with the same safety as ActionForm: the operation ID is saved as a
// recovery receipt before anything is sent, an unconfirmed result keeps the receipt, and only an applied result
// clears the draft and rereads.
import { useState } from "react";
import { commandSchema, type Command } from "@evoloop/contracts";
import { api, isUnconfirmed } from "../../shared/api";
import type { MutationContext } from "../../shared/ActionForm";
import { errorOutcome, resultOutcome, type SubmissionOutcome } from "../../shared/submissionOutcome";

const refused = (message: string): SubmissionOutcome => ({ applied: false, failed: true, stale: false, unconfirmed: false, message });

export function useCommand(context: MutationContext) {
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<SubmissionOutcome | null>(null);
  async function submit(build: () => Record<string, unknown>): Promise<boolean> {
    if (busy || context.blocked) return false;
    setOutcome(null);
    let command: Command;
    try { command = commandSchema.parse({ ...build(), projectId: context.projectId, operationId: crypto.randomUUID() }); }
    catch { setOutcome(refused("请补全必需字段并检查输入格式。")); return false; }
    setBusy(true);
    let recorded = false;
    try { recorded = await context.onAttempt(command); }
    catch { /* A receipt that could not be saved must never send its command. */ }
    if (!recorded) { setBusy(false); setOutcome(refused("浏览器不能保存恢复回执，本次尚未提交。")); return false; }
    try {
      const result = await api().command(command);
      context.onKnown(command.operationId);
      const next = resultOutcome(result);
      setOutcome(next);
      if (next.applied) context.onChanged();
      return next.applied;
    } catch (cause) {
      if (!isUnconfirmed(cause)) context.onKnown(command.operationId);
      setOutcome(errorOutcome(cause));
      return false;
    } finally { setBusy(false); }
  }
  return { busy, outcome, submit, clear: () => setOutcome(null) };
}
