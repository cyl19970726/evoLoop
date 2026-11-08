import type { Pool } from 'pg';
import { DomainError } from '@evoloop/contracts/ports';

export type DeliveryMessage = {
  eventCursor:number; messageId:string; messageState:string; processingState:string|null;
  nativeTurnId:string|null; response:string|null;
};
export type DeliveryDecision = {
  projectId:string; bindingId:string; deliveryId:number; routeVersion:number;
  routeOwner:string; routeEpoch:number; routeSessionRef:string; conversationId:string;
  cursorStart:number; cursorEnd:number;
  decision:'reply'|'draft'|'skip'|'defer'; requestId:string|null; content:string|null;
  state:'prepared'|'attempted'|'observed'|'complete_attempted'|'complete_unknown'|'completed';
};
export type TransportAttempt={routeVersion:number;recordTurnId:string|null;
  finishStatus:'completed'|'interrupted'|'failed'|null};
export type ClaimAttempt={routeVersion:number;routeOwner:string;routeEpoch:number;routeSessionRef:string;
  routePolicyHash:string;targetThreadId:string;observed:boolean;owner:string|null;epoch:number|null;
  cursorStart:number|null;cursorEnd:number|null};
export type TerminalDeliveryObservation={owner:string;epoch:number;sessionRef:string;
  conversationId:string;cursorStart:number;cursorEnd:number};
export type UnhandledDeliveryEvent={eventCursor:number;eventKind:string;direction:string;participantId:string|null;
  reason:'unsupported_content'|'empty_text'|'text_too_large'|'sender_not_allowed';contentLength:number;
  routeVersion:number;createdAt:string};
const of=(row:Record<string,unknown>):DeliveryDecision=>({
  projectId:String(row.project_id),bindingId:String(row.binding_id),deliveryId:Number(row.delivery_id),
  routeVersion:Number(row.route_version),routeOwner:String(row.route_owner),
  routeEpoch:Number(row.route_epoch),routeSessionRef:String(row.route_session_ref),
  conversationId:String(row.conversation_id),cursorStart:Number(row.cursor_start),
  cursorEnd:Number(row.cursor_end),decision:row.decision as DeliveryDecision['decision'],
  requestId:row.request_id as string|null,content:row.content as string|null,
  state:row.state as DeliveryDecision['state'],
});

/** Durable original intent, separate from the immutable event to message links. */
export class PgConnectorDeliveryDecisions {
  constructor(private readonly db:Pool){}
  async claim(projectId:string,bindingId:string,deliveryId:number):Promise<ClaimAttempt|null>{
    const result=await this.db.query(`SELECT route_version,route_owner,route_epoch,route_session_ref,
      route_policy_hash,target_thread_id,observed_at,owner,epoch,cursor_start,cursor_end
      FROM connector_claim_attempt WHERE project_id=$1 AND binding_id=$2 AND delivery_id=$3`,
      [projectId,bindingId,deliveryId]);
    const row=result.rows[0];return row?{routeVersion:Number(row.route_version),routeOwner:String(row.route_owner),
      routeEpoch:Number(row.route_epoch),routeSessionRef:String(row.route_session_ref),
      routePolicyHash:String(row.route_policy_hash),targetThreadId:String(row.target_thread_id),
      observed:!!row.observed_at,
      owner:row.owner??null,epoch:row.epoch===null?null:Number(row.epoch),
      cursorStart:row.cursor_start===null?null:Number(row.cursor_start),
      cursorEnd:row.cursor_end===null?null:Number(row.cursor_end)}:null;
  }
  async markClaimAttempted(projectId:string,bindingId:string,deliveryId:number,routeVersion:number,
    route:{owner:string;epoch:number;sessionRef:string;policyHash:string;targetThreadId:string}):Promise<boolean>{
    const result=await this.db.query(`INSERT INTO connector_claim_attempt
      (project_id,binding_id,delivery_id,route_version,route_owner,route_epoch,route_session_ref,
       route_policy_hash,target_thread_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
      ON CONFLICT DO NOTHING RETURNING delivery_id`,[projectId,bindingId,deliveryId,routeVersion,
        route.owner,route.epoch,route.sessionRef,route.policyHash,route.targetThreadId]);
    return result.rowCount===1;
  }
  async markClaimObserved(projectId:string,bindingId:string,deliveryId:number,routeVersion:number,
    value:{owner:string;epoch:number;cursorStart:number;cursorEnd:number}):Promise<boolean>{
    const result=await this.db.query(`UPDATE connector_claim_attempt SET observed_at=now(),
      owner=$5,epoch=$6,cursor_start=$7,cursor_end=$8
      WHERE project_id=$1 AND binding_id=$2 AND delivery_id=$3 AND route_version=$4
        AND observed_at IS NULL RETURNING delivery_id`,
      [projectId,bindingId,deliveryId,routeVersion,value.owner,value.epoch,value.cursorStart,value.cursorEnd]);
    return result.rowCount===1;
  }
  async transport(projectId:string,bindingId:string,deliveryId:number):Promise<TransportAttempt|null>{
    const result=await this.db.query(`SELECT route_version,record_turn_id,finish_status
      FROM connector_transport_attempt WHERE project_id=$1 AND binding_id=$2 AND delivery_id=$3`,
      [projectId,bindingId,deliveryId]);
    const row=result.rows[0];return row?{routeVersion:row.route_version,
      recordTurnId:row.record_turn_id,finishStatus:row.finish_status}:null;
  }
  async markReserve(projectId:string,bindingId:string,deliveryId:number,routeVersion:number):Promise<boolean>{
    const result=await this.db.query(`INSERT INTO connector_transport_attempt
      (project_id,binding_id,delivery_id,route_version) VALUES($1,$2,$3,$4)
      ON CONFLICT DO NOTHING RETURNING delivery_id`,[projectId,bindingId,deliveryId,routeVersion]);
    return result.rowCount===1;
  }
  async markRecord(projectId:string,bindingId:string,deliveryId:number,routeVersion:number,turnId:string):Promise<boolean>{
    const result=await this.db.query(`UPDATE connector_transport_attempt
      SET record_turn_id=$5,record_attempted_at=now()
      WHERE project_id=$1 AND binding_id=$2 AND delivery_id=$3 AND route_version=$4
        AND record_attempted_at IS NULL RETURNING delivery_id`,
      [projectId,bindingId,deliveryId,routeVersion,turnId]);
    return result.rowCount===1;
  }
  async markFinish(projectId:string,bindingId:string,deliveryId:number,routeVersion:number,
    status:'completed'|'interrupted'|'failed'):Promise<boolean>{
    const result=await this.db.query(`UPDATE connector_transport_attempt
      SET finish_status=$5,finish_attempted_at=now()
      WHERE project_id=$1 AND binding_id=$2 AND delivery_id=$3 AND route_version=$4
        AND finish_attempted_at IS NULL RETURNING delivery_id`,
      [projectId,bindingId,deliveryId,routeVersion,status]);
    return result.rowCount===1;
  }
  async listRecent(projectId:string,bindingId:string,limit:number):Promise<Array<{
    deliveryId:number;eventCount:number;unhandledCount:number;latestMessageState:string;
    decision:DeliveryDecision|null}>>{
    if(!Number.isSafeInteger(limit)||limit<1||limit>50)throw new RangeError('delivery page limit must be 1..50');
    const result=await this.db.query(`WITH event_rows AS (
      SELECT l.delivery_id,l.event_cursor,'message'::text AS source_kind,m.state AS outcome,NULL::text AS reason
      FROM connector_message_link l JOIN session_message m
        ON m.project_id=l.project_id AND m.message_id=l.message_id
      WHERE l.project_id=$1 AND l.binding_id=$2
      UNION ALL
      SELECT u.delivery_id,u.event_cursor,'unhandled'::text,NULL::text,u.reason
      FROM connector_unhandled_event u
      WHERE u.project_id=$1 AND u.binding_id=$2
      UNION ALL
      SELECT t.delivery_id,-1,'transport'::text,t.finish_status,NULL::text
      FROM connector_transport_attempt t
      WHERE t.project_id=$1 AND t.binding_id=$2
      UNION ALL
      SELECT c.delivery_id,-2,'claim'::text,
        CASE WHEN c.observed_at IS NULL THEN 'attempted' ELSE 'observed' END,NULL::text
      FROM connector_claim_attempt c
      WHERE c.project_id=$1 AND c.binding_id=$2
    )
    SELECT e.delivery_id,
      count(DISTINCT CASE WHEN e.source_kind IN ('message','unhandled')
        THEN concat_ws(':',e.source_kind,e.event_cursor) END)::integer AS event_count,
      count(DISTINCT CASE WHEN e.source_kind='unhandled' THEN e.event_cursor END)::integer AS unhandled_count,
      (array_agg(COALESCE(e.outcome,'unhandled:'||e.reason,'transport:'||e.source_kind)
        ORDER BY e.event_cursor DESC))[1] AS latest_message_state,
      to_jsonb(d) AS saved_decision
      FROM event_rows e
      LEFT JOIN connector_delivery_decision d
        ON d.project_id=$1 AND d.binding_id=$2 AND d.delivery_id=e.delivery_id
      GROUP BY e.delivery_id,d.project_id,d.binding_id,d.delivery_id ORDER BY e.delivery_id DESC LIMIT $3`,
      [projectId,bindingId,limit]);
    return result.rows.map(row=>({deliveryId:Number(row.delivery_id),eventCount:row.event_count,
      unhandledCount:row.unhandled_count,
      latestMessageState:row.latest_message_state,
      decision:row.saved_decision?of(row.saved_decision):null}));
  }
  async unhandled(projectId:string,bindingId:string,deliveryId:number):Promise<UnhandledDeliveryEvent[]>{
    const result=await this.db.query(`SELECT event_cursor,event_kind,direction,participant_id,reason,content_length,
      route_version,created_at FROM connector_unhandled_event
      WHERE project_id=$1 AND binding_id=$2 AND delivery_id=$3 ORDER BY event_cursor`,
      [projectId,bindingId,deliveryId]);
    return result.rows.map(row=>({eventCursor:Number(row.event_cursor),eventKind:String(row.event_kind),
      direction:String(row.direction),participantId:row.participant_id??null,
      reason:row.reason as UnhandledDeliveryEvent['reason'],
      contentLength:Number(row.content_length),routeVersion:Number(row.route_version),
      createdAt:new Date(row.created_at).toISOString()}));
  }
  async messages(projectId:string,bindingId:string,deliveryId:number):Promise<DeliveryMessage[]>{
    const result=await this.db.query(`SELECT l.event_cursor,l.message_id,m.state AS message_state,
      p.state AS processing_state,p.native_turn_id,p.response
      FROM connector_message_link l JOIN session_message m
        ON m.project_id=l.project_id AND m.message_id=l.message_id
      LEFT JOIN session_message_processing p
        ON p.project_id=l.project_id AND p.message_id=l.message_id
      WHERE l.project_id=$1 AND l.binding_id=$2 AND l.delivery_id=$3
      ORDER BY l.event_cursor`,[projectId,bindingId,deliveryId]);
    return result.rows.map(row=>({eventCursor:Number(row.event_cursor),messageId:row.message_id,
      messageState:row.message_state,processingState:row.processing_state,
      nativeTurnId:row.native_turn_id,response:row.response}));
  }
  async get(projectId:string,bindingId:string,deliveryId:number):Promise<DeliveryDecision|null>{
    const result=await this.db.query(`SELECT * FROM connector_delivery_decision
      WHERE project_id=$1 AND binding_id=$2 AND delivery_id=$3`,[projectId,bindingId,deliveryId]);
    return result.rows[0]?of(result.rows[0]):null;
  }
  async prepare(input:Omit<DeliveryDecision,'state'>):Promise<DeliveryDecision>{
    const result=await this.db.query(`INSERT INTO connector_delivery_decision
      (project_id,binding_id,delivery_id,route_version,route_owner,route_epoch,route_session_ref,
       conversation_id,cursor_start,cursor_end,decision,request_id,content)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
      ON CONFLICT DO NOTHING RETURNING *`,
      [input.projectId,input.bindingId,input.deliveryId,input.routeVersion,input.routeOwner,
        input.routeEpoch,input.routeSessionRef,input.conversationId,input.cursorStart,input.cursorEnd,
        input.decision,input.requestId,input.content]);
    const saved=result.rows[0]?of(result.rows[0]):await this.get(input.projectId,input.bindingId,input.deliveryId);
    if(!saved||saved.routeVersion!==input.routeVersion||saved.decision!==input.decision||
      saved.requestId!==input.requestId||saved.content!==input.content||
      saved.routeOwner!==input.routeOwner||saved.routeEpoch!==input.routeEpoch||
      saved.routeSessionRef!==input.routeSessionRef||saved.conversationId!==input.conversationId||
      saved.cursorStart!==input.cursorStart||saved.cursorEnd!==input.cursorEnd)
      throw new DomainError('CONNECTOR_DECISION_CONFLICT','Original delivery already has a different decision');
    return saved;
  }
  /** Persist an irreversible external attempt before invoking the gateway. */
  async markAttempted(input:DeliveryDecision):Promise<boolean>{
    const result=await this.db.query(`UPDATE connector_delivery_decision SET state='attempted',updated_at=now()
      WHERE project_id=$1 AND binding_id=$2 AND delivery_id=$3 AND state='prepared' AND decision='reply'
      RETURNING delivery_id`,[input.projectId,input.bindingId,input.deliveryId]);
    return result.rowCount===1;
  }
  async markObserved(input:DeliveryDecision):Promise<void>{
    await this.db.query(`UPDATE connector_delivery_decision SET state='observed',updated_at=now()
      WHERE project_id=$1 AND binding_id=$2 AND delivery_id=$3 AND state IN ('attempted','observed')`,
      [input.projectId,input.bindingId,input.deliveryId]);
  }
  async markCompleteUnknown(input:DeliveryDecision):Promise<void>{
    await this.db.query(`UPDATE connector_delivery_decision SET state='complete_unknown',updated_at=now()
      WHERE project_id=$1 AND binding_id=$2 AND delivery_id=$3 AND state<>'completed'`,
      [input.projectId,input.bindingId,input.deliveryId]);
  }
  /** Persist the irreversible inbox completion attempt before invoking the gateway. */
  async markCompleteAttempted(input:DeliveryDecision):Promise<boolean>{
    const result=await this.db.query(`UPDATE connector_delivery_decision SET state='complete_attempted',updated_at=now()
      WHERE project_id=$1 AND binding_id=$2 AND delivery_id=$3
        AND (state='observed' OR (decision<>'reply' AND state='prepared'))
      RETURNING delivery_id`,[input.projectId,input.bindingId,input.deliveryId]);
    return result.rowCount===1;
  }
  async markCompleted(input:DeliveryDecision,terminal:TerminalDeliveryObservation):Promise<boolean>{
    const result=await this.db.query(`UPDATE connector_delivery_decision SET state='completed',updated_at=now()
      WHERE project_id=$1 AND binding_id=$2 AND delivery_id=$3
        AND state IN ('complete_attempted','complete_unknown')
        AND route_owner=$4 AND route_epoch=$5 AND route_session_ref=$6 AND conversation_id=$7
        AND cursor_start=$8 AND cursor_end=$9`,
      [input.projectId,input.bindingId,input.deliveryId,terminal.owner,terminal.epoch,
        terminal.sessionRef,terminal.conversationId,terminal.cursorStart,terminal.cursorEnd]);
    return result.rowCount===1;
  }
}
