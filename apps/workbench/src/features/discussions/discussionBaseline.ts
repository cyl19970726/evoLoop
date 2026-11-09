// What each discussion form fixes when it is sent. A form keeps the reader's text across rereads, so it remembers the
// baseline the reader looked at; when any part changes, the form refuses to send until the reader checks again.
import type { DiscussionEvent, DiscussionRecord, DiscussionTarget, Document, Goal, Stage, Task } from "@evoloop/contracts";
import type { VerifiedDocumentHead } from "./commands";

export type Baseline = Record<string, string>;

const partLabel: Record<string, string> = {
  discussion: "讨论版本", package: "登记的交接包", head: "文档当前版", decision: "当前决定", target: "所选对象的修订",
  goal: "目标版本", stage: "阶段版本", task: "任务修订", documents: "采纳文档的修订",
};

/** The parts whose value differs from what the reader acknowledged, as reader-facing labels. */
export function changedParts(seen: Baseline, current: Baseline): string[] {
  return [...new Set([...Object.keys(seen), ...Object.keys(current)])]
    .filter(part => (seen[part] ?? "") !== (current[part] ?? ""))
    .map(part => partLabel[part] ?? part);
}

export function handoffBaseline(record: Pick<DiscussionRecord, "version" | "currentDocumentRevisionId">): Baseline {
  return { discussion: String(record.version), package: record.currentDocumentRevisionId };
}

/** A decision also fixes the document head it continues from and the decision it corrects. */
export function decisionBaseline(record: Pick<DiscussionRecord, "version" | "currentDocumentRevisionId">, latest: Pick<DiscussionEvent, "id"> | undefined,
  head: Pick<VerifiedDocumentHead, "revisionId" | "version">): Baseline {
  return { ...handoffBaseline(record), head: `${head.revisionId}@${head.version}`, decision: latest?.id ?? "" };
}

export function targetKey(target: DiscussionTarget | undefined): string {
  if (!target) return "";
  return `${target.kind}:${target.id}@${target.kind === "stage" ? `v${target.version}` : target.revisionId}`;
}

export function linkBaseline(record: Pick<DiscussionRecord, "version">, decision: Pick<DiscussionEvent, "id">, target: DiscussionTarget | undefined): Baseline {
  return { discussion: String(record.version), decision: decision.id, target: targetKey(target) };
}

export interface PrepareSelection { goalId: string; stageId: string; taskId: string; documentIds: readonly string[] }
export interface PrepareLists { goals: Goal[]; stages: Stage[]; tasks: Task[]; documents: Document[] }

/** The revision of each picked object as read now; a picked object that is gone reads as "missing". */
export function preparePart(lists: PrepareLists, part: "goal" | "stage" | "task" | "documents", selection: PrepareSelection): string {
  if (part === "goal") return selection.goalId ? `${selection.goalId}@${lists.goals.find(item => item.id === selection.goalId)?.version ?? "missing"}` : "";
  if (part === "stage") return selection.stageId ? `${selection.stageId}@${lists.stages.find(item => item.id === selection.stageId)?.version ?? "missing"}` : "";
  if (part === "task") return selection.taskId ? `${selection.taskId}@${lists.tasks.find(item => item.id === selection.taskId)?.currentRevisionId ?? "missing"}` : "";
  return [...selection.documentIds].sort()
    .map(id => `${id}@${lists.documents.find(item => item.id === id)?.adoptedRevisionId ?? "missing"}`).join(",");
}

export function prepareBaseline(lists: PrepareLists, selection: PrepareSelection): Baseline {
  return { goal: preparePart(lists, "goal", selection), stage: preparePart(lists, "stage", selection),
    task: preparePart(lists, "task", selection), documents: preparePart(lists, "documents", selection) };
}
