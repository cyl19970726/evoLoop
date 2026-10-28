import type { Task } from "@evoloop/contracts";
import type { EvaluationSourceSignature } from "@evoloop/contracts/evaluation";
import { DomainError, type Reader } from "@evoloop/contracts/ports";

const need = <T>(value: T | null, name: string): T => {
  if (value === null) throw new DomainError("NOT_FOUND", `${name} not found`);
  return value;
};
const fixedOrder = <T>(items: T[], key: (item: T) => string) =>
  [...items].sort((a, b) => key(a).localeCompare(key(b)));

/** Business input only: omit lifecycle revision IDs, run state and delivery metadata. */
export async function taskInputSignature(tx: Reader, task: Task,
  revisionId = task.currentRevisionId): Promise<EvaluationSourceSignature & { content: string }> {
  const revision = need(await tx.getTaskRevision(task.id, revisionId), "source Task revision");
  if (revision.projectId !== task.projectId || revision.taskId !== task.id || revision.id !== revisionId)
    throw new DomainError("TASK_INPUT_MISMATCH", "Task revision does not belong to the selected Task");
  const basis = need(revision.basisSetId ? await tx.getBasisSet(task.id, revision.id, revision.basisSetId) : null,
    "source sealed basis");
  if (basis.projectId !== task.projectId || basis.taskId !== task.id || basis.taskRevisionId !== revision.id || basis.id !== revision.basisSetId)
    throw new DomainError("TASK_INPUT_MISMATCH", "Sealed basis does not belong to the selected Task revision");
  const external = await tx.listTaskExternalSnapshot(task.id, revision.id);
  const proposal = await tx.getTaskProposal(task.id, revision.id);
  const members = await Promise.all(basis.members.map(async item => {
    const source = need(await tx.getDocumentRevision(item.documentId, item.revisionId), "source basis document");
    if (source.projectId !== task.projectId || source.documentId !== item.documentId || source.id !== item.revisionId)
      throw new DomainError("TASK_INPUT_MISMATCH", "Fixed source does not match the selected Task basis");
    return { ...item, contentHash: source.contentHash };
  }));
  return { title: revision.title, content: revision.content,
    contentDocumentId: revision.contentDocumentId, contentRevisionId: revision.contentRevisionId,
    acceptance: revision.acceptance, owner: revision.owner, kind: revision.kind ?? "unclassified",
    ...(proposal?.acceptanceMode ? { acceptancePolicy: { mode: proposal.acceptanceMode,
      consumer: proposal.consumer, useRequired: true as const } } : {}),
    // Keep the legacy serialized shape when no domain was selected; persisted evaluations omit this key.
    ...(revision.domainId ? { domainId: revision.domainId } : {}),
    basis: fixedOrder(members, item => item.documentId),
    retentions: fixedOrder(basis.retentions ?? [], item => item.documentId),
    external: fixedOrder(external.map(item => ({ slotId: item.slotId, kind: item.kind,
      referenceId: item.referenceId, revision: item.revision, contentHash: item.contentHash })), item => item.slotId) };
}

export function canonicalTaskInputJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalTaskInputJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalTaskInputJson(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
