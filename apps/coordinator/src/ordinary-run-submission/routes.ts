import type { FastifyInstance } from "fastify";
import type { Principal, RuntimeRunRecord } from "@evoloop/contracts";
import { ordinaryRunSubmissionSchema, type OrdinaryRunSubmissionCommand,
  type OrdinaryRunSubmissionRecord } from "@evoloop/contracts/ordinary-run-submission";
import { DomainError } from "@evoloop/contracts/ports";
import { z } from "zod";

export interface OrdinaryRunSubmissionRoutes {
  submit(principal: Principal, command: OrdinaryRunSubmissionCommand): Promise<OrdinaryRunSubmissionRecord>;
  getByOperation(principal: Principal, projectId: string, operationId: string): Promise<OrdinaryRunSubmissionRecord | null>;
  getByRun(principal: Principal, projectId: string, runId: string): Promise<OrdinaryRunSubmissionRecord | null>;
  readRun(projectId: string, runId: string): Promise<RuntimeRunRecord | null>;
}

export function registerOrdinaryRunSubmissionRoutes(app: FastifyInstance, service: OrdinaryRunSubmissionRoutes): void {
  const who = (principal: Principal | null): Principal => {
    if (!principal) throw new DomainError("FORBIDDEN", "Authentication required");
    return principal;
  };
  app.post("/api/projects/:projectId/ordinary-runs/submissions", async request => {
    const { projectId } = z.strictObject({ projectId: z.uuid() }).parse(request.params);
    const command = ordinaryRunSubmissionSchema.parse(request.body);
    if (command.projectId !== projectId) throw new DomainError("PROJECT_SCOPE", "Request project differs from submission");
    if (request.workerIdentity) throw new DomainError("FORBIDDEN", "Managed workers use their brokered submission route");
    const record = await service.submit(who(request.principal), command);
    return { status: "recorded" as const, operationId: record.operationId, submissionId: record.id,
      runId: record.runId, state: record.state, submittedBy: record.submittedBy };
  });
  app.get("/api/projects/:projectId/ordinary-runs/operations/:operationId", async (request, reply) => {
    const { projectId, operationId } = z.strictObject({ projectId: z.uuid(), operationId: z.uuid() }).parse(request.params);
    const record = await service.getByOperation(who(request.principal), projectId, operationId);
    return record ? { status: "recorded" as const, operationId: record.operationId, submission: record } :
      reply.code(404).send({ code: "OPERATION_NOT_FOUND", message: "Preserve the original submission intent and operation ID" });
  });
  app.get("/api/projects/:projectId/ordinary-runs/:runId/submission", async request => {
    const { projectId, runId } = z.strictObject({ projectId: z.uuid(), runId: z.uuid() }).parse(request.params);
    const record = await service.getByRun(who(request.principal), projectId, runId);
    const run = record?.state === "sealed" ? await service.readRun(projectId, runId) : null;
    const stale = record?.state === "sealed" && (!run || run.version !== record.terminalRunVersion ||
      (record.deliveryIntent.technicalResult === "passed" && run.state !== "completed"));
    return record ? { status: stale ? "blocked" as const : record.state, submission: record,
      ...(stale ? { reason: "TERMINAL_RUN_VERSION_CHANGED" } : {}) } :
      { status: "absent" as const, reason: "SUBMISSION_ABSENT", runId };
  });
}
