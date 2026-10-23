import type { PoolClient } from "pg";
import type { FormalSourceDecision, TaskExternalReferenceHead, TaskExternalReferenceRecord } from "@evoloop/contracts/references";
import type { StudyReferenceProvenance } from "@evoloop/contracts/references";
import { createHash } from "node:crypto";
import { readStudyDeclaration } from "./orchestration.js";

const iso = (value: Date | string): string => new Date(value).toISOString();
const record = (row: any): TaskExternalReferenceRecord => ({
  projectId: row.project_id, id: row.decision_id, taskId: row.task_id,
  taskRevisionId: row.snapshot_task_revision_id ?? row.origin_task_revision_id,
  slotId: row.slot_id, version: row.slot_version,
  decision: row.decision, kind: row.source_kind, referenceId: row.reference_id,
  revision: row.source_revision, contentHash: row.content_hash, reason: row.reason,
  actionImpact: row.action_impact, actorId: row.actor_id, createdAt: iso(row.created_at),
  observedCurrentRevision: row.observed_current_revision, observedCurrentHash: row.observed_current_hash,
  observedCurrentValidity: row.observed_current_validity,
  studyProvenance: row.study_provenance ?? null,
});
const intentId=(...parts:string[])=>{
  const bytes=Buffer.from(createHash("sha256").update(JSON.stringify(parts)).digest().subarray(0,16));
  bytes[6]=(bytes[6]!&0x0f)|0x50;bytes[8]=(bytes[8]!&0x3f)|0x80;
  const hex=bytes.toString("hex");
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
};

/** Composable project-scoped queries; the caller owns the connection and transaction. */
export class PgReferenceStore {
  constructor(private readonly client: PoolClient, private readonly projectId: string) {}
  async resolveStudyReferenceAuthority(provenance:StudyReferenceProvenance,targetTaskId:string,actorId:string):Promise<{source:TaskExternalReferenceRecord;declaringActorId:string}|null>{
    const declaration=await readStudyDeclaration(this.client,this.projectId,provenance.declarationId);
    const item=declaration?.items.find(candidate=>candidate.sourceDecisionId===provenance.sourceDecisionId);
    if(!declaration || !item || declaration.loopId!==provenance.loopId ||
      declaration.controllerActorId!==actorId || declaration.items.filter(x=>x.sourceDecisionId===item.sourceDecisionId).length!==1 ||
      targetTaskId!==intentId(provenance.loopId,provenance.inboxId,"cognition-task"))return null;
    const createOperationId=intentId(targetTaskId,"create");
    const r=await this.client.query(`SELECT source.*, loop.data AS loop_data
      FROM orchestration_loop loop
      JOIN orchestration_inbox inbox ON inbox.project_id=loop.project_id
        AND inbox.loop_id=loop.loop_id AND inbox.inbox_id=$4 AND inbox.purpose='cognitive_review'
        AND inbox.state='acknowledged' AND inbox.data->>'recipientRoleId'=loop.data->>'cognitiveRoleId'
      JOIN task target ON target.project_id=loop.project_id AND target.task_id=$5
        AND target.owner=loop.data->>'cognitiveRoleId' AND target.kind='research'
        AND target.state NOT IN ('done','cancelled')
      JOIN task_revision initial ON initial.project_id=target.project_id AND initial.task_id=target.task_id
        AND initial.version=1 AND initial.actor_id=$6 AND initial.owner=target.owner AND initial.kind='research'
      JOIN task_proposal proposal ON proposal.project_id=initial.project_id
        AND proposal.task_id=initial.task_id AND proposal.task_revision_id=initial.revision_id
        AND proposal.stage_id=$7
      JOIN operation_journal created ON created.project_id=target.project_id
        AND created.operation_id=$8 AND created.command_type='task.create'
        AND created.actor_id=$6 AND created.result->>'status'='applied'
        AND created.result->>'entityId'=target.task_id::text
        AND created.result->>'revisionId'=initial.revision_id::text
      JOIN task_external_ref_snapshot snapshot ON snapshot.project_id=loop.project_id
        AND snapshot.task_id=$9 AND snapshot.task_revision_id=$10
      JOIN task_external_ref_decision source ON source.project_id=snapshot.project_id
        AND source.decision_id=snapshot.decision_id AND source.decision_id=$11
        AND source.task_id=$9 AND source.slot_id=$12 AND source.source_kind='run'
        AND source.reference_id=$13 AND source.source_revision=$14 AND source.content_hash=$15
      JOIN task_external_ref_head head ON head.project_id=source.project_id
        AND head.task_id=source.task_id AND head.slot_id=source.slot_id AND head.decision_id=source.decision_id
      JOIN runtime_run run ON run.project_id=source.project_id AND run.run_id::text=source.reference_id
        AND run.task_revision_id::text=source.source_revision AND run.input_hash=source.content_hash
        AND run.state IN ('completed','failed','interrupted') AND run.native_turn_id IS NOT NULL
      JOIN runtime_session session ON session.project_id=run.project_id AND session.session_id=run.session_id
        AND session.state='ready' AND session.native_thread_id IS NOT NULL
        AND session.native_session_id IS NOT NULL
      JOIN project_stage stage ON stage.project_id=loop.project_id AND stage.stage_id=$7
        AND stage.goal_id=$16 AND stage.state='active'
      WHERE loop.project_id=$1 AND loop.loop_id=$2 AND loop.state='active'
        AND loop.data->>'currentStudyDeclarationId'=$3
        AND loop.data->>'goalId'=$16::text AND loop.data->>'stageId'=$7::text
        AND NOT EXISTS(SELECT 1 FROM orchestration_dispatch dispatch
          WHERE dispatch.project_id=target.project_id AND dispatch.task_id=target.task_id)
        AND NOT EXISTS(SELECT 1 FROM runtime_run target_run
          WHERE target_run.project_id=target.project_id AND target_run.task_id=target.task_id)
      LIMIT 1`,[this.projectId,provenance.loopId,provenance.declarationId,provenance.inboxId,
      targetTaskId,actorId,declaration.stageId,createOperationId,declaration.sourceTaskId,
      declaration.sourceTaskRevisionId,item.sourceDecisionId,item.sourceSlotId,item.runId,
      item.targetTaskRevisionId,item.inputHash,declaration.goalId]);
    return r.rows[0]?{source:record(r.rows[0]),declaringActorId:declaration.actorId}:null;
  }
  async getTaskExternalHead(taskId: string, slotId: string): Promise<TaskExternalReferenceHead | null> {
    const result = await this.client.query(`SELECT * FROM task_external_ref_head WHERE project_id=$1 AND task_id=$2 AND slot_id=$3`,
      [this.projectId, taskId, slotId]);
    const row = result.rows[0];
    return row ? { projectId: row.project_id, taskId: row.task_id, slotId: row.slot_id,
      version: row.slot_version, decisionId: row.decision_id } : null;
  }
  async getTaskExternalSnapshot(taskId: string, taskRevisionId: string, slotId: string): Promise<TaskExternalReferenceRecord | null> {
    const result = await this.client.query(`SELECT d.*, s.task_revision_id AS snapshot_task_revision_id
      FROM task_external_ref_snapshot s JOIN task_external_ref_decision d
      ON d.project_id=s.project_id AND d.decision_id=s.decision_id
      WHERE s.project_id=$1 AND s.task_id=$2 AND s.task_revision_id=$3 AND s.slot_id=$4`,
      [this.projectId, taskId, taskRevisionId, slotId]);
    return result.rows[0] ? record(result.rows[0]) : null;
  }
  async listTaskExternalSnapshot(taskId: string, taskRevisionId: string): Promise<TaskExternalReferenceRecord[]> {
    const result = await this.client.query(`SELECT d.*, s.task_revision_id AS snapshot_task_revision_id
      FROM task_external_ref_snapshot s JOIN task_external_ref_decision d
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
      observed_current_revision,observed_current_hash,observed_current_validity,reason,action_impact,actor_id,created_at,study_provenance)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19::jsonb)`,
      [this.projectId,value.id,value.taskId,value.taskRevisionId,value.slotId,value.version,value.decision,
        value.kind,value.referenceId,value.revision,value.contentHash,value.observedCurrentRevision,
        value.observedCurrentHash,value.observedCurrentValidity,value.reason,value.actionImpact,value.actorId,value.createdAt,
        value.studyProvenance ? JSON.stringify(value.studyProvenance) : null]);
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
