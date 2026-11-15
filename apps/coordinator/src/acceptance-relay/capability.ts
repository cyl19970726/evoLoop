// What keeps a Session out of acceptance capacity (`work acceptance`): the list of problems for one Session, one per cause. The coordinator builds it from
// its private configuration and the project's writers; the usability problems are the same judgement the work board, `list sessions` and the reservation use.
import type { RuntimeSessionRecord } from "@evoloop/contracts";
import type { SessionUsability } from "../runtime/session-usability.js";
import { usabilityProblems } from "../runtime/session-usability.js";

export interface CapabilityDeps {
  /** The private configuration as far as capacity needs it. */
  config(): Promise<{ boundRecipient(projectId: string, session: RuntimeSessionRecord): string | null;
    messageGrant(projectId: string, session: RuntimeSessionRecord, senderActorId: string, receiverActorId: string): boolean }>;
  executionAuthority(session: RuntimeSessionRecord): Promise<boolean>;
  projectWriter(projectId: string, actorId: string): Promise<boolean>;
  usability(projectId: string, sessionIds: string[]): Promise<Map<string, SessionUsability>>;
}

export function acceptanceCapabilityProblemsFor(deps: CapabilityDeps) {
  return async ({ projectId, session, senderActorId, receiverActorId }: { projectId: string; session: RuntimeSessionRecord; senderActorId: string; receiverActorId: string }): Promise<string[]> => {
    const problems: string[] = [];
    const config = await deps.config();
    if (session.state !== "ready" || !session.nativeThreadId || !await deps.executionAuthority(session)) problems.push("SESSION_NOT_READY");
    if (!await deps.projectWriter(projectId, senderActorId)) problems.push("SENDER_IDENTITY_UNAVAILABLE");
    if (!await deps.projectWriter(projectId, receiverActorId)) problems.push("RECEIVER_IDENTITY_UNAVAILABLE");
    if (config.boundRecipient(projectId, session) !== receiverActorId) problems.push("RECIPIENT_BINDING_MISSING");
    // A Session that cannot start work is not capacity; a judgement that fails is a problem too (fail closed).
    problems.push(...await usabilityProblems(deps.usability, projectId, session.id));
    if (!config.messageGrant(projectId, session, senderActorId, receiverActorId)) problems.push("MESSAGE_GRANT_MISSING");
    return [...new Set(problems)];
  };
}
