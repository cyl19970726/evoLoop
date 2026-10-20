import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { CollaborationBinding, IncomingChangeCandidate, ProjectionObservation } from "@evoloop/contracts/collaboration";
import type { DeliveryAttempt, DeliveryClaim, DeliveryRecord, DeliveryStore, IncomingDecision, IncomingRecord } from "@evoloop/contracts/delivery";

const iso = (value: Date | string | null): string | null => value === null ? null : new Date(value).toISOString();
const stableId = (value: string): string => { const h = createHash("sha256").update(value).digest("hex"); return `${h.slice(0,8)}-${h.slice(8,12)}-5${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`; };
const deliveryOf = (row: any): DeliveryRecord => ({ projectId: row.project_id, eventId: row.event_id, consumerId: row.consumer_id,
  operationId: row.operation_id, effectKey: row.effect_key, taskId: row.entity_id, taskVersion: row.version,
  state: row.state, fence: row.fence, leaseOwner: row.lease_owner, leaseUntilUtc: iso(row.lease_until_utc),
  nextRetryAtUtc: iso(row.next_retry_at_utc), lastReason: row.last_reason, updatedAtUtc: iso(row.updated_at_utc)! });
const bindingOf = (row: any): CollaborationBinding => ({ entityId: row.task_id, remoteRecordId: row.remote_record_id,
  localVersion: row.local_version, remoteOperationId: row.remote_operation_id, remoteVersion: row.remote_version,
  remoteModifiedTime: row.remote_modified_time, confirmedTitle: row.confirmed_title, confirmedStatus: row.confirmed_status });
const incomingOf = (row: any): IncomingRecord => ({ projectId: row.project_id, id: row.incoming_id, operationId: row.operation_id,
  entityId: row.task_id, remoteRecordId: row.remote_record_id, observedLocalVersion: row.observed_local_version,
  observedRemoteOperationId: row.observed_remote_operation_id, observedRemoteModifiedTime: row.observed_remote_modified_time,
  actor: row.actor_evidence, patch: row.patch, reviewOnly: row.review_only, reason: row.reason,
  state: row.state, sourceEventId: row.source_event_id, observedAtUtc: iso(row.observed_at_utc)!,
  reviewedBy: row.reviewed_by, reviewedAtUtc: iso(row.reviewed_at_utc) });

export class PgOutboxDeliveryStore implements DeliveryStore {
  constructor(private readonly pool: Pool) {}
  private async tx<T>(action: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect(); let open = false;
    try { await client.query("BEGIN"); open = true; const result = await action(client); await client.query("COMMIT"); open = false; return result; }
    catch (error) { if (open) try { await client.query("ROLLBACK"); } catch { /* retain primary error */ } throw error; }
    finally { client.release(); }
  }
  private async load(client: PoolClient, projectId: string, eventId: string, consumerId: string): Promise<DeliveryRecord | null> {
    const r = await client.query(`SELECT d.*,e.operation_id,e.effect_key,e.entity_id,e.version FROM outbox_delivery d
      JOIN outbox_event e ON e.project_id=d.project_id AND e.event_id=d.event_id
      WHERE d.project_id=$1 AND d.event_id=$2 AND d.consumer_id=$3`, [projectId,eventId,consumerId]);
    return r.rows[0] ? deliveryOf(r.rows[0]) : null;
  }
  private async attempt(client: PoolClient, d: DeliveryRecord, action: DeliveryAttempt["action"], outcome: DeliveryRecord["state"], reason: string, actorId: string, nowUtc: string, remoteRecordId: string | null = null): Promise<void> {
    await client.query(`INSERT INTO outbox_delivery_attempt(project_id,attempt_id,event_id,consumer_id,fence,action,outcome,reason,remote_record_id,actor_id,created_at_utc)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [d.projectId,randomUUID(),d.eventId,d.consumerId,d.fence,action,outcome,reason,remoteRecordId,actorId,nowUtc]);
  }
  private async materialize(client: PoolClient, projectId: string, consumerId: string, nowUtc: string): Promise<void> {
    await client.query(`INSERT INTO outbox_delivery(project_id,event_id,consumer_id,state,updated_at_utc)
      SELECT e.project_id,e.event_id,$2,'pending',$3 FROM outbox_event e
      JOIN task t ON t.project_id=e.project_id AND t.task_id=e.entity_id
      WHERE e.project_id=$1 AND e.version<=t.version
        AND (e.kind='task' OR e.kind LIKE 'task.%' OR e.kind IN ('delivery.record','observation.record','schedule.task.proposed','schedule.task.todo'))
      ON CONFLICT DO NOTHING`, [projectId,consumerId,nowUtc]);
  }
  async claimNext(projectId: string, consumerId: string, leaseOwner: string, nowUtc: string, leaseMs: number): Promise<DeliveryClaim | null> {
    if (!leaseOwner || !Number.isSafeInteger(leaseMs) || leaseMs < 1000 || leaseMs > 300000) throw new RangeError("invalid delivery lease");
    return this.tx(async client => {
      await this.materialize(client, projectId, consumerId, nowUtc);
      const token = randomUUID();
      const r = await client.query(`WITH chosen AS (
        SELECT d.project_id,d.event_id,d.consumer_id FROM outbox_delivery d
        JOIN outbox_event e ON e.project_id=d.project_id AND e.event_id=d.event_id
        WHERE d.project_id=$1 AND d.consumer_id=$2 AND d.state='pending'
          AND (d.next_retry_at_utc IS NULL OR d.next_retry_at_utc<=$3)
        ORDER BY e.created_at,e.event_id FOR UPDATE OF d SKIP LOCKED LIMIT 1
      ) UPDATE outbox_delivery d SET state='claimed',fence=d.fence+1,claim_token=$4,lease_owner=$5,
        lease_until_utc=$3::timestamptz+($6::int*interval '1 millisecond'),updated_at_utc=$3
        FROM chosen c WHERE d.project_id=c.project_id AND d.event_id=c.event_id AND d.consumer_id=c.consumer_id RETURNING d.event_id`,
      [projectId,consumerId,nowUtc,token,leaseOwner,leaseMs]);
      if (!r.rows[0]) return null;
      const delivery = await this.load(client,projectId,r.rows[0].event_id,consumerId);
      return delivery ? { delivery, token } : null;
    });
  }
  async beginDispatch(claim: DeliveryClaim, actorId: string, nowUtc: string): Promise<boolean> {
    return this.tx(async client => {
      const d = claim.delivery;
      const r = await client.query(`UPDATE outbox_delivery SET state='dispatching',updated_at_utc=$6
        WHERE project_id=$1 AND event_id=$2 AND consumer_id=$3 AND claim_token=$4 AND fence=$5 AND state='claimed' AND lease_until_utc>$6`,
        [d.projectId,d.eventId,d.consumerId,claim.token,d.fence,nowUtc]);
      if (r.rowCount !== 1) return false;
      await this.attempt(client,d,"dispatch","dispatching","external request about to start",actorId,nowUtc);
      return true;
    });
  }
  async finish(claim: DeliveryClaim, observation: ProjectionObservation, actorId: string, nowUtc: string, action: "dispatch" | "reconcile"): Promise<DeliveryRecord | null> {
    return this.tx(async client => {
      const d = claim.delivery;
      const locked = await client.query(`SELECT state FROM outbox_delivery WHERE project_id=$1 AND event_id=$2 AND consumer_id=$3 AND claim_token=$4 AND fence=$5 AND lease_until_utc>$6 FOR UPDATE`,
        [d.projectId,d.eventId,d.consumerId,claim.token,d.fence,nowUtc]);
      if (!locked.rows[0] || locked.rows[0].state !== "dispatching") return null;
      let state: DeliveryRecord["state"] = observation.state === "confirmed" ? "applied" : observation.state === "rate-limited" ? "failed" : observation.state;
      let reason = observation.state === "confirmed" ? "remote readback matched stable task key and version" : observation.state === "rate-limited" ? "remote rate limit" : observation.reason;
      const remoteRecordId = observation.state === "confirmed" ? observation.binding.remoteRecordId : observation.state === "conflict" ? observation.remoteRecordId ?? null : null;
      if (observation.state === "confirmed") {
        const binding = await client.query(`SELECT * FROM collaboration_binding WHERE project_id=$1 AND consumer_id=$2 AND task_id=$3 FOR UPDATE`, [d.projectId,d.consumerId,d.taskId]);
        const old = binding.rows[0];
        if (old && (old.remote_record_id !== observation.binding.remoteRecordId || old.local_version > observation.binding.localVersion)) {
          state = "conflict"; reason = "remote binding identity or local version regressed";
        } else {
          const b = observation.binding;
          await client.query(`INSERT INTO collaboration_binding(project_id,consumer_id,task_id,remote_record_id,local_version,remote_operation_id,remote_version,remote_modified_time,confirmed_title,confirmed_status,updated_at_utc)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
            ON CONFLICT(project_id,consumer_id,task_id) DO UPDATE SET remote_record_id=EXCLUDED.remote_record_id,local_version=EXCLUDED.local_version,
            remote_operation_id=EXCLUDED.remote_operation_id,remote_version=EXCLUDED.remote_version,remote_modified_time=EXCLUDED.remote_modified_time,
            confirmed_title=EXCLUDED.confirmed_title,confirmed_status=EXCLUDED.confirmed_status,updated_at_utc=EXCLUDED.updated_at_utc`,
            [d.projectId,d.consumerId,d.taskId,b.remoteRecordId,b.localVersion,b.remoteOperationId,b.remoteVersion,b.remoteModifiedTime,b.confirmedTitle,b.confirmedStatus,nowUtc]);
        }
      }
      const retryAt = observation.state === "rate-limited" && observation.retryAfterSeconds !== null ? new Date(Date.parse(nowUtc)+Math.min(86400,observation.retryAfterSeconds)*1000).toISOString() : null;
      await client.query(`UPDATE outbox_delivery SET state=$4,claim_token=NULL,lease_owner=NULL,lease_until_utc=NULL,
        next_retry_at_utc=$5,last_reason=$6,updated_at_utc=$7 WHERE project_id=$1 AND event_id=$2 AND consumer_id=$3`,
        [d.projectId,d.eventId,d.consumerId,state,retryAt,reason,nowUtc]);
      await this.attempt(client,d,action,state,reason,actorId,nowUtc,remoteRecordId);
      return this.load(client,d.projectId,d.eventId,d.consumerId);
    });
  }
  async recoverInterrupted(projectId: string, consumerId: string, nowUtc: string): Promise<number> {
    return this.tx(async client => {
      const r = await client.query(`UPDATE outbox_delivery SET state=CASE WHEN state='claimed' THEN 'pending' ELSE 'unknown' END,
        claim_token=NULL,lease_owner=NULL,lease_until_utc=NULL,last_reason='lease expired; external effect requires readback',updated_at_utc=$3
        WHERE project_id=$1 AND consumer_id=$2 AND state IN ('claimed','dispatching') AND lease_until_utc<=$3 RETURNING event_id,fence,state`, [projectId,consumerId,nowUtc]);
      for (const row of r.rows) {
        const d = await this.load(client,projectId,row.event_id,consumerId);
        if (d) await this.attempt(client,d,"recover",row.state,"lease expired; dispatching effect unknown", "coordinator", nowUtc);
      }
      return r.rowCount ?? 0;
    });
  }
  async claimUnknown(projectId: string, eventId: string, consumerId: string, leaseOwner: string, nowUtc: string, leaseMs: number): Promise<DeliveryClaim | null> {
    return this.tx(async client => {
      const token = randomUUID();
      const r = await client.query(`UPDATE outbox_delivery SET state='claimed',fence=fence+1,claim_token=$4,lease_owner=$5,
        lease_until_utc=$6::timestamptz+($7::int*interval '1 millisecond'),updated_at_utc=$6
        WHERE project_id=$1 AND event_id=$2 AND consumer_id=$3 AND state='unknown' RETURNING event_id`, [projectId,eventId,consumerId,token,leaseOwner,nowUtc,leaseMs]);
      if (!r.rows[0]) return null;
      const delivery = await this.load(client,projectId,eventId,consumerId);
      return delivery ? { delivery, token } : null;
    });
  }
  async requestRetry(projectId: string, eventId: string, consumerId: string, actorId: string, reason: string, nowUtc: string): Promise<boolean> {
    return this.tx(async client => {
      const r = await client.query(`UPDATE outbox_delivery SET state='pending',next_retry_at_utc=NULL,last_reason=$5,updated_at_utc=$6
        WHERE project_id=$1 AND event_id=$2 AND consumer_id=$3 AND state='failed' AND ($4::text<>'' ) RETURNING event_id`, [projectId,eventId,consumerId,actorId,reason,nowUtc]);
      if (!r.rows[0]) return false;
      const d = await this.load(client,projectId,eventId,consumerId);
      if (d) await this.attempt(client,d,"retry","pending",reason,actorId,nowUtc);
      return true;
    });
  }
  async get(projectId: string, eventId: string, consumerId: string): Promise<DeliveryRecord | null> {
    const client = await this.pool.connect(); try { return await this.load(client,projectId,eventId,consumerId); } finally { client.release(); }
  }
  async list(projectId: string, consumerId: string, limit = 50, afterEventId?: string): Promise<{ items: DeliveryRecord[]; nextCursor: string | null }> {
    if (!Number.isInteger(limit) || limit<1 || limit>100) throw new RangeError("delivery page limit 1..100");
    const client = await this.pool.connect();
    try {
      const r = await client.query(`SELECT d.*,e.operation_id,e.effect_key,e.entity_id,e.version FROM outbox_delivery d JOIN outbox_event e ON e.project_id=d.project_id AND e.event_id=d.event_id
        WHERE d.project_id=$1 AND d.consumer_id=$2 AND ($3::uuid IS NULL OR d.event_id>$3::uuid) ORDER BY d.event_id LIMIT $4`, [projectId,consumerId,afterEventId??null,limit+1]);
      return { items: r.rows.slice(0,limit).map(deliveryOf), nextCursor: r.rows.length>limit ? r.rows[limit-1]!.event_id : null };
    } finally { client.release(); }
  }
  async attempts(projectId: string, eventId: string, consumerId: string): Promise<DeliveryAttempt[]> {
    const r = await this.pool.query(`SELECT * FROM outbox_delivery_attempt WHERE project_id=$1 AND event_id=$2 AND consumer_id=$3 ORDER BY created_at_utc,attempt_id LIMIT 1001`, [projectId,eventId,consumerId]);
    if (r.rows.length>1000) throw new RangeError("delivery attempt history exceeds limit");
    return r.rows.map(row => ({ projectId: row.project_id, id: row.attempt_id, eventId: row.event_id, consumerId: row.consumer_id, fence: row.fence, action: row.action, outcome: row.outcome, reason: row.reason, remoteRecordId: row.remote_record_id, actorId: row.actor_id, createdAtUtc: iso(row.created_at_utc)! }));
  }
  async getBinding(projectId: string, taskId: string, consumerId: string): Promise<CollaborationBinding | null> {
    const r = await this.pool.query("SELECT * FROM collaboration_binding WHERE project_id=$1 AND consumer_id=$2 AND task_id=$3", [projectId,consumerId,taskId]);
    return r.rows[0] ? bindingOf(r.rows[0]) : null;
  }
  async listBindings(projectId: string, consumerId: string, limit = 100, afterTaskId?: string): Promise<{ items: CollaborationBinding[]; nextCursor: string | null }> {
    if (!Number.isInteger(limit) || limit<1 || limit>100) throw new RangeError("binding page limit 1..100");
    const r = await this.pool.query(`SELECT * FROM collaboration_binding WHERE project_id=$1 AND consumer_id=$2 AND ($3::uuid IS NULL OR task_id>$3::uuid)
      ORDER BY task_id LIMIT $4`, [projectId,consumerId,afterTaskId??null,limit+1]);
    return { items:r.rows.slice(0,limit).map(bindingOf), nextCursor:r.rows.length>limit?r.rows[limit-1]!.task_id:null };
  }
  async recordIncoming(projectId: string, consumerId: string, candidate: IncomingChangeCandidate, sourceEventId: string, observedAtUtc: string): Promise<IncomingRecord> {
    if (!sourceEventId || !candidate.entityId) throw new RangeError("incoming identity required");
    return this.tx(async client => {
      const operationId = stableId(`incoming:${projectId}:${consumerId}:${sourceEventId}`);
      const incomingId = randomUUID();
      const fields = candidate.patch;
      if (Object.keys(fields).some(key => key!=="title" && key!=="status")) throw new RangeError("incoming patch field not allowed");
      const state = candidate.reviewOnly ? "review-only" : "pending";
      await client.query(`INSERT INTO collaboration_incoming(project_id,incoming_id,consumer_id,task_id,remote_record_id,observed_local_version,observed_remote_operation_id,
        observed_remote_modified_time,actor_evidence,patch,review_only,reason,source_event_id,operation_id,state,observed_at_utc)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11,$12,$13,$14,$15,$16)
        ON CONFLICT(project_id,consumer_id,source_event_id) DO NOTHING`,
        [projectId,incomingId,consumerId,candidate.entityId,candidate.remoteRecordId,candidate.observedLocalVersion,candidate.observedRemoteOperationId,
          candidate.observedRemoteModifiedTime,candidate.actor?JSON.stringify(candidate.actor):null,JSON.stringify(fields),candidate.reviewOnly,candidate.reason,sourceEventId,operationId,state,observedAtUtc]);
      const r = await client.query("SELECT * FROM collaboration_incoming WHERE project_id=$1 AND consumer_id=$2 AND source_event_id=$3", [projectId,consumerId,sourceEventId]);
      return incomingOf(r.rows[0]);
    });
  }
  async listIncoming(projectId: string, consumerId: string, limit = 50, afterId?: string): Promise<{ items: IncomingRecord[]; nextCursor: string | null }> {
    if (!Number.isInteger(limit) || limit<1 || limit>100) throw new RangeError("incoming page limit 1..100");
    const r = await this.pool.query(`SELECT * FROM collaboration_incoming WHERE project_id=$1 AND consumer_id=$2 AND ($3::uuid IS NULL OR incoming_id>$3::uuid)
      ORDER BY incoming_id LIMIT $4`, [projectId,consumerId,afterId??null,limit+1]);
    return { items:r.rows.slice(0,limit).map(incomingOf), nextCursor:r.rows.length>limit?r.rows[limit-1]!.incoming_id:null };
  }
  async getIncoming(projectId: string, incomingId: string, consumerId: string): Promise<IncomingRecord | null> {
    const r = await this.pool.query("SELECT * FROM collaboration_incoming WHERE project_id=$1 AND incoming_id=$2 AND consumer_id=$3", [projectId,incomingId,consumerId]);
    return r.rows[0]?incomingOf(r.rows[0]):null;
  }
  async decideIncoming(value: IncomingDecision, consumerId: string): Promise<boolean> {
    return this.tx(async client => {
      const r = await client.query(`UPDATE collaboration_incoming SET state=$4,reviewed_by=$5,reviewed_at_utc=$6
        WHERE project_id=$1 AND incoming_id=$2 AND consumer_id=$3 AND state IN ('pending','review-only','unknown') AND operation_id=$7 RETURNING incoming_id`,
        [value.projectId,value.id,consumerId,value.state,value.actorId,value.createdAtUtc,value.operationId]);
      if (!r.rows[0]) return false;
      await client.query(`INSERT INTO collaboration_incoming_decision(project_id,decision_id,incoming_id,consumer_id,operation_id,state,actor_id,reason,created_at_utc)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [value.projectId,randomUUID(),value.id,consumerId,value.operationId,value.state,value.actorId,value.reason,value.createdAtUtc]);
      return true;
    });
  }
}
