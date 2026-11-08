import type { Pool, PoolClient, QueryResultRow } from "pg";
import { randomUUID } from "node:crypto";
import type { DirectInputCommand, DirectInputRecord, DirectInputGrant } from "@evoloop/contracts/direct-input";
import { DomainError } from "@evoloop/contracts/ports";

const iso = (v: string | Date): string => v instanceof Date ? v.toISOString() : v;
const map = (r: QueryResultRow): DirectInputRecord => ({
  projectId:r.project_id,sessionId:r.session_id,inputId:r.input_id,operationId:r.operation_id,
  actorId:r.actor_id,content:r.content,mode:r.mode,
  source:{kind:r.source_kind,id:r.source_id,processingId:r.processing_id},
  expectedTurnId:r.expected_turn_id,actualTurnId:r.actual_turn_id,nativeItemId:r.native_item_id,
  state:r.state,reason:r.reason,version:r.version,createdAt:iso(r.created_at),updatedAt:iso(r.updated_at),
});
const needed = (r: QueryResultRow | undefined): DirectInputRecord => {
  if(!r)throw new DomainError("INPUT_NOT_FOUND","Direct input was not found");
  return map(r);
};

/** Uses the existing session row, processing slot and message budget in one PG transaction. */
export class PgDirectInputs {
  constructor(private readonly pool: Pool) {}
  private async transaction<T>(work:(client:PoolClient)=>Promise<T>):Promise<T>{
    const client=await this.pool.connect();
    try{await client.query("BEGIN");const result=await work(client);await client.query("COMMIT");return result;}
    catch(error){await client.query("ROLLBACK");throw error;}
    finally{client.release();}
  }
  async get(projectId:string,inputId:string):Promise<DirectInputRecord|null>{
    const r=await this.pool.query("SELECT * FROM session_direct_input WHERE project_id=$1 AND input_id=$2",[projectId,inputId]);
    return r.rows[0]?map(r.rows[0]):null;
  }
  /** Read only, scoped lookup for native Items that carry an exact client ID. */
  async acceptedForInputs(projectId:string,sessionId:string,inputIds:string[]):Promise<DirectInputRecord[]>{
    if(!inputIds.length)return [];
    const r=await this.pool.query(`SELECT * FROM session_direct_input WHERE project_id=$1 AND session_id=$2
      AND input_id=ANY($3::uuid[]) AND mode='steer' AND state='accepted'
      AND actual_turn_id IS NOT NULL`,[projectId,sessionId,inputIds]);
    return r.rows.map(map);
  }
  async hasPrimary(projectId:string,sessionId:string):Promise<boolean>{
    const r=await this.pool.query(`SELECT EXISTS(SELECT 1 FROM runtime_run WHERE project_id=$1 AND session_id=$2
      AND state IN ('requested','dispatching','running','unknown')) OR EXISTS(
      SELECT 1 FROM session_message_processing WHERE project_id=$1 AND session_id=$2
      AND state IN ('dispatching','running','unknown')) AS busy`,[projectId,sessionId]);
    return r.rows[0]?.busy===true;
  }
  async inspect(projectId:string,sessionId:string,actorId:string):Promise<{state:"idle"|"running"|"busy";turnId:string|null;used:number}>{
    const r=await this.pool.query(`SELECT
      (SELECT state FROM runtime_run WHERE project_id=$1 AND session_id=$2
        AND state IN ('requested','dispatching','running','unknown') LIMIT 1) AS run_state,
      (SELECT native_turn_id FROM runtime_run WHERE project_id=$1 AND session_id=$2
        AND state IN ('requested','dispatching','running','unknown') LIMIT 1) AS run_turn,
      (SELECT state FROM session_message_processing WHERE project_id=$1 AND session_id=$2
        AND state IN ('dispatching','running','unknown') LIMIT 1) AS message_state,
      (SELECT native_turn_id FROM session_message_processing WHERE project_id=$1 AND session_id=$2
        AND state IN ('dispatching','running','unknown') LIMIT 1) AS message_turn,
      (SELECT count(*)::integer FROM session_message_processing p JOIN session_message m
        ON m.project_id=p.project_id AND m.message_id=p.message_id
        WHERE p.project_id=$1 AND p.session_id=$2 AND m.sender_actor_id=$3
          AND NOT (p.state='failed' AND p.native_turn_id IS NULL)) AS used`,[projectId,sessionId,actorId]);
    const row=r.rows[0],state=row?.run_state??row?.message_state??null,turnId=row?.run_turn??row?.message_turn??null;
    return {state:state===null?"idle":state==="running"&&turnId?"running":"busy",turnId,used:row?.used??0};
  }
  async list(projectId:string,sessionId:string,limit:number,cursor?:string,actorId?:string):Promise<{items:DirectInputRecord[];nextCursor:string|null}>{
    if(!Number.isInteger(limit)||limit<1||limit>50)throw new DomainError("INVALID_LIMIT","Limit must be 1..50");
    const r=await this.pool.query(`SELECT * FROM session_direct_input WHERE project_id=$1 AND session_id=$2
      AND ($5::text IS NULL OR actor_id=$5)
      AND ($3::uuid IS NULL OR (created_at,input_id)<(SELECT created_at,input_id FROM session_direct_input
        WHERE project_id=$1 AND session_id=$2 AND input_id=$3 AND ($5::text IS NULL OR actor_id=$5)))
      ORDER BY created_at DESC,input_id DESC LIMIT $4`,[projectId,sessionId,cursor??null,limit+1,actorId??null]);
    return {items:r.rows.slice(0,limit).map(map),nextCursor:r.rows.length>limit?r.rows[limit-1]!.input_id:null};
  }
  async reserve(projectId:string,sessionId:string,actorId:string,command:DirectInputCommand,
    grant:DirectInputGrant,fingerprint:string):Promise<{record:DirectInputRecord;created:boolean}>{
    return this.transaction(async client=>{
      const prior=await client.query(`SELECT * FROM session_direct_input WHERE project_id=$1 AND
        (input_id=$2 OR operation_id=$3) FOR UPDATE`,[projectId,command.inputId,command.operationId]);
      if(prior.rows.length){
        const old=map(prior.rows[0]);
        if(prior.rows.length!==1||old.inputId!==command.inputId||old.operationId!==command.operationId||
          old.actorId!==actorId||old.sessionId!==sessionId||old.content!==command.content||
          old.expectedTurnId!==command.expectedTurnId)
          throw new DomainError("INPUT_ID_CONFLICT","Original input intent differs; read the saved input");
        return {record:old,created:false};
      }
      const session=(await client.query(`SELECT * FROM runtime_session WHERE project_id=$1 AND session_id=$2 FOR UPDATE`,
        [projectId,sessionId])).rows[0];
      if(!session||session.state!=="ready"||!session.native_thread_id||!session.native_session_id||
        session.sandbox!=="danger-full-access"||session.approval_policy!=="never")
        throw new DomainError("SESSION_NOT_READY","Owned full-profile Session is unavailable");
      if(!grant.enabled||grant.projectId!==projectId||grant.sessionId!==sessionId||
        grant.senderActorId!==actorId||grant.receiverRoleId!==session.role_id||grant.cwd!==session.cwd||
        !grant.receiverActorId||grant.receiverActorId===actorId||
        (grant.maxTurns!==undefined&&(!Number.isSafeInteger(grant.maxTurns)||grant.maxTurns<1)))
        throw new DomainError("DIRECT_GRANT_MISSING","Exact direct input grant is unavailable");
      const runs=(await client.query(`SELECT run_id,state,native_turn_id FROM runtime_run WHERE project_id=$1 AND session_id=$2
        AND state IN ('requested','dispatching','running','unknown')`,[projectId,sessionId])).rows;
      const messages=(await client.query(`SELECT message_id,processing_id,state,native_turn_id FROM session_message_processing
        WHERE project_id=$1 AND session_id=$2 AND state IN ('dispatching','running','unknown')`,[projectId,sessionId])).rows;
      if(runs.length+messages.length>1)throw new DomainError("SOURCE_AMBIGUOUS","Session has multiple primary sources");
      const active=runs[0]??messages[0];
      const turn=active?.native_turn_id??null;
      let mode:"steer"|"start";
      let source:{kind:"run"|"message";id:string;processingId:string|null};
      if(active){
        if(active.state!=="running"||!turn)throw new DomainError("SESSION_BUSY","Primary Turn is not bound and running");
        if(command.expectedTurnId!==turn)throw new DomainError("TURN_CHANGED","Expected Turn differs from the current primary Turn");
        mode="steer";
        if(!grant.canSteer)throw new DomainError("DIRECT_GRANT_MISSING","Direct steer is not authorized");
        source=runs.length?{kind:"run",id:active.run_id,processingId:null}:
          {kind:"message",id:active.message_id,processingId:active.processing_id};
      }else{
        if(command.expectedTurnId!==null)throw new DomainError("TURN_CHANGED","Expected Turn is no longer active");
        if(!grant.canStart)throw new DomainError("DIRECT_GRANT_MISSING","Direct start is not authorized");
        const count=(await client.query(`SELECT count(*)::integer AS n FROM session_message_processing p
          JOIN session_message m ON m.project_id=p.project_id AND m.message_id=p.message_id
          WHERE p.project_id=$1 AND p.session_id=$2 AND m.sender_actor_id=$3
          AND NOT (p.state='failed' AND p.native_turn_id IS NULL)`,[projectId,sessionId,actorId])).rows[0].n;
        if(grant.maxTurns!==undefined&&count>=grant.maxTurns)
          throw new DomainError("MESSAGE_BUDGET_EXHAUSTED","Direct start Turn budget is exhausted");
        if(!/^[a-f0-9]{64}$/.test(fingerprint))throw new DomainError("NATIVE_ADMISSION_MISSING","Fresh native qualification is required");
        mode="start";source={kind:"message",id:command.inputId,processingId:randomUUID()};
        await client.query(`INSERT INTO session_message(project_id,message_id,operation_id,target_kind,session_id,
          sender_actor_id,content,state,version,created_at,updated_at)
          VALUES($1,$2,$3,'owned',$4,$5,$6,'processing',1,now(),now())`,
          [projectId,command.inputId,command.operationId,sessionId,actorId,command.content]);
        await client.query(`INSERT INTO session_message_processing(project_id,processing_id,message_id,session_id,
          operation_id,receiver_actor_id,state,read_only_policy_fingerprint,version,started_at,updated_at)
          VALUES($1,$2,$3,$4,$5,$6,'dispatching',$7,1,now(),now())`,
          [projectId,source.processingId,command.inputId,sessionId,command.operationId,grant.receiverActorId,fingerprint]);
      }
      const inserted=await client.query(`INSERT INTO session_direct_input(project_id,session_id,input_id,operation_id,
        actor_id,content,mode,source_kind,source_id,processing_id,expected_turn_id,state,version,created_at,updated_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'attempted',1,now(),now()) RETURNING *`,
        [projectId,sessionId,command.inputId,command.operationId,actorId,command.content,mode,
          source.kind,source.id,source.processingId,command.expectedTurnId]);
      return {record:needed(inserted.rows[0]),created:true};
    });
  }
  async attempt(projectId:string,inputId:string):Promise<DirectInputRecord>{
    return this.advance(projectId,inputId,"pending","attempted",null,null,null);
  }
  async unknown(projectId:string,inputId:string,reason:string):Promise<DirectInputRecord>{
    return this.advance(projectId,inputId,"attempted","unknown",null,null,reason);
  }
  async reject(projectId:string,inputId:string,reason:string):Promise<DirectInputRecord>{
    return this.transaction(async client=>{
      const old=needed((await client.query("SELECT * FROM session_direct_input WHERE project_id=$1 AND input_id=$2 FOR UPDATE",[projectId,inputId])).rows[0]);
      if(!["pending","attempted","unknown"].includes(old.state))return old;
      if(old.mode==="start")await this.finishPrimary(client,old,"failed",null,reason);
      return this.update(client,old,"rejected",null,null,reason);
    });
  }
  async accept(projectId:string,inputId:string,turnId:string,itemId:string|null):Promise<DirectInputRecord>{
    return this.transaction(async client=>{
      const old=needed((await client.query("SELECT * FROM session_direct_input WHERE project_id=$1 AND input_id=$2 FOR UPDATE",[projectId,inputId])).rows[0]);
      if(old.state==="accepted"){
        if(old.actualTurnId!==turnId)throw new DomainError("TURN_CONFLICT","Accepted input belongs to another Turn");
        if(itemId&&old.nativeItemId===null)return this.update(client,old,"accepted",turnId,itemId,null);
        return old;
      }
      if(!["attempted","unknown"].includes(old.state))throw new DomainError("INPUT_STATE","Input cannot be accepted");
      if(old.mode==="steer"&&old.expectedTurnId!==turnId)
        throw new DomainError("TURN_CONFLICT","Native steer acknowledged another Turn");
      if(old.mode==="start")await this.finishPrimary(client,old,"running",turnId,null);
      return this.update(client,old,"accepted",turnId,itemId,null);
    });
  }
  private async advance(projectId:string,inputId:string,from:string,to:DirectInputRecord["state"],
    turnId:string|null,itemId:string|null,reason:string|null):Promise<DirectInputRecord>{
    return this.transaction(async client=>{
      const old=needed((await client.query("SELECT * FROM session_direct_input WHERE project_id=$1 AND input_id=$2 FOR UPDATE",[projectId,inputId])).rows[0]);
      if(old.state!==from)throw new DomainError("INPUT_STATE","Original input attempt has already advanced");
      if(old.mode==="start"&&to==="unknown")await this.finishPrimary(client,old,"unknown",null,reason);
      return this.update(client,old,to,turnId,itemId,reason);
    });
  }
  private async update(client:PoolClient,old:DirectInputRecord,state:DirectInputRecord["state"],
    turnId:string|null,itemId:string|null,reason:string|null):Promise<DirectInputRecord>{
    const r=await client.query(`UPDATE session_direct_input SET state=$4,actual_turn_id=COALESCE(actual_turn_id,$5),
      native_item_id=COALESCE(native_item_id,$6),reason=$7,version=version+1,updated_at=now()
      WHERE project_id=$1 AND input_id=$2 AND version=$3 RETURNING *`,
      [old.projectId,old.inputId,old.version,state,turnId,itemId,reason?.slice(0,4000)??null]);
    return needed(r.rows[0]);
  }
  private async finishPrimary(client:PoolClient,old:DirectInputRecord,state:"running"|"unknown"|"failed",
    turnId:string|null,reason:string|null):Promise<void>{
    const p=(await client.query(`SELECT * FROM session_message_processing WHERE project_id=$1 AND processing_id=$2 FOR UPDATE`,
      [old.projectId,old.source.processingId])).rows[0];
    if(!p)throw new DomainError("SOURCE_MISSING","Original direct processing is missing");
    if(p.operation_id!==old.operationId||p.message_id!==old.inputId||
      p.native_turn_id&&turnId&&p.native_turn_id!==turnId)
      throw new DomainError("SOURCE_CHANGED","Original direct processing changed");
    if(state==="running"&&p.native_turn_id===turnId&&["running","completed","failed"].includes(p.state))return;
    if(p.state===state&&p.native_turn_id===turnId)return;
    if(!["dispatching","unknown"].includes(p.state))throw new DomainError("SOURCE_CHANGED","Original direct processing already advanced");
    await client.query(`UPDATE session_message_processing SET state=$3,native_turn_id=COALESCE(native_turn_id,$4),
      failure=$5,version=version+1,updated_at=now() WHERE project_id=$1 AND processing_id=$2`,
      [old.projectId,old.source.processingId,state,turnId,reason?.slice(0,4000)??null]);
    if(state!=="running")await client.query(`UPDATE session_message SET state=$3,version=version+1,updated_at=now()
      WHERE project_id=$1 AND message_id=$2 AND state IN ('processing','unknown') AND state<>$3`,
      [old.projectId,old.inputId,state]);
    else await client.query(`UPDATE session_message SET state='processing',version=version+1,updated_at=now()
      WHERE project_id=$1 AND message_id=$2 AND state='unknown'`,[old.projectId,old.inputId]);
  }
}
