import Fastify from "fastify";
import staticPlugin from "@fastify/static";
import { commandSchema, capabilities, idSchema, type Principal } from "@evoloop/contracts";
import { DomainError } from "@evoloop/contracts/ports";
import type { WorkflowService } from "@evoloop/core";
import { authenticate, authConfigSchema, type AuthConfig } from "./auth.js";
import { z } from "zod";

declare module "fastify" { interface FastifyRequest { principal: Principal | null } }
const pageSchema = z.object({ limit: z.coerce.number().int().min(1).max(100).default(50), cursor: idSchema.optional() });
const errorStatus = (code: string) => code === "FORBIDDEN" ? 403 : code === "NOT_FOUND" ? 404 : 409;
export async function buildServer(options: {
  service: WorkflowService; credentials: AuthConfig; webRoot?: string; canWrite?: () => boolean;
}) {
  const credentials = authConfigSchema.parse(options.credentials);
  const app = Fastify({ logger: false, bodyLimit: 128 * 1024 });
  app.decorateRequest("principal", null);
  app.addHook("onRequest", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "no-referrer");
    reply.header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'");
    if (!request.url.startsWith("/api/")) return;
    request.principal = authenticate(request.headers.authorization, credentials);
    if (!request.principal) return reply.code(401).send({ code: "UNAUTHENTICATED", message: "需要有效的本机访问令牌。" });
    if (request.method !== "GET" && request.method !== "HEAD" && options.canWrite && !options.canWrite()) {
      return reply.code(503).send({ code: "UNAVAILABLE", message: "协调者资格不可用；请保留操作 ID 并回读。" });
    }
  });
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof z.ZodError) {
      return reply.code(400).send({ code: "INVALID_INPUT", message: "输入不符合当前接口合同。", issues: error.issues.map(x => ({ path: x.path, code: x.code })) });
    }
    if (error instanceof DomainError) return reply.code(errorStatus(error.code)).send({ code: error.code, message: error.message, ...(error.currentVersion === undefined ? {} : { currentVersion: error.currentVersion }) });
    if (typeof error === "object" && error !== null && "statusCode" in error) {
      if (error.statusCode === 413) return reply.code(413).send({ code: "TOO_LARGE", message: "请求超过本片大小限制。" });
      if (error.statusCode === 400) return reply.code(400).send({ code: "INVALID_INPUT", message: "请求格式不合法。" });
    }
    // A failed connection/response is not proof that the database commit failed.
    return reply.code(503).send({ code: "RESULT_UNCONFIRMED", message: "暂时无法确认结果。写操作请保留原操作 ID 并查询记录。", requestId: request.id });
  });
  const who = (p: Principal | null) => { if (!p) throw new DomainError("FORBIDDEN", "未认证"); return p; };
  const params = (value: unknown) => z.record(z.string(), idSchema).parse(value);
  app.get("/health", async () => ({ status: options.canWrite?.() === false ? "unavailable" : "ok", capabilities }));
  app.get("/api/session", async request => ({ principal: who(request.principal), capabilities }));
  app.post("/api/commands", async (request, reply) => {
    const command = commandSchema.parse(request.body);
    const result = await options.service.execute(who(request.principal), command);
    return reply.code(result.status === "applied" ? 200 : errorStatus(result.code)).send(result);
  });
  app.get("/api/projects/:projectId", async request => options.service.getProject(who(request.principal), params(request.params).projectId!));
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
  if (options.webRoot) {
    await app.register(staticPlugin, { root: options.webRoot, index: "index.html", wildcard: true, cacheControl: false });
  }
  return app;
}
