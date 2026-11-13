import type { PoolClient } from "pg";
import { DomainError } from "@evoloop/contracts/ports";
import type { DirectDispatchList, ScheduleDispatchPolicy, ScheduleDispatchTransaction } from "@evoloop/contracts/schedule-dispatch";

const iso = (value: unknown): string => value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
const policy = (row: Record<string, unknown>): ScheduleDispatchPolicy => ({ projectId: String(row.project_id), scheduleId: String(row.schedule_id), version: Number(row.version),
  mode: row.mode as ScheduleDispatchPolicy["mode"], state: row.state as ScheduleDispatchPolicy["state"], waitLimitMinutes: Number(row.wait_limit_minutes),
  dailyRunBudget: row.daily_run_budget === null ? null : Number(row.daily_run_budget), setRevisionId: String(row.set_revision_id),
  roleRevisionId: row.role_revision_id ? String(row.role_revision_id) : null, consecutiveFailures: Number(row.consecutive_failures), consecutiveSkips: Number(row.consecutive_skips),
  revertReason: row.revert_reason ? String(row.revert_reason) : null, actorId: String(row.actor_id), reason: String(row.reason), updatedAt: iso(row.updated_at) });

/** Scheduled direct dispatch records (migration 108) inside the command transaction. */
export class PgScheduleDispatch implements ScheduleDispatchTransaction {
  constructor(private readonly client: PoolClient, private readonly projectId: string) {}

  async getDispatchPolicy(scheduleId: string): Promise<ScheduleDispatchPolicy | null> {
    const r = await this.client.query("SELECT * FROM schedule_dispatch_policy WHERE project_id=$1 AND schedule_id=$2", [this.projectId, scheduleId]);
    return r.rows[0] ? policy(r.rows[0]) : null;
  }
  async saveDispatchPolicy(value: Parameters<ScheduleDispatchTransaction["saveDispatchPolicy"]>[0], expectedVersion: number, approve: boolean): Promise<ScheduleDispatchPolicy> {
    const current = await this.client.query(`SELECT d.current_revision_id, (r.task_template->>'owner') AS owner FROM schedule_definition d
      JOIN schedule_revision r ON r.project_id=d.project_id AND r.schedule_id=d.schedule_id AND r.revision_id=d.current_revision_id WHERE d.project_id=$1 AND d.schedule_id=$2`, [this.projectId, value.scheduleId]);
    if (!current.rows[0]) throw new DomainError("NOT_FOUND", "schedule was not found");
    const role = await this.client.query("SELECT current_revision_id FROM role_definition WHERE project_id=$1 AND role_id=$2::uuid", [this.projectId, current.rows[0].owner]);
    if (expectedVersion === 0) {
      await this.client.query(`INSERT INTO schedule_dispatch_policy(project_id,schedule_id,version,mode,state,wait_limit_minutes,daily_run_budget,set_revision_id,role_revision_id,actor_id,reason,updated_at)
        VALUES($1,$2,1,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [this.projectId, value.scheduleId, value.mode, value.state, value.waitLimitMinutes, value.dailyRunBudget,
        current.rows[0].current_revision_id, role.rows[0]?.current_revision_id ?? null, value.actorId, value.reason, value.updatedAt]);
    } else {
      // Approving direct dispatch (re)records the template and Role revision it is approved for, and clears the breaker and the skip count.
      const r = await this.client.query(`UPDATE schedule_dispatch_policy SET version=version+1,mode=$4,state=$5,wait_limit_minutes=$6,daily_run_budget=$7,actor_id=$8,reason=$9,updated_at=$10,
        set_revision_id=CASE WHEN $11 THEN $12::uuid ELSE set_revision_id END, role_revision_id=CASE WHEN $11 THEN $13::uuid ELSE role_revision_id END,
        consecutive_failures=CASE WHEN $11 THEN 0 ELSE consecutive_failures END, consecutive_skips=CASE WHEN $11 THEN 0 ELSE consecutive_skips END,
        revert_reason=CASE WHEN $11 THEN NULL ELSE revert_reason END
        WHERE project_id=$1 AND schedule_id=$2 AND version=$3`, [this.projectId, value.scheduleId, expectedVersion, value.mode, value.state, value.waitLimitMinutes,
        value.dailyRunBudget, value.actorId, value.reason, value.updatedAt, approve, current.rows[0].current_revision_id, role.rows[0]?.current_revision_id ?? null]);
      if (r.rowCount !== 1) throw new DomainError("VERSION_CONFLICT", "The dispatch policy changed");
    }
    return (await this.getDispatchPolicy(value.scheduleId))!;
  }
  async getDirectList(roleId: string): Promise<DirectDispatchList | null> {
    const r = await this.client.query("SELECT * FROM direct_dispatch_list WHERE project_id=$1 AND role_id=$2", [this.projectId, roleId]);
    const row = r.rows[0];
    return row ? { projectId: this.projectId, roleId, version: Number(row.version), sessionIds: row.session_ids, actorId: row.actor_id, reason: row.reason, updatedAt: iso(row.updated_at) } : null;
  }
  async saveDirectList(value: DirectDispatchList, expectedVersion: number): Promise<void> {
    if (expectedVersion === 0) {
      await this.client.query(`INSERT INTO direct_dispatch_list(project_id,role_id,version,session_ids,actor_id,reason,updated_at) VALUES($1,$2,1,$3::uuid[],$4,$5,$6)`,
        [this.projectId, value.roleId, value.sessionIds, value.actorId, value.reason, value.updatedAt]);
      return;
    }
    const r = await this.client.query(`UPDATE direct_dispatch_list SET version=version+1,session_ids=$4::uuid[],actor_id=$5,reason=$6,updated_at=$7 WHERE project_id=$1 AND role_id=$2 AND version=$3`,
      [this.projectId, value.roleId, expectedVersion, value.sessionIds, value.actorId, value.reason, value.updatedAt]);
    if (r.rowCount !== 1) throw new DomainError("VERSION_CONFLICT", "The direct list changed");
  }
  async enqueueTodoNotice(taskId: string, at: string): Promise<void> {
    await this.client.query(`SELECT enqueue_leader_result_notice(t.project_id,'task_todo',t.current_revision_id,t.task_id,t.current_revision_id,NULL,'dispatcher:schedule',
      'task:'||t.task_id||'@'||t.current_revision_id,$3::timestamptz) FROM task t WHERE t.project_id=$1 AND t.task_id=$2`, [this.projectId, taskId, at]);
  }
  async markWithdrawn(taskId: string, choice: "cancel" | "to_leader", at: string): Promise<void> {
    // A dispatch that already happened stays dispatched (it counts against the daily budget); only the reason notes what became of its Task.
    await this.client.query(`UPDATE schedule_dispatch_log SET state=CASE WHEN state='pending' THEN 'fell_back' ELSE state END,reason=$3,decided_at=CASE WHEN state='pending' THEN $4::timestamptz ELSE decided_at END WHERE project_id=$1 AND task_id=$2 AND state IN ('pending','dispatched')`,
      [this.projectId, taskId, choice === "cancel" ? "WITHDRAWN_CANCELLED" : "WITHDRAWN_TO_LEADER", at]);
  }
}
