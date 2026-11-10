// 导入过程文档 / 上传新修订: a Markdown or HTML original (an HTML package with its assets) saved as a fixed revision.
// It is the shared command form (shared/command: useCommand with CommandFrame): the files are read and hashed in the
// browser first, then the recovery receipt is saved before anything is sent; an unknown result blocks the form until
// it is checked by its original operation ID; a new revision is sent against the document version recorded when the
// form opened, and a newer version asks the reader to keep their input or start over. Files are never kept as drafts.
import { useEffect, useRef, useState } from "react";
import type { CommandResult } from "@evoloop/contracts";
import { documentPayloadCommandSchema } from "@evoloop/contracts/process-documents";
import { Field, Input, Notice, Select, Textarea } from "@evoloop/ui";
import { request } from "../../shared/api";
import { CommandFrame, useCommand, type MutationContext, type SubmittableCommand } from "../../shared/command";
import { uploadCommand, uploadProblem, type UploadFiles } from "./uploadCommand";

const hex = (bytes: Uint8Array) => Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
const fileHash = async (buffer: ArrayBuffer): Promise<string> => hex(new Uint8Array(await crypto.subtle.digest("SHA-256", buffer)));
function base64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let at = 0; at < bytes.length; at += 32768) binary += String.fromCharCode(...bytes.subarray(at, at + 32768));
  return btoa(binary);
}
const fileControl = "h-auto py-1.5 file:mr-3 file:cursor-pointer file:rounded-md file:border-0 file:bg-raised file:px-3 file:py-1 file:text-label file:text-foreground";

type Kind = "" | "issue" | "spec" | "discussion" | "report";

export function UploadDocument({ context, mode = "create", documentId, expectedVersion }: {
  context: MutationContext; mode?: "create" | "revise"; documentId?: string; expectedVersion?: number;
}) {
  const [title, setTitle] = useState("");
  const [kind, setKind] = useState<Kind>("");
  const [reason, setReason] = useState("");
  const [format, setFormat] = useState<"markdown" | "html">("markdown");
  const [main, setMain] = useState<File | null>(null);
  const [assets, setAssets] = useState<File[]>([]);
  // The file inputs are the browser's own; a new generation empties them.
  const [generation, setGeneration] = useState(0);
  const [reading, setReading] = useState(false);
  const [problem, setProblem] = useState("");
  const uploads = useRef<{ blobId: string; base64: string }[]>([]);
  const command = useCommand(context, mode === "revise" ? { documentVersion: expectedVersion ?? 0 } : undefined, {
    // The import route takes the document command without its `type` (that names the receipt) and the files beside it.
    validate: candidate => { const { type: _, ...rest } = candidate; documentPayloadCommandSchema.parse(rest); },
    send: (sent: SubmittableCommand) => {
      const { type: _, ...rest } = sent as Record<string, unknown>;
      return request<CommandResult>("", `/api/projects/${encodeURIComponent(context.projectId)}/documents/import`, 120000,
        { method: "POST", body: JSON.stringify({ command: rest, uploads: uploads.current }) });
    },
    onStale: context.onChanged,
  });
  const dirty = !!(main || assets.length || title || kind || reason);
  // A form nobody has filled follows a newer version by itself; a filled one asks (CommandFrame).
  useEffect(() => {
    if (!dirty && command.baselineChanged && !command.awaitingReread) command.rebase();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirty, command.baselineChanged, command.awaitingReread]);
  // What stopped the last attempt is about the inputs then: changing them clears it.
  useEffect(() => { setProblem(""); }, [title, kind, reason, format, main, assets]);
  const clear = () => { setTitle(""); setKind(""); setReason(""); setMain(null); setAssets([]); setFormat("markdown"); setProblem(""); setGeneration(value => value + 1); };

  async function submit() {
    setProblem("");
    const files: UploadFiles = { main, assets, format };
    const refusal = uploadProblem({ mode, title, reason, documentId, expectedVersion }, files);
    if (refusal) { setProblem(refusal); return; }
    const all = [main!, ...assets];
    setReading(true);
    let hashes: string[], blobIds: string[];
    try {
      const buffers = await Promise.all(all.map(file => file.arrayBuffer()));
      hashes = await Promise.all(buffers.map(fileHash));
      blobIds = all.map(() => crypto.randomUUID());
      uploads.current = buffers.map((buffer, index) => ({ blobId: blobIds[index]!, base64: base64(buffer) }));
    } catch { setProblem("浏览器没能读取所选文件，请重新选择后再提交。"); return; }
    finally { setReading(false); }
    const ids = { documentId: mode === "create" ? crypto.randomUUID() : documentId!, revisionId: crypto.randomUUID(), blobIds };
    await command.submit(seen => uploadCommand({ mode, title, kind, reason, author: context.principal.actorId,
      expectedVersion: seen && typeof seen === "object" ? seen.documentVersion : undefined }, files, hashes, ids), clear);
  }

  const heading = mode === "create" ? "导入过程文档" : "上传新修订";
  return <CommandFrame context={context} command={command} label={heading} submitLabel={mode === "create" ? "导入原件" : "保存新修订"} dirty={dirty}
    onSubmit={() => void submit()} paused={reading ? "正在读取并核验文件…" : null}
    onKeep={() => command.rebase()} onRefill={() => { command.rebase(); clear(); }}
    keepNote="保留我的修改：所选文件和理由不变，按读回的最新版本提交；先看上方读回的新内容，确认这份原件仍然适用。">
    <h3 className="text-small font-semibold text-foreground">{heading}</h3>
    {mode === "create" && <Field label="标题">{control => <Input {...control} value={title} autoComplete="off" onChange={event => setTitle(event.target.value)} />}</Field>}
    {mode === "create" && <Field label="类型（可选）">{control => <Select {...control} className="w-full" value={kind} onChange={event => setKind(event.target.value as Kind)}>
      <option value="">未分类</option><option value="issue">问题</option><option value="spec">规范</option><option value="discussion">讨论</option><option value="report">报告</option>
    </Select>}</Field>}
    <Field label="格式">{control => <Select {...control} className="w-full" value={format} onChange={event => { setFormat(event.target.value as "markdown" | "html"); setAssets([]); }}>
      <option value="markdown">Markdown</option><option value="html">HTML</option></Select>}</Field>
    <Field label="原件">{control => <Input {...control} key={`main:${generation}`} type="file" className={fileControl}
      accept={format === "html" ? ".html,.htm,text/html" : ".md,.markdown,text/markdown,text/plain"} onChange={event => setMain(event.target.files?.[0] ?? null)} />}</Field>
    {format === "html" && <Field label="配套资源（可选，同一目录的文件）">{control => <Input {...control} key={`assets:${generation}`} type="file" multiple className={fileControl}
      onChange={event => setAssets(Array.from(event.target.files ?? []))} />}</Field>}
    <Field label="修订理由">{control => <Textarea {...control} value={reason} onChange={event => setReason(event.target.value)} />}</Field>
    <p className="text-caption text-muted-foreground">原件与资源总大小上限 16 MiB。HTML 仅提供静态隔离预览；脚本不会运行。</p>
    {problem && <Notice tone="error">{problem}</Notice>}
  </CommandFrame>;
}
