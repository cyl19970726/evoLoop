// Pure wording for the 分工讨论 page: what a discussion is waiting for, how its list row reads, and how linked
// objects are named. Raw IDs never appear here; they stay in the page's 来源与完整标识 block.
import type { StatusTone } from "@evoloop/ui";
import type { DiscussionEvent, DiscussionRecord, DiscussionTarget } from "@evoloop/contracts";
import type { AllocationRelation, AllocationTargetStatus, AllocationTaskAcceptanceGap } from "@evoloop/contracts/allocation-relations";
import type { ObservationSource } from "@evoloop/contracts/session-work";

export type DiscussionKind = DiscussionRecord["kind"];
export type ListScope = DiscussionKind | "all";

export const kindLabel: Record<DiscussionKind, string> = { allocation: "当前分工", direction: "下一阶段", task_collaboration: "任务协作" };
export const scopeOptions: Array<{ value: ListScope; label: string }> = [
  { value: "allocation", label: "当前分工" }, { value: "direction", label: "下一阶段" }, { value: "all", label: "全部讨论" },
];

const statusTags: Record<DiscussionRecord["status"], { label: string; tone: StatusTone }> = {
  prepared: { label: "待交接", tone: "waiting" },
  handed_off: { label: "待决定", tone: "waiting" },
  decided: { label: "已决定", tone: "idle" },
  linked: { label: "已关联", tone: "done" },
};
export function statusTag(status: DiscussionRecord["status"]): { label: string; tone: StatusTone } { return statusTags[status]; }

/** What the record proves so far and what is still open, in one sentence. */
export function statusSentence(record: Pick<DiscussionRecord, "status" | "kind">, corrected: boolean): string {
  if (record.kind === "task_collaboration") return "任务协作的消息与回执在任务页处理；这里只读回已登记的记录。";
  switch (record.status) {
    case "prepared": return "交接包已准备，还没有登记有人承接。复制交接包交给拟承接的智能体后，再登记实际观察到的承接。";
    case "handed_off": return "已登记承接观察，还没有登记讨论决定。";
    case "decided": return corrected
      ? "决定已纠正。旧决定和已链接对象仍保留；本次决定的后续对象、执行与实际使用待重新核对。"
      : "已登记讨论决定，还没有链接后续对象；执行与实际使用待核对。";
    case "linked": return "已链接本次决定的后续对象。执行与实际使用请进入对象查看实际记录。";
  }
}

export const eventLabel: Record<DiscussionEvent["kind"], string> = {
  prepared: "准备交接包", handoff: "登记承接观察", decision: "登记讨论决定", action: "链接后续对象",
  message: "消息", receipt: "收读回执", action_request: "工程动作请求", action_decision: "工程动作决定", action_execution: "外部执行回执",
};

/** List rows: an allocation or direction discussion reads by its question, a task thread by its task. */
export function listRow(record: DiscussionRecord, taskName: string | undefined, showKind: boolean, reading = false): { title: string; meta: string } {
  const status = record.kind === "task_collaboration" ? "" : statusTags[record.status].label;
  const title = record.kind === "task_collaboration" ? `任务协作 · ${nameOr(taskName, "任务", reading)}` : record.question;
  const parts = [showKind || record.kind === "direction" ? kindLabel[record.kind] : "", status].filter(Boolean);
  return { title, meta: parts.join(" · ") };
}

/** `?discussion=` selects one; `?new=1` opens the prepare form. Anything else on this address selects nothing. */
export function discussionAddress(path: string, projectId: string): { onPage: boolean; discussionId: string; preparing: boolean } {
  const [pathname, query = ""] = path.split("?");
  if (pathname !== `/p/${encodeURIComponent(projectId)}/discussions`) return { onPage: false, discussionId: "", preparing: false };
  const params = new URLSearchParams(query);
  const values = params.getAll("discussion");
  const discussionId = values.length === 1 && /^[0-9a-f-]{36}$/i.test(values[0]!) ? values[0]! : "";
  return { onPage: true, discussionId, preparing: !discussionId && params.get("new") === "1" };
}
export const discussionHref = (projectId: string, id?: string) =>
  `/p/${encodeURIComponent(projectId)}/discussions${id ? `?discussion=${encodeURIComponent(id)}` : ""}`;
export const prepareHref = (projectId: string) => `/p/${encodeURIComponent(projectId)}/discussions?new=1`;

export type TargetKind = DiscussionTarget["kind"];
export const targetKindLabel: Record<TargetKind, string> = { task: "任务", stage: "阶段", role: "职责", document: "文档" };

export const targetStatusTag: Record<AllocationTargetStatus, { label: string; tone: StatusTone }> = {
  current: { label: "当前修订", tone: "idle" },
  changed: { label: "修订已变", tone: "waiting" },
  unavailable: { label: "无法核实", tone: "unknown" },
};
export const assignmentStatusLabel: Record<Extract<AllocationRelation, { kind: "task-recipient" }>["assignmentStatus"], string> = {
  current: "当前承接", historical: "历史承接", unknown: "当前承接待核对",
};
const acceptanceGapText: Record<AllocationTaskAcceptanceGap, string> = {
  "no-assignment": "这一任务修订还没有分派记录。",
  "not-accepted": "这一任务修订已有分派，还没有接受记录。",
  "different-task-revision": "只有其他任务修订有分派记录。",
  unavailable: "这一任务固定修订暂时无法核实。",
};
/** null means an exact-revision accepted path exists (possibly on a later page); undefined means not a task. */
export function acceptanceGapSentence(gap: AllocationTaskAcceptanceGap | null | undefined): string {
  if (gap === undefined) return "";
  return gap === null ? "这一修订已有接受记录；具体接手者可能在后续页。" : acceptanceGapText[gap];
}

export const sourceKindLabel: Record<ObservationSource["kind"], string> = {
  session: "智能体", "host-link": "外部连接", role: "职责", task: "任务", run: "运行", queue: "队列", discussion: "讨论", document: "文档",
  stage: "阶段", delivery: "交付", "consumer-observation": "使用记录", message: "消息", "session-profile": "智能体资料", "task-assignment": "任务分派",
};

const limitationTexts: Record<string, string> = {
  "Fixed target revision unavailable": "有关联对象的固定修订暂时无法核实。",
  "Fixed decision document revision unavailable": "有决定依据的固定原文暂时无法核实。",
  "Page truncated to response byte limit": "这一页因响应大小限制被截短，后续关系在下一页。",
};
/** The relation reader writes its limits in English for agents; the page says them in Chinese and keeps unknown ones verbatim. */
export function limitationText(raw: string): { text: string; original: string | null } {
  const known = limitationTexts[raw];
  return known ? { text: known, original: null } : { text: "关系来源给出了一条限制，原文如下。", original: raw };
}

/** A name read for the object; while it is still being read, say so; only after that, that it could not be read — never the ID. */
export const nameOr = (name: string | undefined, kind: string, reading = false) =>
  name?.trim() || (reading ? `正在读取${kind}名称` : `${kind}名称暂不可读`);

/** The decision events in order, with which ones a later decision corrected. */
export function decisionHistory(events: readonly DiscussionEvent[], latestDecisionEventId: string | null) {
  const corrected = new Set(events.flatMap(event => event.supersedesDecisionEventId ? [event.supersedesDecisionEventId] : []));
  const decisions = events.filter(event => event.kind === "decision");
  const latest = decisions.find(event => event.id === latestDecisionEventId);
  return { latest, earlier: decisions.filter(event => event !== latest).reverse(), corrected };
}
