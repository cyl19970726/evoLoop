import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { before, after, test } from 'node:test';
import pg from 'pg';
import { migrate, PostgresUnitOfWork } from '../src/index.ts';
import { NativeObservationService, reduceNativeObservation } from '@evoloop/core/native-observation';

const url=process.env.TEST_DATABASE_URL;
if(!url||!/^evoloop(?:_[a-z0-9]+)*_test$/.test(decodeURIComponent(new URL(url).pathname.slice(1))))
  throw new Error('native observation test requires a dedicated evoloop_*_test database');
const schema=`el_native_ob_${randomUUID().replaceAll('-','').slice(0,16)}`;
const pool=new pg.Pool({connectionString:url,options:`-c search_path=${schema}`});
const uow=new PostgresUnitOfWork(pool);
const now='2026-10-27T00:00:00.000Z', projectId=randomUUID(), sessionId=randomUUID(), connectionId=randomUUID();
const service=new NativeObservationService({uow,clock:{now:()=>now}});
const event=(method:string,params:unknown)=>({projectId,sessionId,threadId:'native-thread',connectionId,method,params,observedAt:now});
before(async()=>{
  await migrate(url!,schema);
  await pool.query('INSERT INTO project(project_id,title,created_at) VALUES($1,$2,$3)',[projectId,'Native observation',now]);
  await pool.query(`INSERT INTO runtime_session(project_id,session_id,role_id,cwd,authorization_scope,sandbox,approval_policy,
    state,version,native_thread_id,native_session_id,operation_id,actor_id,created_at,updated_at)
    VALUES($1,$2,'worker','/tmp','project','danger-full-access','never','ready',1,'native-thread','native-session',$3,'agent',$4,$4)`,
    [projectId,sessionId,randomUUID(),now]);
});
after(async()=>{await pool.end();const c=new pg.Client({connectionString:url});await c.connect();
  try{await c.query(`DROP SCHEMA "${schema}" CASCADE`);}finally{await c.end();}});

test('one row, exact source binds after ACK, metadata cursor invalidates without native payload',async()=>{
  const key=`owned:${sessionId}`, scope=JSON.stringify({actorId:'reader',permissions:['read']});
  const baseline=await uow.read(projectId,r=>r.sessionObservation!(scope).snapshot(key));
  assert.ok(baseline);
  const historyBefore=await uow.read(projectId,r=>r.sessionObservation!(scope).history(key,{limit:50}));
  let row=reduceNativeObservation(null,event('turn/started',{threadId:'native-thread',turn:{id:'turn-1',status:'inProgress',items:[]}}))!;
  row=reduceNativeObservation(row,event('thread/tokenUsage/updated',{threadId:'native-thread',turnId:'turn-1',tokenUsage:{total:{inputTokens:100,cachedInputTokens:80,outputTokens:30,reasoningOutputTokens:10,totalTokens:130},last:{inputTokens:5,cachedInputTokens:0,outputTokens:2,reasoningOutputTokens:1,totalTokens:7},modelContextWindow:200000}}))!;
  const first=await service.apply(row);assert.equal(first.currentTurn?.source,null);assert.equal(first.version,1);
  const changes=await uow.read(projectId,r=>r.sessionObservation!(scope).changes({cursor:baseline!.observationCursor,key,limit:10}));
  assert.ok(changes.items.some(change=>change.source.kind==='session' && change.source.id===sessionId && change.sessionKeys.includes(key)));
  const historyAfter=await uow.read(projectId,r=>r.sessionObservation!(scope).history(key,{limit:50}));
  assert.deepEqual(historyAfter?.items.map(item=>item.id),historyBefore?.items.map(item=>item.id));
  const journalOne=(await pool.query('SELECT max(sequence)::text AS head FROM session_observation_change WHERE project_id=$1',[projectId])).rows[0].head;
  const messageId=randomUUID(),processingId=randomUUID();
  await pool.query(`INSERT INTO session_message(project_id,message_id,operation_id,target_kind,session_id,sender_actor_id,
    content,state,version,created_at,updated_at) VALUES($1,$2,$3,'owned',$4,'sender','Question','processing',1,$5,$5)`,
    [projectId,messageId,randomUUID(),sessionId,now]);
  await pool.query(`INSERT INTO session_message_processing(project_id,processing_id,message_id,session_id,operation_id,
    receiver_actor_id,state,native_turn_id,read_only_policy_fingerprint,version,started_at,updated_at)
    VALUES($1,$2,$3,$4,$5,'receiver','running','turn-1',$6,1,$7,$7)`,
    [projectId,processingId,messageId,sessionId,randomUUID(),'a'.repeat(64),now]);
  const linked=await service.refreshSource(projectId,sessionId);
  assert.equal(linked?.currentTurn?.source?.kind,'message');assert.equal(linked?.version,2);
  assert.ok(BigInt((await pool.query('SELECT max(sequence)::text AS head FROM session_observation_change WHERE project_id=$1',[projectId])).rows[0].head)>BigInt(journalOne));
  const observed=await pool.query("SELECT detail FROM session_observation_change WHERE source_table='session_native_observation' AND project_id=$1",[projectId]);
  assert.equal(observed.rows.length,2);assert.ok(observed.rows.every(x=>!JSON.stringify(x.detail).includes('inputTokens')));
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM runtime_record_event WHERE project_id=$1',[projectId])).rows[0].n,0);
  const changed=await service.staleConnection(projectId,connectionId,'disconnected');assert.equal(changed,1);
  assert.equal((await service.get(projectId,sessionId))?.freshness,'stale');
  assert.equal(await service.staleConnection(projectId,connectionId,'disconnected'),0);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM session_native_observation WHERE project_id=$1',[projectId])).rows[0].n,1);
});

test('exact thread and scope are enforced at service boundary',async()=>{
  const row=reduceNativeObservation(null,event('thread/status/changed',{threadId:'native-thread',status:{type:'idle'}}))!;
  await assert.rejects(()=>service.apply({...row,threadId:'wrong'}),/exact ready Session and Thread/);
  assert.equal(await service.get(randomUUID(),sessionId),null);
});
