import { z } from 'zod';

const id=z.uuid(); const note=z.string().trim().min(1).max(4000);
const base={projectId:id,operationId:id,queueId:id};
export const queueCommandSchema=z.discriminatedUnion('type',[
  z.strictObject({...base,type:z.literal('queue.create'),maxRuns:z.number().int().min(1).max(100),reason:note,
    entries:z.array(z.strictObject({id,taskId:id,taskRevisionId:id,sessionId:id,roleId:id,dependsOn:z.array(id).max(100),consumerId:note,useRequired:z.boolean(),releaseRule:z.enum(['accepted','bounded_decision'])})).min(1).max(100)}),
  z.strictObject({...base,type:z.literal('queue.reorder'),expectedVersion:z.number().int().positive(),entryIds:z.array(id).max(100),reason:note}),
  z.strictObject({...base,type:z.literal('queue.amend'),expectedVersion:z.number().int().positive(),entryId:id,taskRevisionId:id,reason:note}),
  z.strictObject({...base,type:z.literal('queue.adopt'),expectedVersion:z.number().int().positive()}),
  z.strictObject({...base,type:z.literal('queue.unhold'),entryId:id,expectedEntryVersion:z.number().int().positive(),reason:note}),
  z.strictObject({...base,type:z.literal('queue.claim'),entryId:id,expectedVersion:z.number().int().positive(),claimId:id,runId:id,runOperationId:id}),
  z.strictObject({...base,type:z.literal('queue.continue'),entryId:id,claimId:id,runId:id,runOperationId:id,reason:note,
    answeredQuestions:z.array(z.strictObject({questionEventId:id,answerEventId:id})).max(20).default([])}),
  z.strictObject({...base,type:z.literal('queue.release'),entryId:id,claimId:id,decisionId:id.optional(),reason:note.optional(),nextResponsibility:note.optional()}),
  z.strictObject({...base,type:z.literal('queue.hold'),entryId:id,reason:note}),
]);
export type QueueCommand=z.infer<typeof queueCommandSchema>;
export type QueueEntryState='queued'|'held'|'claimed'|'released';
export type QueueHoldCode='not_adopted'|'task_changed'|'task_unavailable'|'dependency'|'session_unready'|'binding_changed'|'grant_revoked'|'occupied'|'run_in_flight'|'unknown'|'awaiting_acceptance'|'budget_exhausted'|'manual_review';
export type QueueReleaseRule='accepted'|'bounded_decision';
export interface ResidentQueueEntry {projectId:string;queueId:string;id:string;taskId:string;taskRevisionId:string;sourceInputJson:string;sessionId:string;roleId:string;position:number;dependsOn:string[];consumerId:string;useRequired:boolean;releaseRule:QueueReleaseRule;state:QueueEntryState;holdCode:QueueHoldCode|null;holdReason:string|null;claimId:string|null;version:number}
export interface ResidentQueue {projectId:string;id:string;version:number;adoptedVersion:number|null;maxRuns:number;reason:string;actorId:string;entries:ResidentQueueEntry[]}
export interface QueueClaim {projectId:string;queueId:string;entryId:string;claimId:string;taskId:string;sessionId:string;roleId:string;releasedAt:string|null;releaseKind:'accepted'|'bounded'|null}
export interface QueueAttempt {projectId:string;claimId:string;sequence:number;runId:string;operationId:string;taskRevisionId:string;actualRunTaskRevisionId:string|null;reservedAt:string}
export interface QueueSourceFacts {currentTaskRevisionId:string|null;taskState:'todo'|'in_progress'|'done'|'cancelled'|'other';sessionReady:boolean;nativeThreadId:string|null;bindingCurrent:boolean;grantCurrent:boolean;conflictingRun:boolean;currentInputJson:string|null}
export interface QueueReleaseEvidence {currentTaskRevisionId:string;currentInputJson:string;taskState:'done'|'in_progress';deliveryId:string|null;deliveryCurrent:boolean;deliveryPassed:boolean;observationId:string|null;observationConsumerId:string|null;observationUsed:boolean;closureId:string|null;closureCurrent:boolean;boundedDecisionId:string|null;boundedDecisionActorId:string|null;boundedDecisionReason:string|null;nextResponsibility:string|null}
export interface QueueReader {
  queueControllerCurrent(actorId:string):Promise<boolean>;
  listResidentQueues():Promise<ResidentQueue[]>;
  getResidentQueue(id:string):Promise<ResidentQueue|null>;
  listResidentQueueAttempts(claimId:string):Promise<QueueAttempt[]>;
  countResidentQueueAttempts(queueId:string):Promise<number>;
  getResidentQueueClaim(claimId:string):Promise<QueueClaim|null>;
  exactQueueGrant(roleId:string,sessionId:string,taskId:string):Promise<boolean>;
  queueBindingCurrent(roleId:string,sessionId:string):Promise<boolean>;
}
export interface QueueTransaction extends QueueReader {
  assertQueueVacant(taskId:string,sessionId:string,matchingClaimId?:string,matchingRunId?:string,matchingOperationId?:string):Promise<void>;
  assertQueueSessionVacant(sessionId:string):Promise<void>;
  createResidentQueue(queue:ResidentQueue):Promise<void>;
  reorderResidentQueue(queueId:string,expectedVersion:number,entryIds:string[],actorId:string,reason:string):Promise<number>;
  amendResidentQueueEntry(queueId:string,entryId:string,expectedVersion:number,taskRevisionId:string,sourceInputJson:string,actorId:string,reason:string):Promise<number>;
  adoptResidentQueue(queueId:string,expectedVersion:number,actorId:string):Promise<void>;
  claimResidentQueue(queueId:string,entryId:string,expectedVersion:number,claimId:string,attempt:Omit<QueueAttempt,'projectId'|'claimId'|'sequence'|'reservedAt'|'actualRunTaskRevisionId'>):Promise<QueueClaim|null>;
  appendResidentQueueAttempt(claimId:string,attempt:Omit<QueueAttempt,'projectId'|'claimId'|'sequence'|'reservedAt'|'actualRunTaskRevisionId'>,maxRuns:number):Promise<QueueAttempt|null>;
  holdResidentQueueEntry(queueId:string,entryId:string,code:QueueHoldCode,reason:string):Promise<void>;
  unholdResidentQueueEntry(queueId:string,entryId:string,expectedEntryVersion:number,decisionId:string,actorId:string,reason:string):Promise<void>;
  releaseResidentQueueAccepted(claimId:string):Promise<boolean>;
  releaseResidentQueueBounded(claimId:string,decisionId:string,actorId:string,reason:string,nextResponsibility:string):Promise<boolean>;
}
