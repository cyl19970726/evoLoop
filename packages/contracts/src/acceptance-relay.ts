import { z } from "zod";
import type { LeaderWorkPage, LeaderWorkTask } from "./work-index.js";

const id = z.uuid();
const text = z.string().trim().min(1).max(4000);
export const acceptanceArrangeSchema = z.strictObject({
  projectId:id,operationId:id,relayId:id,taskId:id,expectedTaskVersion:z.number().int().positive(),
  deliveryId:id,stage:z.enum(["candidate","formal"]),scopeKey:z.string().trim().min(1).max(120),
  scopeDescription:z.string().trim().min(1).max(4000),entrypoint:z.string().trim().min(1).max(2000).nullable(),
  publicationRef:z.string().trim().min(1).max(2000).nullable(),
  mode:z.enum(["human","leader","session"]),recipientActorId:z.string().trim().min(1).max(100),
  sessionId:id.nullable(),senderActorId:z.string().trim().min(1).max(100).nullable(),
  messageId:id.nullable(),messageOperationId:id.nullable(),reason:z.string().trim().min(1).max(4000),
  supersedesRelayId:id.nullable().optional(),expectedRelayVersion:z.number().int().positive().optional(),
}).superRefine((x,ctx)=>{
  const agent=x.mode!=="human";
  if(x.stage==="formal"&&!x.publicationRef)
    ctx.addIssue({code:"custom",path:["publicationRef"],message:"formal use needs a publication reference"});
  for(const key of ["sessionId","senderActorId","messageId","messageOperationId"] as const)
    if(!!x[key]!==agent)ctx.addIssue({code:"custom",path:[key],
      message:agent?"required for agent recipient":"must be null for human recipient"});
});
export type AcceptanceArrangeInput=z.infer<typeof acceptanceArrangeSchema>;

export const acceptanceReadSchema=z.strictObject({
  projectId:id,taskId:id,relayId:id,operationId:id,
  expectedVersion:z.number().int().positive(),evidence:text,
});
export const acceptanceObserveSchema=z.strictObject({
  projectId:id,taskId:id,relayId:id,operationId:id,
  expectedVersion:z.number().int().positive(),observationId:id,
});
export type AcceptanceReadInput=z.infer<typeof acceptanceReadSchema>;
export type AcceptanceObserveInput=z.infer<typeof acceptanceObserveSchema>;

/** Read projection: saving, delivery, native use and observation are separate facts. */
export interface AcceptanceRelayView {
  relayId:string; version:number; operationId:string; supersedesRelayId:string|null;
  arrangedBy:string; taskId:string; taskRevisionId:string; deliveryId:string; stage:"candidate"|"formal";
  scopeKey:string; scopeDescription:string; entrypoint:string|null; publicationRef:string|null;
  reason:string; mode:"human"|"leader"|"session"; recipientActorId:string; sessionId:string|null;
  roleId:string|null; senderActorId:string|null; state:"pending"|"linked"|"blocked"|"superseded"|"released";
  blockedReason:string|null; messageId:string|null; messageOperationId:string|null; messageState:string|null;
  processingState:string|null; nativeTurnId:string|null; readActorId:string|null;
  humanReadAt:string|null; observationId:string|null; observationResult:string|null;
  observationActorId:string|null; evidenceLevel:string|null;
  /** Exact session binding is the strongest independence fact stored; actor labels alone are never proof. */
  independenceEvidence:"human_credential"|"distinct_runtime_session"|"unverified";
  createdAt:string; updatedAt:string;
}

export interface AcceptanceCapacityView {
  sessionId:string; roleId:string; sessionActorId:string; cwd:string; state:string;
  nativeThreadId:string|null; tenure:"resident"|"temporary"|"unknown";
  isLeader:boolean; activeRuns:number; pendingMessages:number; queueEntries:number;
  openAssignments:number; openAcceptance:number;
  /** Session line entries waiting (queued or suspended): queued work, not busy, so they do not make the Session unavailable. */
  lineQueued:number;
  /** A line entry being started (assigned, awaiting confirmation, or starting): the Session is occupied. */
  lineStarting:number;
  persistedWorkIdle:boolean;
  missingCapabilities:string[]; readyForAcceptance:boolean;
}

export interface AcceptanceOverviewView {
  work: LeaderWorkPage<LeaderWorkTask>|null;
  capacity: AcceptanceCapacityView[];
  observedAt:string;
}

export interface AcceptanceHumanItem {
  projectId:string; relayId:string; taskId:string; taskRevisionId:string; deliveryId:string;
  stage:"candidate"|"formal"; scopeKey:string; scopeDescription:string;
  entrypoint:string|null; publicationRef:string|null; version:number;
  createdAt:string; readAt:string|null; observationId:string|null;
}

export const retirementApprovalSchema=z.strictObject({operationId:id,decisionId:id,closeOperationId:id,
  expectedSessionVersion:z.number().int().positive(),reason:z.string().trim().min(1).max(4000),
  handoffEvidence:z.string().trim().min(1).max(4000)}).refine(x=>x.operationId===x.decisionId,
  {path:["operationId"],message:"decisionId is the immutable operation ID"});
