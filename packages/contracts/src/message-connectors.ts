import { z } from "zod";

const key = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,127}$/);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);

/** The channel owns message bytes and delivery state. This reference never acts as authority. */
export const connectorConversationSchema = z.strictObject({
  provider: z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/),
  connectionId: key,
  conversationId: key,
});
export type ConnectorConversation = z.infer<typeof connectorConversationSchema>;

export const connectorCapabilitiesSchema = z.strictObject({
  history: z.boolean(), search: z.boolean(), subscribe: z.boolean(),
  sendText: z.boolean(), sendMedia: z.boolean(), receipt: z.enum(["local_observed", "recipient_confirmed", "none"]),
});
export type ConnectorCapabilities = z.infer<typeof connectorCapabilitiesSchema>;

/** One native Thread is bound to one external conversation to prevent cross-conversation context reuse. */
export const connectorRouteSchema = z.strictObject({
  projectId: z.uuid(), bindingId: z.uuid(), source: connectorConversationSchema,
  targetSessionId: z.uuid(), targetActorId: key, senderActorId: key,
  owner: key, epoch: z.number().int().positive(), sessionRef: key,
  state: z.enum(["disabled", "active", "paused"]),
  capabilities: connectorCapabilitiesSchema,
  /** Hash of a reviewed, server-side authorization policy; never a credential. */
  policyHash: sha256,
});
export type ConnectorRoute = z.infer<typeof connectorRouteSchema>;

/** Storage version is advanced by one on every successful route change. */
export const versionedConnectorRouteSchema = connectorRouteSchema.extend({
  version: z.number().int().positive(),
});
export type VersionedConnectorRoute = z.infer<typeof versionedConnectorRouteSchema>;
export const connectorRouteRecordSchema = versionedConnectorRouteSchema.extend({
  createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(),
});
export type ConnectorRouteRecord = z.infer<typeof connectorRouteRecordSchema>;
export type ConnectorRoutePage = { items: ConnectorRouteRecord[]; nextCursor: string | null };

export const connectorSourceSchema = z.strictObject({
  source: connectorConversationSchema,
  deliveryId: z.number().int().positive(),
  cursorStart: z.number().int().nonnegative(), cursorEnd: z.number().int().nonnegative(),
  eventCursor: z.number().int().positive(),
  /** Nullable until the channel can prove the originating participant. */
  participantId: key.nullable(),
  replyToEventCursor: z.number().int().positive().nullable(),
});
export type ConnectorSource = z.infer<typeof connectorSourceSchema>;

/** Persisted in the same transaction as the original platform message. */
export const connectorMessageAdmissionSchema = z.strictObject({
  projectId: z.uuid(), bindingId: z.uuid(), routeVersion: z.number().int().positive(),
  source: connectorSourceSchema,
  messageId: z.uuid(), messageOperationId: z.uuid(), decisionId: z.uuid(),
});
export type ConnectorMessageAdmission = z.infer<typeof connectorMessageAdmissionSchema>;
export const connectorTrustedAdmissionSchema = connectorMessageAdmissionSchema.extend({
  content: z.string().trim().min(1).max(16000),
  gateway: z.strictObject({owner:key,epoch:z.number().int().positive(),sessionRef:key}),
});
export type ConnectorTrustedAdmission = z.infer<typeof connectorTrustedAdmissionSchema>;

/** Processing and Turn fields are read from the platform's original message processing row. */
export type ConnectorMessageLink = ConnectorMessageAdmission & {
  decision: "admitted";
  routeOwner: string;
  routeEpoch: number;
  routeSessionRef: string;
  routePolicyHash: string;
  createdAt: string;
  processingId: string | null;
  processingOperationId: string | null;
  processingState: "dispatching" | "running" | "unknown" | "completed" | "failed" | null;
  nativeTurnId: string | null;
  messageState: "queued" | "processing" | "replied" | "completed_without_reply" |
    "failed" | "unknown" | "cancelled" | "manual_pending";
};

/** A route is invalid when another conversation can share its native Session context. */
export function assertIsolatedConnectorRoutes(routes: readonly ConnectorRoute[]): void {
  const sourceKeys = new Set<string>();
  const sessions = new Set<string>();
  for (const raw of routes) {
    const route = connectorRouteSchema.parse(raw);
    if (route.state === "disabled") continue;
    const source = JSON.stringify([route.source.provider, route.source.connectionId, route.source.conversationId]);
    const session = JSON.stringify([route.projectId, route.targetSessionId]);
    if (sourceKeys.has(source)) throw new Error("CONNECTOR_SOURCE_ALREADY_BOUND");
    if (sessions.has(session)) throw new Error("CONNECTOR_SESSION_CONTEXT_SHARED");
    if (route.targetActorId === route.senderActorId) throw new Error("CONNECTOR_ACTOR_COLLISION");
    sourceKeys.add(source);
    sessions.add(session);
  }
}

export function connectorSourceKey(value: ConnectorSource): string {
  const source = connectorSourceSchema.parse(value);
  if (source.cursorEnd < source.cursorStart || source.eventCursor < source.cursorStart ||
    source.eventCursor > source.cursorEnd) throw new Error("CONNECTOR_CURSOR_RANGE");
  return JSON.stringify([source.source.provider, source.source.connectionId,
    source.source.conversationId, source.deliveryId, source.eventCursor]);
}
