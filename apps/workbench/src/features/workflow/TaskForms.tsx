// The parts the task page's tabs share: a titled section, a collapsible action row, one command form on
// @evoloop/ui with useCommand's baseline guard, and what a read that is pending or failed may say.
import React, { type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { Button, ErrorState, Field, Input, LoadingState, Notice, RefreshingIndicator, Select, Textarea, cn } from "@evoloop/ui";
import { errorText } from "../../shared/api";
import type { MutationContext } from "../../shared/ActionForm";
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

/**
 * One command as a form. It records `baseline` when it opens; the command is built from that record. A changed
 * baseline stops the submit until the person has looked at the latest content (keeping or refilling the input).
 */
export function CommandForm<B extends Baseline>({ context, title, submitLabel, fields, baseline, build, options, onApplied, notes, children, danger, label }: {
  context: MutationContext; title?: string; submitLabel: string; fields: FormField[]; baseline: B;
  build(values: Record<string, string>, seen: B): Record<string, unknown>; options?: CommandOptions;
  onApplied?(): void; notes?: ReactNode; children?: ReactNode; danger?: boolean; label?: string;
}) {
  const block = React.useContext(TaskWriteBlock);
  const command = useCommand(context, baseline, options);
  const initials = initialValues(fields);
  const initialKey = JSON.stringify(initials);
  // `base` is what the fields were last filled with; the form is dirty once the person changed any of it.
  const [form, setForm] = React.useState({ base: initials, values: initials });
  const values = form.values;
  const edited = (state: typeof form) => Object.keys({ ...state.base, ...state.values }).some(key => (state.values[key] ?? "") !== (state.base[key] ?? ""));
  const dirty = edited(form);
  const setValues = (next: Record<string, string>) => setForm({ base: next, values: next });
  // Untouched fields follow the latest read; edited ones are kept until the person decides.
  React.useEffect(() => { setForm(current => edited(current) ? current : { base: initials, values: initials }); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [initialKey]);
  const missing = fields.some(field => !field.optional && !(values[field.name] ?? "").trim());
  const blocked = !!block || context.blocked;
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (missing || blocked) return;
    const applied = await command.submit(seen => build(values, seen));
    if (applied) { setValues(initials); onApplied?.(); }
  }
  const set = (name: string, value: string) => setForm(current => ({ ...current, values: { ...current.values, [name]: value } }));
  return <form onSubmit={submit} aria-label={label ?? title ?? submitLabel} data-dirty={dirty ? "true" : undefined} className="flex flex-col gap-3 rounded-lg bg-muted p-4">
    {title && <h3 className="text-small font-semibold text-foreground">{title}</h3>}
    {notes}
    {fields.map(field => <FieldControl key={field.name} field={field} value={values[field.name] ?? ""} onChange={value => set(field.name, value)} />)}
    {children}
    {command.baselineChanged && <Notice tone="waiting" title="打开表单后内容已被更新" action={<span className="flex flex-col gap-1.5">
      <Button size="compact" onClick={() => { command.rebase(); setValues(initials); }}>按最新内容重填</Button>
      <Button size="compact" variant="ghost" onClick={() => command.rebase()}>保留我的输入</Button></span>}>
      {baselineChangedText}</Notice>}
    {command.outcome && !command.baselineChanged && <Notice tone={command.outcome.failed ? "error" : "info"}>{command.outcome.message}</Notice>}
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

interface QueryLike<T> { data: T | undefined; error: unknown; isPending: boolean; isFetching: boolean; refetch(): unknown }

/**
 * What a read may show besides its data: the first read is pending, a failed first read cannot tell anything, a
 * failed reread keeps the last answer marked as such. Returns null when the data can be shown as current.
 */
export function ReadNote<T>({ read, what, lines = 3 }: { read: QueryLike<T>; what: string; lines?: number }) {
  const retry = <Button size="compact" disabled={read.isFetching} onClick={() => void read.refetch()}>重新读取</Button>;
  if (read.isPending && !read.error) return <LoadingState lines={lines} label={`正在读取${what}`} />;
  if (read.error && read.data === undefined) return <ErrorState title={`${what}暂不可读取`} happened={errorText(read.error)}
    next="可以重新读取；读取失败不代表没有记录。" action={retry} />;
  if (read.error) return <Notice tone="waiting" title="上次读回，当前待核对" action={retry}>重新读取{what}失败：{errorText(read.error)}。下面是上次读回的内容。</Notice>;
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
