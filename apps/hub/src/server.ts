import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";
import { bearerToken } from "./auth.js";
import { assertSameOrigin, type HubConfig } from "./config.js";
import { asHubError } from "./errors.js";
import { errorPage } from "./pages.js";
import { Gateway } from "./gateway.js";
import { registerMachineRoutes } from "./machine-routes.js";
import { MachineStore } from "./machines.js";
import { registerRoutes } from "./routes.js";
import { registerWorkbench } from "./workbench.js";
import { HubService } from "./service.js";
import { HubStore } from "./store.js";

export type HubAppOptions = {
  config: HubConfig;
  store: HubStore;
  service?: HubService;
  machines?: MachineStore;
  gateway?: Gateway;
  logger?: FastifyServerOptions["logger"];
};

const requestLogView = (request: { method?: string; url?: string }): { method: string; url: string } => ({
  method: request.method ?? "",
  url: (request.url ?? "").split("?", 1)[0] || "/",
});

const safeLogger = (logger: FastifyServerOptions["logger"]): NonNullable<FastifyServerOptions["logger"]> => {
  if (!logger) return false;
  if (logger === true) return { serializers: { req: requestLogView } };
  return {
    ...logger,
    serializers: { ...logger.serializers, req: requestLogView },
  };
};

export function buildHubApp(options: HubAppOptions): FastifyInstance {
  const { config, store } = options;
  const service = options.service ?? new HubService(store, config);
  const app = Fastify({
    logger: safeLogger(options.logger),
    bodyLimit: config.bodyLimitBytes,
    trustProxy: false,
  });

  app.addContentTypeParser(
    "application/x-www-form-urlencoded",
    { parseAs: "string" },
    (_request, body, done) => {
      try {
        const values: Record<string, string | string[]> = {};
        for (const [key, value] of new URLSearchParams(String(body))) {
          const current = values[key];
          if (current === undefined) values[key] = value;
          else if (Array.isArray(current)) current.push(value);
          else values[key] = [current, value];
        }
        done(null, values);
      } catch (error) {
        done(error as Error);
      }
    },
  );

  app.addHook("onRequest", async request => {
    const method = request.method.toUpperCase();
    if (!["POST", "PUT", "PATCH", "DELETE"].includes(method)) return;
    if (bearerToken(request)) return;
    // A machine proves itself with its own signature over the request, not with a browser Origin.
    if (request.url.startsWith("/api/machine/")) return;
    assertSameOrigin(request.headers.origin, config.publicOrigin);
  });

  app.addHook("onSend", async (_request, reply, payload) => {
    reply.header("x-content-type-options", "nosniff");
    reply.header("referrer-policy", "no-referrer");
    reply.header("x-frame-options", "DENY");
    reply.header("cache-control", "no-store");
    // The workbench pages set their own policy (apps/hub/src/workbench.ts); everything else keeps the strict one.
    if (!reply.hasHeader("content-security-policy")) {
      reply.header(
        "content-security-policy",
        "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
      );
    }
    return payload;
  });

  app.setErrorHandler((error, request, reply) => {
    const hubError = asHubError(error);
    if (hubError.statusCode >= 500) {
      request.log.error(
        { err: { name: (error as Error)?.name, message: (error as Error)?.message, code: (error as { code?: string })?.code } },
        "Hub request failed",
      );
    }
    if (hubError.code === "LOGIN_RATE_LIMITED") {
      const details = hubError.details as { retryAfterSeconds?: number } | null;
      if (details?.retryAfterSeconds) reply.header("retry-after", String(details.retryAfterSeconds));
    }
    if (request.url.startsWith("/form/")) {
      return reply
        .code(hubError.statusCode)
        .type("text/html; charset=utf-8")
        .send(errorPage(hubError.statusCode, hubError.message));
    }
    return reply.code(hubError.statusCode).send({
      error: {
        code: hubError.code,
        message: hubError.message,
        details: hubError.details,
      },
    });
  });

  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith("/api/")) {
      return reply.code(404).send({ error: { code: "NOT_FOUND", message: "The Hub route does not exist.", details: null } });
    }
    return reply.code(404).type("text/html; charset=utf-8").send(errorPage(404, "页面不存在。"));
  });

  const machines = options.machines ?? new MachineStore(store.pool);
  const gateway = options.gateway ?? new Gateway({
    heartbeatMs: config.machineHeartbeatMs ?? 15_000, forwardTimeoutMs: config.forwardTimeoutMs ?? 60_000, maxResponseBytes: config.maxResponseBytes ?? 8 * 1024 * 1024,
  });
  registerRoutes(app, service, store, config, { machines, gateway });
  registerMachineRoutes(app, { config, store, service, machines, gateway });
  if (config.webRoot) registerWorkbench(app, config.webRoot);
  app.addHook("onClose", async () => { gateway.close(); });
  return app;
}
