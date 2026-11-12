// Names for records that are stored by identifier: a role's title, an agent's name, a task's title. Each is read on
// its own (cached per project), so a list never waits on them; until a name is back the text says "名称待读取", and
// the identifier itself belongs in the full-identifier layer, not here. An agent is named as the agent pages name it
// (agentDisplayName), from its directory record (the same read as the task's right column and return links).
import type { ObservedSession } from "@evoloop/contracts/session-observation";
import { agentDisplayName, agentNameIsGenerated } from "../agentNamePresentation";
import { agentNameKey, readAgent } from "../agentRead";
import { ApiError, api } from "../api";
import { isRoleOwnerId, readOwnerRole } from "../ownerRole";
import { useProjectQuery } from "../query";
import type { LeaderWorkTask } from "@evoloop/contracts/work-index";
import { MIGRATION_PLACEHOLDER_OWNER, nameOnly, nameText, responsibleSessionKey, responsibleText, type NameRead } from "../workPresentation";

/** A name as read: a record that is not there (404) is said as such, any other failure as unreadable. */
export function readOf<T>(query: { data?: T; isError: boolean; error?: unknown }, name: (value: T) => string | null | undefined): NameRead {
  if (query.data !== undefined) {
    const text = name(query.data)?.trim();
    return text ? { state: "named", name: text } : { state: "unnamed" };
  }
  if (!query.isError) return { state: "reading" };
  return query.error instanceof ApiError && query.error.status === 404 ? { state: "missing" } : { state: "failed" };
}

/** A role's title. An owner that is not a role identifier has no title to read. */
export function useRoleName(projectId: string, roleId: string | null | undefined): NameRead {
  const enabled = !!roleId && isRoleOwnerId(roleId);
  // Same key and value as the documents page's owner names, so the two share one read.
  const query = useProjectQuery(projectId, ["role", roleId, "title"], signal => readOwnerRole("", projectId, roleId!, signal), { enabled });
  if (roleId === MIGRATION_PLACEHOLDER_OWNER) return { state: "unassigned" };
  return enabled ? readOf(query, role => role.proposal.title) : { state: "failed" };
}

/** An agent's name as read from its directory record: agentDisplayName, marked when it already says the agent's kind. */
export function agentNameRead(query: { data?: ObservedSession; isError: boolean; error?: unknown }): NameRead {
  const read = readOf(query, agentDisplayName);
  return read.state === "named" && query.data && agentNameIsGenerated(query.data) ? { ...read, describesKind: true } : read;
}

/**
 * An agent's name, said as the agent pages say it (agentDisplayName): its registered name, or for a generated title its
 * role and kind (“功能开发 · 外部接入的智能体”), never the short identifier of the service's generated title.
 */
export function useSessionName(projectId: string, sessionKey: string | null | undefined): NameRead {
  const query = useProjectQuery(projectId, agentNameKey(sessionKey), signal => readAgent(projectId, sessionKey!, signal), { enabled: !!sessionKey });
  return sessionKey ? agentNameRead(query) : { state: "failed" };
}

/** A task's current title. */
export function useTaskName(projectId: string, taskId: string | null | undefined): NameRead {
  const query = useProjectQuery(projectId, ["name", "task", taskId], async () => {
    const detail = await api().task(projectId, taskId!);
    if (detail.task.projectId !== projectId || detail.task.id !== taskId) throw new Error("任务响应与所选任务不符");
    return detail.task.title;
  }, { enabled: !!taskId });
  return taskId ? readOf(query, title => title) : { state: "failed" };
}

/** "开发职责", or "职责（名称待读取）". */
export function RoleName({ projectId, roleId }: { projectId: string; roleId: string }) {
  return <>{nameOnly("职责", useRoleName(projectId, roleId))}</>;
}

/** "智能体 · 前端"; a generated name alone (“功能开发 · 受管智能体”), since it already says the kind. */
export function SessionName({ projectId, sessionKey, kind = "智能体" }: { projectId: string; sessionKey: string; kind?: string }) {
  return <>{nameText(kind, useSessionName(projectId, sessionKey))}</>;
}

/** Who acts next on a work-index row, by kind and name: "职责 · 开发职责", "智能体（名称待读取）", "指定验收者". */
export function ResponsibleName({ projectId, item }: { projectId: string; item: Pick<LeaderWorkTask, "responsible" | "assignment"> }) {
  const { responsible, assignment } = item;
  const role = useRoleName(projectId, responsible.kind === "role" ? responsible.id : null);
  const session = useSessionName(projectId, responsibleSessionKey(responsible, assignment));
  const task = useTaskName(projectId, responsible.kind === "task" ? responsible.id : null);
  return <>{responsibleText(responsible, assignment, responsible.kind === "role" ? role : responsible.kind === "session" ? session : task)}</>;
}
