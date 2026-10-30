import assert from 'node:assert/strict';
import {after,before,test} from 'node:test';
import {randomUUID,createHash} from 'node:crypto';
import pg from 'pg';
import {migrate,PostgresUnitOfWork} from '../src/index.ts';
import {WorkflowService,RuntimeWorkflowService} from '@evoloop/core';
import {SessionMessageService} from '@evoloop/core/session-messages';
import {canonicalTaskInputJson,taskInputSignature} from '../../core/src/task-input.ts';
import {seedSealingWorkerSubmission} from './signed-worker-fixture.js';
const url=process.env.TEST_DATABASE_URL;
if(!url||!/^\/evoloop(?:_[a-z0-9]+)*_test$/i.test(new URL(url).pathname))throw Error('Dedicated evoLoop test database required');
const schema='el_recovery_commands_'+randomUUID().replaceAll('-','').slice(0,12);
const pool=new pg.Pool({connectionString:url,options:`-c search_path=${schema}`});
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
const projectId=randomUUID(),roleId=randomUUID(),roleRevision=randomUUID(),sessionId=randomUUID(),taskA=randomUUID(),taskB=randomUUID();
const queueId=randomUUID(),entryA=randomUUID(),entryB=randomUUID(),claimId=randomUUID(),runA=randomUUID(),originalM=randomUUID();
const lead={actorId:'lead',projectIds:[projectId],permissions:['read','write','review'] as Array<'read'|'write'|'review'>};
const uow=new PostgresUnitOfWork(pool,{grant:async()=>true,binding:async()=>true,lead:async()=>true,
  input:async(reader,id)=>canonicalTaskInputJson(await taskInputSignature(reader,(await reader.getTask(id))!))});
const clock={now:()=>new Date().toISOString()},ids={next:randomUUID};
const workflow=new WorkflowService({uow,clock,ids,hasher:{hash},recoveryAuthority:{canRevise:async()=>true},
  collaborationAuthority:{actorForRole:async()=> 'worker',isAuthorizedRoleActor:async()=>true,isProjectActor:async()=>true,hasEngineeringActionGrant:async()=>false}});
const native=new RuntimeWorkflowService({uow,clock,ids});
const messages=new SessionMessageService({uow,clock,ids,grantFor:async()=>({projectId,sessionId,senderActorId:'lead',receiverActorId:'worker',receiverRoleId:roleId,cwd:'/tmp/recovery-command-test',maxTurns:1,enabled:true})});
const business={...lead,actorId:'worker'};
const apply=async(c:any,principal=lead)=>{const r=await workflow.execute(principal,{projectId,operationId:randomUUID(),...c});assert.equal(r.status,'applied',JSON.stringify(r));return r as any;};
before(async()=>{
  await migrate(url!,schema);await apply({type:'project.create',title:'Controlled recovery command integration'});
  const c=await pool.connect();try{await c.query('BEGIN');const rev=roleRevision;
    await c.query(`INSERT INTO role_definition(project_id,role_id,version,current_revision_id,state,proposed_by,created_at_utc,review_at_utc,trial_started_at_utc)
      VALUES($1,$2,1,$3,'trial','lead',now(),now()+interval '1 day',now())`,[projectId,roleId,rev]);
    await c.query(`INSERT INTO role_revision(project_id,role_id,revision_id,version,state,proposal,actor_id,reason,created_at_utc,review_at_utc)
      VALUES($1,$2,$3,1,'trial','{}'::jsonb,'lead','bounded fixture',now(),now()+interval '1 day')`,[projectId,roleId,rev]);await c.query('COMMIT');
  }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
  for(const [taskId,title]of [[taskA,'Fixed A'],[taskB,'Dependent B']]){
    await apply({type:'task.create',taskId,title,content:'Read the fixed source and report a concrete result',acceptance:'Consumer uses the fixed result',owner:roleId,consumer:'lead',useRequired:true});
    await apply({type:'task.start',taskId,expectedVersion:1,reason:'Pin original business input'});
  }
  await apply({type:'runtime.session.reserve',sessionId,roleId,cwd:'/tmp/recovery-command-test',authorizationScope:'project',model:'original-model',sandbox:'danger-full-access',approvalPolicy:'never'},business);
  await native.beginSessionCreate(projectId,sessionId);
  const session=await workflow.getRuntimeSession(lead,projectId,sessionId);
  await native.bindSession(projectId,sessionId,{owner:'evoloop-codex-app-server',projectId,sessionId,roleId,cwd:session.cwd,authorizationScope:session.authorizationScope,nativeThreadId:'same-thread',nativeSessionId:'same-session',
    resumeProfile:{actorId:session.actorId,model:session.model,sandbox:session.sandbox,approvalPolicy:session.approvalPolicy,executionProfileRevisionId:session.executionProfile!.revision.revisionId}});
  await pool.query(`INSERT INTO role_session_binding(project_id,binding_id,role_id,session_id,role_revision_id,actor_id,note,created_at_utc)
    VALUES($1,$2,$3,$4,$5,'lead','owned test fixture',now())`,[projectId,randomUUID(),roleId,sessionId,roleRevision]);
  for(const taskId of [taskA,taskB]){
    const task=(await workflow.getTask(lead,projectId,taskId)).task;
    await apply({type:'task.assignment.set',taskId,expectedTaskVersion:task.version,expectedVersion:0,target:{kind:'owned',sessionId},recipientActorId:'worker',reason:'Assign the fixed v2 input before native dispatch'});
    await apply({type:'task.assignment.acknowledge',taskId,expectedTaskVersion:task.version,expectedVersion:1,evidence:'Personally read the fixed v2 business input',sourceRef:'fixture://original-acceptance'},business);
  }
  await apply({type:'queue.create',queueId,maxRuns:2,reason:'A before B, ordinary M independent',entries:[
    {id:entryA,taskId:taskA,taskRevisionId:(await workflow.getTask(lead,projectId,taskA)).task.currentRevisionId,sessionId,roleId,dependsOn:[],consumerId:'lead',useRequired:true,releaseRule:'accepted'},
    {id:entryB,taskId:taskB,taskRevisionId:(await workflow.getTask(lead,projectId,taskB)).task.currentRevisionId,sessionId,roleId,dependsOn:[entryA],consumerId:'lead',useRequired:true,releaseRule:'accepted'}]});
  await apply({type:'queue.adopt',queueId,expectedVersion:1});
});
after(async()=>{await pool.end();const c=new pg.Client({connectionString:url});await c.connect();try{await c.query(`DROP SCHEMA "${schema}" CASCADE`);}finally{await c.end();}});

test('formal commands preserve failure, fixed business input and original M through retry, acceptance and B',async()=>{
  const fixedA=(await workflow.getTask(lead,projectId,taskA)).task;
  assert.equal(fixedA.version,2);
  const op=randomUUID();const firstClaim=await apply({type:'queue.claim',queueId,entryId:entryA,claimId,runId:runA,operationId:op,runOperationId:op,expectedVersion:1});assert.equal(firstClaim.queue.runId,runA,JSON.stringify(firstClaim));
  // Materialize a row created by the old release. Only this isolated fixture bypasses the new immutable-origin trigger.
  const legacyInput=`Task ${taskA} fixed source ${fixedA.currentRevisionId}\nFixed work and original authorization; read the sealed basis.`;
  const historical=await pool.connect();try{
    await historical.query('BEGIN');await historical.query('SET LOCAL session_replication_role = replica');
    await historical.query('UPDATE runtime_run SET input=$3,input_hash=$4 WHERE project_id=$1 AND run_id=$2',
      [projectId,runA,legacyInput,hash(legacyInput)]);
    await historical.query('COMMIT');
  }catch(error){await historical.query('ROLLBACK');throw error;}finally{historical.release();}
  await native.beginDispatch(projectId,runA);await native.bindTurn(projectId,runA,{id:'failed-original-turn'},{kind:'startReply',operationId:op});
  await apply({type:'session.message.post',messageId:originalM,target:{kind:'owned',sessionId},context:{taskId:taskA,taskRevisionId:fixedA.currentRevisionId},content:'The original message posted while A is running'});
  await native.recordTurn(projectId,runA,'failed-original-turn','failed','Controlled provider rejection');
  const failed=await workflow.getRuntimeRun(lead,projectId,runA);
  const currentA=(await workflow.getTask(lead,projectId,taskA)).task;
  assert.equal(currentA.version,3);assert.equal(currentA.currentRevisionId,failed.taskRevisionId);
  assert.notEqual(currentA.currentRevisionId,fixedA.currentRevisionId);
  assert.equal(currentA.contentRevisionId,fixedA.contentRevisionId);
  const oldAssignment=await uow.read(projectId,tx=>tx.sessionAssignments!.getTaskSessionAssignment(taskA));
  assert.equal(oldAssignment!.state,'accepted');assert.equal(oldAssignment!.taskRevisionId,fixedA.currentRevisionId);
  assert.equal((await workflow.getResidentQueue(lead,projectId,queueId)).entries[0]!.taskRevisionId,fixedA.currentRevisionId);
  const oldProfile=structuredClone(failed.executionProfile);
  let view=await workflow.getSessionRecovery(lead,projectId,sessionId);
  assert.equal(view.gate!.phase,'blocked');assert.equal(view.gate!.resumeMessageId,originalM);
  await assert.rejects(messages.beginDispatch(projectId,originalM,randomUUID(),randomUUID(),'a'.repeat(64)),/recovery|gate/i);
  const session=await workflow.getRuntimeSession(lead,projectId,sessionId);
  await apply({type:'runtime.session.executionProfile.revise',sessionId,expectedVersion:session.version,expectedExecutionProfileRevisionId:session.executionProfile!.revision.revisionId,model:'reviewed-model',sandbox:'danger-full-access',approvalPolicy:'never',evidenceRef:'fixture://exact-grant-and-provider',reason:'Explicit controlled revision'});
  const revised=await workflow.getRuntimeSession(lead,projectId,sessionId);
  assert.equal(revised.executionProfile!.activationState,'pending');assert.deepEqual((await workflow.getRuntimeRun(lead,projectId,runA)).executionProfile,oldProfile);
  const budget={type:'queue.extendBudget',projectId,queueId,expectedVersion:1,expectedMaxRuns:2,maxRuns:5,evidenceRef:'fixture://cost-decision',reason:'Two reviewed failed retries and one reviewed rework',operationId:randomUUID()};
  const extended=await apply(budget);assert.deepEqual(await workflow.execute(lead,budget as any),extended);
  assert.equal((await workflow.getSessionRecovery(lead,projectId,sessionId)).gate!.phase,'blocked');
  await apply({type:'queue.adopt',queueId,expectedVersion:2});
  view=await workflow.getSessionRecovery(lead,projectId,sessionId);
  const retryId=randomUUID(),retryOp=randomUUID();
  const retry={type:'queue.retryFailed',projectId,operationId:retryOp,queueId,entryId:entryA,claimId,runId:retryId,runOperationId:retryOp,expectedVersion:2,expectedGateVersion:view.gate!.version,sourceRunId:runA,expectedSourceRunVersion:failed.version,expectedTaskRevisionId:(await workflow.getTask(lead,projectId,taskA)).task.currentRevisionId,expectedExecutionProfileRevisionId:revised.executionProfile!.revision.revisionId,expectedInputHash:failed.inputHash,resumeMessageId:originalM,evidenceRef:'fixture://review-known-failure',reason:'Retry the same fixed business input once'};
  const [one,two]=await Promise.all([workflow.execute(lead,retry as any),workflow.execute(lead,retry as any)]);assert.equal(one.status,'applied',JSON.stringify(one));assert.deepEqual(one,two);
  assert.equal((await workflow.listResidentQueueAttempts(lead,projectId,claimId)).length,2);
  const reserved=await workflow.getRuntimeRun(lead,projectId,retryId);
  const retryHandoff=JSON.parse(reserved.input);
  assert.equal(retryHandoff.protocol,'evoloop-run-v2');
  assert.deepEqual(retryHandoff.previousRun,{id:failed.id,taskRevisionId:failed.taskRevisionId,inputHash:failed.inputHash});
  assert.deepEqual(retryHandoff.legacySource,retryHandoff.previousRun);
  assert.ok(!reserved.input.includes(failed.input));
  assert.equal((await uow.read(projectId,tx=>tx.sessionAssignments!.getTaskSessionAssignment(taskA)))!.taskRevisionId,fixedA.currentRevisionId);
  assert.equal((await messages.detail(projectId,originalM)).message.context!.taskRevisionId,fixedA.currentRevisionId);
  assert.equal(reserved.executionProfile!.model,'reviewed-model');assert.equal((await workflow.getRuntimeRun(lead,projectId,runA)).state,'failed');
  await assert.rejects(messages.beginDispatch(projectId,originalM,randomUUID(),randomUUID(),'a'.repeat(64)),/recovery|gate|active/i);
  const profile=revised.executionProfile!.revision;
  assert.equal(await uow.transaction(projectId,tx=>tx.recovery!.beginExecutionProfileActivation(sessionId,profile.revisionId,profile.operationId)),true);
  await uow.transaction(projectId,tx=>tx.recovery!.settleExecutionProfileActivation(sessionId,profile.revisionId,'active','Controlled same-Thread native response fixture'));
  await native.beginDispatch(projectId,retryId);await native.bindTurn(projectId,retryId,{id:'retry-turn'},{kind:'startReply',operationId:retryOp});
  await native.recordTurn(projectId,retryId,'retry-turn','failed','First retry also failed');
  const failedRetry=await workflow.getRuntimeRun(lead,projectId,retryId);
  view=await workflow.getSessionRecovery(lead,projectId,sessionId);
  const secondRetryId=randomUUID(),secondRetryOp=randomUUID();
  await apply({type:'queue.retryFailed',queueId,entryId:entryA,claimId,runId:secondRetryId,runOperationId:secondRetryOp,
    operationId:secondRetryOp,expectedVersion:2,expectedGateVersion:view.gate!.version,
    sourceRunId:retryId,expectedSourceRunVersion:failedRetry.version,
    expectedTaskRevisionId:(await workflow.getTask(lead,projectId,taskA)).task.currentRevisionId,
    expectedExecutionProfileRevisionId:profile.revisionId,expectedInputHash:failedRetry.inputHash,
    resumeMessageId:originalM,evidenceRef:'fixture://second-reviewed-retry',reason:'Retry the same fixed original once more'});
  const secondRetry=await workflow.getRuntimeRun(lead,projectId,secondRetryId);
  const secondHandoff=JSON.parse(secondRetry.input);
  assert.deepEqual(secondHandoff.previousRun,{id:failedRetry.id,taskRevisionId:failedRetry.taskRevisionId,inputHash:failedRetry.inputHash});
  assert.deepEqual(secondHandoff.legacySource,{id:failed.id,taskRevisionId:failed.taskRevisionId,inputHash:failed.inputHash});
  await native.beginDispatch(projectId,secondRetryId);await native.bindTurn(projectId,secondRetryId,{id:'second-retry-turn'},{kind:'startReply',operationId:secondRetryOp});
  await native.recordTurn(projectId,secondRetryId,'second-retry-turn','completed','Fixed result from the original business input');
  assert.equal((await workflow.getSessionRecovery(lead,projectId,sessionId)).gate!.phase,'message_pending');
  const lateM=randomUUID();await apply({type:'session.message.post',messageId:lateM,target:{kind:'owned',sessionId},content:'A later message must not replace original M'});
  await assert.rejects(uow.transaction(projectId,tx=>tx.recovery!.assertStartupAllowed(sessionId,'message',lateM)),
    /recovery gate blocks startup/);
  await assert.rejects(messages.beginDispatch(projectId,lateM,randomUUID(),randomUUID(),'a'.repeat(64)));
  await messages.beginDispatch(projectId,originalM,randomUUID(),randomUUID(),'a'.repeat(64));
  const messageTurn:any={id:'original-message-turn',status:'inProgress',startedAtUtc:clock.now(),completedAtUtc:null};
  await messages.bindTurn(projectId,originalM,messageTurn);
  await messages.settle(projectId,originalM,{...messageTurn,status:'completed',completedAtUtc:clock.now()},'The original M reply');
  assert.equal((await messages.detail(projectId,originalM)).message.readReceipt,null);
  assert.equal((await workflow.getSessionRecovery(lead,projectId,sessionId)).gate!.phase,'awaiting_acceptance');
  const bOp=randomUUID(),bRun=randomUUID(),bClaim=randomUUID();
  const bCommand:any={type:'queue.claim',projectId,operationId:bOp,queueId,entryId:entryB,claimId:bClaim,runId:bRun,runOperationId:bOp,expectedVersion:2};
  const blocked=await workflow.execute(lead,bCommand);assert.equal(blocked.status,'rejected');
  const originalMessage=await messages.detail(projectId,originalM);
  const priorCause=(await workflow.getSessionRecovery(lead,projectId,sessionId)).gate!.causeId;
  const priorRetryDecisions=(await workflow.getSessionRecovery(lead,projectId,sessionId)).decisions.filter(d=>d.kind==='retry_failed').length;
  const beforeRework=await workflow.getTask(lead,projectId,taskA);
  await apply({type:'task.reopen',taskId:taskA,expectedVersion:beforeRework.task.version,reason:'Independent review requires correction'});
  const todo=await workflow.getTask(lead,projectId,taskA);
  await apply({type:'task.update',taskId:taskA,expectedVersion:todo.task.version,title:todo.task.title,
    content:`${todo.task.content}\nCorrect independently reviewed defect`,acceptance:todo.task.acceptance,
    owner:roleId,reason:'Amend the fixed business input for rework'});
  const updated=await workflow.getTask(lead,projectId,taskA);
  await apply({type:'task.start',taskId:taskA,expectedVersion:updated.task.version,reason:'Seal rework source'});
  const fixedRework=await workflow.getTask(lead,projectId,taskA);
  await apply({type:'queue.amend',queueId,entryId:entryA,expectedVersion:2,
    taskRevisionId:fixedRework.task.currentRevisionId,reason:'Review exact amended Task input'});
  await apply({type:'queue.adopt',queueId,expectedVersion:3});
  const completedRetry=await workflow.getRuntimeRun(lead,projectId,secondRetryId);
  const awaiting=(await workflow.getSessionRecovery(lead,projectId,sessionId)).gate!;
  const reworkId=randomUUID(),reworkOp=randomUUID();
  const rework={type:'queue.continue',projectId,operationId:reworkOp,queueId,entryId:entryA,claimId,
    runId:reworkId,runOperationId:reworkOp,reason:'Lead approves exact same-claim correction',answeredQuestions:[],
    rework:{expectedGateVersion:awaiting.version,sourceRunId:secondRetryId,
      expectedSourceRunVersion:completedRetry.version,expectedSourceInputHash:completedRetry.inputHash,
      expectedExecutionProfileRevisionId:completedRetry.executionProfile!.revisionId,
      evidenceRef:'fixture://independent-review-correction'}};
  const reworkResult=await apply(rework);
  assert.deepEqual(await workflow.execute(lead,rework as any),reworkResult);
  const permitted=(await workflow.getSessionRecovery(lead,projectId,sessionId)).gate!;
  assert.equal(permitted.phase,'reworking');assert.equal(permitted.retryRunId,reworkId);
  assert.equal(permitted.causeId,priorCause);assert.equal(permitted.resumeMessageId,originalM);
  assert.equal((await workflow.getResidentQueue(lead,projectId,queueId)).entries[1]!.state,'queued');
  await assert.rejects(uow.transaction(projectId,tx=>tx.recovery!.assertStartupAllowed(sessionId,'message',lateM)),
    /recovery gate blocks startup/);
  await assert.rejects(messages.beginDispatch(projectId,lateM,randomUUID(),randomUUID(),'a'.repeat(64)));
  await native.beginDispatch(projectId,reworkId);await native.bindTurn(projectId,reworkId,{id:'rework-turn'},
    {kind:'startReply',operationId:reworkOp});
  await native.recordTurn(projectId,reworkId,'rework-turn','completed','Corrected fixed result');
  assert.equal((await workflow.getRuntimeRun(lead,projectId,reworkId)).state,'completed');
  const afterRework=(await workflow.getSessionRecovery(lead,projectId,sessionId));
  assert.equal(afterRework.gate!.phase,'awaiting_acceptance');
  assert.equal(afterRework.gate!.resumeMessageId,originalM);
  assert.equal(afterRework.decisions.filter(d=>d.kind==='retry_failed').length,priorRetryDecisions);
  assert.deepEqual(await messages.detail(projectId,originalM),originalMessage);
  assert.equal(await uow.read(projectId,tx=>tx.sessionMessages!.countSessionMessageTurns(sessionId,'lead')),1);
  const expectedTaskVersion=(await workflow.getTask(lead,projectId,taskA)).task.version;
  const deliveryOperationId=randomUUID(),deliveryIntent={artifactRef:'fixture:corrected-result',artifactRevision:'fixture-v2',
    contentHash:hash('Corrected result'),technicalResult:'passed' as const,technicalEvidence:'Controlled fixture consumed',reason:'Corrected delivery'};
  await seedSealingWorkerSubmission(pool,projectId,taskA,reworkId,business.actorId,deliveryOperationId,
    expectedTaskVersion,deliveryIntent);
  const delivery=await apply({type:'delivery.record',operationId:deliveryOperationId,taskId:taskA,runId:reworkId,
    expectedVersion:expectedTaskVersion,...deliveryIntent},business);
  await apply({type:'observation.record',taskId:taskA,deliveryId:delivery.revisionId,observer:'lead',observerKind:'agent',result:'used',evidence:'Read exact fixture result',reason:'Independent fixture consumption'});
  await apply({type:'task.close',taskId:taskA,expectedVersion:(await workflow.getTask(lead,projectId,taskA)).task.version,deliveryId:delivery.revisionId,acceptanceResult:'met',acceptanceEvidence:'Current delivery used',reason:'Accept fixture A'});
  await apply({type:'queue.release',queueId,entryId:entryA,claimId});
  assert.equal((await workflow.getSessionRecovery(lead,projectId,sessionId)).gate!.phase,'open');
  const finalOp=randomUUID();await apply({...bCommand,expectedVersion:3,operationId:finalOp,runOperationId:finalOp});
  assert.equal((await workflow.getRuntimeRun(lead,projectId,bRun)).executionProfile!.model,'reviewed-model');
  view=await workflow.getSessionRecovery(lead,projectId,sessionId);assert.equal(view.queues[0]!.attemptsUsed,5);assert.equal(view.queues[0]!.attemptsRemaining,0);
  assert.equal(await uow.read(projectId,tx=>tx.sessionMessages!.countSessionMessageTurns(sessionId,'lead')),1);
});

for(const messageOutcome of ['completed','failed'] as const)test(`bounded release after original message ${messageOutcome} needs a fresh review and never replays it`,async()=>{
  const taskId=randomUUID(),sid=randomUUID(),qid=randomUUID(),eid=randomUUID(),claim=randomUUID(),failedId=randomUUID(),mid=randomUUID();
  await apply({type:'task.create',taskId,title:'Bounded unfinished result',content:'Read fixed source',acceptance:'Lead chooses a bounded next responsibility',owner:roleId});
  await apply({type:'task.start',taskId,expectedVersion:1,reason:'Pin bounded fixture'});
  await apply({type:'runtime.session.reserve',sessionId:sid,roleId,cwd:'/tmp/recovery-command-test',authorizationScope:'project',model:'original-model',sandbox:'danger-full-access',approvalPolicy:'never'},business);
  const creating=await native.beginSessionCreate(projectId,sid);
  await native.bindSession(projectId,sid,{owner:'evoloop-codex-app-server',projectId,sessionId:sid,roleId,cwd:creating.cwd,authorizationScope:creating.authorizationScope,nativeThreadId:`bounded-thread-${sid}`,nativeSessionId:`bounded-session-${sid}`,
    resumeProfile:{actorId:creating.actorId,model:creating.model,sandbox:creating.sandbox,approvalPolicy:creating.approvalPolicy,executionProfileRevisionId:creating.executionProfile!.revision.revisionId}});
  await pool.query(`INSERT INTO role_session_binding(project_id,binding_id,role_id,session_id,role_revision_id,actor_id,note,created_at_utc)
    VALUES($1,$2,$3,$4,$5,'lead','bounded fixture',now())`,[projectId,randomUUID(),roleId,sid,roleRevision]);
  await apply({type:'queue.create',queueId:qid,maxRuns:2,reason:'Predeclared bounded release, no dependent entry',entries:[{id:eid,taskId,taskRevisionId:(await workflow.getTask(lead,projectId,taskId)).task.currentRevisionId,sessionId:sid,roleId,dependsOn:[],consumerId:'lead',useRequired:true,releaseRule:'bounded_decision'}]});
  await apply({type:'queue.adopt',queueId:qid,expectedVersion:1});
  const op=randomUUID();await apply({type:'queue.claim',queueId:qid,entryId:eid,claimId:claim,runId:failedId,operationId:op,runOperationId:op,expectedVersion:1});
  await native.beginDispatch(projectId,failedId);await native.bindTurn(projectId,failedId,{id:`bounded-failure-turn-${sid}`},{kind:'startReply',operationId:op});
  await apply({type:'session.message.post',messageId:mid,target:{kind:'owned',sessionId:sid},content:'Existing bounded original message'});
  await native.recordTurn(projectId,failedId,`bounded-failure-turn-${sid}`,'failed','Controlled bounded source failure');
  const failed=await workflow.getRuntimeRun(lead,projectId,failedId);
  const beforeProfile=await workflow.getRuntimeSession(lead,projectId,sid);
  await apply({type:'runtime.session.executionProfile.revise',sessionId:sid,expectedVersion:beforeProfile.version,expectedExecutionProfileRevisionId:beforeProfile.executionProfile!.revision.revisionId,model:'bounded-reviewed-model',sandbox:'danger-full-access',approvalPolicy:'never',evidenceRef:'fixture://bounded-profile',reason:'Reviewed fixture profile'});
  const target=(await workflow.getRuntimeSession(lead,projectId,sid)).executionProfile!.revision;
  const gate=(await workflow.getSessionRecovery(lead,projectId,sid)).gate!;
  const retryId=randomUUID(),retryOp=randomUUID();
  await apply({type:'queue.retryFailed',queueId:qid,entryId:eid,claimId:claim,runId:retryId,operationId:retryOp,runOperationId:retryOp,expectedVersion:1,expectedGateVersion:gate.version,sourceRunId:failedId,expectedSourceRunVersion:failed.version,expectedTaskRevisionId:(await workflow.getTask(lead,projectId,taskId)).task.currentRevisionId,expectedExecutionProfileRevisionId:(await workflow.getRuntimeSession(lead,projectId,sid)).executionProfile!.revision.revisionId,expectedInputHash:failed.inputHash,resumeMessageId:mid,evidenceRef:'fixture://bounded-retry',reason:'One reviewed retry'});
  await uow.transaction(projectId,async tx=>{
    assert.equal(await tx.recovery!.beginExecutionProfileActivation(sid,target.revisionId,target.operationId),true);
    await tx.recovery!.settleExecutionProfileActivation(sid,target.revisionId,'unknown','Controlled lost acknowledgement');
  });
  await uow.transaction(projectId,tx=>tx.recovery!.settleExecutionProfileActivation(sid,target.revisionId,'active','Controlled exact same-Thread configuration readback'));
  const activationGate=(await workflow.getSessionRecovery(lead,projectId,sid)).gate!;
  assert.equal(activationGate.phase,'blocked');
  await apply({type:'runtime.session.recovery.resume',sessionId:sid,expectedVersion:activationGate.version,expectedCauseId:activationGate.causeId,resumeMessageId:mid,evidenceRef:'fixture://first-resume',reason:'Explicitly resume after configuration-only reconciliation'});
  await native.beginDispatch(projectId,retryId);await native.bindTurn(projectId,retryId,{id:`bounded-retry-turn-${sid}`},{kind:'startReply',operationId:retryOp});
  await native.recordTurn(projectId,retryId,`bounded-retry-turn-${sid}`,'completed','Known result still needs a bounded disposition');
  const service=new SessionMessageService({uow,clock,ids,grantFor:async()=>({projectId,sessionId:sid,senderActorId:'lead',receiverActorId:'worker',receiverRoleId:roleId,cwd:'/tmp/recovery-command-test',maxTurns:1,enabled:true})});
  await service.beginDispatch(projectId,mid,randomUUID(),randomUUID(),'a'.repeat(64));
  const turn:any={id:`bounded-original-message-turn-${sid}`,status:'inProgress',startedAtUtc:clock.now(),completedAtUtc:null};
  await service.bindTurn(projectId,mid,turn);await service.settle(projectId,mid,{...turn,status:messageOutcome,completedAtUtc:clock.now()},messageOutcome==='completed'?'Actual controlled reply':null);
  if(messageOutcome==='failed'){
    const stopped=(await workflow.getSessionRecovery(lead,projectId,sid)).gate!;assert.equal(stopped.phase,'blocked');assert.equal(stopped.causeId,mid);
    await apply({type:'runtime.session.recovery.resume',sessionId:sid,expectedVersion:stopped.version,expectedCauseId:mid,resumeMessageId:stopped.resumeMessageId,evidenceRef:'fixture://known-message-failure',reason:'Keep the actual failed reply and explicitly review the next bounded responsibility'});
  }
  assert.equal((await workflow.getSessionRecovery(lead,projectId,sid)).gate!.phase,'awaiting_acceptance');
  const settledMessage=await service.detail(projectId,mid);
  await apply({type:'queue.release',queueId:qid,entryId:eid,claimId:claim,decisionId:randomUUID(),reason:'Keep unfinished Task with its next reviewer',nextResponsibility:'Lead separately reviews the unfinished Task'});
  const released=await uow.read(projectId,tx=>tx.queue!.getResidentQueueClaim(claim));assert.equal(released!.releaseKind,'bounded');
  const blockedView=await workflow.getSessionRecovery(lead,projectId,sid),blocked=blockedView.gate!;assert.equal(blocked.phase,'blocked');
  assert.equal(blocked.causeId,messageOutcome==='failed'?mid:activationGate.causeId);assert.equal(blockedView.nextAction,'review_recovery_decision');
  await apply({type:'runtime.session.recovery.resume',sessionId:sid,expectedVersion:blocked.version,expectedCauseId:blocked.causeId,resumeMessageId:blocked.resumeMessageId,evidenceRef:'fixture://explicit-resume-after-bounded',reason:'Resume after reviewed bounded release; original message was already processed'});
  const resumed=(await workflow.getSessionRecovery(lead,projectId,sid)).gate!;assert.equal(resumed.phase,'open');assert.equal(resumed.resumeMessageId,null);
  assert.deepEqual(await service.detail(projectId,mid),settledMessage);assert.equal(await uow.read(projectId,tx=>tx.sessionMessages!.countSessionMessageTurns(sid,'lead')),1);
  assert.equal((await workflow.getSessionRecovery(lead,projectId,sid)).decisions.filter(d=>d.kind==='resume'&&d.causeId===(messageOutcome==='failed'?mid:activationGate.causeId)).length,2,'a new gate version permits a second explicit review of the same historical cause');
  assert.equal((await workflow.getTask(lead,projectId,taskId)).task.state,'in_progress');
});

test('cancelled failed Task stops its exact claim without accepting work or erasing recovery',async()=>{
  const sid=randomUUID(),taskId=randomUUID(),qid=randomUUID(),eid=randomUUID(),claim=randomUUID(),runId=randomUUID(),op=randomUUID();
  await apply({type:'task.create',taskId,title:'Stop known failed task',content:'Original failed work',acceptance:'Independent consumer use',owner:roleId,consumer:'lead',useRequired:true});
  await apply({type:'task.start',taskId,expectedVersion:1,reason:'Fix original input'});
  await apply({type:'runtime.session.reserve',sessionId:sid,roleId,cwd:'/tmp/recovery-command-test',authorizationScope:'project',model:'original-model',sandbox:'danger-full-access',approvalPolicy:'never'},business);
  const creating=await native.beginSessionCreate(projectId,sid);
  await native.bindSession(projectId,sid,{owner:'evoloop-codex-app-server',projectId,sessionId:sid,roleId,cwd:creating.cwd,authorizationScope:creating.authorizationScope,nativeThreadId:`stop-thread-${sid}`,nativeSessionId:`stop-session-${sid}`,
    resumeProfile:{actorId:creating.actorId,model:creating.model,sandbox:creating.sandbox,approvalPolicy:creating.approvalPolicy,executionProfileRevisionId:creating.executionProfile!.revision.revisionId}});
  await pool.query(`INSERT INTO role_session_binding(project_id,binding_id,role_id,session_id,role_revision_id,actor_id,note,created_at_utc)
    VALUES($1,$2,$3,$4,$5,'lead','stop fixture',now())`,[projectId,randomUUID(),roleId,sid,roleRevision]);
  const task=(await workflow.getTask(lead,projectId,taskId)).task;
  await apply({type:'task.assignment.set',taskId,expectedTaskVersion:task.version,expectedVersion:0,target:{kind:'owned',sessionId:sid},recipientActorId:'worker',reason:'Assign original work'});
  await apply({type:'task.assignment.acknowledge',taskId,expectedTaskVersion:task.version,expectedVersion:1,evidence:'Read fixed source',sourceRef:'fixture://stop-original'},business);
  await apply({type:'queue.create',queueId:qid,maxRuns:2,reason:'Original failed work',entries:[{id:eid,taskId,taskRevisionId:task.currentRevisionId,sessionId:sid,roleId,dependsOn:[],consumerId:'lead',useRequired:true,releaseRule:'accepted'}]});
  await apply({type:'queue.adopt',queueId:qid,expectedVersion:1});
  await apply({type:'queue.claim',queueId:qid,entryId:eid,claimId:claim,runId,operationId:op,runOperationId:op,expectedVersion:1});
  await native.beginDispatch(projectId,runId);
  await native.bindTurn(projectId,runId,{id:`stop-failure-${sid}`},{kind:'startReply',operationId:op});
  await native.recordTurn(projectId,runId,`stop-failure-${sid}`,'failed','Known fixture failure');
  const failed=await workflow.getRuntimeRun(lead,projectId,runId);
  const gate=(await workflow.getSessionRecovery(lead,projectId,sid)).gate!;
  const entry=(await workflow.getResidentQueue(lead,projectId,qid)).entries[0]!;
  const base={type:'queue.stop',queueId:qid,entryId:eid,claimId:claim,sourceRunId:runId,expectedRunVersion:failed.version,expectedGateVersion:gate.version,expectedEntryVersion:entry.version,
    decisionId:randomUUID(),reason:'User cancelled after known failure',nextResponsibility:'Lead records unfinished work separately'};
  const rejected=await workflow.execute(lead,{projectId,operationId:randomUUID(),...base} as any);
  assert.equal(rejected.status,'rejected','stop requires an explicit Task cancellation');
  const beforeCancel=(await workflow.getTask(lead,projectId,taskId)).task;
  await apply({type:'task.cancel',taskId,expectedVersion:beforeCancel.version,reason:'User cancelled the failed work'});
  const stale=await workflow.execute(lead,{projectId,operationId:randomUUID(),...base,expectedGateVersion:gate.version+1} as any);
  assert.equal(stale.status,'rejected','gate CAS rejects stale authority');
  const staleRun=await workflow.execute(lead,{projectId,operationId:randomUUID(),...base,expectedRunVersion:failed.version+1} as any);
  assert.equal(staleRun.status,'rejected','Run version CAS rejects stale source');
  const staleEntry=await workflow.execute(lead,{projectId,operationId:randomUUID(),...base,expectedEntryVersion:entry.version+1} as any);
  assert.equal(staleEntry.status,'rejected','entry version CAS rejects stale claim');
  const stop={projectId,operationId:randomUUID(),...base};
  const rival={...stop,operationId:randomUUID(),decisionId:randomUUID()};
  const [stopped,competing]=await Promise.all([workflow.execute(lead,stop as any),workflow.execute(lead,rival as any)]);
  assert.equal([stopped,competing].filter(x=>x.status==='applied').length,1,'concurrent stop decisions release once');
  const winner=stopped.status==='applied'?stop:rival,accepted=stopped.status==='applied'?stopped:competing;
  assert.deepEqual(await workflow.execute(lead,winner as any),accepted,'same operation replays without duplicate release');
  const duplicate=await workflow.execute(lead,{...stop,operationId:randomUUID(),decisionId:randomUUID()} as any);
  assert.equal(duplicate.status,'rejected','another stop cannot release the same claim');
  const saved=await uow.read(projectId,tx=>tx.queue!.getResidentQueueClaim(claim));
  assert.equal(saved!.releaseKind,'stopped');assert.ok(saved!.releasedAt);
  assert.equal((await workflow.getRuntimeRun(lead,projectId,runId)).state,'failed');
  assert.equal((await workflow.getTask(lead,projectId,taskId)).task.state,'cancelled');
  assert.equal((await workflow.getSessionRecovery(lead,projectId,sid)).gate!.phase,'blocked','original failure still needs an explicit recovery decision');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM resident_queue_stop_decision WHERE project_id=$1 AND claim_id=$2',[projectId,claim])).rows[0].n,1);
  const reviewed=(await workflow.getSessionRecovery(lead,projectId,sid)).gate!;
  await apply({type:'runtime.session.recovery.resume',sessionId:sid,expectedVersion:reviewed.version,expectedCauseId:reviewed.causeId,resumeMessageId:reviewed.resumeMessageId,evidenceRef:'fixture://reviewed-stop',reason:'Original failed attempt retained and cancelled Task has separate responsibility'});
  assert.equal((await workflow.getSessionRecovery(lead,projectId,sid)).gate!.phase,'open');
  await uow.transaction(projectId,tx=>tx.queue!.assertQueueSessionVacant(sid));
  const nextTask=randomUUID(),nextQueue=randomUUID(),nextEntry=randomUUID(),nextRun=randomUUID(),nextOperation=randomUUID();
  await apply({type:'task.create',taskId:nextTask,title:'Independent next work',content:'New fixed work after stop',acceptance:'Independent use',owner:roleId,consumer:'lead',useRequired:true});
  await apply({type:'task.start',taskId:nextTask,expectedVersion:1,reason:'Fix next input'});
  const next=(await workflow.getTask(lead,projectId,nextTask)).task;
  await apply({type:'task.assignment.set',taskId:nextTask,expectedTaskVersion:next.version,expectedVersion:0,target:{kind:'owned',sessionId:sid},recipientActorId:'worker',reason:'Assign next work'});
  await apply({type:'task.assignment.acknowledge',taskId:nextTask,expectedTaskVersion:next.version,expectedVersion:1,evidence:'Read next fixed source',sourceRef:'fixture://after-stop'},business);
  await apply({type:'queue.create',queueId:nextQueue,maxRuns:1,reason:'Independent next work after stop',entries:[{id:nextEntry,taskId:nextTask,taskRevisionId:next.currentRevisionId,sessionId:sid,roleId,dependsOn:[],consumerId:'lead',useRequired:true,releaseRule:'accepted'}]});
  await apply({type:'queue.adopt',queueId:nextQueue,expectedVersion:1});
  const reclaimed=await apply({type:'queue.claim',queueId:nextQueue,entryId:nextEntry,claimId:randomUUID(),runId:nextRun,operationId:nextOperation,runOperationId:nextOperation,expectedVersion:1});
  assert.equal(reclaimed.queue.runId,nextRun,'the same Session can carry an independent new Task');
});
