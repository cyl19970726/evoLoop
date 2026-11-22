// 知识空间 does not take a place in the menu of a project that has no knowledge backend (the decision on 空页面不占菜单). The signal is the service's own:
// the capabilities setting says "not configured", or the knowledge read is refused with 409 KNOWLEDGE_NOT_CONFIGURED. Any other failure, or a read that
// has not finished, hides nothing.
import { ApiError } from "../../shared/api";
import { useProjectQuery } from "../../shared/query";
import { knowledgeApi, readKnowledgeBackend } from "./knowledgeData";
import { notConfiguredCode } from "./knowledgePresentation";

export async function readKnowledgeConfigured(projectId: string): Promise<"none" | "maybe"> {
  if (await readKnowledgeBackend(projectId) === "none") return "none";
  try { await knowledgeApi(projectId).capabilities(); return "maybe"; }
  catch (error) {
    const code = error instanceof ApiError && error.status === 409 ? (error.detail as { code?: string } | undefined)?.code : undefined;
    return code === notConfiguredCode ? "none" : "maybe";
  }
}

export function useKnowledgeMenuEmpty(projectId: string, enabled: boolean): boolean {
  const read = useProjectQuery(projectId, ["nav", "knowledge"], () => readKnowledgeConfigured(projectId), { enabled: enabled && !!projectId, retry: false });
  return read.data === "none";
}
