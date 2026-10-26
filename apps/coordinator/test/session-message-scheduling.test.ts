import assert from 'node:assert/strict';
import { createHash,randomUUID } from 'node:crypto';
import test from 'node:test';
import type { Principal, ResidentQueue } from '@evoloop/contracts';
import type { SessionMessageRecord } from '@evoloop/contracts/session-messages';
import type { WorkflowService } from '@evoloop/core';
import type { SessionMessageService } from '@evoloop/core/session-messages';
import { sessionMessageCanStart } from '../src/session-messages/scheduling.ts';

const projectId=randomUUID(),sessionId=randomUUID(),taskId=randomUUID(),roleId=randomUUID(),queueId=randomUUID(),entryId=randomUUID(),claimId=randomUUID();
const lead:Principal={actorId:'lead',projectIds:[projectId],permissions:['read','write','review']};
const message:SessionMessageRecord={projectId,id:randomUUID(),operationId:randomUUID(),target:{kind:'owned',sessionId},
  senderActorId:'sender',content:'Question',context:null,replyToMessageId:null,state:'queued',version:1,blockedReason:null,
  readReceipt:null,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};
function queue(state:'queued'|'claimed'):ResidentQueue{return{projectId,id:queueId,version:1,adoptedVersion:1,maxRuns:3,reason:'ordered',actorId:'lead',
  entries:[{projectId,queueId,id:entryId,taskId,taskRevisionId:randomUUID(),sourceInputJson:'{}',sessionId,roleId,
    position:0,dependsOn:[],consumerId:'consumer',useRequired:false,releaseRule:'accepted',state,
    holdCode:null,holdReason:null,claimId:state==='claimed'?claimId:null,version:1}]};}
const fakeService=(mustYield:boolean,blocked:string[])=>({
  noteBlocked:async(_project:string,_id:string,reason:string|null)=>{if(reason)blocked.push(reason);},
  mustYieldBusiness:async()=>mustYield,
}) as unknown as SessionMessageService;

test('a fixed answer in the original Task channel continues before ordinary dispatch',async()=>{
  const previousRunId=randomUUID(),question=randomUUID(),answer=randomUUID(),blocked:string[]=[];
  const calls:unknown[]=[];let readChannel='';
  const workflow={listResidentQueues:async()=>[queue('claimed')],listResidentQueueAttempts:async()=>[{runId:previousRunId}],
    getRuntimeRun:async()=>({state:'completed'}),listDiscussionEvents:async(_p:unknown,_project:unknown,channel:string)=>{
      readChannel=channel;return[
        {id:question,collaborationPayload:{type:'message',kind:'question'}},
        {id:answer,collaborationPayload:{type:'message',kind:'answer',replyToEventId:question}},
      ];},execute:async(_lead:unknown,command:unknown)=>{calls.push(command);return{status:'applied'};}} as unknown as WorkflowService;
  const canStart=sessionMessageCanStart({workflow,service:fakeService(false,blocked),principals:async()=>[lead],onError:e=>{throw e;}});
  assert.equal(await canStart(message),false);
  assert.equal(calls.length,1);
  assert.deepEqual((calls[0] as {answeredQuestions:unknown}).answeredQuestions,[{questionEventId:question,answerEventId:answer}]);
  const h=createHash('sha256').update(`queue-channel:${projectId}:${previousRunId}`).digest('hex');
  assert.equal(readChannel,`${h.slice(0,8)}-${h.slice(8,12)}-5${h.slice(13,16)}-8${h.slice(17,20)}-${h.slice(20,32)}`);
  assert.match(blocked[0]??'',/Original Task answer/);
});

test('durable yield marker gives a ready business entry one turn, then allows the next message',async()=>{
  const blocked:string[]=[];
  const workflow={listResidentQueues:async()=>[queue('queued')]} as unknown as WorkflowService;
  const waiting=sessionMessageCanStart({workflow,service:fakeService(true,blocked),principals:async()=>[lead],onError:e=>{throw e;}});
  assert.equal(await waiting(message),false);assert.match(blocked[0]??'',/one ready Task turn/);
  const resumed=sessionMessageCanStart({workflow,service:fakeService(false,blocked),principals:async()=>[lead],onError:e=>{throw e;}});
  assert.equal(await resumed(message),true);
});

test('scheduling eligibility leaves the last blocked reason until actual dispatch',async()=>{
  const changes:Array<string|null>=[];
  const blocked={...message,blockedReason:'Owned native thread is active or its idle state cannot be verified'};
  const workflow={listResidentQueues:async()=>[]} as unknown as WorkflowService;
  const service={noteBlocked:async(_project:string,_message:string,reason:string|null)=>{changes.push(reason);},
    mustYieldBusiness:async()=>false} as unknown as SessionMessageService;
  const canStart=sessionMessageCanStart({workflow,service,principals:async()=>[lead],onError:e=>{throw e;}});
  assert.equal(await canStart(blocked),true);
  assert.deepEqual(changes,[], 'later native qualification can still fail, so scheduling alone must not clear the reason');
});
