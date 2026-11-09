// The documents a task names (its fixed basis and its linked documents), read once per project and shared with the
// right column and the document peek (same query keys). A document that could not be read is reported as such; it
// never stands for "no newer version".
import { useQueries } from "@tanstack/react-query";
import type { DocumentDetail, DocumentRevision, TaskDetail } from "@evoloop/contracts";
import { api } from "../../shared/api";
import { fixedContent, queryKeys, useProjectQuery } from "../../shared/query";

export interface DocumentRead { data: DocumentDetail | undefined; error: unknown; isPending: boolean }

export function taskDocumentIds(detail: Pick<TaskDetail, "basis" | "links" | "impacts">): string[] {
  return [...new Set([...(detail.basis?.members.map(member => member.documentId) ?? []), ...detail.links.map(link => link.documentId),
    ...detail.impacts.map(impact => impact.documentId)])];
}

export function useTaskDocuments(projectId: string, detail: Pick<TaskDetail, "basis" | "links" | "impacts">) {
  const ids = taskDocumentIds(detail);
  const reads = useQueries({ queries: ids.map(id => ({
    queryKey: queryKeys.project(projectId, "document-detail", id),
    queryFn: async () => {
      const value = await api().document(projectId, id);
      if (value?.document?.id !== id || value.document.projectId !== projectId) throw new Error("文档响应与当前项目不符");
      return value;
    },
    retry: false,
  })) });
  const byId: Record<string, DocumentRead> = Object.fromEntries(ids.map((id, index) => [id, reads[index]!]));
  const documents: Record<string, DocumentDetail | undefined> = Object.fromEntries(ids.map(id => [id, byId[id]!.data]));
  return { ids, reads: byId, documents, pending: reads.some(read => read.isPending), failed: reads.some(read => !!read.error) };
}

/** One fixed revision: it never changes once saved, so it is read once (same key as the document page). */
export function useFixedRevision(projectId: string, documentId: string, revisionId: string | null | undefined, enabled = true) {
  return useProjectQuery(projectId, [fixedContent, documentId, revisionId ?? "", "revision"], async (): Promise<DocumentRevision> => {
    const value = await api().documentRevision(projectId, documentId, revisionId!);
    if (value.projectId !== projectId || value.documentId !== documentId || value.id !== revisionId) throw new Error("文档响应与所选的固定修订不符");
    return value;
  }, { enabled: enabled && !!revisionId });
}
