import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import test from 'node:test';
import { CodexAppServerAdapter, RuntimeUnknownError } from '@evoloop/adapter-codex-app-server';
import type { WorkflowService } from '@evoloop/core';
import type { RuntimeWorkflowService } from '@evoloop/core/runtime';
import type { RuntimeRunRecord, RuntimeSessionRecord } from '@evoloop/contracts';
import type { RuntimeTurn } from '@evoloop/contracts/runtime';
import type { SessionMessageProcessing, SessionMessageRecord } from '@evoloop/contracts/session-messages';
import type { SessionMessageService } from '@evoloop/core/session-messages';
import { SessionMessagePump } from '../src/session-messages/pump.js';
import { bindingOf, RuntimeRunner } from '../src/runtime/runner.js';

// This composes the production adapter, message pump, and runner against a Node protocol fixture;
// it never starts Codex or a model.
const fixture=resolve(import.meta.dirname,'../../../packages/adapter-codex-app-server/test/fixture.mjs');
const scenarios=[
  {name:'normal shared Thread'},
  {name:'lost Task start acknowledgement',loseStartAck:true},
  {name:'lost Task binding acknowledgement',loseBindingAck:true},
] as const;

for(const scenario of scenarios){
  test(`ordinary message then Task use one full Session without replay: ${scenario.name}`,async()=>{
    const projectId=randomUUID(),sessionId=randomUUID(),revisionId=randomUUID(),actorId='fixture-business';
    const at=new Date().toISOString(),cwd='/tmp/evoloop-fixture',authorizationScope='fixture-business';
    const profile={revisionId,version:1,model:'gpt-6-sol',sandbox:'danger-full-access' as const,
      approvalPolicy:'never' as const,cwd,authorizationScope,provenance:'reserved' as const};
    const session:RuntimeSessionRecord={projectId,id:sessionId,roleId:randomUUID(),cwd,authorizationScope,
      model:profile.model,sandbox:profile.sandbox,approvalPolicy:profile.approvalPolicy,state:'ready',version:3,
      nativeThreadId:'thread-owned',nativeSessionId:'thread-owned',operationId:randomUUID(),actorId,
      createdAt:at,updatedAt:at,executionProfile:{revision:{...profile,projectId,sessionId,previousRevisionId:null,
        operationId:randomUUID(),actorId,reason:'full fixture profile',evidenceRef:null,createdAt:at},
        activationState:'active',activeRevisionId:revisionId,activationOperationId:null,attemptedAt:null,activationEvidence:null}};
    const operationId=randomUUID(),input=`[evoloop-run-operation:${operationId}]\nFixed Task input`;
    const run:RuntimeRunRecord={projectId,id:randomUUID(),taskId:randomUUID(),taskRevisionId:randomUUID(),
      basisSetId:randomUUID(),sessionId,operationId,input,inputHash:'a'.repeat(64),state:'requested',version:1,
      nativeTurnId:null,interruptRequested:false,resultSummary:null,actorId,createdAt:at,updatedAt:at,
      executionProfile:profile};
    const message:SessionMessageRecord={projectId,id:randomUUID(),operationId:randomUUID(),
      target:{kind:'owned',sessionId},senderActorId:'fixture-sender',content:'Continue this conversation',context:null,
      replyToMessageId:null,state:'queued',version:1,blockedReason:null,readReceipt:null,createdAt:at,updatedAt:at};
    const messageProcessingOperationId=randomUUID();
    const events:string[]=[];let taskVisible=false,taskStarts=0,bindAttempts=0,unknowns=0,settlements=0;
    let processing:SessionMessageProcessing|null=null;
    const workflow={getProject:async()=>({id:projectId}),listRuntimeSessions:async()=>[session],
      listRuntimeRuns:async()=>taskVisible?[run]:[],getRuntimeSession:async()=>session} as unknown as WorkflowService;
    const trusted={recoverDispatching:async()=>({sessions:[],runs:[]}),canStartRecoveredRun:async()=>true,
      beginDispatch:async()=>{events.push('Task durable beginDispatch');run.state='dispatching';run.version++;},
      bindTurn:async(_p:string,_id:string,turn:RuntimeTurn,proof:{kind:string;operationId:string})=>{
        bindAttempts++;assert.equal(proof.operationId,operationId);
        if(scenario.loseBindingAck&&proof.kind==='startReply')throw new Error('lost durable Run binding acknowledgement');
        if(run.state==='unknown')assert.equal(proof.kind,'historyMarker');
        run.state='running';run.nativeTurnId=turn.id;run.version++;return run;
      },
      markRunUnknown:async()=>{unknowns++;run.state='unknown';run.version++;return run;},
      recordTurn:async(_p:string,_id:string,turnId:string,status:'completed'|'failed'|'interrupted')=>{
        run.nativeTurnId=turnId;run.state=status;run.version++;return run;
      },
    } as unknown as RuntimeWorkflowService;
    const adapter=new CodexAppServerAdapter({executable:process.execPath,spawnArgs:[fixture,'full-sequence'],
      expectedVersion:'codex-cli 0.164.0-alpha.11.1',requestTimeoutMs:500,initializationTimeoutMs:5_000,
      verifyBinding:async()=>true});
    const nativeResume=adapter.resume.bind(adapter),nativeStart=adapter.startTurn.bind(adapter),nativeMessageStart=adapter.startConversationTurn.bind(adapter);
    adapter.resume=async(binding,spec)=>{
      if(taskVisible){
        assert.equal(run.state,'dispatching','Task dispatch must be durable before resuming the shared Thread');
        events.push('Task thread/resume');
      }else{
        assert.equal(processing?.state,'dispatching','message dispatch must be durable before resuming the shared Thread');
        events.push('message thread/resume');
      }
      return nativeResume(binding,spec);
    };
    adapter.startTurn=async(binding,content,op,frozenProfile)=>{
      assert.equal(run.state,'dispatching','Task dispatch must be durable before Task turn/start');
      assert.equal(content,input);assert.equal(op,operationId);assert.deepEqual(frozenProfile,profile);
      taskStarts++;events.push('Task turn/start');
      const started=await nativeStart(binding,content,op,frozenProfile);
      if(scenario.loseStartAck)throw new RuntimeUnknownError('turn/start',null,'fixture lost Task start acknowledgement after native completion');
      return started;
    };
    adapter.startConversationTurn=async(binding,content,op)=>{
      events.push('ordinary message turn/start');return nativeMessageStart(binding,content,op);
    };
    const runner=new RuntimeRunner({runtimeFactory:()=>adapter,workflow,trusted,
      principals:[{actorId,projectIds:[projectId],permissions:['read','write','review']}],
      canWrite:()=>true,allowedCwd:async()=>true,hasGrant:()=>true});
    (runner as unknown as {lightweightInput:()=>Promise<{input:string;protocol:string;contentHash:string;byteLength:number}>}).lightweightInput=async()=>
      ({input,protocol:'evoloop-lightweight-v1',contentHash:'a'.repeat(64),byteLength:Buffer.byteLength(input)});
    const messageService={
      pending:async()=>message.state==='queued'||message.state==='processing'||message.state==='unknown'?[message]:[],
      session:async()=>session,
      processing:async()=>processing,
      preflightDispatch:async()=>{},
      beginDispatch:async()=>{
        events.push('message durable beginDispatch');
        processing={projectId,id:randomUUID(),messageId:message.id,sessionId,operationId:messageProcessingOperationId,
          state:'dispatching',nativeTurnId:null,response:null,failure:null,version:1,startedAt:at,updatedAt:at};
        message.state='processing';message.version++;return processing;
      },
      bindTurn:async(_p:string,_id:string,turn:RuntimeTurn)=>{
        assert.ok(processing);processing.nativeTurnId=turn.id;processing.state='running';processing.version++;
        message.state='processing';return processing;
      },
      settle:async(_p:string,_id:string,turn:RuntimeTurn,response:string|null)=>{
        settlements++;assert.equal(turn.id,'turn-1');assert.equal(response,'reply-1');
        if(processing){processing.state='completed';processing.response=response;processing.version++;}
        message.state='replied';message.version++;
      },
      markUnknown:async()=>{message.state='unknown';message.version++;},
      failBeforeStart:async()=>{message.state='failed';message.version++;},
    } as unknown as SessionMessageService;
    const messagePump=new SessionMessagePump({service:messageService,runtime:()=>adapter,projects:async()=>[projectId],
      canStart:async()=>true,canWrite:()=>true,pollIntervalMs:1_000,onError:error=>{throw error;}});
    try{
      await runner.start();
      await messagePump.tick();
      assert.equal(message.state,'processing');assert.equal(processing?.nativeTurnId,'turn-1');
      await messagePump.tick();
      assert.equal(message.state,'replied');assert.equal(settlements,1);
      taskVisible=true;
      await runner.pump();
      const uncertain=!!scenario.loseStartAck||!!scenario.loseBindingAck;
      if(uncertain){
        assert.equal(run.state,'unknown');assert.equal(run.nativeTurnId,null);assert.equal(unknowns,1);
        await runner.pump();
      }
      assert.equal(run.state,'completed');assert.equal(run.nativeTurnId,'turn-2');
      assert.equal(run.operationId,operationId);assert.equal(run.input,input);assert.deepEqual(run.executionProfile,profile);
      assert.equal(session.executionProfile?.revision.revisionId,revisionId);
      assert.equal(taskStarts,1,'the original Task operation is the only Task turn/start call');
      assert.deepEqual(events,['message durable beginDispatch','ordinary message turn/start','message thread/resume',
        'Task durable beginDispatch','Task thread/resume','Task turn/start']);
      assert.equal(bindAttempts,scenario.loseBindingAck?2:1,
        'only a lost Run binding acknowledgement needs a second history-marker bind');
      const binding=bindingOf(session),turns=await adapter.listTurns(binding);
      assert.deepEqual(turns.data.map(turn=>turn.id),['turn-2','turn-1']);
      const [messageItems,taskItems]=await Promise.all([
        adapter.listItems(binding,'turn-1'),adapter.listItems(binding,'turn-2'),
      ]);
      assert.match(String((messageItems.data[0] as {text?:string}).text),
        new RegExp(`^\\[evoloop-message-operation:${messageProcessingOperationId}\\]`));
      assert.equal((taskItems.data[0] as {text?:string}).text,input);
      const observed=await adapter.inspect(binding) as {observedTurnStarts:number;observedResumes:number;lastTurnModel:string};
      assert.equal(observed.observedTurnStarts,2,'M and Task are the only native Turn starts');
      assert.equal(observed.observedResumes,2,'M and the Task each resume the same full Thread once');
      assert.equal(observed.lastTurnModel,'gpt-6-sol');
    }finally{await runner.stop();}
  });
}
