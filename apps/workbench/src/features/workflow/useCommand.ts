// One command from a form built on @evoloop/ui, with the same safety as ActionForm: the operation ID is saved as a
// recovery receipt before anything is sent, an unconfirmed result keeps the receipt, and only an applied result
// rereads. The form records what the person saw when it opened (its baseline); if that changes before submitting,
// or the service answers that the version moved, the form refuses until the person has looked at the latest content.
// A form that keeps its draft between mounts passes `options.draft`: the draft is kept together with the baseline it
// was written against, so a form mounted again later still compares against what the person saw, not what is on
// screen now.
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

/** A kept draft and the baseline it was written against. */
export interface SavedDraft { values: unknown; baseline: string | undefined }
/** Where drafts are kept between mounts (a Map works); the key names the object, and the record, the draft is for. */
export type DraftStore = Pick<Map<string, SavedDraft>, "get" | "set" | "delete">;
export interface CommandOptions {
  draft?: { store: DraftStore; key: string } | undefined;
  /** The service answered that the version moved: reread, so the person can look at the latest content. */
  onStale?: (() => void) | undefined;
}

/** The baseline a form compares against when it mounts: a kept draft's own baseline, else what is on screen now. */
export function openingBaseline(saved: SavedDraft | undefined, current: string | undefined): string | undefined {
  return saved ? saved.baseline : current;
}

export function useCommand(context: MutationContext, baseline?: string, options: CommandOptions = {}) {
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<SubmissionOutcome | null>(null);
  const [restored] = useState(() => options.draft ? options.draft.store.get(options.draft.key) : undefined);
  const [recorded, setRecorded] = useState(() => openingBaseline(restored, baseline));
  const [stale, setStale] = useState(false);
  const draftKey = options.draft?.key;
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
      if (next.stale) { setStale(true); options.onStale?.(); }
      if (next.applied) { dropDraft(); context.onChanged(); }
      return next.applied;
    } catch (cause) {
      if (!isUnconfirmed(cause)) context.onKnown(command.operationId);
      const next = errorOutcome(cause);
      setOutcome(next);
      if (next.stale) { setStale(true); options.onStale?.(); }
      return false;
    } finally { setBusy(false); }
  }
  /** Keep the typed values with the baseline they are written against. */
  function saveDraft(values: unknown) { if (options.draft && draftKey) options.draft.store.set(draftKey, { values, baseline: recorded }); }
  function dropDraft() { if (options.draft && draftKey) options.draft.store.delete(draftKey); }
  /** The person has looked at the latest content: it becomes the form's new baseline (and the kept draft's). */
  function rebase() {
    setRecorded(baseline); setStale(false); setOutcome(null);
    const kept = draftKey ? options.draft?.store.get(draftKey) : undefined;
    if (kept && draftKey) options.draft!.store.set(draftKey, { ...kept, baseline });
  }
  return { busy, outcome, submit, clear: () => setOutcome(null), baselineChanged, rebase, recordedBaseline: recorded,
    /** The values kept from an earlier mount, or undefined. */
    restoredDraft: restored?.values, saveDraft, dropDraft };
}
