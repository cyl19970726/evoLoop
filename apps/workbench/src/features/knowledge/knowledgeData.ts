// Knowledge reads as project queries (shared/query.ts): every key starts with the project, the signed-in identity
// is used without passing a token, and writes elsewhere (context.onChanged) reread them.
import type { KnowledgeCandidateSummary, KnowledgeSummary } from "@evoloop/contracts/knowledge";
import { useQueryClient } from "@tanstack/react-query";
import { knowledgeClient, type SourceDocument } from "../../shared/knowledgeClient";
import { queryKeys, useProjectQuery } from "../../shared/query";
import { readKnowledgePage, readPagesTo } from "./knowledgeRead";

/** Requests and writes for one project; without a token argument they use the signed-in identity. */
export const knowledgeApi = (projectId: string) => knowledgeClient("", projectId);

export function useKnowledgeIndex(projectId: string, pageDepth: number, candidateDepth: number) {
  const capabilities = useProjectQuery(projectId, ["knowledge", "capabilities"], () => knowledgeApi(projectId).capabilities());
  const pages = useProjectQuery(projectId, ["knowledge", "pages", pageDepth],
    () => readPagesTo(cursor => knowledgeApi(projectId).pages(cursor), pageDepth, (item: KnowledgeSummary) => item.knowledgeId), { keepPrevious: true });
  const candidates = useProjectQuery(projectId, ["knowledge", "candidates", candidateDepth],
    () => readPagesTo(cursor => knowledgeApi(projectId).candidates(cursor), candidateDepth, (item: KnowledgeCandidateSummary) => item.candidateId), { keepPrevious: true });
  const sources = useProjectQuery(projectId, ["knowledge", "sources"],
    () => readPagesTo(cursor => knowledgeApi(projectId).sources(cursor), 1, (item: SourceDocument) => item.documentId));
  return { capabilities, pages, candidates, sources };
}

/** The open page as one unit (body, history, graph, current version, relation titles); the previous unit stays while the next loads. */
export function useKnowledgeReading(projectId: string, id: string | null, revision?: string) {
  return useProjectQuery(projectId, ["knowledge", "read", id ?? "", revision ?? ""],
    () => readKnowledgePage(knowledgeApi(projectId), projectId, id!, revision), { enabled: !!id, keepPrevious: true });
}

export function useKnowledgeCandidate(projectId: string, candidateId: string | undefined) {
  return useProjectQuery(projectId, ["knowledge", "candidate", candidateId ?? ""], async () => {
    const value = await knowledgeApi(projectId).candidate(candidateId!);
    if (value.projectId !== projectId || value.candidateId !== candidateId) throw new Error("候选响应与所选候选不符");
    return value;
  }, { enabled: !!candidateId });
}

/** 重新读取: every knowledge read of this project, keeping what is on screen until the answers arrive. */
export function useKnowledgeReread(projectId: string) {
  const client = useQueryClient();
  return () => void client.invalidateQueries({ queryKey: queryKeys.project(projectId, "knowledge") });
}
