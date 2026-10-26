import type { RuntimeRunRecord } from "@evoloop/contracts";
import { taskSectionHref } from "../orchestration/navigation";

/** Offer only confirmed terminal Runs from the current project's Task. The server rechecks input and ownership. */
export function attributableRuns(projectId: string, taskId: string, runs: RuntimeRunRecord[]): RuntimeRunRecord[] {
  return runs.filter(run => run.projectId === projectId && run.taskId === taskId
    && (run.state === "completed" || run.state === "failed" || run.state === "interrupted"));
}

/** A Delivery declaration earns navigation only after the exact Run read matches its scope. */
export function verifiedDeliveryRun(projectId: string, taskId: string, runId: string, run: RuntimeRunRecord): RuntimeRunRecord | null {
  return run.projectId === projectId && run.taskId === taskId && run.id === runId ? run : null;
}

export function deliveryRunHref(projectId: string, taskId: string, runId: string): string {
  return `${taskSectionHref(projectId, taskId, { tab: "runtime" })}&run=${encodeURIComponent(runId)}`;
}
