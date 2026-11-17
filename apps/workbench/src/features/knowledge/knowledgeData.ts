// Knowledge reads as project queries (shared/query.ts): every key starts with the project, the signed-in identity
// is used without passing a token, and writes elsewhere (context.onChanged) reread them. The page and candidate lists
// read one more page on 载入更多; a failed page or reread keeps what was read.
import type { KnowledgeCandidateSummary, KnowledgeSummary } from "@evoloop/contracts/knowledge";
import { useQueryClient } from "@tanstack/react-query";
import { ApiError, api, type ProjectCapabilitiesView } from "../../shared/api";
import { knowledgeClient } from "../../shared/knowledgeClient";
import { useProjectList } from "../../shared/projectList";
import { queryKeys, useProjectQuery } from "../../shared/query";
import { readKnowledgePage } from "./knowledgeRead";

/** Requests and writes for one project; without a token argument they use the signed-in identity. */
export const knowledgeApi = (projectId: string) => knowledgeClient("", projectId);

/**
 * Whether the service says this project has no external knowledge backend (`GET /projects/:id/capabilities`, the key `knowledge`, judged by the same rule as
 * the knowledge routes). "no" is only said when the service says so; a read that fails, a service that does not judge it, or a configured backend all read as
 * "go on": the knowledge reads are asked and answer for themselves. Kept for a minute, so a reread does not ask again.
 */
export type KnowledgeBackend = "none" | "maybe";
const backendKey = (projectId: string) => queryKeys.project(projectId, "knowledge-backend");
export function knowledgeBackendOf(view: ProjectCapabilitiesView): KnowledgeBackend {
  const knowledge = view.status === "available" ? view.items.find(item => item.key === "knowledge") : undefined;
  return knowledge?.state === "not_configured" ? "none" : "maybe";
}
export async function readKnowledgeBackend(projectId: string): Promise<KnowledgeBackend> {
  try { return knowledgeBackendOf(await api().projectCapabilities(projectId)); } catch { return "maybe"; }
}

/** The answer a project without a knowledge backend gives (the service's own code), produced here so the three knowledge reads do not go out to be refused. */
const notConfiguredAnswer = () => new ApiError(409, "当前项目尚未配置外置知识后端。", { code: "KNOWLEDGE_NOT_CONFIGURED" });

export function useKnowledgeIndex(projectId: string) {
  const client = useQueryClient();
  // The service's setting decides first. Without a backend the page says so (the same states as the service's refusal) and no request is sent for the
  // three reads (capabilities, pages, candidates); with one, or when this is not known, they go out as before.
  const guarded = <T,>(read: () => Promise<T>) => async (): Promise<T> => {
    const backend = await client.fetchQuery({ queryKey: backendKey(projectId), queryFn: () => readKnowledgeBackend(projectId), staleTime: 60_000 });
    if (backend === "none") throw notConfiguredAnswer();
    return read();
  };
  const capabilities = useProjectQuery(projectId, ["knowledge", "capabilities"], guarded(() => knowledgeApi(projectId).capabilities()));
  const pages = useProjectList(projectId, ["knowledge", "pages"], async cursor => { await guarded(async () => undefined)(); return knowledgeApi(projectId).pages(cursor); },
    (item: KnowledgeSummary) => item.knowledgeId);
  const candidates = useProjectList(projectId, ["knowledge", "candidates"], async cursor => { await guarded(async () => undefined)(); return knowledgeApi(projectId).candidates(cursor); },
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
