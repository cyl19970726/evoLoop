// 项目设置: how the identity read back is said against the one read at login, and when it was read. Pure, so the page
// and its tests agree. (仓库规范 says the capabilities judged for the project: capabilityPresentation.ts.)
import type { Principal } from "@evoloop/contracts";

export const permissionLabel: Record<string, string> = { task: "任务", document: "文档", session: "Session", management: "项目管理" };
export const identityLabel: Record<string, string> = { human: "人", agent: "智能体" };
const permissionText = (permission: string) => permissionLabel[permission] ?? permission;
const kindText = (kind: Principal["identityKind"]) => kind ? identityLabel[kind] ?? kind : "未报告";

/** What the identity read again says differently from the one the workbench signed in with. Empty when nothing differs. */
export function identityChanges(login: Principal, current: Principal, projectId: string): string[] {
  const changes: string[] = [];
  if (current.actorId !== login.actorId) changes.push(`读回的身份是 ${current.actorId}，登录时是 ${login.actorId}`);
  if (!current.projectIds.includes(projectId)) changes.push("读回的身份已不能访问本项目");
  const added = current.permissions.filter(item => !login.permissions.includes(item));
  const removed = login.permissions.filter(item => !current.permissions.includes(item));
  if (added.length) changes.push(`新增权限：${added.map(permissionText).join("、")}`);
  if (removed.length) changes.push(`不再有的权限：${removed.map(permissionText).join("、")}`);
  const loginDecisions = login.identityKind === "human" || login.decisions === true;
  const currentDecisions = current.identityKind === "human" || current.decisions === true;
  if (loginDecisions !== currentDecisions) changes.push(currentDecisions ? "新增决定权限" : "不再有决定权限");
  if (JSON.stringify([...login.projectIds].sort()) !== JSON.stringify([...current.projectIds].sort())) changes.push("项目范围已变化");
  if (JSON.stringify([...(login.sessionIds ?? [])].sort()) !== JSON.stringify([...(current.sessionIds ?? [])].sort()))
    changes.push("Session 范围已变化");
  if ((current.identityKind ?? null) !== (login.identityKind ?? null)) changes.push(`身份类型由${kindText(login.identityKind)}变为${kindText(current.identityKind)}`);
  return changes;
}

/** How the identity on screen stands: read again at a time, being read, or kept after a failed read. */
export interface IdentityRead { hasData: boolean; fetching: boolean; failed: boolean; readAt: string }

/** The 最后读取 line of the identity: when it was read, and whether what is shown is current. */
export function identityReadText(read: IdentityRead): string {
  if (read.hasData) return `${read.readAt}${read.failed ? " · 上次读回，当前待核对" : read.fetching ? " · 正在重新核对" : ""}`;
  if (read.failed) return "本次读取失败；下面是登录时读回的内容，当前待核对";
  return "正在读取；下面先显示登录时读回的内容";
}

