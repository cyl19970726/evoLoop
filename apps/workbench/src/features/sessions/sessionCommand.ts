// One command from the agent page's own controls (the composer, withdrawing a queued message, stopping a turn), with
// the same safety as the shared forms: the operation ID is saved as a recovery receipt before anything is sent, an
// unconfirmed result keeps the receipt, and only an applied result rereads the project.
import { commandSchema, type Command } from "@evoloop/contracts";
import { api, isUnconfirmed } from "../../shared/api";
import type { MutationContext } from "../../shared/ActionForm";
import { errorOutcome, resultOutcome, type SubmissionOutcome } from "../../shared/submissionOutcome";

const refused = (message: string): SubmissionOutcome => ({ applied: false, failed: true, stale: false, unconfirmed: false, message });

export async function sendSessionCommand(context: Pick<MutationContext, "projectId" | "onAttempt" | "onKnown" | "onChanged">,
  candidate: Record<string, unknown>): Promise<SubmissionOutcome> {
  let command: Command;
  try { command = commandSchema.parse({ ...candidate, projectId: context.projectId, operationId: crypto.randomUUID() }); }
  catch { return refused("内容格式无法确认，请检查后再发送。"); }
  let recorded = false;
  try { recorded = await context.onAttempt(command); }
  catch { /* A receipt that could not be saved must never send its command. */ }
  if (!recorded) return refused("浏览器不能保存恢复回执，本次尚未发送。");
  try {
    const result = await api().command(command);
    context.onKnown(command.operationId);
    const outcome = resultOutcome(result);
    if (outcome.applied) context.onChanged();
    return outcome;
  } catch (cause) {
    if (!isUnconfirmed(cause)) context.onKnown(command.operationId);
    return errorOutcome(cause);
  }
}
