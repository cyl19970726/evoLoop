import type { Pool } from "pg";
import type { Principal } from "@evoloop/contracts";

/**
 * The service process's dispatcher for scheduled direct dispatch (DEC-045 S1). The occurrence made the Task and a pending log row in one transaction;
 * this appends the Task to the line of the best Session on the Role's direct list, or hands it to the Leader when no Session can take it. It finishes
 * whatever is still pending, so a restart between the two steps loses nothing, and it tells the Leader when a dispatched Task waits past its limit.
 */
export interface DirectDispatchDeps {
  pool: Pool;
  workflow: { execute(principal: Principal, command: never): Promise<{ status: string; entityId?: string; code?: string; message?: string }> };
  /**
   * Why this Session may not be sent scheduled work, or null when it may: its execution authorization (the private configuration's runtime grant for
   * its Role and scope, which `runtime.run.reserve` will need) is read afresh at every trigger. Absent: no extra filter.
   */
  sessionDenial?(projectId: string, sessionId: string): Promise<string | null>;
  /**
   * Why the Session line could not use this Session's signing identity (the line pump resolves it with the same function): a Role shared by several live
   * Sessions needs the Session's own materialCli entry, and the identity must be a current project writer. Null when it resolves. Absent: no extra filter.
   */
  recipientDenial?(projectId: string, sessionId: string): Promise<string | null>;
  newId(): string;
}

interface Candidate { sid: string; ord: number; qlen: number; running: boolean; ready: boolean; gateOpen: boolean; profileOk: boolean; headSuspended: boolean }
const LIVE = "('queued','suspended','starting','started')";
/** A line entry only counts while its Task is open: the entry of a cancelled or closed Task is a stale occupant, never work waiting. */
const OPEN_ENTRY = `e.state IN ${LIVE} AND EXISTS(SELECT 1 FROM task tt WHERE tt.project_id=e.project_id AND tt.task_id=e.task_id AND tt.state NOT IN ('done','cancelled'))`;

export class ScheduleDirectDispatcher {
  constructor(private readonly deps: DirectDispatchDeps) {}

  async process(projectId: string, principal: Principal, now: string): Promise<{ dispatched: number; fellBack: number }> {
    const counts = { dispatched: 0, fellBack: 0 };
    await this.clearStaleOccupants(projectId, principal);
    const pending = await this.deps.pool.query(`SELECT l.schedule_id, l.planned_at_utc, o.task_id, (r.task_template->>'owner') AS owner
      FROM schedule_dispatch_log l
      JOIN schedule_occurrence o ON o.project_id=l.project_id AND o.schedule_id=l.schedule_id AND o.planned_at_utc=l.planned_at_utc
      JOIN schedule_definition d ON d.project_id=l.project_id AND d.schedule_id=l.schedule_id
      JOIN schedule_revision r ON r.project_id=d.project_id AND r.schedule_id=d.schedule_id AND r.revision_id=d.current_revision_id
      WHERE l.project_id=$1 AND l.state='pending' AND o.task_id IS NOT NULL ORDER BY l.planned_at_utc LIMIT 50`, [projectId]);
    for (const row of pending.rows) {
      const plannedAt = (row.planned_at_utc as Date).toISOString();
      const fallBack = async (reason: string, blocked: boolean) => {
        await this.deps.pool.query("SELECT schedule_direct_fall_back($1,$2,$3::timestamptz,$4,$5,$6::timestamptz)", [projectId, row.schedule_id, plannedAt, reason, blocked, now]);
        counts.fellBack++;
      };
      const picked = await this.choose(projectId, String(row.owner));
      if (!picked.sessionId) { await fallBack(picked.denial ?? "NO_AVAILABLE_SESSION", true); continue; }
      const chosen = picked.sessionId;
      const task = await this.deps.pool.query("SELECT version FROM task WHERE project_id=$1 AND task_id=$2", [projectId, row.task_id]);
      const result = await this.deps.workflow.execute(principal, { type: "line.append", projectId, operationId: this.deps.newId(), sessionId: chosen, taskId: row.task_id,
        expectedTaskVersion: task.rows[0].version, source: "schedule", scheduleId: row.schedule_id, reason: `Scheduled direct dispatch for ${plannedAt}` } as never)
        .catch((error: { code?: string; message?: string }): { status: string; entityId?: string; code?: string; message?: string } => ({ status: "rejected", code: error.code ?? "ERROR", message: error.message ?? "" }));
      if (result.status !== "applied") { await fallBack(`APPEND_${result.code ?? "REJECTED"}`, true); continue; }
      await this.deps.pool.query(`UPDATE schedule_dispatch_log SET state='dispatched',task_id=$4,session_id=$5,entry_id=$6,dispatched_at=$7::timestamptz
        WHERE project_id=$1 AND schedule_id=$2 AND planned_at_utc=$3::timestamptz AND state='pending'`, [projectId, row.schedule_id, plannedAt, row.task_id, chosen, result.entityId, now]);
      counts.dispatched++;
    }
    await this.escalateWaiting(projectId, now);
    return counts;
  }

  /** A dispatched Task still waiting in its line past the schedule's limit is told to the Leader once, at once. */
  private async escalateWaiting(projectId: string, now: string): Promise<void> {
    await this.deps.pool.query(`WITH late AS (
        UPDATE schedule_dispatch_log l SET escalated_at=$2::timestamptz
        FROM schedule_dispatch_policy p, session_line_entry e
        WHERE l.project_id=$1 AND l.state='dispatched' AND l.escalated_at IS NULL AND p.project_id=l.project_id AND p.schedule_id=l.schedule_id
          AND e.project_id=l.project_id AND e.entry_id=l.entry_id AND e.state IN ('queued','suspended','starting')
          AND $2::timestamptz >= l.dispatched_at + make_interval(mins => p.wait_limit_minutes)
        RETURNING l.schedule_id, l.planned_at_utc, l.task_id)
      SELECT enqueue_leader_result_notice($1,'direct_dispatch_blocked',schedule_dispatch_uuid(late.schedule_id,late.planned_at_utc,'wait'),late.task_id,t.current_revision_id,NULL,
        'dispatcher:schedule','schedule:'||late.schedule_id||':wait-limit@'||late.planned_at_utc,$2::timestamptz)
      FROM late JOIN task t ON t.project_id=$1 AND t.task_id=late.task_id`, [projectId, now]);
  }

  /** The entry of a scheduled Task that was cancelled or closed still sits in its line (a suspended or started head blocks the Session for good): clear it. */
  private async clearStaleOccupants(projectId: string, principal: Principal): Promise<void> {
    const stale = await this.deps.pool.query(`SELECT e.entry_id, e.version FROM session_line_entry e JOIN task t ON t.project_id=e.project_id AND t.task_id=e.task_id
      WHERE e.project_id=$1 AND e.source='schedule' AND e.state IN ${LIVE} AND t.state IN ('done','cancelled') ORDER BY e.appended_at LIMIT 50`, [projectId]);
    for (const row of stale.rows) {
      await this.deps.workflow.execute(principal, { type: "schedule.directEntry.withdraw", projectId, operationId: this.deps.newId(), entryId: row.entry_id,
        expectedVersion: row.version, choice: "cancel", reason: "The scheduled Task is already cancelled or closed" } as never).catch(() => undefined);
    }
  }

  /**
   * Idle first, then the shortest line, then the list's own order. A Session is passed over when it is not ready, its recovery gate is closed, its execution
   * profile is refused, the head of its line is suspended, its execution authorization is missing, or its signing identity does not resolve. Nobody left:
   * the reason of the first listed Session (in list order) is the reason given, never a different one.
   */
  private async choose(projectId: string, roleId: string): Promise<{ sessionId: string | null; denial: string | null }> {
    const rows = (await this.deps.pool.query<Candidate>(`WITH list AS (SELECT s.sid, s.ord FROM direct_dispatch_list l, unnest(l.session_ids) WITH ORDINALITY s(sid,ord)
        WHERE l.project_id=$1 AND l.role_id::text=$2)
      SELECT list.sid::text AS sid, list.ord::int AS ord,
        (SELECT count(*)::int FROM session_line_entry e WHERE e.project_id=$1 AND e.session_id=list.sid AND ${OPEN_ENTRY}) AS qlen,
        EXISTS(SELECT 1 FROM runtime_run r WHERE r.project_id=$1 AND r.session_id=list.sid AND r.state IN ('requested','dispatching','running','unknown')) AS running,
        COALESCE(rs.state='ready' AND rs.role_id=$2,false) AS ready,
        NOT EXISTS(SELECT 1 FROM session_recovery_gate g WHERE g.project_id=$1 AND g.session_id=list.sid AND g.phase<>'open') AS "gateOpen",
        NOT EXISTS(SELECT 1 FROM session_execution_profile p WHERE p.project_id=$1 AND p.session_id=list.sid AND p.activation_state IN ('rejected','unknown')) AS "profileOk",
        EXISTS(SELECT 1 FROM session_line_entry h WHERE h.project_id=$1 AND h.session_id=list.sid AND h.state='suspended'
          AND h.position=(SELECT min(x.position) FROM session_line_entry x JOIN task tx ON tx.project_id=x.project_id AND tx.task_id=x.task_id
            WHERE x.project_id=$1 AND x.session_id=list.sid AND x.state IN ${LIVE} AND tx.state NOT IN ('done','cancelled'))) AS "headSuspended"
      FROM list LEFT JOIN runtime_session rs ON rs.project_id=$1 AND rs.session_id=list.sid ORDER BY list.ord`, [projectId, roleId])).rows;
    if (!rows.length) return { sessionId: null, denial: "DIRECT_LIST_EMPTY" };
    const usable: Candidate[] = [];
    let first: string | null = null;
    for (const candidate of rows) {
      let why: string | null = !candidate.ready ? "NOT_AVAILABLE:SESSION_NOT_READY" : !candidate.gateOpen ? "NOT_AVAILABLE:RECOVERY_GATE_CLOSED"
        : !candidate.profileOk ? "NOT_AVAILABLE:EXECUTION_PROFILE_UNAVAILABLE" : candidate.headSuspended ? "NOT_AVAILABLE:HEAD_SUSPENDED" : null;
      if (!why && this.deps.sessionDenial) { const refused = await this.deps.sessionDenial(projectId, candidate.sid); if (refused) why = `NOT_AUTHORIZED:${refused}`; }
      if (!why && this.deps.recipientDenial) { const refused = await this.deps.recipientDenial(projectId, candidate.sid); if (refused) why = `RECIPIENT_UNAVAILABLE:${refused}`.slice(0, 300); }
      if (why) first ??= why; else usable.push(candidate);
    }
    usable.sort((a, b) => Number(a.running || a.qlen > 0) - Number(b.running || b.qlen > 0) || a.qlen - b.qlen || a.ord - b.ord);
    return usable[0] ? { sessionId: usable[0].sid, denial: null } : { sessionId: null, denial: first };
  }
}
