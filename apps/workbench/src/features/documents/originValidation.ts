import type { Document, TaskRevision } from "@evoloop/contracts";
import type { RuntimeRunRecord } from "@evoloop/contracts/runtime";

export type DocumentOrigin = NonNullable<Document["origin"]>;

/** Only the exact recorded revision may supply a human title for a document's origin. */
export function verifiedOriginTask(projectId: string, origin: DocumentOrigin,
  revision: TaskRevision): TaskRevision | null {
  return revision.projectId === projectId && revision.taskId === origin.taskId &&
    revision.id === origin.taskRevisionId ? revision : null;
}

/** A Run is shown only when its readback belongs to the same fixed Task revision. */
export function verifiedOriginRun(projectId: string, origin: DocumentOrigin,
  run: RuntimeRunRecord): RuntimeRunRecord | null {
  return origin.runId && run.projectId === projectId && run.id === origin.runId &&
    run.taskId === origin.taskId && run.taskRevisionId === origin.taskRevisionId ? run : null;
}
