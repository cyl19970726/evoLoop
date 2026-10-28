import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import pg from 'pg';
import { migrate, PostgresUnitOfWork } from '../src/index.ts';
import { RuntimeWorkflowService, WorkflowService } from '@evoloop/core';
import { SessionMessageService } from '@evoloop/core/session-messages';
import type { RuntimeBinding, RuntimePage, RuntimeSessionSpec, RuntimeTurn } from '@evoloop/contracts/runtime';
import { RuntimeRunner } from '../../../apps/coordinator/src/runtime/runner.ts';
import { SessionMessagePump } from '../../../apps/coordinator/src/session-messages/pump.ts';
import { sessionMessageCanStart } from '../../../apps/coordinator/src/session-messages/scheduling.ts';
import { ResidentQueuePump } from '../../../apps/coordinator/src/resident-queue/pump.ts';
import { canonicalTaskInputJson, taskInputSignature } from '../../core/src/task-input.ts';

const url=process.env.TEST_DATABASE_URL;
if(!url||!/^evoloop(?:_[a-z0-9]+)*_test$/.test(decodeURIComponent(new URL(url).pathname.slice(1))))
  throw new Error('Conversation queue integration requires a dedicated evoLoop test database');
const schema=`el_conversation_queue_${randomUUID().replaceAll('-','').slice(0,12)}`;
const pool=new pg.Pool({connectionString:url,options:`-c search_path=${schema}`});
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const clock={now:()=>new Date().toISOString()},ids={next:randomUUID};
const project=randomUUID(),role=randomUUID(),roleRevision=randomUUID(),session=randomUUID();
const taskA=randomUUID(),taskB=randomUUID(),queueId=randomUUID(),entryA=randomUUID(),entryB=randomUUID(),messageId=randomUUID();
const cwd='/tmp/evoloop-conversation-queue-fixture';
const lead={actorId:'lead',projectIds:[project],permissions:['read','write','review'] as Array<'read'|'write'|'review'>};
const sender={actorId:'sender',projectIds:[project],permissions:['read','write','review'] as Array<'read'|'write'|'review'>};
const uow=new PostgresUnitOfWork(pool,{grant:async()=>true,binding:async()=>true,lead:async()=>true,
  input:async(reader,taskId)=>canonicalTaskInputJson(await taskInputSignature(reader,(await reader.getTask(taskId))!))});
const workflow=new WorkflowService({uow,clock,ids,hasher:{hash},
  collaborationAuthority:{actorForRole:async()=> 'worker',isAuthorizedRoleActor:async()=>true,
    isProjectActor:async()=>true,hasEngineeringActionGrant:async()=>false}});
const trusted=new RuntimeWorkflowService({uow,clock,ids});
const messages=new SessionMessageService({uow,clock,ids,grantFor:async()=>({projectId:project,sessionId:session,
  senderActorId:'sender',receiverRoleId:role,receiverActorId:'lead',cwd,maxTurns:2,enabled:true})});

class FakeFullNative {
  readonly starts:Array<{kind:'run'|'message';operationId:string;threadId:string;input:string}>=[];
  readonly turns=new Map<string,{turn:RuntimeTurn;input:string;kind:'run'|'message'}>();
  readonly bindings=new Map<string,RuntimeBinding>();
  private ready=false;
  async open(){this.ready=true;}
  async close(){this.ready=false;}
  isReady(){return this.ready;}
  onDisconnect(){return()=>{};}
  onApprovalRequest(){return()=>{};}
  onEvent(){return()=>{};}
  async create(spec:RuntimeSessionSpec):Promise<RuntimeBinding>{
    assert.equal(spec.sandbox,'danger-full-access');assert.equal(spec.approvalPolicy,'never');
    const binding:RuntimeBinding={projectId:spec.projectId,sessionId:spec.sessionId,roleId:spec.roleId,
      cwd:spec.cwd,authorizationScope:spec.authorizationScope,nativeThreadId:`fake-thread-${spec.sessionId}`,
      nativeSessionId:`fake-thread-${spec.sessionId}`,owner:'evoloop-codex-app-server',
      resumeProfile:{actorId:spec.actorId,model:spec.model??null,sandbox:spec.sandbox,
        approvalPolicy:spec.approvalPolicy,...(spec.executionProfileRevisionId?
          {executionProfileRevisionId:spec.executionProfileRevisionId}:{})}};
    this.bindings.set(binding.nativeThreadId,binding);return binding;
  }
  async registerBinding(binding:RuntimeBinding){await trusted.verifyBinding(binding.projectId,binding);
    this.bindings.set(binding.nativeThreadId,binding);}
  async inspect(binding:RuntimeBinding){this.owned(binding);return{id:binding.nativeThreadId};}
  async resume(binding:RuntimeBinding,spec:RuntimeSessionSpec){this.owned(binding);
    assert.equal(spec.sandbox,'danger-full-access');assert.equal(spec.approvalPolicy,'never');return binding;}
  private owned(binding:RuntimeBinding){assert.deepEqual(this.bindings.get(binding.nativeThreadId),binding);}
  private active(){return [...this.turns.values()].some(value=>!value.turn.completedAtUtc);}
  async qualifyConversationThread(binding:RuntimeBinding){this.owned(binding);
    assert.equal(binding.resumeProfile?.sandbox,'danger-full-access');assert.equal(binding.resumeProfile?.approvalPolicy,'never');
    return this.active()?{available:false,reason:'fake Thread active',fingerprint:null}:
      {available:true,reason:'fixture full profile',fingerprint:hash(`full:${binding.nativeThreadId}`)};}
  private start(kind:'run'|'message',binding:RuntimeBinding,input:string,operationId:string):RuntimeTurn{
    this.owned(binding);assert.equal(this.active(),false,'single native Thread writer');
    assert.equal(this.starts.some(start=>start.operationId===operationId),false,'original operation starts once');
    const turn:RuntimeTurn={id:`fake-turn-${this.starts.length+1}`,status:'inProgress',completedAtUtc:null};
    this.starts.push({kind,operationId,threadId:binding.nativeThreadId,input});
    this.turns.set(turn.id,{turn,input,kind});return turn;
  }
  async startTurn(binding:RuntimeBinding,input:string,operationId:string){return this.start('run',binding,input,operationId);}
  async startConversationTurn(binding:RuntimeBinding,input:string,operationId:string){
    assert.match(input,/normal tools and full execution permissions/);return this.start('message',binding,input,operationId);}
  complete(id:string){const saved=this.turns.get(id);assert.ok(saved);saved.turn={...saved.turn,status:'completed',completedAtUtc:clock.now()};}
  async listTurns(binding:RuntimeBinding):Promise<RuntimePage<RuntimeTurn>>{this.owned(binding);
    return{data:[...this.turns.values()].map(value=>value.turn).reverse(),nextCursor:null};}
  async listItems(binding:RuntimeBinding,turnId:string):Promise<RuntimePage<unknown>>{this.owned(binding);
    const saved=this.turns.get(turnId);assert.ok(saved);
    return{data:[{id:`user-${turnId}`,type:'userMessage',text:saved.input},
      {id:`answer-${turnId}`,type:'agentMessage',phase:'final_answer',text:saved.kind==='message'?'Fixture answer M':'Fixture Task result'}],
      nextCursor:null};}
  async interruptTurn(){throw new Error('fixture interruption is not part of this path');}
}

before(async()=>{await migrate(url!,schema);});
after(async()=>{await pool.end();const client=new pg.Client({connectionString:url});await client.connect();
  try{await client.query(`DROP SCHEMA "${schema}" CASCADE`);}finally{await client.end();}});

test('one full Session executes A, queues M while busy, records its reply, and auto releases accepted A before B',async t=>{
  const apply=async(command:Parameters<typeof workflow.execute>[1])=>{
    const result=await workflow.execute(lead,command);assert.equal(result.status,'applied',JSON.stringify(result));return result;};
  await apply({type:'project.create',projectId:project,operationId:randomUUID(),title:'Full conversation queue fixture'});
  const roleClient=await pool.connect();try{await roleClient.query('BEGIN');
    await roleClient.query(`INSERT INTO role_definition(project_id,role_id,version,current_revision_id,state,proposed_by,created_at_utc,review_at_utc,trial_started_at_utc)
      VALUES($1,$2,1,$3,'trial','lead',now(),now()+interval '1 day',now())`,[project,role,roleRevision]);
    await roleClient.query(`INSERT INTO role_revision(project_id,role_id,revision_id,version,state,proposal,actor_id,reason,created_at_utc,review_at_utc)
      VALUES($1,$2,$3,1,'trial','{}'::jsonb,'lead','fixture',now(),now()+interval '1 day')`,[project,role,roleRevision]);
    await roleClient.query('COMMIT');
  }catch(error){await roleClient.query('ROLLBACK');throw error;}finally{roleClient.release();}
  for(const [taskId,title] of [[taskA,'A'],[taskB,'B']] as const){
    await apply({type:'task.create',projectId:project,operationId:randomUUID(),taskId,title,
      content:`# ${title}`,acceptance:'Consumer uses fixed result',owner:role});
    await apply({type:'task.start',projectId:project,operationId:randomUUID(),taskId,expectedVersion:1,reason:'Fix input'});
  }
  await apply({type:'runtime.session.reserve',projectId:project,operationId:randomUUID(),sessionId:session,
    roleId:role,cwd,authorizationScope:'project',sandbox:'danger-full-access',approvalPolicy:'never'});
  const native=new FakeFullNative();
  const runner=new RuntimeRunner({runtimeFactory:()=>native,workflow,trusted,principals:[lead],canWrite:()=>true,
    allowedCwd:async()=>true,hasGrant:async()=>true,
    cliEntryForRun:async()=>({command:'/private/fixture-cli',actorId:'worker'})});
  t.after(()=>runner.stop());
  await runner.start();
  const ready=await workflow.getRuntimeSession(lead,project,session);
  assert.equal(ready.state,'ready');assert.equal(ready.sandbox,'danger-full-access');assert.equal(ready.approvalPolicy,'never');
  await pool.query(`INSERT INTO role_session_binding(project_id,binding_id,role_id,session_id,role_revision_id,actor_id,note,created_at_utc)
    VALUES($1,$2,$3,$4,$5,'lead','owned',now())`,[project,randomUUID(),role,session,roleRevision]);
  const currentA=(await workflow.getTask(lead,project,taskA)).task;
  const currentB=(await workflow.getTask(lead,project,taskB)).task;
  await apply({type:'queue.create',projectId:project,operationId:randomUUID(),queueId,maxRuns:2,reason:'A then B',entries:[
    {id:entryA,taskId:taskA,taskRevisionId:currentA.currentRevisionId,sessionId:session,roleId:role,
      dependsOn:[],consumerId:'lead',useRequired:true,releaseRule:'accepted'},
    {id:entryB,taskId:taskB,taskRevisionId:currentB.currentRevisionId,sessionId:session,roleId:role,
      dependsOn:[entryA],consumerId:'lead',useRequired:false,releaseRule:'accepted'}]});
  await apply({type:'queue.adopt',projectId:project,operationId:randomUUID(),queueId,expectedVersion:1});
  const queuePump=new ResidentQueuePump({workflow,credentials:async()=>[lead],enabled:async()=>true,
    canWrite:()=>true,pollIntervalMs:2000,messageBusy:(p,s)=>messages.isBusy(p,s),onError:error=>{throw error;}});
  await queuePump.tick();
  let queue=await workflow.getResidentQueue(lead,project,queueId);
  assert.equal(queue.entries[0]?.state,'claimed');assert.equal(queue.entries[1]?.state,'queued');
  const claim=queue.entries[0]!.claimId!;
  const firstAttempt=(await workflow.listResidentQueueAttempts(lead,project,claim))[0]!;
  await runner.pump();
  assert.equal((await workflow.getRuntimeRun(lead,project,firstAttempt.runId)).state,'running',JSON.stringify(runner.status(project)));
  assert.equal(native.starts.length,1);assert.equal(native.starts[0]?.kind,'run');
  const messagePost=await workflow.execute(sender,{type:'session.message.post',projectId:project,
    operationId:randomUUID(),messageId,target:{kind:'owned',sessionId:session},content:'Please clarify A now'});
  assert.equal(messagePost.status,'applied',JSON.stringify(messagePost));
  const messagePump=new SessionMessagePump({service:messages,runtime:()=>runner.nativeAdapter(),projects:async()=>[project],
    canWrite:()=>true,pollIntervalMs:2000,
    canStart:sessionMessageCanStart({workflow,service:messages,principals:async()=>[lead],onError:error=>{throw error;}}),
    onError:error=>{throw error;}});
  await messagePump.tick();
  assert.equal((await messages.get(project,messageId)).state,'queued');assert.equal(native.starts.length,1);
  native.complete([...native.turns.keys()][0]!);
  await runner.pump();
  assert.equal((await workflow.getRuntimeRun(lead,project,firstAttempt.runId)).state,'completed');
  await messagePump.tick();
  assert.equal((await messages.detail(project,messageId)).processing?.state,'running');
  assert.equal(native.starts[1]?.kind,'message');assert.equal(native.starts[1]?.threadId,native.starts[0]?.threadId);
  await queuePump.tick();
  assert.equal((await workflow.getResidentQueue(lead,project,queueId)).entries[0]?.state,'claimed',
    'ordinary reply cannot release a Task claim');
  native.complete([...native.turns.keys()][1]!);await messagePump.tick();
  const replied=await messages.detail(project,messageId);
  assert.equal(replied.message.state,'replied');assert.equal(replied.processing?.response,'Fixture answer M');
  await apply({type:'session.message.receipt',projectId:project,operationId:randomUUID(),messageId,
    stage:'read',evidence:'Fixture recipient read the original M'});
  assert.equal((await messages.get(project,messageId)).readReceipt?.actorId,'lead');
  assert.equal((await workflow.getTask(lead,project,taskA)).task.state,'in_progress');
  await queuePump.tick();
  assert.equal((await workflow.getResidentQueue(lead,project,queueId)).entries[1]?.state,'queued');
  const afterRun=(await workflow.getTask(lead,project,taskA)).task;
  const delivery=await apply({type:'delivery.record',projectId:project,operationId:randomUUID(),taskId:taskA,
    runId:firstAttempt.runId,expectedVersion:afterRun.version,artifactRef:'fixture:task-a',artifactRevision:'v1',
    contentHash:hash('A fixed result'),technicalResult:'passed',technicalEvidence:'Fixture native Run settled',reason:'Deliver A'});
  await queuePump.tick();assert.equal((await workflow.getResidentQueue(lead,project,queueId)).entries[0]?.state,'claimed');
  await apply({type:'observation.record',projectId:project,operationId:randomUUID(),taskId:taskA,
    deliveryId:delivery.revisionId!,observer:'lead',observerKind:'agent',result:'used',
    evidence:'Fixture consumer explicitly used A',reason:'A informed next step'});
  await queuePump.tick();assert.equal((await workflow.getResidentQueue(lead,project,queueId)).entries[0]?.state,'claimed');
  const beforeClose=(await workflow.getTask(lead,project,taskA)).task;
  await apply({type:'task.close',projectId:project,operationId:randomUUID(),taskId:taskA,
    expectedVersion:beforeClose.version,deliveryId:delivery.revisionId!,acceptanceResult:'met',
    acceptanceEvidence:'Fixture observed use',reason:'A accepted'});
  await queuePump.tick();
  queue=await workflow.getResidentQueue(lead,project,queueId);
  assert.equal(queue.entries[0]?.state,'released');assert.equal(queue.entries[1]?.state,'queued');
  assert.equal((await pool.query('SELECT release_kind FROM resident_queue_claim WHERE project_id=$1 AND claim_id=$2',
    [project,claim])).rows[0]?.release_kind,'accepted');
  await queuePump.tick();
  queue=await workflow.getResidentQueue(lead,project,queueId);
  assert.equal(queue.entries[1]?.state,'claimed','B is automatically claimed after accepted A release');
  const secondAttempt=(await workflow.listResidentQueueAttempts(lead,project,queue.entries[1]!.claimId!))[0]!;
  await runner.pump();
  assert.equal((await workflow.getRuntimeRun(lead,project,secondAttempt.runId)).state,'running');
  assert.equal(native.starts[2]?.kind,'run');assert.equal(native.starts[2]?.threadId,native.starts[0]?.threadId);
  assert.equal(native.starts.length,3);
});
