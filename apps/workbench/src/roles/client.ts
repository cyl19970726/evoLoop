import type { RoleHandoff, RoleRecord, RoleRevision, RoleSessionBinding, RoleTrialReview } from "@evoloop/contracts/roles";
import type { Page } from "@evoloop/contracts";
import { request } from "../api";

const project = (id: string) => `/api/projects/${encodeURIComponent(id)}`;
const key = (id: string) => encodeURIComponent(id);
export function roleClient(token: string, projectId: string) {
  const base = `${project(projectId)}/roles`;
  return {
    list: (cursor?: string) => request<Page<RoleRecord>>(token, `${base}?limit=50${cursor ? `&cursor=${key(cursor)}` : ""}`, 15000),
    revisions: (id: string) => request<RoleRevision[]>(token, `${base}/${key(id)}/revisions`, 15000),
    reviews: (id: string) => request<RoleTrialReview[]>(token, `${base}/${key(id)}/reviews`, 15000),
    handoffs: (id: string) => request<RoleHandoff[]>(token, `${base}/${key(id)}/handoffs`, 15000),
    bindings: (id: string) => request<RoleSessionBinding[]>(token, `${base}/${key(id)}/bindings`, 15000),
  };
}
