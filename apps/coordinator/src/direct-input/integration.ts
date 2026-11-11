import type { Pool } from "pg";
import type { Principal } from "@evoloop/contracts";
import type { RuntimeSessionRecord } from "@evoloop/contracts/runtime";
import type { UnitOfWork } from "@evoloop/contracts/ports";
import { DomainError } from "@evoloop/contracts/ports";
import { PgDirectInputs } from "@evoloop/adapter-postgres/direct-input";
import { bindingOf } from "../runtime/runner.js";
import type { SessionSteerLock } from "../runtime/session-steer-lock.js";
import type { loadIntegrations } from "../configuration.js";
import type { DirectInputConfiguration } from "./configuration.js";
import { DirectInputService } from "./service.js";

type CurrentConfiguration=Pick<Awaited<ReturnType<typeof loadIntegrations>>,"sessionMessages">&{
  directInputs:DirectInputConfiguration|undefined;
};

/** One composition point for capability and submission; direct grants never replace ordinary grants. */
export function createDirectInputService(deps:{
  pool:Pool;uow:UnitOfWork;
  runtime:ConstructorParameters<typeof DirectInputService>[0]["runtime"];
  lock?:SessionSteerLock;
  canWrite():boolean;
  configuration():Promise<CurrentConfiguration>;
  currentProjectWriter(projectId:string,actorId:string):Promise<boolean>;
  currentSessionExecutionAuthority(session:RuntimeSessionRecord):Promise<boolean>;
  allowedCwd(projectId:string,cwd:string):Promise<boolean>;
}):DirectInputService{
  const session=async(projectId:string,sessionId:string):Promise<RuntimeSessionRecord>=>{
    const value=await deps.uow.read(projectId,r=>r.getRuntimeSession(sessionId));
    if(!value||value.projectId!==projectId||value.id!==sessionId||value.state!=="ready"||
      !value.nativeThreadId||!value.nativeSessionId||value.sandbox!=="danger-full-access"||
      value.approvalPolicy!=="never"||value.executionProfile?.activationState!=="active")
      throw new DomainError("SESSION_NOT_READY","Exact owned Session full profile is unavailable");
    return value;
  };
  return new DirectInputService({
    store:new PgDirectInputs(deps.pool),runtime:deps.runtime,canWrite:deps.canWrite,
    ...(deps.lock?{lock:deps.lock}:{}),
    bindingFor:async(projectId,sessionId)=>bindingOf(await session(projectId,sessionId)),
    admission:async(principal:Principal,projectId,sessionId)=>{
      if(!principal.projectIds.includes(projectId)||!principal.permissions.includes("read")||
        !principal.permissions.includes("write"))throw new DomainError("FORBIDDEN","Project writer required");
      const owner=await session(projectId,sessionId);
      const configured=await deps.configuration();
      const direct=configured.directInputs;
      const directGrant=direct?.enabled?direct.grants.find(g=>g.projectId===projectId&&g.sessionId===sessionId&&
        g.senderActorId===principal.actorId&& (g.canStart||g.canSteer)):null;
      const ordinary=configured.sessionMessages?.enabled?configured.sessionMessages.grants.find(g=>g.enabled&&
        g.projectId===projectId&&g.sessionId===sessionId&&g.senderActorId===principal.actorId&&
        g.receiverRoleId===owner.roleId&&g.cwd===owner.cwd&&g.receiverActorId===owner.actorId):null;
      if(!directGrant||!ordinary||!await deps.currentProjectWriter(projectId,principal.actorId)||
        !await deps.currentProjectWriter(projectId,ordinary.receiverActorId)||
        !await deps.currentSessionExecutionAuthority(owner)||!await deps.allowedCwd(projectId,owner.cwd))
        throw new DomainError("DIRECT_GRANT_MISSING","Exact direct and ordinary Session grants are unavailable");
      return {grant:{...ordinary,canSteer:directGrant.canSteer,canStart:directGrant.canStart},binding:bindingOf(owner)};
    },
  });
}
