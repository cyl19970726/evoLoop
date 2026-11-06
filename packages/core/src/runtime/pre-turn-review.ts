import type { PreTurnReviewDecision, Reader } from "@evoloop/contracts/ports";
import { DomainError } from "@evoloop/contracts/ports";
import { canonicalTaskInputJson } from "../task-input.js";

/** The exact HTTP intent, including expected versions, is bound to one decision ID. */
export function reviewIntentJson(actorId:string,kind:PreTurnReviewDecision["kind"],
  subjectId:string,command:object):string{
  return canonicalTaskInputJson({actorId,kind,subjectId,command});
}

export async function priorReviewDecision<T extends PreTurnReviewDecision["result"]>(
  tx:Reader,operationId:string,actorId:string,kind:PreTurnReviewDecision["kind"],
  subjectId:string,intentJson:string):Promise<T|null>{
  const prior=await tx.getPreTurnReviewDecision(operationId);
  if(!prior){
    if(await tx.getOperation(operationId))
      throw new DomainError("PRE_TURN_DECISION_REUSED","decision ID belongs to another operation");
    return null;
  }
  if(prior.actorId!==actorId||prior.kind!==kind||prior.subjectId!==subjectId||prior.intentJson!==intentJson)
    throw new DomainError("PRE_TURN_DECISION_REUSED","decision ID already identifies another review intent");
  return prior.result as T;
}
