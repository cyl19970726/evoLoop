import type { Task } from "@evoloop/contracts";
import type { TaskSessionAssignment } from "@evoloop/contracts/session-assignments";

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
