import type { QueueAttempt, ResidentQueue } from "@evoloop/contracts/queues";
import { request } from "../api";

export interface EntryAttempts { entryId: string; claimId: string | null; attempts: QueueAttempt[] }
export function queueClient(token: string, projectId: string) {
  const base = `/api/projects/${encodeURIComponent(projectId)}/resident-queues`;
  const key = encodeURIComponent;
  return {
    list: () => request<ResidentQueue[]>(token, base, 15000),
    detail: (id: string) => request<ResidentQueue>(token, `${base}/${key(id)}`, 15000),
    attempts: (id: string) => request<EntryAttempts[]>(token, `${base}/${key(id)}/attempts`, 15000),
  };
}
