import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import test from 'node:test';
import { CodexAppServerAdapter } from '@evoloop/adapter-codex-app-server';
import type { WorkflowService } from '@evoloop/core';
import type { RuntimeWorkflowService } from '@evoloop/core/runtime';
import type { RuntimeRunRecord, RuntimeSessionRecord } from '@evoloop/contracts';
import type { RuntimeTurn } from '@evoloop/contracts/runtime';
import { bindingOf, RuntimeRunner } from '../src/runtime/runner.js';

// This composes the production adapter and runner against a protocol fixture; it never runs a model.
const fixture=resolve(import.meta.dirname,'../../../packages/adapter-codex-app-server/test/fixture.mjs');
const cases=[
  {version:'0.154.0',sandbox:'read-only',mode:'message-profile-loaded-legacy-read-only'},
  {version:'0.154.0',sandbox:'workspace-write',mode:'message-profile-loaded-legacy-workspace-write'},
  {version:'0.164.0-alpha.11.1',sandbox:'read-only',mode:'message-profile-loaded-read-only'},
  {version:'0.164.0-alpha.11.1',sandbox:'workspace-write',mode:'message-profile-loaded-workspace-write'},
  {version:'0.164.0-alpha.11.1',sandbox:'read-only',mode:'message-profile-loaded-read-only-lost'},
  {version:'0.164.0-alpha.11.1',sandbox:'read-only',mode:'message-profile-loaded-read-only-reject'},
  {version:'0.164.0-alpha.11.1',sandbox:'read-only',mode:'message-profile-loaded-read-only',loseBinding:true},
] as const;

for(const scenario of cases){
  test(`adapter and runner preserve one original operation after M: ${scenario.mode}${'loseBinding' in scenario?' / lost binding':''}`,async()=>{
    const projectId=randomUUID(),sessionId=randomUUID(),revisionId=randomUUID(),actorId='fixture-business';
    const at=new Date().toISOString();
    const snapshot={revisionId,version:1,model:'gpt-6-sol',sandbox:scenario.sandbox,approvalPolicy:'on-request' as const,
      cwd:'/tmp/evoloop-fixture',authorizationScope:'fixture-business',provenance:'legacy_session_identity' as const};
    const session:RuntimeSessionRecord={projectId,id:sessionId,roleId:randomUUID(),cwd:snapshot.cwd,
      authorizationScope:snapshot.authorizationScope,model:snapshot.model,sandbox:snapshot.sandbox,
      approvalPolicy:snapshot.approvalPolicy,state:'ready',version:3,nativeThreadId:'thread-owned',
      nativeSessionId:'thread-owned',operationId:randomUUID(),actorId,createdAt:at,updatedAt:at,
      executionProfile:{revision:{...snapshot,projectId,sessionId,previousRevisionId:null,
        operationId:randomUUID(),actorId,reason:'fixed fixture launch profile',evidenceRef:null,createdAt:at},
        activationState:'active',activeRevisionId:revisionId,activationOperationId:null,attemptedAt:null,activationEvidence:null}};
    const operationId=randomUUID(),input=`[evoloop-run-operation:${operationId}]\nFixed business fixture input`;
    const run:RuntimeRunRecord={projectId,id:randomUUID(),taskId:randomUUID(),taskRevisionId:randomUUID(),
      basisSetId:randomUUID(),sessionId,operationId,input,inputHash:'a'.repeat(64),state:'requested',version:1,
      nativeTurnId:null,interruptRequested:false,resultSummary:null,actorId,createdAt:at,updatedAt:at,
      executionProfile:snapshot};
    const adapter=new CodexAppServerAdapter({executable:process.execPath,spawnArgs:[fixture,scenario.mode],
      expectedVersion:`codex-cli ${scenario.version}`,requestTimeoutMs:500,initializationTimeoutMs:5_000,
      enableRestrictedMessagePermissions:true,
      verifyBinding:async()=>true,threadConfig:async()=>scenario.sandbox==='workspace-write'?
        {'sandbox_workspace_write.network_access':false}:undefined});
    const steps:string[]=[];let permits=0,unknowns=0,bindings=0;
    const workflow={getProject:async()=>({id:projectId}),listRuntimeSessions:async()=>[session],
      listRuntimeRuns:async()=>[run],getRuntimeSession:async()=>session} as unknown as WorkflowService;
    const trusted={recoverDispatching:async()=>({sessions:[],runs:[]}),canStartRecoveredRun:async()=>true,
      beginDispatch:async()=>{steps.push('durable permit');permits++;run.state='dispatching';run.version++;},
      bindTurn:async(_p:string,_id:string,turn:RuntimeTurn,proof:{kind:string;operationId:string})=>{
        bindings++;assert.equal(proof.operationId,operationId);
        if('loseBinding' in scenario&&bindings===1)throw new Error('lost durable binding acknowledgement');
        if(run.state==='unknown')assert.equal(proof.kind,'historyMarker');
        run.state='running';run.nativeTurnId=turn.id;run.version++;return run;
      },
      markRunUnknown:async()=>{unknowns++;run.state='unknown';run.version++;return run;},
      recordTurn:async()=>run,
    } as unknown as RuntimeWorkflowService;
    const resume=adapter.resume.bind(adapter),start=adapter.startTurn.bind(adapter);
    adapter.resume=async(binding,spec,dispatchOperationId)=>{
      assert.equal(permits,1,'business resume must follow the durable Run permit');
      assert.equal(dispatchOperationId,operationId);
      steps.push('business resume');return resume(binding,spec,dispatchOperationId);
    };
    adapter.startTurn=async(binding,content,op,profile)=>{
      assert.equal(permits,1);assert.equal(content,input);assert.equal(op,operationId);
      assert.deepEqual(profile,snapshot);steps.push('business turn/start');return start(binding,content,op,profile);
    };
    const runner=new RuntimeRunner({runtimeFactory:()=>adapter,workflow,trusted,
      principals:[{actorId,projectIds:[projectId],permissions:['read','write','review']}],
      canWrite:()=>true,allowedCwd:async()=>true,hasGrant:()=>true});
    (runner as unknown as {input:()=>Promise<{input:string}>}).input=async()=>({input});
    try{
      await adapter.open();const binding=bindingOf(session);await adapter.registerBinding(binding);
      assert.equal((await adapter.qualifyReadOnlyThread(binding)).available,true);
      assert.equal((await adapter.startReadOnlyTurn(binding,'Ordinary fixture M',randomUUID())).id,'turn-1');
      assert.equal(adapter.needsBusinessRestore(binding),true);
      await runner.start();
      assert.deepEqual(steps,['durable permit','business resume','business turn/start']);
      const uncertain=scenario.mode.endsWith('-lost')||scenario.mode.endsWith('-reject');
      if(uncertain){
        assert.equal(run.state,'unknown');assert.equal(run.nativeTurnId,null);assert.equal(unknowns,1);
        assert.equal(runner.status(projectId).faults[0]?.phase,'run_start');
        assert.equal(adapter.needsBusinessRestore(binding),true);
      }else if('loseBinding' in scenario){
        assert.equal(run.state,'unknown');assert.equal(unknowns,1);
        assert.equal(runner.status(projectId).faults[0]?.phase,'run_bind');
      }else{
        assert.equal(run.state,'running');assert.equal(run.nativeTurnId,'turn-2');assert.equal(unknowns,0);
        assert.equal(adapter.needsBusinessRestore(binding),false);
      }
      await runner.pump();
      const observed=await adapter.inspect(binding) as {observedTurnStarts:number;observedResumes:number;lastTurnModel:string};
      assert.equal(observed.observedTurnStarts,2,'M and the single original business start are the only Turn requests');
      assert.equal(observed.observedResumes,2,'M and the single business rejoin are the only resume requests');
      assert.equal(observed.lastTurnModel,uncertain?null:'gpt-6-sol');assert.equal(permits,1);
      if('loseBinding' in scenario){assert.equal(run.state,'running');assert.equal(run.nativeTurnId,'turn-2');}
      assert.equal(run.operationId,operationId);assert.equal(run.input,input);assert.deepEqual(run.executionProfile,snapshot);
      assert.deepEqual(steps,['durable permit','business resume','business turn/start']);
    }finally{await runner.stop();}
  });
}
