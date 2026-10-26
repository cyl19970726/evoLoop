import { createHash } from 'node:crypto';
import type { Principal, ResidentQueue, ResidentQueueEntry } from '@evoloop/contracts';
import type { DiscussionEvent } from '@evoloop/contracts/discussions';
import type { SessionMessageRecord } from '@evoloop/contracts/session-messages';
import type { WorkflowService } from '@evoloop/core';
import type { SessionMessageService } from '@evoloop/core/session-messages';
import { queueIntentId } from '../resident-queue/pump.js';

const terminal=new Set(['completed','failed','interrupted']);
const fixedUuid=(text:string):string=>{const h=createHash('sha256').update(text).digest('hex');
  return `${h.slice(0,8)}-${h.slice(8,12)}-5${h.slice(13,16)}-8${h.slice(17,20)}-${h.slice(20,32)}`;};
const eligible=(queue:ResidentQueue,entry:ResidentQueueEntry):boolean=>
  queue.adoptedVersion===queue.version && entry.state==='queued' && !entry.holdCode &&
  entry.dependsOn.every(id=>queue.entries.find(x=>x.id===id)?.state==='released') &&
  !queue.entries.some(other=>other.sessionId===entry.sessionId&&other.position<entry.position&&other.state!=='released');
function answeredPairs(events:DiscussionEvent[]):Array<{questionEventId:string;answerEventId:string}>{
  const questions=events.filter(e=>e.collaborationPayload?.type==='message'&&e.collaborationPayload.kind==='question');
  const pairs:Array<{questionEventId:string;answerEventId:string}>=[];
  for(const question of questions){const answer=events.find(e=>e.collaborationPayload?.type==='message'&&
    e.collaborationPayload.kind==='answer'&&e.collaborationPayload.replyToEventId===question.id);
    if(answer)pairs.push({questionEventId:question.id,answerEventId:answer.id});}
  return pairs.slice(0,20);
}
export interface SessionMessageSchedulingDeps {workflow:WorkflowService;service:SessionMessageService;
  principals():Promise<Principal[]>;onError(error:unknown):void}
/** Durable fairness and exact Task answer priority; the existing queue command remains business authority. */
export function sessionMessageCanStart(deps:SessionMessageSchedulingDeps){
  return async(message:SessionMessageRecord):Promise<boolean>=>{
    if(message.target.kind!=='owned')return false;
    const sessionId=message.target.sessionId;
    const principal=(await deps.principals()).find(p=>p.projectIds.includes(message.projectId)&&p.permissions.includes('read'));
    if(!principal){await deps.service.noteBlocked(message.projectId,message.id,'Project reader is unavailable');return false;}
    const queues=await deps.workflow.listResidentQueues(principal,message.projectId);
    const claimed=queues.flatMap(queue=>queue.entries.map(entry=>({queue,entry}))).filter(x=>
      x.entry.sessionId===sessionId&&x.entry.state==='claimed'&&!!x.entry.claimId&&!x.entry.holdCode);
    for(const {queue,entry} of claimed){
      const attempts=await deps.workflow.listResidentQueueAttempts(principal,message.projectId,entry.claimId!);
      const last=attempts.at(-1);if(!last)continue;
      const run=await deps.workflow.getRuntimeRun(principal,message.projectId,last.runId);
      if(!terminal.has(run.state)){
        await deps.service.noteBlocked(message.projectId,message.id,'Original Task turn is active or unresolved');return false;
      }
      const channel=fixedUuid(`queue-channel:${message.projectId}:${last.runId}`);
      const events=await deps.workflow.listDiscussionEvents(principal,message.projectId,channel);
      const pairs=answeredPairs(events);
      if(!pairs.length)continue;
      const lead=(await deps.principals()).find(p=>p.actorId===queue.actorId&&p.projectIds.includes(message.projectId)&&
        p.permissions.includes('read')&&p.permissions.includes('write')&&p.permissions.includes('review'));
      if(!lead){await deps.service.noteBlocked(message.projectId,message.id,'Original Task answer awaits its queue controller');return false;}
      const answerKey=pairs.map(p=>`${p.questionEventId}:${p.answerEventId}`).join('|');
      const runId=queueIntentId('answered-run',queue.id,entry.id,last.runId,answerKey);
      const operationId=queueIntentId('answered-operation',queue.id,entry.id,last.runId,answerKey);
      const result=await deps.workflow.execute(lead,{type:'queue.continue',projectId:message.projectId,
        queueId:queue.id,entryId:entry.id,claimId:entry.claimId!,runId,runOperationId:operationId,
        operationId,reason:'Continue original Task from its fixed answered question',answeredQuestions:pairs});
      if(result.status==='rejected'){
        await deps.service.noteBlocked(message.projectId,message.id,`Original Task answer awaiting review: ${result.code}`);
        deps.onError(new Error(`queue.continue ${result.code}`));
      }else await deps.service.noteBlocked(message.projectId,message.id,'Original Task answer continues first');
      return false;
    }
    const readyBusiness=queues.some(queue=>queue.entries.some(entry=>entry.sessionId===sessionId&&eligible(queue,entry)));
    if(readyBusiness&&await deps.service.mustYieldBusiness(message.projectId,sessionId)){
      await deps.service.noteBlocked(message.projectId,message.id,'Waiting for one ready Task turn after the previous ordinary message');
      return false;
    }
    // Final native/permission gates may still block; beginDispatch owns clearing the reason.
    return true;
  };
}
