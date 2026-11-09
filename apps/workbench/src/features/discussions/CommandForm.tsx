// Discussion writes on @evoloop/ui. Submission keeps the rules of shared/ActionForm: the operation ID is saved as a
// recovery receipt before anything is sent, only an applied result clears the draft, an unconfirmed result blocks a
// second submit, and a version change while typing keeps the text and asks the reader to look again first.
import { useState, type FormEvent, type ReactNode } from "react";
import { commandSchema, type Command, type Permission } from "@evoloop/contracts";
import { Button, Notice, cn } from "@evoloop/ui";
import { api } from "../../shared/api";
import type { MutationContext } from "../../shared/ActionForm";
import { errorOutcome, resultOutcome } from "../../shared/submissionOutcome";

export interface SubmitState { busy: boolean; message: string; failed: boolean; stale: boolean; unconfirmed: boolean }
const idle: SubmitState = { busy: false, message: "", failed: false, stale: false, unconfirmed: false };

export function canWrite(context: MutationContext, permission: Permission): boolean {
  return context.principal.permissions.includes(permission);
}

/** Sends one discussion command. `build` throws an Error with a reader-facing message when the input is not usable. */
export function useCommandSubmit(context: MutationContext) {
  const [state, setState] = useState<SubmitState>(idle);
  async function submit(build: () => Record<string, unknown>, onApplied?: (entityId: string) => void): Promise<boolean> {
    // An unconfirmed result leaves its receipt in place, which sets context.blocked until it is checked.
    if (state.busy || context.blocked) return false;
    let command: Command;
    try { command = commandSchema.parse({ ...build(), projectId: context.projectId, operationId: crypto.randomUUID() }); }
    catch (cause) {
      const message = cause instanceof Error && !("issues" in cause) ? cause.message : "有字段没有填写或格式不对，请检查后再保存。";
      setState({ ...idle, message, failed: true }); return false;
    }
    setState({ ...idle, busy: true });
    let recorded = false;
    try { recorded = await context.onAttempt(command); } catch { /* without a saved receipt nothing is sent */ }
    if (!recorded) { setState({ ...idle, message: "浏览器不能保存恢复回执，这次没有提交。", failed: true }); return false; }
    try {
      const result = await api().command(command);
      context.onKnown(command.operationId);
      const outcome = resultOutcome(result);
      setState({ busy: false, message: outcome.message, failed: outcome.failed, stale: outcome.stale, unconfirmed: false });
      if (outcome.applied && result.status === "applied") { onApplied?.(result.entityId); context.onChanged(); return true; }
    } catch (cause) {
      const outcome = errorOutcome(cause);
      if (!outcome.unconfirmed) context.onKnown(command.operationId);
      setState({ busy: false, message: outcome.message, failed: true, stale: outcome.stale, unconfirmed: outcome.unconfirmed });
    }
    return false;
  }
  return { state, submit, reset: () => setState(idle) };
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

/** The frame every discussion form shares: the fields, what happened on the last submit, and one submit button. */
export function CommandFormShell({ label, submitLabel, dirty, state, blocked, versionChanged, onAcceptVersion, onCopyDraft, onReread, onCancel, onSubmit, children }: {
  label: string; submitLabel: string; dirty: boolean; state: SubmitState; blocked: boolean;
  versionChanged?: boolean; onAcceptVersion?: () => void; onCopyDraft?: () => void; onReread?: () => void; onCancel?: () => void;
  onSubmit(): void; children: ReactNode;
}) {
  const handle = (event: FormEvent) => { event.preventDefault(); onSubmit(); };
  const disabled = state.busy || blocked || !!versionChanged;
  return <form aria-label={label} data-dirty={dirty ? "true" : undefined} onSubmit={handle} className="flex flex-col gap-4 rounded-xl bg-muted p-4">
    {children}
    {blocked && <Notice tone="waiting">本项目还有结果未确认的操作。先在“结果未知的操作”里按原操作核对，再保存这里的内容。</Notice>}
    {versionChanged && <Notice tone="waiting" title="讨论在你填写时更新了" action={onAcceptVersion && <Button size="compact" onClick={onAcceptVersion}>已核对，继续</Button>}>
      输入仍保留。先看上方读回的新内容，确认这份输入仍然适用，再继续保存。</Notice>}
    {state.message && <Notice tone={state.failed ? "error" : "info"} action={state.stale && <div className="flex flex-col gap-1.5">
      {onCopyDraft && <Button size="compact" onClick={onCopyDraft}>复制草稿</Button>}
      {onReread && <Button size="compact" variant="ghost" onClick={onReread}>重新读取</Button>}
    </div>}>{state.message}</Notice>}
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
