import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluateQueueEntry, evaluateQueueRelease } from "../src/queues/index.ts";
import type { ResidentQueueEntry, QueueSourceFacts, QueueReleaseEvidence } from "../../contracts/src/queues.ts";
const entry:ResidentQueueEntry={projectId:'p',queueId:'q',id:'e',taskId:'t',taskRevisionId:'r',sourceInputJson:'same',sessionId:'s',roleId:'role',position:0,dependsOn:[],consumerId:'consumer',useRequired:true,releaseRule:'accepted',state:'queued',holdCode:null,holdReason:null,claimId:null,version:1};
const facts:QueueSourceFacts={currentTaskRevisionId:'r',taskState:'in_progress',sessionReady:true,nativeThreadId:'thread',bindingCurrent:true,grantCurrent:true,conflictingRun:false,currentInputJson:'same'};
const evidence:QueueReleaseEvidence={currentTaskRevisionId:'done-revision',currentInputJson:'same',taskState:'done',deliveryId:'d',deliveryCurrent:true,deliveryPassed:true,observationId:'o',observationConsumerId:'consumer',observationUsed:true,closureId:'c',closureCurrent:true,boundedDecisionId:null,boundedDecisionActorId:null,boundedDecisionReason:null,nextResponsibility:null};
test('continuation is executable, but current revision, dependency, grant and unknown Run are gates',()=>{
  assert.equal(evaluateQueueEntry(entry,facts,true).ready,true);
  assert.equal(evaluateQueueEntry(entry,facts,false).code,'dependency');
  assert.equal(evaluateQueueEntry(entry,{...facts,currentTaskRevisionId:'new'},true).ready,true);
  assert.equal(evaluateQueueEntry(entry,{...facts,currentInputJson:'changed'},true).code,'task_changed');
  assert.equal(evaluateQueueEntry(entry,{...facts,grantCurrent:false},true).code,'grant_revoked');
  assert.equal(evaluateQueueEntry(entry,{...facts,conflictingRun:true},true).code,'run_in_flight');
});
test('release needs current closure, delivery and declared consumer use',()=>{
  assert.equal(evaluateQueueRelease(entry,evidence).ready,true);
  assert.equal(evaluateQueueRelease(entry,{...evidence,closureCurrent:false}).ready,false);
  assert.equal(evaluateQueueRelease(entry,{...evidence,observationConsumerId:'worker'}).ready,false);
  assert.equal(evaluateQueueRelease(entry,{...evidence,deliveryPassed:false}).ready,false);
});
test('bounded continuation requires explicit decision and unfinished responsibility',()=>{
  const bounded={...entry,releaseRule:'bounded_decision' as const};
  const base={...evidence,taskState:'in_progress' as const,closureCurrent:false};
  assert.equal(evaluateQueueRelease(bounded,{...base,boundedDecisionId:'decision',boundedDecisionActorId:'lead',boundedDecisionReason:'independent next work',nextResponsibility:'Lead tracks A'}).ready,true);
  assert.equal(evaluateQueueRelease(bounded,{...base,boundedDecisionId:'decision',boundedDecisionActorId:'lead',boundedDecisionReason:'independent next work',nextResponsibility:null}).ready,false);
});
