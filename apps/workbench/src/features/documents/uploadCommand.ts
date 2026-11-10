// 导入过程文档 / 上传新修订 as pure functions: what stops an upload before any file is read, and the document command
// the import route takes (the same fields as before the form moved onto shared/command). Pure, so the form and its
// tests agree.
const maxBytes = 16 * 1024 * 1024;

/** Names the import route accepts: unique, no path, no reference syntax (the contract's 240-character relative name). */
export const safeName = (name: string): boolean => name.length > 0 && name.length <= 240 &&
  !name.includes("/") && !name.includes("\\") && name !== "." && name !== ".." &&
  !name.includes("?") && !name.includes("#") && !name.includes("\0") && !/^[a-z][a-z0-9+.-]*:/i.test(name);

/** The files chosen: only their names, sizes and types are needed to check them. */
export interface UploadFiles {
  main: Pick<File, "name" | "size"> | null;
  assets: ReadonlyArray<Pick<File, "name" | "size" | "type">>;
  format: "markdown" | "html";
}

export interface UploadText { mode: "create" | "revise"; title: string; reason: string; documentId?: string | undefined; expectedVersion?: number | undefined }

/** Why the upload cannot be sent as it is, in words for the form; null when it can. */
export function uploadProblem(text: UploadText, files: UploadFiles): string | null {
  const { main, assets, format } = files;
  if (!main || !text.reason.trim() || text.mode === "create" && !text.title.trim() || text.mode === "revise" && (!text.documentId || !text.expectedVersion))
    return "请填写名称、理由并选择原件。";
  if (text.title.trim().length > 240) return `标题最多 240 字，现在是 ${text.title.trim().length} 字，请删减后再提交。`;
  if (text.reason.trim().length > 4000) return `修订理由最多 4000 字，现在是 ${text.reason.trim().length} 字，请删减后再提交。`;
  if (!safeName(main.name) || assets.some(file => !safeName(file.name)) ||
    new Set(assets.map(file => file.name)).size !== assets.length || assets.some(file => file.name === main.name))
    return "文件名需唯一，且不能包含路径或特殊引用字符。";
  if (format === "markdown" && assets.length) return "配套资源目前用于 HTML 包；Markdown 请上传单个原件。";
  const all = [main, ...assets];
  if (all.some(file => !file.size) || all.reduce((sum, file) => sum + file.size, 0) > maxBytes || assets.length > 50)
    return "文件不能为空；原件与资源总大小不能超过 16 MiB，资源最多 50 个。";
  return null;
}

/**
 * The `document.payload` command for checked files: `hashes` and `ids.blobIds` follow the files in order (the main
 * original first). `type` names the recovery receipt; the import route takes the rest. A revision carries the version
 * the form recorded when it opened (`expectedVersion`).
 */
export function uploadCommand(text: UploadText & { kind: string; author: string }, files: UploadFiles, hashes: readonly string[],
  ids: { documentId: string; revisionId: string; blobIds: readonly string[] }): Record<string, unknown> {
  const { main, assets, format } = files;
  if (!main) throw new Error("请选择原件。");
  if (text.mode === "revise" && !text.expectedVersion) throw new Error("文档版本还没有读回，暂不能上传新修订。");
  return {
    type: "document.payload", documentId: ids.documentId, revisionId: ids.revisionId, mode: text.mode,
    ...(text.mode === "create" ? { title: text.title.trim(), kind: text.kind || null } : { expectedVersion: text.expectedVersion }),
    format, mediaType: format === "html" ? "text/html" : "text/markdown",
    originalName: main.name, author: text.author, reason: text.reason.trim(),
    source: { storage: "blob", payloadRef: ids.blobIds[0], contentHash: hashes[0], size: main.size,
      entrypoint: format === "html" ? main.name : null,
      assets: assets.map((file, index) => ({ path: file.name, blobId: ids.blobIds[index + 1], contentHash: hashes[index + 1], size: file.size,
        mediaType: file.type || "application/octet-stream" })) },
  };
}
