import type { PoolClient, QueryResultRow } from "pg";
import type { NativeInputRecord, NativeInputSource, NativeInputTransaction } from "@evoloop/contracts/native-input";
import { DomainError } from "@evoloop/contracts/ports";

const iso=(v:Date|string):string=>v instanceof Date?v.toISOString():v;
const record=(r:QueryResultRow):NativeInputRecord=>({
  projectId:r.project_id,id:r.input_request_id,sessionId:r.session_id,connectionId:r.connection_id,
  nativeRequestId:r.native_request_id,threadId:r.thread_id,turnId:r.turn_id,itemId:r.item_id,method:r.method,
  questions:r.questions,isBlocking:r.is_blocking,supported:r.supported,unavailableReason:r.unavailable_reason,
  observedAt:iso(r.observed_at),state:r.state,source:r.source,response:r.response,reason:r.reason,
  version:r.version,createdAt:iso(r.created_at),updatedAt:iso(r.updated_at),
});

export class PgNativeInputs implements NativeInputTransaction {
  constructor(private readonly client:PoolClient,private readonly scope:string){}
  private assert(projectId:string){if(projectId!==this.scope)throw new DomainError('PROJECT_SCOPE','Native input belongs to another project');}
  async get(projectId:string,id:string):Promise<NativeInputRecord|null>{
    this.assert(projectId);const r=await this.client.query('SELECT * FROM session_native_input_request WHERE project_id=$1 AND input_request_id=$2',[projectId,id]);
    return r.rows[0]?record(r.rows[0]):null;
  }
  async list(projectId:string,sessionId:string,limit:number):Promise<NativeInputRecord[]>{
    this.assert(projectId);if(!Number.isInteger(limit)||limit<1||limit>100)throw new RangeError('input limit must be 1..100');
    const r=await this.client.query(`SELECT * FROM session_native_input_request WHERE project_id=$1 AND session_id=$2
      ORDER BY CASE WHEN state IN ('pending','response_saved') THEN 0 ELSE 1 END,created_at DESC,input_request_id DESC LIMIT $3`,[projectId,sessionId,limit]);
    return r.rows.map(record);
  }
  async pendingResponses(projectId:string,limit:number):Promise<NativeInputRecord[]>{
    this.assert(projectId);if(!Number.isInteger(limit)||limit<1||limit>100)throw new RangeError('input limit must be 1..100');
    const r=await this.client.query(`SELECT * FROM session_native_input_request WHERE project_id=$1 AND state='response_saved'
      AND response->>'outcome'='pending' ORDER BY created_at,input_request_id LIMIT $2`,[projectId,limit]);return r.rows.map(record);
  }
  async unlinked(projectId:string,sessionId:string,limit:number):Promise<NativeInputRecord[]>{
    this.assert(projectId);const r=await this.client.query(`SELECT * FROM session_native_input_request WHERE project_id=$1 AND session_id=$2
      AND source IS NULL AND turn_id IS NOT NULL
      ORDER BY CASE WHEN state IN ('pending','response_saved') THEN 0 ELSE 1 END,created_at DESC,input_request_id DESC LIMIT $3`,
      [projectId,sessionId,limit]);return r.rows.map(record);
  }
  async findSource(projectId:string,sessionId:string,turnId:string):Promise<NativeInputSource|null>{
    this.assert(projectId);
    const r=await this.client.query(`SELECT 'run' AS kind,run_id AS id,operation_id,actor_id,task_id,task_revision_id,NULL::uuid AS processing_id
      FROM runtime_run WHERE project_id=$1 AND session_id=$2 AND native_turn_id=$3
      UNION ALL
      SELECT 'message' AS kind,m.message_id AS id,p.operation_id,m.sender_actor_id AS actor_id,NULL::uuid AS task_id,
        NULL::uuid AS task_revision_id,p.processing_id
      FROM session_message_processing p JOIN session_message m ON m.project_id=p.project_id AND m.message_id=p.message_id
      WHERE p.project_id=$1 AND p.session_id=$2 AND p.native_turn_id=$3 LIMIT 2`,[projectId,sessionId,turnId]);
    if(r.rows.length>1)throw new DomainError('INPUT_SOURCE_AMBIGUOUS','Native Turn has multiple business sources');
    const row=r.rows[0];if(!row)return null;
    return row.kind==='run'?{kind:'run',runId:row.id,operationId:row.operation_id,actorId:row.actor_id,
      taskId:row.task_id,taskRevisionId:row.task_revision_id}:{kind:'message',messageId:row.id,processingId:row.processing_id,
      operationId:row.operation_id,actorId:row.actor_id};
  }
  async insert(v:NativeInputRecord):Promise<void>{
    this.assert(v.projectId);await this.client.query(`INSERT INTO session_native_input_request(project_id,input_request_id,session_id,connection_id,
      native_request_id,thread_id,turn_id,item_id,method,questions,is_blocking,supported,unavailable_reason,observed_at,
      state,source,response,reason,version,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10::jsonb,$11,$12,$13,$14,$15,$16::jsonb,$17::jsonb,$18,$19,$20,$21)`,
      [v.projectId,v.id,v.sessionId,v.connectionId,JSON.stringify(v.nativeRequestId),v.threadId,v.turnId,v.itemId,v.method,
       JSON.stringify(v.questions),v.isBlocking,v.supported,v.unavailableReason,v.observedAt,v.state,
       v.source?JSON.stringify(v.source):null,v.response?JSON.stringify(v.response):null,v.reason,v.version,v.createdAt,v.updatedAt]);
  }
  async update(v:NativeInputRecord,expectedVersion:number):Promise<void>{
    this.assert(v.projectId);const r=await this.client.query(`UPDATE session_native_input_request SET state=$3,source=$4::jsonb,response=$5::jsonb,
      reason=$6,version=$7,updated_at=$8 WHERE project_id=$1 AND input_request_id=$2 AND version=$9`,
      [v.projectId,v.id,v.state,v.source?JSON.stringify(v.source):null,v.response?JSON.stringify(v.response):null,
       v.reason,v.version,v.updatedAt,expectedVersion]);
    if(!r.rowCount)throw new DomainError('VERSION_CONFLICT','Native input changed',(await this.get(v.projectId,v.id))?.version);
  }
  async invalidateConnections(projectId:string,currentConnectionId:string,at:string):Promise<void>{
    this.assert(projectId);await this.client.query(`UPDATE session_native_input_request SET state='unavailable',reason='disconnected',
      version=version+1,updated_at=$3 WHERE project_id=$1 AND connection_id<>$2 AND state IN ('pending','response_saved')`,
      [projectId,currentConnectionId,at]);
  }
}
