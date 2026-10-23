import type { Pool } from "pg";
import { loopIntentId } from "./runner.js";

/** Check managed ownership before the first native request, including before Run/resolve rows exist. */
export function managedRuntimeAdmission(pool: Pick<Pool, "query">) {
  return async (projectId: string, kind: "run" | "session", id: string): Promise<boolean> => {
    const result = await pool.query(`SELECT d.dispatch_id,d.data->>'runtimeRunId' AS run_id,l.state FROM orchestration_dispatch d JOIN orchestration_loop l
      ON l.project_id=d.project_id AND l.loop_id=d.loop_id WHERE d.project_id=$1`, [projectId]);
    const managed = result.rows.filter(row => loopIntentId(row.dispatch_id, kind) === id || kind === "run" && row.run_id === id);
    return managed.every(row => row.state === "active");
  };
}
