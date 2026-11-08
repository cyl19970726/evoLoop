import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import pg from 'pg';
import {migrate,PostgresUnitOfWork} from '@evoloop/adapter-postgres';
import {CompactionMaintenance} from '../../apps/coordinator/src/runtime/compaction.ts';
import {buildServer} from '../../apps/coordinator/src/server.ts';
import {WorkflowService} from '@evoloop/core';
import {RuntimeCompactionPreflightError,RuntimeUnknownError} from '@evoloop/adapter-codex-app-server';
import {RuntimeRunner} from '../../apps/coordinator/src/runtime/runner.ts';
import type {RuntimeBinding,RuntimeCompactionObservation} from '@evoloop/contracts/runtime';
import type {RuntimeSessionRecord} from '@evoloop/contracts';
import {currentSessionGrant} from '../../apps/coordinator/src/orchestration/dynamic-admission.ts';
import {grantAllowsModel} from '../../apps/coordinator/src/configuration.ts';

test('HTTP compaction admits a current static grant and rejects revoked or changed authority',async()=>{
  const url=process.env.TEST_DATABASE_URL;
  if(!url||!/^\/evoloop(?:_[a-z0-9]+)*_test$/.test(new URL(url).pathname))
    throw Error('dedicated isolated database required');
  const schema=`compact_static_${randomUUID().replaceAll('-','').slice(0,12)}`;
  await migrate(url,schema);
  const pool=new pg.Pool({connectionString:url,options:`-c search_path=${schema}`});
  try{
    const projectId=randomUUID(),sessionId=randomUUID(),threadId=randomUUID(),roleId=randomUUID();
    const reviewer={actorId:'maintainer',projectIds:[projectId],permissions:['read' as const,'write' as const,'review' as const]};
    const revisionId=randomUUID();
    const owner={projectId,id:sessionId,roleId,actorId:'leader',cwd:'/tmp/compact-static',
      authorizationScope:'resident:leader',model:'gpt-6-astra',sandbox:'danger-full-access',
      approvalPolicy:'never',state:'ready',version:1,nativeThreadId:threadId,
      nativeSessionId:randomUUID(),operationId:randomUUID(),createdAt:new Date().toISOString(),
      updatedAt:new Date().toISOString(),executionProfile:{revision:{projectId,sessionId,
        revisionId,version:2,previousRevisionId:randomUUID(),model:'gpt-6-astra',
        reasoningEffort:'max',sandbox:'danger-full-access',approvalPolicy:'never',
        cwd:'/tmp/compact-static',authorizationScope:'resident:leader',provenance:'revised',
        operationId:randomUUID(),actorId:'leader',reason:'active profile',evidenceRef:null,
        createdAt:new Date().toISOString()},activationState:'active',activeRevisionId:revisionId,
        activeModel:'gpt-6-astra',activeReasoningEffort:'max',activationOperationId:randomUUID(),
        attemptedAt:new Date().toISOString(),activationEvidence:'same Thread readback'}} as RuntimeSessionRecord;
    await pool.query('INSERT INTO project(project_id,title,created_at) VALUES($1,$2,now())',[projectId,'static grant test']);
    await pool.query(`INSERT INTO runtime_session(project_id,session_id,role_id,cwd,authorization_scope,model,
      sandbox,approval_policy,state,version,native_thread_id,native_session_id,operation_id,actor_id,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,'danger-full-access','never','ready',1,$7,$8,$9,$10,now(),now())`,
      [projectId,sessionId,roleId,owner.cwd,owner.authorizationScope,owner.model,threadId,
        owner.nativeSessionId,owner.operationId,owner.actorId]);
    const messageId=randomUUID();
    await pool.query(`INSERT INTO session_message(project_id,message_id,operation_id,target_kind,session_id,
      sender_actor_id,content,state,version,created_at,updated_at)
      VALUES($1,$2,$3,'owned',$4,'sender','terminal error','failed',1,now(),now())`,
      [projectId,messageId,randomUUID(),sessionId]);
    await pool.query(`INSERT INTO session_message_processing(project_id,processing_id,message_id,session_id,
      operation_id,receiver_actor_id,state,native_turn_id,read_only_policy_fingerprint,version,started_at,updated_at)
      VALUES($1,$2,$3,$4,$5,'leader','failed','old-turn',$6,1,now(),now())`,
      [projectId,randomUUID(),messageId,sessionId,randomUUID(),'a'.repeat(64)]);
    await pool.query(`UPDATE session_recovery_gate SET phase='blocked',cause_kind='message',
      cause_id=$3,cause_state='failed',version=version+1 WHERE project_id=$1 AND session_id=$2`,
      [projectId,sessionId,messageId]);
    const gateVersion=(await pool.query<{version:number}>(`SELECT version FROM session_recovery_gate
      WHERE project_id=$1 AND session_id=$2`,[projectId,sessionId])).rows[0]!.version;
    let grantEnabled=true,cwdAllowed=true,starts=0;
    const grant={projectId,actorId:reviewer.actorId,roleId,authorizationScope:owner.authorizationScope,
      cwd:owner.cwd,sandbox:owner.sandbox,model:'gpt-6-sol',models:['gpt-6-astra'],
      approvalPolicy:owner.approvalPolicy};
    const runtime={isReady:()=>true,registerBinding:async()=>{},
      observeCompaction:async()=>({threadId,threadStatus:'systemError',model:'gpt-6-astra',
        reasoningEffort:'max',latestTurnId:'old-turn',latestTurnStatus:'failed',
        latestTurnCompletedAtUtc:new Date().toISOString(),compactionItemId:null,
        compactionItemCompleted:false} as RuntimeCompactionObservation),
      compactThread:async(_binding:RuntimeBinding,_baseline:string,beforeSend:(id:number)=>Promise<void>,
        afterAccepted:(connectionId:string)=>Promise<void>)=>{
        starts++;await beforeSend(17);await afterAccepted('isolated-connection');return 'compact-turn';}};
    const runner=new RuntimeRunner({runtimeFactory:()=>runtime as never,
      workflow:{getRuntimeSession:async()=>owner} as WorkflowService,
      trusted:{} as never,principals:[reviewer],canWrite:()=>true,
      allowedCwd:async()=>cwdAllowed,canSettleOwned:async()=>false,ownedCwd:async()=>true,
      hasGrant:(scope,source)=>currentSessionGrant(pool,source!,()=>grantEnabled&&
        Object.entries(scope).every(([key,value])=>key==='model'
          ? grantAllowsModel(grant,value as string)
          : grant[key as keyof typeof grant]===value))});
    Object.assign(runner,{available:true});
    const workflow=new WorkflowService({uow:new PostgresUnitOfWork(pool),
      clock:{now:()=>new Date().toISOString()},ids:{next:randomUUID},hasher:{hash:(value:string)=>value}});
    const service=new CompactionMaintenance(pool,runner);
    const token='s'.repeat(40),otherToken='t'.repeat(40),foreignToken='u'.repeat(40);
    const app=await buildServer({service:workflow,credentials:[{token,...reviewer},
      {token:otherToken,...reviewer,actorId:'other-maintainer'},
      {token:foreignToken,...reviewer,projectIds:[randomUUID()]}],compaction:service});
    try{
      const address=await app.listen({host:'127.0.0.1',port:0});
      const path=`/api/projects/${projectId}/runtime/sessions/${sessionId}/compactions`;
      const input={operationId:randomUUID(),threadId,expectedSessionVersion:1,expectedGateVersion:gateVersion,
        evidenceRef:'incident://static-rejection',reason:'one authorized maintenance attempt'};
      const post=async(bearer=token)=>{
        const response=await fetch(`${address}${path}`,{method:'POST',
          headers:{authorization:`Bearer ${bearer}`,'content-type':'application/json'},body:JSON.stringify(input)});
        const body=await response.text();
        return {statusCode:response.status,body,json:()=>JSON.parse(body)};
      };
      grantEnabled=false;assert.equal((await post()).statusCode,403);
      grantEnabled=true;cwdAllowed=false;assert.equal((await post()).statusCode,403);
      cwdAllowed=true;assert.equal((await post(otherToken)).statusCode,403);
      assert.equal((await post(foreignToken)).statusCode,403);
      owner.authorizationScope='other-scope';assert.equal((await post()).statusCode,403);
      owner.authorizationScope='resident:leader';owner.executionProfile!.activeRevisionId=randomUUID();
      assert.equal((await post()).statusCode,409);
      owner.executionProfile!.activeRevisionId=revisionId;
      assert.equal(starts,0,'denied requests cannot dispatch native work');
      const accepted=await post();
      assert.equal(accepted.statusCode,200,accepted.body);
      assert.equal(accepted.json().state,'accepted');
      assert.equal(starts,1);
      assert.equal((await post()).statusCode,200);
      assert.equal(starts,1,'same original operation cannot dispatch twice');
    }finally{await app.close()}
  }finally{await pool.end();const admin=new pg.Client({connectionString:url});await admin.connect();
    try{await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)}finally{await admin.end()}}
});

test('lost compaction notification requires complete unique successor history',async()=>{
  const binding={nativeThreadId:'thread'} as RuntimeBinding;
  const page=async(cursor?:string)=>cursor
    ? {data:[{id:'old-turn'}],nextCursor:null}
    : {data:[{id:'compact-turn'}],nextCursor:'older'};
  const runner=Object.create(RuntimeRunner.prototype) as RuntimeRunner;
  Object.assign(runner,{runtime:{listTurns:async(_binding:RuntimeBinding,cursor?:string)=>page(cursor)}});
  assert.deepEqual(await runner.compactionTurnsAfter(binding,'old-turn'),['compact-turn']);
  Object.assign(runner,{runtime:{listTurns:async()=>({data:[{id:'compact-turn'}],nextCursor:null})}});
  assert.equal(await runner.compactionTurnsAfter(binding,'old-turn'),null,'missing baseline is incomplete');
  Object.assign(runner,{runtime:{listTurns:async()=>({data:[{id:'other-turn'},{id:'compact-turn'},{id:'old-turn'}],nextCursor:null})}});
  assert.equal(await runner.compactionTurnsAfter(binding,'old-turn'),null,'two successors are ambiguous');
});

test('durable compaction uses one native request and never opens a blocked gate on a lost reply',async()=>{
  const url=process.env.TEST_DATABASE_URL;
  if(!url||!/^\/evoloop(?:_[a-z0-9]+)*_test$/.test(new URL(url).pathname))
    throw Error('dedicated isolated database required');
  const schema=`compact_${randomUUID().replaceAll('-','').slice(0,12)}`;
  await migrate(url,schema);
  const pool=new pg.Pool({connectionString:url,options:`-c search_path=${schema}`});
  try{
    const projectId=randomUUID(),sessionId=randomUUID(),threadId=randomUUID(),operationId=randomUUID(),messageId=randomUUID();
    await pool.query('INSERT INTO project(project_id,title,created_at) VALUES($1,$2,now())',[projectId,'isolated compaction']);
    await pool.query(`INSERT INTO runtime_session(project_id,session_id,role_id,cwd,authorization_scope,model,
      sandbox,approval_policy,state,version,native_thread_id,native_session_id,operation_id,actor_id,created_at,updated_at)
      VALUES($1,$2,$3,'/tmp/compact-test','project','gpt-6-astra','danger-full-access','never',
        'ready',1,$4,$5,$6,'owner',now(),now())`,
      [projectId,sessionId,randomUUID(),threadId,randomUUID(),randomUUID()]);
    await pool.query(`INSERT INTO session_message(project_id,message_id,operation_id,target_kind,session_id,
      sender_actor_id,content,state,version,created_at,updated_at)
      VALUES($1,$2,$3,'owned',$4,'sender','original known failure','failed',1,now(),now())`,
      [projectId,messageId,randomUUID(),sessionId]);
    await pool.query(`INSERT INTO session_message_processing(project_id,processing_id,message_id,session_id,
      operation_id,receiver_actor_id,state,native_turn_id,read_only_policy_fingerprint,version,started_at,updated_at)
      VALUES($1,$2,$3,$4,$5,'receiver','failed','old-turn',$6,1,now(),now())`,
      [projectId,randomUUID(),messageId,sessionId,randomUUID(),'a'.repeat(64)]);
    await pool.query(`UPDATE session_recovery_gate SET phase='blocked',cause_kind='message',
      cause_id=$3,cause_state='failed',version=version+1 WHERE project_id=$1 AND session_id=$2`,
      [projectId,sessionId,messageId]);
    let gateVersion=(await pool.query<{version:number}>(`SELECT version FROM session_recovery_gate
      WHERE project_id=$1 AND session_id=$2`,[projectId,sessionId])).rows[0]!.version;
    const binding:RuntimeBinding={projectId,sessionId,roleId:'role',cwd:'/tmp/compact-test',
      authorizationScope:'project',nativeThreadId:threadId,nativeSessionId:'native',owner:'evoloop-codex-app-server',
      resumeProfile:{actorId:'owner',model:'gpt-6-astra',reasoningEffort:'max',sandbox:'danger-full-access',approvalPolicy:'never'}};
    const before:RuntimeCompactionObservation={threadId,threadStatus:'systemError',model:'gpt-6-astra',
      reasoningEffort:'max',latestTurnId:'old-turn',latestTurnStatus:'failed',
      latestTurnCompletedAtUtc:new Date().toISOString(),compactionItemId:null,
      compactionItemCompleted:false,tokenUsage:{inputTokens:900000,outputTokens:100}};
    let observation=before,starts=0,noEvent=false,unacknowledged=false;
    let preflightFailure:'thread_read'|'send_connection'|null=null;
    let observedWithoutAck=false,capturedTurnId='captured-turn',successors:string[]|null=null;
    let connectionId='connection-A';
    const fake={compactionBinding:async()=>binding,observeCompaction:async()=>observation,
      compactionConnectionId:()=>connectionId,
      compactionTurnsAfter:async()=>successors,
      compactThread:async(_binding:RuntimeBinding,baselineTurnId:string,beforeSend:(id:number)=>Promise<void>,
        afterAccepted:(connectionId:string)=>Promise<void>)=>{
        assert.equal(baselineTurnId,'old-turn');
        if(preflightFailure)
          throw new RuntimeCompactionPreflightError(preflightFailure,
            new Error(preflightFailure==='thread_read'?'native profile mismatch':'owner connection disappeared'));
        starts++;await beforeSend(noEvent?18:17);
        if(unacknowledged){
          const lost=new RuntimeUnknownError('thread/compact/start',17,'no native acknowledgement');
          if(observedWithoutAck)lost.observedTurnId=capturedTurnId;
          throw lost;
        }
        await afterAccepted(connectionId);
        if(noEvent)return null;
        return 'compact-turn';
      }} as unknown as RuntimeRunner;
    const service=new CompactionMaintenance(pool,fake);
    const actor={actorId:'maintainer',projectIds:[projectId],permissions:['read' as const,'write' as const,'review' as const]};
    const token='m'.repeat(40);
    const workflow=new WorkflowService({uow:new PostgresUnitOfWork(pool),
      clock:{now:()=>new Date().toISOString()},ids:{next:randomUUID},hasher:{hash:(value:string)=>value}});
    const readToken='r'.repeat(40);
    const app=await buildServer({service:workflow,credentials:[{token,...actor},
      {token:readToken,actorId:'reader',projectIds:[projectId],permissions:['read']}],compaction:service});
    try{
    const path=`/api/projects/${projectId}/runtime/sessions/${sessionId}/compactions`;
    preflightFailure='thread_read';
    const rejectedInput={operationId:randomUUID(),threadId,expectedSessionVersion:1,expectedGateVersion:gateVersion,
      evidenceRef:'incident://known-three-terminal-errors',reason:'one authorized maintenance attempt'};
    const rejectedResponse=await app.inject({method:'POST',url:path,
      headers:{authorization:`Bearer ${token}`},payload:rejectedInput});
    assert.equal(rejectedResponse.statusCode,200,rejectedResponse.body);
    const rejected=rejectedResponse.json();
    assert.equal(rejected.state,'failed');
    assert.equal(rejected.errorCode,'preflight_thread_read_rejected');
    assert.equal(rejected.nativeRequestId,null);
    assert.equal(starts,0,'a known pre-send rejection cannot write the compaction request');
    const rejectedAgain=await app.inject({method:'POST',url:path,
      headers:{authorization:`Bearer ${token}`},payload:rejectedInput});
    assert.equal(rejectedAgain.statusCode,200,rejectedAgain.body);
    assert.deepEqual(rejectedAgain.json(),rejected,'same operation returns the settled preflight result');
    assert.equal((await pool.query<{phase:string}>(`SELECT phase FROM session_recovery_gate
      WHERE project_id=$1 AND session_id=$2`,[projectId,sessionId])).rows[0]?.phase,'blocked');
    await pool.query(`UPDATE session_recovery_gate SET version=version+1
      WHERE project_id=$1 AND session_id=$2`,[projectId,sessionId]);
    gateVersion+=1;
    preflightFailure='send_connection';
    const connectionLostInput={operationId:randomUUID(),threadId,expectedSessionVersion:1,
      expectedGateVersion:gateVersion,evidenceRef:'incident://connection-lost-before-send',
      reason:'one authorized maintenance attempt'};
    const connectionLostResponse=await app.inject({method:'POST',url:path,
      headers:{authorization:`Bearer ${token}`},payload:connectionLostInput});
    assert.equal(connectionLostResponse.statusCode,200,connectionLostResponse.body);
    const connectionLost=connectionLostResponse.json();
    assert.equal(connectionLost.state,'failed');
    assert.equal(connectionLost.errorCode,'preflight_send_connection_rejected');
    assert.equal(connectionLost.nativeRequestId,null);
    assert.equal(starts,0,'a missing owner connection cannot write the compaction request');
    const connectionLostAgain=await app.inject({method:'POST',url:path,
      headers:{authorization:`Bearer ${token}`},payload:connectionLostInput});
    assert.equal(connectionLostAgain.statusCode,200,connectionLostAgain.body);
    assert.deepEqual(connectionLostAgain.json(),connectionLost,'same operation returns the settled connection-loss result');
    assert.equal((await pool.query<{phase:string}>(`SELECT phase FROM session_recovery_gate
      WHERE project_id=$1 AND session_id=$2`,[projectId,sessionId])).rows[0]?.phase,'blocked');
    await pool.query(`UPDATE session_recovery_gate SET version=version+1
      WHERE project_id=$1 AND session_id=$2`,[projectId,sessionId]);
    gateVersion+=1;preflightFailure=null;
    const input={...rejectedInput,operationId,expectedGateVersion:gateVersion};
    const [firstResponse,concurrent]=await Promise.all([1,2].map(()=>
      app.inject({method:'POST',url:path,headers:{authorization:`Bearer ${token}`},payload:input})));
    assert.equal(firstResponse.statusCode,200,firstResponse.body);
    assert.equal(concurrent.statusCode,200,concurrent.body);
    const first=firstResponse.json();
    assert.equal(first.state,'accepted');assert.equal(first.nativeRequestId,17);
    assert.ok(first.nativeAcknowledgedAt);
    const duplicate=await app.inject({method:'POST',url:path,headers:{authorization:`Bearer ${token}`},payload:input});
    assert.equal(duplicate.statusCode,200);assert.equal(duplicate.json().operationId,operationId);
    assert.equal(starts,1,'same operation never sends another native request');
    const changed=await app.inject({method:'POST',url:path,headers:{authorization:`Bearer ${token}`},payload:{...input,reason:'changed'}});
    assert.equal(changed.statusCode,409);assert.equal(changed.json().code,'OPERATION_REUSED');
    const unauthorized=await app.inject({method:'POST',url:path,headers:{authorization:`Bearer ${readToken}`},payload:input});
    assert.equal(unauthorized.statusCode,403);
    await assert.rejects(()=>service.start(actor,projectId,sessionId,{...input,operationId:randomUUID()}));
    await assert.rejects(()=>pool.query(`UPDATE session_recovery_gate SET phase='open',version=version+1
      WHERE project_id=$1 AND session_id=$2`,[projectId,sessionId]));
    assert.equal((await service.reconcile(actor,projectId,operationId)).state,'accepted');
    observation={...before,latestTurnId:'other-turn',latestTurnStatus:'completed',
      latestTurnCompletedAtUtc:new Date().toISOString(),compactionItemId:'other-item',compactionItemCompleted:true};
    assert.equal((await service.reconcile(actor,projectId,operationId)).state,'accepted',
      'a later unrelated completed Turn cannot settle this request');
    observation={...observation,latestTurnId:'compact-turn',compactionItemId:null};
    assert.equal((await service.reconcile(actor,projectId,operationId)).state,'accepted',
      'outer Turn completion without a compaction Item is insufficient');
    observation={...before,threadStatus:'idle',latestTurnId:'compact-turn',latestTurnStatus:'completed',
      latestTurnCompletedAtUtc:new Date().toISOString(),compactionItemId:'compact-item',
      compactionItemCompleted:true,tokenUsage:{inputTokens:300000,outputTokens:101}};
    const settled=await service.reconcile(actor,projectId,operationId);
    assert.equal(settled.state,'completed');assert.equal(settled.nativeTurnId,'compact-turn');
    assert.equal(settled.compactionItemId,'compact-item');assert.equal(settled.afterInputTokens,300000);
    assert.equal(starts,1);
    // A native acknowledgement without a captured Turn is still indeterminate.
    await pool.query(`UPDATE session_recovery_gate SET version=version+1
      WHERE project_id=$1 AND session_id=$2`,[projectId,sessionId]);
    noEvent=true;observation=before;
    const next={...input,operationId:randomUUID(),expectedGateVersion:gateVersion+1};
    const acceptedWithoutTurn=await service.start(actor,projectId,sessionId,next);
    assert.equal(acceptedWithoutTurn.state,'unknown');
    assert.equal(acceptedWithoutTurn.nativeTurnId,null);
    assert.equal(acceptedWithoutTurn.nativeRequestId,18);
    assert.ok(acceptedWithoutTurn.nativeAcknowledgedAt);
    assert.equal((await service.reconcile(actor,projectId,next.operationId)).state,'unknown');
    successors=null;
    observation={...before,threadStatus:'idle',latestTurnId:'compact-turn-2',latestTurnStatus:'completed',
      latestTurnCompletedAtUtc:new Date().toISOString(),compactionItemId:'compact-item-2',
      compactionItemCompleted:true};
    assert.equal((await service.reconcile(actor,projectId,next.operationId)).state,'unknown',
      'ambiguous or incomplete history cannot identify the lost Turn');
    successors=['compact-turn-2'];
    connectionId='connection-B';
    assert.equal((await service.reconcile(actor,projectId,next.operationId)).state,'unknown',
      'a successor observed by another owner connection cannot be attributed to the accepted operation');
    connectionId='connection-A';
    const recovered=await service.reconcile(actor,projectId,next.operationId);
    assert.equal(recovered.state,'completed');assert.equal(recovered.nativeTurnId,'compact-turn-2');
    assert.equal(starts,2);
    await pool.query(`UPDATE session_recovery_gate SET version=version+1
      WHERE project_id=$1 AND session_id=$2`,[projectId,sessionId]);
    noEvent=false;successors=null;observation=before;
    const failedInput={...input,operationId:randomUUID(),expectedGateVersion:gateVersion+2};
    const failedStarted=await service.start(actor,projectId,sessionId,failedInput);
    assert.equal(failedStarted.nativeTurnId,'compact-turn');
    observation={...before,latestTurnId:'compact-turn',latestTurnStatus:'failed',
      latestTurnCompletedAtUtc:new Date().toISOString(),compactionItemId:null};
    const knownFailure=await service.reconcile(actor,projectId,failedInput.operationId);
    assert.equal(knownFailure.state,'failed');assert.equal(knownFailure.errorCode,'native_compaction_failed');
    assert.equal((await pool.query(`SELECT phase FROM session_recovery_gate WHERE project_id=$1 AND session_id=$2`,
      [projectId,sessionId])).rows[0].phase,'blocked');
    await pool.query(`UPDATE session_recovery_gate SET version=version+1
      WHERE project_id=$1 AND session_id=$2`,[projectId,sessionId]);
    unacknowledged=true;observedWithoutAck=true;observation=before;
    const capturedInput={...input,operationId:randomUUID(),expectedGateVersion:gateVersion+3};
    const captured=await service.start(actor,projectId,sessionId,capturedInput);
    assert.equal(captured.state,'unknown');assert.equal(captured.nativeAcknowledgedAt,null);
    assert.equal(captured.nativeTurnId,'captured-turn','the original owner observed the exact native Turn');
    connectionId='connection-B';
    observation={...before,latestTurnId:'captured-turn',latestTurnStatus:'failed',
      latestTurnCompletedAtUtc:new Date().toISOString(),compactionItemId:null};
    const capturedFailure=await service.reconcile(actor,projectId,capturedInput.operationId);
    assert.equal(capturedFailure.state,'failed','an exact captured Turn must settle after a lost ACK and reconnect');
    assert.equal(capturedFailure.nativeTurnId,'captured-turn');
    await pool.query(`UPDATE session_recovery_gate SET version=version+1
      WHERE project_id=$1 AND session_id=$2`,[projectId,sessionId]);
    connectionId='connection-A';capturedTurnId='captured-completed-turn';observation=before;
    const completedInput={...input,operationId:randomUUID(),expectedGateVersion:gateVersion+4};
    const capturedCompletion=await service.start(actor,projectId,sessionId,completedInput);
    assert.equal(capturedCompletion.state,'unknown');
    assert.equal(capturedCompletion.nativeTurnId,capturedTurnId);
    assert.equal(capturedCompletion.nativeAcknowledgedAt,null);
    connectionId='connection-B';
    observation={...before,threadStatus:'idle',latestTurnId:capturedTurnId,latestTurnStatus:'completed',
      latestTurnCompletedAtUtc:new Date().toISOString(),compactionItemId:'captured-item',
      compactionItemCompleted:true};
    const capturedSuccess=await service.reconcile(actor,projectId,completedInput.operationId);
    assert.equal(capturedSuccess.state,'completed','exact captured Turn and completed Item settle after lost ACK');
    assert.equal(capturedSuccess.nativeTurnId,capturedTurnId);
    await pool.query(`UPDATE session_recovery_gate SET version=version+1
      WHERE project_id=$1 AND session_id=$2`,[projectId,sessionId]);
    connectionId='connection-A';observedWithoutAck=false;observation=before;
    const unackInput={...input,operationId:randomUUID(),expectedGateVersion:gateVersion+5};
    const unack=await app.inject({method:'POST',url:path,headers:{authorization:`Bearer ${token}`},payload:unackInput});
    assert.equal(unack.statusCode,200);assert.equal(unack.json().state,'unknown');
    assert.equal(unack.json().nativeRequestId,17,'request ID was saved before native send');
    assert.equal(unack.json().nativeAcknowledgedAt,null);
    successors=['foreign-turn'];
    observation={...before,threadStatus:'idle',latestTurnId:'foreign-turn',latestTurnStatus:'completed',
      latestTurnCompletedAtUtc:new Date().toISOString(),compactionItemId:'foreign-item',
      compactionItemCompleted:true};
    const foreign=await app.inject({method:'POST',url:`/api/projects/${projectId}/runtime/compactions/${unackInput.operationId}/reconcile`,
      headers:{authorization:`Bearer ${token}`},payload:{}});
    assert.equal(foreign.statusCode,200);
    assert.equal(foreign.json().state,'unknown','another controller’s compaction cannot settle an unacknowledged request');
    assert.equal(foreign.json().nativeTurnId,null);
    assert.equal(starts,6,'each original operation starts at most once');
    }finally{await app.close()}
  }finally{await pool.end();const admin=new pg.Client({connectionString:url});await admin.connect();
    try{await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)}finally{await admin.end()}}
});
