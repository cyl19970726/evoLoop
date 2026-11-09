// Discussion writes on @evoloop/ui. Submission keeps the rules of shared/ActionForm: the operation ID is saved as a
// recovery receipt before anything is sent and only an applied result clears the draft. Because the form keeps the
// reader's text across rereads (it is not rebuilt), it also refuses to send while:
//   - the server said the observed version or pointer changed (stale), until the reader rereads and checks again;
//   - the result of the last send is unknown; once the receipt is resolved the form reads that operation by its ID
//     and clears the draft if it was applied, so the same write is never sent twice;
//   - any fixed input changed since the reader looked (see discussionBaseline.ts).
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { commandSchema, type Command, type Permission } from "@evoloop/contracts";
import { Button, Notice, cn } from "@evoloop/ui";
import { api, errorText, isStaleConflict, isUnconfirmed } from "../../shared/api";
import type { MutationContext } from "../../shared/ActionForm";
import { errorOutcome, resultOutcome } from "../../shared/submissionOutcome";

export interface SubmitState { busy: boolean; message: string; failed: boolean; stale: boolean; unconfirmed: boolean; checking: boolean }
const idle: SubmitState = { busy: false, message: "", failed: false, stale: false, unconfirmed: false, checking: false };

export function canWrite(context: MutationContext, permission: Permission): boolean {
  return context.principal.permissions.includes(permission);
}

/** Sends one discussion command. `build` throws an Error with a reader-facing message when the input is not usable. */
export function useCommandSubmit(context: MutationContext) {
  const [state, setState] = useState<SubmitState>(idle);
  const sent = useRef<{ operationId: string; type: string; onApplied?: (entityId: string) => void } | null>(null);
  const { projectId, principal, blocked, onChanged, onKnown } = context;

  /** Read the unconfirmed operation by its original ID; applied clears the draft, rejected keeps it. */
  async function readBack() {
    const pending = sent.current;
    if (!pending) return;
    setState(current => ({ ...current, checking: true }));
    try {
      const operation = await api().operation(projectId, pending.operationId);
      if (operation.projectId !== projectId || operation.actorId !== principal.actorId || operation.commandType !== pending.type)
        throw new Error("操作记录与这次提交不符");
      onKnown(pending.operationId); sent.current = null;
      if (operation.result.status === "applied") {
        setState({ ...idle, message: "原操作已核对为已应用，这份草稿已清除。" });
        pending.onApplied?.(operation.result.entityId); onChanged();
      } else setState({ ...idle, failed: true, stale: isStaleConflict(operation.result.code),
        message: `原操作已核对为被拒绝：${operation.result.message}。草稿保留，可修改后以新操作提交。` });
    } catch (cause) {
      setState(current => ({ ...current, checking: false,
        message: `结果仍未核清：${errorText(cause)}。草稿保留，确认前不要再次提交。` }));
    }
  }
  // The receipt is resolved elsewhere (结果未知的操作); when it is gone, find out what happened to this write.
  useEffect(() => { if (state.unconfirmed && !blocked && !state.checking) void readBack(); }, [state.unconfirmed, blocked]); // readBack reads refs and props only

  async function submit(build: () => Record<string, unknown>, onApplied?: (entityId: string) => void): Promise<boolean> {
    // An unconfirmed result leaves its receipt in place, which also sets context.blocked until it is checked.
    if (state.busy || state.stale || state.unconfirmed || blocked) return false;
    let command: Command;
    try { command = commandSchema.parse({ ...build(), projectId, operationId: crypto.randomUUID() }); }
    catch (cause) {
      const message = cause instanceof Error && !("issues" in cause) ? cause.message : "有字段没有填写或格式不对，请检查后再保存。";
      setState({ ...idle, message, failed: true }); return false;
    }
    setState({ ...idle, busy: true });
    let recorded = false;
    try { recorded = await context.onAttempt(command); } catch { /* without a saved receipt nothing is sent */ }
    if (!recorded) { setState({ ...idle, message: "浏览器不能保存恢复回执，这次没有提交。", failed: true }); return false; }
    sent.current = { operationId: command.operationId, type: command.type, onApplied };
    try {
      const result = await api().command(command);
      onKnown(command.operationId); sent.current = null;
      const outcome = resultOutcome(result);
      setState({ ...idle, message: outcome.message, failed: outcome.failed, stale: outcome.stale });
      if (outcome.applied && result.status === "applied") { onApplied?.(result.entityId); onChanged(); return true; }
    } catch (cause) {
      if (isUnconfirmed(cause)) {
        setState({ ...idle, failed: true, unconfirmed: true,
          message: `${errorText(cause)}。这次提交的结果未确认：请在“结果未知的操作”里按原操作 ID 核对；核对为已应用后，这份草稿会自动清除。确认前不要再次提交。` });
      } else {
        onKnown(command.operationId); sent.current = null;
        const outcome = errorOutcome(cause);
        setState({ ...idle, message: outcome.message, failed: true, stale: outcome.stale });
      }
    }
    return false;
  }
  return { state, submit, readBack, reset: () => setState(idle) };
}

export const muted = "text-caption text-muted-foreground";
export const control = "w-full rounded-md bg-field px-3 text-small text-foreground outline-none focus-visible:shadow-[var(--focus-ring)] disabled:opacity-50";

/** A labelled native select; @evoloop/ui has no Select yet (docs/frontend/components.md). */
export function SelectField({ label, hint, error, value, onChange, children, disabled }: {
  label: string; hint?: string; error?: string; value: string; onChange(value: string): void; children: ReactNode; disabled?: boolean;
}) {
  return <label className="flex flex-col gap-1.5">
    <span className="text-label font-semibold text-foreground">{label}</span>
    <select value={value} disabled={disabled} aria-invalid={error ? true : undefined} onChange={event => onChange(event.target.value)}
      className={cn(control, "h-9", error && "shadow-[inset_0_0_0_1.5px_var(--danger)]")}>{children}</select>
    {hint && <span className={muted}>{hint}</span>}
    {error && <span className="text-caption text-destructive">{error}</span>}
  </label>;
}

/**
 * The frame every discussion form shares. Sending is refused while `notReady` names a reason, while `changed` lists
 * parts of the baseline that moved, after a stale answer (until the reader rereads and checks again), and while the
 * last result is unknown.
 */
export function CommandFormShell({ label, submitLabel, dirty, submit, blocked, changed = [], notReady, rereading, onAccept, onCopyDraft, onReread, onCancel, onSubmit, children }: {
  label: string; submitLabel: string; dirty: boolean; submit: ReturnType<typeof useCommandSubmit>; blocked: boolean;
  changed?: string[]; notReady?: string | undefined; rereading?: boolean;
  onAccept(): void; onCopyDraft?: () => void; onReread(): void; onCancel?: () => void; onSubmit(): void; children: ReactNode;
}) {
  const { state } = submit;
  const [reread, setReread] = useState(false);
  const handle = (event: FormEvent) => { event.preventDefault(); onSubmit(); };
  const accept = () => { setReread(false); onAccept(); };
  const disabled = state.busy || state.stale || state.unconfirmed || blocked || changed.length > 0 || !!notReady;
  return <form aria-label={label} data-dirty={dirty ? "true" : undefined} onSubmit={handle} className="flex flex-col gap-4 rounded-xl bg-muted p-4">
    {children}
    {notReady && <Notice tone="waiting">{notReady}</Notice>}
    {blocked && !state.unconfirmed && <Notice tone="waiting">本项目还有结果未确认的操作。先在“结果未知的操作”里按原操作核对，再保存这里的内容。</Notice>}
    {state.stale ? <Notice tone="error" title="所见内容已过期" action={<div className="flex flex-col gap-1.5">
      {onCopyDraft && <Button size="compact" onClick={onCopyDraft}>复制草稿</Button>}
      {reread
        ? <Button size="compact" disabled={rereading} onClick={accept}>{rereading ? "正在重新读取…" : "已重新核对，继续"}</Button>
        : <Button size="compact" variant="ghost" onClick={() => { setReread(true); onReread(); }}>重新读取</Button>}
    </div>}>{state.message} 输入仍保留；重新读取并核对新内容后才能再保存。</Notice>
      : changed.length > 0 ? <Notice tone="waiting" title="内容已变化，请重新核对" action={<Button size="compact" disabled={rereading} onClick={accept}>已重新核对</Button>}>
        变化的是：{changed.join("、")}。输入仍保留；先看上方读回的新内容，确认这份输入仍然适用，再保存。</Notice>
      : state.message ? <Notice tone={state.failed ? "error" : "info"} action={state.unconfirmed && !blocked &&
          <Button size="compact" disabled={state.checking} onClick={() => void submit.readBack()}>{state.checking ? "正在核对…" : "按原操作核对"}</Button>}>{state.message}</Notice>
      : null}
    <div className="flex flex-wrap items-center gap-2">
      <Button type="submit" variant="primary" disabled={disabled}>{state.busy ? "正在保存…" : submitLabel}</Button>
      {onCancel && <Button variant="ghost" onClick={onCancel} disabled={state.busy}>收起</Button>}
    </div>
  </form>;
}

/** The text of a draft, so a reader can keep it before rereading. */
export async function copyDraft(title: string, fields: Array<[string, string]>): Promise<boolean> {
  try { await navigator.clipboard.writeText(`${title}\n\n${fields.map(([label, value]) => `${label}\n${value}`).join("\n\n")}`); return true; }
  catch { return false; }
}
