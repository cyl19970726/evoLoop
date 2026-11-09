// One command from a form built on @evoloop/ui, with the same safety as ActionForm: the operation ID is saved as a
// recovery receipt before anything is sent, an unconfirmed result keeps the receipt, and only an applied result
// rereads. The form records what the person saw when it opened (its baseline): every fixed input the command
// depends on, such as the task version, the assignment, queue or timing version, the impact or the delivery. If any
// of it changes before submitting, or the service answers that the version moved, the form refuses until the
// person has looked at the latest content; the versions sent are always the recorded ones.
// A form that keeps its draft between mounts passes `options.draft`: the draft is kept together with the baseline it
// was written against, so a form mounted again later still compares against what the person saw, not what is on
// screen now.
// The hook never adopts a newer baseline by itself. The forms apply one rule (RecordForm, CommandForm and the task
// page's own forms): a form nobody has typed into follows the latest content and records it as its new baseline; a
// form with changes waits until the person has looked (`rebase`).
import { useState } from "react";
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

/** A kept draft and the baseline it was written against (the baseline itself, an object or a string). */
export interface SavedDraft { values: unknown; baseline: Baseline | string | undefined }
/** Where drafts are kept between mounts (a Map works); the key names the object, and the record, the draft is for. */
export type DraftStore = Pick<Map<string, SavedDraft>, "get" | "set" | "delete">;
export interface CommandOptions {
  /** Sends to a dedicated endpoint (the Leader's plan, dependencies and review) instead of the command endpoint. */
  send?: ((command: SubmittableCommand) => Promise<CommandResult>) | undefined;
  /**
   * Checks the built command instead of the shared command schema; the command is then sent exactly as built.
   * For commands with their own endpoint or schema, as ActionForm's `validateCommand`.
   */
  validate?: ((candidate: Record<string, unknown>) => void) | undefined;
  draft?: { store: DraftStore; key: string } | undefined;
  /** The service answered that the version moved: reread, so the person can look at the latest content. */
  onStale?: (() => void) | undefined;
}

/** The baseline a form compares against when it mounts: a kept draft's own baseline, else what is on screen now. */
export function openingBaseline<B>(saved: SavedDraft | undefined, current: B): B {
  return saved ? saved.baseline as B : current;
}

/**
 * Builds the command that is sent: the form's fields plus the project and a new operation ID, parsed by the shared
 * schema (which trims text), or checked by `validate` and kept as built. Throws a message for the person.
 */
export function prepareCommand(built: Record<string, unknown>, projectId: string, operationId: string, options: Pick<CommandOptions, "validate"> = {}): SubmittableCommand {
  const candidate = { ...built, projectId, operationId };
  try {
    if (options.validate) { options.validate(candidate); return candidate as SubmittableCommand; }
    return commandSchema.parse(candidate);
  } catch { throw new Error(incompleteText); }
}

export function useCommand<B extends Baseline | string | undefined = undefined>(context: MutationContext, baseline?: B, options: CommandOptions = {}) {
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<SubmissionOutcome | null>(null);
  const [restored] = useState(() => options.draft ? options.draft.store.get(options.draft.key) : undefined);
  const [recorded, setRecorded] = useState(() => openingBaseline(restored, baseline));
  const [stale, setStale] = useState(false);
  // The baseline on screen when the service said the version moved: until a reread changes it, there is nothing new
  // to look at, so the form waits instead of offering to keep or refill against the same old content.
  const [staleAt, setStaleAt] = useState<string | undefined>(undefined);
  const draftKey = options.draft?.key;
  const current = baselineText(baseline);
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
      try { built = build(recorded as B); }
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
      if (next.stale) { setStale(true); setStaleAt(current); options.onStale?.(); }
      if (next.applied) { dropDraft(); context.onChanged(); }
      return next.applied;
    } catch (cause) {
      if (!isUnconfirmed(cause)) context.onKnown(command.operationId);
      const next = errorOutcome(cause);
      setOutcome(next);
      if (next.stale) { setStale(true); setStaleAt(current); options.onStale?.(); }
      return false;
    } finally { setBusy(false); }
  }
  /** Keep the typed values with the baseline they are written against. */
  function saveDraft(values: unknown) { if (options.draft && draftKey) options.draft.store.set(draftKey, { values, baseline: recorded }); }
  function dropDraft() { if (options.draft && draftKey) options.draft.store.delete(draftKey); }
  /** The person has looked at the latest content (or the form had no changes): it becomes the new baseline, the kept draft's too. */
  function rebase() {
    setRecorded(baseline as B); setStale(false); setStaleAt(undefined); setOutcome(null);
    const kept = draftKey ? options.draft?.store.get(draftKey) : undefined;
    if (kept && draftKey) options.draft!.store.set(draftKey, { ...kept, baseline });
  }
  return { busy, outcome, submit, clear: () => setOutcome(null), baselineChanged, rebase, recordedBaseline: recorded,
    /** The service said the version moved and the latest content has not been read back yet. */
    awaitingReread: stale && staleAt === current,
    /** The recorded baseline the command is built from. */
    seen: recorded as B,
    /** The values kept from an earlier mount, or undefined. */
    restoredDraft: restored?.values, saveDraft, dropDraft };
}
