import type { PoolClient } from "pg";
import type { ScheduleHealthFacts, ScheduleHealthReader } from "@evoloop/contracts/routine-health";

const iso = (value: unknown): string => new Date(value as string | Date).toISOString();
const maxRows = 1000;

/**
 * 例行健康 facts for every schedule of the project in one query: the latest trigger record with the Task it made, the latest Task any record made, and the
 * skipped records after the last one that was not skipped (counted from the records, whatever the dispatch mode). Read-only; no table of its own.
 */
export class PgRoutineHealth implements ScheduleHealthReader {
  constructor(private readonly client: PoolClient, private readonly projectId: string) {}

  async scheduleHealthFacts(): Promise<ScheduleHealthFacts[]> {
    const result = await this.client.query(`SELECT d.schedule_id,
        lo.planned_at_utc AS last_planned,lo.observed_at_utc AS last_observed,lo.state AS last_state,lo.reason AS last_reason,
        lo.task_id AS last_task_id,lt.title AS last_task_title,lt.state AS last_task_state,
        ct.task_id AS made_task_id,ct.title AS made_task_title,ct.state AS made_task_state,
        (SELECT count(*) FROM schedule_occurrence s WHERE s.project_id=d.project_id AND s.schedule_id=d.schedule_id AND s.state='skipped'
          AND s.planned_at_utc>COALESCE((SELECT max(n.planned_at_utc) FROM schedule_occurrence n
            WHERE n.project_id=d.project_id AND n.schedule_id=d.schedule_id AND n.state<>'skipped'),'-infinity'::timestamptz)) AS consecutive_skips
      FROM schedule_definition d
      LEFT JOIN LATERAL (SELECT * FROM schedule_occurrence o WHERE o.project_id=d.project_id AND o.schedule_id=d.schedule_id
        ORDER BY o.planned_at_utc DESC LIMIT 1) lo ON true
      LEFT JOIN task lt ON lt.project_id=d.project_id AND lt.task_id=lo.task_id
      LEFT JOIN LATERAL (SELECT t.task_id,t.title,t.state FROM schedule_occurrence o JOIN task t ON t.project_id=o.project_id AND t.task_id=o.task_id
        WHERE o.project_id=d.project_id AND o.schedule_id=d.schedule_id AND o.task_id IS NOT NULL ORDER BY o.planned_at_utc DESC LIMIT 1) ct ON true
      WHERE d.project_id=$1 ORDER BY d.schedule_id LIMIT $2`, [this.projectId, maxRows + 1]);
    if (result.rows.length > maxRows) throw new Error(`schedule health exceeds ${maxRows} schedules`);
    return result.rows.map(row => ({
      scheduleId: row.schedule_id,
      last: row.last_planned ? { plannedAtUtc: iso(row.last_planned), observedAtUtc: iso(row.last_observed), state: row.last_state, reason: row.last_reason,
        task: row.last_task_id ? { taskId: row.last_task_id, title: row.last_task_title, state: row.last_task_state } : null } : null,
      lastTask: row.made_task_id ? { taskId: row.made_task_id, title: row.made_task_title, state: row.made_task_state } : null,
      consecutiveSkips: Number(row.consecutive_skips),
    }));
  }
}
