import type { Pool } from 'pg';
import { DomainError } from '@evoloop/contracts/ports';

export type DeliveryMessage = {
  eventCursor:number; messageId:string; messageState:string; processingState:string|null;
  nativeTurnId:string|null; response:string|null;
};
export type DeliveryDecision = {
  projectId:string; bindingId:string; deliveryId:number; routeVersion:number;
  decision:'reply'|'draft'|'skip'|'defer'; requestId:string|null; content:string|null;
  state:'prepared'|'attempted'|'observed'|'complete_unknown'|'completed';
};
export type TransportAttempt={routeVersion:number;recordTurnId:string|null;
  finishStatus:'completed'|'interrupted'|'failed'|null};
const of=(row:Record<string,unknown>):DeliveryDecision=>({
  projectId:String(row.project_id),bindingId:String(row.binding_id),deliveryId:Number(row.delivery_id),
  routeVersion:Number(row.route_version),decision:row.decision as DeliveryDecision['decision'],
  requestId:row.request_id as string|null,content:row.content as string|null,
  state:row.state as DeliveryDecision['state'],
});

/** Durable original intent, separate from the immutable event to message links. */
export class PgConnectorDeliveryDecisions {
  constructor(private readonly db:Pool){}
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
    deliveryId:number;eventCount:number;latestMessageState:string;decision:DeliveryDecision|null}>>{
    if(!Number.isSafeInteger(limit)||limit<1||limit>50)throw new RangeError('delivery page limit must be 1..50');
    const result=await this.db.query(`SELECT l.delivery_id,count(*)::integer AS event_count,
      (array_agg(m.state ORDER BY l.event_cursor DESC))[1] AS latest_message_state,
      to_jsonb(d) AS saved_decision
      FROM connector_message_link l JOIN session_message m
        ON m.project_id=l.project_id AND m.message_id=l.message_id
      LEFT JOIN connector_delivery_decision d
        ON d.project_id=l.project_id AND d.binding_id=l.binding_id AND d.delivery_id=l.delivery_id
      WHERE l.project_id=$1 AND l.binding_id=$2
      GROUP BY l.delivery_id,d.project_id,d.binding_id,d.delivery_id ORDER BY l.delivery_id DESC LIMIT $3`,
      [projectId,bindingId,limit]);
    return result.rows.map(row=>({deliveryId:Number(row.delivery_id),eventCount:row.event_count,
      latestMessageState:row.latest_message_state,
      decision:row.saved_decision?of(row.saved_decision):null}));
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
      (project_id,binding_id,delivery_id,route_version,decision,request_id,content)
      VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING RETURNING *`,
      [input.projectId,input.bindingId,input.deliveryId,input.routeVersion,input.decision,input.requestId,input.content]);
    const saved=result.rows[0]?of(result.rows[0]):await this.get(input.projectId,input.bindingId,input.deliveryId);
    if(!saved||saved.routeVersion!==input.routeVersion||saved.decision!==input.decision||
      saved.requestId!==input.requestId||saved.content!==input.content)
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
  async markCompleted(input:DeliveryDecision):Promise<void>{
    await this.db.query(`UPDATE connector_delivery_decision SET state='completed',updated_at=now()
      WHERE project_id=$1 AND binding_id=$2 AND delivery_id=$3`,
      [input.projectId,input.bindingId,input.deliveryId]);
  }
}
