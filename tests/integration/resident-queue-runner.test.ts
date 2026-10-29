import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import pg from 'pg';
import { RuntimeWorkflowService, WorkflowService } from '@evoloop/core';
import { migrate, PostgresUnitOfWork } from '@evoloop/adapter-postgres';
import type { Principal } from '@evoloop/contracts';
import type { RuntimeBinding, RuntimePage, RuntimePort, RuntimeSessionSpec, RuntimeTurn } from '@evoloop/contracts/runtime';
import { canonicalTaskInputJson, taskInputSignature } from '../../packages/core/src/task-input.js';
import { ResidentQueuePump } from '../../apps/coordinator/src/resident-queue/pump.js';
import { RuntimeRunner } from '../../apps/coordinator/src/runtime/runner.js';
import { buildServer } from '../../apps/coordinator/src/server.js';
import { OrdinaryRunSubmissionService, leaseCheckedUnitOfWork } from '../../apps/coordinator/src/ordinary-run-submission/service.js';
import { OrdinaryRunSealPump } from '../../apps/coordinator/src/ordinary-run-submission/pump.js';
import { createOrdinaryRunSealer } from '../../apps/coordinator/src/ordinary-run-submission/seal.js';
import { runInputPage } from '../../apps/coordinator/src/runtime/input-read.js';
import { materialRunInput } from '../../apps/cli/src/lightweight-materials.js';


function withPersistedResumeProfile(runtime: RuntimeWorkflowService, uow: PostgresUnitOfWork): RuntimeWorkflowService {
  const bind = runtime.bindSession.bind(runtime);
  runtime.bindSession = async (projectId, sessionId, binding) => {
    const saved = await uow.read(projectId, reader => reader.getRuntimeSession(sessionId));
    const profile = saved?.executionProfile;
    if (!saved || !profile) throw new Error("fixture Session execution profile unavailable");
    return bind(projectId, sessionId, { ...binding, resumeProfile: { actorId: saved.actorId, model: saved.model,
      sandbox: saved.sandbox, approvalPolicy: saved.approvalPolicy, executionProfileRevisionId: profile.revision.revisionId } });
  };
  return runtime;
}
const database=process.env.TEST_DATABASE_URL;
if(!database||!/^\/evoloop(?:_[a-z0-9]+)*_test$/i.test(new URL(database).pathname))
  throw new Error('dedicated evoloop_*_test database required');
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');

class FakeManagedRuntime {
  constructor(private unknownStartOnce=false){}
  onStart?:()=>Promise<void>;
  ready=false;
  starts:{binding:RuntimeBinding;input:string;operationId:string}[]=[];
  turn:RuntimeTurn|null=null;
  async open(){this.ready=true;}
  async close(){this.ready=false;}
  isReady(){return this.ready;}
  onDisconnect(){return ()=>{};}
  onApprovalRequest(){return ()=>{};}
  async registerBinding(_binding:RuntimeBinding){}
  async create(_spec:RuntimeSessionSpec):Promise<RuntimeBinding>{throw new Error('Session must already be bound');}
  async resume(binding:RuntimeBinding,_spec:RuntimeSessionSpec){return binding;}
  async inspect(binding:RuntimeBinding){return {thread:{id:binding.nativeThreadId,sessionId:binding.nativeSessionId,
    cwd:binding.cwd,source:'appServer'}};}
  async listTurns(_binding:RuntimeBinding):Promise<RuntimePage<RuntimeTurn>>{
    return {data:this.turn?[this.turn]:[],nextCursor:null};
  }
  async listItems(_binding:RuntimeBinding,turnId:string):Promise<RuntimePage<unknown>>{
    assert.equal(turnId,this.turn?.id);
    return {data:[{type:'userMessage',text:this.starts[0]!.input},
      {type:'agentMessage',phase:'final_answer',text:'Fixed Task result'}],nextCursor:null};
  }
  async startTurn(binding:RuntimeBinding,input:string,operationId:string):Promise<RuntimeTurn>{
    this.starts.push({binding,input,operationId});
    await this.onStart?.();
    this.turn={id:'fake-turn-1',status:'completed',completedAtUtc:new Date().toISOString()};
    if(this.unknownStartOnce){this.unknownStartOnce=false;throw new Error('native start reply lost after Turn was created');}
    return {id:this.turn.id,status:'inProgress'};
  }
  async interruptTurn(){throw new Error('No interrupt expected');}
}

for(const scenario of ['normal','lost','rework-completed','rework-failed','rework-unknown'] as const) test(scenario==='lost' ?
  'queue native start reply unknown survives runner restart and reconciles original Run without another start' :
  scenario.startsWith('rework') ? `completed failed-retry claim permits reviewed rework then ${scenario.slice(7)}` :
  'queue native start reply binds and settles original Run on its original Session',async t=>{
  const lostReply=scenario==='lost';
  const rework=scenario.startsWith('rework');
  const schema=`el_queue_runner_${randomUUID().replaceAll('-','').slice(0,16)}`;
  await migrate(database!,schema);
  const pool=new pg.Pool({connectionString:database,options:`-c search_path=${schema}`});
  t.after(async()=>{
    await pool.end();
    const cleanup=new pg.Client({connectionString:database});await cleanup.connect();
    try{await cleanup.query(`DROP SCHEMA "${schema}" CASCADE`);}finally{await cleanup.end();}
  });
  const projectId=randomUUID(),roleId=randomUUID(),roleRevisionId=randomUUID(),taskId=randomUUID();
  const sessionId=randomUUID(),queueId=randomUUID(),entryId=randomUUID();
  const controller:Principal={actorId:'queue-controller',projectIds:[projectId],permissions:['read','write','review']};
  const businessActor='role-worker';
  assert.notEqual(controller.actorId,businessActor);
  const uow=new PostgresUnitOfWork(pool,{grant:async()=>true,binding:async()=>true,lead:async()=>true,
    input:async(reader,id)=>canonicalTaskInputJson(await taskInputSignature(reader,(await reader.getTask(id))!))});
  const workflow=new WorkflowService({uow,clock:{now:()=>new Date().toISOString()},ids:{next:randomUUID},hasher:{hash},
    collaborationAuthority:{actorForRole:async()=>businessActor,isAuthorizedRoleActor:async()=>true,
      isProjectActor:async()=>true,hasEngineeringActionGrant:async()=>false}});
  const trusted=new RuntimeWorkflowService({uow,clock:{now:()=>new Date().toISOString()},ids:{next:randomUUID}});
  withPersistedResumeProfile(trusted,uow);
  const apply=async(command:Parameters<typeof workflow.execute>[1])=>{
    const result=await workflow.execute(controller,command);
    assert.equal(result.status,'applied',JSON.stringify(result));return result;
  };
  await apply({type:'project.create',projectId,operationId:randomUUID(),title:'Runner queue smoke'});
  const role=await pool.connect();try{await role.query('BEGIN');
    await role.query(`INSERT INTO role_definition(project_id,role_id,version,current_revision_id,state,proposed_by,created_at_utc,review_at_utc,trial_started_at_utc)
      VALUES($1,$2,1,$3,'trial',$4,now(),now()+interval '1 day',now())`,
    [projectId,roleId,roleRevisionId,controller.actorId]);
    await role.query(`INSERT INTO role_revision(project_id,role_id,revision_id,version,state,proposal,actor_id,reason,created_at_utc,review_at_utc)
      VALUES($1,$2,$3,1,'trial','{}'::jsonb,$4,'trial',now(),now()+interval '1 day')`,
    [projectId,roleId,roleRevisionId,controller.actorId]);
    await role.query('COMMIT');
  }catch(error){await role.query('ROLLBACK');throw error;}finally{role.release();}
  await apply({type:'task.create',projectId,operationId:randomUUID(),taskId,title:'Build fixed artifact',
    content:'# Fixed scope\nProduce one test artifact.',acceptance:'Consumer can inspect the artifact',owner:roleId});
  await apply({type:'task.start',projectId,operationId:randomUUID(),taskId,expectedVersion:1,reason:'Seal Task input'});
  const followingTaskId=randomUUID(),followingEntryId=randomUUID();
  if(rework){
    await apply({type:'task.create',projectId,operationId:randomUUID(),taskId:followingTaskId,title:'Dependent next Task',
      content:'Wait until the original claim is accepted',acceptance:'Original Task is complete',owner:roleId});
    await apply({type:'task.start',projectId,operationId:randomUUID(),taskId:followingTaskId,expectedVersion:1,reason:'Seal dependent Task'});
  }
  await apply({type:'runtime.session.reserve',projectId,operationId:randomUUID(),sessionId,roleId,
    cwd:'/tmp/evoloop-queue-runner-test',authorizationScope:'project',sandbox:'danger-full-access',approvalPolicy:'never'});
  await trusted.beginSessionCreate(projectId,sessionId);
  const nativeThreadId=`thread-${sessionId}`;
  await trusted.bindSession(projectId,sessionId,{owner:'evoloop-codex-app-server',projectId,sessionId,roleId,
    cwd:'/tmp/evoloop-queue-runner-test',authorizationScope:'project',nativeThreadId,nativeSessionId:`native-${sessionId}`});
  await pool.query(`INSERT INTO role_session_binding(project_id,binding_id,role_id,session_id,role_revision_id,actor_id,note,created_at_utc)
    VALUES($1,$2,$3,$4,$5,$6,'owned',now())`,
  [projectId,randomUUID(),roleId,sessionId,roleRevisionId,controller.actorId]);
  const task=(await workflow.getTask(controller,projectId,taskId)).task;
  await apply({type:'queue.create',projectId,operationId:randomUUID(),queueId,maxRuns:rework?4:1,
    reason:'One bounded smoke Run',entries:[{id:entryId,taskId,taskRevisionId:task.currentRevisionId,
      sessionId,roleId,dependsOn:[],consumerId:controller.actorId,useRequired:true,releaseRule:'accepted'},
      ...(rework?[{id:followingEntryId,taskId:followingTaskId,
        taskRevisionId:(await workflow.getTask(controller,projectId,followingTaskId)).task.currentRevisionId,
        sessionId,roleId,dependsOn:[entryId],consumerId:controller.actorId,useRequired:true,
        releaseRule:'accepted' as const}]:[])]});
  await apply({type:'queue.adopt',projectId,operationId:randomUUID(),queueId,expectedVersion:1});
  const errors:unknown[]=[];
  const queuePump=new ResidentQueuePump({workflow,credentials:async()=>[controller],enabled:async()=>true,
    canWrite:()=>true,pollIntervalMs:60_000,onError:error=>errors.push(error)});
  await queuePump.tick();
  assert.deepEqual(errors,[]);
  const claimed=(await workflow.getResidentQueue(controller,projectId,queueId)).entries[0]!;
  assert.equal(claimed.state,'claimed');
  const attempt=(await workflow.listResidentQueueAttempts(controller,projectId,claimed.claimId!))[0]!;
  const runBefore=await workflow.getRuntimeRun(controller,projectId,attempt.runId);
  assert.equal(runBefore.state,'requested');
  assert.equal(runBefore.operationId,attempt.operationId);
  assert.equal(runBefore.sessionId,sessionId);
  assert.equal(runBefore.actorId,controller.actorId);
  assert.deepEqual(await uow.read(projectId,reader=>reader.getClaimedQueueAcceptanceForTask!(taskId)),
    {consumerId:controller.actorId,runId:attempt.runId});
  assert.equal(await uow.read(projectId,reader=>reader.getClaimedQueueAcceptanceForTask!(randomUUID())),null);
  assert.equal(await uow.read(randomUUID(),reader=>reader.getClaimedQueueAcceptanceForTask!(taskId)),null);
  const journal=await pool.query('SELECT command_type FROM operation_journal WHERE project_id=$1 AND operation_id=$2',
    [projectId,attempt.operationId]);
  assert.equal(journal.rows[0]?.command_type,'queue.claim');
  assert.equal((await pool.query(`SELECT 1 FROM outbox_event WHERE project_id=$1 AND operation_id=$2
    AND kind='runtime.run.requested'`,[projectId,attempt.operationId])).rowCount,1);
  const channel=(await workflow.listDiscussions(controller,projectId)).items.find(x=>x.collaboration?.runId===attempt.runId)!;
  assert.equal(channel?.collaboration?.recipientActorId,businessActor);
  if(rework){
    const failed=await trusted.rejectDispatch(projectId,attempt.runId,'Controlled native preflight failure');
    assert.equal(failed.state,'failed');
    const blocked=await workflow.getSessionRecovery(controller,projectId,sessionId);
    assert.equal(blocked.gate?.phase,'blocked');
    const retryRunId=randomUUID(),retryOperationId=randomUUID();
    await apply({type:'queue.retryFailed',projectId,operationId:retryOperationId,queueId,entryId,
      claimId:claimed.claimId!,runId:retryRunId,runOperationId:retryOperationId,expectedVersion:1,
      expectedGateVersion:blocked.gate!.version,sourceRunId:failed.id,expectedSourceRunVersion:failed.version,
      expectedTaskRevisionId:failed.taskRevisionId,
      expectedExecutionProfileRevisionId:(await workflow.getRuntimeSession(controller,projectId,sessionId)).executionProfile!.revision.revisionId,
      expectedInputHash:failed.inputHash,resumeMessageId:null,evidenceRef:'Reviewed original failure',reason:'One exact retry'});
    await trusted.beginDispatch(projectId,retryRunId);
    await trusted.bindTurn(projectId,retryRunId,{id:'retry-turn',status:'inProgress'},
      {kind:'startReply',operationId:retryOperationId});
    await trusted.recordTurn(projectId,retryRunId,'retry-turn','completed','Retry completed');
    assert.equal((await workflow.getSessionRecovery(controller,projectId,sessionId)).gate?.phase,'awaiting_acceptance');
    const unchangedRun=await workflow.getRuntimeRun(controller,projectId,retryRunId);
    const unchangedGate=(await workflow.getSessionRecovery(controller,projectId,sessionId)).gate!;
    const unchangedOp=randomUUID();
    const unchanged=await workflow.execute(controller,{type:'queue.continue',projectId,operationId:unchangedOp,
      queueId,entryId,claimId:claimed.claimId!,runId:randomUUID(),runOperationId:unchangedOp,
      reason:'An unchanged Task must remain blocked',answeredQuestions:[],
      rework:{expectedGateVersion:unchangedGate.version,sourceRunId:unchangedRun.id,
        expectedSourceRunVersion:unchangedRun.version,expectedSourceInputHash:unchangedRun.inputHash,
        expectedExecutionProfileRevisionId:unchangedRun.executionProfile!.revisionId,
        evidenceRef:'A review comment alone cannot substitute changed Task input'}});
    assert.equal(unchanged.status==='rejected'?unchanged.code:null,'CONTINUATION_INPUT_UNCHANGED');
    const before=await workflow.getTask(controller,projectId,taskId);
    await apply({type:'task.reopen',projectId,operationId:randomUUID(),taskId,
      expectedVersion:before.task.version,reason:'Independent review requested rework'});
    const todo=await workflow.getTask(controller,projectId,taskId);
    await apply({type:'task.update',projectId,operationId:randomUUID(),taskId,expectedVersion:todo.task.version,
      title:todo.task.title,content:`${todo.task.content}\nAddress reviewed correction`,
      acceptance:todo.task.acceptance,owner:roleId,reason:'Fix reviewed defect'});
    const revised=await workflow.getTask(controller,projectId,taskId);
    await apply({type:'task.start',projectId,operationId:randomUUID(),taskId,
      expectedVersion:revised.task.version,reason:'Reseal reviewed rework'});
    const fixed=await workflow.getTask(controller,projectId,taskId);
    const amendment=await workflow.execute(controller,{type:'queue.amend',projectId,operationId:randomUUID(),
      queueId,entryId,expectedVersion:1,taskRevisionId:fixed.task.currentRevisionId,
      reason:'Adopt the reviewed revised Task'});
    assert.equal(amendment.status,'applied',JSON.stringify(amendment));
    await apply({type:'queue.adopt',projectId,operationId:randomUUID(),queueId,expectedVersion:2});
    const reworkOperationId=randomUUID(),reworkRunId=randomUUID();
    const retry=await workflow.getRuntimeRun(controller,projectId,retryRunId);
    const awaiting=(await workflow.getSessionRecovery(controller,projectId,sessionId)).gate!;
    const reworkCommand={type:'queue.continue' as const,projectId,
      operationId:reworkOperationId,queueId,entryId,claimId:claimed.claimId!,runId:reworkRunId,
      runOperationId:reworkOperationId,reason:'Lead approved one reviewed correction',answeredQuestions:[],
      rework:{expectedGateVersion:awaiting.version,sourceRunId:retry.id,expectedSourceRunVersion:retry.version,
        expectedSourceInputHash:retry.inputHash,
        expectedExecutionProfileRevisionId:retry.executionProfile!.revisionId,
        evidenceRef:'Independent review of original delivery requested a correction'}};
    const noPermit=await workflow.execute(controller,{...reworkCommand,operationId:randomUUID(),runOperationId:randomUUID(),rework:undefined});
    assert.equal(noPermit.status==='rejected'?noPermit.code:null,'SESSION_RECOVERY_REQUIRED');
    const stale=await workflow.execute(controller,{...reworkCommand,operationId:randomUUID(),runOperationId:randomUUID(),
      rework:{...reworkCommand.rework,expectedGateVersion:awaiting.version-1}});
    assert.equal(stale.status==='rejected'?stale.code:null,'VERSION_CONFLICT');
    const wrongSource=await workflow.execute(controller,{...reworkCommand,operationId:randomUUID(),runOperationId:randomUUID(),
      rework:{...reworkCommand.rework,sourceRunId:failed.id}});
    assert.equal(wrongSource.status==='rejected'?wrongSource.code:null,'REWORK_SOURCE_MISMATCH');
    const wrongProfile=await workflow.execute(controller,{...reworkCommand,operationId:randomUUID(),runOperationId:randomUUID(),
      rework:{...reworkCommand.rework,expectedExecutionProfileRevisionId:randomUUID()}});
    assert.equal(wrongProfile.status==='rejected'?wrongProfile.code:null,'EXECUTION_PROFILE_CONFLICT');
    const invalidAnswerOp=randomUUID();
    const invalidAnswer=await workflow.execute(controller,{...reworkCommand,operationId:invalidAnswerOp,runOperationId:invalidAnswerOp,
      answeredQuestions:[{questionEventId:randomUUID(),answerEventId:randomUUID()}]});
    assert.equal(invalidAnswer.status==='rejected'?invalidAnswer.code:null,'CONTINUATION_ANSWER_MISMATCH');
    assert.equal((await workflow.getSessionRecovery(controller,projectId,sessionId)).gate?.phase,'awaiting_acceptance',
      'an invalid answer must roll back its provisional rework permit');
    assert.equal((await workflow.listResidentQueueAttempts(controller,projectId,claimed.claimId!)).length,2);
    const wrongActor=await workflow.execute({...controller,actorId:'other-controller'},{...reworkCommand,
      operationId:randomUUID(),runOperationId:randomUUID()});
    assert.equal(wrongActor.status==='rejected'?wrongActor.code:null,'QUEUE_ACTOR_MISMATCH');
    const continued=await workflow.execute(controller,reworkCommand);
    assert.equal(continued.status,'applied',JSON.stringify(continued));
    assert.deepEqual(await workflow.execute(controller,reworkCommand),continued);
    assert.equal((await workflow.listResidentQueueAttempts(controller,projectId,claimed.claimId!)).length,3);
    const permitted=(await workflow.getSessionRecovery(controller,projectId,sessionId)).gate!;
    assert.equal(permitted.phase,'reworking');assert.equal(permitted.retryRunId,reworkRunId);
    assert.equal(permitted.causeId,failed.id,'original failed Run remains the recovery cause');
    assert.equal(await trusted.canStartRecoveredRun(projectId,sessionId,randomUUID()),false);
    await assert.rejects(uow.transaction(projectId,tx=>tx.recovery!.assertStartupAllowed(sessionId,'message',randomUUID())),
      /recovery gate blocks startup/);
    const extraOp=randomUUID();
    const extra=await workflow.execute(controller,{...reworkCommand,operationId:extraOp,runOperationId:extraOp,
      runId:randomUUID()});
    assert.equal(extra.status==='rejected'?extra.code:null,'SESSION_RECOVERY_REQUIRED');
    await trusted.beginDispatch(projectId,reworkRunId);
    if(scenario==='rework-unknown')await trusted.markRunUnknown(projectId,reworkRunId,'Native result unresolved');
    else{
      await trusted.bindTurn(projectId,reworkRunId,{id:`${scenario}-turn`,status:'inProgress'},
        {kind:'startReply',operationId:reworkOperationId});
      await trusted.recordTurn(projectId,reworkRunId,`${scenario}-turn`,
        scenario==='rework-completed'?'completed':'failed','Controlled rework outcome');
    }
    const outcome=(await workflow.getSessionRecovery(controller,projectId,sessionId)).gate!;
    assert.equal(outcome.phase,scenario==='rework-completed'?'awaiting_acceptance':'blocked');
    if(scenario!=='rework-completed')assert.equal(outcome.causeId,reworkRunId);
    await queuePump.tick();
    assert.equal((await workflow.getResidentQueue(controller,projectId,queueId)).entries[1]?.state,'queued',
      'dependent Task stays behind the unaccepted original claim');
    assert.equal((await workflow.listResidentQueueAttempts(controller,projectId,claimed.claimId!)).length,3);
    return;
  }
  const fake=new FakeManagedRuntime(lostReply);
  let ordinaryApp:Awaited<ReturnType<typeof buildServer>>|null=null;
  let ordinaryIntent:Record<string,unknown>|null=null;
  const ordinaryPath=`/api/projects/${projectId}/ordinary-runs`;
  const workerToken='w'.repeat(40),leadToken='l'.repeat(40);
  if(scenario==='normal'){
    const ordinary=new OrdinaryRunSubmissionService(pool,uow);
    ordinaryApp=await buildServer({service:workflow,ordinarySubmissions:ordinary,
      credentials:[{token:workerToken,actorId:businessActor,projectIds:[projectId],permissions:['read','write']},
        {token:leadToken,actorId:controller.actorId,projectIds:[projectId],permissions:['read','write','review']}]});
    const intent={projectId,operationId:randomUUID(),submissionId:randomUUID(),deliveryOperationId:randomUUID(),
      runId:runBefore.id,taskId,sessionId,taskRevisionId:runBefore.taskRevisionId,runInputHash:runBefore.inputHash,
      deliveryIntent:{artifactRef:'fixture:ordinary-artifact',artifactRevision:'fixed-v1',contentHash:hash('ordinary-artifact'),
        technicalResult:'passed',technicalEvidence:'Fixed artifact inspected',reason:'Business Session result'}};
    ordinaryIntent=intent;
    fake.onStart=async()=>{
      const send=(token:string,payload:unknown)=>ordinaryApp!.inject({method:'POST',url:`${ordinaryPath}/submissions`,
        headers:{authorization:`Bearer ${token}`},payload});
      const wrong=await send(leadToken,intent);
      assert.equal(wrong.statusCode,403,wrong.body);
      const signed=await send(workerToken,intent);
      assert.equal(signed.statusCode,200,signed.body);
      assert.equal(signed.json().submittedBy,businessActor);
      // Recover a lost HTTP response using the same operation, without a second intent.
      const recovered=await ordinaryApp!.inject({url:`${ordinaryPath}/operations/${intent.operationId}`,
        headers:{authorization:`Bearer ${workerToken}`}});
      assert.equal(recovered.statusCode,200,recovered.body);
      assert.equal(recovered.json().submission.commandHash.length,64);
      assert.equal((await send(workerToken,{...intent,deliveryIntent:{...intent.deliveryIntent,reason:'changed'}})).statusCode,409);
    };
  }
  const makeRunner=()=>new RuntimeRunner({runtimeFactory:()=>fake as unknown as RuntimePort & FakeManagedRuntime,
    workflow,trusted,principals:[controller],canWrite:()=>true,allowedCwd:async()=>true,hasGrant:()=>true,
    cliEntryForRun:async()=>({command:'/private/fixture-cli',actorId:businessActor})});
  const runner=makeRunner();
  try{
    await runner.start();
    assert.equal(fake.starts.length,1,JSON.stringify(runner.status(projectId)));
    const nativeStart=fake.starts[0]!;
    assert.equal(nativeStart.binding.sessionId,sessionId);
    assert.equal(nativeStart.binding.nativeThreadId,nativeThreadId);
    assert.equal(nativeStart.binding.resumeProfile?.actorId,controller.actorId);
    assert.equal(nativeStart.operationId,attempt.operationId);
    assert.match(nativeStart.input,new RegExp(`^\\[evoloop-run-operation:${attempt.operationId}\\]`));
    assert.match(nativeStart.input,/# 任务：Build fixed artifact/);
    assert.match(nativeStart.input,new RegExp(`/private/fixture-cli handoff ${runBefore.id}`));
    const handoff=JSON.parse(runBefore.input);
    assert.equal(handoff.protocol,'evoloop-run-v2');
    assert.equal(handoff.channel.discussionId,channel.id);
    const inputPath=`/api/projects/${projectId}/runtime/runs/${runBefore.id}/input`;
    const pages={get:async(path:string)=>{
      const url=new URL(path,'http://local');
      assert.equal(url.pathname,inputPath);
      return runInputPage(await workflow.getRuntimeRun(controller,projectId,runBefore.id),
        Number(url.searchParams.get('cursor')),Number(url.searchParams.get('limit')));
    }};
    const directory=await mkdtemp(join(tmpdir(),'evoloop-fixed-run-input-'));
    try{
      const exported=join(directory,'run-input.txt');
      const receipt=await materialRunInput(pages as never,projectId,runBefore.id,runBefore.inputHash,0,31,exported);
      assert.equal(receipt.status,'exported');
      const exact=await readFile(exported,'utf8');
      assert.equal(exact,runBefore.input);
      assert.equal(hash(exact),runBefore.inputHash);
      assert.equal(JSON.parse(exact).channel.discussionId,channel.id);
    }finally{await rm(directory,{recursive:true,force:true});}
    let settledRunner=runner;
    if(lostReply){
      const unknown=await workflow.getRuntimeRun(controller,projectId,attempt.runId);
      assert.equal(unknown.state,'unknown');
      assert.equal(unknown.nativeTurnId,null);
      await queuePump.tick();
      assert.equal((await workflow.getResidentQueue(controller,projectId,queueId)).entries[0]?.state,'claimed');
      assert.equal((await workflow.listResidentQueueAttempts(controller,projectId,claimed.claimId!)).length,1);
      await runner.stop();
      settledRunner=makeRunner();
    }
    try{
      if(lostReply)await settledRunner.start();
      assert.deepEqual(settledRunner.status(projectId).faults,[]);
      const completed=await workflow.getRuntimeRun(controller,projectId,attempt.runId);
      assert.equal(completed.state,'completed');
      assert.equal(completed.nativeTurnId,'fake-turn-1');
      assert.match(completed.resultSummary??'',/Fixed Task result/);
      assert.equal((await pool.query(`SELECT 1 FROM outbox_event WHERE project_id=$1 AND operation_id=$2
        AND kind='runtime.run.completed'`,[projectId,attempt.operationId])).rowCount,1);
      if(scenario==='normal'){
        assert.ok(ordinaryIntent);
        // A fresh service and pump simulate recovery after coordinator restart.
        const ordinary=new OrdinaryRunSubmissionService(pool,uow);
        const originalSubmission=(await ordinary.readSubmission(projectId,runBefore.id))!;
        let submissionLease=true;
        const fencedSubmission=new OrdinaryRunSubmissionService(pool,uow,()=>submissionLease);
        const admissionLock=await pool.connect();
        try{
          await admissionLock.query('BEGIN');
          await admissionLock.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[projectId]);
          const pending=fencedSubmission.updateSubmission({...originalSubmission,state:'blocked',reason:'test fence',
            version:originalSubmission.version+1},originalSubmission.version);
          let waiting=false;
          for(let i=0;i<100;i++){
            const activity=await pool.query(`SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock'
              AND query LIKE 'SELECT pg_advisory_xact_lock(hashtextextended%' AND pid<>pg_backend_pid()`);
            if(activity.rowCount){waiting=true;break;}
            await new Promise(resolve=>setTimeout(resolve,10));
          }
          assert.equal(waiting,true,'submission write must be waiting on the project lock');
          submissionLease=false;
          await admissionLock.query('COMMIT');
          await assert.rejects(pending,{code:'LEASE_LOST'});
          assert.equal((await ordinary.readSubmission(projectId,runBefore.id))?.state,'submitted');
        }finally{admissionLock.release();}
        let signerAuthorized=true, dropCommittedRead=true;
        const sealWorkflow=new WorkflowService({uow:leaseCheckedUnitOfWork(uow,()=>true),
          clock:{now:()=>new Date().toISOString()},ids:{next:randomUUID},hasher:{hash}});
        const seal=new OrdinaryRunSealPump({canWrite:()=>true,listProjects:()=>ordinary.listUnsettledProjects(),
          listUnsettled:(p,limit,after)=>ordinary.listUnsettled(p,limit,after),
          seal:(p,r)=>createOrdinaryRunSealer({readSubmission:(p,r)=>ordinary.readSubmission(p,r),
            updateSubmission:(next,expected)=>ordinary.updateSubmission(next,expected),
            readRun:(p,r)=>ordinary.readRun(p,r),readDelivery:(p,d)=>ordinary.readDelivery(p,d),
            readDeliveryOperation:async s=>{
              const operation=await ordinary.readDeliveryOperation(s);
              if(operation&&dropCommittedRead){dropCommittedRead=false;throw new Error('committed reply/read lost');}
              return operation;
            },
            resolveSubmittedActor:async()=>signerAuthorized?
              {actorId:businessActor,projectIds:[projectId],permissions:['read','write']}:null,
            workflow:sealWorkflow,sealer:{actorId:'system:ordinary-run-sealer',projectIds:[projectId],permissions:['read','write','review']},
            now:()=>new Date().toISOString(),canWrite:()=>true})(p,r)});
        await seal.cycle();
        assert.equal((await ordinary.readSubmission(projectId,runBefore.id))?.state,'unknown');
        assert.equal((await workflow.getTask(controller,projectId,taskId)).deliveries?.length,1,
          'the Delivery committed before its read response was lost');
        signerAuthorized=false;
        await seal.cycle();
        const signed=await ordinary.readSubmission(projectId,runBefore.id);
        assert.equal(signed?.state,'sealed',seal.status().lastError??'');
        await assert.rejects(ordinary.readDeliveryOperation({...signed!,deliveryOperationId:randomUUID()}),
          {code:'SUBMISSION_CONFLICT'},'internal history read stays bound to the original operation');
        assert.equal(signed.terminalRunVersion,completed.version);
        const detail=await workflow.getTask(controller,projectId,taskId);
        assert.equal(detail.deliveries?.length,1);
        const delivery=detail.deliveries![0]!;
        assert.equal(delivery.id,signed.deliveryId);
        assert.equal(delivery.submittedByActorId,businessActor);
        assert.equal(delivery.sourceRunVersion,completed.version);
        const hold=await pool.connect();
        let locked=false;
        try{
          await hold.query('BEGIN');
          await hold.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[projectId]);
          locked=true;
          let leaseHeld=true;
          const fencedWorkflow=new WorkflowService({uow:leaseCheckedUnitOfWork(uow,()=>leaseHeld),
            clock:{now:()=>new Date().toISOString()},ids:{next:randomUUID},hasher:{hash}});
          const blockedOperation=randomUUID(),blockedDocument=randomUUID();
          const pending=fencedWorkflow.execute(controller,{type:'document.create',projectId,
            operationId:blockedOperation,documentId:blockedDocument,title:'Must not start',body:'Lease lost while waiting'});
          let waiting=false;
          for(let i=0;i<100;i++){
            const activity=await pool.query(`SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock'
              AND query LIKE 'SELECT pg_advisory_xact_lock(hashtextextended%' AND pid<>pg_backend_pid()`);
            if(activity.rowCount){waiting=true;break;}
            await new Promise(resolve=>setTimeout(resolve,10));
          }
          assert.equal(waiting,true,'Delivery transaction must be waiting on the project lock before lease loss');
          leaseHeld=false;
          await hold.query('COMMIT');locked=false;
          await assert.rejects(pending,{code:'LEASE_LOST'});
          assert.equal(await uow.read(projectId,reader=>reader.getOperation(blockedOperation)),null);
          assert.equal(await uow.read(projectId,reader=>reader.getDocument(blockedDocument)),null);
        }finally{if(locked)await hold.query('ROLLBACK');hold.release();}
        await seal.cycle();
        assert.equal((await workflow.getTask(controller,projectId,taskId)).deliveries?.length,1);
        const replay=await ordinaryApp!.inject({method:'POST',url:`${ordinaryPath}/submissions`,
          headers:{authorization:`Bearer ${workerToken}`},payload:ordinaryIntent});
        assert.equal(replay.statusCode,200,replay.body);
        assert.equal(replay.json().submissionId,signed.id);
        const used=await workflow.execute(controller,{type:'observation.record',projectId,operationId:randomUUID(),
          taskId,deliveryId:delivery.id,observer:controller.actorId,observerKind:'agent',result:'used',
          evidence:'Independent consumer inspected the fixed artifact',reason:'Use confirmed'});
        assert.equal(used.status,'applied',JSON.stringify(used));
        const current=(await workflow.getTask(controller,projectId,taskId)).task;
        const closed=await workflow.execute(controller,{type:'task.close',projectId,operationId:randomUUID(),taskId,
          expectedVersion:current.version,deliveryId:delivery.id,acceptanceResult:'met',
          acceptanceEvidence:'Independent consumer used the fixed artifact',reason:'Accepted'});
        assert.equal(closed.status,'applied',JSON.stringify(closed));
        await queuePump.tick();
        assert.equal((await workflow.getResidentQueue(controller,projectId,queueId)).entries[0]?.state,'released');
      }
      await settledRunner.pump();
      await queuePump.tick();
      assert.equal(fake.starts.length,1,'a settled Run never starts a second native Turn');
      assert.equal((await workflow.listResidentQueueAttempts(controller,projectId,claimed.claimId!)).length,1);
    }finally{if(settledRunner!==runner)await settledRunner.stop();}
  }finally{await runner.stop();await ordinaryApp?.close();}
});
