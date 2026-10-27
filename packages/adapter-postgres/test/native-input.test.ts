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

  let localNow='2026-10-27T00:00:02.000Z';
  const racingService=new NativeInputService({uow,clock:{now:()=>localNow},ids});
  const racingCapture=capture(7,'native-turn-1');
  const captured=await racingService.capture(racingCapture);
  assert.equal(captured.source?.kind,'message');
  const replyOperationId=randomUUID();
  await uow.transaction(projectId,tx=>applyNativeInputReply(tx,{actorId:'sender',projectIds:[projectId],permissions:['write']},
    {type:'session.input.reply',projectId,operationId:replyOperationId,inputRequestId:racingCapture.id,
      expectedVersion:captured.version,answers:{q1:['B']}},'2026-10-27T00:00:01.000Z'));
  localNow='2026-10-27T00:00:02.000Z';
  assert.equal((await racingService.claimResponse(projectId,racingCapture.id,connectionId))?.response?.outcome,'attempted');
  localNow='2026-10-27T00:00:04.000Z';
  await racingService.closed(projectId,racingCapture.id,connectionId,'native_resolved','2026-10-27T00:00:04.000Z');
  localNow='2026-10-27T00:00:05.000Z';
  const finished=await racingService.finishResponse(projectId,racingCapture.id,connectionId,'submitted','2026-10-27T00:00:03.000Z');
  assert.equal(finished?.state,'resolved');
  assert.deepEqual(finished?.response,{operationId:replyOperationId,actorId:'sender',answers:{q1:['B']},
    savedAt:'2026-10-27T00:00:01.000Z',attemptedAt:'2026-10-27T00:00:02.000Z',submittedAt:'2026-10-27T00:00:03.000Z',outcome:'submitted'});
  assert.equal(finished?.observedAt,racingCapture.observedAt);
  assert.equal(finished?.updatedAt,'2026-10-27T00:00:05.000Z');
  assert.equal(finished?.version,5);
  assert.equal(await racingService.claimResponse(projectId,racingCapture.id,connectionId),null);
  assert.equal((await racingService.pendingResponses(projectId)).some(v=>v.id===racingCapture.id),false);

  const metadataSessionId=randomUUID(),metadataThreadId='metadata-native-thread';
  await pool.query(`INSERT INTO runtime_session(project_id,session_id,role_id,cwd,authorization_scope,sandbox,approval_policy,
    state,version,native_thread_id,native_session_id,operation_id,actor_id,created_at,updated_at)
    VALUES($1,$2,'worker','/tmp','project','danger-full-access','never','ready',1,$3,'metadata-native-session',$4,'agent',$5,$5)`,
    [projectId,metadataSessionId,metadataThreadId,randomUUID(),now]);
  const metadataRace={...capture(8,'metadata-turn'),sessionId:metadataSessionId,threadId:metadataThreadId};
  await racingService.capture(metadataRace);
  assert.equal((await racingService.get(projectId,metadataRace.id))?.source,null);
  const metadataMessageId=randomUUID(),metadataProcessingId=randomUUID();
  await pool.query(`INSERT INTO session_message(project_id,message_id,operation_id,target_kind,session_id,sender_actor_id,
    content,state,version,created_at,updated_at) VALUES($1,$2,$3,'owned',$4,'sender','Metadata','processing',1,$5,$5)`,
    [projectId,metadataMessageId,randomUUID(),metadataSessionId,now]);
  await pool.query(`INSERT INTO session_message_processing(project_id,processing_id,message_id,session_id,operation_id,
    receiver_actor_id,state,native_turn_id,read_only_policy_fingerprint,version,started_at,updated_at)
    VALUES($1,$2,$3,$4,$5,'receiver','running','metadata-turn',$6,1,$7,$7)`,
    [projectId,metadataProcessingId,metadataMessageId,metadataSessionId,randomUUID(),'a'.repeat(64),now]);
  localNow='2026-10-27T00:00:06.000Z';
  assert.equal(await racingService.refreshSources(projectId,metadataSessionId),1);
  const metadataUpdated=await racingService.get(projectId,metadataRace.id);
  assert.equal(metadataUpdated?.updatedAt,localNow);
  const closedAfterMetadata=await racingService.closed(projectId,metadataRace.id,connectionId,'native_resolved','2026-10-27T00:00:03.000Z');
  assert.equal(closedAfterMetadata?.updatedAt,localNow);
  assert.equal(closedAfterMetadata?.observedAt,metadataRace.observedAt);
});

test('native input activity links to its real Session rather than a nonexistent Task',async()=>{
  const page=await uow.read(projectId,r=>r.sessionObservation!('native-input-test').history(`owned:${sessionId}`,{limit:50,importance:'all'}));
  const entries=page!.items.filter(item=>item.kind==='session_native_input_request');
  assert.ok(entries.length>0);
  assert.ok(entries.every(item=>item.source.kind==='session'&&item.source.id===sessionId));
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
  const unsupported:NativeInputCapture={...capture(3,'unused'),turnId:null,itemId:null,questions:[],
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

test('Run source links only the exact project Session and Turn, including after terminal settlement',async()=>{
  const workflow=new WorkflowService({uow,clock,ids,hasher:{hash:(s:string)=>createHash('sha256').update(s).digest('hex')}});
  const lead={actorId:'run-issuer',projectIds:[projectId],permissions:['write','review'] as ('write'|'review')[]};
  const taskId=randomUUID(),runSessionId=randomUUID(),runId=randomUUID(),runOperationId=randomUUID(),turn='run-native-turn';
  const created=await workflow.execute(lead,{type:'task.create',projectId,operationId:randomUUID(),taskId,
    title:'Run source fixture',content:'Fixed work',acceptance:'Evidence',owner:'worker'});
  assert.equal(created.status,'applied');
  const started=await workflow.execute(lead,{type:'task.start',projectId,operationId:randomUUID(),taskId,
    expectedVersion:1,reason:'Begin fixed work'});
  assert.equal(started.status,'applied');
  const task=await uow.read(projectId,r=>r.getTask(taskId));
  const revision=await uow.read(projectId,r=>r.getTaskRevision(taskId,task!.currentRevisionId));
  assert.ok(task&&revision?.basisSetId);
  await pool.query(`INSERT INTO runtime_session(project_id,session_id,role_id,cwd,authorization_scope,sandbox,approval_policy,
    state,version,native_thread_id,native_session_id,operation_id,actor_id,created_at,updated_at)
    VALUES($1,$2,'worker','/tmp','project','danger-full-access','never','ready',1,'run-thread','run-session',$3,'run-issuer',$4,$4)`,
    [projectId,runSessionId,randomUUID(),now]);
  const exact={...capture(10,turn),sessionId:runSessionId,threadId:'run-thread'};
  const otherTurn={...capture(11,'unrelated-turn'),sessionId:runSessionId,threadId:'run-thread'};
  const otherSession=capture(12,turn);
  assert.equal((await service.capture(exact)).source,null,'request may arrive before Run bind ACK');
  assert.equal((await service.capture(otherTurn)).source,null);
  assert.equal((await service.capture(otherSession)).source,null);
  await pool.query(`INSERT INTO runtime_run(project_id,run_id,task_id,task_revision_id,basis_set_id,session_id,
    operation_id,input,input_hash,state,version,actor_id,created_at,updated_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,'Fixed input',$8,'requested',1,'run-issuer',$9,$9)`,
    [projectId,runId,taskId,revision!.id,revision!.basisSetId,runSessionId,runOperationId,'a'.repeat(64),now]);
  assert.equal((await service.get(projectId,exact.id))?.source,null);
  assert.equal(await service.refreshSources(projectId,runSessionId),0,'unbound Run must not be inferred');
  await pool.query(`UPDATE runtime_run SET state='dispatching',version=2,updated_at=$3 WHERE project_id=$1 AND run_id=$2`,
    [projectId,runId,now]);
  await pool.query(`UPDATE runtime_run SET state='running',native_turn_id=$3,version=3,updated_at=$4
    WHERE project_id=$1 AND run_id=$2`,[projectId,runId,turn,now]);
  assert.equal(await service.refreshSources(projectId,runSessionId),1);
  assert.equal(await service.refreshSources(projectId,sessionId),0);
  assert.deepEqual((await service.get(projectId,exact.id))?.source,{kind:'run',runId,
    operationId:runOperationId,actorId:'run-issuer',taskId,taskRevisionId:revision!.id});
  assert.equal((await service.get(projectId,otherTurn.id))?.source,null);
  assert.equal((await service.get(projectId,otherSession.id))?.source,null);
  await pool.query(`UPDATE runtime_run SET state='completed',version=4,result_summary='Done',updated_at=$3
    WHERE project_id=$1 AND run_id=$2`,[projectId,runId,now]);
  const after=capture(13,turn);after.sessionId=runSessionId;after.threadId='run-thread';
  assert.equal((await service.capture(after)).source?.kind,'run','terminal Run remains a valid exact source');
  const foreignProjectId=randomUUID();
  assert.equal(await uow.read(foreignProjectId,r=>r.nativeInputs!.findSource(foreignProjectId,runSessionId,turn)),null);
  const messageId=randomUUID(),processingId=randomUUID();
  await pool.query(`INSERT INTO session_message(project_id,message_id,operation_id,target_kind,session_id,sender_actor_id,
    content,state,version,created_at,updated_at) VALUES($1,$2,$3,'owned',$4,'other-issuer','Other work','replied',1,$5,$5)`,
    [projectId,messageId,randomUUID(),runSessionId,now]);
  await pool.query(`INSERT INTO session_message_processing(project_id,processing_id,message_id,session_id,operation_id,
    receiver_actor_id,state,native_turn_id,read_only_policy_fingerprint,version,started_at,updated_at)
    VALUES($1,$2,$3,$4,$5,'worker','completed',$6,$7,1,$8,$8)`,
    [projectId,processingId,messageId,runSessionId,randomUUID(),turn,'a'.repeat(64),now]);
  const ambiguous={...capture(14,turn),sessionId:runSessionId,threadId:'run-thread'};
  await assert.rejects(()=>service.capture(ambiguous),/multiple business sources/);
  assert.equal(await service.get(projectId,ambiguous.id),null,'ambiguous linkage cannot persist a guessed source');
  assert.equal((await service.get(projectId,exact.id))?.source?.kind,'run','an existing fixed source is not rewritten');
});
