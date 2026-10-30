import type { PoolClient } from 'pg';
import type { ResidentQueue,ResidentQueueEntry,QueueClaim,QueueAttempt,QueueHoldCode,QueueStopDecision } from '../../contracts/src/queues.js';
import { DomainError } from '@evoloop/contracts/ports';

/** Use the caller's transaction; existing reserve and Loop must call assertQueueVacant under the same task/Session locks. */
export type QueueGrantCheck=(client:PoolClient,projectId:string,roleId:string,sessionId:string,taskId:string)=>Promise<boolean>;
export type QueueInputRead=(client:PoolClient,projectId:string,taskId:string)=>Promise<string>;
export type QueueLeadCheck=(client:PoolClient,projectId:string,actorId:string)=>Promise<boolean>;
export type QueueBindingCheck=(client:PoolClient,projectId:string,roleId:string,sessionId:string)=>Promise<boolean>;
const iso=(v:Date|string|null):string|null=>v===null?null:new Date(v).toISOString();
const entryOf=(r:any):ResidentQueueEntry=>({projectId:r.project_id,queueId:r.queue_id,id:r.entry_id,taskId:r.task_id,taskRevisionId:r.task_revision_id,sourceInputJson:r.source_input_json,sessionId:r.session_id,roleId:r.role_id,position:r.position,dependsOn:r.depends_on,consumerId:r.consumer_id,useRequired:r.use_required,releaseRule:r.release_rule,state:r.state,holdCode:r.hold_code,holdReason:r.hold_reason,claimId:r.claim_id,version:r.version});
const claimOf=(r:any):QueueClaim=>({projectId:r.project_id,queueId:r.queue_id,entryId:r.entry_id,claimId:r.claim_id,taskId:r.task_id,sessionId:r.session_id,roleId:r.role_id,releasedAt:iso(r.released_at),releaseKind:r.release_kind});
const attemptOf=(r:any):QueueAttempt=>({projectId:r.project_id,claimId:r.claim_id,sequence:r.sequence,runId:r.run_id,operationId:r.operation_id,taskRevisionId:r.task_revision_id,actualRunTaskRevisionId:r.actual_run_task_revision_id??null,reservedAt:iso(r.reserved_at)!});
const projectQueueLimit=200;
export class PgResidentQueue {
  constructor(private readonly client:PoolClient,private readonly projectId:string,private readonly grant:QueueGrantCheck,private readonly input:QueueInputRead,private readonly lead:QueueLeadCheck,private readonly binding:QueueBindingCheck){}
  queueControllerCurrent(actorId:string){return this.lead(this.client,this.projectId,actorId);}
  exactQueueGrant(roleId:string,sessionId:string,taskId:string){return this.grant(this.client,this.projectId,roleId,sessionId,taskId);}
  queueBindingCurrent(roleId:string,sessionId:string){return this.binding(this.client,this.projectId,roleId,sessionId);}
  async listResidentQueues():Promise<ResidentQueue[]>{
    const rows=await this.client.query('SELECT queue_id FROM resident_queue WHERE project_id=$1 ORDER BY created_at,queue_id LIMIT $2',
      [this.projectId,projectQueueLimit+1]);
    if(rows.rows.length>projectQueueLimit)throw new DomainError('QUEUE_LIMIT_EXCEEDED',
      'Project has more than 200 resident queues; listing and dispatch require reconciliation');
    const queues:ResidentQueue[]=[];
    for(const row of rows.rows)queues.push((await this.getResidentQueue(row.queue_id))!);
    return queues;
  }
  async getResidentQueue(id:string):Promise<ResidentQueue|null>{
    const q=await this.client.query('SELECT * FROM resident_queue WHERE project_id=$1 AND queue_id=$2',[this.projectId,id]);if(!q.rows[0])return null;
    const e=await this.client.query('SELECT * FROM resident_queue_entry WHERE project_id=$1 AND queue_id=$2 ORDER BY position,entry_id',[this.projectId,id]);
    return {projectId:this.projectId,id,version:q.rows[0].version,adoptedVersion:q.rows[0].adopted_version,maxRuns:q.rows[0].max_runs,reason:q.rows[0].reason,actorId:q.rows[0].actor_id,entries:e.rows.map(entryOf)};
  }
  list(id:string){return this.getResidentQueue(id);}
  async listHeld(id:string):Promise<ResidentQueueEntry[]>{const r=await this.client.query('SELECT * FROM resident_queue_entry WHERE project_id=$1 AND queue_id=$2 AND hold_code IS NOT NULL ORDER BY position',[this.projectId,id]);return r.rows.map(entryOf);}
  async listReconcile():Promise<{claim:QueueClaim;attempts:QueueAttempt[]}[]>{const r=await this.client.query('SELECT * FROM resident_queue_claim WHERE project_id=$1 AND released_at IS NULL ORDER BY claimed_at,claim_id',[this.projectId]);return Promise.all(r.rows.map(async x=>({claim:claimOf(x),attempts:await this.listResidentQueueAttempts(x.claim_id)})));}
  async getResidentQueueClaim(id:string):Promise<QueueClaim|null>{const r=await this.client.query('SELECT * FROM resident_queue_claim WHERE project_id=$1 AND claim_id=$2',[this.projectId,id]);return r.rows[0]?claimOf(r.rows[0]):null;}
  async getResidentQueueStopDecision(claimId:string):Promise<QueueStopDecision|null>{
    const r=await this.client.query('SELECT * FROM resident_queue_stop_decision WHERE project_id=$1 AND claim_id=$2',[this.projectId,claimId]);
    const x=r.rows[0];return x?{projectId:this.projectId,decisionId:x.decision_id,claimId:x.claim_id,sourceRunId:x.source_run_id,
      expectedEntryVersion:x.expected_entry_version,expectedRunVersion:x.expected_run_version,expectedGateVersion:x.expected_gate_version,
      actorId:x.actor_id,reason:x.reason,nextResponsibility:x.next_responsibility,createdAt:iso(x.created_at)!}:null;
  }
  async listResidentQueueAttempts(id:string):Promise<QueueAttempt[]>{const r=await this.client.query('SELECT a.*,r.task_revision_id AS actual_run_task_revision_id FROM resident_queue_attempt a LEFT JOIN runtime_run r ON r.project_id=a.project_id AND r.run_id=a.run_id WHERE a.project_id=$1 AND a.claim_id=$2 ORDER BY a.sequence',[this.projectId,id]);return r.rows.map(attemptOf);}
  async countResidentQueueAttempts(queueId:string):Promise<number>{const r=await this.client.query('SELECT count(*)::int AS used FROM resident_queue_attempt a JOIN resident_queue_claim c ON c.project_id=a.project_id AND c.claim_id=a.claim_id WHERE c.project_id=$1 AND c.queue_id=$2',[this.projectId,queueId]);return r.rows[0].used;}
  async createResidentQueue(q:ResidentQueue):Promise<void>{
    if(q.projectId!==this.projectId||q.version!==1||q.adoptedVersion!==null||!await this.lead(this.client,this.projectId,q.actorId))throw new Error('QUEUE_AUTHORIZATION');
    if(q.entries.some((e,i)=>e.projectId!==this.projectId||e.queueId!==q.id||e.position!==i||e.dependsOn.some(d=>!q.entries.slice(0,i).some(x=>x.id===d))))throw new Error('QUEUE_ORDER');
    const project=await this.client.query('SELECT project_id FROM project WHERE project_id=$1 FOR UPDATE',[this.projectId]);
    if(!project.rows[0])throw new DomainError('PROJECT_NOT_FOUND','Project was not found');
    const count=await this.client.query('SELECT count(*)::int AS total FROM resident_queue WHERE project_id=$1',[this.projectId]);
    if(count.rows[0].total>=projectQueueLimit)throw new DomainError('QUEUE_LIMIT_REACHED',
      'Project already has 200 resident queues; create no more until capacity is increased explicitly');
    await this.client.query('INSERT INTO resident_queue(project_id,queue_id,version,max_runs,reason,actor_id) VALUES($1,$2,1,$3,$4,$5)',[this.projectId,q.id,q.maxRuns,q.reason,q.actorId]);
    for(const e of q.entries)await this.client.query(`INSERT INTO resident_queue_entry(project_id,queue_id,entry_id,task_id,task_revision_id,source_input_json,session_id,role_id,position,depends_on,consumer_id,use_required,release_rule)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,[this.projectId,q.id,e.id,e.taskId,e.taskRevisionId,e.sourceInputJson,e.sessionId,e.roleId,e.position,e.dependsOn,e.consumerId,e.useRequired,e.releaseRule]);
    await this.client.query('INSERT INTO resident_queue_revision(project_id,queue_id,version,reason,actor_id,ordered_entry_ids) VALUES($1,$2,1,$3,$4,$5)',[this.projectId,q.id,q.reason,q.actorId,q.entries.map(x=>x.id)]);
  }
  async reorderResidentQueue(id:string,expected:number,ids:string[],actor:string,reason:string):Promise<number>{
    if(!reason.trim()||!await this.lead(this.client,this.projectId,actor))throw new Error('QUEUE_AUTHORIZATION');
    const q=await this.client.query('SELECT version FROM resident_queue WHERE project_id=$1 AND queue_id=$2 FOR UPDATE',[this.projectId,id]);if(q.rows[0]?.version!==expected)throw new Error('QUEUE_VERSION_CONFLICT');
    const r=await this.client.query('SELECT entry_id,position,state,depends_on FROM resident_queue_entry WHERE project_id=$1 AND queue_id=$2 ORDER BY position FOR UPDATE',[this.projectId,id]);
    const fixed=r.rows.filter(x=>['claimed','released'].includes(x.state)),movable=r.rows.filter(x=>['queued','held'].includes(x.state));
    if(ids.length!==movable.length||new Set(ids).size!==ids.length||ids.some(x=>!movable.some(y=>y.entry_id===x)))throw new Error('QUEUE_REORDER_CLAIMED');
    const ordered=r.rows.map(x=>x.entry_id);let n=0;for(let i=0;i<ordered.length;i++)if(!fixed.some(x=>x.entry_id===ordered[i]))ordered[i]=ids[n++]!;
    for(let i=0;i<ordered.length;i++){const e=r.rows.find(x=>x.entry_id===ordered[i]);if(e.depends_on.some((d:string)=>ordered.indexOf(d)<0||ordered.indexOf(d)>=i))throw new Error('QUEUE_DEPENDENCY');}
    await this.client.query("UPDATE resident_queue_entry SET position=position+1000000 WHERE project_id=$1 AND queue_id=$2 AND state IN ('queued','held')",[this.projectId,id]);
    for(let i=0;i<ordered.length;i++)if(!fixed.some(x=>x.entry_id===ordered[i]))await this.client.query('UPDATE resident_queue_entry SET position=$4,version=version+1,updated_at=now() WHERE project_id=$1 AND queue_id=$2 AND entry_id=$3',[this.projectId,id,ordered[i],i]);
    const version=expected+1;await this.client.query('UPDATE resident_queue SET version=$3,adopted_version=NULL,adopted_by=NULL,adopted_at=NULL,reason=$4,actor_id=$5,updated_at=now() WHERE project_id=$1 AND queue_id=$2',[this.projectId,id,version,reason,actor]);
    await this.client.query('INSERT INTO resident_queue_revision(project_id,queue_id,version,reason,actor_id,ordered_entry_ids) VALUES($1,$2,$3,$4,$5,$6)',[this.projectId,id,version,reason,actor,ordered]);return version;
  }
  async amendResidentQueueEntry(id:string,entryId:string,expected:number,taskRevisionId:string,sourceInputJson:string,actor:string,reason:string):Promise<number>{
    if(!reason.trim()||!await this.lead(this.client,this.projectId,actor))throw new Error('QUEUE_AUTHORIZATION');
    const q=await this.client.query('SELECT version FROM resident_queue WHERE project_id=$1 AND queue_id=$2 FOR UPDATE',[this.projectId,id]);if(q.rows[0]?.version!==expected)throw new Error('QUEUE_VERSION_CONFLICT');
    const er=await this.client.query('SELECT * FROM resident_queue_entry WHERE project_id=$1 AND queue_id=$2 AND entry_id=$3 FOR UPDATE',[this.projectId,id,entryId]);if(!er.rows[0]||er.rows[0].state==='released')throw new Error('ENTRY_UNAVAILABLE');const e=entryOf(er.rows[0]);
    const t=await this.client.query('SELECT current_revision_id,state FROM task WHERE project_id=$1 AND task_id=$2 FOR UPDATE',[this.projectId,e.taskId]);if(t.rows[0]?.current_revision_id!==taskRevisionId||t.rows[0]?.state!=='in_progress')throw new Error('TASK_REVISION_CONFLICT');
    if(await this.input(this.client,this.projectId,e.taskId)!==sourceInputJson)throw new Error('TASK_INPUT_CONFLICT');
    if(e.claimId){const attempts=await this.listResidentQueueAttempts(e.claimId);const last=attempts.at(-1);if(last){const run=await this.client.query('SELECT state FROM runtime_run WHERE project_id=$1 AND run_id=$2',[this.projectId,last.runId]);if(!run.rows[0]||!['completed','failed','interrupted'].includes(run.rows[0].state))throw new Error('RUN_UNSETTLED');}}
    const version=expected+1;await this.client.query('UPDATE resident_queue_entry SET task_revision_id=$4,source_input_json=$5,version=version+1,updated_at=now() WHERE project_id=$1 AND queue_id=$2 AND entry_id=$3',[this.projectId,id,entryId,taskRevisionId,sourceInputJson]);
    await this.client.query('INSERT INTO resident_queue_entry_amendment(project_id,queue_id,entry_id,queue_version,old_task_revision_id,new_task_revision_id,old_source_input_json,new_source_input_json,actor_id,reason) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',[this.projectId,id,entryId,version,e.taskRevisionId,taskRevisionId,e.sourceInputJson,sourceInputJson,actor,reason]);
    await this.client.query('UPDATE resident_queue SET version=$3,adopted_version=NULL,adopted_by=NULL,adopted_at=NULL,reason=$4,actor_id=$5,updated_at=now() WHERE project_id=$1 AND queue_id=$2',[this.projectId,id,version,reason,actor]);
    const ordered=await this.client.query('SELECT entry_id FROM resident_queue_entry WHERE project_id=$1 AND queue_id=$2 ORDER BY position',[this.projectId,id]);await this.client.query('INSERT INTO resident_queue_revision(project_id,queue_id,version,reason,actor_id,ordered_entry_ids) VALUES($1,$2,$3,$4,$5,$6)',[this.projectId,id,version,reason,actor,ordered.rows.map(x=>x.entry_id)]);return version;
  }
  async adoptResidentQueue(id:string,expected:number,actor:string):Promise<void>{if(!await this.lead(this.client,this.projectId,actor))throw new Error('QUEUE_AUTHORIZATION');const r=await this.client.query('UPDATE resident_queue SET adopted_version=version,adopted_by=$4,adopted_at=now(),updated_at=now() WHERE project_id=$1 AND queue_id=$2 AND version=$3 RETURNING version',[this.projectId,id,expected,actor]);if(!r.rowCount)throw new Error('QUEUE_VERSION_CONFLICT');}
  async extendResidentQueueBudget(queueId:string,expectedVersion:number,expectedMaxRuns:number,maxRuns:number,actorId:string,reason:string,evidenceRef:string,operationId:string):Promise<number>{
    if(!reason.trim()||!evidenceRef.trim()||maxRuns<=expectedMaxRuns||maxRuns>100||!await this.lead(this.client,this.projectId,actorId))
      throw new DomainError('QUEUE_AUTHORIZATION','Only the original controller may explicitly increase the queue budget');
    const r=await this.client.query('SELECT version,max_runs,actor_id FROM resident_queue WHERE project_id=$1 AND queue_id=$2 FOR UPDATE',[this.projectId,queueId]);
    if(!r.rows[0]||r.rows[0].version!==expectedVersion||r.rows[0].max_runs!==expectedMaxRuns)
      throw new DomainError('VERSION_CONFLICT','Queue budget changed',r.rows[0]?.version);
    if(r.rows[0].actor_id!==actorId)throw new DomainError('QUEUE_AUTHORIZATION','Original controller required');
    const version=expectedVersion+1;
    await this.client.query(`INSERT INTO resident_queue_budget_revision(project_id,queue_id,operation_id,previous_version,version,
      previous_max_runs,max_runs,actor_id,reason,evidence_ref) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [this.projectId,queueId,operationId,expectedVersion,version,expectedMaxRuns,maxRuns,actorId,reason,evidenceRef]);
    await this.client.query('UPDATE resident_queue SET version=$3,max_runs=$4,reason=$5,updated_at=now() WHERE project_id=$1 AND queue_id=$2 AND version=$6',
      [this.projectId,queueId,version,maxRuns,reason,expectedVersion]);
    const entries=await this.client.query('SELECT entry_id FROM resident_queue_entry WHERE project_id=$1 AND queue_id=$2 ORDER BY position',[this.projectId,queueId]);
    await this.client.query('INSERT INTO resident_queue_revision(project_id,queue_id,version,reason,actor_id,ordered_entry_ids) VALUES($1,$2,$3,$4,$5,$6)',
      [this.projectId,queueId,version,reason,actorId,entries.rows.map(x=>x.entry_id)]);
    return version;
  }
  async holdResidentQueueEntry(queueId:string,entryId:string,code:QueueHoldCode,reason:string):Promise<void>{await this.client.query("UPDATE resident_queue_entry SET state=CASE WHEN state='claimed' THEN 'claimed' ELSE 'held' END,hold_code=$4,hold_reason=$5,version=version+1,updated_at=now() WHERE project_id=$1 AND queue_id=$2 AND entry_id=$3 AND state IN ('queued','held','claimed')",[this.projectId,queueId,entryId,code,reason]);}
  async unholdResidentQueueEntry(queueId:string,entryId:string,expectedVersion:number,decisionId:string,actor:string,reason:string):Promise<void>{
    if(!reason.trim()||!await this.lead(this.client,this.projectId,actor))throw new Error('QUEUE_AUTHORIZATION');
    const budget=await this.client.query('SELECT max_runs FROM resident_queue WHERE project_id=$1 AND queue_id=$2 FOR UPDATE',[this.projectId,queueId]);
    const used=await this.countResidentQueueAttempts(queueId);
    const r=await this.client.query("UPDATE resident_queue_entry SET state=CASE WHEN state='held' THEN 'queued' ELSE state END,hold_code=NULL,hold_reason=NULL,version=version+1,updated_at=now() WHERE project_id=$1 AND queue_id=$2 AND entry_id=$3 AND version=$4 AND hold_code IS NOT NULL AND (hold_code<>'budget_exhausted' OR $5<$6) RETURNING entry_id",[this.projectId,queueId,entryId,expectedVersion,used,budget.rows[0]?.max_runs??0]);
    if(!r.rowCount)throw new Error('QUEUE_HOLD_CONFLICT');
    await this.client.query('INSERT INTO resident_queue_unhold_decision(project_id,decision_id,queue_id,entry_id,actor_id,reason) VALUES($1,$2,$3,$4,$5,$6)',[this.projectId,decisionId,queueId,entryId,actor,reason]);
  }
  async assertQueueVacant(taskId:string,sessionId:string,matchingClaimId?:string,matchingRunId?:string,matchingOperationId?:string):Promise<void>{
    const installed=await this.client.query("SELECT to_regclass('resident_queue_claim') IS NOT NULL AS present");
    if(!installed.rows[0]?.present)return;
    await this.client.query('SELECT task_id FROM task WHERE project_id=$1 AND task_id=$2 FOR UPDATE',[this.projectId,taskId]);
    await this.client.query('SELECT session_id FROM runtime_session WHERE project_id=$1 AND session_id=$2 FOR UPDATE',[this.projectId,sessionId]);
    const r=await this.client.query('SELECT * FROM resident_queue_claim WHERE project_id=$1 AND released_at IS NULL AND (task_id=$2 OR session_id=$3) LIMIT 1',[this.projectId,taskId,sessionId]);
    if(!r.rows[0])return;
    const c=r.rows[0];
    if(matchingClaimId===c.claim_id&&matchingRunId&&matchingOperationId&&c.task_id===taskId&&c.session_id===sessionId){
      const a=await this.client.query('SELECT 1 FROM resident_queue_attempt WHERE project_id=$1 AND claim_id=$2 AND run_id=$3 AND operation_id=$4',[this.projectId,matchingClaimId,matchingRunId,matchingOperationId]);
      if(a.rows[0])return;
    }
    throw new Error('QUEUE_OCCUPIED');
  }
  async assertQueueSessionVacant(sessionId:string):Promise<void>{
    const installed=await this.client.query("SELECT to_regclass('resident_queue_claim') IS NOT NULL AS present");
    if(!installed.rows[0]?.present)return;
    await this.client.query('SELECT session_id FROM runtime_session WHERE project_id=$1 AND session_id=$2 FOR UPDATE',[this.projectId,sessionId]);
    const r=await this.client.query('SELECT 1 FROM resident_queue_claim WHERE project_id=$1 AND session_id=$2 AND released_at IS NULL LIMIT 1',[this.projectId,sessionId]);
    if(r.rows[0])throw new Error('QUEUE_OCCUPIED');
  }
  private async assertCurrent(e:ResidentQueueEntry,continuation:boolean):Promise<string|null>{
    const r=await this.client.query(`SELECT t.current_revision_id,t.state AS task_state,t.owner,s.state AS session_state,s.native_thread_id,
      EXISTS(SELECT 1 FROM role_session_binding b WHERE b.project_id=t.project_id AND b.session_id=s.session_id AND b.role_id=$4) AS bound,
      (EXISTS(SELECT 1 FROM runtime_run x WHERE x.project_id=t.project_id AND (x.task_id=t.task_id OR x.session_id=s.session_id) AND x.state IN ('requested','dispatching','running','unknown'))
       OR EXISTS(SELECT 1 FROM session_message_processing m WHERE m.project_id=t.project_id AND m.session_id=s.session_id AND m.state IN ('dispatching','running','unknown'))) AS busy
      FROM task t JOIN runtime_session s ON s.project_id=t.project_id AND s.session_id=$3 WHERE t.project_id=$1 AND t.task_id=$2`,[this.projectId,e.taskId,e.sessionId,e.roleId]);
    const f=r.rows[0];if(!f||!['todo','in_progress'].includes(f.task_state)||f.owner!==e.roleId||f.session_state!=='ready'||!f.native_thread_id||!f.bound||f.busy)return null;
    if(!await this.binding(this.client,this.projectId,e.roleId,e.sessionId))return null;
    if(!await this.grant(this.client,this.projectId,e.roleId,e.sessionId,e.taskId))return null;
    if(await this.input(this.client,this.projectId,e.taskId)!==e.sourceInputJson)return null;
    if(!continuation){const prior=await this.client.query("SELECT 1 FROM resident_queue_entry WHERE project_id=$1 AND queue_id=$2 AND session_id=$3 AND position<$4 AND state<>'released' LIMIT 1",[this.projectId,e.queueId,e.sessionId,e.position]);if(prior.rows[0])return null;}
    return f.current_revision_id;
  }
  async claimResidentQueue(queueId:string,entryId:string,expectedVersion:number,claimId:string,attempt:Omit<QueueAttempt,'projectId'|'claimId'|'sequence'|'reservedAt'|'actualRunTaskRevisionId'>):Promise<QueueClaim|null>{
    const q=await this.client.query('SELECT version,adopted_version,actor_id FROM resident_queue WHERE project_id=$1 AND queue_id=$2 FOR UPDATE',[this.projectId,queueId]);if(!q.rows[0])throw new Error('QUEUE_NOT_FOUND');
    if(!await this.lead(this.client,this.projectId,q.rows[0].actor_id))throw new Error('QUEUE_AUTHORIZATION');
    if(q.rows[0].version!==expectedVersion)throw new Error('QUEUE_VERSION_CONFLICT');
    const er=await this.client.query('SELECT * FROM resident_queue_entry WHERE project_id=$1 AND queue_id=$2 AND entry_id=$3 FOR UPDATE',[this.projectId,queueId,entryId]);
    if(!er.rows[0])throw new Error('ENTRY_UNAVAILABLE');const e=entryOf(er.rows[0]);
    if(e.holdCode)throw new Error('QUEUE_HOLD_REQUIRES_DECISION');
    const prior=await this.getResidentQueueClaim(claimId);if(prior){
      const first=(await this.listResidentQueueAttempts(claimId))[0];
      if(prior.queueId!==queueId||prior.entryId!==entryId||!first||first.runId!==attempt.runId||first.operationId!==attempt.operationId||first.taskRevisionId!==attempt.taskRevisionId)throw new Error('OPERATION_CONFLICT');
      return prior;
    }
    if(q.rows[0].version!==q.rows[0].adopted_version)throw new Error('QUEUE_NOT_ADOPTED');
    if(er.rows[0].state!=='queued')return null;
    await this.client.query('SELECT session_recovery_slot_lock($1,$2)',[this.projectId,e.sessionId]);
    const gate=await this.client.query('SELECT phase FROM session_recovery_gate WHERE project_id=$1 AND session_id=$2 FOR UPDATE',[this.projectId,e.sessionId]);
    if(gate.rows[0]?.phase!=='open')throw new DomainError('SESSION_RECOVERY_REQUIRED','Session recovery gate blocks a new queue claim');
    const deps=await this.client.query(`SELECT d.entry_id,d.state,c.release_kind FROM resident_queue_entry d LEFT JOIN resident_queue_claim c ON c.project_id=d.project_id AND c.queue_id=d.queue_id AND c.entry_id=d.entry_id WHERE d.project_id=$1 AND d.queue_id=$2 AND d.entry_id=ANY($3::uuid[])`,[this.projectId,queueId,e.dependsOn]);
    if(deps.rows.length!==e.dependsOn.length||deps.rows.some(x=>x.state!=='released'||x.release_kind!=='accepted')){await this.holdResidentQueueEntry(queueId,entryId,'dependency','prerequisite not accepted');return null;}
    try{await this.assertQueueVacant(e.taskId,e.sessionId);}catch(error){
      if(error instanceof Error&&error.message==='QUEUE_OCCUPIED'){
        await this.holdResidentQueueEntry(queueId,entryId,'occupied','Task or Session has an active queue claim');return null;
      }
      throw error;
    }
    // An ordinary Turn is a temporary native-slot occupant, not a reason to place the business entry on manual hold.
    const messageBusy=await this.client.query(`SELECT 1 FROM session_message_processing WHERE project_id=$1 AND session_id=$2
      AND state IN ('dispatching','running','unknown') LIMIT 1`,[this.projectId,e.sessionId]);
    if(messageBusy.rows[0])throw new Error('SESSION_MESSAGE_BUSY');
    const revision=await this.assertCurrent(e,false);if(!revision){await this.holdResidentQueueEntry(queueId,entryId,'manual_review','current Task, input, Session, grant or Run changed');return null;}
    if(revision!==attempt.taskRevisionId)throw new Error('TASK_REVISION_CONFLICT');
    await this.client.query('INSERT INTO resident_queue_claim(project_id,queue_id,entry_id,claim_id,task_id,session_id,role_id) VALUES($1,$2,$3,$4,$5,$6,$7)',[this.projectId,queueId,entryId,claimId,e.taskId,e.sessionId,e.roleId]);
    await this.client.query('UPDATE resident_queue_entry SET state=\'claimed\',hold_code=NULL,hold_reason=NULL,claim_id=$4,version=version+1,updated_at=now() WHERE project_id=$1 AND queue_id=$2 AND entry_id=$3',[this.projectId,queueId,entryId,claimId]);
    await this.insertAttempt(claimId,1,attempt);return (await this.getResidentQueueClaim(claimId))!;
  }
  private async insertAttempt(claimId:string,sequence:number,a:Omit<QueueAttempt,'projectId'|'claimId'|'sequence'|'reservedAt'|'actualRunTaskRevisionId'>):Promise<QueueAttempt>{const r=await this.client.query('INSERT INTO resident_queue_attempt(project_id,claim_id,sequence,run_id,operation_id,task_revision_id) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',[this.projectId,claimId,sequence,a.runId,a.operationId,a.taskRevisionId]);return attemptOf(r.rows[0]);}
  async appendResidentQueueAttempt(claimId:string,a:Omit<QueueAttempt,'projectId'|'claimId'|'sequence'|'reservedAt'|'actualRunTaskRevisionId'>,maxRuns:number):Promise<QueueAttempt|null>{
    const key=await this.client.query('SELECT queue_id FROM resident_queue_claim WHERE project_id=$1 AND claim_id=$2',[this.projectId,claimId]);if(!key.rows[0])return null;
    await this.client.query('SELECT queue_id FROM resident_queue WHERE project_id=$1 AND queue_id=$2 FOR UPDATE',[this.projectId,key.rows[0].queue_id]);
    const c=await this.client.query('SELECT * FROM resident_queue_claim WHERE project_id=$1 AND claim_id=$2 FOR UPDATE',[this.projectId,claimId]);if(!c.rows[0]||c.rows[0].released_at)return null;
    const er=await this.client.query('SELECT * FROM resident_queue_entry WHERE project_id=$1 AND queue_id=$2 AND entry_id=$3 FOR UPDATE',[this.projectId,c.rows[0].queue_id,c.rows[0].entry_id]);const e=entryOf(er.rows[0]);
    await this.client.query('SELECT session_recovery_slot_lock($1,$2)',[this.projectId,e.sessionId]);
    const gate=await this.client.query('SELECT phase,retry_run_id,claim_id FROM session_recovery_gate WHERE project_id=$1 AND session_id=$2 FOR UPDATE',[this.projectId,e.sessionId]);
    if(gate.rows[0]?.phase!=='open'&&
      !(['retrying','reworking'].includes(gate.rows[0]?.phase)&&gate.rows[0]?.retry_run_id===a.runId&&gate.rows[0]?.claim_id===claimId))
      throw new DomainError('SESSION_RECOVERY_REQUIRED','Only the explicitly permitted failed Run successor may reserve');
    if(e.holdCode)throw new Error('QUEUE_HOLD_REQUIRES_DECISION');
    const replay=await this.client.query('SELECT * FROM resident_queue_attempt WHERE project_id=$1 AND operation_id=$2',[this.projectId,a.operationId]);if(replay.rows[0]){const x=attemptOf(replay.rows[0]);if(x.claimId!==claimId||x.runId!==a.runId||x.taskRevisionId!==a.taskRevisionId)throw new Error('OPERATION_CONFLICT');return x;}
    const attempts=await this.listResidentQueueAttempts(claimId);if(await this.countResidentQueueAttempts(c.rows[0].queue_id)>=maxRuns)return null;
    const last=attempts.at(-1);if(!last)return null;const run=await this.client.query('SELECT state FROM runtime_run WHERE project_id=$1 AND run_id=$2',[this.projectId,last.runId]);if(!run.rows[0]||!['completed','failed','interrupted'].includes(run.rows[0].state))return null;
    const messageBusy=await this.client.query(`SELECT 1 FROM session_message_processing WHERE project_id=$1 AND session_id=$2
      AND state IN ('dispatching','running','unknown') LIMIT 1`,[this.projectId,e.sessionId]);
    if(messageBusy.rows[0])throw new Error('SESSION_MESSAGE_BUSY');
    const revision=await this.assertCurrent(e,true);if(!revision||revision!==a.taskRevisionId)return null;
    return this.insertAttempt(claimId,attempts.length+1,a);
  }
  async releaseResidentQueueAccepted(claimId:string):Promise<boolean>{
    const cr=await this.client.query('SELECT * FROM resident_queue_claim WHERE project_id=$1 AND claim_id=$2 FOR UPDATE',[this.projectId,claimId]);if(!cr.rows[0]||cr.rows[0].released_at)return false;const c=cr.rows[0];
    const er=await this.client.query('SELECT * FROM resident_queue_entry WHERE project_id=$1 AND queue_id=$2 AND entry_id=$3 FOR UPDATE',[this.projectId,c.queue_id,c.entry_id]);const e=entryOf(er.rows[0]);if(e.holdCode)return false;
    const last=(await this.listResidentQueueAttempts(claimId)).at(-1);if(!last)return false;
    const run=await this.client.query('SELECT state,version FROM runtime_run WHERE project_id=$1 AND run_id=$2',[this.projectId,last.runId]);if(!run.rows[0]||!['completed','failed','interrupted'].includes(run.rows[0].state))return false;
    const r=await this.client.query(`SELECT t.current_revision_id,t.state AS task_state,d.delivery_id,d.source_run_version,o.observation_id,o.result,cl.closure_id,
      p.consumer AS task_consumer,p.acceptance_mode
      FROM task t JOIN task_closure cl ON cl.project_id=t.project_id AND cl.task_id=t.task_id AND cl.task_revision_id=t.current_revision_id AND cl.acceptance_result='met'
      JOIN delivery d ON d.project_id=t.project_id AND d.delivery_id=cl.delivery_id AND d.task_id=t.task_id AND d.run_id=$4 AND d.technical_result='passed'
      LEFT JOIN LATERAL (SELECT p.consumer,p.acceptance_mode FROM task_proposal p JOIN task_revision pr ON pr.project_id=p.project_id AND pr.task_id=p.task_id AND pr.revision_id=p.task_revision_id WHERE p.project_id=t.project_id AND p.task_id=t.task_id ORDER BY pr.version DESC LIMIT 1) p ON true
      LEFT JOIN LATERAL (SELECT observation_id,result FROM consumer_observation o WHERE o.project_id=d.project_id AND o.delivery_id=d.delivery_id AND o.observer=$3 ORDER BY o.sequence DESC LIMIT 1) o ON true
      WHERE t.project_id=$1 AND t.task_id=$2 AND t.state='done' AND d.delivery_id=(SELECT delivery_id FROM delivery x WHERE x.project_id=t.project_id AND x.task_id=t.task_id ORDER BY x.created_at DESC,x.delivery_id DESC LIMIT 1)`,[this.projectId,e.taskId,e.consumerId,last.runId]);
    const x=r.rows[0];if(!x||(x.acceptance_mode&&(!e.useRequired||x.task_consumer&&x.task_consumer!==e.consumerId||
      run.rows[0].state!=='completed'||x.source_run_version!==run.rows[0].version))||
      (e.useRequired&&(!x.observation_id||x.result!=='used')))return false;
    if(await this.input(this.client,this.projectId,e.taskId)!==e.sourceInputJson)return false;
    await this.client.query("UPDATE resident_queue_claim SET release_kind='accepted',released_at=now(),delivery_id=$3,observation_id=$4,closure_id=$5 WHERE project_id=$1 AND claim_id=$2",[this.projectId,claimId,x.delivery_id,x.observation_id??null,x.closure_id]);
    await this.client.query("UPDATE resident_queue_entry SET state='released',version=version+1,updated_at=now() WHERE project_id=$1 AND queue_id=$2 AND entry_id=$3",[this.projectId,e.queueId,e.id]);return true;
  }
  async releaseResidentQueueBounded(claimId:string,decisionId:string,actor:string,reason:string,nextResponsibility:string):Promise<boolean>{
    if(!reason.trim()||!nextResponsibility.trim()||!await this.lead(this.client,this.projectId,actor))throw new Error('QUEUE_AUTHORIZATION');
    const cr=await this.client.query('SELECT * FROM resident_queue_claim WHERE project_id=$1 AND claim_id=$2 FOR UPDATE',[this.projectId,claimId]);if(!cr.rows[0]||cr.rows[0].released_at)return false;const c=cr.rows[0];
    const er=await this.client.query('SELECT * FROM resident_queue_entry WHERE project_id=$1 AND queue_id=$2 AND entry_id=$3 FOR UPDATE',[this.projectId,c.queue_id,c.entry_id]);const e=entryOf(er.rows[0]);if(e.holdCode||e.releaseRule!=='bounded_decision')return false;
    const last=(await this.listResidentQueueAttempts(claimId)).at(-1);if(!last)return false;const run=await this.client.query('SELECT state FROM runtime_run WHERE project_id=$1 AND run_id=$2',[this.projectId,last.runId]);if(!run.rows[0]||!['completed','failed','interrupted'].includes(run.rows[0].state))return false;
    const t=await this.client.query('SELECT state FROM task WHERE project_id=$1 AND task_id=$2 FOR UPDATE',[this.projectId,e.taskId]);if(t.rows[0]?.state!=='in_progress'||await this.input(this.client,this.projectId,e.taskId)!==e.sourceInputJson)return false;
    const busy=await this.client.query("SELECT 1 FROM runtime_run WHERE project_id=$1 AND (task_id=$2 OR session_id=$3) AND state IN ('requested','dispatching','running','unknown') LIMIT 1",[this.projectId,e.taskId,e.sessionId]);if(busy.rows[0])return false;
    await this.client.query('INSERT INTO resident_queue_release_decision(project_id,decision_id,claim_id,actor_id,reason,next_responsibility) VALUES($1,$2,$3,$4,$5,$6)',[this.projectId,decisionId,claimId,actor,reason,nextResponsibility]);
    await this.client.query("UPDATE resident_queue_claim SET release_kind='bounded',released_at=now(),bounded_decision_id=$3 WHERE project_id=$1 AND claim_id=$2",[this.projectId,claimId,decisionId]);
    await this.client.query("UPDATE resident_queue_entry SET state='released',version=version+1,updated_at=now() WHERE project_id=$1 AND queue_id=$2 AND entry_id=$3",[this.projectId,e.queueId,e.id]);return true;
  }
  async stopResidentQueueClaim(claimId:string,decisionId:string,actor:string,expectedEntryVersion:number,expectedRunVersion:number,expectedGateVersion:number,sourceRunId:string,reason:string,nextResponsibility:string):Promise<boolean>{
    if(!reason.trim()||!nextResponsibility.trim()||!await this.lead(this.client,this.projectId,actor))throw new Error('QUEUE_AUTHORIZATION');
    const key=await this.client.query('SELECT queue_id,session_id FROM resident_queue_claim WHERE project_id=$1 AND claim_id=$2',[this.projectId,claimId]);
    if(!key.rows[0])return false;
    const controller=await this.client.query('SELECT actor_id FROM resident_queue WHERE project_id=$1 AND queue_id=$2 FOR UPDATE',[this.projectId,key.rows[0].queue_id]);
    if(controller.rows[0]?.actor_id!==actor)return false;
    await this.client.query('SELECT session_recovery_slot_lock($1,$2)',[this.projectId,key.rows[0].session_id]);
    const gate=await this.client.query('SELECT phase,version,claim_id,cause_kind,cause_id FROM session_recovery_gate WHERE project_id=$1 AND session_id=$2 FOR UPDATE',[this.projectId,key.rows[0].session_id]);
    const g=gate.rows[0];if(!g||g.phase!=='blocked'||g.version!==expectedGateVersion||g.claim_id!==claimId||g.cause_kind!=='run'||g.cause_id!==sourceRunId)return false;
    const cr=await this.client.query('SELECT * FROM resident_queue_claim WHERE project_id=$1 AND claim_id=$2 FOR UPDATE',[this.projectId,claimId]);
    const c=cr.rows[0];if(!c||c.released_at||c.session_id!==key.rows[0].session_id)return false;
    const er=await this.client.query('SELECT * FROM resident_queue_entry WHERE project_id=$1 AND queue_id=$2 AND entry_id=$3 FOR UPDATE',[this.projectId,c.queue_id,c.entry_id]);
    const e=er.rows[0];if(!e||e.state!=='claimed'||e.claim_id!==claimId||e.version!==expectedEntryVersion)return false;
    const last=(await this.listResidentQueueAttempts(claimId)).at(-1);if(last?.runId!==sourceRunId)return false;
    const run=await this.client.query('SELECT state,version,task_id,session_id FROM runtime_run WHERE project_id=$1 AND run_id=$2 FOR UPDATE',[this.projectId,sourceRunId]);
    const r=run.rows[0];if(!r||!['failed','interrupted'].includes(r.state)||r.version!==expectedRunVersion||r.task_id!==c.task_id||r.session_id!==c.session_id)return false;
    const task=await this.client.query('SELECT state FROM task WHERE project_id=$1 AND task_id=$2 FOR UPDATE',[this.projectId,c.task_id]);
    if(task.rows[0]?.state!=='cancelled')return false;
    const active=await this.client.query(`SELECT 1 FROM runtime_run WHERE project_id=$1 AND (task_id=$2 OR session_id=$3)
      AND state IN ('requested','dispatching','running','unknown') LIMIT 1`,[this.projectId,c.task_id,c.session_id]);
    if(active.rows[0])return false;
    const messages=await this.client.query(`SELECT 1 FROM session_message_processing WHERE project_id=$1 AND session_id=$2
      AND state IN ('dispatching','running','unknown') LIMIT 1`,[this.projectId,c.session_id]);
    if(messages.rows[0])return false;
    await this.client.query(`INSERT INTO resident_queue_stop_decision(project_id,decision_id,claim_id,source_run_id,expected_entry_version,
      expected_run_version,expected_gate_version,actor_id,reason,next_responsibility) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [this.projectId,decisionId,claimId,sourceRunId,expectedEntryVersion,expectedRunVersion,expectedGateVersion,actor,reason,nextResponsibility]);
    await this.client.query("UPDATE resident_queue_claim SET release_kind='stopped',released_at=now(),stop_decision_id=$3 WHERE project_id=$1 AND claim_id=$2",[this.projectId,claimId,decisionId]);
    await this.client.query("UPDATE resident_queue_entry SET state='released',version=version+1,updated_at=now() WHERE project_id=$1 AND queue_id=$2 AND entry_id=$3",[this.projectId,c.queue_id,c.entry_id]);
    return true;
  }
}
