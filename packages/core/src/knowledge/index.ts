import type { KnowledgeLintFinding, KnowledgeLintReport, KnowledgeRepository, KnowledgeRevision, KnowledgeSourceRef } from "@evoloop/contracts/knowledge";
import { DomainError } from "@evoloop/contracts/ports";

/** Read-only provenance checks. Findings inform review; they do not prove semantic correctness or publish changes. */
export async function lintKnowledge(repository: KnowledgeRepository, projectId: string, knowledgeId: string,
  revision: string | undefined, checkSource: (source: KnowledgeSourceRef) => Promise<boolean>): Promise<KnowledgeLintReport> {
  const page = await repository.get(projectId, knowledgeId, revision);
  if (!page || page.projectId !== projectId || page.knowledgeId !== knowledgeId || revision && page.revision !== revision)
    throw new DomainError("NOT_FOUND", "Knowledge revision was not found in the requested scope");
  return lintRevision(repository, page, checkSource, { target: "published" });
}

export async function lintKnowledgeCandidate(repository: KnowledgeRepository, projectId: string, candidateId: string,
  checkSource: (source: KnowledgeSourceRef) => Promise<boolean>): Promise<KnowledgeLintReport> {
  const candidate = await repository.getCandidate(projectId, candidateId);
  if (!candidate || candidate.projectId !== projectId || candidate.candidateId !== candidateId)
    throw new DomainError("NOT_FOUND", "Knowledge candidate was not found in the requested scope");
  return lintRevision(repository, { ...candidate, revision: candidate.candidateRevision,
    previousRevision: candidate.expectedRevision, validity: "valid", observedValidity: "valid", createdAt: "" },
  checkSource, { target: "candidate", candidateId });
}

async function lintRevision(repository: KnowledgeRepository, page: KnowledgeRevision,
  checkSource: (source: KnowledgeSourceRef) => Promise<boolean>,
  target: Pick<KnowledgeLintReport, "target" | "candidateId">): Promise<KnowledgeLintReport> {
  const projectId = page.projectId;
  const findings: KnowledgeLintFinding[] = [];
  const add = (code: KnowledgeLintFinding["code"], message: string) => findings.push({ code, message });
  if (page.validity !== "valid" || page.observedValidity !== "valid")
    add("NEEDS_REVIEW", "This fixed revision is withdrawn or needs review");
  if (!page.sources.length) add("NO_SOURCES", "The revision has no registered fixed sources");
  if (page.sources.length > 100 || page.relations.length > 100)
    add("INCOMPLETE", "Revision exceeds the bounded source or relation check; only the first 100 of each were checked");
  const seen = new Set<string>();
  for (const source of page.sources.slice(0, 100)) {
    if (seen.has(source.sourceKey)) add("DUPLICATE_SOURCE", `Duplicate source ${source.sourceKey}`);
    seen.add(source.sourceKey);
    let available = false;
    try {
      available = source.state === "reachable" && await repository.sourceState(projectId, source.sourceKey) !== "withdrawn" &&
        await checkSource(source);
    } catch { /* Missing permissions or originals must remain findings. */ }
    if (!available) add("SOURCE_UNAVAILABLE", `Fixed source ${source.sourceKey} is changed, withdrawn or unavailable`);
  }
  for (const relation of page.relations.slice(0, 100)) {
    let available = false;
    try {
      const target = await repository.get(projectId, relation.toKnowledgeId, relation.toRevision);
      available = relation.fromKnowledgeId === page.knowledgeId && relation.fromRevision === page.revision &&
        relation.state === "active" && relation.sourceKeys.every(key => seen.has(key)) &&
        !!target && target.validity === "valid" && target.observedValidity === "valid";
    } catch { /* Do not turn an unreadable fixed target into a clean check. */ }
    if (!available) add("RELATION_UNAVAILABLE", `Relation ${relation.edgeId} has an unavailable or unreviewed fixed endpoint`);
  }
  return { ...target, knowledgeId: page.knowledgeId, revision: page.revision, contentHash: page.contentHash,
    findings, structural: findings.length ? "findings" : "passed", semantic: "not_run" };
}
