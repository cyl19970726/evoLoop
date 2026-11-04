import type { TaskAttentionCommand } from "@evoloop/contracts";
import type { Transaction } from "@evoloop/contracts/ports";
import { DomainError } from "@evoloop/contracts/ports";

interface AttentionWriter {
  setThreshold(command: Extract<TaskAttentionCommand,{type:"task.attention.thresholds.set"}>, actorId:string, now:string):
    Promise<{entityId:string;version:number}>;
  setFollowUp(command: Extract<TaskAttentionCommand,{type:"task.attention.followUp.set"}>, actorId:string, now:string):
    Promise<{entityId:string;version:number}>;
  recordPublication(command: Extract<TaskAttentionCommand,{type:"task.attention.publication.record"}>, actorId:string, now:string):
    Promise<{entityId:string;version:number}>;
  resolve(command: Extract<TaskAttentionCommand,{type:"task.attention.resolve"}>, actorId:string, now:string):
    Promise<{entityId:string;version:number}>;
}
export async function applyTaskAttention(tx:Transaction, command:TaskAttentionCommand, actorId:string, now:string) {
  const writer=(tx as Transaction & {attention?:AttentionWriter}).attention;
  if(!writer)throw new DomainError("ATTENTION_UNAVAILABLE","Task attention storage is unavailable");
  const saved=command.type==="task.attention.thresholds.set"?await writer.setThreshold(command,actorId,now):
    command.type==="task.attention.followUp.set"?await writer.setFollowUp(command,actorId,now):
    command.type==="task.attention.publication.record"?await writer.recordPublication(command,actorId,now):
    await writer.resolve(command,actorId,now);
  return {result:{status:"applied" as const,operationId:command.operationId,...saved},
    effects:[{kind:command.type,entityId:saved.entityId,version:saved.version}]};
}
