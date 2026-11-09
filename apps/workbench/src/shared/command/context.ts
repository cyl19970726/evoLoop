// What every write needs from the page: who writes in which project, whether an operation with an unknown result
// blocks further writes, and the receipt hooks. `onAttempt` saves the recovery receipt and intent before anything is
// sent (App.tsx); `onKnown` removes it once the result is known; `onChanged` rereads the project.
import type { Operation, Principal } from "@evoloop/contracts";

/** The part of a command that its recovery receipt names. */
export interface RecoverableCommand {
  projectId: string; operationId: string; type: Operation["commandType"];
  taskId?: string; goalId?: string; stageId?: string | null; documentId?: string; discussionId?: string;
}

export interface MutationContext {
  token: string; projectId: string; principal: Principal; blocked: boolean;
  /** ActionForm: names the object a kept draft is for (it is part of the draft key, with the identity, project and title). */
  draftScope?: string;
  /** ActionForm: the fixed inputs the form opened on, as one string (prefer ActionForm's `baseline`, which names each). */
  draftBaseline?: string;
  onAttempt(command: RecoverableCommand): boolean | Promise<boolean>; onKnown(operationId: string): void; onChanged(): void;
}
