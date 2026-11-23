// What the document page's relation bar says, as pure functions over what the page already read (no request of its own).
import type { DocumentTaskReference, TaskDetail } from "@evoloop/contracts";
import { observationResultLabel } from "../workflow";

/** The service's own rule for "this delivery's artifact is this document" (adapter-postgres: document:<id>@… or the document's own address). */
export function artifactIsDocument(artifactRef: string, projectId: string, documentId: string): boolean {
  return artifactRef.startsWith(`document:${documentId}@`) || artifactRef.startsWith(`#/p/${projectId}/documents/${documentId}?revision=`);
}

export const awaitingAcceptance = "待验收";

/** The newest delivery that names the document as its artifact, with the newest acceptance answer for it: 待验收 until one exists. */
export function documentDelivery(detail: Pick<TaskDetail, "deliveries" | "observations">, projectId: string, documentId: string): { word: string } | null {
  const delivery = [...(detail.deliveries ?? [])].filter(item => artifactIsDocument(item.artifactRef, projectId, documentId))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt)).at(-1);
  if (!delivery) return null;
  const answer = [...(detail.observations ?? [])].filter(item => item.deliveryId === delivery.id).sort((a, b) => a.createdAt.localeCompare(b.createdAt)).at(-1);
  return { word: answer ? observationResultLabel[answer.result] : awaitingAcceptance };
}

/** The task the bar names when the document has no 所属任务: only a single referencing task is named; several are counted. */
export type TaskItem =
  | { kind: "primary" }
  | { kind: "only"; task: DocumentTaskReference }
  | { kind: "many"; count: number }
  | { kind: "none" };
export function taskItem(primaryTaskId: string | null | undefined, tasks: DocumentTaskReference[]): TaskItem {
  if (primaryTaskId) return { kind: "primary" };
  if (tasks.length === 1) return { kind: "only", task: tasks[0]! };
  return tasks.length > 1 ? { kind: "many", count: tasks.length } : { kind: "none" };
}
