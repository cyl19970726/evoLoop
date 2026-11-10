import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { Principal } from '@evoloop/contracts';
import { DomainError } from '@evoloop/contracts/ports';
import { RuntimeCompactionPreflightError } from '@evoloop/adapter-codex-app-server';
import { RuntimeServerError, RuntimeUnknownError, type RuntimeBinding, type RuntimeCompactionObservation } from '@evoloop/contracts/runtime';
import type { RuntimeRunner } from './runner.js';
import { runtimeForBinding } from './routed.js';

export interface CompactionIntent {
  operationId:string; threadId:string; expectedSessionVersion:number; expectedGateVersion:number;
  evidenceRef:string; reason:string;
}
interface Row {
  project_id:string; operation_id:string; session_id:string; thread_id:string;
  request_hash:string; gate_version:number; session_version:number; actor_id:string;
  state:'unknown'|'accepted'|'completed'|'failed'; native_request_id:number|null;
  native_acknowledged_at:Date|null; native_connection_id:string|null;
  baseline_turn_id:string|null; native_turn_id:string|null; compaction_item_id:string|null;
  error_code:string|null; before_input_tokens:string|null; after_input_tokens:string|null;
  created_at:Date; updated_at:Date;
}
const hash=(input:CompactionIntent)=>createHash('sha256').update(JSON.stringify(input)).digest('hex');
const assertSame=(row:Row,sessionId:string,input:CompactionIntent,actorId:string)=>{
  if(row.session_id!==sessionId||row.request_hash!==hash(input)||row.actor_id!==actorId)
    throw new DomainError('OPERATION_REUSED','Compaction operation ID has a different intent');
};
const view=(row:Row)=>({projectId:row.project_id,operationId:row.operation_id,
  sessionId:row.session_id,threadId:row.thread_id,gateVersion:row.gate_version,
  sessionVersion:row.session_version,state:row.state,nativeRequestId:row.native_request_id,
  nativeAcknowledgedAt:row.native_acknowledged_at?.toISOString()??null,
  baselineTurnId:row.baseline_turn_id,nativeTurnId:row.native_turn_id,
  compactionItemId:row.compaction_item_id,errorCode:row.error_code,
  beforeInputTokens:row.before_input_tokens==null?null:Number(row.before_input_tokens),
  afterInputTokens:row.after_input_tokens==null?null:Number(row.after_input_tokens),
  createdAt:row.created_at.toISOString(),updatedAt:row.updated_at.toISOString()});

/** Persist first, send once on the existing owner connection, reconcile by the same ID. */
export class CompactionMaintenance {
  private readonly pool:Pool;
  private readonly runner:RuntimeRunner;
  /**
   * `owned` is the configured policy (runtime.compaction.owned). When it is false, or the runtime of the
   * Session's own binding declares no owner compaction request, new operations are refused before any
   * native call; reads and reconciliation of operations already recorded stay available so no persisted
   * intent is stranded.
   */
  constructor(pool:Pool,runner:RuntimeRunner,private readonly policy:{owned?:()=>boolean}={}){this.pool=pool;this.runner=runner}
  private requireOwnedPolicy(){
    if(this.policy.owned&&!this.policy.owned())
      throw new DomainError('CAPABILITY_UNAVAILABLE','Owner compaction is disabled; the native runtime compacts automatically');
  }
  /** A coordinator driving several runtimes asks the one this Session runs on, not the default. */
  private requireOwnedRequest(binding:RuntimeBinding){
    const declared=runtimeForBinding(this.runner.nativeAdapter(),binding).capabilities?.();
    if(declared&&declared.compaction.mode!=='owned_request')
      throw new DomainError('CAPABILITY_UNAVAILABLE','The native runtime does not accept owner compaction requests');
  }
  private authorize(principal:Principal,projectId:string){
    if(!principal.projectIds.includes(projectId)||!principal.permissions.includes('review')||
      !principal.permissions.includes('write')||principal.actorId.startsWith('worker-'))
      throw new DomainError('FORBIDDEN','Compaction maintenance requires a project reviewer');
  }
  private async row(projectId:string,operationId:string,client:Pool|PoolClient=this.pool):Promise<Row|null>{
    const result=await client.query<Row>('SELECT * FROM session_compaction WHERE project_id=$1 AND operation_id=$2',
      [projectId,operationId]);
    return result.rows[0]??null;
  }
  async read(principal:Principal,projectId:string,operationId:string){
    if(!principal.projectIds.includes(projectId)||!principal.permissions.includes('review'))
      throw new DomainError('FORBIDDEN','Compaction history requires a project reviewer');
    const saved=await this.row(projectId,operationId);
    if(!saved)throw new DomainError('NOT_FOUND','Compaction operation not found');
    return view(saved);
  }
  async start(principal:Principal,projectId:string,sessionId:string,input:CompactionIntent){
    this.authorize(principal,projectId);
    const existing=await this.row(projectId,input.operationId);
    if(existing){
      assertSame(existing,sessionId,input,principal.actorId);
      return view(existing);
    }
    this.requireOwnedPolicy();
    let binding:Awaited<ReturnType<RuntimeRunner['compactionBinding']>>;
    let before:RuntimeCompactionObservation;
    try{
      binding=await this.runner.compactionBinding(principal,projectId,sessionId,
        input.expectedSessionVersion,input.threadId);
      this.requireOwnedRequest(binding);
      before=await this.runner.observeCompaction(binding);
      if(!['idle','systemError','notLoaded'].includes(before.threadStatus)||
        before.threadStatus!=='idle'&&
          (before.latestTurnStatus!=='failed'||!before.latestTurnCompletedAtUtc)||
        before.model!==binding.resumeProfile?.model||
        before.latestTurnId&&!before.latestTurnCompletedAtUtc)
        throw new DomainError('COMPACTION_NATIVE_BUSY','Owned Thread lacks settled history or the exact profile');
    }catch(error){
      const raced=await this.row(projectId,input.operationId);
      if(raced){assertSame(raced,sessionId,input,principal.actorId);return view(raced)}
      throw error;
    }
    const client=await this.pool.connect();
    let saved:Row;
    let inserted=false;
    try{
      await client.query('BEGIN');
      // Same order as core writes and native-start admission: project lock, then the Session slot lock,
      // then the recovery gate, then the Session row. A direct input start holds the Session row and
      // reaches the gate through the slot lock; locking the gate first here waited on each other (40P01).
      // Do not move the Session row ahead of the gate: queue claims take slot lock, gate, Session row.
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[projectId]);
      const prior=await this.row(projectId,input.operationId,client);
      if(prior){
        assertSame(prior,sessionId,input,principal.actorId);
        saved=prior;
      }else{
        await client.query('SELECT session_recovery_slot_lock($1,$2)',[projectId,sessionId]);
        const gate=await client.query<{version:number;phase:string;cause_kind:string|null;cause_id:string|null}>(`SELECT version,phase,cause_kind,cause_id FROM session_recovery_gate
          WHERE project_id=$1 AND session_id=$2 FOR UPDATE`,[projectId,sessionId]);
        if(gate.rows[0]?.version!==input.expectedGateVersion||gate.rows[0]?.phase!=='blocked')
          throw new DomainError('COMPACTION_GATE_CHANGED','Exact blocked recovery gate changed');
        const cause=gate.rows[0];
        if(cause.cause_kind==='run'){
          const original=await client.query<{state:string;native_turn_id:string|null}>(`SELECT state,native_turn_id
            FROM runtime_run WHERE project_id=$1 AND run_id=$2 AND session_id=$3`,
            [projectId,cause.cause_id,sessionId]);
          if(!['failed','interrupted'].includes(original.rows[0]?.state??'')||
            !original.rows[0]?.native_turn_id||original.rows[0].native_turn_id!==before.latestTurnId)
            throw new DomainError('COMPACTION_ORIGINAL_UNSETTLED','Exact original Run Turn is not terminal');
        }else if(cause.cause_kind==='message'){
          const original=await client.query<{state:string;native_turn_id:string|null}>(`SELECT m.state,p.native_turn_id
            FROM session_message m LEFT JOIN session_message_processing p
            ON p.project_id=m.project_id AND p.message_id=m.message_id
            WHERE m.project_id=$1 AND m.message_id=$2 AND m.session_id=$3`,
            [projectId,cause.cause_id,sessionId]);
          if(original.rows[0]?.state!=='failed'||!original.rows[0]?.native_turn_id||
            original.rows[0].native_turn_id!==before.latestTurnId)
            throw new DomainError('COMPACTION_ORIGINAL_UNSETTLED','Exact original message Turn is not terminal');
        }else throw new DomainError('COMPACTION_ORIGINAL_UNSETTLED','Blocked gate has no eligible terminal origin');
        const session=await client.query<{version:number;native_thread_id:string;state:string}>(`SELECT version,native_thread_id,state FROM runtime_session
          WHERE project_id=$1 AND session_id=$2 FOR UPDATE`,[projectId,sessionId]);
        if(session.rows[0]?.version!==input.expectedSessionVersion||session.rows[0]?.native_thread_id!==input.threadId||
          session.rows[0]?.state!=='ready')
          throw new DomainError('COMPACTION_SESSION_CHANGED','Exact managed Session changed');
        const run=await client.query(`SELECT 1 FROM runtime_run WHERE project_id=$1 AND session_id=$2
          AND state IN ('requested','dispatching','running','unknown') LIMIT 1`,[projectId,sessionId]);
        const message=await client.query(`SELECT 1 FROM session_message_processing WHERE project_id=$1 AND session_id=$2
          AND state IN ('dispatching','running','unknown') LIMIT 1`,[projectId,sessionId]);
        if(run.rowCount||message.rowCount)
          throw new DomainError('COMPACTION_OPERATION_UNSETTLED','Original Run or message must be reconciled first');
        const priorGate=await client.query(`SELECT 1 FROM session_compaction WHERE project_id=$1
          AND session_id=$2 AND gate_version=$3`,[projectId,sessionId,input.expectedGateVersion]);
        if(priorGate.rowCount)throw new DomainError('COMPACTION_ALREADY_ATTEMPTED','This blocked gate has a saved compaction attempt');
        const created=await client.query<Row>(`INSERT INTO session_compaction
          (project_id,operation_id,session_id,thread_id,request_hash,gate_version,session_version,
           actor_id,evidence_ref,reason,state,baseline_turn_id,before_input_tokens)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'unknown',$11,$12) RETURNING *`,
          [projectId,input.operationId,sessionId,input.threadId,hash(input),input.expectedGateVersion,
            input.expectedSessionVersion,principal.actorId,input.evidenceRef,input.reason,
            before.latestTurnId,before.tokenUsage?.inputTokens??null]);
        saved=created.rows[0]!;
        inserted=true;
      }
      await client.query('COMMIT');
    }catch(error){
      await client.query('ROLLBACK');
      // The other request may have committed while this one waited on the gate.
      const raced=await this.row(projectId,input.operationId);
      if(raced){assertSame(raced,sessionId,input,principal.actorId);return view(raced)}
      throw error;
    }finally{client.release()}
    if(!inserted)return view(saved);
    // A concurrent identical HTTP request can read the same freshly inserted row.
    // Claim the one send with a durable CAS before invoking the adapter.
    const claim=await this.pool.query(`UPDATE session_compaction SET updated_at=now()
      WHERE project_id=$1 AND operation_id=$2 AND native_request_id IS NULL AND updated_at=created_at
      RETURNING operation_id`,[projectId,input.operationId]);
    if(claim.rowCount!==1)return this.read(principal,projectId,input.operationId);
    try{
      const turnId=await this.runner.compactThread(binding,saved.baseline_turn_id!,async requestId=>{
        await this.pool.query(`UPDATE session_compaction SET native_request_id=$3,updated_at=now()
          WHERE project_id=$1 AND operation_id=$2 AND state='unknown'`,[projectId,input.operationId,requestId]);
      },async connectionId=>{
        const acknowledged=await this.pool.query(`UPDATE session_compaction SET native_acknowledged_at=now(),native_connection_id=$3,updated_at=now()
          WHERE project_id=$1 AND operation_id=$2 AND state='unknown'
            AND native_request_id IS NOT NULL AND native_acknowledged_at IS NULL RETURNING operation_id`,
          [projectId,input.operationId,connectionId]);
        if(acknowledged.rowCount!==1)
          throw new DomainError('COMPACTION_ACK_NOT_SAVED','Native acknowledgement could not be persisted');
      });
      await this.pool.query(`UPDATE session_compaction SET state=CASE WHEN $3::text IS NULL THEN 'unknown' ELSE 'accepted' END,
        native_turn_id=$3,updated_at=now()
        WHERE project_id=$1 AND operation_id=$2 AND state='unknown'`,[projectId,input.operationId,turnId]);
    }catch(error){
      if(error instanceof RuntimeCompactionPreflightError){
        await this.pool.query(`UPDATE session_compaction SET state='failed',error_code=$3,updated_at=now()
          WHERE project_id=$1 AND operation_id=$2 AND state='unknown'`,
          [projectId,input.operationId,`preflight_${error.code}`]);
      }else if(error instanceof RuntimeServerError){
        await this.pool.query(`UPDATE session_compaction SET state='failed',error_code=$3,updated_at=now()
          WHERE project_id=$1 AND operation_id=$2 AND state='unknown'`,
          [projectId,input.operationId,`native_${error.category}`]);
      }else if(error instanceof RuntimeUnknownError && error.observedTurnId){
        await this.pool.query(`UPDATE session_compaction SET native_turn_id=$3,updated_at=now()
          WHERE project_id=$1 AND operation_id=$2 AND state='unknown'`,
          [projectId,input.operationId,error.observedTurnId]);
      }else if(!(error instanceof RuntimeUnknownError)){
        // Preflight and unsupported protocol are known before dispatch, but a
        // crash around the call cannot safely be inferred from a missing reply.
        await this.pool.query(`UPDATE session_compaction SET error_code='preflight_or_unknown',updated_at=now()
          WHERE project_id=$1 AND operation_id=$2 AND state='unknown'`,[projectId,input.operationId]);
      }
    }
    return this.read(principal,projectId,input.operationId);
  }
  async reconcile(principal:Principal,projectId:string,operationId:string){
    this.authorize(principal,projectId);
    const saved=await this.row(projectId,operationId);
    if(!saved)throw new DomainError('NOT_FOUND','Compaction operation not found');
    if(saved.state==='completed'||saved.state==='failed')return this.read(principal,projectId,operationId);
    // The request ID is saved before writing to native stdin. A lost response
    // and an unrelated later compaction Turn cannot establish acceptance.
    if(!saved.native_acknowledged_at&&!saved.native_turn_id)
      return this.read(principal,projectId,operationId);
    const binding=await this.runner.compactionBinding(principal,projectId,saved.session_id,
      saved.session_version,saved.thread_id);
    let turnId=saved.native_turn_id;
    if(!turnId&&saved.native_acknowledged_at&&saved.native_request_id&&saved.baseline_turn_id){
      // A later owner process can observe a different writer's sole successor.
      // History alone does not identify the original accepted request.
      if(!saved.native_connection_id||this.runner.compactionConnectionId()!==saved.native_connection_id)
        return this.read(principal,projectId,operationId);
      const successors=await this.runner.compactionTurnsAfter(binding,saved.baseline_turn_id);
      if(successors?.length===1){
        const candidate=await this.runner.observeCompaction(binding,successors[0]);
        // A lost notification can be attributed only to the sole successor
        // with persisted compaction evidence. A failed Turn without an Item
        // needs its captured turn/started ID to establish ownership.
        if(candidate.latestTurnId===successors[0]&&candidate.compactionItemId)
          turnId=successors[0]!;
      }
    }
    if(!turnId)return this.read(principal,projectId,operationId);
    const seen:RuntimeCompactionObservation=await this.runner.observeCompaction(binding,turnId);
    if(!saved.native_turn_id&&this.runner.compactionConnectionId()!==saved.native_connection_id)
      return this.read(principal,projectId,operationId);
    if(seen.latestTurnId===turnId&&seen.latestTurnId!==saved.baseline_turn_id){
      const completed=seen.compactionItemCompleted&&seen.latestTurnStatus==='completed'&&
        !!seen.latestTurnCompletedAtUtc&&seen.threadStatus==='idle';
      const failed=!!seen.latestTurnCompletedAtUtc&&seen.latestTurnStatus==='failed';
      await this.pool.query(`UPDATE session_compaction SET state=$3,native_turn_id=$4,
        compaction_item_id=$5,after_input_tokens=$6,error_code=$7,updated_at=now()
        WHERE project_id=$1 AND operation_id=$2 AND state IN ('unknown','accepted')
          AND (native_turn_id IS NULL OR native_turn_id=$4)
          AND EXISTS (SELECT 1 FROM session_recovery_gate g WHERE g.project_id=$1
            AND g.session_id=session_compaction.session_id AND g.phase='blocked'
            AND g.version=session_compaction.gate_version)`,
        [projectId,operationId,completed?'completed':failed?'failed':saved.state,
          seen.latestTurnId,seen.compactionItemId,seen.tokenUsage?.inputTokens??null,
          failed?'native_compaction_failed':null]);
    }
    return this.read(principal,projectId,operationId);
  }
}
