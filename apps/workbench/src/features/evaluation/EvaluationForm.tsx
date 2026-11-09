// One evaluation write, drawn with @evoloop/ui and kept to the same safety as the shared ActionForm: the operation ID
// is saved as a recovery receipt before anything is sent; an unconfirmed result keeps that receipt and the draft; a
// changed version or fixed pointer stops submission until the draft is saved and the form is rebuilt from a reread.
// Drafts live in the same memory-only store as ActionForm, so leaving the project or signing out clears them.
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { commandSchema, type Command } from "@evoloop/contracts";
import { Button, Field, Input, Notice, Textarea, cn } from "@evoloop/ui";
import { api, isUnconfirmed } from "../../shared/api";
import { commandDrafts, readableDraft, type Field as FieldSpec, type MutationContext } from "../../shared/ActionForm";
import { errorOutcome, resultOutcome } from "../../shared/submissionOutcome";

export const selectClass = "h-9 w-full min-w-0 cursor-pointer rounded-md border-0 bg-field px-3 text-small text-foreground outline-none focus-visible:shadow-[var(--focus-ring)] disabled:opacity-50";
const cjk = /[㐀-鿿]/;

export interface EvaluationFormProps {
  context: MutationContext; title: string; fields: FieldSpec[];
  build(values: Record<string, string>): Record<string, unknown>;
  /** Writes in evaluations need the review permission, as before. */
  review?: boolean;
  onApplied?: (result: { entityId: string; revisionId?: string }) => void;
  /** Shown above the fields. */
  intro?: ReactNode;
  /** When set, submission is paused and this says why (for example a reread that failed). */
  hold?: string | undefined;
  /** Collapsed behind its title until opened (the default), or always open inside its section. */
  collapsible?: boolean;
}

export function EvaluationForm({ context, title, fields, build, review = false, onApplied, intro, hold, collapsible = true }: EvaluationFormProps) {
  const initial = () => Object.fromEntries(fields.map(f => [f.name, f.value ?? (f.kind === "multi" ? "[]" : "")]));
  const draftKey = context.draftScope ? `${context.principal.actorId}:${context.projectId}:${context.draftScope}:${title}` : null;
  const saved = draftKey ? commandDrafts.get(draftKey) : undefined;
  const [values, setValues] = useState<Record<string, string>>(() => saved?.values ?? initial());
  const [dirty, setDirty] = useState(!!saved);
  const [readBaseline, setReadBaseline] = useState(saved?.baseline ?? context.draftBaseline);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [failed, setFailed] = useState(false);
  const [stale, setStale] = useState(false);
  const [draftSaved, setDraftSaved] = useState(false);
  const [copyFallback, setCopyFallback] = useState(false);
  // A form rebuilt around a kept draft (for example after the task version changed) opens, so its notice is seen.
  const [startOpen] = useState(!!saved);
  const allowed = context.principal.permissions.includes(review ? "review" : "write");
  const baselineChanged = dirty && readBaseline !== context.draftBaseline;
  const stopped = busy || !allowed || context.blocked || stale || baselineChanged || !!hold;
  useEffect(() => {
    if (dirty) return;
    setValues(initial()); setReadBaseline(context.draftBaseline);
  }, [context.draftBaseline]); // eslint-disable-line react-hooks/exhaustive-deps

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (stopped) return;
    setMessage(""); setFailed(false);
    const missing = fields.find(field => field.kind === "multi" && !field.optional && !(JSON.parse(values[field.name] || "[]") as string[]).length);
    if (missing) { setMessage(`请至少选择一项：${missing.label}。`); setFailed(true); return; }
    let candidate: Record<string, unknown>;
    try { candidate = { ...build(values), projectId: context.projectId, operationId: crypto.randomUUID() }; }
    catch (cause) {
      // Field parsers explain themselves in Chinese; anything else stays the general hint.
      const text = cause instanceof Error && cjk.test(cause.message) ? cause.message : "请补全必需字段并检查输入格式。";
      setMessage(text); setFailed(true); return;
    }
    let command: Command;
    try { command = commandSchema.parse(candidate); }
    catch { setMessage("请补全必需字段并检查输入格式。"); setFailed(true); return; }
    setBusy(true);
    let recorded = false;
    try { recorded = await context.onAttempt(command); }
    catch { /* A receipt that could not be saved must never send its command. */ }
    if (!recorded) { setBusy(false); setMessage("浏览器不能保存恢复回执，本次尚未提交。"); setFailed(true); return; }
    try {
      const result = await api().command(command);
      context.onKnown(command.operationId);
      const outcome = resultOutcome(result);
      setMessage(outcome.message); setFailed(outcome.failed); setStale(outcome.stale);
      if (outcome.applied && result.status === "applied") {
        if (draftKey) commandDrafts.delete(draftKey);
        setDirty(false);
        onApplied?.(result); context.onChanged();
      }
    } catch (cause) {
      if (!isUnconfirmed(cause)) context.onKnown(command.operationId);
      const outcome = errorOutcome(cause);
      setMessage(outcome.message); setFailed(true);
      if (outcome.stale) setStale(true);
    } finally { setBusy(false); }
  }
  async function copyDraft() {
    const draft = readableDraft(title, fields, values);
    try { await navigator.clipboard.writeText(draft); setDraftSaved(true); setCopyFallback(false); }
    catch { setCopyFallback(true); setDraftSaved(false); }
  }
  function updateValue(name: string, value: string) {
    setValues(current => {
      const next = { ...current, [name]: value };
      if (draftKey) commandDrafts.set(draftKey, { values: next, baseline: readBaseline });
      return next;
    });
    setDirty(true);
    setDraftSaved(false);
  }
  const renderField = (field: FieldSpec) => {
    if (field.kind === "multi") {
      const chosen = JSON.parse(values[field.name] || "[]") as string[];
      return <fieldset key={field.name} className="m-0 flex min-w-0 flex-col gap-1.5 border-0 p-0">
        <legend className="mb-1.5 p-0 text-label font-semibold text-foreground">{field.label}</legend>
        {field.options?.length ? field.options.map(item => <label key={item.value} className="flex min-w-0 items-start gap-2 text-small text-foreground">
          <input type="checkbox" name={field.name} value={item.value} checked={chosen.includes(item.value)} className="mt-1 size-4 shrink-0 accent-primary"
            onChange={event => updateValue(field.name, JSON.stringify(event.target.checked ? [...chosen, item.value] : chosen.filter(value => value !== item.value)))} />
          <span className="min-w-0 break-words">{item.label}</span>
        </label>) : <p className="m-0 text-caption text-muted-foreground">没有可选项。</p>}
        {field.hint && <p className="m-0 text-caption text-muted-foreground">{field.hint}</p>}
      </fieldset>;
    }
    return <Field key={field.name} label={field.label} hint={field.hint}>{control => field.kind === "textarea"
      ? <Textarea {...control} name={field.name} autoComplete="off" required={!field.optional} value={values[field.name]} placeholder={field.placeholder}
        onChange={event => updateValue(field.name, event.target.value)} />
      : field.kind === "select"
        ? <select {...control} name={field.name} required={!field.optional} value={values[field.name]} className={selectClass} onChange={event => updateValue(field.name, event.target.value)}>
          <option value="">请选择</option>{field.options?.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}
        </select>
        : <Input {...control} name={field.name} autoComplete="off" required={!field.optional} value={values[field.name]} placeholder={field.placeholder}
          onChange={event => updateValue(field.name, event.target.value)} />}</Field>;
  };
  const form = <form className="flex min-w-0 flex-col gap-4" data-dirty={dirty ? "true" : undefined} onSubmit={submit} aria-label={title}>
    {intro}
    {fields.filter(field => !field.advanced).map(renderField)}
    {fields.some(field => field.advanced) && <details className="text-small"><summary className="cursor-pointer text-text-secondary">高级选项</summary>
      <div className="mt-3 flex flex-col gap-4">{fields.filter(field => field.advanced).map(renderField)}</div></details>}
    {!allowed && <Notice>当前身份没有{review ? "审阅" : "写入"}权限。</Notice>}
    {context.blocked && <Notice tone="waiting">本项目仍有结果未确认的操作，请先核对上方回执。</Notice>}
    {hold && <Notice tone="waiting">{hold}</Notice>}
    {message && <Notice tone={failed ? "error" : "info"}>{message}</Notice>}
    {(stale || baselineChanged) && <Notice tone="error" title="当前版本或固定指针已经变化">
      <p className="m-0">输入仍保留，不能按新版本直接提交；请先保存完整草稿，再核对当前基线。</p>
      <div className="mt-2 flex flex-wrap gap-2">
        <Button size="compact" onClick={() => void copyDraft()}>复制当前草稿</Button>
        <Button size="compact" disabled={!draftSaved} onClick={() => {
          if (draftKey) commandDrafts.delete(draftKey);
          setDirty(false); setStale(false); setValues(initial()); setReadBaseline(context.draftBaseline); context.onChanged();
        }}>回读当前状态（重建表单）</Button>
      </div>
      {draftSaved && <p className="m-0 mt-2">草稿已复制或由你确认手动保存，可以回读后对照新基线重填。</p>}
      {copyFallback && <div className="mt-2 flex flex-col gap-2"><p className="m-0">剪贴板不可用。请选择并手动复制下方全部字段，再确认保存。</p>
        <Textarea readOnly aria-label="完整草稿" value={readableDraft(title, fields, values)} onFocus={event => event.currentTarget.select()} rows={12} />
        <Button size="compact" className="w-fit" onClick={() => setDraftSaved(true)}>我已手动保存完整草稿</Button></div>}
    </Notice>}
    <Button type="submit" variant="primary" className="w-fit" disabled={stopped}>{busy ? "保存中…" : title}</Button>
  </form>;
  if (!collapsible) return form;
  return <details className="group min-w-0 rounded-xl bg-raised shadow-sm" data-dirty={dirty ? "true" : undefined} open={startOpen || undefined}>
    <summary className={cn("cursor-pointer rounded-xl px-4 py-3 text-small font-medium text-foreground outline-none focus-visible:shadow-[var(--focus-ring)]")}>{title}</summary>
    <div className="border-t border-border px-4 pb-4 pt-3">{form}</div>
  </details>;
}
