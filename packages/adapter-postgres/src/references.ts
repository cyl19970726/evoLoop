import type { PoolClient } from "pg";
import type { FormalSourceDecision, TaskExternalReferenceHead, TaskExternalReferenceRecord } from "@evoloop/contracts/references";

const iso = (value: Date | string): string => new Date(value).toISOString();
const record = (row: any): TaskExternalReferenceRecord => ({
  projectId: row.project_id, id: row.decision_id, taskId: row.task_id,
  taskRevisionId: row.origin_task_revision_id, slotId: row.slot_id, version: row.slot_version,
  decision: row.decision, kind: row.source_kind, referenceId: row.reference_id,
  revision: row.source_revision, contentHash: row.content_hash, reason: row.reason,
  actionImpact: row.action_impact, actorId: row.actor_id, createdAt: iso(row.created_at),
  observedCurrentRevision: row.observed_current_revision, observedCurrentHash: row.observed_current_hash,
  observedCurrentValidity: row.observed_current_validity,
});

/** Composable project-scoped queries; the caller owns the connection and transaction. */
export class PgReferenceStore {
  constructor(private readonly client: PoolClient, private readonly projectId: string) {}
  async getTaskExternalHead(taskId: string, slotId: string): Promise<TaskExternalReferenceHead | null> {
    const result = await this.client.query(`SELECT * FROM task_external_ref_head WHERE project_id=$1 AND task_id=$2 AND slot_id=$3`,
      [this.projectId, taskId, slotId]);
    const row = result.rows[0];
    return row ? { projectId: row.project_id, taskId: row.task_id, slotId: row.slot_id,
      version: row.slot_version, decisionId: row.decision_id } : null;
  }
  async getTaskExternalSnapshot(taskId: string, taskRevisionId: string, slotId: string): Promise<TaskExternalReferenceRecord | null> {
    const result = await this.client.query(`SELECT d.* FROM task_external_ref_snapshot s JOIN task_external_ref_decision d
      ON d.project_id=s.project_id AND d.decision_id=s.decision_id
      WHERE s.project_id=$1 AND s.task_id=$2 AND s.task_revision_id=$3 AND s.slot_id=$4`,
      [this.projectId, taskId, taskRevisionId, slotId]);
    return result.rows[0] ? record(result.rows[0]) : null;
  }
  async listTaskExternalSnapshot(taskId: string, taskRevisionId: string): Promise<TaskExternalReferenceRecord[]> {
    const result = await this.client.query(`SELECT d.* FROM task_external_ref_snapshot s JOIN task_external_ref_decision d
      ON d.project_id=s.project_id AND d.decision_id=s.decision_id
      WHERE s.project_id=$1 AND s.task_id=$2 AND s.task_revision_id=$3 ORDER BY s.slot_id LIMIT 101`,
      [this.projectId, taskId, taskRevisionId]);
    if (result.rows.length > 100) throw new Error("External reference snapshot exceeds 100 slots");
    return result.rows.map(record);
  }
  async listTaskExternalReferences(taskId: string): Promise<TaskExternalReferenceRecord[]> {
    const result = await this.client.query(`SELECT * FROM task_external_ref_decision WHERE project_id=$1 AND task_id=$2
      ORDER BY created_at,decision_id LIMIT 1001`, [this.projectId, taskId]);
    if (result.rows.length > 1000) throw new Error("External reference history exceeds 1000 decisions");
    return result.rows.map(record);
  }
  async listFormalSourceDecisions(gitReferenceId: string): Promise<FormalSourceDecision[]> {
    const result = await this.client.query(`SELECT * FROM formal_source_decision WHERE project_id=$1 AND git_source_ref_id=$2
      ORDER BY created_at,decision_id LIMIT 1001`, [this.projectId, gitReferenceId]);
    if (result.rows.length > 1000) throw new Error("Formal source history exceeds 1000 decisions");
    return result.rows.map(row => ({ projectId: row.project_id, id: row.decision_id,
      gitReferenceId: row.git_source_ref_id, documentId: row.document_id, documentRevisionId: row.document_revision_id,
      decision: row.decision, actorId: row.actor_id, reason: row.reason, createdAt: iso(row.created_at) }));
  }
  async insertFormalSourceDecision(value: FormalSourceDecision): Promise<void> {
    if (value.projectId !== this.projectId) throw new Error("Project scope mismatch");
    await this.client.query(`INSERT INTO formal_source_decision(project_id,decision_id,git_source_ref_id,document_id,
      document_revision_id,decision,actor_id,reason,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [this.projectId, value.id, value.gitReferenceId, value.documentId, value.documentRevisionId,
        value.decision, value.actorId, value.reason, value.createdAt]);
  }
  async insertTaskExternalDecision(value: TaskExternalReferenceRecord): Promise<void> {
    if (value.projectId !== this.projectId) throw new Error("Project scope mismatch");
    await this.client.query(`INSERT INTO task_external_ref_decision(project_id,decision_id,task_id,origin_task_revision_id,
      slot_id,slot_version,decision,source_kind,reference_id,source_revision,content_hash,
      observed_current_revision,observed_current_hash,observed_current_validity,reason,action_impact,actor_id,created_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
      [this.projectId,value.id,value.taskId,value.taskRevisionId,value.slotId,value.version,value.decision,
        value.kind,value.referenceId,value.revision,value.contentHash,value.observedCurrentRevision,
        value.observedCurrentHash,value.observedCurrentValidity,value.reason,value.actionImpact,value.actorId,value.createdAt]);
  }
  async advanceTaskExternalHead(value: TaskExternalReferenceHead, expectedVersion: number): Promise<boolean> {
    if (value.projectId !== this.projectId || value.version !== expectedVersion + 1) throw new Error("Invalid external reference head");
    if (expectedVersion === 0) {
      const result = await this.client.query(`INSERT INTO task_external_ref_head(project_id,task_id,slot_id,slot_version,decision_id)
        VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
        [this.projectId,value.taskId,value.slotId,value.version,value.decisionId]);
      return result.rowCount === 1;
    }
    const result = await this.client.query(`UPDATE task_external_ref_head SET slot_version=$4,decision_id=$5
      WHERE project_id=$1 AND task_id=$2 AND slot_id=$3 AND slot_version=$6`,
      [this.projectId,value.taskId,value.slotId,value.version,value.decisionId,expectedVersion]);
    return result.rowCount === 1;
  }
  async insertTaskExternalSnapshot(taskId: string, taskRevisionId: string, slotId: string,
    slotVersion: number, decisionId: string): Promise<void> {
    await this.client.query(`INSERT INTO task_external_ref_snapshot(project_id,task_id,task_revision_id,slot_id,slot_version,decision_id)
      VALUES($1,$2,$3,$4,$5,$6)`, [this.projectId,taskId,taskRevisionId,slotId,slotVersion,decisionId]);
  }
}
