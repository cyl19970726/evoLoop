// One command, sent with the protections every form needs (docs/frontend/components.md, “提交表单”):
//   - the recovery receipt and intent are saved (`context.onAttempt`) before anything is sent; a receipt that cannot be
//     saved sends nothing;
//   - each submission gets a new operation ID; a lost answer is retried only by that original ID (OperationCheck);
//   - an unknown result keeps the receipt (which blocks every other write in the project) and blocks this form; when
//     the receipt has been resolved, the form reads the operation by its original ID: applied clears the draft,
//     rejected keeps it;
//   - the form records its baseline when it opens (every fixed input the command depends on); a changed baseline or a
//     stale answer refuses to send, and the versions sent are always the recorded ones;
//   - a version conflict rereads (`onStale`) before the person decides what to do with their changes.
// The hook never adopts a newer baseline by itself: the form does (`rebase`) when nobody has typed into it, or after
// the person has looked at the latest content (CommandForm applies this rule).
import { useEffect, useRef, useState } from "react";
import type { AppliedResult, Command, CommandResult } from "@evoloop/contracts";
import { api, errorText, isUnconfirmed } from "../api";
import { errorOutcome, resultOutcome, type SubmissionOutcome } from "../submissionOutcome";
import type { MutationContext, RecoverableCommand } from "./context";
import type { DraftStore, PendingOperation, SavedDraft } from "./drafts";
import {
  baselineChangedText, baselineText, changedParts, openingBaseline, personMessage, prepareCommand, receiptFailedText,
  submissionRefusal, unconfirmedNote, type Baseline, type SubmittableCommand,
} from "./rules";

const refused = (message: string): SubmissionOutcome => ({ applied: false, failed: true, stale: false, unconfirmed: false, message });

export interface CommandOptions {
  /** Sends to a dedicated endpoint (the Leader's plan, dependencies and review) instead of the command endpoint. */
  send?: ((command: SubmittableCommand) => Promise<CommandResult>) | undefined;
  /** Checks the built command instead of the shared command schema; the command is then sent exactly as built. */
  validate?: ((candidate: Record<string, unknown>) => void) | undefined;
  /** Keeps the draft between mounts, with the baseline it was written against. The key names the object. */
  draft?: { store: DraftStore; key: string } | undefined;
  /** The service answered that the version moved: reread, so the person can look at the latest content. */
  onStale?: (() => void) | undefined;
  /** Called with the applied result, also when an unknown result is later read back as applied. */
  onApplied?: ((result: AppliedResult) => void) | undefined;
  /** Readable names of the parts of an object baseline, for “变化的是：…”. */
  partLabels?: Readonly<Record<string, string>> | undefined;
  /**
   * What the form shows besides its baseline (its latest field values, as one string). After a version conflict the
   * form waits for a reread; a reread that changes either the baseline or this ends the wait.
   */
  content?: string | undefined;
}

export function useCommand<B extends Baseline | string | undefined = undefined>(context: MutationContext, baseline?: B, options: CommandOptions = {}) {
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<SubmissionOutcome | null>(null);
  const [restored] = useState<SavedDraft | undefined>(() => options.draft ? options.draft.store.get(options.draft.key) : undefined);
  const [recorded, setRecorded] = useState(() => openingBaseline(restored, baseline));
  const [stale, setStale] = useState(false);
  // What was on screen when the service said the version moved: until a reread changes it, there is nothing new to
  // look at, so the form waits instead of offering to keep or refill against the same old content.
  const [staleAt, setStaleAt] = useState<string | undefined>(undefined);
  // A submission whose result is unknown (restored with its draft after a remount).
  const [pending, setPending] = useState<PendingOperation | null>(() => restored?.pending ?? null);
  const [checking, setChecking] = useState(false);
  const latest = useRef(options);
  latest.current = options;
  // The per-submission callback of the operation that is pending, for when it is read back as applied.
  const appliedHere = useRef<((result: AppliedResult) => void) | undefined>(undefined);
  const draftKey = options.draft?.key;
  const current = baselineText(baseline);
  const view = `${current ?? ""}\u0000${options.content ?? ""}`;
  const baselineChanged = submissionRefusal({ busy: false, blocked: false, stale, recorded: baselineText(recorded), current }) === "baseline";

  const store = () => options.draft && draftKey ? { store: options.draft.store, key: draftKey } : null;
  function dropDraft() { const kept = store(); if (kept) kept.store.delete(kept.key); }
  /** Keep the typed values with the baseline they are written against (and an operation still to be checked). */
  function saveDraft(values: unknown) {
    const kept = store();
    if (kept) kept.store.set(kept.key, { values, baseline: recorded, ...(pending ? { pending } : {}) });
  }
  function keepPending(operation: PendingOperation | null) {
    const kept = store();
    if (!kept) return;
    const saved = kept.store.get(kept.key);
    if (operation) kept.store.set(kept.key, { ...(saved ?? { values: undefined, baseline: recorded }), pending: operation });
    else if (saved) {
      const { pending: _, ...rest } = saved;
      if (rest.values === undefined) kept.store.delete(kept.key); else kept.store.set(kept.key, rest);
    }
  }
  function markStale() { setStale(true); setStaleAt(view); latest.current.onStale?.(); }
  function applied(result: AppliedResult, here: ((result: AppliedResult) => void) | undefined) {
    dropDraft(); here?.(result); latest.current.onApplied?.(result); context.onChanged();
  }

  /**
   * Sends the command `build` returns from the recorded baseline. Resolves true only when the service applied it.
   * `onApplied` runs for this submission, also when its unknown result is read back as applied later.
   */
  async function submit(build: (seen: B) => Record<string, unknown>, onApplied?: (result: AppliedResult) => void): Promise<boolean> {
    const refusal = submissionRefusal({ busy, blocked: context.blocked, stale, unconfirmed: !!pending, recorded: baselineText(recorded), current });
    if (refusal === "baseline") { setOutcome(refused(baselineChangedText)); return false; }
    if (refusal) return false;
    setOutcome(null);
    let command: SubmittableCommand;
    try {
      let built: Record<string, unknown>;
      try { built = build(recorded as B); }
      catch (cause) { throw new Error(personMessage(cause)); }
      command = prepareCommand(built, context.projectId, crypto.randomUUID(), options);
    } catch (cause) { setOutcome(refused(personMessage(cause))); return false; }
    setBusy(true);
    let receipt = false;
    try { receipt = await context.onAttempt(command as RecoverableCommand); }
    catch { /* A receipt that could not be saved must never send its command. */ }
    if (!receipt) { setBusy(false); setOutcome(refused(receiptFailedText)); return false; }
    try {
      const result = options.send ? await options.send(command) : await api().command(command as Command);
      context.onKnown(command.operationId);
      const next = resultOutcome(result);
      setOutcome(next);
      if (next.stale) markStale();
      if (result.status === "applied") { applied(result, onApplied); return true; }
      return false;
    } catch (cause) {
      const next = errorOutcome(cause);
      if (isUnconfirmed(cause)) {
        // The receipt stays: it blocks every write in the project until the operation is checked by its original ID.
        const operation = { operationId: command.operationId, type: command.type };
        appliedHere.current = onApplied;
        setPending(operation); keepPending(operation);
        setOutcome({ ...next, message: `${next.message}${unconfirmedNote}` });
        return false;
      }
      context.onKnown(command.operationId);
      setOutcome(next);
      if (next.stale) markStale();
      return false;
    } finally { setBusy(false); }
  }

  /** Reads the pending operation by its original ID: applied clears the draft, rejected keeps it for a new submission. */
  async function readBack() {
    const operation = pending;
    if (!operation || checking) return;
    setChecking(true);
    try {
      const record = await api().operation(context.projectId, operation.operationId);
      if (record.projectId !== context.projectId || record.actorId !== context.principal.actorId || record.commandType !== operation.type)
        throw new Error("操作记录与这次提交不符");
      setPending(null); keepPending(null);
      const here = appliedHere.current;
      appliedHere.current = undefined;
      if (record.result.status === "applied") {
        setOutcome({ applied: true, failed: false, stale: false, unconfirmed: false, message: "原操作已核对为已应用，这份草稿已清除。" });
        applied(record.result, here);
      } else {
        const refusal = resultOutcome(record.result);
        setOutcome({ ...refusal, message: `原操作已核对为被拒绝：${refusal.message}。草稿保留，可修改后以新操作提交。` });
        if (refusal.stale) markStale();
      }
    } catch (cause) {
      setOutcome({ applied: false, failed: true, stale: false, unconfirmed: true,
        message: `结果仍未核清：${errorText(cause)}。草稿保留，确认前不要再次提交。` });
    } finally { setChecking(false); }
  }
  // The receipt is checked elsewhere (结果未知的操作); once it is resolved, find out what happened to this submission.
  useEffect(() => {
    if (pending && !context.blocked && !checking) void readBack();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending?.operationId, context.blocked]);

  /**
   * The person has looked at the latest content (or the form had no changes): it becomes the new baseline, the kept
   * draft's too. `values` replaces the kept draft's values (what the form keeps after “保留我的修改”).
   */
  function rebase(values?: unknown) {
    setRecorded(baseline as B); setStale(false); setStaleAt(undefined);
    setOutcome(previous => previous?.unconfirmed ? previous : null);
    const kept = store();
    const saved = kept?.store.get(kept.key);
    if (kept && (saved || values !== undefined)) kept.store.set(kept.key, { ...saved, values: values === undefined ? saved?.values : values, baseline });
  }
  /** The person picked an object: its part of the baseline is taken as read now (an object baseline only). */
  function adopt(parts: Record<string, string | number | boolean | null>) {
    setRecorded(previous => previous && typeof previous === "object" ? { ...previous, ...parts } as B : previous);
  }
  return {
    busy, outcome, submit, readBack, clear: () => setOutcome(null), baselineChanged, rebase, adopt,
    /** The recorded baseline the command is built from. */
    recordedBaseline: recorded, seen: recorded as B,
    /** The readable names of the baseline parts that moved since the form recorded them. */
    changed: baselineChanged ? changedParts(recorded, baseline, options.partLabels) : [],
    /** The service said the version moved and the latest content has not been read back yet. */
    awaitingReread: stale && staleAt === view,
    stale,
    /** A submission's result is unknown: nothing more is sent until it is checked by its original ID. */
    unconfirmed: !!pending, checking,
    /** The values kept from an earlier mount, or undefined. */
    restoredDraft: restored?.values, saveDraft, dropDraft,
  };
}
