export type KnowledgeRoute =
  | { view: "outside" | "list" }
  | { view: "read"; id: string; revision?: string }
  | { view: "review"; id?: string }
  | { view: "invalid"; message: string };

const knowledgePath = (projectId: string) => `/p/${encodeURIComponent(projectId)}/knowledge`;

function queryOnly(params: URLSearchParams, allowed: string[]): boolean {
  const keys = [...params.keys()];
  return keys.every(key => allowed.includes(key)) && allowed.every(key => params.getAll(key).length <= 1);
}

export function readKnowledgeRoute(hash: string, projectId: string): KnowledgeRoute {
  const [path, query = ""] = hash.split("?");
  const canonicalPath = knowledgePath(projectId);
  if (path !== canonicalPath && !path.startsWith(`${canonicalPath}/`)) return { view: "outside" };
  if (path !== canonicalPath) return { view: "invalid", message: "这个知识链接的地址不受支持。请从知识列表重新打开。" };

  const params = new URLSearchParams(query);
  if (!queryOnly(params, ["knowledgeId", "knowledgeRevision", "candidateId", "review"])) {
    return { view: "invalid", message: "这个知识链接带了不支持或重复的参数。请从知识列表重新打开。" };
  }
  const candidateId = params.get("candidateId");
  const review = params.get("review");
  const knowledgeId = params.get("knowledgeId");
  const revision = params.get("knowledgeRevision");
  if (candidateId !== null) {
    return candidateId && params.size === 1 ? { view: "review", id: candidateId }
      : { view: "invalid", message: "候选链接缺少要打开的候选。" };
  }
  if (review !== null) {
    return review === "1" && params.size === 1 ? { view: "review" }
      : { view: "invalid", message: "候选与审阅的链接无效。" };
  }
  if (knowledgeId !== null) {
    return knowledgeId && (revision === null || !!revision) ? { view: "read", id: knowledgeId, revision: revision ?? undefined }
      : { view: "invalid", message: "固定知识链接缺少要打开的页面或版本。" };
  }
  if (revision !== null) return { view: "invalid", message: "固定版本链接缺少要打开的页面。" };
  return { view: "list" };
}

export type KnowledgeSelection = { knowledgeId: string; revision?: string | undefined } | { candidateId: string } | "review";

/** The address of a knowledge view. A fixed link keeps `knowledgeId` before `knowledgeRevision` (returnRoute.ts relies on it). */
export function knowledgeHref(projectId: string, selection?: KnowledgeSelection): string {
  const path = knowledgePath(projectId);
  if (!selection) return path;
  if (selection === "review") return `${path}?review=1`;
  const params = new URLSearchParams();
  if ("candidateId" in selection) params.set("candidateId", selection.candidateId);
  else {
    params.set("knowledgeId", selection.knowledgeId);
    if (selection.revision) params.set("knowledgeRevision", selection.revision);
  }
  return `${path}?${params}`;
}

/** A fixed process document opened from a knowledge source, returning to the knowledge view it came from. */
export const sourceDocumentHref = (projectId: string, documentId: string, revision: string, returnTo: string) =>
  `/p/${encodeURIComponent(projectId)}/documents/${encodeURIComponent(documentId)}?revision=${encodeURIComponent(revision)}&return=${encodeURIComponent(returnTo)}`;

export function matchesKnowledgeRevision(
  page: { knowledgeId: string; revision: string } | null | undefined,
  selectedId: string | null | undefined,
  fixedRevision?: string,
): boolean {
  // The unversioned read endpoint is authoritative for its own response.
  // A separately fetched list/history may still carry an older revision.
  return !!page && page.knowledgeId === selectedId && (!fixedRevision || page.revision === fixedRevision);
}

export interface FixedKnowledgeTitle { knowledgeId: string; revision: string; title: string }

/** A relation label is valid only for the exact immutable target revision. */
export function findFixedKnowledgeTitle(
  id: string, revision: string, records: readonly FixedKnowledgeTitle[],
): string | null {
  const match = records.find(item => item.knowledgeId === id && item.revision === revision && item.title.trim());
  return match?.title.trim() ?? null;
}

export const unresolvedFixedKnowledgeTitle = "固定目标（标题未读取）";

/**
 * While the next page is read, the page already on screen stays (so the right column does not collapse) but only as
 * the previous page: it never counts as the page or revision the address asks for.
 */
export function readingOnScreen<T extends { projectId: string; knowledgeId: string; revision: string }>(
  data: T | undefined, placeholder: boolean, projectId: string, id: string | null, revision?: string,
): { page: T | null; previous: boolean } {
  if (!data || data.projectId !== projectId) return { page: null, previous: false };
  return { page: data, previous: placeholder || !matchesKnowledgeRevision(data, id, revision) };
}
