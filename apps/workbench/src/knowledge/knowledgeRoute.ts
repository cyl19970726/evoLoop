export type KnowledgeRoute =
  | { view: "outside" | "list" }
  | { view: "read"; id: string; revision?: string }
  | { view: "review"; id?: string }
  | { view: "invalid"; message: string };

export interface KnowledgeRouteSnapshot<TPage, THistory, TGraph> {
  route: KnowledgeRoute;
  page: TPage | null;
  history: THistory[];
  graph: TGraph | null;
}

const knowledgePath = (projectId: string) => `#/p/${encodeURIComponent(projectId)}/knowledge`;

function queryOnly(params: URLSearchParams, allowed: string[]): boolean {
  const keys = [...params.keys()];
  return keys.every(key => allowed.includes(key)) && allowed.every(key => params.getAll(key).length <= 1);
}

export function readKnowledgeRoute(hash: string, projectId: string): KnowledgeRoute {
  const [path, query = ""] = hash.split("?");
  const canonicalPath = knowledgePath(projectId);
  if (path !== canonicalPath && !path.startsWith(`${canonicalPath}/`)) return { view: "outside" };
  if (path !== canonicalPath) return { view: "invalid", message: "此知识链接使用了不支持的子路径。请从知识列表重新打开固定版本。" };

  const params = new URLSearchParams(query);
  if (!queryOnly(params, ["knowledgeId", "knowledgeRevision", "candidateId", "review"])) {
    return { view: "invalid", message: "此知识链接包含不支持或重复的参数。请从知识列表重新打开固定版本。" };
  }
  const candidateId = params.get("candidateId");
  const review = params.get("review");
  const knowledgeId = params.get("knowledgeId");
  const revision = params.get("knowledgeRevision");
  if (candidateId !== null) {
    return candidateId && params.size === 1 ? { view: "review", id: candidateId }
      : { view: "invalid", message: "候选链接缺少有效候选 ID。" };
  }
  if (review !== null) {
    return review === "1" && params.size === 1 ? { view: "review" }
      : { view: "invalid", message: "候选审阅链接无效。" };
  }
  if (knowledgeId !== null) {
    return knowledgeId && (revision === null || !!revision) ? { view: "read", id: knowledgeId, revision: revision ?? undefined }
      : { view: "invalid", message: "固定知识链接缺少有效知识 ID 或修订 ID。" };
  }
  if (revision !== null) return { view: "invalid", message: "固定修订链接缺少知识 ID。" };
  return { view: "list" };
}

/** A route change must detach the prior revision before any replacement request can finish. */
export function transitionKnowledgeRoute<TPage, THistory, TGraph>(
  previous: KnowledgeRouteSnapshot<TPage, THistory, TGraph>, hash: string, projectId: string,
): KnowledgeRouteSnapshot<TPage, THistory, TGraph> {
  const route = readKnowledgeRoute(hash, projectId);
  if (route.view === "outside") return previous;
  return { route, page: null, history: [], graph: null };
}

export function matchesKnowledgeRevision(
  page: { knowledgeId: string; revision: string } | null,
  selectedId: string | null,
  fixedRevision?: string,
  currentRevision?: string,
): boolean {
  return !!page && page.knowledgeId === selectedId && (fixedRevision
    ? page.revision === fixedRevision
    : !!currentRevision && page.revision === currentRevision);
}
