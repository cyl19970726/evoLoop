// 项目设置 and 仓库规范: how the identity read back is said against the one read at login, and which capabilities the
// server declared, in words. Pure, so the pages and their tests agree.
import type { Principal } from "@evoloop/contracts";

export const permissionLabel: Record<string, string> = { read: "读取项目", write: "提交业务变更", review: "审阅与复核", approve: "接受与验收" };
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

export type CapabilityState = "yes" | "no" | "unknown";
export interface CapabilityRow { label: string; state: CapabilityState; text: string }
export const capabilityTag: Record<CapabilityState, { tone: "done" | "idle" | "unknown"; label: string }> = {
  yes: { tone: "done", label: "已配置" }, no: { tone: "idle", label: "未配置" }, unknown: { tone: "unknown", label: "无法判断" },
};

const flag = (value: unknown): boolean | undefined => typeof value === "boolean" ? value : undefined;

/**
 * A source declared per identity (Git repositories, the external knowledge base): the server says whether any project
 * this identity can open has one. That proves this project has none when it is false; when true, it is this project
 * only if this identity can open no other.
 */
function sourceRow(label: string, declared: boolean | undefined, projectIds: readonly string[], projectId: string, none: string): CapabilityRow {
  if (declared === undefined) return { label, state: "unknown", text: "服务端没有报告，无法判断。" };
  if (!declared) return { label, state: "no", text: none };
  if (projectIds.length === 1 && projectIds[0] === projectId) return { label, state: "yes", text: "已为本项目配置。" };
  return { label, state: "unknown", text: "你能访问的项目里至少有一个已配置；是否包括本项目，服务端没有分项目报告，无法判断。" };
}

/** The capabilities the server declared on /api/session, for this project and identity, in words. */
export function capabilityRows(capabilities: Record<string, unknown>, projectIds: readonly string[], projectId: string): CapabilityRow[] {
  const source = capabilities.sourceConfiguration && typeof capabilities.sourceConfiguration === "object"
    ? capabilities.sourceConfiguration as Record<string, unknown> : {};
  const runtime = flag(capabilities.runtime);
  const originals = flag(capabilities.documentOriginals) ?? flag(capabilities.html);
  return [
    sourceRow("Git 固定来源", flag(source.git) ?? flag(capabilities.git), projectIds, projectId,
      "服务端没有为你能访问的任何项目配置仓库，登记 Git 固定来源会被拒绝。"),
    sourceRow("外部知识库", flag(source.wiki) ?? flag(capabilities.wiki), projectIds, projectId,
      "服务端没有为你能访问的任何项目接入外部知识库。"),
    runtime === undefined ? { label: "受管智能体运行", state: "unknown", text: "服务端没有报告，无法判断。" }
      : { label: "受管智能体运行", state: runtime ? "yes" : "no", text: runtime ? "服务端的运行时在读取时可用。" : "服务端的运行时在读取时不可用。" },
    originals === undefined ? { label: "文档原件与 HTML 报告", state: "unknown", text: "服务端没有报告，无法判断。" }
      : { label: "文档原件与 HTML 报告", state: originals ? "yes" : "no", text: originals ? "可以上传和阅读原件。" : "服务端没有接入原件存储。" },
  ];
}
