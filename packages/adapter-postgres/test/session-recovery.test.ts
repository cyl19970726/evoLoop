import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { before, after, test } from 'node:test';
import pg from 'pg';
import { migrate, PostgresUnitOfWork } from '../src/index.ts';
import { SessionMessageService } from '@evoloop/core/session-messages';
import type { SessionMessageRecord } from '@evoloop/contracts/session-messages';
import { sessionRecoveryCommands } from '@evoloop/contracts/session-recovery';
import { PgSessionRecovery } from '../src/session-recovery.ts';
import { loopIntentId } from '../../../apps/coordinator/src/orchestration/runner.ts';

const url=process.env.TEST_DATABASE_URL;
if(!url||!/^evoloop(?:_[a-z0-9]+)*_test$/.test(decodeURIComponent(new URL(url).pathname.slice(1))))
  throw new Error('session recovery test requires a dedicated evoLoop test database');
const schema=`el_recovery_${randomUUID().replaceAll('-','').slice(0,16)}`;
const pool=new pg.Pool({connectionString:url,options:`-c search_path=${schema}`});
const uow=new PostgresUnitOfWork(pool);
const project=randomUUID(),session=randomUUID(),role=randomUUID(),task=randomUUID(),revision=randomUUID(),basis=randomUUID();
const document=randomUUID(),documentRevision=randomUUID(),run=randomUUID(),messageId=randomUUID();
const at='2026-10-26T00:00:00.000Z',qualified='a'.repeat(64);
const message:SessionMessageRecord={projectId:project,id:messageId,operationId:randomUUID(),target:{kind:'owned',sessionId:session},
  senderActorId:'sender',content:'Original queued M',context:null,replyToMessageId:null,state:'queued',version:1,
  blockedReason:null,readReceipt:null,createdAt:at,updatedAt:at};
const grant={projectId:project,sessionId:session,senderActorId:'sender',receiverRoleId:role,receiverActorId:'worker',
  cwd:'/tmp/evoloop-recovery-test',maxTurns:3,enabled:true};
const messages=new SessionMessageService({uow,clock:{now:()=>new Date().toISOString()},ids:{next:randomUUID},grantFor:async()=>grant});

before(async()=>{
  await migrate(url!,schema);
  const c=await pool.connect();
  try{
    await c.query('BEGIN');
    await c.query("INSERT INTO project(project_id,title,created_at) VALUES($1,'Recovery test',$2)",[project,at]);
    await c.query(`INSERT INTO runtime_session(project_id,session_id,role_id,cwd,authorization_scope,sandbox,approval_policy,
      state,version,native_thread_id,native_session_id,operation_id,actor_id,created_at,updated_at)
      VALUES($1,$2,$3,$4,'project','workspace-write','on-request','ready',1,$5,$5,$6,'worker',$7,$7)`,
      [project,session,role,grant.cwd,`native-${session}`,randomUUID(),at]);
    await c.query(`INSERT INTO process_document(project_id,document_id,title,version,current_revision_id,kind,status)
      VALUES($1,$2,'Task',1,$3,'task','draft')`,[project,document,documentRevision]);
    await c.query(`INSERT INTO document_revision(project_id,document_id,revision_id,body,format,content_hash,author,created_at,reason)
      VALUES($1,$2,$3,'Fixed body','markdown',repeat('a',64),'lead',$4,'fixture')`,[project,document,documentRevision,at]);
    await c.query(`INSERT INTO task(project_id,task_id,version,current_revision_id,title,acceptance,owner,state,content_document_id,content_revision_id)
      VALUES($1,$2,1,$3,'Task','Result',$4,'in_progress',$5,$6)`,[project,task,revision,role,document,documentRevision]);
    await c.query(`INSERT INTO task_revision(project_id,task_id,revision_id,version,title,acceptance,owner,state,basis_set_id,actor_id,reason,created_at,content_document_id,content_revision_id)
      VALUES($1,$2,$3,1,'Task','Result',$7,'in_progress',$4,'lead','fixture',$8,$5,$6)`,
      [project,task,revision,basis,document,documentRevision,role,at]);
    await c.query('INSERT INTO basis_set(project_id,task_id,task_revision_id,basis_set_id,sealed) VALUES($1,$2,$3,$4,true)',
      [project,task,revision,basis]);
    await c.query(`INSERT INTO runtime_run(project_id,run_id,task_id,task_revision_id,basis_set_id,session_id,operation_id,
      input,input_hash,state,version,native_turn_id,actor_id,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,'Fixed input','hash','running',1,'original-turn','worker',$8,$8)`,
      [project,run,task,revision,basis,session,randomUUID(),at]);
    await c.query('COMMIT');
  }catch(error){await c.query('ROLLBACK');throw error;}finally{c.release();}
  await uow.transaction(project,tx=>tx.sessionMessages!.insertSessionMessage(message));
});
after(async()=>{await pool.end();const c=new pg.Client({connectionString:url});await c.connect();
  try{await c.query(`DROP SCHEMA "${schema}" CASCADE`);}finally{await c.end();}});

test('transaction-scoped recovery classifies only this project’s persisted bound dispatch origin',async()=>{
  const c=await pool.connect();
  try{
    await c.query('BEGIN');
    // Shadow the dispatch relation in this transaction to isolate the origin predicate
    // without manufacturing an unrelated Goal, Role policy, and division decision.
    await c.query('CREATE TEMP TABLE orchestration_dispatch(project_id uuid,dispatch_id uuid,binding_id uuid) ON COMMIT DROP');
    const bound=randomUUID(),unbound=randomUUID(),foreign=randomUUID(),foreignProject=randomUUID();
    await c.query(`INSERT INTO orchestration_dispatch(project_id,dispatch_id,binding_id) VALUES
      ($1,$2,$3),($1,$4,NULL),($5,$6,$7)`,[project,bound,randomUUID(),unbound,foreignProject,foreign,randomUUID()]);
    const recovery=new PgSessionRecovery(c,project);
    assert.equal(await recovery.isDynamicSession(session),false,'ordinary reserved Session remains static');
    assert.equal(await recovery.isDynamicSession(loopIntentId(bound,'session')),true);
    assert.equal(await recovery.isDynamicSession(loopIntentId(unbound,'session')),false,'unbound dispatch does not classify origin');
    assert.equal(await recovery.isDynamicSession(loopIntentId(foreign,'session')),false,'other project is excluded');
    await c.query(`INSERT INTO orchestration_dispatch(project_id,dispatch_id,binding_id)
      SELECT $1, md5('overflow-'||n::text)::uuid, $2 FROM generate_series(1,10001) n`,[project,randomUUID()]);
    assert.equal(await recovery.isDynamicSession(session),true,'bounded overflow fails closed');
    await c.query('ROLLBACK');
  }catch(error){await c.query('ROLLBACK');throw error;}finally{c.release();}
});

test('terminal failure fences the already queued original message before native startup',async()=>{
  await uow.transaction(project,async tx=>{
    const current=(await tx.getRuntimeRun(run))!;
    await tx.updateRuntimeRun({...current,state:'failed',version:current.version+1,updatedAt:new Date().toISOString()},current.version);
  });
  await assert.rejects(messages.beginDispatch(project,messageId,randomUUID(),randomUUID(),qualified),
    /RECOVERY|recovery|blocked|fenced|gate/i);
  assert.equal((await messages.detail(project,messageId)).message.state,'queued');
  assert.equal((await messages.detail(project,messageId)).processing,null);
  await assert.rejects(uow.transaction(project,async tx=>{
    const original=(await tx.getRuntimeRun(run))!;
    await tx.insertRuntimeRun({...original,id:randomUUID(),operationId:randomUUID(),state:'requested',version:1,
      nativeTurnId:null,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()});
  }),/recovery gate blocks native startup/i);
});

test('recording an original Run as unknown and later marking its interrupt intent does not start another Run',async()=>{
  const unknownSession=randomUUID(),unknownRun=randomUUID(),unknownTask=randomUUID(),unknownRevision=randomUUID(),
    unknownBasis=randomUUID(),unknownDocument=randomUUID(),unknownDocumentRevision=randomUUID(),now=new Date().toISOString();
  const c=await pool.connect();try{
    await c.query('BEGIN');
    await c.query(`INSERT INTO runtime_session(project_id,session_id,role_id,cwd,authorization_scope,sandbox,approval_policy,
      state,version,native_thread_id,native_session_id,operation_id,actor_id,created_at,updated_at)
      VALUES($1,$2,$3,$4,'project','workspace-write','on-request','ready',1,$5,$5,$6,'worker',$7,$7)`,
      [project,unknownSession,role,grant.cwd,`native-${unknownSession}`,randomUUID(),now]);
    await c.query(`INSERT INTO process_document(project_id,document_id,title,version,current_revision_id,kind,status)
      VALUES($1,$2,'Uncertain Task',1,$3,'task','draft')`,[project,unknownDocument,unknownDocumentRevision]);
    await c.query(`INSERT INTO document_revision(project_id,document_id,revision_id,body,format,content_hash,author,created_at,reason)
      VALUES($1,$2,$3,'Uncertain task','markdown',$4,'lead',$5,'fixture')`,
      [project,unknownDocument,unknownDocumentRevision,qualified,now]);
    await c.query(`INSERT INTO task(project_id,task_id,version,current_revision_id,title,acceptance,owner,state,content_document_id,content_revision_id)
      VALUES($1,$2,1,$3,'Uncertain Task','Review uncertainty',$4,'in_progress',$5,$6)`,
      [project,unknownTask,unknownRevision,role,unknownDocument,unknownDocumentRevision]);
    await c.query(`INSERT INTO task_revision(project_id,task_id,revision_id,version,title,acceptance,owner,state,basis_set_id,actor_id,reason,created_at,content_document_id,content_revision_id)
      VALUES($1,$2,$3,1,'Uncertain Task','Review uncertainty',$7,'in_progress',$4,'lead','fixture',$8,$5,$6)`,
      [project,unknownTask,unknownRevision,unknownBasis,unknownDocument,unknownDocumentRevision,role,now]);
    await c.query('INSERT INTO basis_set(project_id,task_id,task_revision_id,basis_set_id,sealed) VALUES($1,$2,$3,$4,true)',
      [project,unknownTask,unknownRevision,unknownBasis]);
    await c.query('COMMIT');
  }catch(error){await c.query('ROLLBACK');throw error;}finally{c.release();}
  await uow.transaction(project,async tx=>{
    const original=(await tx.getRuntimeRun(run))!;
    await tx.insertRuntimeRun({...original,id:unknownRun,taskId:unknownTask,taskRevisionId:unknownRevision,
      basisSetId:unknownBasis,sessionId:unknownSession,operationId:randomUUID(),
      state:'running',version:1,nativeTurnId:'original-unknown-turn',interruptRequested:false,
      executionProfile:null,createdAt:now,updatedAt:now});
    const current=(await tx.getRuntimeRun(unknownRun))!;
    await tx.updateRuntimeRun({...current,state:'unknown',version:2,updatedAt:new Date().toISOString()},1);
    assert.equal((await tx.recovery!.getRecoveryGate(unknownSession))!.phase,'blocked');
    const uncertain=(await tx.getRuntimeRun(unknownRun))!;
    await tx.updateRuntimeRun({...uncertain,version:3,interruptRequested:true,updatedAt:new Date().toISOString()},2);
    assert.equal((await tx.recovery!.getRecoveryGate(unknownSession))!.phase,'blocked');
    assert.equal((await tx.getRuntimeRun(unknownRun))!.interruptRequested,true);
    const flagged=(await tx.getRuntimeRun(unknownRun))!;
    await tx.updateRuntimeRun({...flagged,state:'failed',version:4,updatedAt:new Date().toISOString()},3);
    const recorded=(await tx.getRuntimeRun(unknownRun))!;
    await tx.updateRuntimeRun({...recorded,state:'unknown',version:5,updatedAt:new Date().toISOString()},4);
    assert.equal((await tx.recovery!.getRecoveryGate(unknownSession))!.phase,'blocked');
  });
  await assert.rejects(uow.transaction(project,async tx=>{
    const original=(await tx.getRuntimeRun(unknownRun))!;
    await tx.updateRuntimeRun({...original,state:'dispatching',version:6,updatedAt:new Date().toISOString()},5);
  }),/recovery gate blocks native startup/i);
  await assert.rejects(uow.transaction(project,async tx=>{
    const original=(await tx.getRuntimeRun(unknownRun))!;
    await tx.insertRuntimeRun({...original,id:randomUUID(),operationId:randomUUID(),state:'requested',version:1,
      nativeTurnId:null,createdAt:now,updatedAt:now});
  }),/recovery gate blocks native startup/i);
});

test('unknown message processing may record original operation metadata without permitting another startup',async()=>{
  const s=randomUUID(),m=randomUUID(),p=randomUUID(),later=randomUUID(),now=new Date().toISOString();
  const c=await pool.connect();try{
    await c.query('BEGIN');
    await c.query(`INSERT INTO runtime_session(project_id,session_id,role_id,cwd,authorization_scope,sandbox,approval_policy,
      state,version,native_thread_id,native_session_id,operation_id,actor_id,created_at,updated_at)
      VALUES($1,$2,$3,$4,'project','workspace-write','on-request','ready',1,$5,$5,$6,'worker',$7,$7)`,
      [project,s,role,grant.cwd,`native-${s}`,randomUUID(),now]);
    await c.query(`INSERT INTO session_message(project_id,message_id,operation_id,target_kind,session_id,sender_actor_id,
      content,state,version,created_at,updated_at) VALUES($1,$2,$3,'owned',$4,'sender','Original M','queued',1,$5,$5)`,
      [project,m,randomUUID(),s,now]);
    await c.query(`INSERT INTO session_message_processing(project_id,processing_id,message_id,session_id,operation_id,
      receiver_actor_id,state,native_turn_id,read_only_policy_fingerprint,version,started_at,updated_at)
      VALUES($1,$2,$3,$4,$5,'worker','running','original-message-turn',$6,1,$7,$7)`,
      [project,p,m,s,randomUUID(),qualified,now]);
    await c.query(`UPDATE session_message_processing SET state='unknown',version=2 WHERE project_id=$1 AND processing_id=$2`,[project,p]);
    await c.query(`UPDATE session_message_processing SET failure='readback pending',version=3
      WHERE project_id=$1 AND processing_id=$2`,[project,p]);
    const gate=await c.query('SELECT phase,cause_id FROM session_recovery_gate WHERE project_id=$1 AND session_id=$2',[project,s]);
    assert.equal(gate.rows[0]?.phase,'blocked');assert.equal(gate.rows[0]?.cause_id,m);
    await c.query('COMMIT');
    await assert.rejects(uow.transaction(project,async tx=>{
      const blocked=(await tx.recovery!.lockRecoveryGate(s))!,decisionId=randomUUID();
      await tx.recovery!.saveRecoveryDecision({projectId:project,id:decisionId,sessionId:s,kind:'resume',
        expectedGateVersion:blocked.version,causeId:m,sourceRunId:null,sourceInputHash:null,retryRunId:null,
        resumeMessageId:null,actorId:'lead',reason:'Must not clear unknown M',evidenceRef:'review://unknown',createdAt:now},
        {...blocked,phase:'open',resumeMessageId:null,version:blocked.version+1,decisionOperationId:decisionId},blocked.version);
    }),/RECOVERY_MESSAGE_CHANGED|unresolved|pinned/i);
    await c.query(`INSERT INTO session_message(project_id,message_id,operation_id,target_kind,session_id,
      sender_actor_id,content,state,version,created_at,updated_at)
      VALUES($1,$2,$3,'owned',$4,'sender','Later M','queued',1,$5,$5)`,[project,later,randomUUID(),s,now]);
    await assert.rejects(c.query(`INSERT INTO session_message_processing(project_id,processing_id,message_id,
      session_id,operation_id,receiver_actor_id,state,read_only_policy_fingerprint,version,started_at,updated_at)
      VALUES($1,$2,$3,$4,$5,'worker','dispatching',$6,1,$7,$7)`,
      [project,randomUUID(),later,s,randomUUID(),qualified,now]),/recovery gate blocks native startup/i);
  }catch(error){await c.query('ROLLBACK');throw error;}finally{c.release();}
});

test('explicit decision can permit only the pinned original message, then no-claim completion opens',async()=>{
  const other=randomUUID();
  await uow.transaction(project,tx=>tx.sessionMessages!.insertSessionMessage({...message,id:other,
    operationId:randomUUID(),content:'Later message B',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()}));
  await uow.transaction(project,async tx=>{
    const gate=await tx.recovery!.lockRecoveryGate(session);
    assert.equal(gate.phase,'blocked');assert.equal(gate.causeId,run);assert.equal(gate.resumeMessageId,messageId);
    const decisionId=randomUUID(),now=new Date().toISOString();
    await tx.recovery!.saveRecoveryDecision({projectId:project,id:decisionId,sessionId:session,kind:'resume',
      expectedGateVersion:gate.version,causeId:run,sourceRunId:run,sourceInputHash:null,retryRunId:null,
      resumeMessageId:messageId,actorId:'lead',reason:'Reviewed known failure',evidenceRef:'review://1',createdAt:now},
      {...gate,phase:'message_pending',version:gate.version+1,reason:'Reviewed known failure',
        decisionOperationId:decisionId,updatedAt:now},gate.version);
    assert.equal((await tx.recovery!.getRecoveryGate(session))!.phase,'message_pending');
    await assert.rejects(tx.recovery!.assertStartupAllowed(session,'message',other),/blocks startup/i);
    await tx.recovery!.assertStartupAllowed(session,'message',messageId);
  });
  await assert.rejects(messages.beginDispatch(project,other,randomUUID(),randomUUID(),qualified),/recovery|slot|message/i);
  const p=await messages.beginDispatch(project,messageId,randomUUID(),randomUUID(),qualified);
  assert.equal(p.messageId,messageId);
  await assert.rejects(uow.transaction(project,async tx=>{
    const current=(await tx.getRuntimeRun(run))!;
    await tx.insertRuntimeRun({...current,id:randomUUID(),operationId:randomUUID(),state:'requested',version:1,
      nativeTurnId:null,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()});
  }),/recovery gate|native startup|ordinary message/i);
  await uow.transaction(project,async tx=>{
    const processing=(await tx.sessionMessages!.getSessionMessageProcessing(messageId))!;
    await tx.sessionMessages!.updateSessionMessageProcessing({...processing,state:'running',version:2,
      nativeTurnId:'message-turn',updatedAt:new Date().toISOString()},1);
    await tx.sessionMessages!.updateSessionMessageProcessing({...processing,state:'completed',version:3,
      nativeTurnId:'message-turn',updatedAt:new Date().toISOString()},2);
    assert.equal((await tx.recovery!.getRecoveryGate(session))!.phase,'open');
  });
});

test('configured execution profile is immutable per Run and unknown activation never opens the gate',async()=>{
  const another=randomUUID(),revisionId=randomUUID(),operationId=randomUUID(),pendingRunId=randomUUID(),now=new Date().toISOString();
  await uow.transaction(project,async tx=>{
    const base=(await tx.getRuntimeSession(session))!;
    assert.equal(base.executionProfile?.revision.version,1);
    assert.equal(sessionRecoveryCommands[0].safeParse({type:'runtime.session.executionProfile.revise',
      projectId:project,operationId:randomUUID(),sessionId:session,expectedVersion:base.version,
      expectedExecutionProfileRevisionId:base.executionProfile?.revision.revisionId,
      model:'new-model',evidenceRef:'review://grant',reason:'Controlled revision'}).success,true,
      'reserved SQL profile ID must satisfy the public UUID contract');
    assert.equal((await tx.getRuntimeRun(run))!.executionProfile?.revisionId,base.executionProfile?.revision.revisionId);
  });
  const c=await pool.connect();try{await c.query(`INSERT INTO runtime_session(project_id,session_id,role_id,cwd,authorization_scope,sandbox,approval_policy,
    state,version,native_thread_id,native_session_id,operation_id,actor_id,created_at,updated_at)
    VALUES($1,$2,$3,$4,'project','workspace-write','on-request','ready',1,$5,$5,$6,'worker',$7,$7)`,
    [project,another,role,grant.cwd,`native-${another}`,randomUUID(),now]);}finally{c.release();}
  await uow.transaction(project,async tx=>{
    const original=(await tx.getRuntimeSession(another))!;
    const profile=original.executionProfile!;
    await tx.recovery!.adoptExecutionProfile({...profile.revision,revisionId,previousRevisionId:profile.revision.revisionId,
      version:2,model:'configured-new-model',provenance:'revised',operationId,actorId:'lead',reason:'Reviewed model grant',
      evidenceRef:'review://model',createdAt:now},1);
    const changed=(await tx.getRuntimeSession(another))!;
    assert.equal(changed.model,'configured-new-model');
    assert.equal(changed.executionProfile?.activationState,'pending');
    assert.equal(changed.executionProfile?.activeRevisionId,profile.revision.revisionId);
    assert.equal((await tx.recovery!.getRecoveryGate(another))!.phase,'open');
    const prior=(await tx.getRuntimeRun(run))!;
    await tx.recovery!.assertStartupAllowed(another,'run',pendingRunId);
    await tx.insertRuntimeRun({...prior,id:pendingRunId,sessionId:another,operationId:randomUUID(),state:'requested',
      version:1,nativeTurnId:null,executionProfile:{revisionId,version:2,model:'configured-new-model',
        sandbox:'workspace-write',approvalPolicy:'on-request',cwd:grant.cwd,authorizationScope:'project',provenance:'revised'},
      createdAt:now,updatedAt:now});
    await assert.rejects(tx.recovery!.assertStartupAllowed(another,'run',pendingRunId),/profile/i,
      'persisted requested Run cannot dispatch before native activation is positively confirmed');
    assert.equal(await tx.recovery!.beginExecutionProfileActivation(another,revisionId,operationId),true);
    assert.equal(await tx.recovery!.beginExecutionProfileActivation(another,revisionId,operationId),false);
    await tx.recovery!.settleExecutionProfileActivation(another,revisionId,'unknown','No positive native receipt');
    assert.equal((await tx.recovery!.getRecoveryGate(another))!.phase,'blocked');
    await assert.rejects(tx.recovery!.assertStartupAllowed(another,'run',randomUUID()),/profile|recovery gate/i);
  });
  await uow.transaction(project,async tx=>{
    assert.equal(await tx.recovery!.beginExecutionProfileActivation(another,revisionId,operationId),false);
    await tx.recovery!.settleExecutionProfileActivation(another,revisionId,'active','Original operation readback confirmed');
    assert.equal((await tx.recovery!.getRecoveryGate(another))!.phase,'blocked');
    assert.equal((await tx.getRuntimeSession(another))!.executionProfile?.activeRevisionId,revisionId);
    const gate=await tx.recovery!.lockRecoveryGate(another),decisionId=randomUUID();
    assert.equal(gate.retryRunId!==null,true);
    await tx.recovery!.saveRecoveryDecision({projectId:project,id:decisionId,sessionId:another,kind:'resume',
      expectedGateVersion:gate.version,causeId:revisionId,sourceRunId:null,sourceInputHash:null,retryRunId:gate.retryRunId,
      resumeMessageId:null,actorId:'lead',reason:'Reviewed exact activation readback',evidenceRef:'review://activation',createdAt:now},
      {...gate,version:gate.version+1,phase:'retrying',decisionOperationId:decisionId,
        reason:'Reviewed exact activation readback',updatedAt:now},gate.version);
    await assert.rejects(tx.recovery!.assertStartupAllowed(another,'run',randomUUID()),/blocks startup/i);
    await tx.recovery!.assertStartupAllowed(another,'run',gate.retryRunId!);
    let current=(await tx.getRuntimeRun(pendingRunId))!;
    await tx.updateRuntimeRun({...current,state:'dispatching',version:2,updatedAt:new Date().toISOString()},1);
    current=(await tx.getRuntimeRun(pendingRunId))!;
    await tx.updateRuntimeRun({...current,state:'running',version:3,nativeTurnId:'confirmed-profile-turn',
      updatedAt:new Date().toISOString()},2);
    current=(await tx.getRuntimeRun(pendingRunId))!;
    await tx.updateRuntimeRun({...current,state:'completed',version:4,updatedAt:new Date().toISOString()},3);
  });
});

test('explicit native rejection and failed unstarted Run permit a new target while retaining last confirmed profile',async()=>{
  const firstRevision=randomUUID(),secondRevision=randomUUID(),firstOperation=randomUUID(),secondOperation=randomUUID(),
    requestedId=randomUUID(),at=new Date().toISOString();
  await uow.transaction(project,async tx=>{
    const initial=(await tx.getRuntimeSession(session))!;
    const lastActive=initial.executionProfile!.revision.revisionId;
    await tx.recovery!.adoptExecutionProfile({...initial.executionProfile!.revision,
      revisionId:firstRevision,previousRevisionId:lastActive,version:2,model:'rejected-target',provenance:'revised',
      operationId:firstOperation,actorId:'lead',reason:'Reviewed static model grant',evidenceRef:'review://first',createdAt:at},
      initial.version);
    const prior=(await tx.getRuntimeRun(run))!;
    await tx.insertRuntimeRun({...prior,id:requestedId,operationId:randomUUID(),state:'requested',version:1,
      nativeTurnId:null,executionProfile:{revisionId:firstRevision,version:2,model:'rejected-target',
        sandbox:initial.sandbox,approvalPolicy:initial.approvalPolicy,cwd:initial.cwd,
        authorizationScope:initial.authorizationScope,provenance:'revised'},createdAt:at,updatedAt:at});
    assert.equal(await tx.recovery!.beginExecutionProfileActivation(session,firstRevision,firstOperation),true);
    await tx.recovery!.settleExecutionProfileActivation(session,firstRevision,'rejected','Native RPC rejected exact revision');
    const after=(await tx.getRuntimeSession(session))!;
    assert.equal(after.executionProfile!.activationState,'rejected');
    assert.equal(after.executionProfile!.activeRevisionId,lastActive);
    assert.equal((await tx.recovery!.getRecoveryGate(session))!.phase,'blocked');
    await tx.updateRuntimeRun({...((await tx.getRuntimeRun(requestedId))!),state:'failed',version:2,updatedAt:new Date().toISOString()},1);
    const blocked=(await tx.recovery!.getRecoveryGate(session))!;
    assert.equal(blocked.causeKind,'run');assert.equal(blocked.causeId,requestedId);
    await tx.recovery!.adoptExecutionProfile({...after.executionProfile!.revision,revisionId:secondRevision,
      previousRevisionId:firstRevision,version:3,model:'reviewed-new-target',provenance:'revised',
      operationId:secondOperation,actorId:'lead',reason:'Reviewed replacement after explicit rejection',
      evidenceRef:'review://replacement',createdAt:new Date().toISOString()},after.version);
    const latest=(await tx.getRuntimeSession(session))!;
    assert.equal(latest.executionProfile!.activationState,'pending');
    assert.equal(latest.executionProfile!.activeRevisionId,lastActive);
    assert.equal(latest.executionProfile!.revision.previousRevisionId,firstRevision);
    assert.equal((await tx.recovery!.getRecoveryGate(session))!.causeId,requestedId,
      'new target does not erase failed Run, claim, or original message cause');
    assert.equal((await tx.getRuntimeRun(requestedId))!.executionProfile?.revisionId,firstRevision,
      'failed Run keeps its original fixed launch profile');
  });
});

test('failed claimed A permits only its exact retry, then original M and accepted release before B',async()=>{
  const p=randomUUID(),s=randomUUID(),r=randomUUID(),rr=randomUUID(),t=randomUUID(),tr=randomUUID(),b=randomUUID(),
    d=randomUUID(),dr=randomUUID(),q=randomUUID(),e=randomUUID(),claim=randomUUID(),a=randomUUID(),retry=randomUUID(),
    originalM=randomUUID(),laterM=randomUUID(),now=new Date().toISOString(),sourceInput='{"fixed":true}';
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    await client.query("INSERT INTO project(project_id,title,created_at) VALUES($1,'Recovery chain',now())",[p]);
    await client.query(`INSERT INTO process_document(project_id,document_id,title,version,current_revision_id,adopted_revision_id,kind,status)
      VALUES($1,$2,'Fixed Task',1,$3,$3,'task','published')`,[p,d,dr]);
    await client.query(`INSERT INTO document_revision(project_id,document_id,revision_id,body,format,content_hash,author,created_at,reason)
      VALUES($1,$2,$3,'Body','markdown',repeat('a',64),'lead',now(),'fixture')`,[p,d,dr]);
    await client.query(`INSERT INTO document_decision(project_id,decision_id,document_id,revision_id,actor_id,reason,created_at)
      VALUES($1,$2,$3,$4,'lead','adopt',now())`,[p,randomUUID(),d,dr]);
    await client.query(`INSERT INTO task(project_id,task_id,version,current_revision_id,title,acceptance,owner,state,content_document_id,content_revision_id)
      VALUES($1,$2,1,$3,'A','Accepted',$4,'in_progress',$5,$6)`,[p,t,tr,r,d,dr]);
    await client.query(`INSERT INTO task_revision(project_id,task_id,revision_id,version,title,acceptance,owner,state,basis_set_id,actor_id,reason,created_at,content_document_id,content_revision_id)
      VALUES($1,$2,$3,1,'A','Accepted',$7,'in_progress',$4,'lead','fixture',now(),$5,$6)`,[p,t,tr,b,d,dr,r]);
    await client.query('INSERT INTO basis_set(project_id,task_id,task_revision_id,basis_set_id,sealed) VALUES($1,$2,$3,$4,true)',[p,t,tr,b]);
    await client.query(`INSERT INTO runtime_session(project_id,session_id,role_id,cwd,authorization_scope,sandbox,approval_policy,state,version,
      native_thread_id,native_session_id,operation_id,actor_id,created_at,updated_at)
      VALUES($1,$2,$3,'/tmp/recovery-chain','project','read-only','on-request','ready',1,$4,$4,$5,'lead',now(),now())`,
      [p,s,r,'native-'+s,randomUUID()]);
    await client.query(`INSERT INTO role_definition(project_id,role_id,version,current_revision_id,state,proposed_by,created_at_utc,review_at_utc,trial_started_at_utc)
      VALUES($1,$2,1,$3,'trial','lead',now(),now()+interval '1 day',now())`,[p,r,rr]);
    await client.query(`INSERT INTO role_revision(project_id,role_id,revision_id,version,state,proposal,actor_id,reason,created_at_utc,review_at_utc)
      VALUES($1,$2,$3,1,'trial','{}'::jsonb,'lead','fixture',now(),now()+interval '1 day')`,[p,r,rr]);
    await client.query(`INSERT INTO role_session_binding(project_id,binding_id,role_id,session_id,role_revision_id,actor_id,note,created_at_utc)
      VALUES($1,$2,$3,$4,$5,'lead','bound',now())`,[p,randomUUID(),r,s,rr]);
    await client.query(`INSERT INTO resident_queue(project_id,queue_id,version,adopted_version,max_runs,adopted_by,adopted_at,reason,actor_id)
      VALUES($1,$2,1,1,3,'lead',now(),'A then B','lead')`,[p,q]);
    await client.query(`INSERT INTO resident_queue_entry(project_id,queue_id,entry_id,task_id,task_revision_id,source_input_json,
      session_id,role_id,position,consumer_id,use_required,release_rule,state,claim_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,0,'lead',false,'accepted','claimed',$9)`,[p,q,e,t,tr,sourceInput,s,r,claim]);
    await client.query(`INSERT INTO resident_queue_claim(project_id,queue_id,entry_id,claim_id,task_id,session_id,role_id)
      VALUES($1,$2,$3,$4,$5,$6,$7)`,[p,q,e,claim,t,s,r]);
    await client.query(`INSERT INTO resident_queue_attempt(project_id,claim_id,sequence,run_id,operation_id,task_revision_id)
      VALUES($1,$2,1,$3,$4,$5)`,[p,claim,a,randomUUID(),tr]);
    await client.query(`INSERT INTO runtime_run(project_id,run_id,task_id,task_revision_id,basis_set_id,session_id,operation_id,
      input,input_hash,state,version,native_turn_id,actor_id,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'running',1,'turn-a','lead',now(),now())`,
      [p,a,t,tr,b,s,randomUUID(),sourceInput,qualified]);
    for(const id of [originalM,laterM])await client.query(`INSERT INTO session_message(project_id,message_id,operation_id,target_kind,
      session_id,sender_actor_id,content,state,version,created_at,updated_at)
      VALUES($1,$2,$3,'owned',$4,'lead','Original or later','queued',1,now()+($5::int*interval '1 second'),now())`,
      [p,id,randomUUID(),s,id===originalM?0:1]);
    await client.query('COMMIT');
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  const uq=new PostgresUnitOfWork(pool,{grant:async()=>true,lead:async()=>true,binding:async()=>true,input:async()=>sourceInput});
  await uq.transaction(p,async tx=>{const old=(await tx.getRuntimeRun(a))!;
    await tx.updateRuntimeRun({...old,state:'failed',version:2,updatedAt:now},1);
    const gate=(await tx.recovery!.getRecoveryGate(s))!;
    assert.equal(gate.phase,'blocked');assert.equal(gate.claimId,claim);assert.equal(gate.resumeMessageId,originalM);
  });
  await assert.rejects(uq.transaction(p,tx=>tx.recovery!.assertStartupAllowed(s,'message',originalM)),/blocks startup/i);
  await uq.transaction(p,async tx=>{
    const gate=await tx.recovery!.lockRecoveryGate(s),decisionId=randomUUID();
    await tx.recovery!.saveRecoveryDecision({projectId:p,id:decisionId,sessionId:s,kind:'retry_failed',
      expectedGateVersion:gate.version,causeId:a,sourceRunId:a,sourceInputHash:qualified,retryRunId:retry,
      resumeMessageId:originalM,actorId:'lead',reason:'Retry exact failed A',evidenceRef:'review://retry',createdAt:now},
      {...gate,phase:'retrying',version:gate.version+1,retryRunId:retry,
        decisionOperationId:decisionId,reason:'Retry exact failed A',updatedAt:now},gate.version);
    await assert.rejects(tx.recovery!.assertStartupAllowed(s,'run',randomUUID()),/blocks startup/i);
    await tx.recovery!.assertStartupAllowed(s,'run',retry);
    assert.equal((await tx.queue!.appendResidentQueueAttempt(claim,{runId:retry,operationId:randomUUID(),taskRevisionId:tr},3))?.runId,retry);
    const old=(await tx.getRuntimeRun(a))!;
    await tx.insertRuntimeRun({...old,id:retry,operationId:randomUUID(),state:'requested',version:1,nativeTurnId:null,
      createdAt:now,updatedAt:now});
  });
  await uq.transaction(p,async tx=>{
    let current=(await tx.getRuntimeRun(retry))!;
    await tx.updateRuntimeRun({...current,state:'dispatching',version:2,updatedAt:now},1);
    current=(await tx.getRuntimeRun(retry))!;
    await tx.updateRuntimeRun({...current,state:'running',version:3,nativeTurnId:'turn-retry',updatedAt:now},2);
    current=(await tx.getRuntimeRun(retry))!;
    await tx.updateRuntimeRun({...current,state:'completed',version:4,updatedAt:now},3);
    assert.equal((await tx.recovery!.getRecoveryGate(s))!.phase,'message_pending');
    await assert.rejects(tx.recovery!.assertStartupAllowed(s,'message',laterM),/blocks startup/i);
  });
  const service=new SessionMessageService({uow:uq,clock:{now:()=>new Date().toISOString()},ids:{next:randomUUID},
    grantFor:async()=>({projectId:p,sessionId:s,senderActorId:'lead',receiverRoleId:r,receiverActorId:'worker',
      cwd:'/tmp/recovery-chain',maxTurns:3,enabled:true})});
  await service.beginDispatch(p,originalM,randomUUID(),randomUUID(),qualified);
  await uq.transaction(p,async tx=>{
    const process=(await tx.sessionMessages!.getSessionMessageProcessing(originalM))!;
    await tx.sessionMessages!.updateSessionMessageProcessing({...process,state:'running',version:2,nativeTurnId:'turn-m',updatedAt:new Date().toISOString()},1);
    await tx.sessionMessages!.updateSessionMessageProcessing({...process,state:'completed',version:3,nativeTurnId:'turn-m',updatedAt:new Date().toISOString()},2);
    const original=(await tx.sessionMessages!.getSessionMessage(originalM))!;
    await tx.sessionMessages!.updateSessionMessage({...original,state:'completed_without_reply',version:original.version+1,
      updatedAt:new Date().toISOString()},original.version);
    assert.equal((await tx.recovery!.getRecoveryGate(s))!.phase,'awaiting_acceptance');
    await assert.rejects(tx.recovery!.assertStartupAllowed(s,'run',randomUUID()),/blocks startup/i);
  });
  // Business acceptance is tested by queue service separately; this exercises the
  // accepted claim transition that atomically advances the recovery gate.
  const accepted=await pool.connect();try{await accepted.query('BEGIN');
    await accepted.query(`UPDATE resident_queue_claim SET release_kind='accepted',released_at=now(),delivery_id=$3,closure_id=$4
      WHERE project_id=$1 AND claim_id=$2`,[p,claim,randomUUID(),randomUUID()]);
    await accepted.query('COMMIT');
  }catch(error){await accepted.query('ROLLBACK');throw error;}finally{accepted.release();}
  await uq.transaction(p,async tx=>{
    assert.equal((await tx.recovery!.getRecoveryGate(s))!.phase,'open');
    await tx.recovery!.assertStartupAllowed(s,'run',randomUUID());
  });
  const secondRun=randomUUID();
  await uq.transaction(p,async tx=>{
    const prior=(await tx.getRuntimeRun(retry))!;
    await tx.insertRuntimeRun({...prior,id:secondRun,operationId:randomUUID(),state:'requested',version:1,
      nativeTurnId:null,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()});
    let current=(await tx.getRuntimeRun(secondRun))!;
    await tx.updateRuntimeRun({...current,state:'dispatching',version:2,updatedAt:new Date().toISOString()},1);
    current=(await tx.getRuntimeRun(secondRun))!;
    await tx.updateRuntimeRun({...current,state:'running',version:3,nativeTurnId:'second-business-turn',
      updatedAt:new Date().toISOString()},2);
    current=(await tx.getRuntimeRun(secondRun))!;
    await tx.updateRuntimeRun({...current,state:'failed',version:4,updatedAt:new Date().toISOString()},3);
    const nextAccident=(await tx.recovery!.getRecoveryGate(s))!;
    assert.equal(nextAccident.phase,'blocked');assert.equal(nextAccident.causeId,secondRun);
    assert.equal(nextAccident.resumeMessageId,laterM,
      'after accepted release, a later failure must pin the current queued message, not the processed prior M');
    assert.notEqual(nextAccident.resumeMessageId,originalM);
  });
  const boundedSession=randomUUID(),boundedQueue=randomUUID(),boundedEntry=randomUUID(),boundedClaim=randomUUID(),
    interruptedRun=randomUUID(),boundedDecision=randomUUID(),boundedMessage=randomUUID();
  const old=await pool.connect();try{await old.query('BEGIN');
    await old.query(`INSERT INTO runtime_session(project_id,session_id,role_id,cwd,authorization_scope,sandbox,
      approval_policy,state,version,native_thread_id,native_session_id,operation_id,actor_id,created_at,updated_at)
      VALUES($1,$2,$3,'/tmp/recovery-chain','project','read-only','on-request','ready',1,$4,$4,$5,'lead',now(),now())`,
      [p,boundedSession,r,'native-'+boundedSession,randomUUID()]);
    await old.query(`INSERT INTO resident_queue(project_id,queue_id,version,adopted_version,max_runs,adopted_by,adopted_at,reason,actor_id)
      VALUES($1,$2,1,1,2,'lead',now(),'Reviewed bounded release','lead')`,[p,boundedQueue]);
    await old.query(`INSERT INTO resident_queue_entry(project_id,queue_id,entry_id,task_id,task_revision_id,source_input_json,
      session_id,role_id,position,consumer_id,use_required,release_rule,state,claim_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,0,'lead',false,'bounded_decision','claimed',$9)`,
      [p,boundedQueue,boundedEntry,t,tr,sourceInput,boundedSession,r,boundedClaim]);
    await old.query(`INSERT INTO resident_queue_claim(project_id,queue_id,entry_id,claim_id,task_id,session_id,role_id)
      VALUES($1,$2,$3,$4,$5,$6,$7)`,[p,boundedQueue,boundedEntry,boundedClaim,t,boundedSession,r]);
    await old.query(`INSERT INTO resident_queue_attempt(project_id,claim_id,sequence,run_id,operation_id,task_revision_id)
      VALUES($1,$2,1,$3,$4,$5)`,[p,boundedClaim,interruptedRun,randomUUID(),tr]);
    await old.query(`INSERT INTO session_message(project_id,message_id,operation_id,target_kind,session_id,sender_actor_id,
      content,state,version,created_at,updated_at)
      VALUES($1,$2,$3,'owned',$4,'lead','Pinned bounded message','queued',1,now(),now())`,
      [p,boundedMessage,randomUUID(),boundedSession]);
    await old.query(`INSERT INTO runtime_run(project_id,run_id,task_id,task_revision_id,basis_set_id,session_id,operation_id,
      input,input_hash,state,version,native_turn_id,actor_id,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'interrupted',1,'interrupted-turn','lead',now(),now())`,
      [p,interruptedRun,t,tr,b,boundedSession,randomUUID(),sourceInput,qualified]);
    await old.query('COMMIT');
  }catch(error){await old.query('ROLLBACK');throw error;}finally{old.release();}
  await assert.rejects(uq.transaction(p,async tx=>{
    const gate=await tx.recovery!.lockRecoveryGate(boundedSession),decisionId=randomUUID();
    await tx.recovery!.saveRecoveryDecision({projectId:p,id:decisionId,sessionId:boundedSession,kind:'resume',
      expectedGateVersion:gate.version,causeId:interruptedRun,sourceRunId:interruptedRun,sourceInputHash:null,
      retryRunId:null,resumeMessageId:null,actorId:'lead',reason:'Must keep queued M',
      evidenceRef:'review://queued',createdAt:now},
      {...gate,phase:'open',resumeMessageId:null,version:gate.version+1,decisionOperationId:decisionId},gate.version);
  }),/Queued original message must remain pinned/i);
  await assert.rejects(uq.transaction(p,async tx=>{
    const gate=await tx.recovery!.lockRecoveryGate(boundedSession),nextRunId=randomUUID(),decisionId=randomUUID();
    assert.equal(gate.causeState,'interrupted');assert.equal(gate.claimId,boundedClaim);
    await tx.recovery!.saveRecoveryDecision({projectId:p,id:decisionId,sessionId:boundedSession,kind:'retry_failed',
      expectedGateVersion:gate.version,causeId:interruptedRun,sourceRunId:interruptedRun,sourceInputHash:qualified,
      retryRunId:nextRunId,resumeMessageId:boundedMessage,actorId:'lead',reason:'Review interrupted source',
      evidenceRef:'review://interrupted',createdAt:now},
      {...gate,phase:'retrying',version:gate.version+1,retryRunId:nextRunId,
        decisionOperationId:decisionId,reason:'Review interrupted source',updatedAt:now},gate.version);
    throw new Error('rollback positive interrupted decision fixture');
  }),/rollback positive interrupted decision fixture/);
  const completedRetry=randomUUID(),completedOperation=randomUUID();
  await uq.transaction(p,async tx=>{
    const gate=await tx.recovery!.lockRecoveryGate(boundedSession),decisionId=randomUUID(),at=new Date().toISOString();
    await tx.recovery!.saveRecoveryDecision({projectId:p,id:decisionId,sessionId:boundedSession,kind:'retry_failed',
      expectedGateVersion:gate.version,causeId:interruptedRun,sourceRunId:interruptedRun,sourceInputHash:qualified,
      retryRunId:completedRetry,resumeMessageId:boundedMessage,actorId:'lead',reason:'Retry the interrupted original',
      evidenceRef:'review://bounded-retry',createdAt:at},
      {...gate,phase:'retrying',version:gate.version+1,retryRunId:completedRetry,
        decisionOperationId:decisionId,reason:'Retry the interrupted original',updatedAt:at},gate.version);
    const prior=(await tx.getRuntimeRun(interruptedRun))!;
    await tx.insertRuntimeRun({...prior,id:completedRetry,operationId:completedOperation,state:'requested',version:1,
      nativeTurnId:null,createdAt:at,updatedAt:at});
    let current=(await tx.getRuntimeRun(completedRetry))!;
    await tx.updateRuntimeRun({...current,state:'dispatching',version:2,updatedAt:at},1);
    current=(await tx.getRuntimeRun(completedRetry))!;
    await tx.updateRuntimeRun({...current,state:'running',version:3,nativeTurnId:'bounded-retry-turn',updatedAt:at},2);
    current=(await tx.getRuntimeRun(completedRetry))!;
    await tx.updateRuntimeRun({...current,state:'completed',version:4,updatedAt:at},3);
    assert.equal((await tx.recovery!.getRecoveryGate(boundedSession))!.phase,'message_pending');
  });
  const processed=await pool.connect();try{await processed.query('BEGIN');
    await processed.query(`UPDATE session_message SET state='processing',version=2 WHERE project_id=$1 AND message_id=$2`,
      [p,boundedMessage]);
    await processed.query(`INSERT INTO session_message_processing(project_id,processing_id,message_id,session_id,operation_id,
      receiver_actor_id,state,native_turn_id,read_only_policy_fingerprint,version,started_at,updated_at)
      VALUES($1,$2,$3,$4,$5,'lead','running','bounded-message-turn',$6,1,now(),now())`,
      [p,randomUUID(),boundedMessage,boundedSession,randomUUID(),qualified]);
    await processed.query(`UPDATE session_message_processing SET state='completed',version=2
      WHERE project_id=$1 AND message_id=$2`,[p,boundedMessage]);
    await processed.query(`UPDATE session_message SET state='completed_without_reply',version=3
      WHERE project_id=$1 AND message_id=$2`,[p,boundedMessage]);
    await processed.query('COMMIT');
  }catch(error){await processed.query('ROLLBACK');throw error;}finally{processed.release();}
  await uq.transaction(p,async tx=>assert.equal((await tx.recovery!.getRecoveryGate(boundedSession))!.phase,'awaiting_acceptance'));
  const bounded=await pool.connect();try{await bounded.query('BEGIN');
    await bounded.query(`INSERT INTO resident_queue_release_decision(project_id,decision_id,claim_id,actor_id,reason,next_responsibility)
      VALUES($1,$2,$3,'lead','Bounded stop','Manual follow-up')`,[p,boundedDecision,boundedClaim]);
    await bounded.query(`UPDATE resident_queue_claim SET release_kind='bounded',released_at=now(),bounded_decision_id=$3
      WHERE project_id=$1 AND claim_id=$2`,[p,boundedClaim,boundedDecision]);
    await bounded.query('COMMIT');
  }catch(error){await bounded.query('ROLLBACK');throw error;}finally{bounded.release();}
  await uq.transaction(p,async tx=>{
    const gate=await tx.recovery!.lockRecoveryGate(boundedSession);
    assert.equal(gate.phase,'blocked');assert.equal(gate.claimId,boundedClaim,
      'bounded release after completed retry must become reviewable, not stay in awaiting_acceptance');
    const invalidDecision=randomUUID();
    await assert.rejects(tx.recovery!.saveRecoveryDecision({projectId:p,id:invalidDecision,sessionId:boundedSession,
      kind:'resume',expectedGateVersion:gate.version,causeId:interruptedRun,sourceRunId:interruptedRun,
      sourceInputHash:null,retryRunId:null,resumeMessageId:boundedMessage,actorId:'lead',
      reason:'Cannot dispatch processed M twice',evidenceRef:'review://bounded',createdAt:now},
      {...gate,phase:'message_pending',claimId:null,version:gate.version+1,
        decisionOperationId:invalidDecision,updatedAt:now},gate.version),/RECOVERY_MESSAGE_CHANGED|settled/i);
    const decisionId=randomUUID();
    await tx.recovery!.saveRecoveryDecision({projectId:p,id:decisionId,sessionId:boundedSession,kind:'resume',
      expectedGateVersion:gate.version,causeId:interruptedRun,sourceRunId:interruptedRun,sourceInputHash:null,
      retryRunId:null,resumeMessageId:null,actorId:'lead',reason:'Review bounded release and stop',
      evidenceRef:'review://bounded',createdAt:now},
      {...gate,phase:'open',claimId:null,resumeMessageId:null,version:gate.version+1,
        decisionOperationId:decisionId,reason:'Review bounded release and stop',updatedAt:now},gate.version);
    assert.equal((await tx.recovery!.getRecoveryGate(boundedSession))!.claimId,null);
    assert.equal((await tx.recovery!.getRecoveryGate(boundedSession))!.phase,'open');
  });
});

test('budget extension is an immutable, controller-authored revision and requires separate adoption',async()=>{
  const queueId=randomUUID(),authorized=new PostgresUnitOfWork(pool,{lead:async()=>true});
  await authorized.transaction(project,async tx=>{
    await tx.queue!.createResidentQueue({projectId:project,id:queueId,version:1,adoptedVersion:null,
      maxRuns:1,reason:'One reviewed attempt',actorId:'lead',entries:[]});
    await tx.queue!.adoptResidentQueue(queueId,1,'lead');
  });
  await authorized.transaction(project,async tx=>{
    assert.equal(await tx.queue!.extendResidentQueueBudget(queueId,1,1,2,'lead','Need one bounded retry',
      'review://budget',randomUUID()),2);
    const q=(await tx.queue!.getResidentQueue(queueId))!;
    assert.equal(q.maxRuns,2);assert.equal(q.version,2);assert.equal(q.adoptedVersion,1);
    await assert.rejects(tx.queue!.extendResidentQueueBudget(queueId,1,1,3,'lead','Stale',
      'review://stale',randomUUID()),/changed/i);
  });
  const c=await pool.connect();try{
    const audit=await c.query('SELECT previous_max_runs,max_runs,actor_id FROM resident_queue_budget_revision WHERE project_id=$1 AND queue_id=$2',
      [project,queueId]);
    assert.equal(audit.rows.length,1);assert.deepEqual(audit.rows[0],{previous_max_runs:1,max_runs:2,actor_id:'lead'});
  }finally{c.release();}
});

test('new reserved Session activates only its original configured revision on first native binding',async()=>{
  const id=randomUUID(),operationId=randomUUID(),at=new Date().toISOString();
  await uow.transaction(project,async tx=>{
    await tx.insertRuntimeSession({projectId:project,id,roleId:role,cwd:grant.cwd,
      authorizationScope:'project',model:'reserved-model',sandbox:'read-only',approvalPolicy:'on-request',
      state:'reserved',version:1,nativeThreadId:null,nativeSessionId:null,operationId,actorId:'lead',
      closeOperationId:null,closeAttemptedAt:null,closeVerifiedAt:null,createdAt:at,updatedAt:at});
    const reserved=(await tx.getRuntimeSession(id))!;
    assert.equal(reserved.executionProfile?.revision.provenance,'reserved');
    assert.equal(reserved.executionProfile?.activationState,'pending');
    assert.equal(reserved.executionProfile?.activeRevisionId,null);
    assert.equal(sessionRecoveryCommands[0].safeParse({type:'runtime.session.executionProfile.revise',projectId:project,
      operationId:randomUUID(),sessionId:id,expectedVersion:1,
      expectedExecutionProfileRevisionId:reserved.executionProfile?.revision.revisionId,
      model:'future-model',evidenceRef:'review://future',reason:'Future revision'}).success,true);
    await tx.updateRuntimeSession({...reserved,state:'creating',version:2,updatedAt:new Date().toISOString()},1);
    const creating=(await tx.getRuntimeSession(id))!;
    assert.equal(creating.executionProfile?.activationState,'pending');
    await tx.updateRuntimeSession({...creating,state:'ready',version:3,nativeThreadId:'native-'+id,
      nativeSessionId:'native-'+id,updatedAt:new Date().toISOString()},2);
    const bound=(await tx.getRuntimeSession(id))!;
    assert.equal(bound.executionProfile?.activationState,'active');
    assert.equal(bound.executionProfile?.activeRevisionId,reserved.executionProfile?.revision.revisionId);
  });
});
