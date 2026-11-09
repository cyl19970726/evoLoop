// The parts the task page's tabs share: a titled section, a collapsible action row, one command form on
// @evoloop/ui with useCommand's baseline guard, and what a read that is pending or failed may say.
import React, { type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { Button, ErrorState, Field, Input, LoadingState, Notice, RefreshingIndicator, Select, Textarea, cn } from "@evoloop/ui";
import { errorText } from "../../shared/api";
import type { MutationContext } from "../../shared/ActionForm";
import type { SubmissionOutcome } from "../../shared/submissionOutcome";
import { readStanding } from "../../shared/query";
import { baselineChangedText, useCommand, type Baseline, type CommandOptions } from "./useCommand";

/** Why the task page may not write right now (a historical revision, a reread, an unconfirmed operation), or "". */
export const TaskWriteBlock = React.createContext("");

export function TabSection({ title, meta, action, children, id, className }: {
  title: string; meta?: ReactNode; action?: ReactNode; children: ReactNode; id?: string; className?: string;
}) {
  const headingId = React.useId();
  return <section id={id} aria-labelledby={headingId} className={cn("flex scroll-mt-20 flex-col gap-3", className)}>
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <h2 id={headingId} className="text-heading font-semibold text-foreground">{title}</h2>
      {meta && <span className="text-caption text-muted-foreground">{meta}</span>}
      {action && <span className="ml-auto flex items-center gap-2">{action}</span>}
    </div>
    {children}
  </section>;
}

/**
 * One action or record that opens in place: a title, a muted line under it, and its content when open. The content
 * mounts the first time the row opens, so a form records its baseline when the person opens it, not when the page
 * loaded; closing the row keeps the draft and that baseline for as long as the page lives (a changed baseline then
 * refuses the submit). Drafts are not kept across a reload or another project.
 */
export function ActionRow({ title, description, children, defaultOpen = false, id, dirty, trailing }: {
  title: ReactNode; description?: ReactNode; children: ReactNode; defaultOpen?: boolean; id?: string; dirty?: boolean; trailing?: ReactNode;
}) {
  const [open, setOpen] = React.useState(defaultOpen);
  const [opened, setOpened] = React.useState(defaultOpen);
  return <details id={id} open={open} onToggle={event => { setOpen(event.currentTarget.open); if (event.currentTarget.open) setOpened(true); }} data-dirty={dirty ? "true" : undefined} className="group border-t border-border first:border-t-0">
    <summary className="flex cursor-pointer list-none items-start gap-2 py-3 outline-none focus-visible:shadow-[var(--focus-ring)] [&::-webkit-details-marker]:hidden">
      <ChevronRight aria-hidden="true" className="mt-1 size-3.5 shrink-0 text-muted-foreground transition-transform duration-150 group-open:rotate-90 motion-reduce:transition-none" />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-small font-medium text-foreground">{title}</span>
        {description && <span className="text-caption text-muted-foreground">{description}</span>}
      </span>
      {trailing && <span className="shrink-0">{trailing}</span>}
    </summary>
    {opened && <div className="flex flex-col gap-3 pb-4 pl-[22px]">{children}</div>}
  </details>;
}

export interface FormField {
  name: string; label: string; kind?: "text" | "textarea" | "select" | "datetime" | "radio";
  initial?: string; options?: { value: string; label: string; disabled?: boolean }[];
  optional?: boolean; hint?: string; rows?: number; placeholder?: string; maxLength?: number;
}

const initialValues = (fields: FormField[]) => Object.fromEntries(fields.map(field => [field.name, field.initial ?? ""]));

type Values = Record<string, string>;
/** A form's fields: `base` is what they were last filled with, `values` what is in them now. */
export interface FormState { base: Values; values: Values }

/** The person changed at least one field from what it was filled with. */
export function formDirty(state: FormState): boolean {
  return Object.keys({ ...state.base, ...state.values }).some(key => (state.values[key] ?? "") !== (state.base[key] ?? ""));
}

/** “保留我的修改”: the fields the person changed stay; every other field takes the latest content. */
export function keepEdits(state: FormState, latest: Values): FormState {
  const values = Object.fromEntries(Object.keys(latest).map(key =>
    [key, (state.values[key] ?? "") !== (state.base[key] ?? "") ? state.values[key] ?? "" : latest[key] ?? ""]));
  return { base: latest, values };
}

/**
 * The one rule for a form when newer content arrives (the same as RecordForm on 目标与阶段): a form nobody has typed
 * into follows it, and when its baseline moved it records the new one (`rebase`); a form with changes waits until the
 * person has looked. While a version conflict is being read back, nothing moves. Returns what to do, or null.
 */
export function followLatest(state: FormState, latest: Values, baselineChanged: boolean, awaitingReread: boolean): { state: FormState; rebase: boolean } | null {
  if (formDirty(state) || awaitingReread) return null;
  if (!baselineChanged && JSON.stringify(latest) === JSON.stringify(state.base)) return null;
  return { state: { base: latest, values: latest }, rebase: baselineChanged };
}

/** The notice for a form whose baseline moved: while the latest content is read back it only waits. */
export function BaselineNotice({ awaiting, onReread, onKeep, onRefill, keepLabel = "保留我的修改", keepNote }: {
  awaiting: boolean; onReread(): void; onKeep(): void; onRefill(): void; keepLabel?: string; keepNote?: string;
}) {
  return awaiting
    ? <Notice tone="waiting" data-baseline-changed="" title="版本已变化，正在读回最新内容"
      action={<Button size="compact" variant="ghost" onClick={onReread}>重新读取</Button>}>
      读回后再决定保留修改还是按最新内容重填；修改留在下面，暂不能提交。</Notice>
    : <Notice tone="waiting" data-baseline-changed="" title="打开表单后内容已被更新" action={<span className="flex flex-col gap-1.5">
      <Button size="compact" onClick={onRefill}>按最新内容重填</Button>
      <Button size="compact" variant="ghost" onClick={onKeep}>{keepLabel}</Button></span>}>
      {baselineChangedText}{keepNote ?? "保留我的修改：只保留你改过的部分，其余换成最新内容。"}</Notice>;
}

/** A submission's result, with the service's original answer as 诊断信息 when the message replaced it. */
export function OutcomeNotice({ outcome }: { outcome: SubmissionOutcome }) {
  return <Notice tone={outcome.failed ? "error" : "info"}>{outcome.message}
    {outcome.detail && <details className="mt-1 text-caption text-muted-foreground"><summary className="w-fit cursor-pointer">诊断信息</summary>
      <p className="mt-1 whitespace-pre-wrap [overflow-wrap:anywhere]">{outcome.detail}</p></details>}</Notice>;
}

/**
 * One command as a form. It records `baseline` when it opens; the command is built from that record. Newer content
 * follows `followLatest`; a version conflict rereads (`onStale`, the project by default) before the person decides.
 */
export function CommandForm<B extends Baseline>({ context, title, submitLabel, fields, baseline, build, options, onApplied, notes, children, danger, label }: {
  context: MutationContext; title?: string; submitLabel: string; fields: FormField[]; baseline: B;
  build(values: Record<string, string>, seen: B): Record<string, unknown>; options?: CommandOptions;
  onApplied?(): void; notes?: ReactNode; children?: ReactNode; danger?: boolean; label?: string;
}) {
  const block = React.useContext(TaskWriteBlock);
  const reread = options?.onStale ?? context.onChanged;
  const command = useCommand(context, baseline, { ...options, onStale: reread });
  const initials = initialValues(fields);
  const initialKey = JSON.stringify(initials);
  const [form, setForm] = React.useState<FormState>({ base: initials, values: initials });
  const [saved, setSaved] = React.useState(false);
  const values = form.values;
  const dirty = formDirty(form);
  React.useEffect(() => {
    const next = followLatest(form, initials, command.baselineChanged, command.awaitingReread);
    if (!next) return;
    if (next.rebase) command.rebase();
    setForm(next.state);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialKey, command.baselineChanged, command.awaitingReread, dirty]);
  const missing = fields.some(field => !field.optional && !(values[field.name] ?? "").trim());
  const blocked = !!block || context.blocked;
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (missing || blocked) return;
    setSaved(false);
    const applied = await command.submit(seen => build(values, seen));
    // The fields go back to untouched; when the write is read back, the form follows it.
    if (applied) { setForm({ base: initials, values: initials }); setSaved(true); onApplied?.(); }
  }
  const set = (name: string, value: string) => { setSaved(false); setForm(current => ({ ...current, values: { ...current.values, [name]: value } })); };
  return <form onSubmit={submit} aria-label={label ?? title ?? submitLabel} data-dirty={dirty ? "true" : undefined} className="flex flex-col gap-3 rounded-lg bg-muted p-4">
    {title && <h3 className="text-small font-semibold text-foreground">{title}</h3>}
    {notes}
    {fields.map(field => <FieldControl key={field.name} field={field} value={values[field.name] ?? ""} onChange={value => set(field.name, value)} />)}
    {children}
    {command.baselineChanged && <BaselineNotice awaiting={command.awaitingReread} onReread={reread}
      onKeep={() => { command.rebase(); setForm(keepEdits(form, initials)); }}
      onRefill={() => { command.rebase(); setForm({ base: initials, values: initials }); }} />}
    {command.outcome && !(command.baselineChanged && command.outcome.stale) && <OutcomeNotice outcome={command.outcome} />}
    {saved && !command.outcome && <p role="status" className="text-caption text-muted-foreground">已保存，上面已是读回的最新内容。</p>}
    {blocked && <p className="text-caption text-muted-foreground">暂不能提交：{block || "本项目还有结果未确认的操作，请先按原操作 ID 核对。"}</p>}
    <div className="flex flex-wrap gap-2">
      <Button type="submit" variant={danger ? "danger" : "primary"} size="compact" disabled={blocked || command.busy || command.baselineChanged || missing}>
        {command.busy ? "正在提交…" : submitLabel}</Button>
    </div>
  </form>;
}

function FieldControl({ field, value, onChange }: { field: FormField; value: string; onChange(value: string): void }) {
  const label = field.optional ? `${field.label}（可选）` : field.label;
  if (field.kind === "radio") return <fieldset className="flex flex-col gap-1.5">
    <legend className="mb-1 text-label font-semibold text-foreground">{label}</legend>
    {field.options?.map(option => <label key={option.value} className="flex items-center gap-2 text-label text-foreground">
      <input type="radio" name={field.name} value={option.value} checked={value === option.value} onChange={() => onChange(option.value)} className="accent-[var(--accent)]" />
      {option.label}</label>)}
    {field.hint && <p className="text-caption text-muted-foreground">{field.hint}</p>}
  </fieldset>;
  return <Field label={label} hint={field.hint}>{control => field.kind === "textarea"
    ? <Textarea {...control} name={field.name} value={value} required={!field.optional} rows={field.rows ?? 3} maxLength={field.maxLength ?? 4000}
      placeholder={field.placeholder} onChange={event => onChange(event.target.value)} />
    : field.kind === "select" ? <Select {...control} name={field.name} value={value} required={!field.optional} onChange={event => onChange(event.target.value)} className="w-full">
      {(field.optional || !field.options?.some(option => option.value === value)) && <option value="">{field.optional ? "不设置" : "请选择"}</option>}
      {field.options?.map(option => <option key={option.value} value={option.value} disabled={option.disabled}>{option.label}</option>)}
    </Select>
      : <Input {...control} name={field.name} type={field.kind === "datetime" ? "datetime-local" : "text"} value={value} required={!field.optional}
        maxLength={field.maxLength} placeholder={field.placeholder} autoComplete="off" onChange={event => onChange(event.target.value)} />}</Field>;
}

export const reasonField = (label = "理由与依据", hint?: string): FormField => ({ name: "reason", label, kind: "textarea", ...(hint ? { hint } : {}) });

interface QueryLike<T> { data: T | undefined; error: unknown; isPending: boolean; isFetching: boolean; isPlaceholderData?: boolean; refetch(): unknown }

/** Whether a read can be shown as current: answered, and its last reread did not fail. */
export function readCurrent<T>(read: Pick<QueryLike<T>, "data" | "error">): boolean {
  return read.data !== undefined && !read.error;
}

/**
 * What a read may show besides its data (readStanding): the first read is pending, a failed first read cannot tell
 * anything, a failed reread keeps the same key's last answer marked 上次读回. Returns null when the data is current.
 */
export function ReadNote<T>({ read, what, lines = 3 }: { read: QueryLike<T>; what: string; lines?: number }) {
  const retry = <Button size="compact" disabled={read.isFetching} onClick={() => void read.refetch()}>重新读取</Button>;
  const standing = readStanding({ data: read.data, isError: !!read.error, isPlaceholderData: !!read.isPlaceholderData });
  if (read.isPending && !read.error) return <LoadingState lines={lines} label={`正在读取${what}`} />;
  if (standing.failed) return <ErrorState title={`${what}暂不可读取`} happened={errorText(read.error)}
    next="可以重新读取；读取失败不代表没有记录。" action={retry} />;
  if (standing.stale) return <Notice tone="waiting" title="上次读回，当前待核对" action={retry}>重新读取{what}失败：{errorText(read.error)}。下面是上次读回的内容。</Notice>;
  if (standing.previous) return <RefreshingIndicator label={`正在读取${what}`} />;
  if (read.isFetching && read.data !== undefined) return <RefreshingIndicator label={`正在核对${what}`} />;
  return null;
}

/** A label above a value, in plain blocks (the old global sheet still lays out every `dl > div` as a grid). */
export function Fact({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return <div role="group" aria-label={label} className={cn("flex min-w-0 flex-col gap-0.5", className)}>
    <p className="text-caption text-muted-foreground">{label}</p>
    <div className="text-label text-foreground [overflow-wrap:anywhere]">{children}</div>
  </div>;
}

/** A short muted line. */
export function Fine({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cn("text-caption text-muted-foreground", className)}>{children}</p>;
}
