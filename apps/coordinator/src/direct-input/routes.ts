import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { directInputCommand } from "@evoloop/contracts/direct-input";
import { DomainError } from "@evoloop/contracts/ports";
import type { DirectInputService } from "./service.js";

/** Register only when the same live capability and native owner are wired by main. */
export function registerDirectInputRoutes(app:FastifyInstance,service:DirectInputService):void{
  const params=z.strictObject({projectId:z.uuid(),sessionId:z.uuid()});
  app.post("/api/projects/:projectId/sessions/:sessionId/direct-inputs",async request=>{
    const {projectId,sessionId}=params.parse(request.params);
    if(!request.principal)throw new DomainError("FORBIDDEN","Authentication required");
    return service.submit(request.principal,projectId,sessionId,directInputCommand.parse(request.body));
  });
  app.get("/api/projects/:projectId/sessions/:sessionId/direct-input-capability",async request=>{
    const {projectId,sessionId}=params.parse(request.params);
    if(!request.principal)throw new DomainError("FORBIDDEN","Authentication required");
    return service.capability(request.principal,projectId,sessionId);
  });
  app.get("/api/projects/:projectId/sessions/:sessionId/direct-inputs",async request=>{
    const {projectId,sessionId}=params.parse(request.params);
    if(!request.principal)throw new DomainError("FORBIDDEN","Authentication required");
    const {limit,cursor}=z.strictObject({limit:z.coerce.number().int().min(1).max(50).default(30),cursor:z.uuid().optional()}).parse(request.query);
    return service.list(request.principal,projectId,sessionId,limit,cursor);
  });
  app.get("/api/projects/:projectId/sessions/:sessionId/direct-inputs/:inputId",async request=>{
    const {projectId,sessionId,inputId}=params.extend({inputId:z.uuid()}).parse(request.params);
    if(!request.principal)throw new DomainError("FORBIDDEN","Authentication required");
    const receipt=await service.get(request.principal,projectId,inputId);
    if(receipt.sessionId!==sessionId)throw new DomainError("NOT_FOUND","Input is not in this Session");
    return receipt;
  });
  app.post("/api/projects/:projectId/sessions/:sessionId/direct-inputs/:inputId/reconcile",async request=>{
    const {projectId,sessionId,inputId}=params.extend({inputId:z.uuid()}).parse(request.params);
    if(!request.principal)throw new DomainError("FORBIDDEN","Authentication required");
    const receipt=await service.reconcile(request.principal,projectId,inputId);
    if(receipt.sessionId!==sessionId)throw new DomainError("NOT_FOUND","Input is not in this Session");
    return receipt;
  });
}
