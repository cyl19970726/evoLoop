// 返回来源: a link into an agent may carry where it came from (`return`, `actor`, `returnTitle`; shared/returnLink.ts).
// The agent page offers the way back to that page of this project — a task, the task table, 统筹安排, a document or a
// work section — only to the reader the link was made for, and never back to this same agent.
import { readReturn, returnKeys, type ReturnPlace } from "../../shared/returnLink";

export interface SessionSource { href: string; title: string | null; label: string; place: ReturnPlace }

/** The page this agent page was opened from, or null. */
export function sessionTaskReturn(path: string, projectId: string, sessionKey: string, actorId: string): SessionSource | null {
  const params = new URLSearchParams(path.split("?")[1] ?? "");
  if (params.get("session") !== sessionKey) return null;
  const source = readReturn(path, projectId, actorId);
  if (!source || source.place.kind === "agent" && source.place.sessionKey === sessionKey) return null;
  return source;
}

/** The parameters that keep the way back when the agent page rewrites its own address. */
export function sourceParams(path: string): Array<[string, string]> {
  const params = new URLSearchParams(path.split("?")[1] ?? "");
  return returnKeys.flatMap(name => params.has(name) ? [[name, params.get(name)!] as [string, string]] : []);
}
