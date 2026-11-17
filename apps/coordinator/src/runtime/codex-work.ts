import type { Pool } from "pg";

/**
 * Whether anything other than `exceptMessageId` is running on the Codex runtime: a message Turn or Run that is dispatching, running or unknown, or a live native Turn in progress.
 * Replacing the Codex child ends them all, so a replacement is only made when this is false (defect 548712ac). Sessions of other providers do not count.
 */
export async function codexWorkInFlight(pool: Pick<Pool, "query">, exceptMessageId: string): Promise<boolean> {
  const rows = await pool.query(`SELECT
      (SELECT count(*)::int FROM session_message_processing p JOIN runtime_session s ON s.project_id=p.project_id AND s.session_id=p.session_id
        WHERE s.runtime_provider='codex' AND p.state IN ('dispatching','running','unknown') AND p.message_id<>$1) AS messages,
      (SELECT count(*)::int FROM runtime_run r JOIN runtime_session s ON s.project_id=r.project_id AND s.session_id=r.session_id
        WHERE s.runtime_provider='codex' AND r.state IN ('dispatching','running','unknown')) AS runs,
      (SELECT count(*)::int FROM session_native_observation o WHERE o.freshness='live' AND o.projection->'currentTurn'->>'status'='inProgress') AS turns`, [exceptMessageId]);
  const row = rows.rows[0] as { messages: number; runs: number; turns: number };
  return row.messages + row.runs + row.turns > 0;
}
