import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import pg from 'pg';
import {migrate,PostgresUnitOfWork} from '@evoloop/adapter-postgres';
import {CompactionMaintenance} from '../../apps/coordinator/src/runtime/compaction.ts';
import {buildServer} from '../../apps/coordinator/src/server.ts';
import {WorkflowService} from '@evoloop/core';
import {RuntimeUnknownError} from '@evoloop/adapter-codex-app-server';
import type {RuntimeRunner} from '../../apps/coordinator/src/runtime/runner.ts';
import type {RuntimeBinding,RuntimeCompactionObservation} from '@evoloop/contracts/runtime';

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
    const gateVersion=(await pool.query<{version:number}>(`SELECT version FROM session_recovery_gate
      WHERE project_id=$1 AND session_id=$2`,[projectId,sessionId])).rows[0]!.version;
    const binding:RuntimeBinding={projectId,sessionId,roleId:'role',cwd:'/tmp/compact-test',
      authorizationScope:'project',nativeThreadId:threadId,nativeSessionId:'native',owner:'evoloop-codex-app-server',
      resumeProfile:{actorId:'owner',model:'gpt-6-astra',reasoningEffort:'max',sandbox:'danger-full-access',approvalPolicy:'never'}};
    const before:RuntimeCompactionObservation={threadId,threadStatus:'idle',model:'gpt-6-astra',
      reasoningEffort:'max',latestTurnId:'old-turn',latestTurnStatus:'failed',
      latestTurnCompletedAtUtc:new Date().toISOString(),compactionItemId:null,
      compactionItemCompleted:false,tokenUsage:{inputTokens:900000,outputTokens:100}};
    let observation=before,starts=0;
    const fake={compactionBinding:async()=>binding,observeCompaction:async()=>observation,
      compactThread:async(_binding:RuntimeBinding,beforeSend:(id:number)=>Promise<void>)=>{
        starts++;await beforeSend(17);const lost=new RuntimeUnknownError('thread/compact/start',17,'lost response');
        lost.observedTurnId='compact-turn';throw lost;
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
    const input={operationId,threadId,expectedSessionVersion:1,expectedGateVersion:gateVersion,
      evidenceRef:'incident://known-three-terminal-errors',reason:'one authorized maintenance attempt'};
    const path=`/api/projects/${projectId}/runtime/sessions/${sessionId}/compactions`;
    const firstResponse=await app.inject({method:'POST',url:path,headers:{authorization:`Bearer ${token}`},payload:input});
    assert.equal(firstResponse.statusCode,200,firstResponse.body);
    const first=firstResponse.json();
    assert.equal(first.state,'unknown');assert.equal(first.nativeRequestId,17);
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
    assert.equal((await service.reconcile(actor,projectId,operationId)).state,'unknown');
    observation={...before,latestTurnId:'other-turn',latestTurnStatus:'completed',
      latestTurnCompletedAtUtc:new Date().toISOString(),compactionItemId:'other-item',compactionItemCompleted:true};
    assert.equal((await service.reconcile(actor,projectId,operationId)).state,'unknown',
      'a later unrelated completed Turn cannot settle this request');
    observation={...observation,latestTurnId:'compact-turn',compactionItemId:null};
    assert.equal((await service.reconcile(actor,projectId,operationId)).state,'unknown',
      'outer Turn completion without a compaction Item is insufficient');
    observation={...before,latestTurnId:'compact-turn',latestTurnStatus:'completed',
      latestTurnCompletedAtUtc:new Date().toISOString(),compactionItemId:'compact-item',
      compactionItemCompleted:true,tokenUsage:{inputTokens:300000,outputTokens:101}};
    const settled=await service.reconcile(actor,projectId,operationId);
    assert.equal(settled.state,'completed');assert.equal(settled.nativeTurnId,'compact-turn');
    assert.equal(settled.compactionItemId,'compact-item');assert.equal(settled.afterInputTokens,300000);
    assert.equal(starts,1);
    }finally{await app.close()}
  }finally{await pool.end();const admin=new pg.Client({connectionString:url});await admin.connect();
    try{await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)}finally{await admin.end()}}
});
