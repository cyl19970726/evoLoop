import { useState, type FormEvent, type ReactNode } from "react";
import { commandSchema, type Command, type Principal, type Operation } from "@evoloop/contracts";
import { api, errorText, isUnconfirmed } from "../api";

export interface RecoverableCommand {
  projectId: string; operationId: string; type: Operation["commandType"];
  taskId?: string; goalId?: string; stageId?: string; documentId?: string; discussionId?: string;
}
export interface MutationContext {
  token: string; projectId: string; principal: Principal; blocked: boolean;
  onAttempt(command: RecoverableCommand): boolean; onKnown(operationId: string): void; onChanged(): void;
}
export interface Field {
  name: string; label: string; value?: string; kind?: "text" | "textarea" | "select" | "multi";
  options?: { value: string; label: string }[]; optional?: boolean; hint?: string;
}
export function Notice({ children, error = false }: { children: ReactNode; error?: boolean }) {
  return <div className={`notice ${error ? "error" : "info"}`} role={error ? "alert" : "status"}>{children}</div>;
}

/** Shared command submission preserves the draft and persists the operation ID before any write. */
export function ActionForm({ context, title, fields, build, review = false, onApplied }: {
  context: MutationContext; title: string; fields: Field[]; review?: boolean;
  build(values: Record<string, string>): Record<string, unknown>; onApplied?: (result: { entityId: string; revisionId?: string }) => void;
}) {
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(fields.map(f => [f.name, f.value ?? (f.kind === "multi" ? "[]" : "")])));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [failed, setFailed] = useState(false);
  const [stale, setStale] = useState(false);
  const allowed = context.principal.permissions.includes(review ? "review" : "write");
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || !allowed || context.blocked || stale) return;
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
        setMessage(result.message); setFailed(true); setStale(result.code === "VERSION_CONFLICT");
      } else {
        setMessage("已保存，正在读取持久记录。");
        onApplied?.(result); context.onChanged();
      }
    } catch (cause) {
      if (!isUnconfirmed(cause)) context.onKnown(command.operationId);
      setMessage(`${errorText(cause)}${isUnconfirmed(cause) ? "。请在上方按原操作 ID 核对，确认前不要再次提交。" : "。草稿已保留；版本冲突时先回读当前内容。"}`);
      setFailed(true);
      // A 409 may mean a stale object; require explicit readback before trying a fresh command.
      if (!isUnconfirmed(cause) && typeof cause === "object" && cause && "status" in cause && cause.status === 409) setStale(true);
    } finally { setBusy(false); }
  }
  return <form className="workflow-form" onSubmit={submit}>
    <h3>{title}</h3>
    {fields.map(field => <label key={field.name}>{field.label}
      {field.kind === "textarea" ? <textarea required={!field.optional} value={values[field.name]} onChange={e => setValues(v => ({ ...v, [field.name]: e.target.value }))} />
        : field.kind === "select" || field.kind === "multi" ? <select required={!field.optional} multiple={field.kind === "multi"} value={field.kind === "multi" ? JSON.parse(values[field.name] || "[]") as string[] : values[field.name]} onChange={e => setValues(v => ({ ...v, [field.name]: field.kind === "multi" ? JSON.stringify(Array.from(e.target.selectedOptions, o => o.value)) : e.target.value }))}>
          {field.kind !== "multi" && <option value="">请选择</option>}{field.options?.map(o => <option value={o.value} key={o.value}>{o.label}</option>)}
        </select> : <input required={!field.optional} value={values[field.name]} onChange={e => setValues(v => ({ ...v, [field.name]: e.target.value }))} />}
      {field.hint && <small>{field.hint}</small>}
    </label>)}
    {!allowed && <Notice>当前身份没有{review ? "审阅" : "写入"}权限。</Notice>}
    {context.blocked && <Notice>本项目仍有结果未确认的操作，请先核对上方回执。</Notice>}
    {message && <Notice error={failed}>{message}</Notice>}
    {stale && <p>当前草稿保持原样。请复制所需内容，再使用页面的“回读当前状态”更新基线。</p>}
    <button type="submit" className="primary" disabled={busy || !allowed || context.blocked || stale}>{busy ? "保存中…" : title}</button>
  </form>;
}
export const reasonField: Field = { name: "reason", label: "理由与依据", kind: "textarea" };
export const option = (value: string, label: string) => ({ value, label });
