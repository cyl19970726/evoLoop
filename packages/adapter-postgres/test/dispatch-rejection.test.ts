import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { before, after, test } from 'node:test';
import pg from 'pg';
import { RuntimeWorkflowService } from '@evoloop/core';
import { migrate, PostgresUnitOfWork } from '../src/index.ts';
import type { NativeResumeRejection } from '@evoloop/contracts/runtime';

const url=process.env.TEST_DATABASE_URL;
if(!url||!/^evoloop(?:_[a-z0-9]+)*_test$/.test(decodeURIComponent(new URL(url).pathname.slice(1))))
  throw new Error('dispatch rejection test requires a dedicated evoLoop test database');
const schema=`el_reject_${randomUUID().replaceAll('-','').slice(0,16)}`;
const pool=new pg.Pool({connectionString:url,options:`-c search_path=${schema}`});
const uow=new PostgresUnitOfWork(pool);
const runtime=new RuntimeWorkflowService({uow,clock:{now:()=>new Date().toISOString()},ids:{next:randomUUID}});
const project=randomUUID(),role=randomUUID(),at='2026-10-27T00:00:00.000Z';
type Fixture={runId:string;sessionId:string;operationId:string};

before(async()=>{
  await migrate(url!,schema);
  await pool.query("INSERT INTO project(project_id,title,created_at) VALUES($1,'Dispatch rejection test',$2)",[project,at]);
});
after(async()=>{await pool.end();const c=new pg.Client({connectionString:url});await c.connect();
  try{await c.query(`DROP SCHEMA "${schema}" CASCADE`);}finally{await c.end();}});

async function fixture():Promise<Fixture>{
  const sessionId=randomUUID(),runId=randomUUID(),operationId=randomUUID(),taskId=randomUUID(),revisionId=randomUUID(),
    basisId=randomUUID(),documentId=randomUUID(),documentRevisionId=randomUUID(),now=new Date().toISOString();
  const c=await pool.connect();try{
    await c.query('BEGIN');
    await c.query(`INSERT INTO runtime_session(project_id,session_id,role_id,cwd,authorization_scope,sandbox,approval_policy,
      state,version,native_thread_id,native_session_id,operation_id,actor_id,created_at,updated_at)
      VALUES($1,$2,$3,'/tmp/dispatch-rejection','project','read-only','on-request','ready',1,$4,$4,$5,'worker',$6,$6)`,
      [project,sessionId,role,`native-${sessionId}`,randomUUID(),now]);
    await c.query(`INSERT INTO process_document(project_id,document_id,title,version,current_revision_id,kind,status)
      VALUES($1,$2,'Fixed Task',1,$3,'task','draft')`,[project,documentId,documentRevisionId]);
    await c.query(`INSERT INTO document_revision(project_id,document_id,revision_id,body,format,content_hash,author,created_at,reason)
      VALUES($1,$2,$3,'Fixed task','markdown',$4,'lead',$5,'fixture')`,
      [project,documentId,documentRevisionId,'a'.repeat(64),now]);
    await c.query(`INSERT INTO task(project_id,task_id,version,current_revision_id,title,acceptance,owner,state,content_document_id,content_revision_id)
      VALUES($1,$2,1,$3,'Fixed Task','Result',$4,'in_progress',$5,$6)`,
      [project,taskId,revisionId,role,documentId,documentRevisionId]);
    await c.query(`INSERT INTO task_revision(project_id,task_id,revision_id,version,title,acceptance,owner,state,basis_set_id,
      actor_id,reason,created_at,content_document_id,content_revision_id)
      VALUES($1,$2,$3,1,'Fixed Task','Result',$7,'in_progress',$4,'lead','fixture',$8,$5,$6)`,
      [project,taskId,revisionId,basisId,documentId,documentRevisionId,role,now]);
    await c.query('INSERT INTO basis_set(project_id,task_id,task_revision_id,basis_set_id,sealed) VALUES($1,$2,$3,$4,true)',
      [project,taskId,revisionId,basisId]);
    await c.query(`INSERT INTO runtime_run(project_id,run_id,task_id,task_revision_id,basis_set_id,session_id,operation_id,
      input,input_hash,state,version,native_turn_id,actor_id,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,'Fixed input',$8,'requested',1,NULL,'worker',$9,$9)`,
      [project,runId,taskId,revisionId,basisId,sessionId,operationId,'b'.repeat(64),now]);
    await c.query(`INSERT INTO operation_journal(project_id,operation_id,actor_id,command_hash,command_type,result,created_at)
      VALUES($1,$2,'worker',$3,'runtime.run.reserve','{}',$4)`,[project,operationId,'c'.repeat(64),now]);
    await c.query('COMMIT');
  }catch(error){await c.query('ROLLBACK');throw error;}finally{c.release();}
  return {sessionId,runId,operationId};
}
const proof=(operationId:string):NativeResumeRejection=>({kind:'native_resume_rejected',operationId,
  code:-32603,category:'thread_unavailable'});

test('exact native resume rejection after durable dispatch fails original Run and blocks its Session',async()=>{
  const f=await fixture();
  const dispatching=await runtime.beginDispatch(project,f.runId);
  const rejected=await runtime.rejectDispatch(project,f.runId,'RAW PRIVATE NATIVE ERROR MUST NOT PERSIST',proof(f.operationId));
  assert.equal(rejected.state,'failed');assert.equal(rejected.version,dispatching.version+1);
  assert.equal(rejected.input,dispatching.input);assert.equal(rejected.inputHash,dispatching.inputHash);
  assert.equal(rejected.taskRevisionId,dispatching.taskRevisionId);assert.equal(rejected.basisSetId,dispatching.basisSetId);
  assert.deepEqual(rejected.executionProfile,dispatching.executionProfile);
  const result=await pool.query(`SELECT r.state,r.result_summary,g.phase,g.cause_id,g.cause_state,
    (SELECT count(*)::int FROM runtime_record_event e WHERE e.project_id=r.project_id AND e.run_id=r.run_id
      AND e.kind='run.dispatchRejected') AS events,
    (SELECT count(*)::int FROM outbox_event o WHERE o.project_id=r.project_id AND o.entity_id=r.run_id
      AND o.kind='runtime.run.failed') AS outbox
    FROM runtime_run r JOIN session_recovery_gate g ON g.project_id=r.project_id AND g.session_id=r.session_id
    WHERE r.project_id=$1 AND r.run_id=$2`,[project,f.runId]);
  assert.equal(result.rows[0]?.state,'failed');assert.equal(result.rows[0]?.phase,'blocked');
  assert.equal(result.rows[0]?.cause_id,f.runId);assert.equal(result.rows[0]?.cause_state,'failed');
  assert.equal(result.rows[0]?.events,1);assert.equal(result.rows[0]?.outbox,1);
  assert.match(result.rows[0]?.result_summary??'',/thread_unavailable/);
  assert.doesNotMatch(result.rows[0]?.result_summary??'',/RAW PRIVATE/);
  await assert.rejects(runtime.beginDispatch(project,f.runId),/RUN_NOT_REQUESTED|already attempted/i);
});

test('default preflight remains requested-only; proof requires exact operation and valid classified code',async()=>{
  const requested=await fixture();
  await assert.rejects(runtime.rejectDispatch(project,requested.runId,'native error',proof(requested.operationId)),
    /RUN_NOT_DISPATCHING|dispatching/i);
  assert.equal((await runtime.rejectDispatch(project,requested.runId,'Preflight failed')).state,'failed');
  const f=await fixture();await runtime.beginDispatch(project,f.runId);
  await assert.rejects(runtime.rejectDispatch(project,f.runId,'No proof'),/RUN_NOT_REQUESTED|preflight/i);
  await assert.rejects(runtime.rejectDispatch(project,f.runId,'Wrong operation',proof(randomUUID())),
    /NATIVE_REJECTION_PROOF_INVALID|proof/i);
  await assert.rejects(runtime.rejectDispatch(project,f.runId,'Invalid code',{...proof(f.operationId),code:1.5}),
    /NATIVE_REJECTION_PROOF_INVALID|proof/i);
  await assert.rejects(runtime.rejectDispatch(project,f.runId,'Invalid category',
    {...proof(f.operationId),category:'native_failure'} as unknown as NativeResumeRejection),
    /NATIVE_REJECTION_PROOF_INVALID|proof/i);
  assert.equal((await uow.read(project,reader=>reader.getRuntimeRun(f.runId)))?.state,'dispatching');
  const turnAttached=await fixture();await runtime.beginDispatch(project,turnAttached.runId);
  await uow.transaction(project,async tx=>{
    const current=(await tx.getRuntimeRun(turnAttached.runId))!;
    await tx.updateRuntimeRun({...current,nativeTurnId:'already-attached',version:current.version+1,
      updatedAt:new Date().toISOString()},current.version);
  });
  await assert.rejects(runtime.rejectDispatch(project,turnAttached.runId,'Late proof',proof(turnAttached.operationId)),
    /RUN_NOT_DISPATCHING|unstarted/i);
});

test('native rejection proof cannot rewrite an unknown or already running Run',async()=>{
  const unknown=await fixture();await runtime.beginDispatch(project,unknown.runId);
  await runtime.markRunUnknown(project,unknown.runId,'Lost start reply');
  await assert.rejects(runtime.rejectDispatch(project,unknown.runId,'Late rejection',proof(unknown.operationId)),
    /RUN_NOT_DISPATCHING|dispatching/i);
  const running=await fixture();await runtime.beginDispatch(project,running.runId);
  await runtime.bindTurn(project,running.runId,{id:'already-started-turn',status:'running'},
    {kind:'startReply',operationId:running.operationId});
  await assert.rejects(runtime.rejectDispatch(project,running.runId,'Late rejection',proof(running.operationId)),
    /RUN_NOT_DISPATCHING|dispatching/i);
  assert.equal((await uow.read(project,reader=>reader.getRuntimeRun(unknown.runId)))?.state,'unknown');
  assert.equal((await uow.read(project,reader=>reader.getRuntimeRun(running.runId)))?.state,'running');
});
