import type { RuntimeSessionRecord } from "@evoloop/contracts/runtime";

/** A saved target profile alone does not authorize a new Run. */
export function activeFullExecution(session: RuntimeSessionRecord): boolean {
  const profile = session.executionProfile;
  return session.state === "ready" && session.sandbox === "danger-full-access" && session.approvalPolicy === "never"
    && !!profile && profile.activationState === "active" && profile.activeRevisionId === profile.revision.revisionId
    && profile.revision.sandbox === "danger-full-access" && profile.revision.approvalPolicy === "never"
    && profile.revision.model === session.model && profile.revision.cwd === session.cwd
    && profile.revision.authorizationScope === session.authorizationScope;
}
