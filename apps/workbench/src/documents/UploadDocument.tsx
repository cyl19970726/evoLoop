import { useState, type FormEvent } from "react";
import type { CommandResult } from "@evoloop/contracts";
import type { DocumentPayloadCommand } from "@evoloop/contracts/process-documents";
import { ApiError, errorText, isUnconfirmed, request } from "../api";
import { Notice, type MutationContext } from "../workflow/ActionForm";

const maxBytes = 16 * 1024 * 1024;
const key = (value: string) => encodeURIComponent(value);
const hex = (bytes: Uint8Array) => Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
const fileHash = async (buffer: ArrayBuffer): Promise<string> => hex(new Uint8Array(await crypto.subtle.digest("SHA-256", buffer)));
function base64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let at = 0; at < bytes.length; at += 32768) binary += String.fromCharCode(...bytes.subarray(at, at + 32768));
  return btoa(binary);
}
const safeName = (name: string): boolean => name.length > 0 && name.length <= 240 &&
  !name.includes("/") && !name.includes("\\") && name !== "." && name !== ".." &&
  !name.includes("?") && !name.includes("#") && !name.includes("\0") && !/^[a-z][a-z0-9+.-]*:/i.test(name);
const rejected = (value: unknown): value is Extract<CommandResult, { status: "rejected" }> =>
  !!value && typeof value === "object" && (value as { status?: unknown }).status === "rejected";

export function UploadDocument({ context, mode = "create", documentId, expectedVersion }: {
  context: MutationContext; mode?: "create" | "revise"; documentId?: string; expectedVersion?: number;
}) {
  const [title, setTitle] = useState("");
  const [reason, setReason] = useState("");
  const [format, setFormat] = useState<"markdown" | "html">("markdown");
  const [main, setMain] = useState<File | null>(null);
  const [assets, setAssets] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [unknown, setUnknown] = useState(false);
  const [stale, setStale] = useState(false);
  const [message, setMessage] = useState("");
  const canWrite = context.principal.permissions.includes("write");
  async function submit(event: FormEvent) {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    if (busy || unknown || stale || context.blocked || !canWrite) return;
    setMessage("");
    if (!main || !reason.trim() || mode === "create" && !title.trim() ||
      mode === "revise" && (!documentId || !expectedVersion)) { setMessage("请填写名称、理由并选择原件。"); return; }
    if (!safeName(main.name) || assets.some(file => !safeName(file.name)) ||
      new Set(assets.map(file => file.name)).size !== assets.length || assets.some(file => file.name === main.name)) {
      setMessage("文件名需唯一，且不能包含路径或特殊引用字符。"); return;
    }
    if (format === "markdown" && assets.length) { setMessage("配套资源目前用于 HTML 包；Markdown 请上传单个原件。"); return; }
    const allFiles = [main, ...assets];
    if (allFiles.some(file => !file.size) || allFiles.reduce((sum, file) => sum + file.size, 0) > maxBytes || assets.length > 50) {
      setMessage("文件不能为空；原件与资源总大小不能超过 16 MiB，资源最多 50 个。"); return;
    }
    setBusy(true);
    let attemptId: string | null = null;
    try {
      const operationId = crypto.randomUUID(), revisionId = crypto.randomUUID();
      attemptId = operationId;
      const docId = mode === "create" ? crypto.randomUUID() : documentId!;
      const ids = allFiles.map(() => crypto.randomUUID());
      const buffers = await Promise.all(allFiles.map(file => file.arrayBuffer()));
      const hashes = await Promise.all(buffers.map(fileHash));
      const uploads = buffers.map((buffer, index) => ({ blobId: ids[index]!, base64: base64(buffer) }));
      const command: DocumentPayloadCommand = {
        projectId: context.projectId, operationId, documentId: docId, revisionId, mode,
        ...(mode === "create" ? { title: title.trim() } : { expectedVersion }),
        format, mediaType: format === "html" ? "text/html" : "text/markdown",
        originalName: main.name, author: context.principal.actorId, reason: reason.trim(),
        source: { storage: "blob", payloadRef: ids[0]!, contentHash: hashes[0]!, size: main.size,
          entrypoint: format === "html" ? main.name : null,
          assets: assets.map((file, index) => ({ path: file.name, blobId: ids[index + 1]!,
            contentHash: hashes[index + 1]!, size: file.size, mediaType: file.type || "application/octet-stream" })) },
      };
      if (!context.onAttempt({ type: "document.payload", projectId: context.projectId,
        operationId, documentId: docId })) { setMessage("浏览器不能保存恢复回执，本次尚未提交。"); return; }
      const result = await request<CommandResult>(context.token,
        `/api/projects/${key(context.projectId)}/documents/import`, 120000,
        { method: "POST", body: JSON.stringify({ command, uploads }) });
      context.onKnown(operationId);
      if (result.status === "rejected") {
        setMessage(result.message); setStale(result.code === "VERSION_CONFLICT");
      } else {
        setTitle(""); setReason(""); setMain(null); setAssets([]); setFormat("markdown"); form.reset();
        setMessage("原件和固定修订已保存。"); context.onChanged();
      }
    } catch (cause) {
      const known = cause instanceof ApiError && rejected(cause.detail) ? cause.detail : null;
      if (!isUnconfirmed(cause) && attemptId) context.onKnown(attemptId);
      if (known) {
        setMessage(known.message); setStale(known.code === "VERSION_CONFLICT");
      } else {
        setMessage(`${errorText(cause)}${isUnconfirmed(cause) ? "。请先按已保存的操作 ID 核对结果；此表单不会重新提交。" : "。输入已保留。"}`);
        if (isUnconfirmed(cause)) setUnknown(true);
      }
    } finally { setBusy(false); }
  }
  return <form data-dirty={main || assets.length || title || reason ? "true" : undefined} className="workflow-form panel" onSubmit={submit}>
    <h3>{mode === "create" ? "导入过程文档" : "上传新修订"}</h3>
    {mode === "create" && <label>标题<input required value={title} onChange={event => setTitle(event.target.value)} /></label>}
    <label>格式<select value={format} onChange={event => { setFormat(event.target.value as "markdown" | "html"); setAssets([]); }}>
      <option value="markdown">Markdown</option><option value="html">HTML</option></select></label>
    <label>原件<input type="file" required accept={format === "html" ? ".html,.htm,text/html" : ".md,.markdown,text/markdown,text/plain"}
      onChange={event => setMain(event.target.files?.[0] ?? null)} /></label>
    {format === "html" && <label>配套资源（可选，同一目录的文件）<input type="file" multiple
      onChange={event => setAssets(Array.from(event.target.files ?? []))} /></label>}
    <label>修订理由<textarea required value={reason} onChange={event => setReason(event.target.value)} /></label>
    <p className="muted">原件与资源总大小上限 16 MiB。HTML 仅提供静态隔离预览；脚本不会运行。</p>
    {!canWrite && <Notice>当前身份没有写入权限。</Notice>}
    {context.blocked && <Notice>本项目有结果未确认的操作，请先核对回执。</Notice>}
    {stale && <Notice error>版本已变化；输入保持原样，请先回读当前修订。</Notice>}
    {unknown && <Notice error>结果尚未确认。请使用已保存的操作 ID 回读，不要重新上传。</Notice>}
    {message && <Notice error={stale || unknown}>{message}</Notice>}
    <button className="primary" type="submit" disabled={busy || unknown || stale || context.blocked || !canWrite}>
      {busy ? "正在核验并上传…" : mode === "create" ? "导入原件" : "保存新修订"}</button>
  </form>;
}
