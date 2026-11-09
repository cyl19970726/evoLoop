// Knowledge reads as project queries (shared/query.ts): every key starts with the project, the signed-in identity
// is used without passing a token, and writes elsewhere (context.onChanged) reread them. The page and candidate lists
// read one more page on 载入更多; a failed page or reread keeps what was read.
import type { KnowledgeCandidateSummary, KnowledgeSummary } from "@evoloop/contracts/knowledge";
import { useQueryClient } from "@tanstack/react-query";
import { knowledgeClient } from "../../shared/knowledgeClient";
import { queryKeys, useProjectList, useProjectQuery } from "../../shared/query";
import { readKnowledgePage } from "./knowledgeRead";

/** Requests and writes for one project; without a token argument they use the signed-in identity. */
export const knowledgeApi = (projectId: string) => knowledgeClient("", projectId);

export function useKnowledgeIndex(projectId: string) {
  const capabilities = useProjectQuery(projectId, ["knowledge", "capabilities"], () => knowledgeApi(projectId).capabilities());
  const pages = useProjectList(projectId, ["knowledge", "pages"], cursor => knowledgeApi(projectId).pages(cursor),
    (item: KnowledgeSummary) => item.knowledgeId);
  const candidates = useProjectList(projectId, ["knowledge", "candidates"], cursor => knowledgeApi(projectId).candidates(cursor),
    (item: KnowledgeCandidateSummary) => item.candidateId);
  // The sources a candidate may cite: the first page (50 adopted process documents).
  const sources = useProjectQuery(projectId, ["knowledge", "sources"], () => knowledgeApi(projectId).sources());
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
