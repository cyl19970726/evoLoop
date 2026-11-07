import type { Transaction } from "@evoloop/contracts/ports";
import { DomainError } from "@evoloop/contracts/ports";

/** The planned instant and predecessor gate normal Task admission. */
export async function requireTaskTimingReady(tx: Transaction, taskId: string, nowUtc: string): Promise<void> {
  const timing = await tx.taskTiming?.get(taskId);
  if (!timing) return;
  if (Date.parse(nowUtc) < Date.parse(timing.executeAtUtc))
    throw new DomainError("TASK_NOT_DUE", `Task is scheduled for ${timing.executeAtUtc}`);
  if (!timing.previousTaskId) return;
  const previous = await tx.getTask(timing.previousTaskId);
  if (!previous) throw new DomainError("TASK_SERIES_WAITING", "Previous series Task is unavailable");
  if (previous.state !== "done" && previous.state !== "cancelled")
    throw new DomainError("TASK_SERIES_WAITING", `Previous Task ${previous.id} is ${previous.state}`);
  if ((await tx.listRuntimeRuns(previous.id)).some(run => ["requested", "dispatching", "running", "unknown"].includes(run.state)))
    throw new DomainError("TASK_SERIES_WAITING", `Previous Task ${previous.id} has an unsettled Run`);
}
