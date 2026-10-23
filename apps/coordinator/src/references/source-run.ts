import type { RuntimeRunRecord, RuntimeSessionRecord } from "@evoloop/contracts";

/** A bound dynamic Session cannot become a static evidence source through a colliding tuple grant. */
export async function staticRunSessionAvailable(projectId: string, run: RuntimeRunRecord,
  session: RuntimeSessionRecord, authority: {
    runtimeEnabled: boolean;
    isBoundDynamicSession(projectId: string, sessionId: string): Promise<boolean>;
    hasRuntimeGrant(scope: {projectId:string;actorId:string;roleId:string;authorizationScope:string;
      cwd:string;sandbox:string}): boolean;
    allowedRuntimeCwd(projectId: string, cwd: string): Promise<boolean>;
  }): Promise<boolean> {
  if (!authority.runtimeEnabled || run.projectId !== projectId || session.projectId !== projectId ||
      session.state !== "ready" || await authority.isBoundDynamicSession(projectId,session.id)) return false;
  return authority.hasRuntimeGrant({projectId,actorId:run.actorId,roleId:session.roleId,
    authorizationScope:session.authorizationScope,cwd:session.cwd,sandbox:session.sandbox}) &&
    await authority.allowedRuntimeCwd(projectId,session.cwd);
}
