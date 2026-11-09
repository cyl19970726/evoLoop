// The original of one fixed revision with its registered assets: an HTML report, or the Markdown text of a revision
// kept only as its original (an uploaded file or an import saves no inline body). It never changes, so it is read
// once and stays out of the rereads that follow the current version and writes (`fixedContent`).
import { request } from "../../shared/api";
import { fixedContent, useProjectQuery } from "../../shared/query";
import { originalPath, type Original } from "../../shared/ui/OriginalDocumentReader";

export function useOriginal(projectId: string, documentId: string, revisionId: string, enabled = true) {
  return useProjectQuery(projectId, [fixedContent, documentId, revisionId, "original"], async signal => {
    const result = await request<Original>("", originalPath(projectId, documentId, revisionId), 30000, { signal });
    if (result.revision.projectId !== projectId || result.revision.documentId !== documentId || result.revision.id !== revisionId)
      throw new Error("原件响应与所选项目、文档及固定修订不符");
    return result;
  }, { enabled });
}
