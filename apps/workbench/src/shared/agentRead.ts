// One agent (Session) read by its directory key, shared by every page that names an agent: the same query key
// (`agentNameKey`) and value everywhere, so a task's header, its tables and a return link share one read and say the
// same name (agentDisplayName).
import type { ObservedSession } from "@evoloop/contracts/session-observation";
import { sessionClient } from "./sessionClient";

/** The project query key of one agent's directory record. */
export const agentNameKey = (key: string | null | undefined) => ["session-names", key] as const;

/** The agent behind `key`; an answer about another agent is refused rather than shown under this name. */
export async function readAgent(projectId: string, key: string, signal?: AbortSignal): Promise<ObservedSession> {
  const value = await sessionClient("", projectId).snapshot(key, signal);
  if (!value?.session || value.session.key !== key) throw new Error("智能体目录未返回这个智能体");
  return value.session;
}
