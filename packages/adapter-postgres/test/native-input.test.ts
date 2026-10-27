import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { before, after, test } from 'node:test';
import pg from 'pg';
import { migrate, PostgresUnitOfWork } from '../src/index.ts';
import { NativeInputService, applyNativeInputReply } from '@evoloop/core/native-input';
import { WorkflowService } from '@evoloop/core';
import type { NativeInputCapture } from '@evoloop/contracts/native-input';

const url=process.env.TEST_DATABASE_URL;
if(!url||!/^evoloop(?:_[a-z0-9]+)*_test$/.test(decodeURIComponent(new URL(url).pathname.slice(1))))
  throw new Error('native input tests require a dedicated evoloop test database');
const schema=`el_input_${randomUUID().replaceAll('-','').slice(0,16)}`;
const pool=new pg.Pool({connectionString:url,options:`-c search_path=${schema}`});
const uow=new PostgresUnitOfWork(pool);
const projectId=randomUUID(),sessionId=randomUUID(),now='2026-10-27T00:00:00.000Z',connectionId=randomUUID();
const clock={now:()=>now};const ids={next:randomUUID};const service=new NativeInputService({uow,clock,ids});
const capture=(nativeRequestId:string|number=1,turnId='native-turn-1'):NativeInputCapture=>({
  projectId,sessionId,id:randomUUID(),connectionId,nativeRequestId,threadId:'native-thread',turnId,itemId:'native-item',
  method:'item/tool/requestUserInput',questions:[{id:'q1',header:'Choice',question:'Choose a value',isOther:false,
    options:[{label:'A',description:'First'},{label:'B',description:'Second'}]}],isBlocking:true,supported:true,
  unavailableReason:null,observedAt:now,
});
before(async()=>{
  await migrate(url!,schema);
  await pool.query('INSERT INTO project(project_id,title,created_at) VALUES($1,$2,$3)',[projectId,'Native input',now]);
  await pool.query(`INSERT INTO runtime_session(project_id,session_id,role_id,cwd,authorization_scope,sandbox,approval_policy,
    state,version,native_thread_id,native_session_id,operation_id,actor_id,created_at,updated_at)
    VALUES($1,$2,'worker','/tmp','project','danger-full-access','never','ready',1,'native-thread','native-session',$3,'agent',$4,$4)`,
    [projectId,sessionId,randomUUID(),now]);
});
after(async()=>{await pool.end();const c=new pg.Client({connectionString:url});await c.connect();
  try{await c.query(`DROP SCHEMA "${schema}" CASCADE`);}finally{await c.end();}});

test('capture waits for exact Turn source; reply uses actor and CAS; attempted intent never replays',async()=>{
  const c=capture();const first=await service.capture(c);assert.equal(first.source,null);
  assert.deepEqual(await service.capture(c),first);
  const noSource={type:'session.input.reply' as const,projectId,operationId:randomUUID(),inputRequestId:c.id,
    expectedVersion:1,answers:{q1:['A']}};
  await assert.rejects(()=>uow.transaction(projectId,tx=>applyNativeInputReply(tx,{actorId:'agent',projectIds:[projectId],permissions:['write']},noSource,now)),/not awaiting/);
  const messageId=randomUUID(),processingId=randomUUID();
  await pool.query(`INSERT INTO session_message(project_id,message_id,operation_id,target_kind,session_id,sender_actor_id,
    content,state,version,created_at,updated_at) VALUES($1,$2,$3,'owned',$4,'sender','Question','processing',1,$5,$5)`,
    [projectId,messageId,randomUUID(),sessionId,now]);
  await pool.query(`INSERT INTO session_message_processing(project_id,processing_id,message_id,session_id,operation_id,
    receiver_actor_id,state,native_turn_id,read_only_policy_fingerprint,version,started_at,updated_at)
    VALUES($1,$2,$3,$4,$5,'receiver','running','native-turn-1',$6,1,$7,$7)`,
    [projectId,processingId,messageId,sessionId,randomUUID(),'a'.repeat(64),now]);
  assert.equal(await service.refreshSources(projectId,sessionId),1);
  const linked=(await service.get(projectId,c.id))!;assert.equal(linked.source?.kind,'message');
  await assert.rejects(()=>uow.transaction(projectId,tx=>applyNativeInputReply(tx,{actorId:'stranger',projectIds:[projectId],permissions:['write']},
    {...noSource,expectedVersion:linked.version},now)),/initiating actor/);
  await assert.rejects(()=>uow.transaction(projectId,tx=>applyNativeInputReply(tx,{actorId:'sender',projectIds:[projectId],permissions:['write']},
    {...noSource,expectedVersion:linked.version,answers:{q1:['C']}},now)),/native option/);
  await uow.transaction(projectId,tx=>applyNativeInputReply(tx,{actorId:'sender',projectIds:[projectId],permissions:['write']},
    {...noSource,expectedVersion:linked.version},now));
  const saved=(await service.get(projectId,c.id))!;assert.equal(saved.response?.actorId,'sender');
  await assert.rejects(()=>uow.transaction(projectId,tx=>applyNativeInputReply(tx,{actorId:'sender',projectIds:[projectId],permissions:['write']},
    {...noSource,expectedVersion:linked.version},now)),/changed/);
  const claimed=await service.claimResponse(projectId,c.id,connectionId);assert.equal(claimed?.response?.outcome,'attempted');
  assert.equal(await service.claimResponse(projectId,c.id,connectionId),null);
  await service.closed(projectId,c.id,connectionId,'native_resolved',now);
  await service.finishResponse(projectId,c.id,connectionId,'submitted',now);
  assert.equal((await service.get(projectId,c.id))?.state,'resolved');
  assert.equal((await service.get(projectId,c.id))?.response?.outcome,'submitted');
});

test('typed native IDs and reconnect invalidation remain isolated',async()=>{
  const one=capture(2,'turn-two'),two={...capture('2','turn-three'),itemId:'other-item'};
  await service.capture(one);await service.capture(two);
  assert.equal((await service.list(projectId,sessionId)).filter(v=>String(v.nativeRequestId)==='2').length,2);
  await service.invalidateConnections(projectId,randomUUID());
  assert.equal((await service.get(projectId,one.id))?.state,'unavailable');
  assert.equal((await service.get(projectId,two.id))?.state,'unavailable');
  assert.equal((await service.pendingResponses(projectId)).length,0);
});

test('unsupported null Turn, other Turn, and overbudget requests never infer a source',async()=>{
  const unsupported:NativeInputCapture={...capture(3,'unused'),turnId:null,questions:[],
    method:'mcpServer/elicitation/request',supported:false,unavailableReason:'unsupported'};
  const saved=await service.capture(unsupported);
  assert.equal(saved.state,'unavailable');assert.equal(saved.source,null);
  const other=await service.capture(capture(4,'different-turn'));
  assert.equal(other.source,null);
  assert.equal(await service.refreshSources(projectId,sessionId),0);
  const huge=capture(5,'big-turn');huge.questions[0]!.options=[{label:'x',description:'d'}];
  huge.questions[0]!.question='q'.repeat(4001);
  await assert.rejects(()=>service.capture(huge),/question is invalid/);
  assert.equal(await service.get(projectId,huge.id),null);
});

test('business command journal replays exact reviewer reply without a second mutation',async()=>{
  const c=capture(6,'native-turn-1');const pending=await service.capture(c);
  assert.equal(pending.source?.kind,'message');
  const workflow=new WorkflowService({uow,clock,ids,hasher:{hash:(s:string)=>createHash('sha256').update(s).digest('hex')}});
  const principal={actorId:'reviewer',projectIds:[projectId],permissions:['write','review'] as ('write'|'review')[]};
  const command={type:'session.input.reply' as const,projectId,operationId:randomUUID(),inputRequestId:c.id,
    expectedVersion:pending.version,answers:{q1:['B']}};
  const first=await workflow.execute(principal,command);assert.equal(first.status,'applied');
  const replay=await workflow.execute(principal,command);assert.deepEqual(replay,first);
  assert.equal((await service.get(projectId,c.id))?.version,pending.version+1);
  const changed=await workflow.execute(principal,{...command,answers:{q1:['A']}}).catch(e=>e);
  assert.equal(changed.code,'OPERATION_REUSED');
});
