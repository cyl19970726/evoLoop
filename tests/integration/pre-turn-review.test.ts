import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
import test from 'node:test';
import pg from 'pg';
import {migrate,PostgresUnitOfWork} from '@evoloop/adapter-postgres';
import {WorkflowService} from '@evoloop/core';
import {SessionMessageService} from '@evoloop/core/session-messages';
import {buildServer} from '../../apps/coordinator/src/server.ts';
import type {RuntimeRunner} from '../../apps/coordinator/src/runtime/runner.ts';

test('HTTP review decision cannot be reused after a second writer refusal',async()=>{
const url=process.env.TEST_DATABASE_URL;
if(!url||!/^\/evoloop(?:_[a-z0-9]+)*_test$/.test(new URL(url).pathname))throw Error('dedicated isolated database required');
const schema=`qa_host_${randomUUID().replaceAll('-','').slice(0,12)}`;
await migrate(url,schema);
// An intermediate candidate had already created the table inside 055. Its
// migration record is immutable, so 056 must also accept that layout.
const upgrade=new pg.Client({connectionString:url,options:`-c search_path=${schema}`});
await upgrade.connect();
try{
  const applied=await upgrade.query("SELECT name FROM pgmigrations WHERE name IN ('055_pre_turn_continuation','056_pre_turn_review_decision')");
  assert.equal(applied.rowCount,2);
  await upgrade.query("DELETE FROM pgmigrations WHERE name='056_pre_turn_review_decision'");
}finally{await upgrade.end()}
await migrate(url,schema);
// Also cover databases that applied the original 055 with no decision table.
const original055=new pg.Client({connectionString:url,options:`-c search_path=${schema}`});
await original055.connect();
try{
  await original055.query('DROP TABLE pre_turn_review_decision');
  await original055.query("DELETE FROM pgmigrations WHERE name='056_pre_turn_review_decision'");
}finally{await original055.end()}
await migrate(url,schema);
const pool=new pg.Pool({connectionString:url,options:`-c search_path=${schema}`});
assert.equal((await pool.query("SELECT to_regclass('pre_turn_review_decision') AS name")).rows[0]?.name,
  'pre_turn_review_decision');
const uow=new PostgresUnitOfWork(pool);
const projectId=randomUUID(),sessionId=randomUUID(),roleId=randomUUID(),threadId=randomUUID();
const messageId=randomUUID(),messageOperationId=randomUUID(),processingId=randomUUID(),processingOperationId=randomUUID();
const now=new Date().toISOString(),cwd='/tmp/qa-pr200-host';
const reviewer={actorId:'qa-reviewer',projectIds:[projectId],permissions:['read' as const,'write' as const,'review' as const]};
const grant={projectId,sessionId,senderActorId:'qa-sender',receiverRoleId:roleId,receiverActorId:'qa-receiver',cwd,maxTurns:3,enabled:true};
const workflow=new WorkflowService({uow,clock:{now:()=>new Date().toISOString()},ids:{next:randomUUID},
  hasher:{hash:(s:string)=>s}});
const messages=new SessionMessageService({uow,clock:{now:()=>new Date().toISOString()},ids:{next:randomUUID},grantFor:async()=>grant});
const result:Record<string,unknown>={schema,projectId,sessionId,threadId,
  messageId,messageOperationId,processingId,processingOperationId,nativeAdapter:'controlled: no native turn/start'};
const code=(e:unknown)=>e&&typeof e==='object'&&'code' in e?String(e.code):e instanceof Error?e.message:'unknown';
try{
  await pool.query("INSERT INTO project(project_id,title,created_at) VALUES($1,'QA pre-turn isolated',$2)",[projectId,now]);
  await pool.query(`INSERT INTO runtime_session(project_id,session_id,role_id,cwd,authorization_scope,sandbox,approval_policy,
    state,version,native_thread_id,native_session_id,operation_id,actor_id,created_at,updated_at)
    VALUES($1,$2,$3,$4,'project','danger-full-access','never','ready',1,$5,$6,$7,'qa-receiver',$8,$8)`,
    [projectId,sessionId,roleId,cwd,threadId,randomUUID(),randomUUID(),now]);
  const msg={projectId,id:messageId,operationId:messageOperationId,target:{kind:'owned' as const,sessionId},
    senderActorId:'qa-sender',content:'Isolated original input',context:null,replyToMessageId:null,
    state:'queued' as const,version:1,blockedReason:null,readReceipt:null,createdAt:now,updatedAt:now};
  await uow.transaction(projectId,tx=>tx.sessionMessages!.insertSessionMessage(msg));
  await messages.beginDispatch(projectId,messageId,processingId,processingOperationId,'a'.repeat(64));
  const proof=(requestId:number)=>({threadId,operationId:processingOperationId,requestId,code:-32600 as const,inputHash:'b'.repeat(64)});
  await messages.markUnknown(projectId,messageId,'QA controlled exact pre-turn refusal',proof(17));
  const observed=await messages.detail(projectId,messageId);
  const gate=await uow.read(projectId,r=>r.recovery!.getRecoveryGate(sessionId));
  result.first={message:observed.message.state,processing:observed.processing?.state,
    proof:observed.processing?.preTurnProof?.status,requestId:observed.processing?.preTurnProof?.requestId,
    gate:gate?.phase,gateVersion:gate?.version};
  const token='v'.repeat(40),readerToken='r'.repeat(40);
  let nativeAvailable=true;
  const app=await buildServer({service:workflow,sessionMessages:messages,hasRuntimeGrant:scope=>scope.actorId==='qa-reviewer',
    credentials:[{token,actorId:reviewer.actorId,projectIds:[projectId],permissions:['read','write','review']},
      {token:readerToken,actorId:'qa-reader',projectIds:[projectId],permissions:['read']}],
    runtime:{nativeStartsAvailable:()=>nativeAvailable,status:()=>({available:nativeAvailable,faults:[]})} as unknown as RuntimeRunner});
  try{
    const path=`/api/projects/${projectId}/session-messages/${messageId}/pre-turn-continue`;
    const body={operationId:randomUUID(),sessionId,originalOperationId:processingOperationId,
      expectedVersion:observed.processing!.version,expectedMessageVersion:observed.message.version,
      expectedGateVersion:gate!.version,evidenceRef:'qa-isolated://handoff-1',reason:'controlled review only'};
    const call=async(value:unknown,who=token)=>{
      const r=await app.inject({method:'POST',url:path,headers:{authorization:`Bearer ${who}`},payload:value});
      return {http:r.statusCode,code:r.statusCode===200?null:r.json().code,proof:r.statusCode===200?r.json().preTurnProof?.status:null};
    };
    result.readerDenied=await call(body,readerToken);
    result.wrongSession=await call({...body,sessionId:randomUUID()});
    result.wrongOperation=await call({...body,originalOperationId:randomUUID()});
    result.firstReview=await call(body);
    nativeAvailable=false;
    result.reusedReview=await call(body);
    result.changedFirstIntent=await call({...body,evidenceRef:'qa-isolated://changed-evidence'});
    result.offlineNewIntent=await call({...body,operationId:randomUUID()});
    nativeAvailable=true;
    const [a,b]=await Promise.all([messages.claimPreTurnContinuation(projectId,messageId),
      messages.claimPreTurnContinuation(projectId,messageId)]);
    result.concurrentClaim=[a,b].filter(Boolean).length;
    result.claimStatus=(await messages.detail(projectId,messageId)).processing?.preTurnProof?.status;
    await messages.markUnknown(projectId,messageId,'QA second controlled refusal',proof(18));
    const second=await messages.detail(projectId,messageId);
    result.second={status:second.processing?.preTurnProof?.status,requestId:second.processing?.preTurnProof?.requestId,
      sameMessage:second.message.id===messageId,sameProcessing:second.processing?.id===processingId,
      sameOperation:second.processing?.operationId===processingOperationId};
    const oldProof=observed.processing!.preTurnProof!;
    try{await pool.query(`UPDATE session_message_processing SET pre_turn_proof=$3::jsonb,version=version+1
      WHERE project_id=$1 AND message_id=$2`,[projectId,messageId,JSON.stringify({...oldProof,status:'approved',
      decisionOperationId:body.operationId,reviewerActorId:reviewer.actorId,evidenceRef:body.evidenceRef,
      decisionReason:body.reason,gateVersionAtApproval:gate!.version})]);result.oldReviewSql='unexpected-success'}
    catch(e){result.oldReviewSql=code(e)}
    result.oldReviewApi=await call({...body,expectedVersion:second.processing!.version,
      expectedMessageVersion:second.message.version});
    result.originalReadback=await call(body);
    result.secondReview=await call({...body,operationId:randomUUID(),expectedVersion:second.processing!.version,
      expectedMessageVersion:second.message.version,evidenceRef:'qa-isolated://handoff-2'});
    result.secondClaim=(await messages.claimPreTurnContinuation(projectId,messageId))?.preTurnProof?.status;
    result.thirdClaim=await messages.claimPreTurnContinuation(projectId,messageId);
    await messages.bindTurn(projectId,messageId,{id:'qa-controlled-turn',status:'inProgress'});
    const final=await messages.detail(projectId,messageId);
    result.final={messageState:final.message.state,processingState:final.processing?.state,
      processingId:final.processing?.id,operationId:final.processing?.operationId,
      proof:final.processing?.preTurnProof?.status,nativeTurnId:final.processing?.nativeTurnId};
    const reviews=await pool.query(`SELECT detail::jsonb->>'requestId' AS request_id FROM runtime_record_event
      WHERE project_id=$1 AND session_id=$2 AND kind='message.preTurnReviewed' ORDER BY sequence`,[projectId,sessionId]);
    result.reviewRequestIds=reviews.rows.map(r=>r.request_id);
  }finally{await app.close()}
  assert.equal(result.firstReview.http,200);
  assert.equal(result.reusedReview.http,200);
  assert.deepEqual(result.changedFirstIntent,{http:409,code:'PRE_TURN_DECISION_REUSED',proof:null});
  assert.equal(result.offlineNewIntent.code,'RUNTIME_UNAVAILABLE');
  assert.equal(result.concurrentClaim,1);
  assert.equal(result.oldReviewSql,'23514');
  assert.deepEqual(result.oldReviewApi,{http:409,code:'PRE_TURN_DECISION_REUSED',proof:null});
  assert.equal(result.originalReadback.http,200);
  assert.equal(result.secondReview.http,200);
  assert.equal(result.secondClaim,'attempting');
  assert.equal(result.thirdClaim,null);
  assert.deepEqual(result.reviewRequestIds,['17','18']);
}finally{await pool.end(); const cleanup=new pg.Client({connectionString:url});await cleanup.connect();try{await cleanup.query(`DROP SCHEMA \"${schema}\" CASCADE`)}finally{await cleanup.end()}}
});
