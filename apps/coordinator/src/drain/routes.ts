import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Principal } from "@evoloop/contracts";
import { DomainError } from "@evoloop/contracts/ports";
import type { DrainControl } from "./service.js";

/**
 * GET  /api/instance/drain          the state, who/when/why, what is queued and what is still in flight (any signed-in
 *                                   reader sees the state and counts; the list of Runs and Turns is the maintainer's)
 * POST /api/instance/drain          { action: "start" | "release", reason } — maintainers only
 * GET  /api/instance/drain/history  the recorded starts and releases (maintainers only)
 */
export function registerDrainRoutes(app: FastifyInstance, deps: { control: DrainControl; isMaintainer(principal: Principal): Promise<boolean> }): void {
  const principalOf = (request: { principal: Principal | null }): Principal => {
    if (!request.principal) throw new DomainError("FORBIDDEN", "Authentication required");
    return request.principal;
  };
  app.get("/api/instance/drain", async request => {
    const principal = principalOf(request);
    const status = await deps.control.status();
    if (await deps.isMaintainer(principal)) return { ...status, maintainer: true };
    return { ...status, maintainer: false, inFlight: { counts: status.inFlight.counts, runs: [], messageTurns: [] } };
  });
  app.post("/api/instance/drain", async request => {
    const principal = principalOf(request);
    const body = z.strictObject({ action: z.enum(["start", "release"]), reason: z.string().trim().min(1).max(1000) }).parse(request.body);
    if (!await deps.isMaintainer(principal))
      throw new DomainError("FORBIDDEN", "Only an instance maintainer (a credential with read, write and review in every project) may start or release a drain");
    return deps.control.set(principal, body.action, body.reason);
  });
  app.get("/api/instance/drain/history", async request => {
    const principal = principalOf(request);
    if (!await deps.isMaintainer(principal)) throw new DomainError("FORBIDDEN", "Instance maintainer required");
    return { items: await deps.control.history(50) };
  });
}
