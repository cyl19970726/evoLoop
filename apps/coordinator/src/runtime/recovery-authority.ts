import type { Principal, RuntimeSessionRecord } from "@evoloop/contracts";
import type { AuthConfig } from "../auth.js";
import { hasCurrentStudyReviewer } from "../auth.js";
import type { loadIntegrations } from "../configuration.js";

/** Pure current-file authorization. Dynamic ownership is checked by the recovery transaction itself. */
export function staticRecoveryAuthority(
  currentIntegrations: () => Promise<Awaited<ReturnType<typeof loadIntegrations>>>,
  currentIdentity: () => Promise<AuthConfig>,
) {
  return { canRevise: async (principal: Principal, session: RuntimeSessionRecord, target: {model:string;sandbox:"danger-full-access";approvalPolicy:"never"}): Promise<boolean> => {
    if (!principal.actorId || !principal.projectIds.includes(session.projectId) ||
      !principal.permissions.includes("read") || !principal.permissions.includes("write") ||
      !principal.permissions.includes("review") || !target.model) return false;
    const identity=await currentIdentity();
    if (!hasCurrentStudyReviewer(identity, session.projectId, principal.actorId) ||
      !hasCurrentStudyReviewer(identity, session.projectId, session.actorId)) return false;
    const current = await currentIntegrations();
    return !!current.runtime?.enabled && current.hasRuntimeGrant({
      projectId: session.projectId, actorId: session.actorId, roleId: session.roleId,
      authorizationScope: session.authorizationScope, cwd: session.cwd, sandbox: target.sandbox,
      model:target.model, approvalPolicy: target.approvalPolicy,
    }) && await current.allowedRuntimeCwd(session.projectId, session.cwd);
  } };
}
