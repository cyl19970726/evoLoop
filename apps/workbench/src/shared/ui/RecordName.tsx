// Names for records that are stored by identifier: a role's title, an agent's registered name, a task's title.
// Each is read on its own (cached per project), so a list never waits on them; until a name is back the text says
// "名称待读取", and the identifier itself belongs in the full-identifier layer, not here.
import type { SessionProfileRecord } from "@evoloop/contracts/session-assignments";
import { ApiError, api, requestNullable } from "../api";
import { isRoleOwnerId, readOwnerRole } from "../ownerRole";
import { useProjectQuery } from "../query";
import type { LeaderWorkTask } from "@evoloop/contracts/work-index";
import { nameOnly, nameText, responsibleSessionKey, responsibleText, type NameRead } from "../workPresentation";

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
  return enabled ? readOf(query, role => role.proposal.title) : { state: "failed" };
}

/** An agent's registered name. Only an explicitly registered name counts; a generated title is not a name. */
export function useSessionName(projectId: string, sessionKey: string | null | undefined): NameRead {
  const query = useProjectQuery(projectId, ["name", "session", sessionKey], async signal => {
    // No registered profile is an answer (null), not a failure.
    const profile = await requestNullable<SessionProfileRecord>("",
      `/api/projects/${encodeURIComponent(projectId)}/session-work/${encodeURIComponent(sessionKey!)}/profile`, 15000, signal);
    if (profile && profile.projectId !== projectId) throw new Error("智能体名称响应不属于当前项目");
    return profile ?? null;
  }, { enabled: !!sessionKey });
  return sessionKey ? readOf(query, profile => profile?.displayName) : { state: "failed" };
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

/** "智能体 · 前端"; "智能体（未登记名称）" when no name was registered. */
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
