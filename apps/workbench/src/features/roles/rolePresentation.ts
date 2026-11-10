// What the 职责 page says about a Role, kept apart from rendering so each wording can be checked without a browser.
// Service values (state, evidence kind, review decision, handoff state) never reach the screen as raw English.
import type { RoleHandoff, RoleProposal, RoleRecord, RoleTrialReview } from "@evoloop/contracts/roles";
import type { DomainRoute, HostCapability, HostLink } from "@evoloop/contracts/resident-hosts";
import type { StatusTone } from "@evoloop/ui";

export const roleIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The task an evidence source names (`task://{id}`, or a bare task id on a task handoff); anything else is shown as written. */
export function sourceRefTaskId(sourceRef: string): string | null {
  const match = /^task:\/\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(sourceRef.trim());
  return match ? match[1]! : null;
}

export const roleStateText: Record<RoleRecord["state"], string> = {
  candidate: "待判断", trial: "试行中", active: "持续职责", "retirement-pending": "待交接关闭",
  retired: "已撤回", rejected: "未采纳", deferred: "待重看",
};
const stateTone: Record<RoleRecord["state"], StatusTone> = {
  candidate: "waiting", deferred: "waiting", trial: "progress", active: "done", "retirement-pending": "waiting", retired: "history", rejected: "history",
};
export const roleStateTone = (state: RoleRecord["state"]): StatusTone => stateTone[state];

export function roleClassText(proposal: Pick<RoleProposal, "roleClass">): string {
  return proposal.roleClass === "system" ? "系统职责" : proposal.roleClass === "business" ? "业务职责" : "分类未登记";
}

const evidenceText: Record<RoleProposal["evidence"][number]["kind"], string> = {
  backlog: "持续积压", omission: "反复遗漏", rework: "反复返工", effect: "实际效果", cost: "已付成本",
};
export const evidenceKindText = (kind: RoleProposal["evidence"][number]["kind"]) => evidenceText[kind];

const alternativeText: Record<RoleProposal["alternatives"][number]["kind"], string> = {
  method: "改方法或工具", knowledge: "补知识或输入", "another-instance": "同职责增实例", "temporary-assignment": "临时专项",
};
export const alternativeKindText = (kind: RoleProposal["alternatives"][number]["kind"]) => alternativeText[kind];

const reviewText: Record<RoleTrialReview["decision"], string> = {
  "continue-trial": "延长试行", activate: "确认为持续职责", merge: "并入已有职责", retire: "撤回并交接",
};
export const reviewDecisionText = (decision: RoleTrialReview["decision"]) => reviewText[decision];

const handoffKind: Record<RoleHandoff["kind"], string> = { task: "未完成任务", knowledge: "知识与材料", session: "智能体现场" };
export const handoffText = (handoff: Pick<RoleHandoff, "kind" | "state">) =>
  `${handoffKind[handoff.kind]} · ${handoff.state === "acknowledged" ? "已确认接收" : "待接收确认"}`;

const capabilityText: Record<HostCapability, string> = { open: "打开", read: "读取", "manual-claim": "人工领取", start: "启动", send: "发送", interrupt: "中断" };
export const capabilitiesText = (items: readonly HostCapability[]) => items.map(item => capabilityText[item]).join("、");

/** One host link as the presence list states it: which kind of host, and how far it has been checked. */
export function hostTitle(link: HostLink): string {
  const kind = link.host.kind === "owned" ? "项目受管智能体"
    : link.host.provider === "codex-desktop" ? "外部 Codex Desktop 聊天" : "外部宿主（类型未支持）";
  return `${kind} · ${link.state === "verified" ? "已核实" : link.state === "revoked" ? "已撤权" : "仅登记"}`;
}

const routeText: Record<DomainRoute["status"], string> = {
  unassigned: "未指定职责", "role-unavailable": "职责尚不可承接", unlinked: "未链接承载",
  "owned-ready": "受管智能体可承接", "external-manual": "外部宿主需人工领取", "host-unverified": "宿主能力未核实",
};
export const routeStatusText = (status: DomainRoute["status"]) => routeText[status];

/** Which next steps the Role's state allows; the service checks again when a form is sent. */
export function roleActions(state: RoleRecord["state"]) {
  const live = state === "trial" || state === "active";
  return {
    decide: state === "candidate" || state === "deferred",
    review: live,
    handoff: live || state === "retirement-pending",
    bind: live,
    connect: live,
    retire: state === "retirement-pending",
  };
}

/** `?role=` on the 职责 address: null when absent, "" when repeated (no single target), else the value. */
export function roleTarget(path: string, rolesPath: string): string | null {
  const [pathname, query = ""] = path.split("?");
  if (pathname !== rolesPath) return null;
  const params = new URLSearchParams(query);
  if (!params.has("role")) return null;
  const values = params.getAll("role");
  return values.length === 1 ? values[0]! : "";
}

export type TargetState =
  | { kind: "none" } | { kind: "invalid" } | { kind: "found" } | { kind: "searching" }
  | { kind: "unreadable"; error: string } | { kind: "limit" } | { kind: "missing" };

/** Where a linked Role stands: found, still being looked for page by page, or provably not in this project. */
export function targetState(target: string | null, found: boolean, read: { loading: boolean; error: string; more: boolean; pages: number; maxPages: number; loadingMore?: boolean; moreError?: string }): TargetState {
  if (target === null) return { kind: "none" };
  if (!roleIdPattern.test(target)) return { kind: "invalid" };
  if (found) return { kind: "found" };
  if (read.error) return { kind: "unreadable", error: read.error };
  if (read.moreError) return { kind: "unreadable", error: read.moreError };
  if (read.loading || read.loadingMore || read.more && read.pages < read.maxPages) return { kind: "searching" };
  return read.more ? { kind: "limit" } : { kind: "missing" };
}

/** What the page says about a linked Role. The full ID is never in the sentence; the page offers it under 完整标识. */
export function targetNotice(state: TargetState): { tone: "info" | "error"; title: string; text: string } | null {
  switch (state.kind) {
    case "invalid": return { tone: "error", title: "链接无效", text: "链接中的目标职责 ID 无效；没有定位到其他职责。" };
    case "searching": return { tone: "info", title: "正在定位", text: "正在逐页定位链接里的职责…" };
    case "unreadable": return { tone: "error", title: "无法定位", text: `职责列表没有读完，暂时无法定位链接里的职责：${state.error}` };
    case "limit": return { tone: "error", title: "尚未定位", text: "自动追加读取已到上限，链接里的职责尚未定位；可在“全部职责”继续加载后再核对。" };
    case "missing": return { tone: "error", title: "没有这项职责", text: "当前项目已读完职责，没有链接里的这项职责；没有定位到其他职责。" };
    default: return null;
  }
}

/** Role revision reasons the service writes itself, in words; anything else written by a person is shown as is. */
export function revisionReasonText(reason: string): { text: string; raw?: string } {
  const handoff = /^prepared (task|knowledge|session) handoff$/.exec(reason);
  if (handoff) return { text: `登记待交接：${handoffText({ kind: handoff[1] as RoleHandoff["kind"], state: "prepared" }).split(" · ")[0]}` };
  if (reason === "evidence-backed proposal") return { text: "附证据提出职责" };
  if (reason === "handoff acknowledged") return { text: "确认交接已完成" };
  if (reason === "runtime session binding") return { text: "绑定承载智能体" };
  const retire = /^([\s\S]*); knowledge: ([\s\S]*); runtime: ([\s\S]*)$/.exec(reason);
  if (retire) return { text: `撤回：${retire[1]}\n知识与材料的处理：${retire[2]}\n在途智能体的核对：${retire[3]}` };
  // Free text from a person is kept; an unrecognised service sentence (no Chinese at all) is not shown raw.
  return /[\u3400-\u9fff]/.test(reason) || !reason.trim() ? { text: reason || "未写原因" } : { text: "系统记录的修订原因（未识别）", raw: reason };
}

/**
 * A person in the record: the reader is 我, a readable account name stays; an opaque identifier is never shortened into
 * the text (原始标识放在来源层): it is “未登记名称的身份”, its identifier under 完整标识 (`actorIdentifier`).
 */
export function actorText(actorId: string, me: string): string {
  if (actorId === me) return "我";
  return roleIdPattern.test(actorId) ? "未登记名称的身份" : actorId;
}

/** The identifier to keep under 完整标识 for a person `actorText` does not name, or null. */
export function actorIdentifier(actorId: string, me: string): string | null {
  return actorId !== me && roleIdPattern.test(actorId) ? actorId : null;
}

const live = new Set<RoleRecord["state"]>(["active", "trial", "retirement-pending"]);
const order: Record<RoleRecord["state"], number> = { active: 0, trial: 1, "retirement-pending": 2, candidate: 3, deferred: 4, rejected: 5, retired: 6 };

export interface RoleGroup { key: "business" | "system" | "other"; label: string; items: RoleRecord[] }

/** Business and system roles that are established or on trial, then everything else (proposals, closed ones). */
export function roleGroups(roles: readonly RoleRecord[]): RoleGroup[] {
  const sorted = [...roles].sort((a, b) => order[a.state] - order[b.state] || a.proposal.title.localeCompare(b.proposal.title, "zh-CN"));
  const groups: RoleGroup[] = [
    { key: "business", label: "业务职责", items: sorted.filter(role => live.has(role.state) && role.proposal.roleClass !== "system") },
    { key: "system", label: "系统职责", items: sorted.filter(role => live.has(role.state) && role.proposal.roleClass === "system") },
    { key: "other", label: "提议与已关闭", items: sorted.filter(role => !live.has(role.state)) },
  ];
  return groups.filter(group => group.items.length > 0);
}

const lines = (value: string) => value.split(/\r?\n/).map(part => part.trim()).filter(Boolean);
export { lines as splitLines };
