// Git 与外部来源登记: how recorded decisions and fixed sources are named, and which entry of each slot is its head.
import type { EpistemicStatus, KnowledgeValidity } from "@evoloop/contracts/knowledge";
import type { TaskExternalReferenceRecord } from "@evoloop/contracts/references";

export const referenceDecisionLabel: Record<TaskExternalReferenceRecord["decision"], string> = { adopt: "采用", retain: "保留", replace: "替换" };
export const referenceKindLabel: Record<TaskExternalReferenceRecord["kind"], string> = { git: "Git 文件", wiki: "知识页", run: "受管运行" };
export const formalDecisionLabel = { adopted: "人工认定为正式依据", rejected: "人工拒绝纳入", incorporated: "人工确认已纳入该过程修订" } as const;
export const validityLabel: Record<KnowledgeValidity, string> = { valid: "有效", needs_review: "待复核", withdrawn: "已撤回" };
export const epistemicLabel: Record<EpistemicStatus, string> = {
  observation: "观察", inference: "推断", hypothesis: "假设", adopted: "已采纳判断", disputed: "有争议", superseded: "已取代",
};

export const hashPattern = /^[a-f0-9]{64}$/;
export const commitPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

/** The latest decision of every slot: only that one can be reviewed again (保留 or 替换). */
export function slotHeads(history: TaskExternalReferenceRecord[]): Map<string, TaskExternalReferenceRecord> {
  const heads = new Map<string, TaskExternalReferenceRecord>();
  for (const item of history) if ((heads.get(item.slotId)?.version ?? 0) < item.version) heads.set(item.slotId, item);
  return heads;
}

/** One line for a recorded decision: what was decided, on which kind of source, in which version of its slot. */
export function referenceLine(item: Pick<TaskExternalReferenceRecord, "decision" | "kind" | "version">): string {
  return `${referenceDecisionLabel[item.decision] ?? "决定"} · ${referenceKindLabel[item.kind] ?? "外部来源"} · 这一依据位置的第 ${item.version} 版`;
}
