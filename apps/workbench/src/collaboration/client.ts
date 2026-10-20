import type { DeliveryAttempt, DeliveryRecord, IncomingRecord } from "@evoloop/contracts/delivery";
import type { Page } from "@evoloop/contracts";
import { request } from "../api";

const key = (value: string) => encodeURIComponent(value);
export function collaborationClient(token: string, projectId: string) {
  const base = `/api/projects/${key(projectId)}/collaboration`;
  const post = <T>(path: string, value?: unknown) => request<T>(token,path,15000,{method:"POST",body:JSON.stringify(value ?? {})});
  return {
    overview: () => request<{configured:boolean;verifiedAtUtc:string|null;error:string|null;deliveries:Page<DeliveryRecord>;incoming:Page<IncomingRecord>;incomingPending:number}>(token,base,15000),
    deliveries: (cursor?: string) => request<Page<DeliveryRecord>>(token,`${base}/deliveries?limit=50${cursor?`&cursor=${key(cursor)}`:""}`,15000),
    attempts: (eventId: string) => request<DeliveryAttempt[]>(token,`${base}/deliveries/${key(eventId)}/attempts`,15000),
    delivery: (eventId: string) => request<DeliveryRecord|null>(token,`${base}/deliveries/${key(eventId)}`,15000),
    incoming: (cursor?: string) => request<Page<IncomingRecord>>(token,`${base}/incoming?limit=50${cursor?`&cursor=${key(cursor)}`:""}`,15000),
    incomingItem: (id: string) => request<IncomingRecord|null>(token,`${base}/incoming/${key(id)}`,15000),
    reconcile: (eventId: string, reason: string) => post<DeliveryRecord|null>(`${base}/deliveries/${key(eventId)}/reconcile`,{reason}),
    retry: (eventId: string, reason: string) => post<{requested:boolean}>(`${base}/deliveries/${key(eventId)}/retry`,{reason}),
    poll: () => post<{observed:number}>(`${base}/poll`),
    review: (id: string, decision: "apply"|"reject", reason: string) => post<{state:IncomingRecord["state"];operationId:string;reason:string}>(`${base}/incoming/${key(id)}/review`,{decision,reason}),
  };
}
