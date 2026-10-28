import type { PoolClient, QueryResultRow } from "pg";
import { isDeepStrictEqual } from "node:util";
import type { OrdinaryRunSubmissionRecord } from "@evoloop/contracts/ordinary-run-submission";
import type { RuntimeRunRecord } from "@evoloop/contracts/runtime";
import { parseQueueHandoff } from "@evoloop/contracts/runtime-handoff";
import { DomainError } from "@evoloop/contracts/ports";
import { PgRuntimeStore } from "./runtime.js";

export type { OrdinaryRunSubmissionRecord } from "@evoloop/contracts/ordinary-run-submission";

const iso = (value: Date | string): string => value instanceof Date ? value.toISOString() : value;
const recordOf = (r: QueryResultRow): OrdinaryRunSubmissionRecord => ({
  projectId:r.project_id,id:r.submission_id,runId:r.run_id,taskId:r.task_id,sessionId:r.session_id,
  taskRevisionId:r.task_revision_id,runInputHash:r.run_input_hash,operationId:r.operation_id,
  commandHash:r.command_hash,deliveryOperationId:r.delivery_operation_id,deliveryIntent:r.delivery_intent,
  submittedBy:r.submitted_by,state:r.state,version:r.version,expectedTaskVersion:r.expected_task_version,
  terminalRunVersion:r.terminal_run_version,sealedBy:r.sealed_by,deliveryId:r.delivery_id,reason:r.reason,
  createdAtUtc:iso(r.created_at_utc),updatedAtUtc:iso(r.updated_at_utc),
});

/** The caller owns the PoolClient transaction and its commit or rollback. */
export class PgOrdinaryRunSubmissionStore {
  constructor(private readonly client: PoolClient, private readonly projectId: string) {}

  private scope(projectId: string): void {
    if (projectId !== this.projectId) throw new DomainError("PROJECT_SCOPE", "Run submission belongs to another project");
  }

  async get(runId: string): Promise<OrdinaryRunSubmissionRecord | null> {
    const r=await this.client.query("SELECT * FROM ordinary_run_submission WHERE project_id=$1 AND run_id=$2",[this.projectId,runId]);
    return r.rows[0]?recordOf(r.rows[0]):null;
  }

  async getByOperationId(operationId: string): Promise<OrdinaryRunSubmissionRecord | null> {
    const r=await this.client.query("SELECT * FROM ordinary_run_submission WHERE project_id=$1 AND operation_id=$2",[this.projectId,operationId]);
    return r.rows[0]?recordOf(r.rows[0]):null;
  }

  async getRun(runId: string): Promise<RuntimeRunRecord | null> {
    return new PgRuntimeStore(this.client,this.projectId).getRuntimeRun(runId);
  }

  async hasManagedDispatch(runId: string): Promise<boolean> {
    const r=await this.client.query(`SELECT 1 FROM orchestration_dispatch d
      WHERE d.project_id=$1 AND d.data->>'runtimeRunId'=$2 LIMIT 1`,[this.projectId,runId]);
    return r.rows.length>0;
  }

  /** A queue Run needs its exact collaboration channel; a direct Run needs its owned Session assignment. */
  async getFixedRecipient(runId: string): Promise<string | null> {
    const run=await this.getRun(runId);
    if(!run)return null;
    const queue=await this.client.query("SELECT 1 FROM resident_queue_attempt WHERE project_id=$1 AND run_id=$2",[this.projectId,runId]);
    if(queue.rows.length){
      let handoff: ReturnType<typeof parseQueueHandoff>;
      try { handoff=parseQueueHandoff(run.input); }
      catch { throw new DomainError("QUEUE_HANDOFF_INVALID","Fixed queue Run handoff is invalid"); }
      if(!handoff || handoff.taskId!==run.taskId || handoff.taskRevisionId!==run.taskRevisionId ||
        handoff.basisSetId!==run.basisSetId) return null;
      const r=await this.client.query(`SELECT d.collaboration_recipient_actor_id AS actor_id
        FROM discussion d WHERE d.project_id=$1 AND d.kind='task_collaboration' AND d.collaboration_run_id=$2
          AND d.task_id=$3 AND d.task_revision_id=$4 AND d.collaboration_session_id=$5
          AND d.discussion_id=$6 AND d.collaboration_recipient_actor_id=$7
          AND d.collaboration_issuer_actor_id=$8`,
        [this.projectId,runId,run.taskId,run.taskRevisionId,run.sessionId,
          handoff.channel.discussionId,handoff.channel.recipientActorId,handoff.channel.issuerActorId]);
      return r.rows.length===1?r.rows[0].actor_id:null;
    }
    const r=await this.client.query(`SELECT recipient_actor_id AS actor_id FROM task_session_assignment
      WHERE project_id=$1 AND task_id=$2 AND task_revision_id=$3 AND target_kind='owned'
        AND target_id=$4 AND state IN ('assigned','accepted') AND recipient_actor_id IS NOT NULL`,
      [this.projectId,run.taskId,run.taskRevisionId,run.sessionId]);
    return r.rows[0]?.actor_id??null;
  }

  async insert(item: OrdinaryRunSubmissionRecord): Promise<void> {
    this.scope(item.projectId);
    await this.client.query(`INSERT INTO ordinary_run_submission(project_id,submission_id,run_id,task_id,session_id,
      task_revision_id,run_input_hash,operation_id,command_hash,delivery_operation_id,delivery_intent,
      submitted_by,state,version,expected_task_version,terminal_run_version,sealed_by,delivery_id,reason,
      created_at_utc,updated_at_utc) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)`,
      [item.projectId,item.id,item.runId,item.taskId,item.sessionId,item.taskRevisionId,item.runInputHash,
        item.operationId,item.commandHash,item.deliveryOperationId,JSON.stringify(item.deliveryIntent),item.submittedBy,
        item.state,item.version,item.expectedTaskVersion,item.terminalRunVersion,item.sealedBy,item.deliveryId,
        item.reason,item.createdAtUtc,item.updatedAtUtc]);
  }

  async update(item: OrdinaryRunSubmissionRecord, expectedVersion: number): Promise<void> {
    this.scope(item.projectId);
    const current=await this.get(item.runId);
    if(current && !isDeepStrictEqual(
      [item.id,item.taskId,item.sessionId,item.taskRevisionId,item.runInputHash,item.operationId,
        item.commandHash,item.deliveryOperationId,item.deliveryIntent,item.submittedBy,item.createdAtUtc],
      [current.id,current.taskId,current.sessionId,current.taskRevisionId,current.runInputHash,current.operationId,
        current.commandHash,current.deliveryOperationId,current.deliveryIntent,current.submittedBy,current.createdAtUtc]))
      throw new DomainError("SUBMISSION_CONFLICT","Run submission original intent cannot change");
    const r=await this.client.query(`UPDATE ordinary_run_submission SET state=$3,version=$4,
      expected_task_version=$5,terminal_run_version=$6,sealed_by=$7,delivery_id=$8,reason=$9,updated_at_utc=$10
      WHERE project_id=$1 AND run_id=$2 AND version=$11`,
      [item.projectId,item.runId,item.state,item.version,item.expectedTaskVersion,item.terminalRunVersion,
        item.sealedBy,item.deliveryId,item.reason,item.updatedAtUtc,expectedVersion]);
    if(!r.rowCount)throw new DomainError("VERSION_CONFLICT","Run submission version changed",(await this.get(item.runId))?.version);
  }

  async listUnsettled(limit=100, after?: {createdAtUtc:string;runId:string}): Promise<OrdinaryRunSubmissionRecord[]> {
    if(!Number.isInteger(limit)||limit<1||limit>1000)throw new RangeError("submission limit must be 1..1000");
    const r=await this.client.query(`SELECT * FROM ordinary_run_submission WHERE project_id=$1
      AND state IN ('submitted','blocked','sealing','unknown')
      AND ($3::timestamptz IS NULL OR (created_at_utc,run_id)>($3::timestamptz,$4::uuid))
      ORDER BY created_at_utc,run_id LIMIT $2`,[this.projectId,limit,after?.createdAtUtc??null,after?.runId??null]);
    return r.rows.map(recordOf);
  }
}
