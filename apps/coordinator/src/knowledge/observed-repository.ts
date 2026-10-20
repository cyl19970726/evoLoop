import type { KnowledgeRepository, KnowledgeRevision, KnowledgeSourceRef, KnowledgeSummary } from "@evoloop/contracts/knowledge";

/** Adds current source observations without changing external Wiki bodies or immutable revision history. */
export function withObservedSources(
  repository: KnowledgeRepository,
  checkSource: (projectId: string, source: KnowledgeSourceRef) => Promise<boolean>,
): KnowledgeRepository {
  async function observe(page: KnowledgeRevision): Promise<KnowledgeRevision> {
    if (page.validity === "withdrawn" || page.observedValidity === "withdrawn")
      return { ...page, observedValidity: "withdrawn" };
    if (page.validity === "needs_review" || page.observedValidity === "needs_review")
      return { ...page, observedValidity: "needs_review" };
    // A partial check is never treated as proof that all sources remain current.
    if (page.sources.length > 100) return { ...page, observedValidity: "needs_review" };
    for (const source of page.sources) {
      if (source.state !== "reachable") return { ...page, observedValidity: "needs_review" };
      try {
        if (!await checkSource(page.projectId, source)) return { ...page, observedValidity: "needs_review" };
      } catch {
        return { ...page, observedValidity: "needs_review" };
      }
    }
    return page;
  }
  async function summary(projectId: string, item: KnowledgeSummary): Promise<KnowledgeSummary> {
    if (item.validity !== "valid") return item;
    // Call the raw repository: it verifies external fixed body bytes and avoids decorator recursion.
    let page: KnowledgeRevision | null;
    try { page = await repository.get(projectId, item.knowledgeId, item.revision); }
    catch { return { ...item, validity: "needs_review" }; }
    if (!page) return { ...item, validity: "needs_review" };
    const observed = await observe(page);
    return { ...item, validity: observed.observedValidity };
  }
  return {
    capabilities: () => repository.capabilities(),
    async list(projectId, limit, cursor) {
      const original = await repository.list(projectId, limit, cursor);
      const items: KnowledgeSummary[] = [];
      for (const item of original.items) items.push(await summary(projectId, item));
      return { ...original, items };
    },
    async get(projectId, knowledgeId, revision) {
      const original = await repository.get(projectId, knowledgeId, revision);
      return original ? observe(original) : null;
    },
    // History describes the immutable original revision status. Reading any fixed revision adds an observed hint.
    history: (projectId, knowledgeId, limit, cursor) => repository.history(projectId, knowledgeId, limit, cursor),
    async graph(projectId, focusKnowledgeId, limit) {
      const original = await repository.graph(projectId, focusKnowledgeId, limit);
      const nodes: KnowledgeSummary[] = [];
      for (const item of original.nodes) nodes.push(await summary(projectId, item));
      const needsReview = new Set(nodes.filter(item => item.validity !== "valid").map(item => `${item.knowledgeId}\0${item.revision}`));
      const edges = original.edges.map(edge => edge.state === "active" &&
        (needsReview.has(`${edge.fromKnowledgeId}\0${edge.fromRevision}`) || needsReview.has(`${edge.toKnowledgeId}\0${edge.toRevision}`))
        ? { ...edge, state: "needs_review" as const } : edge);
      return { ...original, nodes, edges };
    },
    sourceState: (projectId, sourceKey) => repository.sourceState(projectId, sourceKey),
    listCandidates: (projectId, limit, cursor) => repository.listCandidates(projectId, limit, cursor),
    getCandidate: (projectId, candidateId) => repository.getCandidate(projectId, candidateId),
    propose: candidate => repository.propose(candidate),
    review: (projectId, decision) => repository.review(projectId, decision),
    publish: (projectId, candidateId, operationId, actorId) => repository.publish(projectId, candidateId, operationId, actorId),
    reconcile: (projectId, operationId, actorId) => repository.reconcile(projectId, operationId, actorId),
    retractSource: (projectId, sourceKey, operationId, actorId) => repository.retractSource(projectId, sourceKey, operationId, actorId),
  };
}
