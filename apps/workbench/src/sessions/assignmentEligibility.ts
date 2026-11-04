import type { Task } from "@evoloop/contracts";
import type { TaskSessionAssignment } from "@evoloop/contracts/session-assignments";
import type { SessionTarget } from "@evoloop/contracts/session-work";

export function sameSessionTarget(left: SessionTarget, right: SessionTarget): boolean {
  return left.kind === "owned"
    ? right.kind === "owned" && left.sessionId === right.sessionId
    : right.kind === "external" && left.linkId === right.linkId;
}

/** The directory may group several proven HostLinks under one canonical Session. */
export function assignedObservedSession<T extends { target: SessionTarget; aliases: SessionTarget[] }>(
  assignment: Pick<TaskSessionAssignment, "projectId" | "taskId" | "target"> | null,
  projectId: string, taskId: string, sessions: T[],
): T | undefined {
  if (!assignment || assignment.projectId !== projectId || assignment.taskId !== taskId) return undefined;
  return sessions.find(item => sameSessionTarget(item.target, assignment.target)
    || item.aliases.some(alias => sameSessionTarget(alias, assignment.target)));
}

/** A live concrete assignment fences new owned queue entries and Run reservations. */
export function eligibleOwnedSessions<T extends { id: string; roleId: string; state: string }>(
  task: Pick<Task, "projectId" | "id" | "owner" | "currentRevisionId">,
  sessions: T[], assignment: TaskSessionAssignment | null,
): T[] {
  if (assignment && (assignment.projectId !== task.projectId || assignment.taskId !== task.id)) return [];
  const live = assignment?.state === "released" ? null : assignment;
  if (live && (live.taskRevisionId !== task.currentRevisionId || live.target.kind === "external")) return [];
  return sessions.filter(session => session.state === "ready" && session.roleId === task.owner
    && (!live || live.target.kind === "owned" && live.target.sessionId === session.id));
}
