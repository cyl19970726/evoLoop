import type { PoolClient, QueryResultRow } from "pg";
import { DomainError } from "@evoloop/contracts/ports";
import type { SessionAssignmentPage, SessionAssignmentTransaction, SessionProfileRecord, TaskSessionAssignment } from "@evoloop/contracts/session-assignments";
import type { SessionTarget } from "@evoloop/contracts/session-work";

type Row = QueryResultRow;
const iso = (value: Date | string): string => value instanceof Date ? value.toISOString() : value;
const targetOf = (r: Row): SessionTarget => r.target_kind === "owned"
  ? { kind: "owned", sessionId: r.target_id } : { kind: "external", linkId: r.target_id };
const targetId = (target: SessionTarget): string => target.kind === "owned" ? target.sessionId : target.linkId;
const profileOf = (r: Row): SessionProfileRecord => ({ projectId: r.project_id, target: targetOf(r), version: r.version,
  displayName: r.display_name, purpose: r.purpose, membership: r.membership, tenure: r.tenure,
  actorId: r.actor_id, reason: r.reason, updatedAt: iso(r.updated_at) });
const assignmentOf = (r: Row): TaskSessionAssignment => ({ projectId: r.project_id, taskId: r.task_id,
  version: r.version, taskRevisionId: r.task_revision_id, target: targetOf(r), recipientActorId: r.recipient_actor_id,
  state: r.state, ack: r.ack_method ? { method: r.ack_method, actorId: r.ack_actor_id,
    observerActorId: r.ack_observer_actor_id, evidence: r.ack_evidence, sourceRef: r.ack_source_ref,
    at: iso(r.ack_at) } : null, actorId: r.actor_id, reason: r.reason, updatedAt: iso(r.updated_at) });
function bounded(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new RangeError("page limit must be 1..100");
}
function page<T>(rows: Row[], limit: number, mapper: (r: Row) => T, key: (r: Row) => string): SessionAssignmentPage<T> {
  const items = rows.slice(0, limit);
  return { items: items.map(mapper), nextCursor: rows.length > limit ? key(items[items.length - 1]!) : null };
}
export class PgSessionAssignments implements SessionAssignmentTransaction {
  constructor(private readonly client: PoolClient, private readonly projectId: string) {}
  async getSessionProfile(target: SessionTarget): Promise<SessionProfileRecord | null> {
    const result = await this.client.query("SELECT * FROM session_profile WHERE project_id=$1 AND target_kind=$2 AND target_id=$3",
      [this.projectId, target.kind, targetId(target)]);
    return result.rows[0] ? profileOf(result.rows[0]) : null;
  }
  async listSessionProfileHistory(target: SessionTarget, limit: number, cursor?: string): Promise<SessionAssignmentPage<SessionProfileRecord>> {
    bounded(limit);
    const result = await this.client.query(`SELECT * FROM session_profile_revision WHERE project_id=$1 AND target_kind=$2 AND target_id=$3
      AND ($4::integer IS NULL OR version<$4::integer) ORDER BY version DESC LIMIT $5`,
      [this.projectId, target.kind, targetId(target), cursor ?? null, limit + 1]);
    return page(result.rows, limit, profileOf, r => String(r.version));
  }
  async getTaskSessionAssignment(taskId: string): Promise<TaskSessionAssignment | null> {
    const result = await this.client.query("SELECT * FROM task_session_assignment WHERE project_id=$1 AND task_id=$2",
      [this.projectId, taskId]);
    return result.rows[0] ? assignmentOf(result.rows[0]) : null;
  }
  async listTaskSessionAssignments(target: SessionTarget, limit: number, cursor?: string): Promise<SessionAssignmentPage<TaskSessionAssignment>> {
    bounded(limit);
    const result = await this.client.query(`SELECT * FROM task_session_assignment WHERE project_id=$1 AND target_kind=$2 AND target_id=$3
      AND ($4::uuid IS NULL OR task_id>$4::uuid) ORDER BY task_id LIMIT $5`,
      [this.projectId, target.kind, targetId(target), cursor ?? null, limit + 1]);
    return page(result.rows, limit, assignmentOf, r => r.task_id);
  }
  async listTaskSessionAssignmentHistory(taskId: string, limit: number, cursor?: string): Promise<SessionAssignmentPage<TaskSessionAssignment>> {
    bounded(limit);
    const result = await this.client.query(`SELECT * FROM task_session_assignment_revision WHERE project_id=$1 AND task_id=$2
      AND ($3::integer IS NULL OR version<$3::integer) ORDER BY version DESC LIMIT $4`,
      [this.projectId, taskId, cursor ?? null, limit + 1]);
    return page(result.rows, limit, assignmentOf, r => String(r.version));
  }
  async saveSessionProfile(value: SessionProfileRecord, expectedVersion: number): Promise<void> {
    if (value.projectId !== this.projectId || value.version !== expectedVersion + 1) throw new DomainError("PROJECT_SCOPE", "Invalid profile version or scope");
    const values = [this.projectId, value.target.kind, targetId(value.target), value.version, value.displayName,
      value.purpose, value.membership, value.tenure, value.actorId, value.reason, value.updatedAt];
    const sql = expectedVersion === 0
      ? `INSERT INTO session_profile(project_id,target_kind,target_id,version,display_name,purpose,membership,tenure,actor_id,reason,updated_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT DO NOTHING RETURNING version`
      : `UPDATE session_profile SET version=$4,display_name=$5,purpose=$6,membership=$7,tenure=$8,actor_id=$9,reason=$10,updated_at=$11
         WHERE project_id=$1 AND target_kind=$2 AND target_id=$3 AND version=$12 RETURNING version`;
    const applied = await this.client.query(sql, expectedVersion === 0 ? values : [...values, expectedVersion]);
    if (!applied.rowCount) throw new DomainError("VERSION_CONFLICT", "Session profile version changed");
    await this.client.query(`INSERT INTO session_profile_revision(project_id,target_kind,target_id,version,display_name,purpose,membership,tenure,actor_id,reason,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, values);
  }
  async saveTaskSessionAssignment(value: TaskSessionAssignment, expectedVersion: number): Promise<void> {
    if (value.projectId !== this.projectId || value.version !== expectedVersion + 1) throw new DomainError("PROJECT_SCOPE", "Invalid assignment version or scope");
    const values = [this.projectId, value.taskId, value.version, value.taskRevisionId, value.target.kind,
      targetId(value.target), value.recipientActorId, value.state, value.ack?.method ?? null,
      value.ack?.actorId ?? null, value.ack?.observerActorId ?? null, value.ack?.evidence ?? null,
      value.ack?.sourceRef ?? null, value.ack?.at ?? null, value.actorId, value.reason, value.updatedAt];
    const sql = expectedVersion === 0
      ? `INSERT INTO task_session_assignment(project_id,task_id,version,task_revision_id,target_kind,target_id,recipient_actor_id,state,
         ack_method,ack_actor_id,ack_observer_actor_id,ack_evidence,ack_source_ref,ack_at,actor_id,reason,updated_at)
         VALUES(${Array.from({ length: 17 }, (_, i) => `$${i + 1}`).join(",")}) ON CONFLICT DO NOTHING RETURNING version`
      : `UPDATE task_session_assignment SET version=$3,task_revision_id=$4,target_kind=$5,target_id=$6,recipient_actor_id=$7,state=$8,
         ack_method=$9,ack_actor_id=$10,ack_observer_actor_id=$11,ack_evidence=$12,ack_source_ref=$13,ack_at=$14,
         actor_id=$15,reason=$16,updated_at=$17 WHERE project_id=$1 AND task_id=$2 AND version=$18 RETURNING version`;
    const applied = await this.client.query(sql, expectedVersion === 0 ? values : [...values, expectedVersion]);
    if (!applied.rowCount) throw new DomainError("VERSION_CONFLICT", "Task assignment version changed");
    await this.client.query(`INSERT INTO task_session_assignment_revision(project_id,task_id,version,task_revision_id,target_kind,target_id,
      recipient_actor_id,state,ack_method,ack_actor_id,ack_observer_actor_id,ack_evidence,ack_source_ref,ack_at,actor_id,reason,updated_at)
      VALUES(${Array.from({ length: 17 }, (_, i) => `$${i + 1}`).join(",")})`, values);
  }
  async assertTaskAssignmentMovable(taskId: string): Promise<void> {
    const busy = await this.client.query(`SELECT 1 FROM runtime_run WHERE project_id=$1 AND task_id=$2
      AND state IN ('requested','dispatching','running','unknown') UNION ALL
      SELECT 1 FROM resident_queue_claim WHERE project_id=$1 AND task_id=$2 AND released_at IS NULL LIMIT 1`,
    [this.projectId, taskId]);
    if (busy.rowCount) throw new DomainError("TASK_BUSY", "Unresolved Run or active queue claim owns this Task");
  }
}
