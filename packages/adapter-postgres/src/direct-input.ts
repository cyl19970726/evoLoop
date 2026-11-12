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
  private async transaction<T>(projectId:string,work:(client:PoolClient)=>Promise<T>):Promise<T>{
    const client=await this.pool.connect();
    try{await client.query("BEGIN");
      // Same order as core writes: project lock first. A start locks the Session row and then inserts a
      // message whose project key share waits on queue creation's project row lock, while queue creation
      // waits to reference that Session row (40P01) unless both queue behind this lock.
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[projectId]);
      const result=await work(client);await client.query("COMMIT");return result;}
    catch(error){await client.query("ROLLBACK");throw error;}
    finally{client.release();}
  }
  /**
   * A refused input is "queued" exactly when its text exists as an ordinary message under the same ID and that message is
   * not the input's own primary. A start that owned a slot wrote its primary message under the input ID, so a refused start
   * counts only when it never had a slot. A steer never writes a message under its ID except when it is queued, but it
   * carries the processing_id of the message Turn it was inserted into (the Leader's usual case), so that ID says nothing.
   */
  private async withQueued(items:DirectInputRecord[],run:Pick<Pool,"query">=this.pool):Promise<DirectInputRecord[]>{
    const refused=items.filter(x=>x.state==="rejected"&&(x.mode==="steer"||x.source.processingId===null));
    if(!refused.length)return items.map(x=>({...x,queuedMessageId:null}));
    const found=await run.query(`SELECT message_id FROM session_message WHERE project_id=$1 AND message_id=ANY($2::uuid[])`,
      [refused[0]!.projectId,refused.map(x=>x.inputId)]);
    const ids=new Set<string>(found.rows.map(row=>row.message_id));
    return items.map(x=>({...x,queuedMessageId:refused.includes(x)&&ids.has(x.inputId)?x.inputId:null}));
  }
  async get(projectId:string,inputId:string):Promise<DirectInputRecord|null>{
    const r=await this.pool.query("SELECT * FROM session_direct_input WHERE project_id=$1 AND input_id=$2",[projectId,inputId]);
    return r.rows[0]?(await this.withQueued([map(r.rows[0])]))[0]!:null;
  }
  /** Read only, scoped lookup for native Items that carry an exact client ID. */
  async acceptedForInputs(projectId:string,sessionId:string,inputIds:string[]):Promise<DirectInputRecord[]>{
    if(!inputIds.length)return [];
    const r=await this.pool.query(`SELECT * FROM session_direct_input WHERE project_id=$1 AND session_id=$2
      AND input_id=ANY($3::uuid[]) AND mode='steer' AND state='accepted'
      AND actual_turn_id IS NOT NULL`,[projectId,sessionId,inputIds]);
    return r.rows.map(map);
  }
  /** Accepted inputs whose Turn is known but whose native Item was never recorded (a start learns it only by reading history). */
  async unboundAccepted(limit:number):Promise<DirectInputRecord[]>{
    if(!Number.isInteger(limit)||limit<1||limit>100)throw new RangeError("limit must be 1..100");
    const r=await this.pool.query(`SELECT * FROM session_direct_input WHERE state='accepted' AND native_item_id IS NULL
      AND actual_turn_id IS NOT NULL ORDER BY updated_at,input_id LIMIT $1`,[limit]);
    return r.rows.map(map);
  }
  /** A held provider starts nothing new for any of its Sessions; adding to a Turn already running is not a new start. */
  async providerHeld(projectId:string,sessionId:string,run:Pick<Pool,"query">=this.pool):Promise<boolean>{
    const r=await run.query(`SELECT EXISTS(SELECT 1 FROM runtime_provider_hold h JOIN runtime_session s ON s.project_id=h.project_id
      AND s.runtime_provider=h.provider WHERE h.project_id=$1 AND h.state='held' AND s.session_id=$2) AS held`,[projectId,sessionId]);
    return r.rows[0]?.held===true;
  }
  /** What the Session's running primary Turn came from: a business Task Run, or a message (also a direct start); null when idle. */
  async primaryKind(projectId:string,sessionId:string):Promise<"run"|"message"|null>{
    const r=await this.pool.query(`SELECT EXISTS(SELECT 1 FROM runtime_run WHERE project_id=$1 AND session_id=$2
      AND state IN ('requested','dispatching','running','unknown')) AS run,EXISTS(SELECT 1 FROM session_message_processing WHERE project_id=$1
      AND session_id=$2 AND state IN ('dispatching','running','unknown')) AS message`,[projectId,sessionId]);
    return r.rows[0]?.run?"run":r.rows[0]?.message?"message":null;
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
    return {items:await this.withQueued(r.rows.slice(0,limit).map(map)),nextCursor:r.rows.length>limit?r.rows[limit-1]!.input_id:null};
  }
  async reserve(projectId:string,sessionId:string,actorId:string,command:DirectInputCommand,
    grant:DirectInputGrant,fingerprint:string,options:{notice?:boolean}={}):Promise<{record:DirectInputRecord;created:boolean}>{
    return this.transaction(projectId,async client=>{
      const prior=await client.query(`SELECT * FROM session_direct_input WHERE project_id=$1 AND
        (input_id=$2 OR operation_id=$3) FOR UPDATE`,[projectId,command.inputId,command.operationId]);
      if(prior.rows.length){
        const old=map(prior.rows[0]);
        if(prior.rows.length!==1||old.inputId!==command.inputId||old.operationId!==command.operationId||
          old.actorId!==actorId||old.sessionId!==sessionId||old.content!==command.content||
          old.expectedTurnId!==command.expectedTurnId)
          throw new DomainError("INPUT_ID_CONFLICT","Original input intent differs; read the saved input");
        return {record:(await this.withQueued([old],client))[0]!,created:false};
      }
      // One ID is one intent, whichever entry saw it first. A message already saved under this input ID (or this operation ID) is that
      // text queued: inserting it as well would send it to the Leader twice (a queue request whose receipt was lost, then an insert
      // with the same ID). The ordinary entry refuses the other order (insertSessionMessage); both run under the project lock.
      const taken=await client.query(`SELECT message_id FROM session_message WHERE project_id=$1 AND (message_id=$2 OR operation_id=$3) LIMIT 1`,
        [projectId,command.inputId,command.operationId]);
      if(taken.rows.length)throw new DomainError("INPUT_ID_IS_MESSAGE",
        "this ID is already an ordinary queued message; read it by its ID instead of inserting the text again");
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
      // A platform notice only ever adds to a running Turn that a message started: never to a Run, never as a new Turn, and a changed Turn is
      // refused (to be retried with a new packet) instead of being saved as a queued message.
      if(options.notice&&runs.length)throw new DomainError("NOTICE_NOT_INTO_RUN","A platform notice is never added to a business Task Run");
      if(options.notice&&!active)throw new DomainError("TURN_ENDED","The Turn ended before the notice was added; nothing was reserved");
      if(options.notice&&(active.state!=="running"||!turn||command.expectedTurnId!==turn))
        throw new DomainError("TURN_CHANGED","The Turn is not the one the notice was built for; nothing was reserved");
      if(active){
        // Everything below is refused before any native request: it is saved as one queued message instead of failing the person.
        if(active.state!=="running"||!turn)return this.queueRefused(client,projectId,sessionId,actorId,command,
          "NOT_BOUND: the primary Turn is not bound and running yet; saved as a queued ordinary message");
        if(command.expectedTurnId!==turn)return this.queueRefused(client,projectId,sessionId,actorId,command,
          "TURN_CHANGED: the Turn changed before the input was added; saved as a queued ordinary message");
        mode="steer";
        if(!grant.canSteer)throw new DomainError("DIRECT_GRANT_MISSING","Direct steer is not authorized");
        source=runs.length?{kind:"run",id:active.run_id,processingId:null}:
          {kind:"message",id:active.message_id,processingId:active.processing_id};
      }else{
        if(command.expectedTurnId!==null)return this.queueRefused(client,projectId,sessionId,actorId,command,
          "TURN_CHANGED: the Turn ended before the input was added; saved as a queued ordinary message");
        // An idle start would begin a new Turn on a held provider and fail the same way, closing the gate again. Refused before
        // anything is reserved; the caller saves the text as a queued message, which goes out with the release.
        if(await this.providerHeld(projectId,sessionId,client))
          throw new DomainError("PROVIDER_HELD","the model provider is paused (quota or authentication); queue the message instead, it goes out with the release");
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
  /**
   * The input is provably unsent (the Turn the person saw changed or ended, or the primary Turn is not bound yet): the same
   * input becomes one queued ordinary message with the same ID and operation ID, and the receipt says so. A repeat finds this
   * receipt and adds nothing. Runs inside the reservation transaction, after the Session and the ordinary-message grant were
   * checked. Unknown outcomes are never converted: they never reach this point.
   */
  private async queueRefused(client:PoolClient,projectId:string,sessionId:string,actorId:string,
    command:DirectInputCommand,reason:string):Promise<{record:DirectInputRecord;created:boolean}>{
    await client.query(`INSERT INTO session_message(project_id,message_id,operation_id,target_kind,session_id,
      sender_actor_id,content,state,version,created_at,updated_at)
      VALUES($1,$2,$3,'owned',$4,$5,$6,'queued',1,now(),now())`,
      [projectId,command.inputId,command.operationId,sessionId,actorId,command.content]);
    const mode=command.expectedTurnId===null?"start":"steer";
    const inserted=await client.query(`INSERT INTO session_direct_input(project_id,session_id,input_id,operation_id,
      actor_id,content,mode,source_kind,source_id,processing_id,expected_turn_id,state,reason,version,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,'message',$3,NULL,$8,'rejected',$9,1,now(),now()) RETURNING *`,
      [projectId,sessionId,command.inputId,command.operationId,actorId,command.content,mode,command.expectedTurnId,reason]);
    return {record:{...needed(inserted.rows[0]),queuedMessageId:command.inputId},created:true};
  }
  async attempt(projectId:string,inputId:string):Promise<DirectInputRecord>{
    return this.advance(projectId,inputId,"pending","attempted",null,null,null);
  }
  async unknown(projectId:string,inputId:string,reason:string):Promise<DirectInputRecord>{
    return this.advance(projectId,inputId,"attempted","unknown",null,null,reason);
  }
  async reject(projectId:string,inputId:string,reason:string):Promise<DirectInputRecord>{
    return this.transaction(projectId,async client=>{
      const old=needed((await client.query("SELECT * FROM session_direct_input WHERE project_id=$1 AND input_id=$2 FOR UPDATE",[projectId,inputId])).rows[0]);
      if(!["pending","attempted","unknown"].includes(old.state))return old;
      if(old.mode==="start")await this.finishPrimary(client,old,"failed",null,reason);
      return this.update(client,old,"rejected",null,null,reason);
    });
  }
  /** A steer kind refusal is terminal for direct input, but its content is not lost: queue it as one ordinary message. */
  async rejectSteerAndQueue(projectId:string,inputId:string,reason:string,options:{provedUnsent?:boolean}={}):Promise<DirectInputRecord>{
    return this.transaction(projectId,async client=>{
      const old=needed((await client.query("SELECT * FROM session_direct_input WHERE project_id=$1 AND input_id=$2 FOR UPDATE",
        [projectId,inputId])).rows[0]);
      if(old.mode!=="steer")throw new DomainError("INPUT_STATE","Only a steer can become a queued ordinary message");
      if(old.state==="rejected")return (await this.withQueued([old],client))[0]!;
      // Queue only after an explicit pre-send refusal. An unknown steer may already have reached the Turn, so a later retry without
      // proof must not turn it into a second ordinary message. The one exception is the refusal answering this very request
      // (`provedUnsent`): the runtime itself said the steer was not applied, so it cannot have reached the Turn, even if a
      // reconcile that found nothing marked the input unknown while the request was on the wire.
      if(!["pending","attempted"].includes(old.state)&&!(options.provedUnsent&&old.state==="unknown"))
        throw new DomainError("INPUT_STATE","Original input attempt has already advanced");
      await client.query(`INSERT INTO session_message(project_id,message_id,operation_id,target_kind,session_id,
        sender_actor_id,content,state,version,created_at,updated_at)
        VALUES($1,$2,$3,'owned',$4,$5,$6,'queued',1,now(),now())
        ON CONFLICT (project_id,message_id) DO NOTHING`,
        [projectId,old.inputId,old.operationId,old.sessionId,old.actorId,old.content]);
      return {...await this.update(client,old,"rejected",null,null,reason),queuedMessageId:old.inputId};
    });
  }
  async accept(projectId:string,inputId:string,turnId:string,itemId:string|null):Promise<DirectInputRecord>{
    return this.transaction(projectId,async client=>{
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
    return this.transaction(projectId,async client=>{
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
