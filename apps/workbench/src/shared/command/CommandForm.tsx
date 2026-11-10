// The one command form (docs/frontend/components.md, “提交表单”). CommandFrame draws what every form shows around its
// fields: why it cannot send now, the baseline that moved (keep the fields the person changed, or refill from the
// latest content), an unknown result and its check by the original operation ID, the outcome with 诊断信息, and the
// submit button. CommandForm is a frame with a list of fields; a form with its own field layout (分工讨论) uses the
// frame with useCommand directly.
import * as React from "react";
import type { ReactNode } from "react";
import type { AppliedResult, Permission } from "@evoloop/contracts";
import { Button, Field, Input, Notice, Select, Textarea, cn } from "@evoloop/ui";
import type { SubmissionOutcome } from "../submissionOutcome";
import type { MutationContext } from "./context";
import { readableDraft } from "./drafts";
import {
  baselineChangedText, blockedText, conflictingFields, contentMoved, followLatest, formDirty, keepEdits, movedFields, overLimitText, permissionText, restoredFormState,
  unconfirmedNote, unconfirmedTitle, type Baseline, type FormState,
} from "./rules";
import { useCommand, type CommandOptions } from "./useCommand";

/** Why the forms in this region may not write right now (a historical revision, a reread), or "". */
export const CommandBlock = React.createContext("");

/** A submission's result, with the service's original answer as 诊断信息 when the message replaced it. */
export function OutcomeNotice({ outcome }: { outcome: SubmissionOutcome }) {
  return <Notice tone={outcome.failed ? "error" : "info"}>{outcome.message}
    {outcome.detail && <Diagnostic detail={outcome.detail} />}</Notice>;
}

function Diagnostic({ detail }: { detail: string }) {
  return <details className="mt-1 text-caption text-muted-foreground"><summary className="w-fit cursor-pointer">诊断信息</summary>
    <p className="mt-1 whitespace-pre-wrap [overflow-wrap:anywhere]">{detail}</p></details>;
}

/** A field both the person and someone else changed: the person chooses which text it keeps. */
export interface FieldConflict { name: string; label: string }
export type ConflictChoices = Record<string, "mine" | "latest">;

/**
 * The notice for a form whose baseline moved. While a version conflict is read back it waits (refilling from the
 * latest content is always possible); then the person keeps their changes or refills. Changes are kept only where
 * nobody else changed the same field: a field both changed (`conflicts`) is decided field by field. Refilling drops
 * the person's input, so it asks once more and offers the copy first. `copy` gives the draft as text; when the
 * clipboard is not available, the text is shown for a manual copy.
 */
export function BaselineNotice({ awaiting, onReread, onKeep, onRefill, onResolve, conflicts = [], keepLabel = "保留我的修改", keepNote, changed = [], copy, rereading, title }: {
  awaiting: boolean; onReread(): void; onKeep(): void; onRefill(): void; onResolve?: ((choices: ConflictChoices) => void) | undefined;
  conflicts?: readonly FieldConflict[] | undefined; keepLabel?: string | undefined; keepNote?: string | undefined;
  changed?: readonly string[] | undefined; copy?: (() => string) | undefined; rereading?: boolean | undefined; title?: string | undefined;
}) {
  const [copied, setCopied] = React.useState<"no" | "yes" | "manual">("no");
  const [confirming, setConfirming] = React.useState(false);
  const [choices, setChoices] = React.useState<ConflictChoices>({});
  const name = React.useId();
  const copyDraft = async () => {
    try { await navigator.clipboard.writeText(copy!()); setCopied("yes"); } catch { setCopied("manual"); }
  };
  const parts = changed.length ? `变化的是：${changed.join("、")}。` : "";
  const copyButton = copy && <Button size="compact" variant="ghost" onClick={() => void copyDraft()}>{copied === "yes" ? "草稿已复制" : "复制当前草稿"}</Button>;
  const manual = copy && copied === "manual" && <span className="mt-2 flex flex-col gap-1.5">
    <span className="text-caption">剪贴板不可用。请选择并手动复制下面的全部字段。</span>
    <Textarea readOnly aria-label="完整草稿" value={copy()} rows={8} onFocus={event => event.currentTarget.select()} /></span>;
  // Refilling drops the person's input: one more click to confirm, with the copy right beside it.
  const refill = confirming
    ? <span className="flex flex-col items-start gap-1.5" role="group" aria-label="确认按最新内容重填">
      <Button size="compact" variant="danger" onClick={() => { setConfirming(false); onRefill(); }}>丢弃修改并重填</Button>
      <Button size="compact" variant="ghost" onClick={() => setConfirming(false)}>先不重填</Button></span>
    : <Button size="compact" variant="ghost" disabled={rereading} onClick={() => setConfirming(true)}>按最新内容重填</Button>;
  const confirmNote = confirming && <p className="mt-1 font-medium text-foreground">重填会丢掉你在这张表单里的全部修改；需要的话先复制草稿。</p>;
  if (awaiting) return <Notice tone="waiting" data-baseline-changed="" title="版本已变化，正在读回最新内容" action={<span className="flex flex-col items-start gap-1.5">
    <Button size="compact" disabled={rereading} onClick={onReread}>{rereading ? "正在重新读取…" : "重新读取"}</Button>{refill}{copyButton}</span>}>
    读回后再决定保留修改还是按最新内容重填；修改留在下面，暂不能提交。{parts}{confirmNote}{manual}</Notice>;
  const decided = conflicts.every(conflict => choices[conflict.name]);
  return <Notice tone="waiting" data-baseline-changed="" title={title ?? "打开表单后内容已被更新"} action={<span className="flex flex-col items-start gap-1.5">
    {conflicts.length
      ? <Button size="compact" disabled={rereading || !decided} onClick={() => onResolve?.(choices)}>按所选继续</Button>
      : <Button size="compact" disabled={rereading} onClick={onKeep}>{keepLabel}</Button>}
    {refill}{copyButton}</span>}>
    {baselineChangedText}{parts}
    {conflicts.length
      ? <span className="mt-2 flex flex-col gap-2">
        <span>这些字段你改过，打开表单后别人也改了。保留你的文字会覆盖别人的修改，请逐项选择；只有你改过的其他字段照旧保留。</span>
        {conflicts.map(conflict => <span key={conflict.name} role="radiogroup" aria-label={`${conflict.label}用哪一版`} className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <span className="font-medium text-foreground">{conflict.label}</span>
          {(["latest", "mine"] as const).map(choice => <label key={choice} className="flex items-center gap-1.5">
            <input type="radio" name={`${name}-${conflict.name}`} checked={choices[conflict.name] === choice} className="accent-[var(--accent)]"
              onChange={() => setChoices(current => ({ ...current, [conflict.name]: choice }))} />
            {choice === "latest" ? "用最新内容" : "用我的版本（覆盖别人的修改）"}</label>)}
        </span>)}</span>
      : keepNote ?? "保留我的修改：只保留你改过的部分，其余换成最新内容。"}
    {confirmNote}{manual}</Notice>;
}

/** The part of useCommand the frame reads. */
export interface CommandView {
  busy: boolean; outcome: SubmissionOutcome | null; baselineChanged: boolean; awaitingReread: boolean;
  unconfirmed: boolean; checking: boolean; changed: string[]; readBack(): Promise<void>;
}

export interface CommandFrameProps {
  context: MutationContext; command: CommandView;
  /** The form's accessible name. */
  label: string; submitLabel: string;
  /** The person changed something (marks the page as having unsaved input). */
  dirty: boolean;
  /** Called on submit when sending is possible; the form validates its fields and calls `command.submit`. */
  onSubmit(): void;
  /** “保留我的修改” and “按最新内容重填”; both record the latest baseline (`command.rebase`). */
  onKeep(): void; onRefill(): void;
  /** Rereads the latest content (the form's `onStale`; the project by default). */
  onReread?: (() => void) | undefined;
  keepLabel?: string | undefined; keepNote?: string | undefined;
  /** The title of the notice when the baseline moved (a draft kept from an earlier mount says so). */
  baselineTitle?: string | undefined;
  /** The content the form was filled with moved while the person was typing (no baseline part changed). */
  moved?: boolean | undefined;
  /** The readable names of the fields whose latest content moved, for “变化的是：…”. */
  changedFields?: readonly string[] | undefined;
  /** Fields both the person and someone else changed; with them, keeping is decided field by field (`onResolve`). */
  conflicts?: readonly FieldConflict[] | undefined;
  onResolve?: ((choices: ConflictChoices) => void) | undefined;
  /** The permissions needed to send (write by default). */
  permission?: Permission | readonly Permission[] | undefined;
  /** Why sending waits (the content on screen is being checked), or nothing. */
  paused?: string | null | undefined;
  danger?: boolean | undefined;
  /** The last write was applied and read back. */
  saved?: boolean | undefined;
  /** The draft as text, offered for copying when the baseline moved. */
  copy?: (() => string) | undefined;
  /** A reread is in flight (keeping or refilling waits for it). */
  rereading?: boolean | undefined;
  onCancel?: (() => void) | undefined; cancelLabel?: string | undefined;
  /** More buttons beside the submit button (清空草稿). */
  actions?: ReactNode;
  /** `muted`: the form is its own grey block (the default); `plain`: it sits in a block that is already drawn. */
  surface?: "muted" | "plain" | undefined;
  /** `inline`: one growing field with the button beside it (a message composer). */
  layout?: "stack" | "inline" | undefined;
  submitOnModEnter?: boolean | undefined;
  className?: string | undefined;
  children: ReactNode;
}

export function CommandFrame({ context, command, label, submitLabel, dirty, onSubmit, onKeep, onRefill, onReread, keepLabel, keepNote, baselineTitle, moved = false,
  changedFields = [], conflicts, onResolve,
  permission = "write", paused, danger, saved, copy, rereading, onCancel, cancelLabel = "收起", actions, surface = "muted", layout = "stack", submitOnModEnter, className, children }: CommandFrameProps) {
  const block = React.useContext(CommandBlock);
  const needed: readonly Permission[] = typeof permission === "string" ? [permission] : permission;
  const denied = permissionText(context.principal.permissions, needed);
  const blocked = !!block || context.blocked;
  const changed = command.baselineChanged || moved;
  const disabled = !!denied || blocked || command.busy || changed || command.unconfirmed || !!paused;
  const reread = onReread ?? context.onChanged;
  const submitButton = <Button type="submit" variant={danger ? "danger" : "primary"} size={layout === "inline" ? "default" : "compact"} disabled={disabled}
    className="shrink-0">{command.busy ? "正在提交…" : submitLabel}</Button>;
  const notices = <>
    {paused && <Notice tone="waiting">{paused}</Notice>}
    {denied && <p className="text-caption text-muted-foreground">{denied}</p>}
    {blocked && <p className="text-caption text-muted-foreground">{block ? `暂不能提交：${block}` : blockedText}</p>}
    {changed && <BaselineNotice awaiting={command.awaitingReread} onReread={reread} onKeep={onKeep} onRefill={onRefill} keepLabel={keepLabel}
      keepNote={keepNote} changed={[...new Set([...command.changed, ...changedFields])]} copy={copy} rereading={rereading || !!paused} title={baselineTitle}
      conflicts={conflicts} onResolve={onResolve} />}
    {command.unconfirmed && <Notice tone="waiting" title={unconfirmedTitle} action={!context.blocked &&
      <Button size="compact" disabled={command.checking} onClick={() => void command.readBack()}>{command.checking ? "正在核对…" : "按原操作核对"}</Button>}>
      {command.outcome?.unconfirmed ? command.outcome.message : `请在上方按原操作 ID 核对，确认前不要再次提交。${unconfirmedNote}`}
      {command.outcome?.unconfirmed && command.outcome.detail && <Diagnostic detail={command.outcome.detail} />}</Notice>}
    {command.outcome && !command.outcome.unconfirmed && !(changed && command.outcome.stale) && <OutcomeNotice outcome={command.outcome} />}
    {saved && !command.outcome && <p role="status" className="text-caption text-muted-foreground">已保存，上面已是读回的最新内容。</p>}
  </>;
  return <form data-ui="" aria-label={label} data-dirty={dirty ? "true" : undefined} noValidate
    onSubmit={event => { event.preventDefault(); if (!disabled) onSubmit(); }}
    onKeyDown={submitOnModEnter ? event => {
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !command.busy) { event.preventDefault(); event.currentTarget.requestSubmit(); }
    } : undefined}
    className={cn("flex min-w-0 flex-col gap-3", surface === "muted" && "rounded-lg bg-muted p-4", className)}>
    {layout === "inline"
      ? <><div className="flex min-w-0 items-end gap-2"><div className="flex min-w-0 flex-1 flex-col gap-3">{children}</div>{submitButton}</div>{notices}</>
      : <>{children}{notices}<div className="flex flex-wrap items-center gap-2">{submitButton}{actions}
        {onCancel && <Button size="compact" variant="ghost" onClick={onCancel} disabled={command.busy}>{cancelLabel}</Button>}</div></>}
  </form>;
}

/** What a `custom` field draws its control with; the value stays a string the form keeps, drafts and compares. */
export interface CustomControl {
  control: { id: string; "aria-describedby"?: string | undefined; "aria-invalid"?: boolean | undefined };
  value: string; values: Record<string, string>; onChange(value: string): void;
}

export interface FormField {
  name: string; label: string;
  /**
   * `multi`: several choices, kept as a JSON array; `datetime`: a local date and time; `time`: a clock time (HH:mm);
   * `custom`: a control of the page's own (`render`), such as choosing a record by name.
   */
  kind?: "text" | "textarea" | "select" | "multi" | "datetime" | "time" | "radio" | "custom" | undefined;
  /** The control of a `custom` field. */
  render?: ((props: CustomControl) => ReactNode) | undefined;
  /** A line under the field worked out from what is typed now (what a local time becomes, the identifiers chosen). */
  preview?: ((values: Record<string, string>) => ReactNode) | undefined;
  initial?: string | undefined; options?: { value: string; label: string; disabled?: boolean | undefined }[] | undefined;
  optional?: boolean | undefined; hint?: string | undefined; rows?: number | undefined; placeholder?: string | undefined;
  /**
   * The contract's limit, checked before sending with a message (never by cutting the text: the browser's own limit
   * would cut a pasted text without saying so). No limit by default.
   */
  maxLength?: number | undefined;
  /** Folded under “高级选项”. */
  advanced?: boolean | undefined;
  /** One line that grows with its text (a message composer). */
  autoGrow?: boolean | undefined;
}

export function initialValues(fields: readonly FormField[]): Record<string, string> {
  return Object.fromEntries(fields.map(field => [field.name, field.initial ?? (field.kind === "multi" ? "[]" : "")]));
}

const chosen = (value: string): string[] => { try { const list = JSON.parse(value || "[]"); return Array.isArray(list) ? list.map(String) : []; } catch { return []; } };

/** The fields that cannot be sent as they are (an empty required field, a text over its limit), with what to do about each. */
export function missingFields(fields: readonly FormField[], values: Record<string, string>): Record<string, string> {
  return Object.fromEntries(fields.flatMap(field => {
    const value = values[field.name] ?? "";
    const tooLong = field.kind === "multi" ? null : overLimitText(value, field.maxLength);
    if (tooLong)
      return [[field.name, tooLong]];
    if (field.optional) return [];
    if (field.kind === "multi") return chosen(value).length ? [] : [[field.name, "请至少选择一项。"]];
    if (value.trim()) return [];
    const choose = field.kind === "select" || field.kind === "radio" || field.kind === "custom" || field.kind === "datetime" || field.kind === "time";
    return [[field.name, choose ? `请选择${field.label}。` : `请填写${field.label}。`]];
  }));
}

export interface CommandFormProps<B extends Baseline | string | undefined> {
  context: MutationContext; fields: FormField[]; submitLabel: string;
  /** The command's fields from the values and the recorded baseline (never the one on screen now). */
  build(values: Record<string, string>, seen: B): Record<string, unknown>;
  /** A heading inside the form. */
  title?: string | undefined;
  /** The form's accessible name (the title or the submit label by default). */
  label?: string | undefined;
  /** Every fixed input the command depends on, as it was when the form opened. */
  baseline?: B | undefined;
  options?: CommandOptions | undefined;
  onApplied?: ((result: AppliedResult) => void) | undefined;
  /** Shown above the fields; a function receives the form, to offer filling it from elsewhere (an earlier draft). */
  notes?: ReactNode | ((form: FormHandle) => ReactNode);
  children?: ReactNode; danger?: boolean | undefined;
  /** Offer “清空草稿” while the person has changes. */
  clearable?: boolean | undefined;
  permission?: Permission | readonly Permission[] | undefined;
  paused?: string | null | undefined;
  /** Offer to copy the draft as text when the baseline moved. */
  copyable?: boolean | undefined;
  submitOnModEnter?: boolean | undefined;
  surface?: "muted" | "plain" | undefined;
  className?: string | undefined;
}

/** What a form's notes may do with it. */
export interface FormHandle { dirty: boolean; initials: Record<string, string>; fill(values: Record<string, string>): void }

/**
 * One command as a form. It records `baseline` when it opens; the command is built from that record. Newer content
 * follows `followLatest`; a version conflict rereads (`options.onStale`, the project by default) before the person
 * decides. With `options.draft` the typed values are kept between mounts with the baseline they were written on.
 */
export function CommandForm<B extends Baseline | string | undefined = undefined>({ context, fields, submitLabel, build, title, label, baseline, options,
  onApplied, notes, children, danger, clearable, permission, paused, copyable, submitOnModEnter, surface, className }: CommandFormProps<B>) {
  const reread = options?.onStale ?? context.onChanged;
  const initials = initialValues(fields);
  const initialKey = JSON.stringify(initials);
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [saved, setSaved] = React.useState(false);
  const command = useCommand(context, baseline as B, { ...options, onStale: reread, content: initialKey,
    onApplied: result => { setForm({ base: initials, values: initials }); setErrors({}); setSaved(true); options?.onApplied?.(result); onApplied?.(result); } });
  // A draft kept from an earlier mount comes back with the baseline it was written against.
  const [form, setForm] = React.useState<FormState>(() => restoredFormState(command.restoredDraft, initials) ?? { base: initials, values: initials });
  // Until the person has looked, a moved baseline under a restored draft is explained as the draft's age.
  const [fromEarlierMount, setFromEarlierMount] = React.useState(command.restoredDraft !== undefined);
  const dirty = formDirty(form);
  const moved = contentMoved(form, initials);
  React.useEffect(() => {
    const next = followLatest(form, initials, command.baselineChanged, command.awaitingReread);
    if (!next) return;
    if (next.rebase) command.rebase();
    setForm(next.state);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialKey, command.baselineChanged, command.awaitingReread, dirty]);
  // A field set later than it was rendered (a custom control that reads something before it sets its value) starts
  // from the form as it is now, so it never puts back what was typed meanwhile.
  const latestForm = React.useRef(form);
  latestForm.current = form;
  const set = (name: string, value: string) => {
    const now = latestForm.current;
    const next = { ...now, values: { ...now.values, [name]: value } };
    latestForm.current = next;
    setSaved(false); setForm(next); command.saveDraft(next);
    if (errors[name]) setErrors(({ [name]: _, ...rest }) => rest);
  };
  function submit() {
    const problems = missingFields(fields, form.values);
    setErrors(problems);
    if (Object.keys(problems).length) return;
    setSaved(false);
    const values = form.values;
    void command.submit(seen => build(values, seen));
  }
  // Kept only where nobody else changed the same field; a field both changed is decided field by field.
  const keep = (choices = {}) => { const next = keepEdits(form, initials, choices); command.rebase(next); setForm(next); setFromEarlierMount(false); };
  const labelOf = (name: string) => fields.find(field => field.name === name)?.label ?? name;
  const conflicts = conflictingFields(form, initials).map(name => ({ name, label: labelOf(name) }));
  const changedFields = dirty ? movedFields(form, initials).map(labelOf) : [];
  const refill = () => { command.rebase(); command.dropDraft(); setForm({ base: initials, values: initials }); setErrors({}); setFromEarlierMount(false); };
  const clear = () => { command.dropDraft(); setForm({ base: initials, values: initials }); setErrors({}); };
  const fill = (values: Record<string, string>) => { const next = { ...form, values: { ...form.values, ...values } }; setForm(next); command.saveDraft(next); };
  const inline = fields.length > 0 && fields.every(field => field.autoGrow);
  const name = label ?? title ?? submitLabel;
  const control = (field: FormField) => <FieldControl key={field.name} field={field} value={form.values[field.name] ?? ""} values={form.values} error={errors[field.name]}
    hideLabel={inline} onChange={value => set(field.name, value)} />;
  const advanced = fields.filter(field => field.advanced);
  return <CommandFrame context={context} command={command} label={name} submitLabel={submitLabel} dirty={dirty} onSubmit={submit} onKeep={() => keep()}
    onRefill={refill} onReread={reread} moved={moved} permission={permission} paused={paused} danger={danger} saved={saved}
    conflicts={conflicts} onResolve={keep} changedFields={changedFields}
    baselineTitle={fromEarlierMount && !command.outcome ? "这份草稿写于较早的版本" : undefined}
    actions={clearable && dirty && <Button size="compact" variant="ghost" onClick={clear} disabled={command.busy}>清空草稿</Button>}
    copy={copyable ? () => readableDraft(name, fields, form.values) : undefined} surface={surface} layout={inline ? "inline" : "stack"}
    submitOnModEnter={submitOnModEnter} className={className}>
    {title && <h3 className="text-small font-semibold text-foreground">{title}</h3>}
    {typeof notes === "function" ? notes({ dirty, initials, fill }) : notes}
    {fields.filter(field => !field.advanced).map(control)}
    {advanced.length > 0 && <details className="text-small"><summary className="w-fit cursor-pointer text-text-secondary">高级选项</summary>
      <div className="mt-3 flex flex-col gap-3">{advanced.map(control)}</div></details>}
    {children}
  </CommandFrame>;
}

interface FieldProps { field: FormField; value: string; values: Record<string, string>; error?: string | undefined; hideLabel?: boolean | undefined; onChange(value: string): void }

function FieldControl(props: FieldProps) {
  const preview = props.field.preview?.(props.values);
  if (preview === undefined || preview === null || preview === "") return <FieldInput {...props} />;
  return <div className="flex min-w-0 flex-col gap-1.5"><FieldInput {...props} />
    <div role="status" data-field-preview={props.field.name} className="text-caption text-text-secondary [overflow-wrap:anywhere]">{preview}</div></div>;
}

function FieldInput({ field, value, values, error, hideLabel, onChange }: FieldProps) {
  const label = field.optional && !field.label.includes("可选") ? `${field.label}（可选）` : field.label;
  const errorId = React.useId();
  if (field.kind === "radio" || field.kind === "multi") {
    const picked = field.kind === "multi" ? chosen(value) : [];
    return <fieldset className="flex min-w-0 flex-col gap-1.5" aria-describedby={error ? errorId : undefined}>
      <legend className="mb-1 text-label font-semibold text-foreground">{label}</legend>
      {field.options?.length ? field.options.map(option => <label key={option.value} className="flex min-w-0 items-start gap-2 text-label text-foreground">
        {field.kind === "radio"
          ? <input type="radio" name={field.name} value={option.value} checked={value === option.value} disabled={option.disabled} onChange={() => onChange(option.value)} className="mt-1 accent-[var(--accent)]" />
          : <input type="checkbox" name={field.name} value={option.value} checked={picked.includes(option.value)} disabled={option.disabled} className="mt-1 size-4 shrink-0 accent-[var(--accent)]"
            onChange={event => onChange(JSON.stringify(event.target.checked ? [...picked, option.value] : picked.filter(item => item !== option.value)))} />}
        <span className="min-w-0 [overflow-wrap:anywhere]">{option.label}</span></label>)
        : <p className="text-caption text-muted-foreground">没有可选项。</p>}
      {field.hint && <p className="text-caption text-muted-foreground">{field.hint}</p>}
      {error && <p id={errorId} className="text-caption text-destructive">{error}</p>}
    </fieldset>;
  }
  return <Field label={label} hint={field.hint} error={error} className={hideLabel ? "[&>label]:sr-only" : undefined}>{control => field.kind === "custom"
    ? field.render?.({ control, value, values, onChange }) ?? null
    : field.kind === "textarea"
    ? field.autoGrow
      ? <Textarea {...control} name={field.name} value={value} required={!field.optional} rows={1} placeholder={field.placeholder}
        autoComplete="off" className="min-h-10 resize-none" onChange={event => onChange(event.target.value)}
        ref={node => { if (node) { node.style.height = "auto"; node.style.height = `${Math.min(node.scrollHeight, 120)}px`; } }} />
      : <Textarea {...control} name={field.name} value={value} required={!field.optional} rows={field.rows ?? 3}
        placeholder={field.placeholder} autoComplete="off" onChange={event => onChange(event.target.value)} />
    : field.kind === "select" ? <Select {...control} name={field.name} value={value} required={!field.optional} onChange={event => onChange(event.target.value)} className="w-full">
      {(field.optional || !field.options?.some(option => option.value === value)) && <option value="">{field.optional ? "不设置" : "请选择"}</option>}
      {field.options?.map(option => <option key={option.value} value={option.value} disabled={option.disabled}>{option.label}</option>)}
    </Select>
      : <Input {...control} name={field.name} type={field.kind === "datetime" ? "datetime-local" : field.kind === "time" ? "time" : "text"}
        step={field.kind === "datetime" || field.kind === "time" ? (/:\d{2}:\d{2}$/.test(value) ? 1 : 60) : undefined} value={value} required={!field.optional}
        placeholder={field.placeholder} autoComplete="off" onChange={event => onChange(event.target.value)} />}</Field>;
}
