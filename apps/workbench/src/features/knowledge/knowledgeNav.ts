// 知识空间 takes a place in the menu only once the project has a knowledge backend. The signal is the service's own: the capabilities read
// answers; a refusal with 409 KNOWLEDGE_NOT_CONFIGURED, any other failure, or a read that has not finished lists nothing.
// Kept free of the page's own modules: the shell loads this on every page, so it only touches the small shared clients.
import { ApiError } from "../../shared/api";
import { knowledgeClient } from "../../shared/knowledgeClient";
import { useProjectQuery } from "../../shared/query";

const notConfiguredCode = "KNOWLEDGE_NOT_CONFIGURED";

export async function readKnowledgeConfigured(projectId: string): Promise<"none" | "configured" | "unknown"> {
  try { await knowledgeClient("", projectId).capabilities(); return "configured"; }
  catch (error) {
    const code = error instanceof ApiError && error.status === 409 ? (error.detail as { code?: string } | undefined)?.code : undefined;
    return code === notConfiguredCode ? "none" : "unknown";
  }
}

export function useKnowledgeConfigured(projectId: string, enabled: boolean): boolean {
  const read = useProjectQuery(projectId, ["nav", "knowledge"], () => readKnowledgeConfigured(projectId), { enabled: enabled && !!projectId, retry: false });
  return read.data === "configured";
}
