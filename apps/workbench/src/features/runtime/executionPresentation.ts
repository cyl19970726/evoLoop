// What 分工与运行 says about managed agents (Session) and their runs, apart from rendering so each rule can be tested.
// Service states reach the screen as short Chinese labels; a close is offered only when no recorded fact blocks it.
import type { ResidentQueue } from "@evoloop/contracts/queues";
import type { RuntimeRunRecord, RuntimeSessionRecord } from "@evoloop/contracts/runtime";
import type { StatusTone } from "@evoloop/ui";
import type { ExecutionGrant } from "../../shared/runtimeClient";

export const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const sessionStateText: Record<RuntimeSessionRecord["state"], string> = {
  reserved: "已预留", creating: "创建中", ready: "就绪", closing: "关闭中", unknown: "状态未知", closed: "已关闭",
};
const sessionTone: Record<RuntimeSessionRecord["state"], StatusTone> = {
  reserved: "waiting", creating: "progress", ready: "idle", closing: "progress", unknown: "unknown", closed: "history",
};
export const sessionStateTone = (state: RuntimeSessionRecord["state"]): StatusTone => sessionTone[state];

export const runStateText: Record<RuntimeRunRecord["state"], string> = {
  requested: "已请求", dispatching: "派发中", running: "运行中", completed: "已结束", failed: "失败", interrupted: "已中断", unknown: "结果未知",
};
const runTone: Record<RuntimeRunRecord["state"], StatusTone> = {
  requested: "waiting", dispatching: "progress", running: "progress", completed: "done", failed: "blocked", interrupted: "history", unknown: "unknown",
};
export const runStateTone = (state: RuntimeRunRecord["state"]): StatusTone => runTone[state];
export const pendingRun = (state: RuntimeRunRecord["state"]) => state === "requested" || state === "dispatching" || state === "running" || state === "unknown";

const permissionText: Record<string, string> = {
  "danger-full-access": "完整本机权限", "workspace-write": "可写工作区", "read-only": "只读",
  never: "无需逐次审批", "on-request": "按需审批", untrusted: "逐次审批",
};
export const permissionsText = (sandbox: string, approval: string) => `${permissionText[sandbox] ?? sandbox} · ${permissionText[approval] ?? approval}`;

export interface SessionGroup { key: "working" | "preparing" | "check" | "closed"; label: string; items: RuntimeSessionRecord[] }

/** Rail and overview groups: usable first, then those still being prepared, those needing a check, and closed ones. */
export function sessionGroups(sessions: readonly RuntimeSessionRecord[]): SessionGroup[] {
  const byTime = [...sessions].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || a.id.localeCompare(b.id));
  const groups: SessionGroup[] = [
    { key: "working", label: "就绪", items: byTime.filter(session => session.state === "ready") },
    { key: "preparing", label: "准备中", items: byTime.filter(session => session.state === "reserved" || session.state === "creating") },
    { key: "check", label: "需要核对", items: byTime.filter(session => session.state === "closing" || session.state === "unknown") },
    { key: "closed", label: "已关闭", items: byTime.filter(session => session.state === "closed") },
  ];
  return groups.filter(group => group.items.length > 0);
}

/** Grants that may create a new managed agent: full local access, no per-step approval, network on. */
export function fullGrants(grants: readonly ExecutionGrant[], roleId?: string): ExecutionGrant[] {
  return grants.filter(grant => grant.sandbox === "danger-full-access" && grant.approvalPolicy === "never" && grant.networkAccess === true
    && (!roleId || grant.roleId === roleId));
}

/** Models a grant may use that the runtime also lists. */
export function allowedModels(grant: ExecutionGrant, catalog: readonly string[]): string[] {
  const authorized = [...(grant.model ? [grant.model] : []), ...(grant.models ?? [])];
  return [...new Set(catalog.filter(model => authorized.includes(model)))];
}

/** Activation of the session's target execution profile, in words. */
export function profileText(session: RuntimeSessionRecord, activation: (state: NonNullable<RuntimeSessionRecord["executionProfile"]>["activationState"]) => string): string {
  const profile = session.executionProfile;
  if (!profile) return "未读到执行配置修订；不能从创建时权限推断当前配置。";
  const active = profile.activationState === "active" && profile.activeRevisionId === profile.revision.revisionId;
  const state = profile.activationState === "active" && !active ? profile.activeRevisionId ? "当前激活的是其他修订" : "激活记录待核对" : activation(profile.activationState);
  const tail = active ? "此修订已登记激活。" : profile.activeRevisionId ? "目标修订尚未确认激活；原已激活修订继续单独保留。" : "尚无已确认的配置修订。";
  return `目标执行配置 v${profile.revision.version}：${permissionsText(profile.revision.sandbox, profile.revision.approvalPolicy)} · 模型 ${profile.revision.model ?? "未显式指定"} · ${state}。${tail}`;
}

/** The old full-access upgrade applies to a ready agent whose target profile is not full access yet. */
export function needsFullAccessUpgrade(session: RuntimeSessionRecord): boolean {
  const profile = session.executionProfile;
  return !!profile && session.state === "ready" && (profile.revision.sandbox !== "danger-full-access" || profile.revision.approvalPolicy !== "never")
    && profile.activationState !== "attempting" && profile.activationState !== "unknown";
}

export interface CloseRead {
  /** The run list was read completely this time. */
  runsRead: boolean;
  runs: readonly RuntimeRunRecord[];
  /** Queue entries were read completely this time; null when the read failed. */
  queues: readonly ResidentQueue[] | null;
}

/** Every recorded reason a close request cannot be offered now. Empty means none was found in what was read. */
export function closeBlockers(session: RuntimeSessionRecord, read: CloseRead): string[] {
  const blockers: string[] = [];
  if (session.state !== "ready") blockers.push(session.state === "closed" ? "已关闭，不需要再次请求" : session.state === "closing"
    ? "关闭请求已登记，正在等待原操作结果；不能重发关闭" : `当前状态为“${sessionStateText[session.state]}”，只有就绪的智能体可以请求关闭`);
  if (session.state === "ready" && !session.nativeThreadId) blockers.push("原生线程尚未绑定，无法核实归档");
  if (!read.runsRead) blockers.push("运行列表未读回，不能确认没有在途运行");
  else {
    const pending = read.runs.filter(run => run.sessionId === session.id && pendingRun(run.state));
    if (pending.length) blockers.push(`仍有在途或结果未知的运行（${pending.length} 项）`);
  }
  if (!read.queues) blockers.push("队列未读回，不能确认没有占用");
  else {
    const entries = read.queues.flatMap(queue => queue.entries).filter(entry => entry.sessionId === session.id && entry.state !== "released");
    if (entries.length) blockers.push(`仍有队列占用或待处理条目（${entries.length} 项，含 ${entries.filter(entry => entry.state === "claimed").length} 项已领取）`);
  }
  return blockers;
}

/** The address of one managed agent in 分工与运行. */
export const executionHref = (projectId: string, sessionId: string) => `/p/${projectId}/runtime?session=${encodeURIComponent(sessionId)}`;
