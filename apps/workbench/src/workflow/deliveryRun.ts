import type { RuntimeRunRecord } from "@evoloop/contracts";

/** Offer only confirmed terminal Runs from the current project's Task. The server rechecks input and ownership. */
export function attributableRuns(projectId: string, taskId: string, runs: RuntimeRunRecord[]): RuntimeRunRecord[] {
  return runs.filter(run => run.projectId === projectId && run.taskId === taskId
    && (run.state === "completed" || run.state === "failed" || run.state === "interrupted"));
}
