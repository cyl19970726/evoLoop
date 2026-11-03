import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { Principal } from '@evoloop/contracts';
import type { Transaction } from '@evoloop/contracts/ports';
import { DomainError } from '@evoloop/contracts/ports';
import type { SessionMessageCommand, SessionMessageManualStopEvidence,
  SessionMessageProcessing, SessionMessageRecord } from '@evoloop/contracts/session-messages';
import { applySessionMessage } from '../src/session-messages/index.ts';

const projectId=randomUUID(),sessionId=randomUUID(),messageId=randomUUID(),processingId=randomUUID();
const principal:Principal={actorId:'reviewer',projectIds:[projectId],permissions:['read','write','review']};
const now='2026-11-03T04:00:00.000Z';
const command:Extract<SessionMessageCommand,{type:'session.message.manualStop'}>={
  type:'session.message.manualStop',projectId,operationId:randomUUID(),messageId,sessionId,processingId,
  preflightId:randomUUID(),
  nativeTurnId:'original-turn',expectedMessageVersion:2,expectedProcessingVersion:3,
  oldCoordinatorPid:101,oldNativePid:102,oldCoordinatorStartIdentity:'coordinator-start',
  oldNativeStartIdentity:'native-start',exitEvidenceRef:'/private/exit.json',exitEvidenceHash:'a'.repeat(64),
  observedNativeStatus:'inProgress',observedThreadStatus:'notLoaded',observedItemCount:1,
  observedItemIdsHash:'b'.repeat(64),reason:'Reviewer confirmed the old owner exited and original work remains unproven',
};
const message:SessionMessageRecord={projectId,id:messageId,operationId:randomUUID(),target:{kind:'owned',sessionId},
  senderActorId:'root',content:'original request',context:null,replyToMessageId:null,state:'unknown',version:2,
  blockedReason:null,readReceipt:null,createdAt:now,updatedAt:now};
const processing:SessionMessageProcessing={projectId,id:processingId,messageId,sessionId,operationId:randomUUID(),
  state:'unknown',nativeTurnId:'original-turn',response:null,failure:'Original owner read became unknown',
  readOnlyPolicyFingerprint:'c'.repeat(64),receiverActorId:'leader',version:3,startedAt:now,updatedAt:now};

test('reviewed manual stop records prior unknown and releases only the original processing',async()=>{
  let savedMessage={...message},savedProcessing={...processing};
  let evidence:SessionMessageManualStopEvidence|null=null,settled=false;
  const tx={sessionMessages:{
    getSessionMessage:async()=>savedMessage,getSessionMessageProcessing:async()=>savedProcessing,
    getSessionMessageManualStopPreflight:async()=>({preflightId:command.preflightId,
      capturedByActorId:'root',
      processingId,sessionId,nativeTurnId:command.nativeTurnId,
      oldCoordinatorPid:command.oldCoordinatorPid,oldNativePid:command.oldNativePid,
      oldCoordinatorStartIdentity:command.oldCoordinatorStartIdentity,
      oldNativeStartIdentity:command.oldNativeStartIdentity}),
    getSessionMessageManualStopEvidence:async()=>evidence,
    insertSessionMessageManualStopEvidence:async(value:SessionMessageManualStopEvidence)=>{evidence=value;},
    updateSessionMessageProcessing:async(value:SessionMessageProcessing,expected:number)=>{
      assert.equal(expected,3);savedProcessing=value;},
    updateSessionMessage:async(value:SessionMessageRecord,expected:number)=>{
      assert.equal(expected,2);savedMessage=value;},
    markSessionMessageSettled:async()=>{settled=true;},
  }} as unknown as Transaction;
  const result=await applySessionMessage(tx,principal,command,now);
  assert.equal(result.result.status,'applied');
  assert.equal(savedMessage.state,'failed');
  assert.equal(savedProcessing.state,'failed');
  assert.match(savedProcessing.failure??'',/native completion unproven/);
  assert.equal(evidence?.priorFailure,'Original owner read became unknown');
  assert.equal(evidence?.nativeTurnId,'original-turn');
  assert.equal(settled,true);
  await assert.rejects(applySessionMessage(tx,principal,command,now),
    (error:unknown)=>error instanceof DomainError && error.code==='VERSION_CONFLICT');
});

test('manual stop rejects a changed processing version before recording stop evidence',async()=>{
  let inserted=false;
  const tx={sessionMessages:{getSessionMessage:async()=>message,
    getSessionMessageProcessing:async()=>({...processing,version:4}),
    getSessionMessageManualStopPreflight:async()=>null,
    insertSessionMessageManualStopEvidence:async()=>{inserted=true;}}} as unknown as Transaction;
  await assert.rejects(applySessionMessage(tx,principal,command,now),
    (error:unknown)=>error instanceof DomainError && error.code==='VERSION_CONFLICT');
  assert.equal(inserted,false);
});

test('manual stop refuses a reviewer who captured their own pre-stop anchor',async()=>{
  let inserted=false;
  const tx={sessionMessages:{getSessionMessage:async()=>message,
    getSessionMessageProcessing:async()=>processing,
    getSessionMessageManualStopEvidence:async()=>null,
    getSessionMessageManualStopPreflight:async()=>({capturedByActorId:principal.actorId}),
    insertSessionMessageManualStopEvidence:async()=>{inserted=true;}}} as unknown as Transaction;
  await assert.rejects(applySessionMessage(tx,principal,command,now),
    (error:unknown)=>error instanceof DomainError && error.code==='MANUAL_STOP_SELF_ATTESTATION');
  assert.equal(inserted,false);
});
