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
    this.turn={id:'fake-turn-1',status:'completed',completedAtUtc:new Date().toISOString()};
    if(this.unknownStartOnce){this.unknownStartOnce=false;throw new Error('native start reply lost after Turn was created');}
    return {id:this.turn.id,status:'inProgress'};
  }
  async interruptTurn(){throw new Error('No interrupt expected');}
}

for(const lostReply of [false,true]) test(lostReply ?
  'queue native start reply unknown survives runner restart and reconciles original Run without another start' :
  'queue native start reply binds and settles original Run on its original Session',async t=>{
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
  await apply({type:'queue.create',projectId,operationId:randomUUID(),queueId,maxRuns:1,
    reason:'One bounded smoke Run',entries:[{id:entryId,taskId,taskRevisionId:task.currentRevisionId,
      sessionId,roleId,dependsOn:[],consumerId:controller.actorId,useRequired:true,releaseRule:'accepted'}]});
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
  const journal=await pool.query('SELECT command_type FROM operation_journal WHERE project_id=$1 AND operation_id=$2',
    [projectId,attempt.operationId]);
  assert.equal(journal.rows[0]?.command_type,'queue.claim');
  assert.equal((await pool.query(`SELECT 1 FROM outbox_event WHERE project_id=$1 AND operation_id=$2
    AND kind='runtime.run.requested'`,[projectId,attempt.operationId])).rowCount,1);
  const channel=(await workflow.listDiscussions(controller,projectId)).items.find(x=>x.collaboration?.runId===attempt.runId)!;
  assert.equal(channel?.collaboration?.recipientActorId,businessActor);
  const fake=new FakeManagedRuntime(lostReply);
  const makeRunner=()=>new RuntimeRunner({runtimeFactory:()=>fake as unknown as RuntimePort & FakeManagedRuntime,
    workflow,trusted,principals:[controller],canWrite:()=>true,allowedCwd:async()=>true,hasGrant:()=>true});
  const runner=makeRunner();
  try{
    await runner.start();
    assert.equal(fake.starts.length,1);
    const nativeStart=fake.starts[0]!;
    assert.equal(nativeStart.binding.sessionId,sessionId);
    assert.equal(nativeStart.binding.nativeThreadId,nativeThreadId);
    assert.equal(nativeStart.binding.resumeProfile?.actorId,controller.actorId);
    assert.equal(nativeStart.operationId,attempt.operationId);
    assert.match(nativeStart.input,new RegExp(`^\\[evoloop-run-operation:${attempt.operationId}\\]`));
    assert.match(nativeStart.input,/# Fixed scope/);
    assert.match(nativeStart.input,/Produce one test artifact/);
    const handoff=JSON.parse(nativeStart.input.split('\n')[1]!) as {runInstructionRead:{inputHash:string;requiredBeforeAction:boolean;path:string}};
    assert.equal(handoff.runInstructionRead.inputHash,runBefore.inputHash);
    assert.equal(handoff.runInstructionRead.requiredBeforeAction,true);
    assert.equal(handoff.runInstructionRead.path,`/api/projects/${projectId}/runtime/runs/${runBefore.id}/input`);
    assert.match(nativeStart.input,/Before acting.*complete exact Run instruction/);
    const pages={get:async(path:string)=>{
      const url=new URL(path,'http://local');
      assert.equal(url.pathname,handoff.runInstructionRead.path);
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
      assert.match(exact,new RegExp(`Task channel ${channel.id}`));
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
      await settledRunner.pump();
      await queuePump.tick();
      assert.equal(fake.starts.length,1,'a settled Run never starts a second native Turn');
      assert.equal((await workflow.listResidentQueueAttempts(controller,projectId,claimed.claimId!)).length,1);
    }finally{if(settledRunner!==runner)await settledRunner.stop();}
  }finally{await runner.stop();}
});
