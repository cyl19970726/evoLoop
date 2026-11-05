import { createHash } from "node:crypto";
import type { Pool, PoolClient, QueryResultRow } from "pg";
import { DomainError } from "@evoloop/contracts/ports";
import { canonicalJson } from "@evoloop/core";
import { connectorRouteSchema, connectorCapabilitiesSchema, connectorRouteRecordSchema,
  versionedConnectorRouteSchema,
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
  targetSessionId: r.target_session_id, targetActorId: r.target_actor_id,
  senderActorId: r.sender_actor_id, owner: r.owner, epoch: r.epoch,
  sessionRef: r.session_ref, state: r.state,
  capabilities: connectorCapabilitiesSchema.parse(r.capabilities), policyHash: r.policy_hash,
  version: r.version, createdAt: iso(r.created_at), updatedAt: iso(r.updated_at),
});
const operationOf = (r: Row): ConnectorRouteOperation => ({
  projectId: r.project_id, id: r.operation_id, actorId: r.actor_id,
  requestHash: r.request_hash, kind: r.kind, bindingId: r.binding_id,
  result: connectorRouteRecordSchema.parse(r.result), createdAt: iso(r.created_at),
});
function definiteRefusal(error: unknown): never {
  if (error && typeof error === "object" && "code" in error) {
    if (error.code === "23505")
      throw new DomainError("CONNECTOR_ROUTE_CONFLICT", "Route binding, source, or receiver Session is already reserved");
    if (error.code === "23503")
      throw new DomainError("CONNECTOR_ROUTE_REFERENCE", "Project or exact owned Session does not exist");
    if (error.code === "23514")
      throw new DomainError("CONNECTOR_ROUTE_REFUSED", "Route identity, epoch, or disabled-only constraint refused the write");
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

/** Route persistence only. Delivery stays closed until a restricted receiver is proven. */
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
        conversation_id,target_session_id,target_actor_id,sender_actor_id,owner,epoch,session_ref,state,
        capabilities,policy_hash,version) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'disabled',$12,$13,1)
        RETURNING *`, [route.projectId,route.bindingId,...key(route),route.targetActorId,
        route.senderActorId,route.owner,route.epoch,route.sessionRef,route.capabilities,route.policyHash]);
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
      if (JSON.stringify(key(current)) !== JSON.stringify(key(route)))
        throw new DomainError("CONNECTOR_ROUTE_IDENTITY", "Source and receiver Session are immutable");
      if (route.state === "active") await this.preflightActivation(client,route);
      if (route.state !== "disabled")
        throw new DomainError("CONNECTOR_ROUTE_UNVERIFIED", "Target actor and channel Session provenance are unverified");
      const result = await client.query(`UPDATE connector_route SET target_actor_id=$4,sender_actor_id=$5,
        owner=$6,epoch=$7,session_ref=$8,state=$9,capabilities=$10,policy_hash=$11,
        version=$12,updated_at=now() WHERE project_id=$1 AND binding_id=$2 AND version=$3 RETURNING *`,
        [route.projectId,route.bindingId,expectedVersion,route.targetActorId,route.senderActorId,
          route.owner,route.epoch,route.sessionRef,route.state,route.capabilities,route.policyHash,route.version]);
      if (!result.rows[0]) throw new DomainError("VERSION_CONFLICT", "Route version changed");
      return routeOf(result.rows[0]);
    });
  }

  private async preflightActivation(client: PoolClient, route: VersionedConnectorRoute): Promise<never> {
    const result = await client.query(`SELECT s.state,s.native_thread_id,s.native_session_id,
      s.sandbox,s.approval_policy,p.activation_state,p.revision_id,p.active_revision_id,
      r.sandbox AS profile_sandbox,r.approval_policy AS profile_approval
      FROM runtime_session s LEFT JOIN session_execution_profile p
        ON p.project_id=s.project_id AND p.session_id=s.session_id
      LEFT JOIN session_execution_profile_revision r ON r.project_id=p.project_id
        AND r.session_id=p.session_id AND r.revision_id=p.revision_id
      WHERE s.project_id=$1 AND s.session_id=$2`, [route.projectId,route.targetSessionId]);
    const receiver = result.rows[0];
    if (!receiver || receiver.state !== "ready" || !receiver.native_thread_id || !receiver.native_session_id ||
      receiver.activation_state !== "active" || receiver.revision_id !== receiver.active_revision_id ||
      !["read-only","workspace-write"].includes(receiver.sandbox) ||
      !["on-request","untrusted"].includes(receiver.approval_policy) ||
      receiver.profile_sandbox !== receiver.sandbox || receiver.profile_approval !== receiver.approval_policy)
      throw new DomainError("CONNECTOR_RECEIVER_NOT_RESTRICTED", "Exact owned Session lacks an active restricted profile");
    // Database configuration alone cannot prove gateway tool/credential isolation,
    // native Thread configuration, or recovery of earlier unknown Turns.
    throw new DomainError("CONNECTOR_RECEIVER_UNPROVEN", "Restricted receiver proof is not persisted");
  }
}
