import type { Task } from "@evoloop/contracts";
import { DomainError, type Reader } from "@evoloop/contracts/ports";

/** Explicit concrete assignment wins over a same-Role guess; legacy work remains compatible. */
export async function requireAssignedSession(reader: Reader, task: Task, sessionId: string,
  establishedQueueClaim = false): Promise<void> {
  const assignment = await reader.sessionAssignments?.getTaskSessionAssignment(task.id);
  if (!assignment || assignment.state === "released") return;
  if (assignment.target.kind !== "owned" || assignment.target.sessionId !== sessionId)
    throw new DomainError("TASK_ASSIGNED_ELSEWHERE", "此任务已明确分派给另一会话，先依法交接或重新分派。");
  // An existing queue claim supplies its own independently checked, frozen business
  // input. Its Run lifecycle revisions do not rewrite an old manual acknowledgement.
  if (!establishedQueueClaim && assignment.taskRevisionId !== task.currentRevisionId)
    throw new DomainError("ASSIGNMENT_STALE", "任务依据已变化，请核对并重新确认具体分派。");
}
