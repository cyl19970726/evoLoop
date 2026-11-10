// 负责职责与同职责的其他智能体: which bound agents can be offered as entries, and what the reader is told about the rest.
import type { RoleSessionBinding } from "@evoloop/contracts/roles";
import type { RuntimeSessionRecord } from "@evoloop/contracts/runtime";
import { ApiError, errorText } from "../../shared/api";

export const ownerSessionState: Record<RuntimeSessionRecord["state"], string> = {
  reserved: "已预留", creating: "创建中", ready: "就绪", closing: "关闭中", unknown: "状态未知", closed: "已关闭",
};

/**
 * The agents bound to the owner Role that are also registered in this project for that Role. A binding whose agent
 * cannot be matched is not offered as an entry; the note says so. A binding never means the agent runs this task.
 */
export function boundAgents(projectId: string, owner: string, bindings: RoleSessionBinding[], sessions: RuntimeSessionRecord[]):
  { agents: RuntimeSessionRecord[]; note: string | null } {
  // A record of another project in either answer is reported, never filtered out quietly.
  if (bindings.some(item => item.projectId !== projectId || item.roleId !== owner) || sessions.some(item => item.projectId !== projectId))
    throw new Error("智能体关联响应与当前项目不符");
  const bound = new Set(bindings.map(item => item.sessionId));
  const agents = sessions.filter(item => bound.has(item.id) && item.roleId === owner);
  if (bound.size > agents.length) return { agents, note: "部分绑定记录未能核对到同项目、同职责的智能体，未提供它们的入口。" };
  if (bound.size === 0) return { agents, note: "这项职责还没有登记绑定的智能体；任务具体由谁承接看右栏。" };
  return { agents, note: null };
}

/** Why the owner Role is not shown: not registered (a 404 is an answer), or cannot be checked now. */
export function ownerRoleProblem(error: unknown): string {
  return error instanceof ApiError && error.status === 404 ? "未找到已登记职责" : `职责暂不可核对：${errorText(error)}`;
}
