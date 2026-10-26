import { createHash } from 'node:crypto';
import type { PoolClient, QueryResultRow } from 'pg';
import { DomainError } from '@evoloop/contracts/ports';
import type { ExecutionProfileRevision, SessionExecutionProfile, SessionRecoveryDecision,
  SessionRecoveryGate, SessionRecoveryTransaction } from '@evoloop/contracts/session-recovery';

const iso=(value:Date|string):string=>new Date(value).toISOString();
const gateOf=(r:QueryResultRow):SessionRecoveryGate=>({projectId:r.project_id,sessionId:r.session_id,
  version:r.version,phase:r.phase,causeKind:r.cause_kind,causeId:r.cause_id,causeState:r.cause_state,
  reason:r.reason,queueId:r.queue_id,claimId:r.claim_id,retryRunId:r.retry_run_id,
  resumeMessageId:r.resume_message_id,decisionOperationId:r.decision_operation_id,updatedAt:iso(r.updated_at)});
const revisionOf=(r:QueryResultRow):ExecutionProfileRevision=>({projectId:r.project_id,sessionId:r.session_id,
  revisionId:r.revision_id,version:r.version,previousRevisionId:r.previous_revision_id,
  model:r.model,sandbox:r.sandbox,approvalPolicy:r.approval_policy,cwd:r.cwd,
  authorizationScope:r.authorization_scope,provenance:r.provenance,operationId:r.operation_id,
  actorId:r.actor_id,reason:r.reason,evidenceRef:r.evidence_ref,createdAt:iso(r.created_at)});
const decisionOf=(r:QueryResultRow):SessionRecoveryDecision=>({projectId:r.project_id,id:r.decision_id,
  sessionId:r.session_id,kind:r.kind,expectedGateVersion:r.expected_gate_version,causeId:r.cause_id,
  sourceRunId:r.source_run_id,sourceInputHash:r.source_input_hash,retryRunId:r.retry_run_id,
  resumeMessageId:r.resume_message_id,actorId:r.actor_id,reason:r.reason,evidenceRef:r.evidence_ref,
  createdAt:iso(r.created_at)});
const conflict=(message:string,current?:number)=>new DomainError('VERSION_CONFLICT',message,current);
const dynamicSessionId=(dispatchId:string):string=>{
  const bytes=Buffer.from(createHash('sha256').update(JSON.stringify([dispatchId,'session'])).digest().subarray(0,16));
  bytes[6]=(bytes[6]!&0x0f)|0x50;
  bytes[8]=(bytes[8]!&0x3f)|0x80;
  const hex=bytes.toString('hex');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
};

/** The caller owns the project transaction; all mutations take the existing Session slot lock. */
export class PgSessionRecovery implements SessionRecoveryTransaction {
  constructor(private readonly client:PoolClient,private readonly projectId:string){}
  private scope(projectId:string){if(projectId!==this.projectId)throw new DomainError('PROJECT_SCOPE','Recovery belongs to another project');}
  private async slot(sessionId:string){await this.client.query('SELECT session_recovery_slot_lock($1,$2)',[this.projectId,sessionId]);}
  async isDynamicSession(sessionId:string):Promise<boolean>{
    const result=await this.client.query(`SELECT dispatch_id FROM orchestration_dispatch
      WHERE project_id=$1 AND binding_id IS NOT NULL ORDER BY dispatch_id LIMIT 10001`,[this.projectId]);
    // An incomplete bounded scan cannot prove a Session is static.
    if(result.rows.length>10000)return true;
    return result.rows.some(row=>dynamicSessionId(row.dispatch_id as string)===sessionId);
  }
  async getRecoveryGate(sessionId:string):Promise<SessionRecoveryGate|null>{
    const r=await this.client.query('SELECT * FROM session_recovery_gate WHERE project_id=$1 AND session_id=$2',[this.projectId,sessionId]);
    return r.rows[0]?gateOf(r.rows[0]):null;
  }
  async lockRecoveryGate(sessionId:string):Promise<SessionRecoveryGate>{
    await this.slot(sessionId);
    const r=await this.client.query('SELECT * FROM session_recovery_gate WHERE project_id=$1 AND session_id=$2 FOR UPDATE',[this.projectId,sessionId]);
    if(!r.rows[0])throw new DomainError('NOT_FOUND','Session recovery gate not found');
    return gateOf(r.rows[0]);
  }
  async getExecutionProfileRevision(sessionId:string,revisionId:string):Promise<ExecutionProfileRevision|null>{
    const r=await this.client.query('SELECT * FROM session_execution_profile_revision WHERE project_id=$1 AND session_id=$2 AND revision_id=$3',[this.projectId,sessionId,revisionId]);
    return r.rows[0]?revisionOf(r.rows[0]):null;
  }
  async getCurrentExecutionProfile(sessionId:string):Promise<SessionExecutionProfile|null>{
    const r=await this.client.query(`SELECT p.*,h.activation_state,h.active_revision_id,h.activation_operation_id,h.attempted_at,h.activation_evidence
      FROM session_execution_profile h JOIN session_execution_profile_revision p
      ON p.project_id=h.project_id AND p.session_id=h.session_id AND p.revision_id=h.revision_id
      WHERE h.project_id=$1 AND h.session_id=$2`,[this.projectId,sessionId]);
    const row=r.rows[0];return row?{revision:revisionOf(row),activationState:row.activation_state,
      activeRevisionId:row.active_revision_id,activationOperationId:row.activation_operation_id,
      attemptedAt:row.attempted_at?iso(row.attempted_at):null,activationEvidence:row.activation_evidence}:null;
  }
  async listRecoveryDecisions(sessionId:string,limit=50):Promise<SessionRecoveryDecision[]>{
    if(!Number.isInteger(limit)||limit<1||limit>100)throw new DomainError('LIMIT_INVALID','Recovery decision limit must be 1..100');
    const r=await this.client.query('SELECT * FROM session_recovery_decision WHERE project_id=$1 AND session_id=$2 ORDER BY created_at DESC,decision_id DESC LIMIT $3',[this.projectId,sessionId,limit]);
    return r.rows.map(decisionOf);
  }
  async adoptExecutionProfile(revision:ExecutionProfileRevision,expectedSessionVersion:number):Promise<void>{
    this.scope(revision.projectId);
    const gate=await this.lockRecoveryGate(revision.sessionId);
    if(!['open','blocked'].includes(gate.phase))throw new DomainError('RECOVERY_BLOCKED','Session recovery is already in progress');
    const current=await this.getCurrentExecutionProfile(revision.sessionId);
    if(!current||!['active','rejected','pending'].includes(current.activationState)||
      (current.activationState==='pending'&&current.activationOperationId!==null)||
      revision.previousRevisionId!==current.revision.revisionId||
      revision.version!==current.revision.version+1||revision.provenance!=='revised'||
      revision.operationId==='00000000-0000-0000-0000-000000000000')
      throw new DomainError('EXECUTION_PROFILE_CONFLICT','Execution profile basis changed');
    const before=current.revision;
    if(revision.model===before.model||revision.sandbox!==before.sandbox||revision.approvalPolicy!==before.approvalPolicy||
      revision.cwd!==before.cwd||revision.authorizationScope!==before.authorizationScope)
      throw new DomainError('EXECUTION_PROFILE_CONFLICT','Only the configured model may change');
    const busy=await this.client.query(`SELECT 1 FROM runtime_run WHERE project_id=$1 AND session_id=$2 AND state IN ('requested','dispatching','running','unknown')
      UNION ALL SELECT 1 FROM session_message_processing WHERE project_id=$1 AND session_id=$2 AND state IN ('dispatching','running','unknown')
      LIMIT 1`,[this.projectId,revision.sessionId]);
    if(busy.rows[0])throw new DomainError('SESSION_BUSY','Session is occupied');
    const session=await this.client.query('SELECT version,state,model FROM runtime_session WHERE project_id=$1 AND session_id=$2 FOR UPDATE',[this.projectId,revision.sessionId]);
    if(session.rows[0]?.version!==expectedSessionVersion)throw conflict('Session version changed',session.rows[0]?.version);
    if(session.rows[0].state!=='ready'||session.rows[0].model!==before.model)throw new DomainError('SESSION_NOT_READY','Session identity changed');
    await this.client.query(`INSERT INTO session_execution_profile_revision(project_id,session_id,revision_id,version,previous_revision_id,model,sandbox,approval_policy,cwd,
      authorization_scope,provenance,operation_id,actor_id,reason,evidence_ref,created_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [this.projectId,revision.sessionId,revision.revisionId,revision.version,revision.previousRevisionId,revision.model,
        revision.sandbox,revision.approvalPolicy,revision.cwd,revision.authorizationScope,revision.provenance,
        revision.operationId,revision.actorId,revision.reason,revision.evidenceRef,revision.createdAt]);
    const head=await this.client.query(`UPDATE session_execution_profile SET revision_id=$3,activation_state='pending',activation_operation_id=NULL,
      attempted_at=NULL,activation_evidence=NULL WHERE project_id=$1 AND session_id=$2 AND revision_id=$4`,
      [this.projectId,revision.sessionId,revision.revisionId,before.revisionId]);
    if(!head.rowCount)throw conflict('Execution profile changed');
    const updated=await this.client.query(`UPDATE runtime_session SET model=$3,version=version+1,updated_at=$4
      WHERE project_id=$1 AND session_id=$2 AND version=$5`,[this.projectId,revision.sessionId,revision.model,revision.createdAt,expectedSessionVersion]);
    if(!updated.rowCount)throw conflict('Session version changed');
    // The pending profile itself bars native startup. Preserve a failed claim's cause,
    // original message, and retry permit until the requested Run is persisted.
  }
  async beginExecutionProfileActivation(sessionId:string,revisionId:string,operationId:string):Promise<boolean>{
    const gate=await this.lockRecoveryGate(sessionId);
    const profile=await this.getCurrentExecutionProfile(sessionId);
    if(!profile||profile.revision.revisionId!==revisionId||profile.revision.operationId!==operationId)
      throw new DomainError('EXECUTION_PROFILE_CONFLICT','Exact revision and operation required');
    if(profile.activationState!=='pending')return false;
    if(!['open','retrying'].includes(gate.phase))
      throw new DomainError('RECOVERY_BLOCKED','Revision activation has no native startup permit');
    const requested=await this.client.query(`SELECT run_id FROM runtime_run WHERE project_id=$1 AND session_id=$2
      AND state='requested' AND execution_profile_snapshot->>'revisionId'=$3
      AND ($4='open' OR run_id=$5::uuid) ORDER BY created_at DESC,run_id DESC LIMIT 1`,
      [this.projectId,sessionId,revisionId,gate.phase,gate.retryRunId]);
    if(!requested.rows[0])throw new DomainError('RUN_NOT_REQUESTED','Exact requested Run with fixed profile is required');
    const r=await this.client.query(`UPDATE session_execution_profile SET activation_state='attempting',activation_operation_id=$3,
      attempted_at=now() WHERE project_id=$1 AND session_id=$2 AND revision_id=$4 AND activation_state='pending'`,
      [this.projectId,sessionId,operationId,revisionId]);
    return !!r.rowCount;
  }
  async settleExecutionProfileActivation(sessionId:string,revisionId:string,state:'active'|'unknown'|'rejected',evidence:string):Promise<void>{
    const gate=await this.lockRecoveryGate(sessionId);
    const profile=await this.getCurrentExecutionProfile(sessionId);
    if(!profile||profile.revision.revisionId!==revisionId||
      !(profile.activationState==='attempting'||(profile.activationState==='unknown'&&state==='active'))||
      profile.activationOperationId!==profile.revision.operationId)
      throw new DomainError('EXECUTION_PROFILE_CONFLICT','Only the original activation attempt can settle');
    await this.client.query(`UPDATE session_execution_profile SET activation_state=$3,
      active_revision_id=CASE WHEN $3='active' THEN revision_id ELSE active_revision_id END,activation_evidence=$4
      WHERE project_id=$1 AND session_id=$2`,[this.projectId,sessionId,state,evidence]);
    if(state!=='active'){
      const requested=await this.client.query(`SELECT run_id FROM runtime_run WHERE project_id=$1 AND session_id=$2
        AND state='requested' AND native_turn_id IS NULL AND execution_profile_snapshot->>'revisionId'=$3
        AND ($4::uuid IS NULL OR run_id=$4::uuid) ORDER BY created_at DESC,run_id DESC LIMIT 1`,
        [this.projectId,sessionId,revisionId,gate.retryRunId]);
      if(!requested.rows[0])throw new DomainError('RUN_NOT_REQUESTED','Activation outcome lost its exact requested Run');
      await this.client.query(`UPDATE session_recovery_gate SET phase='blocked',cause_kind='execution_profile',cause_id=$3,
        cause_state=$4,retry_run_id=$5,reason='Execution profile activation outcome requires explicit review',
        version=version+1,updated_at=now() WHERE project_id=$1 AND session_id=$2`,
        [this.projectId,sessionId,revisionId,state,requested.rows[0].run_id]);
    }
  }
  async saveRecoveryDecision(decision:SessionRecoveryDecision,next:SessionRecoveryGate,expectedVersion:number):Promise<void>{
    this.scope(decision.projectId);this.scope(next.projectId);
    if(decision.sessionId!==next.sessionId||decision.expectedGateVersion!==expectedVersion||!decision.reason.trim()||!decision.evidenceRef.trim())
      throw new DomainError('RECOVERY_DECISION_INVALID','Recovery decision does not match gate');
    const gate=await this.lockRecoveryGate(decision.sessionId);
    if(gate.version!==expectedVersion)throw conflict('Recovery gate changed',gate.version);
    if(gate.phase!=='blocked'||gate.causeId!==decision.causeId||
      next.resumeMessageId!==decision.resumeMessageId||next.version!==gate.version+1||
      next.causeId!==gate.causeId||next.causeKind!==gate.causeKind||next.queueId!==gate.queueId||
      next.decisionOperationId!==decision.id)
      throw new DomainError('RECOVERY_SOURCE_CHANGED','Recovery decision cannot change the original cause or message');
    if(gate.resumeMessageId){
      const pinned=await this.client.query(`SELECT state,session_id FROM session_message
        WHERE project_id=$1 AND message_id=$2 FOR UPDATE`,[this.projectId,gate.resumeMessageId]);
      if(pinned.rows[0]?.session_id!==gate.sessionId)
        throw new DomainError('RECOVERY_MESSAGE_CHANGED','Original pinned message changed');
      const processing=await this.client.query(`SELECT state FROM session_message_processing
        WHERE project_id=$1 AND message_id=$2 FOR UPDATE`,[this.projectId,gate.resumeMessageId]);
      if(['dispatching','running','unknown'].includes(processing.rows[0]?.state??'')||
        ['processing','unknown'].includes(pinned.rows[0].state))
        throw new DomainError('RECOVERY_MESSAGE_CHANGED','Original pinned message remains unresolved');
      if(pinned.rows[0].state==='queued'){
        if(next.resumeMessageId!==gate.resumeMessageId)
          throw new DomainError('RECOVERY_MESSAGE_CHANGED','Queued original message must remain pinned');
      }else if(['replied','completed_without_reply','failed','cancelled'].includes(pinned.rows[0].state)){
        if(decision.kind!=='resume'||next.resumeMessageId!==null)
          throw new DomainError('RECOVERY_MESSAGE_CHANGED','Settled original message cannot be dispatched again');
      }else throw new DomainError('RECOVERY_MESSAGE_CHANGED','Original pinned message state is invalid');
    }else if(next.resumeMessageId!==null)
      throw new DomainError('RECOVERY_MESSAGE_CHANGED','Recovery cannot pin a different message');
    if(decision.kind==='retry_failed'){
      if(gate.causeKind!=='run'||!['failed','interrupted'].includes(gate.causeState??'')||
        decision.sourceRunId!==gate.causeId||!decision.sourceInputHash||!decision.retryRunId||
        next.phase!=='retrying'||next.retryRunId!==decision.retryRunId||!gate.claimId||next.claimId!==gate.claimId)
        throw new DomainError('RECOVERY_DECISION_INVALID','Retry must name the exact failed claim and successor Run');
      const source=await this.client.query(`SELECT r.state,r.input_hash,a.claim_id,c.released_at,
          a.sequence=(SELECT max(other.sequence) FROM resident_queue_attempt other
            WHERE other.project_id=a.project_id AND other.claim_id=a.claim_id) AS latest FROM runtime_run r
        JOIN resident_queue_attempt a ON a.project_id=r.project_id AND a.run_id=r.run_id
        JOIN resident_queue_claim c ON c.project_id=a.project_id AND c.claim_id=a.claim_id
        WHERE r.project_id=$1 AND r.run_id=$2`,[this.projectId,gate.causeId]);
      if(source.rows[0]?.claim_id!==gate.claimId||source.rows[0]?.released_at||!source.rows[0]?.latest||
        source.rows[0]?.state!==gate.causeState||source.rows[0]?.input_hash!==decision.sourceInputHash)
        throw new DomainError('RECOVERY_SOURCE_CHANGED','Failed original claim/input changed');
    }else if(decision.kind==='resume'){
      const profileRetry=gate.causeKind==='execution_profile'&&gate.retryRunId!==null;
      const claim=gate.claimId?await this.client.query(`SELECT released_at FROM resident_queue_claim
        WHERE project_id=$1 AND claim_id=$2 AND session_id=$3 FOR UPDATE`,
        [this.projectId,gate.claimId,gate.sessionId]):null;
      if(gate.claimId&&!claim?.rows[0])throw new DomainError('CLAIM_MISMATCH','Recorded claim is unavailable');
      const retainedClaimId=claim?.rows[0]?.released_at?null:gate.claimId;
      if(decision.retryRunId!==gate.retryRunId||next.retryRunId!==gate.retryRunId||
        next.claimId!==retainedClaimId||
        next.phase!==(profileRetry?'retrying':next.resumeMessageId?'message_pending':retainedClaimId?'awaiting_acceptance':'open'))
        throw new DomainError('RECOVERY_DECISION_INVALID','Resume must preserve the pinned message and claim');
      if(gate.causeKind==='message'){
        const message=await this.client.query('SELECT state,session_id FROM session_message WHERE project_id=$1 AND message_id=$2',
          [this.projectId,gate.causeId]);
        if(message.rows[0]?.session_id!==gate.sessionId||
          !['replied','completed_without_reply','failed'].includes(message.rows[0]?.state))
          throw new DomainError('MESSAGE_UNSETTLED','Original message outcome is not resolved');
      }
      if(gate.causeKind==='run'){
        const source=await this.client.query('SELECT state,session_id FROM runtime_run WHERE project_id=$1 AND run_id=$2',
          [this.projectId,gate.causeId]);
        if(source.rows[0]?.session_id!==gate.sessionId||
          !['completed','failed','interrupted'].includes(source.rows[0]?.state)||
          (retainedClaimId&&source.rows[0]?.state!=='completed'))
          throw new DomainError('RUN_UNSETTLED','Original Run requires reconciliation or failed-claim retry');
      }
      if(profileRetry){
        const p=await this.getCurrentExecutionProfile(decision.sessionId);
        const requested=await this.client.query(`SELECT 1 FROM runtime_run WHERE project_id=$1 AND session_id=$2
          AND run_id=$3 AND state='requested' AND native_turn_id IS NULL
          AND execution_profile_snapshot->>'revisionId'=$4`,
          [this.projectId,decision.sessionId,gate.retryRunId,gate.causeId]);
        if(p?.activationState!=='active'||p.revision.revisionId!==gate.causeId||!requested.rows[0])
          throw new DomainError('PROFILE_ACTIVATION_UNRESOLVED','Exact requested Run and positive activation readback required');
      }
    }else throw new DomainError('RECOVERY_DECISION_INVALID','Unsupported recovery decision');
    await this.client.query(`INSERT INTO session_recovery_decision(project_id,decision_id,session_id,kind,expected_gate_version,cause_id,
      source_run_id,source_input_hash,retry_run_id,resume_message_id,actor_id,reason,evidence_ref,created_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [this.projectId,decision.id,decision.sessionId,decision.kind,decision.expectedGateVersion,decision.causeId,
        decision.sourceRunId,decision.sourceInputHash,decision.retryRunId,decision.resumeMessageId,
        decision.actorId,decision.reason,decision.evidenceRef,decision.createdAt]);
    const r=await this.client.query(`UPDATE session_recovery_gate SET version=$3,phase=$4,cause_kind=$5,cause_id=$6,cause_state=$7,
      reason=$8,queue_id=$9,claim_id=$10,retry_run_id=$11,resume_message_id=$12,decision_operation_id=$13,updated_at=$14
      WHERE project_id=$1 AND session_id=$2 AND version=$15`,
      [this.projectId,decision.sessionId,next.version,next.phase,next.causeKind,next.causeId,next.causeState,next.reason,
        next.queueId,next.claimId,next.retryRunId,next.resumeMessageId,next.decisionOperationId,next.updatedAt,expectedVersion]);
    if(!r.rowCount)throw conflict('Recovery gate changed');
  }
  async assertStartupAllowed(sessionId:string,kind:'run'|'message',id:string):Promise<void>{
    const gate=await this.lockRecoveryGate(sessionId);
    const profile=await this.getCurrentExecutionProfile(sessionId);
    const permitted=gate.phase==='open'||(kind==='run'&&gate.phase==='retrying'&&gate.retryRunId===id)||
      (kind==='message'&&gate.phase==='message_pending'&&gate.resumeMessageId===id);
    if(!permitted)throw new DomainError('RECOVERY_BLOCKED','Session recovery gate blocks startup');
    if(profile?.activationState==='active')return;
    if(kind==='run'&&profile?.activationState==='pending'){
      const existing=await this.client.query('SELECT 1 FROM runtime_run WHERE project_id=$1 AND run_id=$2',
        [this.projectId,id]);
      if(!existing.rows[0])return; // reserve precheck only; dispatch of that persisted Run still waits
    }
    throw new DomainError('PROFILE_NOT_ACTIVE','Execution profile is not confirmed');
  }
}
