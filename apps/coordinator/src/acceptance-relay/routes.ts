import type { FastifyInstance } from "fastify";
import type { WorkflowService } from "@evoloop/core";
import { DomainError } from "@evoloop/contracts/ports";
import { z } from "zod";
import { acceptanceArrangeSchema, acceptanceObserveSchema, acceptanceReadSchema,
  retirementApprovalSchema } from "@evoloop/contracts/acceptance-relay";
import type { AcceptanceRelayService } from "./service.js";
import type { LeaderWorkIndexReader } from "../work-management/work-index.js";

export function registerAcceptanceRelayRoutes(app: FastifyInstance, workflow: WorkflowService,
  relay: AcceptanceRelayService, workIndex?: LeaderWorkIndexReader): void {
  const params = z.strictObject({projectId:z.uuid(),taskId:z.uuid()});
  const relayParams = z.strictObject({projectId:z.uuid(),taskId:z.uuid(),relayId:z.uuid()});
  app.get("/api/projects/:projectId/acceptance-relay/overview", async request => {
    const p=z.strictObject({projectId:z.uuid()}).parse(request.params);
    const q=z.strictObject({limit:z.coerce.number().int().min(1).max(100).default(50),
      cursor:z.string().min(1).max(500).optional()}).parse(request.query);
    if(!request.principal)throw new DomainError("FORBIDDEN","Authentication required");
    await workflow.getProject(request.principal,p.projectId);
    return {work:workIndex ? await workIndex.index(request.principal,p.projectId,
      {view:"tasks",limit:q.limit,includeClosed:false,...(q.cursor?{cursor:q.cursor}:{})}) : null,
      capacity:await relay.capacity(request.principal,p.projectId),
      observedAt:new Date().toISOString()};
  });
  app.get("/api/projects/:projectId/acceptance-relay/mine", async request => {
    const p=z.strictObject({projectId:z.uuid()}).parse(request.params);
    if(!request.principal)throw new DomainError("FORBIDDEN","Authentication required");
    await workflow.getProject(request.principal,p.projectId);
    return {items:await relay.mine(request.principal,p.projectId),direct:await relay.mineDirect(request.principal,p.projectId)};
  });
  app.get("/api/projects/:projectId/tasks/:taskId/acceptance-relay", async request => {
    const p = params.parse(request.params);
    if (!request.principal) throw new DomainError("FORBIDDEN","Authentication required");
    await workflow.getProject(request.principal,p.projectId);
    return {items:await relay.list(p.projectId,p.taskId)};
  });
  app.post("/api/projects/:projectId/tasks/:taskId/acceptance-relay", async request => {
    const p = params.parse(request.params);
    const input = acceptanceArrangeSchema.parse(request.body);
    if (p.projectId !== input.projectId || p.taskId !== input.taskId)
      throw new DomainError("TARGET_MISMATCH","Route and arrangement target differ");
    if (!request.principal) throw new DomainError("FORBIDDEN","Authentication required");
    await workflow.getProject(request.principal,p.projectId);
    const arranged = await relay.arrange(request.principal,input);
    await relay.tick([p.projectId]);
    return {status:"recorded",operationId:input.operationId,arranged,
      items:await relay.list(p.projectId,p.taskId)};
  });
  app.post("/api/projects/:projectId/tasks/:taskId/acceptance-relay/:relayId/read", async request => {
    const p=relayParams.parse(request.params);
    const body=acceptanceReadSchema.parse(request.body);
    if(p.projectId!==body.projectId||p.taskId!==body.taskId||p.relayId!==body.relayId)
      throw new DomainError("TARGET_MISMATCH","Route and human read target differ");
    if(!request.principal)throw new DomainError("FORBIDDEN","Authentication required");
    await workflow.getProject(request.principal,p.projectId);
    await relay.humanRead(request.principal,p.projectId,p.taskId,p.relayId,body.operationId,body.expectedVersion,body.evidence);
    return {items:await relay.list(p.projectId,p.taskId)};
  });
  app.post("/api/projects/:projectId/tasks/:taskId/acceptance-relay/:relayId/observation", async request => {
    const p=relayParams.parse(request.params);
    const body=acceptanceObserveSchema.parse(request.body);
    if(p.projectId!==body.projectId||p.taskId!==body.taskId||p.relayId!==body.relayId)
      throw new DomainError("TARGET_MISMATCH","Route and observation target differ");
    if(!request.principal)throw new DomainError("FORBIDDEN","Authentication required");
    await workflow.getProject(request.principal,p.projectId);
    await relay.linkObservation(request.principal,p.projectId,p.taskId,p.relayId,body.observationId,
      body.operationId,body.expectedVersion);
    return {items:await relay.list(p.projectId,p.taskId)};
  });
  app.get("/api/projects/:projectId/runtime/sessions/:sessionId/retirement", async request => {
    const p=z.strictObject({projectId:z.uuid(),sessionId:z.uuid()}).parse(request.params);
    if(!request.principal)throw new DomainError("FORBIDDEN","Authentication required");
    await workflow.getProject(request.principal,p.projectId);
    return relay.retirementStatus(request.principal,p.projectId,p.sessionId);
  });
  app.post("/api/projects/:projectId/runtime/sessions/:sessionId/retirement", async request => {
    const p=z.strictObject({projectId:z.uuid(),sessionId:z.uuid()}).parse(request.params);
    const body=retirementApprovalSchema.parse(request.body);
    if(!request.principal)throw new DomainError("FORBIDDEN","Authentication required");
    await workflow.getProject(request.principal,p.projectId);
    return {status:"recorded",operationId:body.operationId,
      retirement:await relay.approveRetirement(request.principal,{...p,...body})};
  });
}
