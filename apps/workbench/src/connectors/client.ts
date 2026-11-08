import type { ConnectorRoute, ConnectorRoutePage, ConnectorRouteRecord, VersionedConnectorRoute } from "@evoloop/contracts/message-connectors";
import { request } from "../api";

export type ConnectorDeliverySummary = {deliveryId:number;eventCount:number;unhandledCount:number;latestMessageState:string;
  decision:{decision:string;state:string;requestId:string|null}|null};
export type ConnectorDeliveryDetail = {deliveryId:number;messages:Array<{eventCursor:number;messageId:string;
  messageState:string;processingState:string|null;nativeTurnId:string|null}>;
  unhandled:Array<{eventCursor:number;eventKind:string;direction:string;participantId:string|null;
    reason:string;contentLength:number}>;
  decision:{decision:string;state:string;requestId:string|null}|null};

const key = encodeURIComponent;
export function connectorClient(token: string, projectId: string) {
  const root = `/api/projects/${key(projectId)}/message-connectors`;
  const get = <T>(path: string) => request<T>(token, `${root}${path}`, 15000);
  const write = <T>(path: string, method: "POST" | "PUT", body: unknown) =>
    request<T>(token, `${root}${path}`, 15000, { method, body: JSON.stringify(body) });
  return {
    list: (cursor?: string) => get<ConnectorRoutePage>(`/routes?limit=50${cursor ? `&cursor=${key(cursor)}` : ""}`),
    route: (id: string) => get<ConnectorRouteRecord>(`/routes/${key(id)}`),
    deliveries: (id:string) => get<{items:ConnectorDeliverySummary[]}>(`/routes/${key(id)}/deliveries?limit=10`),
    delivery: (id:string,deliveryId:number) => get<ConnectorDeliveryDetail>(
      `/routes/${key(id)}/deliveries/${deliveryId}`),
    operation: (id: string) => get<{ id: string; result: ConnectorRouteRecord }>(`/operations/${key(id)}`),
    create: (route: ConnectorRoute, operationId: string) =>
      write<{ operationId: string; route: ConnectorRouteRecord }>("/routes", "POST", { route, operationId }),
    update: (route: VersionedConnectorRoute, expectedVersion: number, operationId: string) =>
      write<{ operationId: string; route: ConnectorRouteRecord }>(`/routes/${key(route.bindingId)}`, "PUT",
        { route, expectedVersion, operationId }),
  };
}
