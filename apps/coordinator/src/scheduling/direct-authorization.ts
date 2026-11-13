import type { Pool } from "pg";

/** What the private configuration says, read afresh by the caller each time (main.ts passes loadIntegrations over the configuration file). */
export interface DirectAuthorizationConfig {
  runtime?: { enabled: boolean } | null | undefined;
  hasRuntimeGrant(scope: { projectId: string; actorId: string; roleId: string; authorizationScope: string; cwd: string; sandbox: string; model: string | null; approvalPolicy: string }): boolean;
  allowedRuntimeCwd(projectId: string, cwd: string): Promise<boolean>;
}

/**
 * Scheduled direct dispatch only sends work to a Session that `runtime.run.reserve` will then accept: the Session is ready and the private configuration
 * grants its Role execution in its scope, working directory and sandbox. The configuration is read at every trigger, so a grant withdrawn between two
 * triggers is honoured at the next one. The answer is the reason a Session is refused, or null when it may receive the work.
 */
export function sessionDenial(pool: Pool, load: () => Promise<DirectAuthorizationConfig>) {
  return async (projectId: string, sessionId: string): Promise<string | null> => {
    const current = await load();
    if (!current.runtime?.enabled) return "RUNTIME_NOT_ENABLED";
    const result = await pool.query(`SELECT actor_id, role_id, authorization_scope, cwd, sandbox, model, approval_policy FROM runtime_session WHERE project_id=$1 AND session_id=$2 AND state='ready'`, [projectId, sessionId]);
    const session = result.rows[0];
    if (!session) return "SESSION_NOT_READY";
    if (!current.hasRuntimeGrant({ projectId, actorId: session.actor_id, roleId: session.role_id, authorizationScope: session.authorization_scope, cwd: session.cwd,
      sandbox: session.sandbox, model: session.model, approvalPolicy: session.approval_policy })) return "NO_EXECUTION_GRANT";
    if (!(await current.allowedRuntimeCwd(projectId, session.cwd))) return "CWD_NOT_ALLOWED";
    return null;
  };
}
