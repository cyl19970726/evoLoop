import type { Pool } from "pg";
import type { RuntimeRunRecord, RuntimeSessionRecord } from "@evoloop/contracts";
import type { DelegationTemplate } from "@evoloop/contracts/division";
import type { OrchestrationDispatch, OrchestrationLoop } from "@evoloop/contracts/orchestration";
import { loopIntentId } from "./runner.js";

type TemplateReader = (projectId: string, templateId: string) => Promise<{template: DelegationTemplate; hash: string} | null>;
type Spec = {projectId: string; sessionId: string; actorId: string; roleId: string;
  authorizationScope: string; cwd: string; sandbox: string; model: string | null; approvalPolicy: string};

/** Project-owned dynamic authority must resolve to one consumed, transfer-confirmed Dispatch. */
export function dynamicRuntimeAdmission(pool: Pick<Pool, "query">, getTemplate: TemplateReader, now: () => string) {
  const match = async (spec: Spec, historical = false) => {
    const rows = await pool.query(`SELECT d.data AS dispatch,l.data AS loop,p.data AS policy,b.data AS binding,
      EXISTS(SELECT 1 FROM role_definition role JOIN role_decision decision
        ON decision.project_id=role.project_id AND decision.role_id=role.role_id AND decision.decision='accept-trial'
        WHERE role.project_id=d.project_id AND role.role_id=b.role_id AND role.state IN ('trial','active')) AS role_accepted
      FROM orchestration_dispatch d JOIN orchestration_loop l ON l.project_id=d.project_id AND l.loop_id=d.loop_id
      JOIN runtime_role_binding b ON b.project_id=d.project_id AND b.binding_id=d.binding_id
      LEFT JOIN loop_policy_revision p ON p.project_id=l.project_id AND p.policy_id=l.current_policy_revision_id
      WHERE d.project_id=$1 AND d.binding_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM orchestration_event e JOIN orchestration_operation o
          ON o.project_id=e.project_id AND o.operation_id=e.operation_id AND o.actor_id=e.actor_id
        WHERE e.project_id=d.project_id AND e.kind='division.consumed' AND e.entity_type='dispatch'
          AND e.entity_id=d.dispatch_id AND o.result->>'entityType'='dispatch'
          AND o.result->>'entityId'=d.dispatch_id::text)
        AND EXISTS (SELECT 1 FROM orchestration_event e WHERE e.project_id=d.project_id
          AND e.kind='division.transferConfirmed' AND e.entity_type='dispatch' AND e.entity_id=d.dispatch_id)`, [spec.projectId]);
    const row = rows.rows.find(value => loopIntentId((value.dispatch as OrchestrationDispatch).id, "session") === spec.sessionId);
    if (!row) return null;
    const d = row.dispatch as OrchestrationDispatch, l = row.loop as OrchestrationLoop;
    const b = row.binding as {id:string; projectId:string; loopId:string; roleId:string; actorId:string;
      firstTaskId:string; parentDispatchId:string; authorizationScopeId:string;
      template:{id:string;revision:number;hash:string}; runtime:{cwd:string;model:string;sandbox:string;
        approvalPolicy:string;expiresAtUtc:string}};
    const p = row.policy as {bindingByRole:Record<string,string>} | null;
    if (d.projectId !== spec.projectId || d.bindingId !== b.id || d.loopId !== b.loopId ||
      d.taskId !== b.firstTaskId || d.parentDispatchId !== b.parentDispatchId || d.recipientRoleId !== b.roleId ||
      d.authorizationScopeId !== b.authorizationScopeId || b.actorId !== spec.actorId ||
      b.roleId !== spec.roleId || b.authorizationScopeId !== spec.authorizationScope ||
      b.runtime.cwd !== spec.cwd || b.runtime.sandbox !== spec.sandbox ||
      b.runtime.model !== spec.model || b.runtime.approvalPolicy !== spec.approvalPolicy) return null;
    if (historical) return {dispatch:d,binding:b};
    const template = await getTemplate(spec.projectId,b.template.id);
    if (l.state !== "active" || !p || p.bindingByRole[b.roleId] !== b.id || !row.role_accepted ||
      !template || template.hash !== b.template.hash || template.template.revision !== b.template.revision ||
      template.template.actorId !== spec.actorId ||
      template.template.authorizationScopeId !== spec.authorizationScope ||
      template.template.cwd !== spec.cwd || template.template.model !== spec.model ||
      template.template.sandbox !== spec.sandbox || template.template.approvalPolicy !== spec.approvalPolicy ||
      Date.parse(template.template.expiresAtUtc) <= Date.parse(now())) return null;
    return {dispatch:d,binding:b};
  };
  const spec = (session: RuntimeSessionRecord): Spec => ({
    projectId:session.projectId,sessionId:session.id,actorId:session.actorId,roleId:session.roleId,
    authorizationScope:session.authorizationScope,cwd:session.cwd,sandbox:session.sandbox,
    model:session.model,approvalPolicy:session.approvalPolicy,
  });
  return {
    isDynamicSession: async (projectId: string, sessionId: string) => {
      const result = await pool.query(`SELECT dispatch_id FROM orchestration_dispatch
        WHERE project_id=$1 AND binding_id IS NOT NULL`, [projectId]);
      return result.rows.some(row => loopIntentId(row.dispatch_id as string,"session") === sessionId);
    },
    canReserveSession: async (value: Spec) => (await match(value))?.dispatch.state === "dispatching",
    canReserveRun: async (session: RuntimeSessionRecord, runId: string, taskId: string) => {
      const found = await match(spec(session));
      return !!found && found.dispatch.state === "dispatching" &&
        loopIntentId(found.dispatch.id,"run") === runId && found.dispatch.taskId === taskId;
    },
    canCreateSession: async (session: RuntimeSessionRecord) => (await match(spec(session)))?.dispatch.state === "dispatching",
    canStartRun: async (run: RuntimeRunRecord, session: RuntimeSessionRecord) => {
      const found = await match(spec(session));
      return !!found && found.dispatch.state === "dispatching" && found.dispatch.taskId === run.taskId &&
        run.sessionId === session.id && run.actorId === session.actorId &&
        loopIntentId(found.dispatch.id,"run") === run.id;
    },
    canSettleOwned: async (session: RuntimeSessionRecord, run?: RuntimeRunRecord) => {
      const found = await match(spec(session),true);
      return !!found && (!run || run.projectId === session.projectId && run.sessionId === session.id &&
        run.actorId === session.actorId && run.taskId === found.dispatch.taskId &&
        loopIntentId(found.dispatch.id,"run") === run.id);
    },
  };
}
