import type { AllocationRelationFilter, AllocationTracePage } from "@evoloop/contracts/allocation-relations";
import { request } from "../api";

export type { AllocationTrace, AllocationTracePage } from "@evoloop/contracts/allocation-relations";
export type AllocationFilter = AllocationRelationFilter;

export function allocationRelations(token: string, projectId: string, filter: AllocationFilter, cursor?: string, signal?: AbortSignal) {
  const query = new URLSearchParams({ limit: "20" });
  if (filter.roleId) query.set("roleId", filter.roleId);
  else if (filter.sessionKey) query.set("sessionKey", filter.sessionKey);
  else if (filter.discussionId) query.set("discussionId", filter.discussionId);
  if (cursor) query.set("cursor", cursor);
  return request<AllocationTracePage>(token,
    `/api/projects/${encodeURIComponent(projectId)}/allocation-relations?${query}`, 15000, { signal });
}
