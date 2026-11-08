import type { PoolClient, QueryResultRow } from "pg";
import type { SessionTarget } from "@evoloop/contracts/session-work";
import type { SessionMessageManualStopEvidence, SessionMessageManualStopPreflight, SessionMessageProcessing, SessionMessageRecord, SessionMessageTransaction } from "@evoloop/contracts/session-messages";
import { DomainError } from "@evoloop/contracts/ports";
import { preTurnProofSchema } from "@evoloop/contracts/runtime";
import { taskAttentionNoticeCurrent } from "./task-attention.js";

const iso = (v: Date | string): string => v instanceof Date ? v.toISOString() : v;
const nativeEpoch = (value: unknown): number | null => {
  if (value == null) return null;
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 1) throw new DomainError('NATIVE_EPOCH_INVALID','Native environment epoch is invalid');
  return result;
};
const message = (r: QueryResultRow): SessionMessageRecord => ({
  projectId:r.project_id,id:r.message_id,operationId:r.operation_id,
  target:r.target_kind==='owned'?{kind:'owned',sessionId:r.session_id}:{kind:'external',linkId:r.link_id},
  senderActorId:r.sender_actor_id,content:r.content,
  context:r.context_task_id?{taskId:r.context_task_id,taskRevisionId:r.context_task_revision_id}:null,
  replyToMessageId:r.reply_to_message_id,state:r.state,version:r.version,
  blockedReason:r.blocked_reason??null,
  readReceipt:r.receipt_actor_id?{actorId:r.receipt_actor_id,evidence:r.receipt_evidence,at:iso(r.receipt_recorded_at)}:null,
  createdAt:iso(r.created_at),updatedAt:iso(r.updated_at),
});
const processing = (r: QueryResultRow): SessionMessageProcessing => ({
  projectId:r.project_id,id:r.processing_id,messageId:r.message_id,sessionId:r.session_id,
  operationId:r.operation_id,state:r.state,nativeTurnId:r.native_turn_id,response:r.response,
  failure:r.failure,readOnlyPolicyFingerprint:r.read_only_policy_fingerprint,receiverActorId:r.receiver_actor_id,
  roleContext:r.role_context??null,
  nativeEnvironmentEpoch:nativeEpoch(r.native_environment_epoch),
  preTurnProof:r.pre_turn_proof==null?null:preTurnProofSchema.parse(r.pre_turn_proof),
  interruptOperationId:r.interrupt_operation_id??null,interruptActorId:r.interrupt_actor_id??null,
  interruptReason:r.interrupt_reason??null,
  interruptRequestedAt:r.interrupt_requested_at?iso(r.interrupt_requested_at):null,
  interruptAttemptedAt:r.interrupt_attempted_at?iso(r.interrupt_attempted_at):null,
  version:r.version,startedAt:iso(r.started_at),updatedAt:iso(r.updated_at),
});
const manualStopEvidence = (r: QueryResultRow): SessionMessageManualStopEvidence => ({
  projectId:r.project_id,messageId:r.message_id,processingId:r.processing_id,sessionId:r.session_id,
  nativeTurnId:r.native_turn_id,preflightId:r.preflight_id,operationId:r.operation_id,actorId:r.actor_id,reason:r.reason,
  priorFailure:r.prior_failure,oldCoordinatorPid:r.old_coordinator_pid,oldNativePid:r.old_native_pid,
  oldCoordinatorStartIdentity:r.old_coordinator_start_identity,oldNativeStartIdentity:r.old_native_start_identity,
  exitEvidenceRef:r.exit_evidence_ref,exitEvidenceHash:r.exit_evidence_hash,
  observedNativeStatus:r.observed_native_status,observedThreadStatus:r.observed_thread_status,
  observedItemCount:r.observed_item_count,observedItemIdsHash:r.observed_item_ids_hash,
  recordedAt:iso(r.recorded_at),
});
const manualStopPreflight = (r: QueryResultRow): SessionMessageManualStopPreflight => ({
  projectId:r.project_id,messageId:r.message_id,preflightId:r.preflight_id,
  processingId:r.processing_id,sessionId:r.session_id,nativeTurnId:r.native_turn_id,
  nativeThreadId:r.native_thread_id,messageVersion:r.message_version,processingVersion:r.processing_version,
  host:r.host,capturedByActorId:r.captured_by_actor_id,listenPort:r.listen_port,
  oldCoordinatorPid:r.old_coordinator_pid,oldCoordinatorStartIdentity:r.old_coordinator_start_identity,
  oldNativePid:r.old_native_pid,oldNativeStartIdentity:r.old_native_start_identity,
  preStopEvidenceJson:r.pre_stop_evidence_json,preStopEvidenceHash:r.pre_stop_evidence_hash,
  captureFileRef:r.capture_file_ref,captureFileHash:r.capture_file_hash,capturedAt:iso(r.captured_at),
});
const SELECT_MESSAGE = `SELECT m.*, rr.actor_id AS receipt_actor_id,rr.evidence AS receipt_evidence,
  rr.recorded_at AS receipt_recorded_at FROM session_message m LEFT JOIN LATERAL (
    SELECT actor_id,evidence,recorded_at FROM session_message_read_receipt
    WHERE project_id=m.project_id AND message_id=m.message_id ORDER BY recorded_at LIMIT 1
  ) rr ON true`;

export class PgSessionMessages implements SessionMessageTransaction {
  constructor(private readonly client:PoolClient,private readonly projectId:string){}
  private scope(projectId:string){if(projectId!==this.projectId)throw new DomainError('PROJECT_SCOPE','message belongs to another project');}
  async getSessionMessage(id:string):Promise<SessionMessageRecord|null>{
    const r=await this.client.query(`${SELECT_MESSAGE} WHERE m.project_id=$1 AND m.message_id=$2`,[this.projectId,id]);
    return r.rows[0]?message(r.rows[0]):null;
  }
  async getSessionMessages(ids:string[]):Promise<SessionMessageRecord[]>{
    const unique=[...new Set(ids)];
    if(unique.length>100)throw new RangeError('message source page exceeds 100');
    if(!unique.length)return[];
    const r=await this.client.query(`${SELECT_MESSAGE} WHERE m.project_id=$1 AND m.message_id=ANY($2::uuid[])`,[this.projectId,unique]);
    return r.rows.map(message);
  }
  async listSessionMessages(target:SessionTarget,limit:number,cursor?:string):Promise<{items:SessionMessageRecord[];nextCursor:string|null}>{
    if(!Number.isInteger(limit)||limit<1||limit>100)throw new RangeError('message limit must be 1..100');
    const key=target.kind==='owned'?'session_id':'link_id'; const value=target.kind==='owned'?target.sessionId:target.linkId;
    const r=await this.client.query(`${SELECT_MESSAGE} WHERE m.project_id=$1 AND m.target_kind=$2 AND m.${key}=$3
      AND ($4::uuid IS NULL OR (m.created_at,m.message_id)<(SELECT created_at,message_id FROM session_message WHERE project_id=$1 AND message_id=$4))
      ORDER BY m.created_at DESC,m.message_id DESC LIMIT $5`,[this.projectId,target.kind,value,cursor??null,limit+1]);
    const rows=r.rows.slice(0,limit);return{items:rows.map(message),nextCursor:r.rows.length>limit?rows.at(-1)!.message_id:null};
  }
  async listPendingSessionMessages(limit:number,offset=0):Promise<SessionMessageRecord[]>{
    if(!Number.isInteger(limit)||limit<1||limit>100)throw new RangeError('message limit must be 1..100');
    if(!Number.isSafeInteger(offset)||offset<0)throw new RangeError('message offset must be a nonnegative safe integer');
    const r=await this.client.query(`${SELECT_MESSAGE} WHERE m.project_id=$1 AND m.target_kind='owned'
      AND m.state IN ('queued','processing','unknown')
      AND (m.state<>'queued' OR (NOT EXISTS(SELECT 1 FROM session_message_processing busy
          WHERE busy.project_id=m.project_id AND busy.session_id=m.session_id AND busy.state IN ('dispatching','running','unknown'))
        AND NOT EXISTS(SELECT 1 FROM session_message older WHERE older.project_id=m.project_id
          AND older.session_id=m.session_id AND older.state='queued'
          AND (older.created_at,older.message_id)<(m.created_at,m.message_id))))
      ORDER BY CASE WHEN m.state IN ('processing','unknown') THEN 0 ELSE 1 END,
        CASE WHEN m.blocked_reason IS NULL THEN 0 ELSE 1 END,m.created_at,m.message_id LIMIT $2 OFFSET $3`,[this.projectId,limit,offset]);
    return r.rows.map(message);
  }
  async getSessionMessageProcessing(messageId:string):Promise<SessionMessageProcessing|null>{
    const r=await this.client.query('SELECT * FROM session_message_processing WHERE project_id=$1 AND message_id=$2',[this.projectId,messageId]);
    return r.rows[0]?processing(r.rows[0]):null;
  }
  async getSessionMessageManualStopEvidence(messageId:string):Promise<SessionMessageManualStopEvidence|null>{
    const r=await this.client.query('SELECT * FROM session_message_manual_stop_evidence WHERE project_id=$1 AND message_id=$2',
      [this.projectId,messageId]);
    return r.rows[0]?manualStopEvidence(r.rows[0]):null;
  }
  async getSessionMessageManualStopPreflight(messageId:string):Promise<SessionMessageManualStopPreflight|null>{
    const r=await this.client.query('SELECT * FROM session_message_manual_stop_preflight WHERE project_id=$1 AND message_id=$2',
      [this.projectId,messageId]);
    return r.rows[0]?manualStopPreflight(r.rows[0]):null;
  }
  async listSessionMessageProcessing(messageIds:string[]):Promise<SessionMessageProcessing[]>{
    const ids=[...new Set(messageIds)];
    if(!ids.length)return[];
    const r=await this.client.query('SELECT * FROM session_message_processing WHERE project_id=$1 AND message_id=ANY($2::uuid[]) ORDER BY started_at,processing_id',
      [this.projectId,ids]);
    return r.rows.map(processing);
  }
  async countSessionMessageTurns(sessionId:string,senderActorId:string):Promise<number>{
    const r=await this.client.query(`SELECT count(*)::integer AS count FROM session_message_processing p
      JOIN session_message m ON m.project_id=p.project_id AND m.message_id=p.message_id
      WHERE p.project_id=$1 AND p.session_id=$2 AND m.sender_actor_id=$3
        AND NOT (p.state='failed' AND p.native_turn_id IS NULL)`,[this.projectId,sessionId,senderActorId]);
    return r.rows[0]?.count??0;
  }
  async mustYieldBusiness(sessionId:string):Promise<boolean>{
    const r=await this.client.query('SELECT must_yield_business FROM session_message_schedule WHERE project_id=$1 AND session_id=$2',[this.projectId,sessionId]);
    return r.rows[0]?.must_yield_business===true;
  }
  async hasActiveSessionMessage(sessionId:string):Promise<boolean>{
    const r=await this.client.query(`SELECT 1 FROM session_message_processing WHERE project_id=$1 AND session_id=$2
      AND state IN ('dispatching','running','unknown') LIMIT 1`,[this.projectId,sessionId]);
    return !!r.rows[0];
  }
  async insertSessionMessage(v:SessionMessageRecord):Promise<void>{
    this.scope(v.projectId);
    if(v.target.kind==='owned'){
      // Serialize posting with close after the command's earlier ready read.
      const session=await this.client.query('SELECT state FROM runtime_session WHERE project_id=$1 AND session_id=$2 FOR UPDATE',
        [this.projectId,v.target.sessionId]);
      if(session.rows[0]?.state!=='ready')throw new DomainError('SESSION_NOT_READY','owned recipient must be a ready Session');
    }
    await this.client.query(`INSERT INTO session_message(project_id,message_id,operation_id,target_kind,session_id,link_id,sender_actor_id,content,context_task_id,context_task_revision_id,reply_to_message_id,state,version,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [v.projectId,v.id,v.operationId,v.target.kind,v.target.kind==='owned'?v.target.sessionId:null,v.target.kind==='external'?v.target.linkId:null,v.senderActorId,v.content,v.context?.taskId??null,v.context?.taskRevisionId??null,v.replyToMessageId,v.state,v.version,v.createdAt,v.updatedAt]);
  }
  async updateSessionMessage(v:SessionMessageRecord,expectedVersion:number):Promise<void>{
    this.scope(v.projectId);const r=await this.client.query(`UPDATE session_message SET state=$3,version=$4,updated_at=$5,blocked_reason=$7
      WHERE project_id=$1 AND message_id=$2 AND version=$6`,[v.projectId,v.id,v.state,v.version,v.updatedAt,expectedVersion,v.blockedReason]);
    if(!r.rowCount)throw new DomainError('VERSION_CONFLICT','message changed',(await this.getSessionMessage(v.id))?.version);
  }
  async insertSessionMessageProcessing(v:SessionMessageProcessing):Promise<void>{
    this.scope(v.projectId);
    if(!v.readOnlyPolicyFingerprint||!/^[a-f0-9]{64}$/.test(v.readOnlyPolicyFingerprint))
      throw new DomainError('POLICY_PROOF_MISSING','native Session execution admission policy proof is required');
    if(!v.receiverActorId?.trim())throw new DomainError('MESSAGE_RECIPIENT','actual receiving actor is required');
    try {
      await this.client.query(`INSERT INTO session_message_processing(project_id,processing_id,message_id,session_id,operation_id,receiver_actor_id,state,native_turn_id,response,failure,read_only_policy_fingerprint,version,started_at,updated_at,role_context)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,[v.projectId,v.id,v.messageId,v.sessionId,v.operationId,v.receiverActorId,v.state,v.nativeTurnId,v.response,v.failure,v.readOnlyPolicyFingerprint,v.version,v.startedAt,v.updatedAt,v.roleContext??null]);
    } catch (error) {
      if ((error as {constraint?:string}).constraint === 'acceptance_source_current')
        throw new DomainError('ACCEPTANCE_SOURCE_SUPERSEDED','Acceptance Delivery or arrangement changed before message start');
      throw error;
    }
  }
  async updateSessionMessageProcessing(v:SessionMessageProcessing,expectedVersion:number):Promise<void>{
    this.scope(v.projectId);const r=await this.client.query(`UPDATE session_message_processing SET state=$3,native_turn_id=$4,response=$5,failure=$6,version=$7,updated_at=$8,
      interrupt_operation_id=$10,interrupt_actor_id=$11,interrupt_reason=$12,interrupt_requested_at=$13,pre_turn_proof=$14::jsonb
      WHERE project_id=$1 AND processing_id=$2 AND version=$9`,[v.projectId,v.id,v.state,v.nativeTurnId,v.response,v.failure,v.version,v.updatedAt,expectedVersion,
      v.interruptOperationId??null,v.interruptActorId??null,v.interruptReason??null,v.interruptRequestedAt??null,
      v.preTurnProof?JSON.stringify(preTurnProofSchema.parse(v.preTurnProof)):null]);
    if(!r.rowCount)throw new DomainError('VERSION_CONFLICT','message processing changed');
  }
  async insertSessionMessageManualStopEvidence(v:SessionMessageManualStopEvidence):Promise<void>{
    this.scope(v.projectId);
    await this.client.query(`INSERT INTO session_message_manual_stop_evidence(project_id,message_id,processing_id,session_id,
      native_turn_id,operation_id,actor_id,reason,prior_failure,old_coordinator_pid,old_native_pid,
      old_coordinator_start_identity,old_native_start_identity,
      exit_evidence_ref,exit_evidence_hash,observed_native_status,observed_thread_status,observed_item_count,
      observed_item_ids_hash,recorded_at,preflight_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)`,
      [v.projectId,v.messageId,v.processingId,v.sessionId,v.nativeTurnId,v.operationId,v.actorId,v.reason,
        v.priorFailure,v.oldCoordinatorPid,v.oldNativePid,v.oldCoordinatorStartIdentity,v.oldNativeStartIdentity,
        v.exitEvidenceRef,v.exitEvidenceHash,
        v.observedNativeStatus,v.observedThreadStatus,v.observedItemCount,v.observedItemIdsHash,v.recordedAt,
        v.preflightId]);
  }
  async markSessionMessageInterruptAttempted(messageId:string,operationId:string,expectedVersion:number,at:string):Promise<boolean>{
    const r=await this.client.query(`UPDATE session_message_processing SET interrupt_attempted_at=$5,version=version+1,updated_at=$5
      WHERE project_id=$1 AND message_id=$2 AND interrupt_operation_id=$3 AND version=$4
      AND interrupt_attempted_at IS NULL AND state IN ('running','unknown')`,
      [this.projectId,messageId,operationId,expectedVersion,at]);
    return !!r.rowCount;
  }
  async insertSessionMessageReadReceipt(messageId:string,actorId:string,evidence:string,at:string):Promise<void>{
    await this.client.query(`INSERT INTO session_message_read_receipt(project_id,message_id,actor_id,evidence,recorded_at)
      VALUES($1,$2,$3,$4,$5)`,[this.projectId,messageId,actorId,evidence,at]);
  }
  async setSessionMessageBlockedReason(messageId:string,reason:string|null):Promise<void>{
    await this.client.query("UPDATE session_message SET blocked_reason=$3,version=version+1,updated_at=now() WHERE project_id=$1 AND message_id=$2 AND state='queued' AND blocked_reason IS DISTINCT FROM $3",[this.projectId,messageId,reason?.slice(0,4000)??null]);
  }
  async markSessionMessageSettled(sessionId:string,messageId:string,at:string):Promise<void>{
    await this.client.query(`INSERT INTO session_message_schedule(project_id,session_id,must_yield_business,last_message_id,updated_at)
      VALUES($1,$2,true,$3,$4) ON CONFLICT(project_id,session_id) DO UPDATE
      SET must_yield_business=true,last_message_id=$3,updated_at=$4`,[this.projectId,sessionId,messageId,at]);
  }
  async assertSessionVacant(sessionId:string,includeQueued=false):Promise<void>{
    await this.client.query('SELECT session_id FROM runtime_session WHERE project_id=$1 AND session_id=$2 FOR UPDATE',[this.projectId,sessionId]);
    const r=await this.client.query(`SELECT EXISTS(SELECT 1 FROM runtime_run WHERE project_id=$1 AND session_id=$2
      AND state IN ('requested','dispatching','running','unknown')) OR EXISTS(SELECT 1 FROM session_message_processing
      WHERE project_id=$1 AND session_id=$2 AND state IN ('dispatching','running','unknown'))
      OR ($3::boolean AND EXISTS(SELECT 1 FROM session_message WHERE project_id=$1 AND session_id=$2
        AND target_kind='owned' AND state='queued')) AS occupied`,[this.projectId,sessionId,includeQueued]);
    if(r.rows[0]?.occupied)throw new DomainError('SESSION_BUSY','Session has an active or unresolved turn');
  }
  async assertCurrentLeaderSource(messageId:string):Promise<void>{
    const source=await this.client.query(`SELECT task_id,task_revision_id,state,kind,notice_id FROM leader_result_notice
      WHERE project_id=$1 AND message_id=$2 AND kind IN ('task_todo','task_attention')`,[this.projectId,messageId]);
    if(!source.rows[0])return;
    const notice=source.rows[0];
    if(notice.kind==='task_attention'){
      const state=await taskAttentionNoticeCurrent(this.client,this.projectId,notice.notice_id);
      if(notice.state!=='linked'||state!=='current')
        throw new DomainError(state==='unknown'?'ATTENTION_SOURCE_UNKNOWN':'ATTENTION_SOURCE_EXPIRED',
          state==='unknown'?'Attention source observation is temporarily unknown':'Fixed attention source is no longer current');
      return;
    }
    const task=await this.client.query(`SELECT state,current_revision_id FROM task
      WHERE project_id=$1 AND task_id=$2 FOR UPDATE`,[this.projectId,notice.task_id]);
    const current=task.rows[0];
    if(notice.state!=='linked'||!current||current.state!=='todo'||
      current.current_revision_id!==notice.task_revision_id)
      throw new DomainError('TODO_SOURCE_SUPERSEDED','Fixed Leader todo is no longer current');
    const assignment=await this.client.query(`SELECT 1 FROM task_session_assignment
      WHERE project_id=$1 AND task_id=$2 AND task_revision_id=$3 AND state<>'released' LIMIT 1`,
      [this.projectId,notice.task_id,notice.task_revision_id]);
    if(assignment.rows[0])throw new DomainError('TODO_SOURCE_SUPERSEDED','Fixed Leader todo is already assigned');
  }
}
