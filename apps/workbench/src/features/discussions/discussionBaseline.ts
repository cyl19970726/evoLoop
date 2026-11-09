// What each discussion form fixes when it is sent: its baseline for the shared command form (shared/command). The form
// records it when it opens; when any part moves while the reader has typed, the form refuses to send until the reader
// has looked, and names the parts that moved.
import type { DiscussionEvent, DiscussionRecord, DiscussionTarget, Document, Goal, Stage, Task } from "@evoloop/contracts";
import { changedParts as movedParts } from "../../shared/command/rules";
import type { VerifiedDocumentHead } from "./commands";

export type Baseline = Record<string, string>;

/** The readable name of each part, for “变化的是：…”. */
export const discussionPartLabels: Readonly<Record<string, string>> = {
  discussion: "讨论版本", package: "登记的交接包", head: "文档当前版", decision: "当前决定", target: "所选对象的修订",
  goal: "目标版本", stage: "阶段版本", task: "任务修订", documents: "采纳文档的修订",
};

/** The parts whose value differs from what the reader acknowledged, as reader-facing labels. */
export function changedParts(seen: Baseline, current: Baseline): string[] {
  return movedParts(seen, current, discussionPartLabels);
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
