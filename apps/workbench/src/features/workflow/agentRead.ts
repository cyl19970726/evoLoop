// One agent (Session) read by its directory key, shared by every place the task page names an agent.
import type { ObservedSession } from "@evoloop/contracts/session-observation";
import { sessionClient } from "../../shared/sessionClient";

/** The agent behind `key`; an answer about another agent is refused rather than shown under this name. */
export async function readAgent(projectId: string, key: string, signal?: AbortSignal): Promise<ObservedSession> {
  const value = await sessionClient("", projectId).snapshot(key, signal);
  if (!value?.session || value.session.key !== key) throw new Error("智能体目录未返回这个智能体");
  return value.session;
}
