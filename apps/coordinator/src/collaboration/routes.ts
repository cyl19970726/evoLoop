import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Principal } from "@evoloop/contracts";
import type { DeliveryStore } from "@evoloop/contracts/delivery";
import type { WorkflowService } from "@evoloop/core";
import { reviewIncomingChange, CollaborationRuleError } from "@evoloop/core/delivery";
import type { CollaborationRunner } from "./runner.js";

const id = z.uuid();
const projectParams = z.object({ projectId:id });
const eventParams = z.object({ projectId:id,eventId:id });
const incomingParams = z.object({ projectId:id,incomingId:id });
const page = z.object({ limit:z.coerce.number().int().min(1).max(100).default(50),cursor:id.optional() });
const reason = z.object({ reason:z.string().trim().min(1).max(4000) });
function scope(principal: Principal | null, projectId: string, review = false): Principal {
  if (!principal || !principal.projectIds.includes(projectId) || !principal.permissions.includes("read") || review && (!principal.permissions.includes("write") || !principal.permissions.includes("review")))
    throw new CollaborationRuleError("FORBIDDEN","project collaboration access denied");
  return principal;
}
export function registerCollaborationRoutes(app: FastifyInstance, options: { runner: CollaborationRunner; store: DeliveryStore; workflow: WorkflowService; consumerId: string;
  hasGrant?: (projectId: string, actorId: string) => boolean }) {
  const hasGrant = (projectId: string, actorId: string) => options.hasGrant?.(projectId,actorId) === true;
  const grant = (principal: Principal, projectId: string) => {
    if (!hasGrant(projectId,principal.actorId)) throw new CollaborationRuleError("FORBIDDEN","current project integration grant required");
  };
  app.get("/api/projects/:projectId/collaboration", async request => {
    const { projectId } = projectParams.parse(request.params); const principal=scope(request.principal,projectId);
    if (!hasGrant(projectId,principal.actorId)) return { ...options.runner.status(projectId),
      deliveries:{items:[],nextCursor:null},incoming:{items:[],nextCursor:null},incomingPending:0 };
    const [deliveries,incoming] = await Promise.all([options.store.list(projectId,options.consumerId,50),options.store.listIncoming(projectId,options.consumerId,50)]);
    return { ...options.runner.status(projectId),deliveries, incoming, incomingPending:incoming.items.filter(item=>item.state==="pending" || item.state==="review-only" || item.state==="unknown").length };
  });
  app.get("/api/projects/:projectId/collaboration/deliveries", async request => {
    const {projectId}=projectParams.parse(request.params); const principal=scope(request.principal,projectId); grant(principal,projectId); const q=page.parse(request.query);
    return options.store.list(projectId,options.consumerId,q.limit,q.cursor);
  });
  app.get("/api/projects/:projectId/collaboration/deliveries/:eventId/attempts", async request => {
    const {projectId,eventId}=eventParams.parse(request.params); const principal=scope(request.principal,projectId); grant(principal,projectId);
    return options.store.attempts(projectId,eventId,options.consumerId);
  });
  app.get("/api/projects/:projectId/collaboration/deliveries/:eventId", async request => {
    const {projectId,eventId}=eventParams.parse(request.params); const principal=scope(request.principal,projectId); grant(principal,projectId);
    return options.store.get(projectId,eventId,options.consumerId);
  });
  app.get("/api/projects/:projectId/collaboration/incoming", async request => {
    const {projectId}=projectParams.parse(request.params); const principal=scope(request.principal,projectId); grant(principal,projectId); const q=page.parse(request.query);
    return options.store.listIncoming(projectId,options.consumerId,q.limit,q.cursor);
  });
  app.get("/api/projects/:projectId/collaboration/incoming/:incomingId", async request => {
    const {projectId,incomingId}=incomingParams.parse(request.params); const principal=scope(request.principal,projectId); grant(principal,projectId);
    return options.store.getIncoming(projectId,incomingId,options.consumerId);
  });
  app.post("/api/projects/:projectId/collaboration/deliveries/:eventId/reconcile", async request => {
    const {projectId,eventId}=eventParams.parse(request.params); const principal=scope(request.principal,projectId,true); grant(principal,projectId); reason.parse(request.body);
    return options.runner.reconcile(principal,projectId,eventId);
  });
  app.post("/api/projects/:projectId/collaboration/deliveries/:eventId/retry", async request => {
    const {projectId,eventId}=eventParams.parse(request.params); const principal=scope(request.principal,projectId,true); grant(principal,projectId); const body=reason.parse(request.body);
    return { requested:await options.runner.retry(principal,projectId,eventId,body.reason) };
  });
  app.post("/api/projects/:projectId/collaboration/poll", async request => {
    const {projectId}=projectParams.parse(request.params); const principal=scope(request.principal,projectId,true); grant(principal,projectId);
    return { observed:await options.runner.pollIncoming(principal,projectId) };
  });
  app.post("/api/projects/:projectId/collaboration/incoming/:incomingId/review", async request => {
    const {projectId,incomingId}=incomingParams.parse(request.params); const principal=scope(request.principal,projectId,true); grant(principal,projectId);
    const body=z.object({decision:z.enum(["apply","reject"]),reason:z.string().trim().min(1).max(4000)}).parse(request.body);
    const guardedStore = new Proxy(options.store, { get(target, property) {
      if (property === "decideIncoming") return (...args: Parameters<DeliveryStore["decideIncoming"]>) => {
        grant(principal,projectId); return target.decideIncoming(...args);
      };
      const value = Reflect.get(target,property);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    const guardedWorkflow = {
      getTask: (...args: Parameters<WorkflowService["getTask"]>) => { grant(principal,projectId); return options.workflow.getTask(...args); },
      getOperation: (...args: Parameters<WorkflowService["getOperation"]>) => { grant(principal,projectId); return options.workflow.getOperation(...args); },
      execute: (...args: Parameters<WorkflowService["execute"]>) => { grant(principal,projectId); return options.workflow.execute(...args); },
    };
    return reviewIncomingChange({store:guardedStore,workflow:guardedWorkflow,consumerId:options.consumerId,
      nowUtc:()=>new Date().toISOString(),verifyRemote:candidate=>{
        grant(principal,projectId); return options.runner.verifyIncomingCandidate(candidate,principal);
      }},principal,projectId,incomingId,body.decision,body.reason);
  });
}
