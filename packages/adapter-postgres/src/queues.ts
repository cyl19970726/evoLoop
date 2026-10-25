import type { PoolClient } from "pg";
import type { QueueClaim, ResidentQueue, ResidentQueueEntry, QueueHoldCode } from "../../contracts/src/queues.js";

// Every mutating method uses the caller's transaction. Reserve and Loop must lock
// the same task and session rows and call assertQueueVacant before inserting a Run.
export type ExactGrantCheck = (client: PoolClient, projectId: string, roleId: string, sessionId: string, taskId: string) => Promise<boolean>;
export type LeadCheck = (client: PoolClient, projectId: string, actorId: string) => Promise<boolean>;
const rowEntry = (r: any): ResidentQueueEntry => ({ projectId:r.project_id,queueId:r.queue_id,id:r.entry_id,taskId:r.task_id,taskRevisionId:r.task_revision_id,sessionId:r.session_id,roleId:r.role_id,position:r.position,dependsOn:r.depends_on,consumerId:r.consumer_id,useRequired:r.use_required,releaseRule:r.release_rule,state:r.state,holdCode:r.hold_code,holdReason:r.hold_reason,claimId:r.claim_id,version:r.version });
const rowClaim = (r: any): QueueClaim => ({ projectId:r.project_id,queueId:r.queue_id,entryId:r.entry_id,claimId:r.claim_id,taskId:r.task_id,taskRevisionId:r.task_revision_id,sessionId:r.session_id,roleId:r.role_id,runId:r.run_id,operationId:r.operation_id,state:r.state,nativeTurnId:r.native_turn_id,reason:r.reason });
export class PgResidentQueue {
  constructor(private readonly client: PoolClient, private readonly projectId: string, private readonly exactGrant: ExactGrantCheck, private readonly lead: LeadCheck) {}
  async list(queueId: string): Promise<ResidentQueue | null> {
    const q=await this.client.query("SELECT * FROM resident_queue WHERE project_id=$1 AND queue_id=$2",[this.projectId,queueId]);
    if (!q.rows[0]) return null;
    const e=await this.client.query("SELECT * FROM resident_queue_entry WHERE project_id=$1 AND queue_id=$2 ORDER BY position,entry_id",[this.projectId,queueId]);
    return {projectId:this.projectId,id:queueId,version:q.rows[0].version,adoptedVersion:q.rows[0].adopted_version,reason:q.rows[0].reason,actorId:q.rows[0].actor_id,entries:e.rows.map(rowEntry)};
  }
  async listHeld(queueId: string): Promise<ResidentQueueEntry[]> {
    const r=await this.client.query("SELECT * FROM resident_queue_entry WHERE project_id=$1 AND queue_id=$2 AND state='held' ORDER BY position,entry_id",[this.projectId,queueId]);return r.rows.map(rowEntry);
  }
  async listReconcile(): Promise<QueueClaim[]> {
    const r=await this.client.query("SELECT * FROM resident_queue_claim WHERE project_id=$1 AND released_at IS NULL ORDER BY claimed_at,claim_id",[this.projectId]);return r.rows.map(rowClaim);
  }
  async create(queueId:string, actorId:string, reason:string, entries:Omit<ResidentQueueEntry,"projectId"|"queueId"|"state"|"holdCode"|"holdReason"|"claimId"|"version">[]):Promise<void> {
    if (!reason.trim() || !await this.lead(this.client,this.projectId,actorId)) throw new Error("Lead authorization and reason required");
    if (entries.some((e,i)=>e.position!==i || e.dependsOn.some(d=>d===e.id || !entries.slice(0,i).some(x=>x.id===d)))) throw new Error("queue order or dependency invalid");
    await this.client.query("INSERT INTO resident_queue(project_id,queue_id,version,reason,actor_id) VALUES($1,$2,1,$3,$4)",[this.projectId,queueId,reason,actorId]);
    for (const e of entries) await this.client.query(`INSERT INTO resident_queue_entry(project_id,queue_id,entry_id,task_id,task_revision_id,session_id,role_id,position,depends_on,consumer_id,use_required,release_rule)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,[this.projectId,queueId,e.id,e.taskId,e.taskRevisionId,e.sessionId,e.roleId,e.position,e.dependsOn,e.consumerId,e.useRequired,e.releaseRule]);
    await this.client.query("INSERT INTO resident_queue_revision(project_id,queue_id,version,reason,actor_id,ordered_entry_ids) VALUES($1,$2,1,$3,$4,$5)",[this.projectId,queueId,reason,actorId,entries.map(e=>e.id)]);
  }
  async reorder(queueId:string, expectedVersion:number, ids:string[], actorId:string, reason:string):Promise<number> {
    if (!reason.trim() || !await this.lead(this.client,this.projectId,actorId)) throw new Error("Lead authorization and reason required");
    const q=await this.client.query("SELECT version FROM resident_queue WHERE project_id=$1 AND queue_id=$2 FOR UPDATE",[this.projectId,queueId]);
    if (!q.rows[0] || q.rows[0].version!==expectedVersion) throw new Error("QUEUE_VERSION_CONFLICT");
    const all=await this.client.query("SELECT entry_id,position,state,depends_on FROM resident_queue_entry WHERE project_id=$1 AND queue_id=$2 ORDER BY position FOR UPDATE",[this.projectId,queueId]);
    const fixed=all.rows.filter(r=>r.state==='claimed'||r.state==='released'); const movable=all.rows.filter(r=>r.state==='queued'||r.state==='held');
    if (ids.length!==movable.length || new Set(ids).size!==ids.length || ids.some(id=>!movable.some(r=>r.entry_id===id))) throw new Error("reorder may contain only unclaimed entries exactly once");
    const ordered=all.rows.map(r=>r.entry_id); let n=0; for(let i=0;i<ordered.length;i++) if (!fixed.some(r=>r.entry_id===ordered[i])) ordered[i]=ids[n++]!;
    for(let i=0;i<ordered.length;i++){const e=all.rows.find(r=>r.entry_id===ordered[i])!; if(e.depends_on.some((d:string)=>ordered.indexOf(d)<0||ordered.indexOf(d)>=i)) throw new Error("dependency order invalid");}
    // Temporarily displace positions to retain the unique(project,queue,position) invariant.
    await this.client.query("UPDATE resident_queue_entry SET position=position+1000000 WHERE project_id=$1 AND queue_id=$2 AND state IN ('queued','held')",[this.projectId,queueId]);
    for(let i=0;i<ordered.length;i++) if(!fixed.some(r=>r.entry_id===ordered[i])) await this.client.query("UPDATE resident_queue_entry SET position=$4,version=version+1,updated_at=now() WHERE project_id=$1 AND queue_id=$2 AND entry_id=$3",[this.projectId,queueId,ordered[i],i]);
    const version=expectedVersion+1;
    await this.client.query("UPDATE resident_queue SET version=$3,adopted_version=NULL,adopted_by=NULL,adopted_at=NULL,reason=$4,actor_id=$5,updated_at=now() WHERE project_id=$1 AND queue_id=$2",[this.projectId,queueId,version,reason,actorId]);
    await this.client.query("INSERT INTO resident_queue_revision(project_id,queue_id,version,reason,actor_id,ordered_entry_ids) VALUES($1,$2,$3,$4,$5,$6)",[this.projectId,queueId,version,reason,actorId,ordered]);
    return version;
  }
  async adopt(queueId:string, expectedVersion:number, actorId:string):Promise<void> {
    if (!await this.lead(this.client,this.projectId,actorId)) throw new Error("Lead authorization required");
    const r=await this.client.query("UPDATE resident_queue SET adopted_version=version,adopted_by=$4,adopted_at=now(),updated_at=now() WHERE project_id=$1 AND queue_id=$2 AND version=$3 RETURNING version",[this.projectId,queueId,expectedVersion,actorId]);
    if(!r.rowCount) throw new Error("QUEUE_VERSION_CONFLICT");
  }
  async assertQueueVacant(taskId:string, sessionId:string):Promise<void> {
    await this.client.query("SELECT task_id FROM task WHERE project_id=$1 AND task_id=$2 FOR UPDATE",[this.projectId,taskId]);
    await this.client.query("SELECT session_id FROM runtime_session WHERE project_id=$1 AND session_id=$2 FOR UPDATE",[this.projectId,sessionId]);
    const r=await this.client.query("SELECT claim_id FROM resident_queue_claim WHERE project_id=$1 AND released_at IS NULL AND (task_id=$2 OR session_id=$3) LIMIT 1",[this.projectId,taskId,sessionId]);
    if(r.rows[0]) throw new Error("QUEUE_OCCUPIED");
  }
  async claim(queueId:string, entryId:string, expectedQueueVersion:number, ids:{claimId:string;runId:string;operationId:string}):Promise<QueueClaim|null> {
    const replay=await this.client.query("SELECT * FROM resident_queue_claim WHERE project_id=$1 AND operation_id=$2",[this.projectId,ids.operationId]);
    if(replay.rows[0]) {const c=rowClaim(replay.rows[0]); if(c.entryId!==entryId||c.claimId!==ids.claimId||c.runId!==ids.runId) throw new Error("OPERATION_CONFLICT"); return c;}
    const q=await this.client.query("SELECT version,adopted_version FROM resident_queue WHERE project_id=$1 AND queue_id=$2 FOR UPDATE",[this.projectId,queueId]);
    const afterLockReplay=await this.client.query("SELECT * FROM resident_queue_claim WHERE project_id=$1 AND operation_id=$2",[this.projectId,ids.operationId]);
    if(afterLockReplay.rows[0]) {const c=rowClaim(afterLockReplay.rows[0]);if(c.entryId!==entryId||c.claimId!==ids.claimId||c.runId!==ids.runId) throw new Error('OPERATION_CONFLICT');return c;}
    if(!q.rows[0]||q.rows[0].version!==expectedQueueVersion||q.rows[0].adopted_version!==expectedQueueVersion) throw new Error("QUEUE_NOT_ADOPTED");
    const er=await this.client.query("SELECT * FROM resident_queue_entry WHERE project_id=$1 AND queue_id=$2 AND entry_id=$3 FOR UPDATE",[this.projectId,queueId,entryId]);
    if(!er.rows[0]||!['queued','held'].includes(er.rows[0].state)) throw new Error("ENTRY_UNAVAILABLE");
    const e=rowEntry(er.rows[0]);
    await this.assertQueueVacant(e.taskId,e.sessionId);
    const earlier=await this.client.query("SELECT 1 FROM resident_queue_entry WHERE project_id=$1 AND queue_id=$2 AND session_id=$3 AND position<$4 AND state<>'released' LIMIT 1",[this.projectId,queueId,e.sessionId,e.position]);
    if(earlier.rows[0]) {await this.hold(e,'dependency','earlier entry for this Session is not released');return null;}
    const deps=await this.client.query(`SELECT d.entry_id,d.state,c.release_kind FROM resident_queue_entry d
      LEFT JOIN resident_queue_claim c ON c.project_id=d.project_id AND c.queue_id=d.queue_id AND c.entry_id=d.entry_id
      WHERE d.project_id=$1 AND d.queue_id=$2 AND d.entry_id=ANY($3::uuid[])`,[this.projectId,queueId,e.dependsOn]);
    const dependencyReleased=deps.rows.length===e.dependsOn.length&&deps.rows.every(r=>r.state==='released'&&r.release_kind==='accepted');
    const facts=await this.client.query(`SELECT t.current_revision_id,t.state AS task_state,s.state AS session_state,s.native_thread_id,
      EXISTS(SELECT 1 FROM role_session_binding b WHERE b.project_id=t.project_id AND b.session_id=s.session_id AND b.role_id=$4) AS binding_current,
      EXISTS(SELECT 1 FROM runtime_run r WHERE r.project_id=t.project_id AND (r.task_id=t.task_id OR r.session_id=s.session_id) AND r.state IN ('requested','dispatching','running','unknown')) AS conflicting_run
      FROM task t JOIN runtime_session s ON s.project_id=t.project_id AND s.session_id=$3 WHERE t.project_id=$1 AND t.task_id=$2`,[this.projectId,e.taskId,e.sessionId,e.roleId]);
    const f=facts.rows[0]; const grant=await this.exactGrant(this.client,this.projectId,e.roleId,e.sessionId,e.taskId);
    const decision: {ready:boolean;code:QueueHoldCode|null;reason:string|null} = !dependencyReleased ? {ready:false,code:'dependency',reason:'prerequisite entry is not released'}
      : !f || !['todo','in_progress'].includes(f.task_state) ? {ready:false,code:'task_unavailable',reason:'task is not executable'}
      : f.current_revision_id!==e.taskRevisionId ? {ready:false,code:'task_changed',reason:'fixed Task revision changed'}
      : f.session_state!=='ready'||!f.native_thread_id ? {ready:false,code:'session_unready',reason:'owned Session is not ready'}
      : !f.binding_current ? {ready:false,code:'binding_changed',reason:'Role binding is not current'}
      : !grant ? {ready:false,code:'grant_revoked',reason:'current exact grant does not authorize start'}
      : f.conflicting_run ? {ready:false,code:'run_in_flight',reason:'Task or Session has active or unknown Run'}
      : {ready:true,code:null,reason:null};
    if(!decision.ready){await this.hold(e,decision.code!,decision.reason!);return null;}
    await this.client.query(`INSERT INTO resident_queue_claim(project_id,queue_id,entry_id,claim_id,task_id,task_revision_id,session_id,role_id,run_id,operation_id,state)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'intent')`,[this.projectId,queueId,e.id,ids.claimId,e.taskId,e.taskRevisionId,e.sessionId,e.roleId,ids.runId,ids.operationId]);
    await this.client.query("UPDATE resident_queue_entry SET state='claimed',hold_code=NULL,hold_reason=NULL,claim_id=$4,version=version+1,updated_at=now() WHERE project_id=$1 AND queue_id=$2 AND entry_id=$3",[this.projectId,queueId,e.id,ids.claimId]);
    return {projectId:this.projectId,queueId,entryId:e.id,claimId:ids.claimId,taskId:e.taskId,taskRevisionId:e.taskRevisionId,sessionId:e.sessionId,roleId:e.roleId,runId:ids.runId,operationId:ids.operationId,state:'intent',nativeTurnId:null,reason:null};
  }
  private async hold(e:ResidentQueueEntry,code:QueueHoldCode,reason:string):Promise<void>{await this.client.query("UPDATE resident_queue_entry SET state='held',hold_code=$4,hold_reason=$5,version=version+1,updated_at=now() WHERE project_id=$1 AND queue_id=$2 AND entry_id=$3 AND state IN ('queued','held')",[this.projectId,e.queueId,e.id,code,reason]);}
  async markClaim(claimId:string, expected:QueueClaim['state'], next:'dispatching'|'running'|'terminal'|'unknown', reason:string|null=null,nativeTurnId:string|null=null):Promise<boolean>{
    if (!({intent:['dispatching','unknown'],dispatching:['running','terminal','unknown'],running:['terminal','unknown'],unknown:['running','terminal'],terminal:[],released:[]} as Record<QueueClaim['state'],string[]>)[expected].includes(next)) throw new Error('invalid claim transition');
    if (expected==='unknown' && !nativeTurnId) throw new Error('unknown requires original native Turn readback');
    const r=await this.client.query("UPDATE resident_queue_claim SET state=$4,reason=$5,native_turn_id=COALESCE(native_turn_id,$6),updated_at=now() WHERE project_id=$1 AND claim_id=$2 AND state=$3 AND released_at IS NULL RETURNING claim_id",[this.projectId,claimId,expected,next,reason,nativeTurnId]);return !!r.rowCount;
  }
  async releaseAccepted(claimId:string):Promise<boolean>{
    const cr=await this.client.query("SELECT * FROM resident_queue_claim WHERE project_id=$1 AND claim_id=$2 FOR UPDATE",[this.projectId,claimId]); if(!cr.rows[0]||cr.rows[0].state!=='terminal') return false; const c=cr.rows[0];
    const er=await this.client.query("SELECT * FROM resident_queue_entry WHERE project_id=$1 AND queue_id=$2 AND entry_id=$3 FOR UPDATE",[this.projectId,c.queue_id,c.entry_id]); const e=rowEntry(er.rows[0]);
    const r=await this.client.query(`SELECT t.current_revision_id,t.state AS task_state,d.delivery_id,o.observation_id,cl.closure_id
      FROM task t JOIN task_closure cl ON cl.project_id=t.project_id AND cl.task_id=t.task_id AND cl.task_revision_id=t.current_revision_id AND cl.acceptance_result='met'
      JOIN delivery d ON d.project_id=t.project_id AND d.delivery_id=cl.delivery_id AND d.task_revision_id=t.current_revision_id AND d.technical_result='passed'
      LEFT JOIN LATERAL (SELECT observation_id,result FROM consumer_observation o WHERE o.project_id=d.project_id AND o.delivery_id=d.delivery_id AND o.observer=$3 ORDER BY o.sequence DESC LIMIT 1) o ON true
      WHERE t.project_id=$1 AND t.task_id=$2`,[this.projectId,e.taskId,e.consumerId]);
    const x=r.rows[0]; if(!x||x.current_revision_id!==e.taskRevisionId||x.task_state!=='done'||(e.useRequired&&(!x.observation_id||x.result!=='used'))) return false;
    await this.client.query("UPDATE resident_queue_claim SET state='released',release_kind='accepted',released_at=now(),updated_at=now(),delivery_id=$3,observation_id=$4,closure_id=$5 WHERE project_id=$1 AND claim_id=$2",[this.projectId,claimId,x.delivery_id,x.observation_id??null,x.closure_id]);
    await this.client.query("UPDATE resident_queue_entry SET state='released',claim_id=NULL,version=version+1,updated_at=now() WHERE project_id=$1 AND queue_id=$2 AND entry_id=$3",[this.projectId,e.queueId,e.id]);return true;
  }
  async releaseBounded(claimId:string, decision:{id:string;actorId:string;reason:string;nextResponsibility:string}):Promise<boolean>{
    if(!decision.reason.trim()||!decision.nextResponsibility.trim()||!await this.lead(this.client,this.projectId,decision.actorId)) throw new Error('bounded Lead decision required');
    const cr=await this.client.query("SELECT * FROM resident_queue_claim WHERE project_id=$1 AND claim_id=$2 FOR UPDATE",[this.projectId,claimId]);if(!cr.rows[0]||cr.rows[0].state==='released') return false;
    const c=cr.rows[0];const er=await this.client.query("SELECT * FROM resident_queue_entry WHERE project_id=$1 AND queue_id=$2 AND entry_id=$3 FOR UPDATE",[this.projectId,c.queue_id,c.entry_id]);const e=rowEntry(er.rows[0]);
    if(e.releaseRule!=='bounded_decision'||c.state!=='terminal') return false;
    const t=await this.client.query("SELECT current_revision_id,state FROM task WHERE project_id=$1 AND task_id=$2 FOR UPDATE",[this.projectId,e.taskId]);if(t.rows[0]?.current_revision_id!==e.taskRevisionId||t.rows[0]?.state!=='in_progress')return false;
    const running=await this.client.query("SELECT 1 FROM runtime_run WHERE project_id=$1 AND (task_id=$2 OR session_id=$3) AND state IN ('requested','dispatching','running','unknown') LIMIT 1",[this.projectId,e.taskId,e.sessionId]);if(running.rows[0])return false;
    await this.client.query("INSERT INTO resident_queue_release_decision(project_id,decision_id,claim_id,actor_id,reason,next_responsibility) VALUES($1,$2,$3,$4,$5,$6)",[this.projectId,decision.id,claimId,decision.actorId,decision.reason,decision.nextResponsibility]);
    await this.client.query("UPDATE resident_queue_claim SET state='released',release_kind='bounded',released_at=now(),updated_at=now(),bounded_decision_id=$3 WHERE project_id=$1 AND claim_id=$2",[this.projectId,claimId,decision.id]);
    await this.client.query("UPDATE resident_queue_entry SET state='released',claim_id=NULL,version=version+1,updated_at=now() WHERE project_id=$1 AND queue_id=$2 AND entry_id=$3",[this.projectId,e.queueId,e.id]);return true;
  }
}
export class QueueHeld extends Error {constructor(readonly code:QueueHoldCode,message:string){super(message);}}
