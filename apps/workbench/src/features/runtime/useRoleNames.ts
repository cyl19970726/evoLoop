// Names of the Roles the managed agents are registered under. Each Role is read once per project key; an identifier that
// is not a Role ID (older free-text owners) is shown as written. A failed read never shows another Role's name.
import { useQueries } from "@tanstack/react-query";
import { ApiError, errorText } from "../../shared/api";
import { isRoleOwnerId, readOwnerRole } from "../../shared/ownerRole";
import { queryKeys } from "../../shared/query";

export interface RoleName { title?: string; fallback: string; note?: string; error?: string }

export function roleNameOf(roleId: string, read: { title?: string; error?: unknown; pending: boolean } | undefined): RoleName {
  if (!isRoleOwnerId(roleId)) return { fallback: roleId };
  const fallback = `职责 ${roleId.slice(0, 8)}`;
  if (read?.title) return { title: read.title, fallback };
  if (read?.error) {
    const missing = read.error instanceof ApiError && read.error.status === 404;
    return { fallback, note: missing ? "未找到已登记职责" : "名称暂不可核对", error: missing ? "未找到已登记职责" : `职责暂不可核对：${errorText(read.error)}` };
  }
  return { fallback, note: "正在核对名称" };
}

export function useRoleNames(projectId: string, roleIds: readonly string[]): (roleId: string) => RoleName {
  const ids = [...new Set(roleIds.filter(isRoleOwnerId))].sort();
  const reads = useQueries({
    queries: ids.map(id => ({
      queryKey: queryKeys.project(projectId, "roles", id, "record"),
      queryFn: ({ signal }: { signal: AbortSignal }) => readOwnerRole("", projectId, id, signal).then(role => role.proposal.title.trim()),
      enabled: !!projectId,
    })),
  });
  const byId = new Map(ids.map((id, index) => [id, reads[index]!]));
  return roleId => {
    const read = byId.get(roleId);
    // Only a read that has just succeeded names the Role; while rereading after a failure the failure stands.
    return roleNameOf(roleId, read && { title: read.isError ? undefined : read.data, error: read.error, pending: read.isPending });
  };
}
