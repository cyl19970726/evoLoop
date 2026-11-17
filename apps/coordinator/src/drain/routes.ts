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
export function registerDrainRoutes(app: FastifyInstance, deps: { control: DrainControl; isMaintainer(principal: Principal): Promise<boolean>;
  /** Throws unless the principal may read the project (the same check as every project read). */
  projectAccess?(principal: Principal, projectId: string): Promise<unknown> }): void {
  const principalOf = (request: { principal: Principal | null }): Principal => {
    if (!request.principal) throw new DomainError("FORBIDDEN", "Authentication required");
    return request.principal;
  };
  const view = async (principal: Principal) => {
    const status = await deps.control.status();
    if (await deps.isMaintainer(principal)) return { ...status, maintainer: true };
    return { ...status, maintainer: false, inFlight: { counts: status.inFlight.counts, runs: [], messageTurns: [] } };
  };
  app.get("/api/instance/drain", async request => view(principalOf(request)));
  // The same state for a page that reaches this instance through the Hub, which forwards only a project's own API: `/api/instance/drain` is a 404 there, and the page used to
  // ask for it every 15 seconds (Task 5a47dcb8). A project reader sees exactly what any signed-in reader sees at the instance path; nothing about starting or releasing a drain moves here.
  app.get("/api/projects/:projectId/instance-drain", async request => {
    const principal = principalOf(request);
    const { projectId } = z.strictObject({ projectId: z.uuid() }).parse(request.params);
    await deps.projectAccess?.(principal, projectId);
    return view(principal);
  });
  app.post("/api/instance/drain", async request => {
    const principal = principalOf(request);
    const body = z.strictObject({ action: z.enum(["start", "release"]), reason: z.string().trim().min(1).max(1000) }).parse(request.body);
    if (!await deps.isMaintainer(principal))
      throw new DomainError("FORBIDDEN", "Only an instance maintainer (a credential with management and decision authority in every project) may start or release a drain");
    return deps.control.set(principal, body.action, body.reason);
  });
  app.get("/api/instance/drain/history", async request => {
    const principal = principalOf(request);
    if (!await deps.isMaintainer(principal)) throw new DomainError("FORBIDDEN", "Instance maintainer required");
    return { items: await deps.control.history(50) };
  });
}
