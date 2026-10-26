import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { before,after,test } from 'node:test';
import pg from 'pg';
import { migrate,PostgresUnitOfWork } from '../src/index.ts';
import { SessionMessageService,applySessionMessage } from '@evoloop/core/session-messages';
import { SessionMessagePump } from '../../../apps/coordinator/src/session-messages/pump.ts';
import type { SessionMessageRecord } from '@evoloop/contracts/session-messages';

const url=process.env.TEST_DATABASE_URL;
if(!url||!/^evoloop(?:_[a-z0-9]+)*_test$/.test(new URL(url).pathname.slice(1)))
  throw new Error('dedicated evoloop_*_test database required');
const schema=`el_msg_${randomUUID().replaceAll('-','').slice(0,16)}`;
const pool=new pg.Pool({connectionString:url,options:`-c search_path=${schema}`});
const uow=new PostgresUnitOfWork(pool);
const projectId=randomUUID(),sessionId=randomUUID(),roleId=randomUUID(),now='2026-10-26T00:00:00.000Z';
const grant={projectId,sessionId,senderActorId:'sender',receiverRoleId:roleId,receiverActorId:'receiver',cwd:'/tmp/evoloop-message-test',maxTurns:3,enabled:true};
const service=new SessionMessageService({uow,clock:{now:()=>new Date().toISOString()},ids:{next:randomUUID},
  grantFor:async()=>grant});
const qualified='a'.repeat(64);
function item(id=randomUUID()):SessionMessageRecord{return{projectId,id,operationId:randomUUID(),target:{kind:'owned',sessionId},
  senderActorId:'sender',content:'What changed?',context:null,replyToMessageId:null,state:'queued',version:1,
  blockedReason:null,readReceipt:null,createdAt:now,updatedAt:now};}
before(async()=>{
  await migrate(url!,schema);
  await pool.query('INSERT INTO project(project_id,title,created_at) VALUES($1,$2,$3)',[projectId,'Message test',now]);
  await pool.query(`INSERT INTO runtime_session(project_id,session_id,role_id,cwd,authorization_scope,sandbox,approval_policy,
    state,version,native_thread_id,native_session_id,operation_id,actor_id,created_at,updated_at)
    VALUES($1,$2,$3,$4,'project','workspace-write','on-request','ready',1,$5,$6,$7,'receiver',$8,$8)`,
    [projectId,sessionId,roleId,grant.cwd,'thread-'+sessionId,'native-'+sessionId,randomUUID(),now]);
});
after(async()=>{await pool.end();const c=new pg.Client({connectionString:url});await c.connect();
  try{await c.query(`DROP SCHEMA "${schema}" CASCADE`);}finally{await c.end();}});

test('message persists separately, unknown retains exact operation, receipt requires receiving actor',async()=>{
  const message=item();
  await uow.transaction(projectId,tx=>tx.sessionMessages!.insertSessionMessage(message));
  assert.deepEqual(await service.detail(projectId,message.id),{message,processing:null});
  assert.equal((await service.list(projectId,{kind:'owned',sessionId},10)).items[0]?.senderActorId,'sender');
  const processingId=randomUUID(),operationId=randomUUID();
  await service.beginDispatch(projectId,message.id,processingId,operationId,qualified);
  const cancel={type:'session.message.cancel' as const,projectId,operationId:randomUUID(),messageId:message.id,
    expectedVersion:(await service.get(projectId,message.id)).version,reason:'I changed my mind'};
  await assert.rejects(()=>uow.transaction(projectId,tx=>applySessionMessage(tx,{actorId:'sender',projectIds:[projectId],permissions:['write']},cancel,now)),/unprocessed/);
  await assert.rejects(()=>service.beginDispatch(projectId,message.id,randomUUID(),randomUUID(),qualified),/queued/);
  await service.markUnknown(projectId,message.id,'lost native reply');
  const unknownVersion=(await service.get(projectId,message.id)).version;
  await assert.rejects(()=>uow.transaction(projectId,tx=>applySessionMessage(tx,{actorId:'sender',projectIds:[projectId],permissions:['write']},
    {...cancel,expectedVersion:unknownVersion},now)),/unprocessed/);
  assert.equal((await service.processing(projectId,message.id))?.operationId,operationId);
  assert.equal((await service.get(projectId,message.id)).state,'unknown');
  await assert.rejects(()=>uow.transaction(projectId,tx=>tx.sessionMessages!.assertSessionVacant(sessionId)),/active or unresolved/);
  await service.bindTurn(projectId,message.id,{id:'native-turn-1',status:'inProgress'});
  await service.settle(projectId,message.id,{id:'native-turn-1',status:'completed',completedAtUtc:now},null);
  assert.equal((await service.get(projectId,message.id)).state,'completed_without_reply');
  const detail=await service.detail(projectId,message.id);
  assert.equal(detail.message.state,'completed_without_reply');
  assert.equal(detail.processing?.state,'completed');
  assert.equal(detail.processing?.nativeTurnId,'native-turn-1');
  assert.equal(await service.mustYieldBusiness(projectId,sessionId),true);
  const restarted=new SessionMessageService({uow,clock:{now:()=>new Date().toISOString()},ids:{next:randomUUID},grantFor:async()=>grant});
  assert.equal(await restarted.mustYieldBusiness(projectId,sessionId),true);
  const receipt={type:'session.message.receipt' as const,projectId,operationId:randomUUID(),messageId:message.id,stage:'read' as const,evidence:'I personally read it'};
  await assert.rejects(()=>uow.transaction(projectId,tx=>applySessionMessage(tx,{actorId:'sender',projectIds:[projectId],permissions:['write']},receipt,now)),/receiving/);
  await assert.rejects(()=>uow.transaction(projectId,tx=>applySessionMessage(tx,{actorId:'lead',projectIds:[projectId],permissions:['write','review']},receipt,now)),/receiving/);
  const beforeReceipt=(await pool.query('SELECT sequence FROM session_observation_head WHERE project_id=$1',[projectId])).rows[0].sequence;
  const settledVersion=(await service.get(projectId,message.id)).version;
  await uow.transaction(projectId,tx=>applySessionMessage(tx,{actorId:'receiver',projectIds:[projectId],permissions:['write']},receipt,now));
  assert.equal((await service.get(projectId,message.id)).readReceipt?.actorId,'receiver');
  const readChanges=(await pool.query(`SELECT actor_id,source_table FROM session_observation_change
    WHERE project_id=$1 AND sequence>$2 AND message_id=$3 AND session_id=$4`,
    [projectId,beforeReceipt,message.id,sessionId])).rows;
  assert.deepEqual(readChanges,[{actor_id:'receiver',source_table:'session_message_read_receipt'}],
    'explicit read must invalidate the precise Session and retain the receiving actor');
  assert.equal((await service.get(projectId,message.id)).version,settledVersion,'the terminal message remains immutable');
});

test('preflight is side-effect-free for missing or exhausted grants and dispatch rechecks revocation',async()=>{
  const sender=`sender-${randomUUID()}`;
  const first={...item(),senderActorId:sender};
  const second={...item(),senderActorId:sender};
  let current:typeof grant|null=null;
  const guarded=new SessionMessageService({uow,clock:{now:()=>new Date().toISOString()},ids:{next:randomUUID},
    grantFor:async()=>current});
  await uow.transaction(projectId,tx=>tx.sessionMessages!.insertSessionMessage(first));
  await assert.rejects(()=>guarded.preflightDispatch(projectId,first.id),/grant is unavailable/);
  assert.equal((await guarded.detail(projectId,first.id)).message.state,'queued');
  assert.equal((await guarded.detail(projectId,first.id)).processing,null);
  current={...grant,senderActorId:sender,maxTurns:2};
  await guarded.preflightDispatch(projectId,first.id);
  await guarded.beginDispatch(projectId,first.id,randomUUID(),randomUUID(),qualified);
  await guarded.bindTurn(projectId,first.id,{id:'quota-seed',status:'inProgress'});
  await guarded.settle(projectId,first.id,{id:'quota-seed',status:'completed',completedAtUtc:now},null);
  await uow.transaction(projectId,tx=>tx.sessionMessages!.insertSessionMessage(second));
  await guarded.preflightDispatch(projectId,second.id);
  current=null;
  await assert.rejects(()=>guarded.beginDispatch(projectId,second.id,randomUUID(),randomUUID(),qualified),/grant is unavailable/);
  assert.equal((await guarded.detail(projectId,second.id)).processing,null);
  current={...grant,senderActorId:sender,maxTurns:1};
  await assert.rejects(()=>guarded.preflightDispatch(projectId,second.id),/grant is exhausted/);
  assert.equal((await guarded.detail(projectId,second.id)).message.state,'queued');
  assert.equal((await guarded.detail(projectId,second.id)).processing,null);
});

test('pending scanning can pass the old ten-thousand offset while each page stays bounded',async()=>{
  assert.deepEqual(await service.pending(projectId,30,10030),[]);
  await assert.rejects(()=>service.pending(projectId,30,Number.MAX_SAFE_INTEGER+1),/offset/);
});

test('two message processors cannot occupy one Session and direct Task Run INSERT is rejected while occupied',async()=>{
  const first=item(),second=item();
  await uow.transaction(projectId,async tx=>{await tx.sessionMessages!.insertSessionMessage(first);await tx.sessionMessages!.insertSessionMessage(second);});
  await service.beginDispatch(projectId,first.id,randomUUID(),randomUUID(),qualified);
  await assert.rejects(()=>service.beginDispatch(projectId,second.id,randomUUID(),randomUUID(),qualified),/active or unresolved/);
  const c=await pool.connect();try{
    await c.query('BEGIN');
    await assert.rejects(()=>c.query(`INSERT INTO runtime_run(project_id,run_id,task_id,task_revision_id,basis_set_id,session_id,
      operation_id,input,input_hash,state,version,actor_id,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,'x','hash','requested',1,'receiver',now(),now())`,
      [projectId,randomUUID(),randomUUID(),randomUUID(),randomUUID(),sessionId,randomUUID()]),/Session occupied by ordinary message/);
    await c.query('ROLLBACK');
  }finally{c.release();}
  await service.bindTurn(projectId,first.id,{id:'native-turn-2',status:'inProgress'});
  await service.settle(projectId,first.id,{id:'native-turn-2',status:'failed',completedAtUtc:now},null);
  assert.equal((await service.get(projectId,first.id)).state,'failed');
  await uow.transaction(projectId,async tx=>{const pending=(await tx.sessionMessages!.getSessionMessage(second.id))!;
    await tx.sessionMessages!.updateSessionMessage({...pending,state:'cancelled',version:pending.version+1,updatedAt:new Date().toISOString()},pending.version);});
});

test('unknown native start only reads original history marker and never resends',async()=>{
  const message=item();await uow.transaction(projectId,tx=>tx.sessionMessages!.insertSessionMessage(message));
  const operationId=randomUUID();await service.beginDispatch(projectId,message.id,randomUUID(),operationId,qualified);
  await service.markUnknown(projectId,message.id,'lost native acknowledgement');
  let starts=0,readOnlyGates=0,found=false;
  const runtime={isReady:()=>true,registerBinding:async()=>{},markReadOnlyThread:()=>{readOnlyGates++;},
    startReadOnlyTurn:async()=>{starts++;throw new Error('must not resend');},
    listTurns:async()=>({data:found?[{id:'recovered-turn',status:'completed',completedAtUtc:now}]:[],nextCursor:null}),
    listItems:async()=>({data:[{id:'input',type:'userMessage',text:`[evoloop-message-operation:${operationId}] original`},
      {id:'answer',type:'agentMessage',phase:'final_answer',text:'A visible reply'}],nextCursor:null})};
  const errors:unknown[]=[];
  const pump=new SessionMessagePump({service,runtime:()=>runtime,projects:async()=>[projectId],canStart:async()=>true,
    canWrite:()=>true,pollIntervalMs:1000,onError:e=>errors.push(e)});
  await pump.tick();assert.equal(starts,0);assert.equal((await service.get(projectId,message.id)).state,'unknown');
  found=true;await pump.tick();assert.equal(starts,0);assert.equal((await service.get(projectId,message.id)).state,'replied');
  assert.equal((await service.processing(projectId,message.id))?.response,'A visible reply');
  assert.equal(readOnlyGates,2);assert.deepEqual(errors,[]);
});

test('direct ordinary processing INSERT cannot cross an active Task Run',async()=>{
  const c=await pool.connect();
  const taskId=randomUUID(),taskRevisionId=randomUUID(),basisId=randomUUID(),docId=randomUUID(),docRevisionId=randomUUID();
  const message=item();
  try{
    await c.query('BEGIN');
    await c.query(`INSERT INTO process_document(project_id,document_id,title,version,current_revision_id,adopted_revision_id,kind,status)
      VALUES($1,$2,'Task',1,$3,$3,'task','published')`,[projectId,docId,docRevisionId]);
    await c.query(`INSERT INTO document_revision(project_id,document_id,revision_id,body,format,content_hash,author,created_at,reason,media_type,original_name,assets_manifest)
      VALUES($1,$2,$3,'Task body','markdown',repeat('a',64),'lead',now(),'fixed','text/markdown','task.md','[]'::jsonb)`,[projectId,docId,docRevisionId]);
    await c.query(`INSERT INTO document_decision(project_id,decision_id,document_id,revision_id,actor_id,reason,created_at)
      VALUES($1,$2,$3,$4,'lead','adopt',now())`,[projectId,randomUUID(),docId,docRevisionId]);
    await c.query(`INSERT INTO task(project_id,task_id,version,current_revision_id,title,acceptance,owner,state,kind,content_document_id,content_revision_id)
      VALUES($1,$2,1,$3,'Task','check',$6,'in_progress',NULL,$4,$5)`,[projectId,taskId,taskRevisionId,docId,docRevisionId,roleId]);
    await c.query(`INSERT INTO task_revision(project_id,task_id,revision_id,version,title,acceptance,owner,state,basis_set_id,actor_id,reason,created_at,kind,content_document_id,content_revision_id)
      VALUES($1,$2,$3,1,'Task','check',$7,'in_progress',$4,'lead','fixed',now(),NULL,$5,$6)`,
      [projectId,taskId,taskRevisionId,basisId,docId,docRevisionId,roleId]);
    await c.query('INSERT INTO basis_set(project_id,task_id,task_revision_id,basis_set_id,sealed) VALUES($1,$2,$3,$4,false)',
      [projectId,taskId,taskRevisionId,basisId]);
    await c.query(`INSERT INTO basis_member(project_id,task_id,task_revision_id,basis_set_id,document_id,document_revision_id)
      VALUES($1,$2,$3,$4,$5,$6)`,[projectId,taskId,taskRevisionId,basisId,docId,docRevisionId]);
    await c.query('UPDATE basis_set SET sealed=true WHERE project_id=$1 AND task_id=$2 AND basis_set_id=$3',[projectId,taskId,basisId]);
    await c.query(`INSERT INTO session_message_schedule(project_id,session_id,must_yield_business,updated_at)
      VALUES($1,$2,true,now()) ON CONFLICT(project_id,session_id) DO UPDATE
      SET must_yield_business=true,updated_at=now()`,[projectId,sessionId]);
    const businessRunId=randomUUID();
    await c.query(`INSERT INTO runtime_run(project_id,run_id,task_id,task_revision_id,basis_set_id,session_id,operation_id,input,input_hash,state,version,actor_id,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,'Task input','hash','requested',1,'receiver',now(),now())`,
      [projectId,businessRunId,taskId,taskRevisionId,basisId,sessionId,randomUUID()]);
    assert.equal((await c.query('SELECT must_yield_business FROM session_message_schedule WHERE project_id=$1 AND session_id=$2',
      [projectId,sessionId])).rows[0]?.must_yield_business,true);
    await c.query(`UPDATE runtime_run SET state='dispatching',version=2,updated_at=now()
      WHERE project_id=$1 AND run_id=$2`,[projectId,businessRunId]);
    assert.equal((await c.query('SELECT must_yield_business FROM session_message_schedule WHERE project_id=$1 AND session_id=$2',
      [projectId,sessionId])).rows[0]?.must_yield_business,true);
    await c.query(`UPDATE runtime_run SET state='running',native_turn_id='business-turn',version=3,updated_at=now()
      WHERE project_id=$1 AND run_id=$2`,[projectId,businessRunId]);
    assert.equal((await c.query('SELECT must_yield_business FROM session_message_schedule WHERE project_id=$1 AND session_id=$2',
      [projectId,sessionId])).rows[0]?.must_yield_business,false);
    await c.query(`INSERT INTO session_message(project_id,message_id,operation_id,target_kind,session_id,sender_actor_id,content,state,version,created_at,updated_at)
      VALUES($1,$2,$3,'owned',$4,'sender','ordinary','queued',1,now(),now())`,[projectId,message.id,message.operationId,sessionId]);
    await assert.rejects(()=>c.query(`INSERT INTO session_message_processing(project_id,processing_id,message_id,session_id,operation_id,receiver_actor_id,state,read_only_policy_fingerprint,version,started_at,updated_at)
      VALUES($1,$2,$3,$4,$5,'receiver','dispatching',$6,1,now(),now())`,[projectId,randomUUID(),message.id,sessionId,randomUUID(),qualified]),
      /Session occupied by Task Run/);
    await c.query('ROLLBACK');
  }catch(error){await c.query('ROLLBACK');throw error;}finally{c.release();}
});

test('sender identity, same-project recipient and exact conversation grant fail closed',async()=>{
  const badTarget={type:'session.message.post' as const,projectId,operationId:randomUUID(),messageId:randomUUID(),
    target:{kind:'owned' as const,sessionId:randomUUID()},content:'Please clarify'};
  await assert.rejects(()=>uow.transaction(projectId,tx=>applySessionMessage(tx,{actorId:'sender',projectIds:[projectId],permissions:['write']},badTarget,now)),/Session not found/);
  const message=item();
  await uow.transaction(projectId,tx=>tx.sessionMessages!.insertSessionMessage(message));
  const denied=new SessionMessageService({uow,clock:{now:()=>new Date().toISOString()},ids:{next:randomUUID},
    grantFor:async()=>({...grant,enabled:false})});
  await assert.rejects(()=>denied.beginDispatch(projectId,message.id,randomUUID(),randomUUID(),qualified),/grant is unavailable/);
  assert.equal((await service.get(projectId,message.id)).state,'queued');
  assert.equal(await service.processing(projectId,message.id),null);
  const cancel={type:'session.message.cancel' as const,projectId,operationId:randomUUID(),messageId:message.id,
    expectedVersion:1,reason:'No longer needed'};
  await assert.rejects(()=>uow.transaction(projectId,tx=>applySessionMessage(tx,{actorId:'other',projectIds:[projectId],permissions:['write']},cancel,now)),/sender/);
  await uow.transaction(projectId,tx=>applySessionMessage(tx,{actorId:'sender',projectIds:[projectId],permissions:['write']},cancel,now));
  assert.equal((await service.get(projectId,message.id)).state,'cancelled');
});

test('creator may message their Session, but only the granted worker may attest reading',async()=>{
  const ownedSessionId=randomUUID();
  await pool.query(`INSERT INTO runtime_session(project_id,session_id,role_id,cwd,authorization_scope,sandbox,approval_policy,
    state,version,native_thread_id,native_session_id,operation_id,actor_id,created_at,updated_at)
    VALUES($1,$2,$3,$4,'project','workspace-write','on-request','ready',1,$5,$6,$7,'lead',$8,$8)`,
    [projectId,ownedSessionId,roleId,grant.cwd,'thread-'+ownedSessionId,'native-'+ownedSessionId,randomUUID(),now]);
  const id=randomUUID();
  const post={type:'session.message.post' as const,projectId,operationId:randomUUID(),messageId:id,
    target:{kind:'owned' as const,sessionId:ownedSessionId},content:'Please explain the current state'};
  await uow.transaction(projectId,tx=>applySessionMessage(tx,{actorId:'lead',projectIds:[projectId],permissions:['write']},post,now));
  const workerService=new SessionMessageService({uow,clock:{now:()=>new Date().toISOString()},ids:{next:randomUUID},
    grantFor:async()=>({...grant,sessionId:ownedSessionId,senderActorId:'lead',receiverActorId:'worker',maxTurns:1})});
  await workerService.beginDispatch(projectId,id,randomUUID(),randomUUID(),qualified);
  await workerService.bindTurn(projectId,id,{id:'worker-turn',status:'inProgress'});
  await workerService.settle(projectId,id,{id:'worker-turn',status:'completed',completedAtUtc:now},'Explanation');
  const receipt={type:'session.message.receipt' as const,projectId,operationId:randomUUID(),messageId:id,
    stage:'read' as const,evidence:'Read the original question'};
  await assert.rejects(()=>uow.transaction(projectId,tx=>applySessionMessage(tx,
    {actorId:'lead',projectIds:[projectId],permissions:['write','review']},receipt,now)),/granted receiving actor/);
  await uow.transaction(projectId,tx=>applySessionMessage(tx,
    {actorId:'worker',projectIds:[projectId],permissions:['write']},receipt,now));
  assert.equal((await workerService.get(projectId,id)).readReceipt?.actorId,'worker');
  assert.equal((await workerService.processing(projectId,id))?.receiverActorId,'worker');
});

test('explicit pre-turn rejection releases occupancy and does not claim a native Turn or read receipt',async()=>{
  const first=item(),second=item();
  await uow.transaction(projectId,async tx=>{await tx.sessionMessages!.insertSessionMessage(first);await tx.sessionMessages!.insertSessionMessage(second);});
  const roomy=new SessionMessageService({uow,clock:{now:()=>new Date().toISOString()},ids:{next:randomUUID},
    grantFor:async()=>({...grant,maxTurns:10})});
  const before=await uow.read(projectId,r=>r.sessionMessages!.countSessionMessageTurns(sessionId,'sender'));
  await roomy.beginDispatch(projectId,first.id,randomUUID(),randomUUID(),qualified);
  await roomy.failBeforeStart(projectId,first.id,'Native rejected read-only policy before turn/start');
  assert.equal((await roomy.get(projectId,first.id)).state,'failed');
  assert.equal((await roomy.processing(projectId,first.id))?.nativeTurnId,null);
  assert.equal(await uow.read(projectId,r=>r.sessionMessages!.countSessionMessageTurns(sessionId,'sender')),before);
  const receipt={type:'session.message.receipt' as const,projectId,operationId:randomUUID(),messageId:first.id,
    stage:'read' as const,evidence:'I saw it'};
  await assert.rejects(()=>uow.transaction(projectId,tx=>applySessionMessage(tx,
    {actorId:'receiver',projectIds:[projectId],permissions:['write']},receipt,now)),/real native Turn/);
  await roomy.beginDispatch(projectId,second.id,randomUUID(),randomUUID(),qualified);
  await roomy.failBeforeStart(projectId,second.id,'Native rejected before turn/start');
});

test('unqualified native tool profile keeps an ordinary message queued before any Turn',async()=>{
  const message=item();await uow.transaction(projectId,tx=>tx.sessionMessages!.insertSessionMessage(message));
  const roomy=new SessionMessageService({uow,clock:{now:()=>new Date().toISOString()},ids:{next:randomUUID},
    grantFor:async()=>({...grant,maxTurns:100})});
  let starts=0;
  const runtime={isReady:()=>true,registerBinding:async()=>{},qualifyReadOnlyThread:async()=>({
    available:false,reason:'Native apps are not explicitly disabled',fingerprint:null}),
    startReadOnlyTurn:async()=>{starts++;throw new Error('must not start');},
    listTurns:async()=>({data:[],nextCursor:null}),listItems:async()=>({data:[],nextCursor:null})};
  const pump=new SessionMessagePump({service:roomy,runtime:()=>runtime,projects:async()=>[projectId],canStart:async()=>true,
    canWrite:()=>true,pollIntervalMs:1000,onError:e=>{throw e;}});
  await pump.tick();
  const saved=await service.get(projectId,message.id);
  assert.equal(saved.state,'queued');assert.match(saved.blockedReason??'',/Native apps/);
  assert.equal(await service.processing(projectId,message.id),null);assert.equal(starts,0);
});
