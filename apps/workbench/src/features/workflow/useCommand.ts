// One command from a form built on @evoloop/ui, with the same safety as ActionForm: the operation ID is saved as a
// recovery receipt before anything is sent, an unconfirmed result keeps the receipt, and only an applied result
// rereads. The form records what the person saw when it opened (its baseline): every fixed input the command
// depends on, such as the task version, the assignment, queue or timing version, the impact or the delivery. If any
// of it changes before submitting, or the service answers that the version moved, the form refuses until the
// person has looked at the latest content; the versions sent are always the recorded ones.
import { useEffect, useRef, useState } from "react";
import { commandSchema, type Command, type CommandResult } from "@evoloop/contracts";
import { api, isUnconfirmed } from "../../shared/api";
import type { MutationContext, RecoverableCommand } from "../../shared/ActionForm";
import { errorOutcome, resultOutcome, type SubmissionOutcome } from "../../shared/submissionOutcome";

const refused = (message: string): SubmissionOutcome => ({ applied: false, failed: true, stale: false, unconfirmed: false, message });
export const baselineChangedText = "打开表单后，这里的内容已被更新。请先查看最新内容，再按最新内容重新提交。";
export const incompleteText = "请补全必需字段并检查输入格式。";

/** The fixed inputs a form was opened on. Values are compared exactly; key order does not matter. */
export type Baseline = Readonly<Record<string, string | number | boolean | null>>;
export type SubmittableCommand = Command | (Record<string, unknown> & RecoverableCommand);

/** A baseline as one comparable string (a string baseline is used as is). */
export function baselineText(value: Baseline | string | undefined): string | undefined {
  if (value === undefined || typeof value === "string") return value;
  return JSON.stringify(Object.keys(value).sort().map(key => [key, value[key]]));
}

/** Why a submission must not be sent now, or null. A changed baseline or a stale answer always refuses. */
export function submissionRefusal(state: { busy: boolean; blocked: boolean; stale: boolean; recorded?: string | undefined; current?: string | undefined }):
  "busy" | "blocked" | "baseline" | null {
  if (state.busy) return "busy";
  if (state.blocked) return "blocked";
  if (state.stale || state.recorded !== undefined && state.current !== undefined && state.recorded !== state.current) return "baseline";
  return null;
}

export interface CommandOptions {
  /** Sends to a dedicated endpoint (the Leader's plan, dependencies and review) instead of the command endpoint. */
  send?: ((command: SubmittableCommand) => Promise<CommandResult>) | undefined;
  /**
   * Checks the built command instead of the shared command schema; the command is then sent exactly as built.
   * For commands with their own endpoint or schema, as ActionForm's `validateCommand`.
   */
  validate?: ((candidate: Record<string, unknown>) => void) | undefined;
}

/**
 * Builds the command that is sent: the form's fields plus the project and a new operation ID, parsed by the shared
 * schema (which trims text), or checked by `validate` and kept as built. Throws a message for the person.
 */
export function prepareCommand(built: Record<string, unknown>, projectId: string, operationId: string, options: CommandOptions = {}): SubmittableCommand {
  const candidate = { ...built, projectId, operationId };
  try {
    if (options.validate) { options.validate(candidate); return candidate as SubmittableCommand; }
    return commandSchema.parse(candidate);
  } catch { throw new Error(incompleteText); }
}

export function useCommand<B extends Baseline | string | undefined = undefined>(context: MutationContext, baseline?: B, options: CommandOptions = {}) {
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<SubmissionOutcome | null>(null);
  const [recorded, setRecorded] = useState<B | undefined>(baseline);
  const [stale, setStale] = useState(false);
  // After this form's own write is applied, the next baseline read back is its result: it becomes the new baseline.
  const followNext = useRef(false);
  const current = baselineText(baseline);
  useEffect(() => {
    if (recorded === undefined && baseline !== undefined) { setRecorded(baseline); return; }
    if (followNext.current && current !== baselineText(recorded)) { followNext.current = false; setRecorded(baseline); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current]);
  const seen = (recorded ?? baseline) as B;
  const baselineChanged = submissionRefusal({ busy: false, blocked: false, stale, recorded: baselineText(recorded), current }) === "baseline";
  /** Sends the command `build` returns from the recorded baseline. Resolves true only when the service applied it. */
  async function submit(build: (seen: B) => Record<string, unknown>): Promise<boolean> {
    const refusal = submissionRefusal({ busy, blocked: context.blocked, stale, recorded: baselineText(recorded), current });
    if (refusal === "baseline") { setOutcome(refused(baselineChangedText)); return false; }
    if (refusal) return false;
    setOutcome(null);
    let command: SubmittableCommand;
    try {
      let built: Record<string, unknown>;
      try { built = build(seen); }
      catch (cause) { throw new Error(cause instanceof Error && cause.message ? cause.message : incompleteText); }
      command = prepareCommand(built, context.projectId, crypto.randomUUID(), options);
    } catch (cause) { setOutcome(refused(cause instanceof Error ? cause.message : incompleteText)); return false; }
    setBusy(true);
    let recordedReceipt = false;
    try { recordedReceipt = await context.onAttempt(command as RecoverableCommand); }
    catch { /* A receipt that could not be saved must never send its command. */ }
    if (!recordedReceipt) { setBusy(false); setOutcome(refused("浏览器不能保存恢复回执，本次尚未提交。")); return false; }
    try {
      const result = options.send ? await options.send(command) : await api().command(command as Command);
      context.onKnown(command.operationId);
      const next = resultOutcome(result);
      setOutcome(next);
      if (next.stale) setStale(true);
      if (next.applied) { followNext.current = true; context.onChanged(); }
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
  function rebase() { followNext.current = false; setRecorded(baseline); setStale(false); setOutcome(null); }
  return { busy, outcome, submit, clear: () => setOutcome(null), baselineChanged, rebase, recordedBaseline: recorded, seen };
}
