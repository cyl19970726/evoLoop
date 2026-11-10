import { createHash } from "node:crypto";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import { DomainError } from "@evoloop/contracts/ports";
import { canonicalJson } from "@evoloop/core";
import { connectorRouteSchema, connectorCapabilitiesSchema, connectorRouteRecordSchema,
  connectorMessageAdmissionSchema, connectorTrustedAdmissionSchema, connectorSourceKey,
  connectorUnhandledEventSchema,
  versionedConnectorRouteSchema,
  type ConnectorMessageAdmission, type ConnectorMessageLink, type ConnectorSource,
  type ConnectorTrustedAdmission, type ConnectorUnhandledEvent,
  type ConnectorRoute, type ConnectorRoutePage, type ConnectorRouteRecord,
  type VersionedConnectorRoute } from "@evoloop/contracts/message-connectors";

type Row = QueryResultRow;
export type ConnectorRouteOperation = {
  projectId: string; id: string; actorId: string; requestHash: string;
  kind: "create" | "update"; bindingId: string; result: ConnectorRouteRecord; createdAt: string;
};
const iso = (value: Date | string): string => value instanceof Date ? value.toISOString() : value;
const key = (value: ConnectorRoute) => [value.source.provider, value.source.connectionId,
  value.source.conversationId, value.targetSessionId];
const routeOf = (r: Row): ConnectorRouteRecord => ({
  projectId: r.project_id, bindingId: r.binding_id,
  source: { provider: r.provider, connectionId: r.connection_id, conversationId: r.conversation_id },
  conversationLabel: r.conversation_label, conversationKind: r.conversation_kind,
  targetSessionId: r.target_session_id,
  targetThreadId: r.target_thread_id, targetActorId: r.target_actor_id,
  senderActorId: r.sender_actor_id, owner: r.owner, epoch: r.epoch,
  sessionRef: r.session_ref, state: r.state, mode: r.mode, readScope: r.read_scope,
  sendTargets: r.send_targets, senderIds: r.sender_ids, internalTargets: r.internal_targets,
  capabilities: connectorCapabilitiesSchema.parse(r.capabilities), policyHash: r.policy_hash,
  version: r.version, createdAt: iso(r.created_at), updatedAt: iso(r.updated_at),
});
const operationOf = (r: Row): ConnectorRouteOperation => ({
  projectId: r.project_id, id: r.operation_id, actorId: r.actor_id,
  requestHash: r.request_hash, kind: r.kind, bindingId: r.binding_id,
  result: connectorRouteRecordSchema.parse({ mode: "restricted", sendTargets: [], internalTargets: [],
    ...r.result }), createdAt: iso(r.created_at),
});
function definiteRefusal(error: unknown): never {
  if (error && typeof error === "object" && "code" in error) {
    if (error.code === "23505")
      throw new DomainError("CONNECTOR_ROUTE_CONFLICT", "Route binding, source, or receiver Session is already reserved");
    if (error.code === "23503")
      throw new DomainError("CONNECTOR_ROUTE_REFERENCE", "Project or exact owned Session does not exist");
    if (error.code === "23514")
      throw new DomainError("CONNECTOR_ROUTE_REFUSED", "Route identity, policy, or Session constraint refused the write");
  }
  throw error;
}
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const actorKey = /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,127}$/;
function requestHash(kind: "create" | "update", route: VersionedConnectorRoute | ConnectorRoute,
  expectedVersion?: number): string {
  const { createdAt: _createdAt, updatedAt: _updatedAt, ...intent } = route as ConnectorRouteRecord;
  return createHash("sha256").update(canonicalJson({ kind, route: intent,
    ...(expectedVersion === undefined ? {} : { expectedVersion }) })).digest("hex");
}

/** Route persistence with reviewed versioned policy changes. */
export class PgConnectorRoutes {
  constructor(private readonly db: Pool) {}

  private async write(kind: "create" | "update", route: ConnectorRoute | VersionedConnectorRoute,
    expectedVersion: number | undefined, operationId: string, actorId: string,
    apply: (client: PoolClient) => Promise<ConnectorRouteRecord>): Promise<ConnectorRouteRecord> {
    if (!uuid.test(operationId) || !actorKey.test(actorId))
      throw new DomainError("CONNECTOR_OPERATION_INVALID", "Operation ID or actor ID is invalid");
    const hash = requestHash(kind,route,expectedVersion);
    const client = await this.db.connect();
    try {
      await client.query("BEGIN");
      // Project lock first, as core writes do: the route guard then shares the target Session row.
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[route.projectId]);
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 55198))",
        [`${route.projectId}:${operationId}`]);
      const prior = await client.query(`SELECT * FROM connector_route_operation
        WHERE project_id=$1 AND operation_id=$2 FOR UPDATE`,[route.projectId,operationId]);
      if (prior.rows[0]) {
        const saved = operationOf(prior.rows[0]);
        if (saved.actorId !== actorId || saved.requestHash !== hash || saved.kind !== kind ||
          saved.bindingId !== route.bindingId)
          throw new DomainError("CONNECTOR_OPERATION_CONFLICT", "Operation ID already has a different intent");
        await client.query("COMMIT");
        return saved.result;
      }
      const result = await apply(client);
      await client.query(`INSERT INTO connector_route_operation(project_id,operation_id,actor_id,request_hash,
        kind,binding_id,result) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)`,
        [route.projectId,operationId,actorId,hash,kind,route.bindingId,JSON.stringify(result)]);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch { /* Preserve the original write or commit outcome. */ }
      return definiteRefusal(error);
    } finally { client.release(); }
  }

  async create(input: ConnectorRoute, operationId: string, actorId: string): Promise<ConnectorRouteRecord> {
    const route = connectorRouteSchema.parse(input);
    return this.write("create",route,undefined,operationId,actorId,async client => {
      if (route.state !== "disabled")
        throw new DomainError("CONNECTOR_ROUTE_DISABLED_REQUIRED", "New routes start disabled");
      if (route.targetActorId === route.senderActorId)
        throw new DomainError("CONNECTOR_ACTOR_COLLISION", "Sender and receiver actors must differ");
      const result = await client.query(`INSERT INTO connector_route(project_id,binding_id,provider,connection_id,
        conversation_id,conversation_label,conversation_kind,target_session_id,target_thread_id,
        target_actor_id,sender_actor_id,owner,epoch,session_ref,read_scope,state,capabilities,
        policy_hash,version,mode,send_targets,sender_ids,internal_targets)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'disabled',$16,$17,1,$18,$19,$20,$21)
        RETURNING *`, [route.projectId,route.bindingId,route.source.provider,route.source.connectionId,
        route.source.conversationId,route.conversationLabel,route.conversationKind,route.targetSessionId,
        route.targetThreadId,route.targetActorId,route.senderActorId,route.owner,route.epoch,
        route.sessionRef,route.readScope,route.capabilities,route.policyHash,route.mode,
        route.sendTargets,route.senderIds,route.internalTargets]);
      return routeOf(result.rows[0]!);
    });
  }

  async operation(projectId: string, operationId: string): Promise<ConnectorRouteOperation | null> {
    const result = await this.db.query(`SELECT * FROM connector_route_operation
      WHERE project_id=$1 AND operation_id=$2`,[projectId,operationId]);
    return result.rows[0] ? operationOf(result.rows[0]) : null;
  }

  async get(projectId: string, bindingId: string): Promise<ConnectorRouteRecord | null> {
    const result = await this.db.query(`SELECT * FROM connector_route WHERE project_id=$1 AND binding_id=$2`,
      [projectId,bindingId]);
    return result.rows[0] ? routeOf(result.rows[0]) : null;
  }

  async list(projectId: string, limit: number, cursor?: string): Promise<ConnectorRoutePage> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new RangeError("page limit must be 1..100");
    const result = await this.db.query(`SELECT * FROM connector_route WHERE project_id=$1
      AND ($2::uuid IS NULL OR binding_id>$2::uuid) ORDER BY binding_id LIMIT $3`,
      [projectId,cursor ?? null,limit+1]);
    const items = result.rows.slice(0,limit).map(routeOf);
    return { items, nextCursor: result.rows.length > limit ? items[items.length-1]!.bindingId : null };
  }

  async update(input: VersionedConnectorRoute | ConnectorRouteRecord, expectedVersion: number,
    operationId: string, actorId: string): Promise<ConnectorRouteRecord> {
    const route = "createdAt" in input || "updatedAt" in input
      ? connectorRouteRecordSchema.parse(input) : versionedConnectorRouteSchema.parse(input);
    return this.write("update",route,expectedVersion,operationId,actorId,async client => {
      if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1 || route.version !== expectedVersion+1)
        throw new DomainError("VERSION_CONFLICT", "Route version must advance by one");
      if (route.targetActorId === route.senderActorId)
        throw new DomainError("CONNECTOR_ACTOR_COLLISION", "Sender and receiver actors must differ");
      const currentResult = await client.query(`SELECT * FROM connector_route
        WHERE project_id=$1 AND binding_id=$2 FOR UPDATE`,[route.projectId,route.bindingId]);
      const current = currentResult.rows[0] ? routeOf(currentResult.rows[0]) : null;
      if (!current || current.version !== expectedVersion)
        throw new DomainError("VERSION_CONFLICT", "Route version changed");
      if (JSON.stringify(key(current)) !== JSON.stringify(key(route)) ||
        current.conversationKind !== route.conversationKind ||
        current.targetActorId !== route.targetActorId || current.senderActorId !== route.senderActorId)
        throw new DomainError("CONNECTOR_ROUTE_IDENTITY", "Source and receiver Session are immutable");
      if (route.mode !== current.mode)
        throw new DomainError("CONNECTOR_ROUTE_IDENTITY", "Route mode is immutable");
      const targetsChanged = JSON.stringify(route.sendTargets) !== JSON.stringify(current.sendTargets) ||
        JSON.stringify(route.senderIds) !== JSON.stringify(current.senderIds) ||
        JSON.stringify(route.internalTargets) !== JSON.stringify(current.internalTargets);
      if (targetsChanged && (current.state !== "disabled" || route.state !== "disabled" ||
        route.policyHash === current.policyHash))
        throw new DomainError("CONNECTOR_ROUTE_POLICY", "Target changes require a disabled route and new reviewed policy hash");
      if (route.state !== "disabled") await this.preflightActivation(client,route);
      const result = await client.query(`UPDATE connector_route SET conversation_label=$4,
        target_thread_id=$5,target_actor_id=$6,sender_actor_id=$7,owner=$8,epoch=$9,session_ref=$10,
        read_scope=$11,state=$12,capabilities=$13,policy_hash=$14,version=$15,
        send_targets=$16,sender_ids=$17,internal_targets=$18,updated_at=now()
        WHERE project_id=$1 AND binding_id=$2 AND version=$3 RETURNING *`,
        [route.projectId,route.bindingId,expectedVersion,route.conversationLabel,route.targetThreadId,
          route.targetActorId,route.senderActorId,route.owner,route.epoch,route.sessionRef,
          route.readScope,route.state,route.capabilities,route.policyHash,route.version,
          route.sendTargets,route.senderIds,route.internalTargets]);
      if (!result.rows[0]) throw new DomainError("VERSION_CONFLICT", "Route version changed");
      return routeOf(result.rows[0]);
    });
  }

  private async preflightActivation(client: PoolClient, route: VersionedConnectorRoute): Promise<void> {
    const result = await client.query(`SELECT s.state,s.actor_id,s.native_thread_id,s.native_session_id,
      s.sandbox,s.approval_policy,s.authorization_scope,p.activation_state,p.revision_id,p.active_revision_id,
      r.sandbox AS profile_sandbox,r.approval_policy AS profile_approval,r.authorization_scope AS profile_scope
      FROM runtime_session s LEFT JOIN session_execution_profile p
        ON p.project_id=s.project_id AND p.session_id=s.session_id
      LEFT JOIN session_execution_profile_revision r ON r.project_id=p.project_id
        AND r.session_id=p.session_id AND r.revision_id=p.revision_id
      WHERE s.project_id=$1 AND s.session_id=$2 FOR SHARE OF s`, [route.projectId,route.targetSessionId]);
    const receiver = result.rows[0];
    if (route.mode === "standard") {
      if (!receiver || receiver.state !== "ready" ||
        !receiver.native_thread_id || !receiver.native_session_id ||
        receiver.native_thread_id !== route.targetThreadId ||
        receiver.sandbox !== "danger-full-access" || receiver.approval_policy !== "never" ||
        !receiver.authorization_scope ||
        receiver.activation_state !== "active" || receiver.revision_id !== receiver.active_revision_id ||
        receiver.profile_sandbox !== receiver.sandbox || receiver.profile_approval !== receiver.approval_policy ||
        receiver.profile_scope !== receiver.authorization_scope)
        throw new DomainError("CONNECTOR_RECEIVER_NOT_STANDARD", "Exact owned Session lacks an active standard profile");
      return;
    }
    if (!receiver || receiver.state !== "ready" || !receiver.native_thread_id || !receiver.native_session_id ||
      receiver.native_thread_id !== route.targetThreadId ||
      receiver.activation_state !== "active" || receiver.revision_id !== receiver.active_revision_id ||
      receiver.actor_id !== route.targetActorId || receiver.sandbox !== "read-only" ||
      receiver.approval_policy !== "never" ||
      receiver.authorization_scope !== `connector-receiver:${route.bindingId}` ||
      receiver.profile_sandbox !== receiver.sandbox || receiver.profile_approval !== receiver.approval_policy ||
      receiver.profile_scope !== receiver.authorization_scope)
      throw new DomainError("CONNECTOR_RECEIVER_NOT_RESTRICTED", "Exact owned Session lacks an active restricted profile");
    // Database configuration alone cannot prove gateway tool/credential isolation,
    // native Thread configuration, or recovery of earlier unknown Turns.
    throw new DomainError("CONNECTOR_RECEIVER_UNPROVEN", "Restricted receiver proof is not persisted");
  }
}

const linkQuery = `SELECT l.*,m.state AS message_state,
  p.processing_id,p.operation_id AS processing_operation_id,
  p.state AS processing_state,p.native_turn_id
  FROM connector_message_link l
  JOIN session_message m ON m.project_id=l.project_id AND m.message_id=l.message_id
  LEFT JOIN session_message_processing p ON p.project_id=l.project_id AND p.message_id=l.message_id`;
const linkOf = (r: Row): ConnectorMessageLink => ({
  projectId:r.project_id,bindingId:r.binding_id,routeVersion:r.route_version,
  routeOwner:r.route_owner,routeEpoch:r.route_epoch,routeSessionRef:r.route_session_ref,
  routePolicyHash:r.route_policy_hash,
  source:{source:{provider:r.provider,connectionId:r.connection_id,conversationId:r.conversation_id},
    deliveryId:Number(r.delivery_id),cursorStart:Number(r.cursor_start),cursorEnd:Number(r.cursor_end),
    eventCursor:Number(r.event_cursor),participantId:r.participant_id,
    replyToEventCursor:r.reply_to_event_cursor===null?null:Number(r.reply_to_event_cursor)},
  messageId:r.message_id,messageOperationId:r.message_operation_id,decisionId:r.decision_id,
  decision:r.decision,createdAt:iso(r.created_at),messageState:r.message_state,
  processingId:r.processing_id??null,processingOperationId:r.processing_operation_id??null,
  processingState:r.processing_state??null,nativeTurnId:r.native_turn_id??null,
});
const fixedLink = (link: ConnectorMessageLink): ConnectorMessageAdmission => ({
  projectId:link.projectId,bindingId:link.bindingId,routeVersion:link.routeVersion,
  source:link.source,messageId:link.messageId,
  messageOperationId:link.messageOperationId,decisionId:link.decisionId,
});
const fixedLinkFromTrusted = (intent: ConnectorTrustedAdmission): ConnectorMessageAdmission => ({
  projectId:intent.projectId,bindingId:intent.bindingId,routeVersion:intent.routeVersion,
  source:intent.source,messageId:intent.messageId,
  messageOperationId:intent.messageOperationId,decisionId:intent.decisionId,
});

/** Narrow, trusted ingress into the existing platform message queue. */
export class PgConnectorMessageLinks {
  constructor(private readonly db: Pool) {}

  private async recordAdmission(client: PoolClient, input: ConnectorMessageAdmission): Promise<ConnectorMessageLink> {
    const admission = connectorMessageAdmissionSchema.parse(input);
    const sourceKey = connectorSourceKey(admission.source);
    const s = admission.source;
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 55199))",[sourceKey]);
    const prior = await client.query(`${linkQuery} WHERE l.provider=$1 AND l.connection_id=$2
      AND l.conversation_id=$3 AND l.delivery_id=$4 AND l.event_cursor=$5`,
      [s.source.provider,s.source.connectionId,s.source.conversationId,s.deliveryId,s.eventCursor]);
    if (prior.rows[0]) {
      const saved = linkOf(prior.rows[0]);
      if (canonicalJson(fixedLink(saved)) !== canonicalJson(admission))
        throw new DomainError("CONNECTOR_SOURCE_CONFLICT", "Channel event already has a different admission");
      return saved;
    }
    const route = await client.query(`SELECT owner,epoch,session_ref,policy_hash FROM connector_route
      WHERE project_id=$1 AND binding_id=$2 FOR SHARE`,[admission.projectId,admission.bindingId]);
    if (!route.rows[0]) throw new DomainError("CONNECTOR_ADMISSION_REFUSED", "Exact route does not exist");
    try {
      const inserted = await client.query(`INSERT INTO connector_message_link(project_id,binding_id,route_version,
        route_owner,route_epoch,route_session_ref,route_policy_hash,
        provider,connection_id,conversation_id,delivery_id,cursor_start,cursor_end,event_cursor,
        participant_id,reply_to_event_cursor,message_id,message_operation_id,decision_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
        RETURNING message_id`,[admission.projectId,admission.bindingId,admission.routeVersion,
        route.rows[0].owner,route.rows[0].epoch,route.rows[0].session_ref,route.rows[0].policy_hash,
        s.source.provider,s.source.connectionId,s.source.conversationId,s.deliveryId,s.cursorStart,
        s.cursorEnd,s.eventCursor,s.participantId,s.replyToEventCursor,
        admission.messageId,admission.messageOperationId,admission.decisionId]);
      const result = await client.query(`${linkQuery} WHERE l.project_id=$1 AND l.message_id=$2`,
        [admission.projectId,inserted.rows[0]!.message_id]);
      return linkOf(result.rows[0]!);
    } catch (error) {
      if (error && typeof error === "object" && "code" in error) {
        if (error.code === "23505")
          throw new DomainError("CONNECTOR_LINK_CONFLICT", "Message, decision, or channel event already belongs to another admission");
        if (error.code === "23514" || error.code === "23503")
          throw new DomainError("CONNECTOR_ADMISSION_REFUSED", "Route or platform message failed the exact admission check");
      }
      throw error;
    }
  }

  /** Trusted gateway ingress. One source event, platform message, and link commit together. */
  async admitTrusted(input: ConnectorTrustedAdmission): Promise<ConnectorMessageLink> {
    const intent = connectorTrustedAdmissionSchema.parse(input);
    const s = intent.source;
    const client = await this.db.connect();
    try {
      await client.query("BEGIN");
      // Project lock first, as core writes do. Admission shares the target Session row and then its
      // queued message takes the Session slot lock; a writer holding that slot lock and waiting for the
      // Session row (profile adoption, queue claims) would otherwise meet it in a cycle (40P01).
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[intent.projectId]);
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 55199))",
        [connectorSourceKey(s)]);
      const prior = await client.query(`${linkQuery} WHERE l.provider=$1 AND l.connection_id=$2
        AND l.conversation_id=$3 AND l.delivery_id=$4 AND l.event_cursor=$5`,
        [s.source.provider,s.source.connectionId,s.source.conversationId,s.deliveryId,s.eventCursor]);
      if (prior.rows[0]) {
        const saved = linkOf(prior.rows[0]);
        const original = await client.query(`SELECT content FROM session_message
          WHERE project_id=$1 AND message_id=$2`,[saved.projectId,saved.messageId]);
        if (canonicalJson(fixedLink(saved)) !== canonicalJson(fixedLinkFromTrusted(intent)) ||
          saved.routeOwner !== intent.gateway.owner || saved.routeEpoch !== intent.gateway.epoch ||
          saved.routeSessionRef !== intent.gateway.sessionRef || original.rows[0]?.content !== intent.content)
          throw new DomainError("CONNECTOR_SOURCE_CONFLICT", "Channel event already has a different admission intent");
        await client.query("COMMIT");
        return saved;
      }
      const route = await client.query(`SELECT r.*,s.state AS session_state,s.actor_id AS session_actor_id,
        s.native_thread_id,s.native_session_id,
        s.sandbox,s.approval_policy,s.authorization_scope,
        p.activation_state,p.revision_id,p.active_revision_id,
        pr.sandbox AS profile_sandbox,pr.approval_policy AS profile_approval,
        pr.authorization_scope AS profile_scope
        FROM connector_route r JOIN runtime_session s
          ON s.project_id=r.project_id AND s.session_id=r.target_session_id
        LEFT JOIN session_execution_profile p
          ON p.project_id=s.project_id AND p.session_id=s.session_id
        LEFT JOIN session_execution_profile_revision pr
          ON pr.project_id=p.project_id AND pr.session_id=p.session_id AND pr.revision_id=p.revision_id
        WHERE r.project_id=$1 AND r.binding_id=$2 FOR SHARE OF r,s`,
        [intent.projectId,intent.bindingId]);
      const r = route.rows[0];
      const active=!!r&&r.state==="active"&&r.version===intent.routeVersion;
      let resumable=false;
      if(r&&["paused","disabled"].includes(r.state)&&r.version>=intent.routeVersion&&
        r.provider===s.source.provider&&r.connection_id===s.source.connectionId&&
        r.conversation_id===s.source.conversationId&&r.owner===intent.gateway.owner&&
        r.epoch===intent.gateway.epoch&&r.session_ref===intent.gateway.sessionRef){
        const priorAttempt=await client.query(`SELECT 1 FROM connector_transport_attempt
          WHERE project_id=$1 AND binding_id=$2 AND delivery_id=$3 AND route_version=$4`,
          [intent.projectId,intent.bindingId,s.deliveryId,intent.routeVersion]);
        resumable=!!priorAttempt.rows[0];
      }
      if ((!active&&!resumable)||
        r.provider !== s.source.provider || r.connection_id !== s.source.connectionId ||
        r.conversation_id !== s.source.conversationId ||
        r.owner !== intent.gateway.owner || r.epoch !== intent.gateway.epoch ||
        r.session_ref !== intent.gateway.sessionRef ||
        !s.participantId || !r.sender_ids.includes(s.participantId) ||
        r.session_state !== "ready" || !r.native_thread_id || !r.native_session_id ||
        r.native_thread_id !== r.target_thread_id ||
        (r.mode === "standard" ?
          (r.sandbox !== "danger-full-access" || r.approval_policy !== "never" ||
            !r.authorization_scope) :
          true) ||
        r.activation_state !== "active" || r.revision_id !== r.active_revision_id ||
        r.profile_sandbox !== r.sandbox || r.profile_approval !== r.approval_policy ||
        r.profile_scope !== r.authorization_scope)
        throw new DomainError("CONNECTOR_ADMISSION_REFUSED", "Exact active standard route and ready receiver are required");
      await client.query(`INSERT INTO session_message(project_id,message_id,operation_id,target_kind,
        session_id,link_id,sender_actor_id,content,context_task_id,context_task_revision_id,
        reply_to_message_id,state,version,blocked_reason,created_at,updated_at)
        VALUES($1,$2,$3,'owned',$4,NULL,$5,$6,NULL,NULL,NULL,'queued',1,NULL,now(),now())`,
        [intent.projectId,intent.messageId,intent.messageOperationId,r.target_session_id,
          r.sender_actor_id,intent.content]);
      const saved = await this.recordAdmission(client,fixedLinkFromTrusted(intent));
      const commandHash = createHash("sha256").update(canonicalJson(intent)).digest("hex");
      await client.query(`INSERT INTO operation_journal(project_id,operation_id,actor_id,
        command_hash,command_type,result,created_at)
        VALUES($1,$2,$3,$4,'connector.message.admit',$5::jsonb,now())`,
        [intent.projectId,intent.messageOperationId,r.sender_actor_id,commandHash,
          JSON.stringify({status:"applied",operationId:intent.messageOperationId,
            entityId:intent.messageId,version:1})]);
      await client.query("COMMIT");
      return saved;
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch { /* Keep the original error or uncertain commit result. */ }
      if (error && typeof error === "object" && "code" in error && error.code === "23505")
        throw new DomainError("CONNECTOR_LINK_CONFLICT", "Original message or operation ID already belongs to another intent");
      throw error;
    } finally { client.release(); }
  }

  /** Persist an incoming event that cannot become a SessionMessage, without storing private content. */
  async recordUnhandled(input: ConnectorUnhandledEvent): Promise<void> {
    const intent = connectorUnhandledEventSchema.parse(input);
    const s = intent.source;
    const client = await this.db.connect();
    try {
      await client.query("BEGIN");
      // Project lock first, as core writes do: this shares the route and Session rows before inserting.
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[intent.projectId]);
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 55199))",
        [connectorSourceKey(s)]);
      const admitted = await client.query(`SELECT message_id FROM connector_message_link
        WHERE project_id=$1 AND provider=$2 AND connection_id=$3 AND conversation_id=$4
          AND delivery_id=$5 AND event_cursor=$6`,
        [intent.projectId,s.source.provider,s.source.connectionId,s.source.conversationId,
          s.deliveryId,s.eventCursor]);
      if (admitted.rows[0])
        throw new DomainError("CONNECTOR_SOURCE_CONFLICT","Channel event already belongs to a platform message");
      const prior = await client.query(`SELECT * FROM connector_unhandled_event
        WHERE provider=$1 AND connection_id=$2 AND conversation_id=$3
          AND delivery_id=$4 AND event_cursor=$5`,
        [s.source.provider,s.source.connectionId,s.source.conversationId,s.deliveryId,s.eventCursor]);
      if (prior.rows[0]) {
        const row=prior.rows[0];
        if(row.project_id!==intent.projectId||row.binding_id!==intent.bindingId||
          row.route_version!==intent.routeVersion||row.route_owner!==intent.gateway.owner||
          row.route_epoch!==intent.gateway.epoch||row.route_session_ref!==intent.gateway.sessionRef||
          row.route_target_thread_id!==intent.gateway.threadId||
          Number(row.cursor_start)!==s.cursorStart||Number(row.cursor_end)!==s.cursorEnd||
          row.event_kind!==intent.eventKind||row.direction!==intent.direction||
          row.reason!==intent.reason||row.content_length!==intent.contentLength)
          throw new DomainError("CONNECTOR_SOURCE_CONFLICT","Unhandled event already has a different record");
        await client.query("COMMIT");
        return;
      }
      const route = await client.query(`SELECT r.*,s.state AS session_state,s.native_thread_id,s.native_session_id,
        s.sandbox,s.approval_policy,s.authorization_scope,
        p.activation_state,p.revision_id,p.active_revision_id,
        pr.sandbox AS profile_sandbox,pr.approval_policy AS profile_approval,
        pr.authorization_scope AS profile_scope
        FROM connector_route r JOIN runtime_session s
          ON s.project_id=r.project_id AND s.session_id=r.target_session_id
        LEFT JOIN session_execution_profile p
          ON p.project_id=s.project_id AND p.session_id=s.session_id
        LEFT JOIN session_execution_profile_revision pr
          ON pr.project_id=p.project_id AND pr.session_id=p.session_id AND pr.revision_id=p.revision_id
        WHERE r.project_id=$1 AND r.binding_id=$2 FOR SHARE OF r,s`,
        [intent.projectId,intent.bindingId]);
      const r=route.rows[0];
      if(!r||r.state!=='active'||r.mode!=='standard'||r.version!==intent.routeVersion||
        r.provider!==s.source.provider||r.connection_id!==s.source.connectionId||
        r.conversation_id!==s.source.conversationId||r.owner!==intent.gateway.owner||
        r.epoch!==intent.gateway.epoch||r.session_ref!==intent.gateway.sessionRef||
        r.target_thread_id!==intent.gateway.threadId||
        r.session_state!=='ready'||r.native_thread_id!==r.target_thread_id||
        !r.native_session_id||r.sandbox!=='danger-full-access'||r.approval_policy!=='never'||
        !r.authorization_scope||r.activation_state!=='active'||r.revision_id!==r.active_revision_id||
        r.profile_sandbox!==r.sandbox||r.profile_approval!==r.approval_policy||
        r.profile_scope!==r.authorization_scope)
        throw new DomainError("CONNECTOR_ADMISSION_REFUSED","Exact active standard route is required");
      await client.query(`INSERT INTO connector_unhandled_event(project_id,binding_id,route_version,
        route_owner,route_epoch,route_session_ref,route_target_thread_id,route_policy_hash,
        provider,connection_id,conversation_id,
        delivery_id,cursor_start,cursor_end,event_cursor,event_kind,direction,reason,content_length)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
        [intent.projectId,intent.bindingId,intent.routeVersion,intent.gateway.owner,
          intent.gateway.epoch,intent.gateway.sessionRef,intent.gateway.threadId,r.policy_hash,
          s.source.provider,s.source.connectionId,s.source.conversationId,s.deliveryId,
          s.cursorStart,s.cursorEnd,s.eventCursor,
          intent.eventKind,intent.direction,intent.reason,intent.contentLength]);
      await client.query("COMMIT");
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch { /* Preserve the original outcome. */ }
      if (error && typeof error === "object" && "code" in error && error.code === "23505")
        throw new DomainError("CONNECTOR_SOURCE_CONFLICT","Channel event already has another saved outcome");
      throw error;
    } finally { client.release(); }
  }

  async getUnhandledBySource(projectId:string,source:ConnectorSource):Promise<boolean>{
    connectorSourceKey(source);
    const s=source.source;
    const result=await this.db.query(`SELECT 1 FROM connector_unhandled_event
      WHERE project_id=$1 AND provider=$2 AND connection_id=$3 AND conversation_id=$4
        AND delivery_id=$5 AND event_cursor=$6`,
      [projectId,s.provider,s.connectionId,s.conversationId,source.deliveryId,source.eventCursor]);
    return !!result.rows[0];
  }

  async getByMessageId(projectId: string, messageId: string): Promise<ConnectorMessageLink | null> {
    const result = await this.db.query(`${linkQuery} WHERE l.project_id=$1 AND l.message_id=$2`,[projectId,messageId]);
    return result.rows[0] ? linkOf(result.rows[0]) : null;
  }

  async getBySource(projectId: string, source: ConnectorSource): Promise<ConnectorMessageLink | null> {
    connectorSourceKey(source);
    const s = source.source;
    const result = await this.db.query(`${linkQuery} WHERE l.project_id=$1 AND l.provider=$2 AND l.connection_id=$3
      AND l.conversation_id=$4 AND l.delivery_id=$5 AND l.event_cursor=$6`,
      [projectId,s.provider,s.connectionId,s.conversationId,source.deliveryId,source.eventCursor]);
    return result.rows[0] ? linkOf(result.rows[0]) : null;
  }
}
