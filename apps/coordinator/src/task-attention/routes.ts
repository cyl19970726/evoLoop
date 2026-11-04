import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
import type { Principal } from "@evoloop/contracts";
import type { WorkflowService } from "@evoloop/core";
import { trialAttentionThreshold, trialAttentionThresholdMs } from "@evoloop/core";
import { PgTaskAttention } from "@evoloop/adapter-postgres";
import { DomainError } from "@evoloop/contracts/ports";
import { taskAttentionThresholdsSetSchema,taskAttentionFollowUpSetSchema,
  taskAttentionPublicationRecordSchema,taskAttentionResolveSchema,
  taskAttentionStageSchema } from "@evoloop/contracts";
import type { LeaderWorkTimingStage } from "@evoloop/contracts/work-index";

const uuid=z.uuid();
function actor(p:Principal|null,projectId:string,write=false):Principal{
  if(!p||!p.projectIds.includes(projectId)||!p.permissions.includes("read")||
    (write&&(!p.permissions.includes("write")||!p.permissions.includes("review"))))
    throw new DomainError("FORBIDDEN","Task attention requires project read or write and review permission");
  return p;
}
export function registerTaskAttentionRoutes(app:FastifyInstance,service:WorkflowService,pool:Pool):void{
  const project=(raw:unknown)=>z.strictObject({projectId:uuid}).parse(raw);
  const task=(raw:unknown)=>z.strictObject({projectId:uuid,taskId:uuid}).parse(raw);
  const item=(raw:unknown)=>z.strictObject({projectId:uuid,itemId:uuid}).parse(raw);
  async function access(principal:Principal|null,projectId:string,write=false){
    const who=actor(principal,projectId,write);
    await service.getProject(who,projectId);
    return who;
  }
  app.get("/api/projects/:projectId/task-attention/thresholds",async request=>{
    const p=project(request.params);await access(request.principal,p.projectId);
    const q=z.strictObject({stageId:uuid.optional(),phase:taskAttentionStageSchema.optional()}).parse(request.query);
    const store=new PgTaskAttention(pool,p.projectId), stored=await store.thresholds();
    const phases=q.phase?[q.phase]:Object.keys(trialAttentionThresholdMs) as LeaderWorkTimingStage[];
    return {items:await Promise.all(phases.map(async phase=>
      await store.effectiveThreshold(q.stageId??null,phase)??trialAttentionThreshold(phase))),
      overrides:stored.filter(x=>!q.phase||x.phase===q.phase)};
  });
  app.put("/api/projects/:projectId/task-attention/thresholds",async request=>{
    const p=project(request.params),who=await access(request.principal,p.projectId,true);
    const command=taskAttentionThresholdsSetSchema.parse(request.body);
    if(command.projectId!==p.projectId)throw new DomainError("INVALID_COMMAND","Project differs from route");
    return service.execute(who,command);
  });
  app.get("/api/projects/:projectId/tasks/:taskId/attention",async request=>{
    const p=task(request.params),who=await access(request.principal,p.projectId);
    await service.getTask(who,p.projectId,p.taskId);
    const store=new PgTaskAttention(pool,p.projectId);
    const [followUp,followUpHistory,items]=await Promise.all([store.getFollowUp(p.taskId),
      store.followUpHistory(p.taskId),store.items({taskId:p.taskId,state:"open",limit:100})]);
    return {followUp,followUpHistory,items:items.items,itemsNextCursor:items.nextCursor};
  });
  app.put("/api/projects/:projectId/tasks/:taskId/attention/follow-up",async request=>{
    const p=task(request.params),who=await access(request.principal,p.projectId,true);
    const command=taskAttentionFollowUpSetSchema.parse(request.body);
    if(command.projectId!==p.projectId||command.taskId!==p.taskId)
      throw new DomainError("INVALID_COMMAND","Task differs from route");
    return service.execute(who,command);
  });
  app.post("/api/projects/:projectId/tasks/:taskId/attention/publication",async request=>{
    const p=task(request.params),who=await access(request.principal,p.projectId,true);
    const command=taskAttentionPublicationRecordSchema.parse(request.body);
    if(command.projectId!==p.projectId||command.taskId!==p.taskId)
      throw new DomainError("INVALID_COMMAND","Task differs from route");
    return service.execute(who,command);
  });
  app.get("/api/projects/:projectId/task-attention/items",async request=>{
    const p=project(request.params);await access(request.principal,p.projectId);
    const q=z.strictObject({taskId:uuid.optional(),state:z.enum(["open","resolved"]).optional(),
      phase:taskAttentionStageSchema.optional(),
      signal:z.enum(["stage_overdue","activity_without_progress","observation_gap"]).optional(),
      waitingOnKind:z.enum(["session","consumer","leader","publisher","user","task","unknown"]).optional(),
      waitingOnId:z.string().trim().min(1).max(500).optional(),
      limit:z.coerce.number().int().min(1).max(100).default(50),cursor:z.string().min(1).max(1024).optional()}).parse(request.query);
    return new PgTaskAttention(pool,p.projectId).items(q);
  });
  app.get("/api/projects/:projectId/task-attention/items/:itemId",async request=>{
    const p=item(request.params);await access(request.principal,p.projectId);
    const store=new PgTaskAttention(pool,p.projectId),record=await store.getItem(p.itemId);
    if(!record)throw new DomainError("ATTENTION_NOT_FOUND","Attention item is unavailable");
    return {item:record,events:await store.itemEvents(p.itemId)};
  });
  app.post("/api/projects/:projectId/task-attention/items/:itemId/resolve",async request=>{
    const p=item(request.params),who=await access(request.principal,p.projectId,true);
    const command=taskAttentionResolveSchema.parse(request.body);
    if(command.projectId!==p.projectId||command.itemId!==p.itemId)
      throw new DomainError("INVALID_COMMAND","Attention item differs from route");
    return service.execute(who,command);
  });
}
