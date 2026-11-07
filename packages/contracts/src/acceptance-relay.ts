import { z } from "zod";

const id = z.uuid();
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

/** Read projection: saving, delivery, native use and observation are separate facts. */
export interface AcceptanceRelayView {
  relayId:string; taskRevisionId:string; deliveryId:string; stage:"candidate"|"formal";
  scopeKey:string; scopeDescription:string; entrypoint:string|null; publicationRef:string|null;
  mode:"human"|"leader"|"session"; recipientActorId:string; sessionId:string|null;
  state:"pending"|"linked"|"blocked"|"superseded"|"released";
  blockedReason:string|null; messageId:string|null; messageState:string|null;
  processingState:string|null; nativeTurnId:string|null; readActorId:string|null;
  humanReadAt:string|null; observationId:string|null; observationResult:string|null;
  observationActorId:string|null; createdAt:string;
}

export const retirementApprovalSchema=z.strictObject({operationId:id,decisionId:id,closeOperationId:id,
  expectedSessionVersion:z.number().int().positive(),reason:z.string().trim().min(1).max(4000),
  handoffEvidence:z.string().trim().min(1).max(4000)}).refine(x=>x.operationId===x.decisionId,
  {path:["operationId"],message:"decisionId is the immutable operation ID"});
