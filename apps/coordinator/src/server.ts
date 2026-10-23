import { registerReferenceRoutes, type ReferenceRouteOptions } from "./references/routes.js";
import Fastify from "fastify";
import staticPlugin from "@fastify/static";
import { commandSchema, capabilities, idSchema, type Principal } from "@evoloop/contracts";
import { DomainError } from "@evoloop/contracts/ports";
import type { WorkflowService } from "@evoloop/core";
import { authenticate, authConfigSchema, type AuthConfig } from "./auth.js";
import { z } from "zod";
import type { RuntimeRunner } from "./runtime/runner.js";
import { runtimeReconcileSchema } from "@evoloop/contracts/runtime";
import type { RuntimeGrant } from "./configuration.js";
import { registerDocumentRoutes, type DocumentRouteOptions } from "./documents/routes.js";
import { registerCollaborationRoutes } from "./collaboration/routes.js";
import type { CollaborationRunner } from "./collaboration/runner.js";
import type { DeliveryStore } from "@evoloop/contracts/delivery";
import type { ScheduleGrant, SchedulingPump } from "./scheduling/pump.js";
import { registerKnowledgeRoutes, type KnowledgeRouteOptions } from "./knowledge/routes.js";
import { registerWorkManagementRoutes } from "./work-management/routes.js";
import { registerEvaluationRoutes, type ReadEvaluationPacket } from "./evaluation/routes.js";
import { OrchestrationError } from "@evoloop/core/orchestration";
import { registerOrchestrationRoutes, type OrchestrationRouteOptions } from "./orchestration/routes.js";
import { authorizeWorkerRequest, type WorkerGuardFacts } from "./workers/guard.js";
import type { WorkerIdentity } from "./workers/types.js";

declare module "fastify" { interface FastifyRequest { principal: Principal | null; workerIdentity: WorkerIdentity | null } }
const pageSchema = z.object({ limit: z.coerce.number().int().min(1).max(100).default(50), cursor: idSchema.optional() });
const errorStatus = (code: string) => code === "FORBIDDEN" ? 403 : code === "NOT_FOUND" ? 404 : 409;
export async function buildServer(options: {
  service: WorkflowService; credentials: AuthConfig; webRoot?: string; canWrite?: () => boolean;
  runtime?: RuntimeRunner; allowedRuntimeCwds?: (projectId: string) => string[];
  allowedRuntimeCwd?: (projectId: string, cwd: string) => Promise<boolean>;
  hasRuntimeGrant?: (scope: RuntimeGrant) => boolean;
  runtimeGrants?: (projectId: string, actorId: string) => RuntimeGrant[];
  references?: ReferenceRouteOptions;
  scheduling?: SchedulingPump;
  schedulingGrants?: (projectId: string, actorId: string) => ScheduleGrant[];
  collaboration?: {runner: CollaborationRunner; store: DeliveryStore; consumerId: string; hasGrant(projectId:string,actorId:string):boolean};
  documents?: Omit<DocumentRouteOptions, "workflow">;
  knowledge?: Omit<KnowledgeRouteOptions, "workflow">;
  readEvaluationPacket?: ReadEvaluationPacket;
  orchestration?: OrchestrationRouteOptions;
  workers?: { authenticate(header: string | undefined): Promise<WorkerIdentity | null>; facts(identity: WorkerIdentity): WorkerGuardFacts };
  sourceConfiguration?(principal: Principal | null): {git: boolean; wiki: boolean};
}) {
  const credentials = authConfigSchema.parse(options.credentials);
  const app = Fastify({ logger: false, bodyLimit: 128 * 1024 });
  app.decorateRequest("principal", null);
  app.decorateRequest("workerIdentity", null);
  app.addHook("onRequest", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "no-referrer");
    reply.header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' blob:; connect-src 'self'; img-src 'self' data: blob:; font-src 'self' data:; media-src 'self' data:; frame-src 'self' blob:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'");
    if (!request.url.startsWith("/api/")) return;
    request.principal = authenticate(request.headers.authorization, credentials);
    if (!request.principal && options.workers) {
      request.workerIdentity = await options.workers.authenticate(request.headers.authorization);
      request.principal = request.workerIdentity?.principal ?? null;
    }
    if (!request.principal) return reply.code(401).send({ code: "UNAUTHENTICATED", message: "需要有效的本机访问令牌。" });
    if (request.method !== "GET" && request.method !== "HEAD" && options.canWrite && !options.canWrite()) {
      return reply.code(503).send({ code: "UNAVAILABLE", message: "协调者资格不可用；请保留操作 ID 并回读。" });
    }
  });
  // Body-aware scope authorization applies to every worker API request, including plugin routes.
  app.addHook("preValidation", async (request, reply) => {
    if (request.workerIdentity && (!options.workers || !await authorizeWorkerRequest(request.workerIdentity,
      {method: request.method, path: request.url, body: request.body}, options.workers.facts(request.workerIdentity))))
      return reply.code(403).send({code: "FORBIDDEN", message: "当前执行身份没有此对象或操作的授权。"});
  });
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof z.ZodError) {
      return reply.code(400).send({ code: "INVALID_INPUT", message: "输入不符合当前接口合同。", issues: error.issues.map(x => ({ path: x.path, code: x.code })) });
    }
    if (error instanceof DomainError) return reply.code(errorStatus(error.code)).send({ code: error.code, message: error.message, ...(error.currentVersion === undefined ? {} : { currentVersion: error.currentVersion }) });
    if (error instanceof OrchestrationError) return reply.code(errorStatus(error.code)).send({ code: error.code, message: error.message, ...(error.currentVersion === undefined ? {} : { currentVersion: error.currentVersion }) });
    if (typeof error === "object" && error !== null && "statusCode" in error) {
      if (error.statusCode === 413) return reply.code(413).send({ code: "TOO_LARGE", message: "请求超过本片大小限制。" });
      if (error.statusCode === 400) return reply.code(400).send({ code: "INVALID_INPUT", message: "请求格式不合法。" });
    }
    // A failed connection/response is not proof that the database commit failed.
    return reply.code(503).send({ code: "RESULT_UNCONFIRMED", message: "暂时无法确认结果。写操作请保留原操作 ID 并查询记录。", requestId: request.id });
  });
  const who = (p: Principal | null) => { if (!p) throw new DomainError("FORBIDDEN", "未认证"); return p; };
  const params = (value: unknown) => z.record(z.string(), idSchema).parse(value);
  const callerGrants = (projectId:string,actorId:string) => (options.runtimeGrants?.(projectId,actorId) ?? []).filter(g=>g.projectId===projectId && g.actorId===actorId);
  const callerSchedulingGrants = (projectId: string, actorId: string) =>
    (options.schedulingGrants?.(projectId, actorId) ?? []).filter(g => g.projectId === projectId && g.actorId === actorId);
  const currentCapabilities = (principal: Principal | null = null) => ({ ...capabilities,
    ...(options.sourceConfiguration?.(principal) ?? {}), goalWorkflow: true, html: !!options.documents,
    documentOriginals: !!options.documents, knowledge: !!options.knowledge, runtime: options.runtime?.status().available ?? false,
    sourceConfiguration: options.sourceConfiguration?.(principal) ?? {git: false, wiki: false},
  });
  app.get("/health", async () => ({ status: options.canWrite?.() === false ? "unavailable" : "ok", capabilities: currentCapabilities() }));
  app.get("/api/session", async request => ({ principal: who(request.principal), capabilities: currentCapabilities(request.principal) }));
  app.post("/api/commands", async (request, reply) => {
    const command = commandSchema.parse(request.body);
    if (command.type.startsWith("runtime.")) {
      if (command.type !== "runtime.handoff.record" && command.type !== "runtime.run.abandonReadOnly" && !options.runtime?.status().available) throw new DomainError("RUNTIME_UNAVAILABLE", "Codex 执行服务尚未配置或当前不可用；本次未登记派发。");
      const principal = who(request.principal);
      if (!principal.projectIds.includes(command.projectId) || (command.type === "runtime.handoff.record" ? !principal.permissions.includes("write") : !principal.permissions.includes("review"))) {
        throw new DomainError("FORBIDDEN", "执行操作需要本项目复核权限。");
      }
      if (command.type === "runtime.session.reserve") {
        if (!options.hasRuntimeGrant?.({ projectId: command.projectId, actorId: principal.actorId,
          roleId: command.roleId, authorizationScope: command.authorizationScope, cwd: command.cwd, sandbox: command.sandbox }) ||
          !await options.allowedRuntimeCwd?.(command.projectId, command.cwd)) {
          throw new DomainError("FORBIDDEN", "执行职责、范围、目录与权限须与项目授权完全一致。");
        }
      }
      if (command.type === "runtime.run.reserve") {
        const session = await options.service.getRuntimeSession(principal, command.projectId, command.sessionId);
        if (!options.hasRuntimeGrant?.({ projectId: command.projectId, actorId: principal.actorId,
          roleId: session.roleId, authorizationScope: session.authorizationScope, cwd: session.cwd, sandbox: session.sandbox })) {
          throw new DomainError("FORBIDDEN", "当前请求者未获该职责和范围的执行授权。");
        }
      }
    }
    if (command.type === "schedule.create" || (command.type === "schedule.revise" && command.state === "active")) {
      const principal = who(request.principal);
      if (!principal.projectIds.includes(command.projectId) || !principal.permissions.includes("review") ||
        !callerSchedulingGrants(command.projectId, principal.actorId).some(grant =>
          grant.scopeId === command.authorization.scopeId && grant.roleId === command.authorization.roleId)) {
        throw new DomainError("FORBIDDEN", "当前身份没有此项目、范围和职责的日程授权。");
      }
    }
    const result = await options.service.execute(who(request.principal), command);
    return reply.code(result.status === "applied" ? 200 : errorStatus(result.code)).send(result);
  });
  app.get("/api/projects/:projectId", async request => options.service.getProject(who(request.principal), params(request.params).projectId!));
  app.get("/api/projects/:projectId/scheduling/status", async request => {
    const projectId = params(request.params).projectId!;
    const principal = who(request.principal);
    await options.service.getProject(principal, projectId);
    const status = options.scheduling?.status() ?? { state: "disabled", lastTickAt: null, lastError: null, lastCreated: 0 };
    return { ...status, grants: status.state === "disabled" ? [] : callerSchedulingGrants(projectId, principal.actorId) };
  });
  app.get("/api/projects/:projectId/runtime", async request => {
    const projectId = params(request.params).projectId!;
    await options.service.getProject(who(request.principal), projectId);
    return { ...(options.runtime?.status() ?? { available: false, error: "尚未配置 Codex 执行服务" }), allowedCwds: [...new Set(callerGrants(projectId,who(request.principal).actorId).map(g=>g.cwd))], grants: callerGrants(projectId,who(request.principal).actorId) };
  });
  app.get("/api/projects/:projectId/runtime/sessions", async request => options.service.listRuntimeSessions(who(request.principal), params(request.params).projectId!));
  app.get("/api/projects/:projectId/runtime/sessions/:id/history", async request => {
    const p = params(request.params);
    if (!options.runtime?.status().available) throw new DomainError("RUNTIME_UNAVAILABLE", "执行服务不可用，无法声称历史完整。");
    return options.runtime.history(who(request.principal), p.projectId!, p.id!);
  });
  app.get("/api/projects/:projectId/runtime/sessions/:id/events", async request => {
    const p = params(request.params); return options.service.listRuntimeSessionEvents(who(request.principal), p.projectId!, p.id!);
  });
  app.post("/api/projects/:projectId/runtime/recover", async request => {
    const projectId = params(request.params).projectId!;
    const principal = who(request.principal);
    if (!principal.projectIds.includes(projectId) || !principal.permissions.includes("review")) throw new DomainError("FORBIDDEN", "恢复执行服务需要本项目复核权限。");
    await options.service.getProject(principal, projectId);
    if (!options.runtime) throw new DomainError("RUNTIME_UNAVAILABLE", "执行服务尚未配置。");
    if (!callerGrants(projectId, principal.actorId).length) throw new DomainError("FORBIDDEN", "当前身份没有本项目的执行恢复授权。");
    if (options.runtime.status().available) return options.runtime.status();
    await options.runtime.recover();
    return options.runtime.status();
  });
  app.get("/api/projects/:projectId/runtime/runs", async request => {
    const projectId = params(request.params).projectId!;
    const query = z.object({ taskId: idSchema.optional() }).parse(request.query);
    return options.service.listRuntimeRuns(who(request.principal), projectId, query.taskId);
  });
  app.get("/api/projects/:projectId/runtime/runs/:id", async request => {
    const p = params(request.params); return options.service.getRuntimeRun(who(request.principal), p.projectId!, p.id!);
  });
  app.get("/api/projects/:projectId/runtime/runs/:id/events", async request => {
    const p = params(request.params); return options.service.listRuntimeEvents(who(request.principal), p.projectId!, p.id!);
  });
  app.get("/api/projects/:projectId/runtime/runs/:id/result", async request => {
    const p = params(request.params);
    if (!options.runtime?.status().available) throw new DomainError("RUNTIME_UNAVAILABLE", "执行服务不可用；已保存的运行状态仍可读取。");
    return options.runtime.result(who(request.principal), p.projectId!, p.id!);
  });
  app.get("/api/projects/:projectId/runtime/runs/:id/trace", async request => {
    const p = params(request.params);
    const principal = who(request.principal);
    if (!principal.projectIds.includes(p.projectId!) || !principal.permissions.includes("read") || !principal.permissions.includes("review"))
      throw new DomainError("FORBIDDEN", "读取工作轨迹需要本项目读取和复核权限。");
    if (!options.runtime?.status().available) throw new DomainError("RUNTIME_UNAVAILABLE", "执行服务不可用，无法读取原生工作轨迹。");
    const query = z.object({ cursor: z.string().min(1).max(2048).optional() }).parse(request.query);
    const run = await options.service.getRuntimeRun(principal, p.projectId!, p.id!);
    const session = await options.service.getRuntimeSession(principal, p.projectId!, run.sessionId);
    if (!callerGrants(p.projectId!, principal.actorId).some(grant => grant.roleId === session.roleId &&
      grant.authorizationScope === session.authorizationScope && grant.cwd === session.cwd && grant.sandbox === session.sandbox))
      throw new DomainError("FORBIDDEN", "当前身份没有此运行所属会话的执行授权。");
    return options.runtime.trace(principal, p.projectId!, p.id!, query.cursor);
  });
  app.post("/api/projects/:projectId/runtime/runs/:id/reconcile", async request => {
    const p = params(request.params);
    const principal = who(request.principal);
    if (!principal.projectIds.includes(p.projectId!) || !principal.permissions.includes("review")) {
      throw new DomainError("FORBIDDEN", "重新核对运行需要本项目复核权限。");
    }
    if (!options.runtime?.status().available) throw new DomainError("RUNTIME_UNAVAILABLE", "执行服务不可用，无法重新读取原生运行。");
    const body = runtimeReconcileSchema.parse(request.body);
    const run = await options.service.getRuntimeRun(principal, p.projectId!, p.id!);
    const session = await options.service.getRuntimeSession(principal, p.projectId!, run.sessionId);
    if (!callerGrants(p.projectId!, principal.actorId).some(grant => grant.roleId === session.roleId &&
      grant.authorizationScope === session.authorizationScope && grant.cwd === session.cwd && grant.sandbox === session.sandbox)) {
      throw new DomainError("FORBIDDEN", "当前身份没有此运行所属会话的执行授权。");
    }
    return options.runtime.reconcile(principal, p.projectId!, p.id!, body.expectedVersion, body.reason);
  });
  app.get("/api/projects/:projectId/goals", async request => {
    const p = params(request.params); const q = pageSchema.parse(request.query);
    return options.service.listGoals(who(request.principal), p.projectId!, q.limit, q.cursor);
  });
  app.get("/api/projects/:projectId/goals/:id", async request => {
    const p = params(request.params); return options.service.getGoal(who(request.principal), p.projectId!, p.id!);
  });
  app.get("/api/projects/:projectId/goals/:id/revisions", async request => {
    const p = params(request.params); return options.service.listGoalRevisions(who(request.principal), p.projectId!, p.id!);
  });
  app.get("/api/projects/:projectId/stages/:id/revisions", async request => {
    const p = params(request.params); return options.service.listStageRevisions(who(request.principal), p.projectId!, p.id!);
  });
  app.get("/api/projects/:projectId/stages", async request => options.service.listStages(who(request.principal), params(request.params).projectId!));
  app.get("/api/projects/:projectId/stages/:id", async request => {
    const p = params(request.params); return options.service.getStage(who(request.principal), p.projectId!, p.id!);
  });
  app.get("/api/projects/:projectId/stages/:id/reviews", async request => {
    const p = params(request.params); return options.service.listStageReviews(who(request.principal), p.projectId!, p.id!);
  });
  app.get("/api/projects/:projectId/tasks/:id/revisions", async request => {
    const p = params(request.params); return options.service.listTaskRevisions(who(request.principal), p.projectId!, p.id!);
  });
  app.get("/api/projects/:projectId/discussions", async request => {
    const p = params(request.params); const q = pageSchema.parse(request.query);
    return options.service.listDiscussions(who(request.principal), p.projectId!, q.limit, q.cursor);
  });
  app.get("/api/projects/:projectId/discussions/:id", async request => {
    const p = params(request.params); return options.service.getDiscussion(who(request.principal), p.projectId!, p.id!);
  });
  app.get("/api/projects/:projectId/discussions/:id/events", async request => {
    const p = params(request.params); return options.service.listDiscussionEvents(who(request.principal), p.projectId!, p.id!);
  });
  for (const entity of ["documents", "tasks"] as const) {
    app.get(`/api/projects/:projectId/${entity}`, async request => {
      const p = params(request.params); const q = pageSchema.parse(request.query);
      return entity === "documents" ? options.service.listDocuments(who(request.principal), p.projectId!, q.limit, q.cursor) : options.service.listTasks(who(request.principal), p.projectId!, q.limit, q.cursor);
    });
    app.get(`/api/projects/:projectId/${entity}/:id`, async request => {
      const p = params(request.params);
      return entity === "documents" ? options.service.getDocument(who(request.principal), p.projectId!, p.id!) : options.service.getTask(who(request.principal), p.projectId!, p.id!);
    });
    app.get(`/api/projects/:projectId/${entity}/:id/revisions/:revisionId`, async request => {
      const p = params(request.params);
      return entity === "documents" ? options.service.getDocumentRevision(who(request.principal), p.projectId!, p.id!, p.revisionId!) : options.service.getTaskRevision(who(request.principal), p.projectId!, p.id!, p.revisionId!);
    });
  }
  app.get("/api/projects/:projectId/impacts", async request => options.service.listImpacts(who(request.principal), params(request.params).projectId!));
  app.get("/api/projects/:projectId/operations/:id", async (request, reply) => {
    const p = params(request.params);
    const operation = await options.service.getOperation(who(request.principal), p.projectId!, p.id!);
    return operation ?? reply.code(404).send({ code: "OPERATION_NOT_FOUND", message: "尚无已确认记录；这不能证明仍在进行的请求未提交。" });
  });
  if (options.references) registerReferenceRoutes(app, options.references);
  if (options.orchestration) registerOrchestrationRoutes(app, options.orchestration);
  if (options.collaboration) registerCollaborationRoutes(app, { ...options.collaboration, workflow: options.service });
  await registerWorkManagementRoutes(app, options.service);
  registerEvaluationRoutes(app, options.service, options.readEvaluationPacket);
  if (options.knowledge) registerKnowledgeRoutes(app, { workflow: options.service, ...options.knowledge });
  if (options.documents) registerDocumentRoutes(app, { workflow: options.service, ...options.documents });
  if (options.webRoot) {
    await app.register(staticPlugin, { root: options.webRoot, index: "index.html", wildcard: true, cacheControl: false });
  }
  return app;
}
