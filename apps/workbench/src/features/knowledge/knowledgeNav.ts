// 知识空间 does not take a place in the menu of a project that has no knowledge backend (the decision on 空页面不占菜单). The signal is the service's own:
// the knowledge read is refused with 409 KNOWLEDGE_NOT_CONFIGURED. Any other failure, or a read that
// has not finished, hides nothing.
// Kept free of the page's own modules: the shell loads this on every page, so it only touches the small shared clients.
import { ApiError } from "../../shared/api";
import { knowledgeClient } from "../../shared/knowledgeClient";
import { useProjectQuery } from "../../shared/query";

const notConfiguredCode = "KNOWLEDGE_NOT_CONFIGURED";

export async function readKnowledgeConfigured(projectId: string): Promise<"none" | "maybe"> {
  try { await knowledgeClient("", projectId).capabilities(); return "maybe"; }
  catch (error) {
    const code = error instanceof ApiError && error.status === 409 ? (error.detail as { code?: string } | undefined)?.code : undefined;
    return code === notConfiguredCode ? "none" : "maybe";
  }
}

export function useKnowledgeMenuEmpty(projectId: string, enabled: boolean): boolean {
  const read = useProjectQuery(projectId, ["nav", "knowledge"], () => readKnowledgeConfigured(projectId), { enabled: enabled && !!projectId, retry: false });
  return read.data === "none";
}
