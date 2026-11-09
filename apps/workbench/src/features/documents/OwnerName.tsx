// The person or role responsible for a task, by name. A role is stored by its ID, which belongs in the source layer,
// so it is read back and shown by its title; until then, or when it cannot be read, the text says so.
import { isRoleOwnerId, readOwnerRole } from "../../shared/ownerRole";
import { useProjectQuery } from "../../shared/query";

export function OwnerName({ projectId, owner }: { projectId: string; owner: string }) {
  const role = isRoleOwnerId(owner);
  const read = useProjectQuery(projectId, ["role", owner, "title"], signal => readOwnerRole("", projectId, owner, signal), { enabled: role });
  if (!role) return <>{owner}</>;
  return <span title={owner}>{read.data?.proposal?.title?.trim() ?? (read.isError ? "职责名称待核对" : "正在核对职责")}</span>;
}
