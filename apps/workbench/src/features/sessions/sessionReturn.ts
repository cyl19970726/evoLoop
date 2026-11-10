// 从任务进入后返回任务: a link into an agent may carry where it came from (`return`, `actor`, `returnTitle`, the same
// parameters a task page reads for its way back to an agent). The agent page offers the way back only for a task of
// this project and only to the identity the link was made for.
import { isProjectRoute } from "../../shared/ui/returnRoute";

export interface SessionSource { href: string; title: string }

/** The task this agent page was opened from, or null. */
export function sessionTaskReturn(path: string, projectId: string, sessionKey: string, actorId: string): SessionSource | null {
  const params = new URLSearchParams(path.split("?")[1] ?? "");
  const target = params.get("return");
  if (params.get("session") !== sessionKey || params.getAll("return").length !== 1 || params.get("actor") !== actorId) return null;
  if (!isProjectRoute(target, projectId) || !/\/tasks\/[0-9a-f-]{36}$/i.test(target.split("?")[0]!)) return null;
  return { href: target, title: params.get("returnTitle")?.trim().slice(0, 80) || "来源任务" };
}

/** The parameters that keep the way back when the agent page rewrites its own address. */
export function sourceParams(path: string): Array<[string, string]> {
  const params = new URLSearchParams(path.split("?")[1] ?? "");
  return (["return", "actor", "returnTitle"] as const).flatMap(name => params.has(name) ? [[name, params.get(name)!] as [string, string]] : []);
}
