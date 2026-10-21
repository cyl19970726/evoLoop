import type { FastifyInstance } from "fastify";
import type { Principal } from "@evoloop/contracts";
import type { EvaluationFixedRef } from "@evoloop/contracts/evaluation";
import { DomainError } from "@evoloop/contracts/ports";
import type { WorkflowService } from "@evoloop/core";
import { z } from "zod";

export interface EvaluationPacketRead {
  content: string; contentHash: string; manifestHash: string; builderVersion: string; sources: EvaluationFixedRef[];
}
export type ReadEvaluationPacket = (principal: Principal, projectId: string, runId: string) => Promise<EvaluationPacketRead>;

export function registerEvaluationRoutes(app: FastifyInstance, service: WorkflowService, readPacket?: ReadEvaluationPacket) {
  const params = (value: unknown) => z.object({ projectId: z.uuid(), id: z.uuid().optional(),
    taskId: z.uuid().optional(), attemptId: z.uuid().optional() }).parse(value);
  const who = (request: { principal: Principal | null }) => {
    if (!request.principal) throw new DomainError("FORBIDDEN", "Authentication required");
    return request.principal;
  };
  app.get("/api/projects/:projectId/evaluations", request => {
    const p = params(request.params);
    const q = z.strictObject({ limit: z.coerce.number().int().min(1).max(100).default(50), cursor: z.uuid().optional(),
      taskId: z.uuid().optional(), knowledgePageId: z.uuid().optional() }).parse(request.query);
    return service.listEvaluations(who(request), p.projectId, q.limit, q.cursor, q.taskId, q.knowledgePageId);
  });
  app.get("/api/projects/:projectId/evaluations/source-task/:taskId", request => {
    const p = params(request.params);
    return service.getEvaluationSourceTask(who(request), p.projectId, p.taskId!);
  });
  app.get("/api/projects/:projectId/evaluations/:id", async request => {
    const p = params(request.params), principal = who(request);
    const q = z.strictObject({ revision: z.uuid().optional() }).parse(request.query);
    const revision = await service.getEvaluation(principal, p.projectId, p.id!, q.revision);
    const [revisions, attempts, assessments, conclusions] = await Promise.all([
      service.listEvaluationRevisions(principal, p.projectId, p.id!),
      service.listEvaluationAttempts(principal, p.projectId, p.id!, revision.id),
      service.listEvaluationAssessments(principal, p.projectId, p.id!, revision.id),
      service.listEvaluationConclusions(principal, p.projectId, p.id!, revision.id),
    ]);
    return { revision, revisions, attempts, assessments, conclusions };
  });
  app.get("/api/projects/:projectId/evaluations/:id/attempts/:attemptId/packet", async request => {
    const p = params(request.params), principal = who(request);
    const q = z.strictObject({ revision: z.uuid() }).parse(request.query);
    await service.getEvaluation(principal, p.projectId, p.id!, q.revision);
    const attempts = await service.listEvaluationAttempts(principal, p.projectId, p.id!, q.revision);
    const attempt = attempts.find(item => item.id === p.attemptId);
    if (!attempt) throw new DomainError("NOT_FOUND", "Attempt is not in this fixed evaluation revision");
    const run = await service.getRuntimeRun(principal, p.projectId, attempt.runId);
    const binding = run.evaluationBinding;
    if (!binding || binding.evaluationId !== p.id || binding.revisionId !== q.revision
      || binding.attemptId !== attempt.id || run.taskRevisionId !== attempt.actualTaskRevisionId)
      throw new DomainError("ATTEMPT_RUN_MISMATCH", "Attempt does not match the recorded execution");
    if (!run.evaluationPacket) throw new DomainError("PACKET_UNAVAILABLE", "No actual dispatch packet was saved for this attempt");
    if (!readPacket) throw new DomainError("PACKET_UNAVAILABLE", "Controlled packet reader is unavailable");
    return readPacket(principal, p.projectId, run.id);
  });
}
