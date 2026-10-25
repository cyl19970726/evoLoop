import type { RoleRecord } from "@evoloop/contracts/roles";
import { request } from "../api";

const roleIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isRoleOwnerId(owner: string): boolean { return roleIdPattern.test(owner); }

export async function readOwnerRole(token: string, projectId: string, owner: string, signal?: AbortSignal): Promise<RoleRecord> {
  const role = await request<RoleRecord>(token,
    `/api/projects/${encodeURIComponent(projectId)}/roles/${encodeURIComponent(owner)}`, 15000, { signal });
  if (role.id !== owner || role.projectId !== projectId || !role.proposal?.title?.trim())
    throw new Error("职责响应与当前任务不符");
  return role;
}
