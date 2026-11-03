import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Command, RuntimeSessionRecord } from '@evoloop/contracts';
import type { RuntimeTurn } from '@evoloop/contracts/runtime';
import { DomainError } from '@evoloop/contracts/ports';
import { previewManualStop, verifyManualStop } from '../src/session-messages/manual-stop.ts';

const digest = (value:string) => createHash('sha256').update(value).digest('hex');
const session = ():RuntimeSessionRecord => ({projectId:randomUUID(),id:randomUUID(),roleId:randomUUID(),
  cwd:'/tmp/evoloop-manual-stop',authorizationScope:'project',model:'model',sandbox:'danger-full-access',
  approvalPolicy:'never',state:'ready',version:1,nativeThreadId:'original-thread',nativeSessionId:'original-native',
  operationId:randomUUID(),actorId:'leader',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()});
const runtime = (nativeStatus:RuntimeTurn['status']='interrupted',threadStatus='idle',completedAtUtc:string|null=null) => ({
  isReady:()=>true,registerBinding:async()=>{},
  inspect:async()=>({thread:{id:'original-thread',sessionId:'original-native',cwd:'/tmp/evoloop-manual-stop',
    status:{type:threadStatus}}}),
  listTurns:async()=>({data:[{id:'original-turn',status:nativeStatus,completedAtUtc}],nextCursor:null}),
  listItems:async()=>({data:[{id:'original-user',type:'userMessage'}],nextCursor:null}),
});
const rejected = (code:string) => (error:unknown) => error instanceof DomainError && error.code===code;

test('owner preview keeps a timestampless original Turn separate from native completion',async()=>{
  const original=session();
  const candidate=await previewManualStop(runtime(),original,'original-turn');
  assert.equal(candidate.eligible,true);
  assert.equal(candidate.completedAtUtc,null);
  assert.equal(candidate.itemCount,1);
  assert.equal(candidate.itemIdsHash,digest(JSON.stringify(['original-user'])));
  assert.equal((await previewManualStop(runtime('inProgress','active'),original,'original-turn')).eligible,false);
  assert.equal((await previewManualStop(runtime('completed','idle',new Date().toISOString()),original,'original-turn')).eligible,false);
  await assert.rejects(previewManualStop(runtime(),original,'other-turn'),rejected('MANUAL_STOP_TURN_UNREADABLE'));
  const paged={...runtime(),listTurns:async(_binding:unknown,cursor?:string)=>
    cursor==='next'?{data:[{id:'original-turn',status:'interrupted' as const,completedAtUtc:null}],nextCursor:null}:
      {data:[],nextCursor:'next'}};
  assert.equal((await previewManualStop(paged,original,'original-turn')).eligible,true);
});

test('manual stop requires a private exact exit manifest, absent old processes and unchanged native preview',async()=>{
  const original=session(),messageId=randomUUID(),processingId=randomUUID();
  const root=await mkdtemp(join(tmpdir(),'evoloop-manual-stop-'));
  try{
    const path=join(root,'exit.json');
    const preflightId=randomUUID();
    const anchor={format:'evoloop-message-preflight-v1',preflightId,host:hostname(),capturedByActorId:'root',
      projectId:original.projectId,sessionId:original.id,threadId:original.nativeThreadId,
      messageId,processingId,nativeTurnId:'original-turn',
      osObservedAt:'2026-11-03T01:00:00Z',databaseLease:{clientPort:56000,serverPort:55461},
      oldCoordinator:{pid:910001,startIdentity:'old-coordinator-start'},
      oldNative:{pid:910002,startIdentity:'old-native-start',parentPid:910001}};
    const preflight={...anchor,preStopEvidenceJson:JSON.stringify(anchor),
      preStopEvidenceHash:digest(JSON.stringify(anchor)),captureFileHash:'c'.repeat(64),
      captureFileRef:join(root,'capture.json'),capturedAt:'2026-11-03T01:00:30Z',
      nativeThreadId:'original-thread',messageVersion:2,processingVersion:3,listenPort:4318,
      oldCoordinatorPid:910001,oldNativePid:910002,
      oldCoordinatorStartIdentity:'old-coordinator-start',oldNativeStartIdentity:'old-native-start'};
    const manifest={host:hostname(),projectId:original.projectId,sessionId:original.id,
      threadId:original.nativeThreadId,messageId,processingId,nativeTurnId:'original-turn',
      preflightId,preStopEvidenceHash:preflight.preStopEvidenceHash,captureFileHash:preflight.captureFileHash,
      oldCoordinator:{pid:910001,startIdentity:'old-coordinator-start'},
      oldNative:{pid:910002,startIdentity:'old-native-start'},
      preStopObservedAt:'2026-11-03T01:00:00Z',postStopObservedAt:'2026-11-03T01:02:00Z',
      preStopEvidence:anchor,
      postStopEvidence:'Both original processes exited and supervisor was disabled'};
    const bytes=JSON.stringify(manifest);
    await writeFile(path,bytes);await chmod(path,0o600);
    const command={type:'session.message.manualStop',projectId:original.projectId,operationId:randomUUID(),
      messageId,sessionId:original.id,processingId,nativeTurnId:'original-turn',preflightId,
      expectedMessageVersion:2,expectedProcessingVersion:3,reason:'Reviewed first maintenance handoff',
      oldCoordinatorPid:910001,oldNativePid:910002,
      oldCoordinatorStartIdentity:'old-coordinator-start',oldNativeStartIdentity:'old-native-start',
      exitEvidenceRef:path,exitEvidenceHash:digest(bytes),observedNativeStatus:'interrupted',
      observedThreadStatus:'idle',observedItemCount:1,
      observedItemIdsHash:digest(JSON.stringify(['original-user']))} as Extract<Command,{type:'session.message.manualStop'}>;
    const preview=await previewManualStop(runtime(),original,'original-turn');
    await verifyManualStop(command,original,preview,preflight,root,()=>true,()=>true);
    await assert.rejects(verifyManualStop(command,original,preview,preflight,root,()=>true,pid=>pid!==910002),
      rejected('MANUAL_STOP_OWNER_LIVE'));
    await assert.rejects(verifyManualStop({...command,observedItemCount:0},original,preview,preflight,root,()=>true,()=>true),
      rejected('MANUAL_STOP_NATIVE_CHANGED'));
    await assert.rejects(verifyManualStop({...command,exitEvidenceHash:'0'.repeat(64)},original,preview,preflight,root,()=>true,()=>true),
      rejected('MANUAL_STOP_EVIDENCE'));
    await assert.rejects(verifyManualStop(command,original,{...preview,threadStatus:'active',eligible:false},preflight,root,()=>true,()=>true),
      rejected('MANUAL_STOP_NATIVE_CHANGED'));
    await assert.rejects(verifyManualStop(command,original,preview,{...preflight,oldNativePid:1},root,()=>true,()=>true),
      rejected('MANUAL_STOP_EVIDENCE'));
  }finally{await rm(root,{recursive:true,force:true});}
});
