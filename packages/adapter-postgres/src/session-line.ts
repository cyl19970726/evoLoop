import type { PoolClient, QueryResultRow } from "pg";
import { DomainError } from "@evoloop/contracts/ports";
import type { SessionLine, SessionLineEntry, SessionLineEvent, SessionLineTransaction } from "@evoloop/contracts/session-line";

type Row = QueryResultRow;
const iso = (value: Date | string): string => value instanceof Date ? value.toISOString() : value;
const lineOf = (r: Row): SessionLine => ({ projectId: r.project_id, sessionId: r.session_id, controllerActorId: r.controller_actor_id,
  version: r.version, createdAt: iso(r.created_at), updatedAt: iso(r.updated_at) });
const entryOf = (r: Row): SessionLineEntry => ({ projectId: r.project_id, id: r.entry_id, sessionId: r.session_id, taskId: r.task_id,
  position: Number(r.position), state: r.state, step: r.step, attempt: r.attempt, assignOperationId: r.assign_operation_id,
  startOperationId: r.start_operation_id, reassignOperationId: r.reassign_operation_id, reserveOperationId: r.reserve_operation_id, messageId: r.message_id,
  suspendReason: r.suspend_reason, withdrawnReason: r.withdrawn_reason, source: r.source, sourceActorId: r.source_actor_id,
  scheduleId: r.schedule_id, releaseRule: r.release_rule, runId: r.run_id, version: r.version,
  appendedAt: iso(r.appended_at), updatedAt: iso(r.updated_at) });
const eventOf = (r: Row): SessionLineEvent => ({ projectId: r.project_id, seq: Number(r.event_seq), sessionId: r.session_id,
  entryId: r.entry_id, taskId: r.task_id, kind: r.kind, detail: r.detail, actorId: r.actor_id, at: iso(r.at) });

export class PgSessionLine implements SessionLineTransaction {
  constructor(private readonly client: PoolClient, private readonly projectId: string) {}
  async getSessionLine(sessionId: string): Promise<SessionLine | null> {
    const r = await this.client.query("SELECT * FROM session_line WHERE project_id=$1 AND session_id=$2", [this.projectId, sessionId]);
    return r.rows[0] ? lineOf(r.rows[0]) : null;
  }
  async listSessionLines(): Promise<SessionLine[]> {
    return (await this.client.query("SELECT * FROM session_line WHERE project_id=$1 ORDER BY session_id", [this.projectId])).rows.map(lineOf);
  }
  async listSessionLineEntries(sessionId: string, includeEnded = false): Promise<SessionLineEntry[]> {
    const r = await this.client.query(`SELECT * FROM session_line_entry WHERE project_id=$1 AND session_id=$2
      AND ($3::boolean OR state NOT IN ('started','withdrawn')) ORDER BY position,entry_id`, [this.projectId, sessionId, includeEnded]);
    return r.rows.map(entryOf);
  }
  async getSessionLineEntry(entryId: string): Promise<SessionLineEntry | null> {
    const r = await this.client.query("SELECT * FROM session_line_entry WHERE project_id=$1 AND entry_id=$2", [this.projectId, entryId]);
    return r.rows[0] ? entryOf(r.rows[0]) : null;
  }
  async getLiveSessionLineEntryForTask(taskId: string): Promise<SessionLineEntry | null> {
    const r = await this.client.query(`SELECT * FROM session_line_entry WHERE project_id=$1 AND task_id=$2
      AND state IN ('queued','suspended','starting')`, [this.projectId, taskId]);
    return r.rows[0] ? entryOf(r.rows[0]) : null;
  }
  async listSessionLineEvents(afterSeq: number, limit: number, sessionId?: string): Promise<SessionLineEvent[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new RangeError("event limit must be 1..500");
    const r = await this.client.query(`SELECT * FROM session_line_event WHERE project_id=$1 AND event_seq>$2
      AND ($3::uuid IS NULL OR session_id=$3) ORDER BY event_seq LIMIT $4`, [this.projectId, afterSeq, sessionId ?? null, limit]);
    return r.rows.map(eventOf);
  }
  async insertSessionLine(value: SessionLine): Promise<void> {
    await this.client.query(`INSERT INTO session_line(project_id,session_id,controller_actor_id,version,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5,$6)`, [this.projectId, value.sessionId, value.controllerActorId, value.version, value.createdAt, value.updatedAt]);
  }
  async touchSessionLine(sessionId: string, expectedVersion: number, at: string): Promise<void> {
    const r = await this.client.query(`UPDATE session_line SET version=version+1,updated_at=$4 WHERE project_id=$1 AND session_id=$2 AND version=$3`,
      [this.projectId, sessionId, expectedVersion, at]);
    if (!r.rowCount) throw new DomainError("VERSION_CONFLICT", "Session line changed");
  }
  async insertSessionLineEntry(value: Omit<SessionLineEntry, "position">): Promise<SessionLineEntry> {
    const r = await this.client.query(`INSERT INTO session_line_entry(project_id,entry_id,session_id,task_id,position,state,step,attempt,
      suspend_reason,withdrawn_reason,source,source_actor_id,schedule_id,release_rule,run_id,version,appended_at,updated_at)
      VALUES($1,$2,$3,$4,(SELECT COALESCE(max(position),0)+1 FROM session_line_entry WHERE project_id=$1 AND session_id=$3),
      $5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING *`,
    [this.projectId, value.id, value.sessionId, value.taskId, value.state, value.step, value.attempt, value.suspendReason,
      value.withdrawnReason, value.source, value.sourceActorId, value.scheduleId, value.releaseRule, value.runId, value.version,
      value.appendedAt, value.updatedAt]).catch((error: { code?: string; constraint?: string }) => {
      if (error.code === "23505" && error.constraint === "session_line_entry_task_live")
        throw new DomainError("TASK_ALREADY_QUEUED", "This Task is already waiting in a Session line");
      throw error;
    });
    return entryOf(r.rows[0]!);
  }
  async updateSessionLineEntry(value: SessionLineEntry, expectedVersion: number): Promise<void> {
    const r = await this.client.query(`UPDATE session_line_entry SET state=$4,step=$5,attempt=$6,assign_operation_id=$7,start_operation_id=$8,
      reserve_operation_id=$9,message_id=$10,suspend_reason=$11,withdrawn_reason=$12,run_id=$13,version=$14,updated_at=$15,reassign_operation_id=$16
      WHERE project_id=$1 AND entry_id=$2 AND version=$3`, [this.projectId, value.id, expectedVersion, value.state, value.step,
      value.attempt, value.assignOperationId, value.startOperationId, value.reserveOperationId, value.messageId, value.suspendReason,
      value.withdrawnReason, value.runId, value.version, value.updatedAt, value.reassignOperationId]);
    if (!r.rowCount) throw new DomainError("VERSION_CONFLICT", "Session line entry changed");
  }
  async swapSessionLineEntry(entryId: string, direction: "forward" | "back", at: string): Promise<boolean> {
    const own = (await this.client.query("SELECT session_id,position FROM session_line_entry WHERE project_id=$1 AND entry_id=$2 FOR UPDATE",
      [this.projectId, entryId])).rows[0];
    if (!own) return false;
    const neighbour = (await this.client.query(`SELECT entry_id,position FROM session_line_entry WHERE project_id=$1 AND session_id=$2
      AND state IN ('queued','suspended','starting') AND ${direction === "forward" ? "position<$3 ORDER BY position DESC" : "position>$3 ORDER BY position ASC"} LIMIT 1 FOR UPDATE`,
    [this.projectId, own.session_id, own.position])).rows[0];
    if (!neighbour) return false;
    await this.client.query(`UPDATE session_line_entry SET position=CASE entry_id WHEN $2 THEN $4::bigint WHEN $3 THEN $5::bigint END,
      version=version+1,updated_at=$6 WHERE project_id=$1 AND entry_id IN ($2,$3)`,
    [this.projectId, entryId, neighbour.entry_id, neighbour.position, own.position, at]);
    return true;
  }
  async appendSessionLineEvent(value: Omit<SessionLineEvent, "seq">): Promise<void> {
    await this.client.query(`INSERT INTO session_line_event(project_id,session_id,entry_id,task_id,kind,detail,actor_id,at)
      VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8)`, [this.projectId, value.sessionId, value.entryId, value.taskId, value.kind,
      JSON.stringify(value.detail), value.actorId, value.at]);
  }
  async assertNotQueuedInLine(taskId: string, operationId: string): Promise<void> {
    // The upgrade tests replay commands against schemas that predate migration 080; no line can exist there.
    if (!(await this.client.query("SELECT to_regclass('session_line_entry') AS t")).rows[0]?.t) return;
    const entry = await this.getLiveSessionLineEntryForTask(taskId);
    if (!entry) return;
    if (entry.state === "starting" && [entry.assignOperationId, entry.startOperationId, entry.reassignOperationId, entry.reserveOperationId].includes(operationId)) return;
    throw new DomainError("QUEUED_IN_SESSION_LINE", "This Task waits in a Session line; remove it from the line before arranging it another way");
  }
}
