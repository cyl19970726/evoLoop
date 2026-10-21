import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { commandSchema, type Command, type Principal, type Operation } from "@evoloop/contracts";
import { api, errorText, isStaleConflict, isUnconfirmed } from "../api";

export interface RecoverableCommand {
  projectId: string; operationId: string; type: Operation["commandType"];
  taskId?: string; goalId?: string; stageId?: string | null; documentId?: string; discussionId?: string;
}
export interface MutationContext {
  token: string; projectId: string; principal: Principal; blocked: boolean;
  draftScope?: string; draftBaseline?: string;
  onAttempt(command: RecoverableCommand): boolean; onKnown(operationId: string): void; onChanged(): void;
}
// Sensitive form content stays in this authenticated page's memory, never storage.
interface Draft { values: Record<string, string>; baseline?: string }
const drafts = new Map<string, Draft>();
export function clearCommandDrafts() { drafts.clear(); }
export interface Field {
  name: string; label: string; value?: string; kind?: "text" | "textarea" | "select" | "multi";
  options?: { value: string; label: string }[]; optional?: boolean; hint?: string;
}
export function Notice({ children, error = false }: { children: ReactNode; error?: boolean }) {
  return <div className={`notice ${error ? "error" : "info"}`} role={error ? "alert" : "status"}>{children}</div>;
}
export function readableDraft(title: string, fields: Field[], values: Record<string, string>): string {
  return `${title}\n\n${fields.map(field => `${field.label} (${field.name})\n${values[field.name] ?? ""}`).join("\n\n")}`;
}

/** Shared command submission preserves the draft and persists the operation ID before any write. */
export function ActionForm({ context, title, fields, build, review = false, onApplied, initiallyOpen = false }: {
  context: MutationContext; title: string; fields: Field[]; review?: boolean; initiallyOpen?: boolean;
  build(values: Record<string, string>): Record<string, unknown>; onApplied?: (result: { entityId: string; revisionId?: string }) => void;
}) {
  const initial = () => Object.fromEntries(fields.map(f => [f.name, f.value ?? (f.kind === "multi" ? "[]" : "")]));
  const draftKey = context.draftScope ? `${context.principal.actorId}:${context.projectId}:${context.draftScope}:${title}` : null;
  const saved = draftKey ? drafts.get(draftKey) : undefined;
  const [values, setValues] = useState<Record<string, string>>(() => saved?.values ?? initial());
  const [dirty, setDirty] = useState(!!saved);
  const [readBaseline, setReadBaseline] = useState(saved?.baseline ?? context.draftBaseline);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [failed, setFailed] = useState(false);
  const [stale, setStale] = useState(false);
  const [draftSaved, setDraftSaved] = useState(false);
  const [copyFallback, setCopyFallback] = useState(false);
  const allowed = context.principal.permissions.includes(review ? "review" : "write");
  const baselineChanged = dirty && readBaseline !== context.draftBaseline;
  useEffect(() => {
    if (dirty) return;
    setValues(initial()); setReadBaseline(context.draftBaseline);
  }, [context.draftBaseline]);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || !allowed || context.blocked || stale || baselineChanged) return;
    setMessage(""); setFailed(false);
    let command: Command;
    try { command = commandSchema.parse({ ...build(values), projectId: context.projectId, operationId: crypto.randomUUID() }); }
    catch { setMessage("请补全必需字段并检查输入格式。"); setFailed(true); return; }
    if (!context.onAttempt(command)) { setMessage("浏览器不能保存恢复回执，本次尚未提交。"); setFailed(true); return; }
    setBusy(true);
    try {
      const result = await api(context.token).command(command);
      context.onKnown(command.operationId);
      if (result.status === "rejected") {
        setMessage(result.message); setFailed(true); setStale(isStaleConflict(result.code));
      } else {
        if (draftKey) drafts.delete(draftKey);
        setDirty(false);
        setMessage("已保存，正在读取持久记录。");
        onApplied?.(result); context.onChanged();
      }
    } catch (cause) {
      if (!isUnconfirmed(cause)) context.onKnown(command.operationId);
      const unconfirmed = isUnconfirmed(cause);
      const changed = isStaleConflict(cause);
      setMessage(`${errorText(cause)}${unconfirmed ? "。请在上方按原操作 ID 核对，确认前不要再次提交。" : changed
        ? "。所见版本或固定指针已变化；先保存草稿，再回读当前状态。" : "。这次请求已被明确拒绝；草稿保留，可修改选择后以新操作提交。"}`);
      setFailed(true);
      if (!unconfirmed && changed) setStale(true);
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
      if (draftKey) drafts.set(draftKey, { values: next, baseline: readBaseline });
      return next;
    });
    setDirty(true);
    setDraftSaved(false);
  }
  return <details className="command-disclosure" data-dirty={dirty ? "true" : undefined} open={initiallyOpen}><summary>{title}</summary><form className="workflow-form" onSubmit={submit}>
    {fields.map(field => <label key={field.name}>{field.label}
      {field.kind === "textarea" ? <textarea name={field.name} autoComplete="off" required={!field.optional} value={values[field.name]} onChange={e => updateValue(field.name, e.target.value)} />
        : field.kind === "select" || field.kind === "multi" ? <select name={field.name} required={!field.optional} multiple={field.kind === "multi"} value={field.kind === "multi" ? JSON.parse(values[field.name] || "[]") as string[] : values[field.name]} onChange={e => updateValue(field.name, field.kind === "multi" ? JSON.stringify(Array.from(e.target.selectedOptions, o => o.value)) : e.target.value)}>
          {field.kind !== "multi" && <option value="">请选择</option>}{field.options?.map(o => <option value={o.value} key={o.value}>{o.label}</option>)}
        </select> : <input name={field.name} autoComplete="off" required={!field.optional} value={values[field.name]} onChange={e => updateValue(field.name, e.target.value)} />}
      {field.hint && <small>{field.hint}</small>}
    </label>)}
    {!allowed && <Notice>当前身份没有{review ? "审阅" : "写入"}权限。</Notice>}
    {context.blocked && <Notice>本项目仍有结果未确认的操作，请先核对上方回执。</Notice>}
    {message && <Notice error={failed}>{message}</Notice>}
    {(stale || baselineChanged) && <div className="notice error"><p>当前版本或固定指针已经变化。输入仍保留，不能按新版本直接提交；请先保存完整草稿，再核对当前基线。</p>
      <div className="actions"><button type="button" onClick={() => void copyDraft()}>复制当前草稿</button>
        <button type="button" disabled={!draftSaved} onClick={() => {
          if (draftKey) drafts.delete(draftKey);
          setDirty(false); setStale(false); setValues(initial()); setReadBaseline(context.draftBaseline); context.onChanged();
        }}>回读当前状态（重建表单）</button></div>
      {draftSaved && <p>草稿已复制或由你确认手动保存，可以回读后对照新基线重填。</p>}
      {copyFallback && <><p>剪贴板不可用。请选择并手动复制下方全部字段，再确认保存。</p>
        <textarea className="draft-fallback" readOnly value={readableDraft(title, fields, values)} onFocus={event => event.currentTarget.select()} rows={12} />
        <button type="button" onClick={() => setDraftSaved(true)}>我已手动保存完整草稿</button></>}
    </div>}
    <button type="submit" className="primary" disabled={busy || !allowed || context.blocked || stale || baselineChanged}>{busy ? "保存中…" : title}</button>
  </form></details>;
}
export const reasonField: Field = { name: "reason", label: "理由与依据", kind: "textarea" };
export const option = (value: string, label: string) => ({ value, label });
