import type { Pool, PoolClient } from "pg";
import type { RoleDecision, RoleHandoff, RoleHandoffEvent, RoleReader, RoleRecord, RoleRevision, RoleRuntimeSessionSnapshot, RoleSessionBinding, RoleTaskSnapshot, RoleTransaction, RoleTrialReview } from "@evoloop/contracts/roles";

const iso = (value: Date | string): string => new Date(value).toISOString();
export class PgRoleConflict extends Error { constructor(message: string) { super(message); this.name = "PgRoleConflict"; } }

/** Composable queries bound to the caller's transaction and project. The caller owns BEGIN/COMMIT and command journaling. */
export class PgRoleQueries implements RoleTransaction, RoleReader {
  constructor(private readonly client: PoolClient, private readonly projectId: string) {}

  async getRole(roleId: string): Promise<RoleRecord | null> {
    const result = await this.client.query(`SELECT d.*,r.proposal FROM role_definition d JOIN role_revision r
      ON r.project_id=d.project_id AND r.role_id=d.role_id AND r.revision_id=d.current_revision_id
      WHERE d.project_id=$1 AND d.role_id=$2`, [this.projectId, roleId]);
    const row = result.rows[0];
    return row ? { projectId: row.project_id, id: row.role_id, version: row.version, currentRevisionId: row.current_revision_id,
      state: row.state, proposal: row.proposal, proposedBy: row.proposed_by, createdAtUtc: iso(row.created_at_utc),
      trialStartedAtUtc: row.trial_started_at_utc ? iso(row.trial_started_at_utc) : null, reviewAtUtc: iso(row.review_at_utc), mergeTargetRoleId: row.merge_target_role_id } : null;
  }
  async listRoles(limit = 50, afterRoleId?: string): Promise<{ items: RoleRecord[]; nextCursor: string | null }> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new RangeError("role page limit must be 1..100");
    const result = await this.client.query(`SELECT role_id FROM role_definition WHERE project_id=$1 AND ($2::uuid IS NULL OR role_id>$2::uuid) ORDER BY role_id LIMIT $3`, [this.projectId,afterRoleId ?? null,limit+1]);
    const ids = result.rows.slice(0,limit).map(row => row.role_id as string);
    const items: RoleRecord[] = [];
    for (const id of ids) { const value = await this.getRole(id); if (value) items.push(value); }
    return { items, nextCursor: result.rows.length > limit ? ids[ids.length-1] ?? null : null };
  }
  async listRevisions(roleId: string): Promise<RoleRevision[]> {
    const result = await this.client.query("SELECT * FROM role_revision WHERE project_id=$1 AND role_id=$2 ORDER BY version LIMIT 1001", [this.projectId,roleId]);
    if (result.rows.length > 1000) throw new PgRoleConflict("role revision history exceeds read limit");
    return result.rows.map(row => ({ projectId: row.project_id, roleId: row.role_id, id: row.revision_id, version: row.version, state: row.state, proposal: row.proposal, actorId: row.actor_id, reason: row.reason, createdAtUtc: iso(row.created_at_utc), reviewAtUtc: iso(row.review_at_utc), mergeTargetRoleId: row.merge_target_role_id }));
  }
  async listReviews(roleId: string): Promise<RoleTrialReview[]> {
    const result = await this.client.query("SELECT * FROM role_trial_review WHERE project_id=$1 AND role_id=$2 ORDER BY created_at_utc,review_id LIMIT 1001", [this.projectId,roleId]);
    if (result.rows.length > 1000) throw new PgRoleConflict("role review history exceeds read limit");
    return result.rows.map(row => ({ projectId: row.project_id, id: row.review_id, roleId: row.role_id, revisionId: row.revision_id, decision: row.decision, effectEvidence: row.effect_evidence, effectEvidenceRefs: row.effect_evidence_refs, costEvidence: row.cost_evidence, costEvidenceRefs: row.cost_evidence_refs, baselineComparison: row.baseline_comparison, actorId: row.actor_id, reason: row.reason, createdAtUtc: iso(row.created_at_utc) }));
  }
  async listHandoffs(roleId: string): Promise<RoleHandoff[]> {
    const result = await this.client.query("SELECT * FROM role_handoff WHERE project_id=$1 AND role_id=$2 ORDER BY prepared_at_utc,handoff_id LIMIT 1001", [this.projectId,roleId]);
    if (result.rows.length > 1000) throw new PgRoleConflict("role handoff history exceeds read limit");
    return result.rows.map(row => this.handoff(row));
  }
  async listSessionBindings(roleId: string): Promise<RoleSessionBinding[]> {
    const result = await this.client.query("SELECT * FROM role_session_binding WHERE project_id=$1 AND role_id=$2 ORDER BY created_at_utc,binding_id LIMIT 1001", [this.projectId,roleId]);
    if (result.rows.length > 1000) throw new PgRoleConflict("role binding history exceeds read limit");
    return result.rows.map(row => ({ projectId: row.project_id, id: row.binding_id, roleId: row.role_id, sessionId: row.session_id, roleRevisionId: row.role_revision_id, actorId: row.actor_id, note: row.note, createdAtUtc: iso(row.created_at_utc) }));
  }

  private async insertRevision(value: RoleRevision): Promise<void> {
    await this.client.query(`INSERT INTO role_revision(project_id,role_id,revision_id,version,state,proposal,actor_id,reason,created_at_utc,review_at_utc,merge_target_role_id)
      VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11)`,
      [this.projectId,value.roleId,value.id,value.version,value.state,JSON.stringify(value.proposal),value.actorId,value.reason,value.createdAtUtc,value.reviewAtUtc,value.mergeTargetRoleId]);
  }
  async createRole(record: RoleRecord, revision: RoleRevision): Promise<void> {
    await this.client.query(`INSERT INTO role_definition(project_id,role_id,version,current_revision_id,state,proposed_by,created_at_utc,trial_started_at_utc,review_at_utc,merge_target_role_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [this.projectId,record.id,record.version,record.currentRevisionId,record.state,record.proposedBy,record.createdAtUtc,record.trialStartedAtUtc,record.reviewAtUtc,record.mergeTargetRoleId]);
    await this.insertRevision(revision);
  }
  async advanceRole(record: RoleRecord, expectedVersion: number, revision: RoleRevision): Promise<void> {
    const changed = await this.client.query(`UPDATE role_definition SET version=$3,current_revision_id=$4,state=$5,trial_started_at_utc=$6,review_at_utc=$7,merge_target_role_id=$8
      WHERE project_id=$1 AND role_id=$2 AND version=$9`, [this.projectId,record.id,record.version,record.currentRevisionId,record.state,record.trialStartedAtUtc,record.reviewAtUtc,record.mergeTargetRoleId,expectedVersion]);
    if (changed.rowCount !== 1) throw new PgRoleConflict("role version changed");
    await this.insertRevision(revision);
  }
  async addDecision(value: RoleDecision): Promise<void> {
    await this.client.query(`INSERT INTO role_decision(project_id,decision_id,role_id,revision_id,decision,actor_id,reason,created_at_utc) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
      [this.projectId,value.id,value.roleId,value.revisionId,value.decision,value.actorId,value.reason,value.createdAtUtc]);
  }
  async addReview(value: RoleTrialReview): Promise<void> {
    await this.client.query(`INSERT INTO role_trial_review(project_id,review_id,role_id,revision_id,decision,effect_evidence,effect_evidence_refs,cost_evidence,cost_evidence_refs,baseline_comparison,actor_id,reason,created_at_utc)
      VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9::jsonb,$10,$11,$12,$13)`,
      [this.projectId,value.id,value.roleId,value.revisionId,value.decision,value.effectEvidence,JSON.stringify(value.effectEvidenceRefs),value.costEvidence,JSON.stringify(value.costEvidenceRefs),value.baselineComparison,value.actorId,value.reason,value.createdAtUtc]);
  }
  async getHandoff(handoffId: string): Promise<RoleHandoff | null> {
    const result = await this.client.query("SELECT * FROM role_handoff WHERE project_id=$1 AND handoff_id=$2", [this.projectId,handoffId]);
    return result.rows[0] ? this.handoff(result.rows[0]) : null;
  }
  private handoff(row: any): RoleHandoff {
    return { projectId: row.project_id, id: row.handoff_id, roleId: row.role_id, kind: row.kind, sourceRef: row.source_ref, targetRoleId: row.target_role_id,
      observedTaskVersion: row.observed_task_version, state: row.state, preparedAtUtc: iso(row.prepared_at_utc), acknowledgedAtUtc: row.acknowledged_at_utc ? iso(row.acknowledged_at_utc) : null };
  }
  private async addHandoffEvent(value: RoleHandoffEvent): Promise<void> {
    await this.client.query(`INSERT INTO role_handoff_event(project_id,event_id,handoff_id,role_id,state,actor_id,note,created_at_utc)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [this.projectId,value.id,value.handoffId,value.roleId,value.state,value.actorId,value.note,value.createdAtUtc]);
  }
  async addHandoff(value: RoleHandoff, event: RoleHandoffEvent): Promise<void> {
    await this.client.query(`INSERT INTO role_handoff(project_id,handoff_id,role_id,kind,source_ref,target_role_id,observed_task_version,state,prepared_at_utc,acknowledged_at_utc)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [this.projectId,value.id,value.roleId,value.kind,value.sourceRef,value.targetRoleId,value.observedTaskVersion,value.state,value.preparedAtUtc,value.acknowledgedAtUtc]);
    await this.addHandoffEvent(event);
  }
  async acknowledgeHandoff(value: RoleHandoff, event: RoleHandoffEvent): Promise<void> {
    const changed = await this.client.query(`UPDATE role_handoff SET state='acknowledged',acknowledged_at_utc=$3 WHERE project_id=$1 AND handoff_id=$2 AND state='prepared'`, [this.projectId,value.id,value.acknowledgedAtUtc]);
    if (changed.rowCount !== 1) throw new PgRoleConflict("handoff state changed");
    await this.addHandoffEvent(event);
  }
  async listUnacknowledgedHandoffs(roleId: string): Promise<RoleHandoff[]> {
    const result = await this.client.query("SELECT * FROM role_handoff WHERE project_id=$1 AND role_id=$2 AND state='prepared' ORDER BY prepared_at_utc,handoff_id LIMIT 101", [this.projectId,roleId]);
    if (result.rows.length > 100) throw new PgRoleConflict("too many unresolved handoffs to verify");
    return result.rows.map(row => this.handoff(row));
  }
  async getTask(taskId: string): Promise<RoleTaskSnapshot | null> {
    const result = await this.client.query("SELECT task_id,owner,version,state FROM task WHERE project_id=$1 AND task_id=$2", [this.projectId,taskId]);
    const row = result.rows[0]; return row ? { id: row.task_id, owner: row.owner, version: row.version, state: row.state } : null;
  }
  async listUnfinishedOwnedTasks(roleId: string): Promise<RoleTaskSnapshot[]> {
    const result = await this.client.query("SELECT task_id,owner,version,state FROM task WHERE project_id=$1 AND owner=$2 AND state NOT IN ('done','cancelled') ORDER BY task_id LIMIT 101", [this.projectId,roleId]);
    if (result.rows.length > 100) throw new PgRoleConflict("too many unfinished tasks to verify");
    return result.rows.map(row => ({ id: row.task_id, owner: row.owner, version: row.version, state: row.state }));
  }
  async getRuntimeSession(sessionId: string): Promise<RoleRuntimeSessionSnapshot | null> {
    const result = await this.client.query("SELECT session_id,role_id,state,native_thread_id FROM runtime_session WHERE project_id=$1 AND session_id=$2", [this.projectId,sessionId]);
    const row = result.rows[0]; return row ? { id: row.session_id, roleId: row.role_id, state: row.state, nativeThreadId: row.native_thread_id } : null;
  }
  async listOpenRuntimeSessions(roleId: string): Promise<RoleRuntimeSessionSnapshot[]> {
    const result = await this.client.query("SELECT session_id,role_id,state,native_thread_id FROM runtime_session WHERE project_id=$1 AND role_id=$2 AND state<>'closed' ORDER BY session_id LIMIT 101", [this.projectId,roleId]);
    if (result.rows.length > 100) throw new PgRoleConflict("too many open runtime sessions to verify");
    return result.rows.map(row => ({ id: row.session_id, roleId: row.role_id, state: row.state, nativeThreadId: row.native_thread_id }));
  }
  async addSessionBinding(value: RoleSessionBinding): Promise<void> {
    await this.client.query(`INSERT INTO role_session_binding(project_id,binding_id,role_id,session_id,role_revision_id,actor_id,note,created_at_utc)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [this.projectId,value.id,value.roleId,value.sessionId,value.roleRevisionId,value.actorId,value.note,value.createdAtUtc]);
  }
}

/** Standalone transaction facade for tests and pre-integration use; shared command UoW should call PgRoleQueries itself. */
export class PgRoleStore {
  constructor(private readonly pool: Pool) {}
  async transaction<T>(projectId: string, action: (tx: PgRoleQueries) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await action(new PgRoleQueries(client, projectId));
      await client.query("COMMIT");
      return result;
    } catch (error) { try { await client.query("ROLLBACK"); } catch { /* preserve original error */ } throw error; }
    finally { client.release(); }
  }
}
