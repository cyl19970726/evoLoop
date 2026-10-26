import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import pg from 'pg';
import { migrate } from '../src/index.ts';
import { PgResidentQueue } from '../src/queues.ts';
import { PostgresUnitOfWork } from '../src/index.ts';
import { RuntimeWorkflowService, WorkflowService } from '@evoloop/core';
import { queueCommandSchema } from '@evoloop/contracts/queues';
import { canonicalTaskInputJson, taskInputSignature } from '../../core/src/task-input.ts';
import { reserveRuntime } from '../../core/src/runtime/reserve.ts';
import { ResidentQueuePump, queueIntentId } from '../../../apps/coordinator/src/resident-queue/pump.ts';
import { loopIntentId } from '../../../apps/coordinator/src/orchestration/runner.ts';
import type { Reader, Transaction, UnitOfWork } from '@evoloop/contracts/ports';
import { createHash } from 'node:crypto';
const url=process.env.TEST_DATABASE_URL;
if(!url || !/^\/evoloop(?:_[a-z0-9]+)*_test$/i.test(new URL(url).pathname)) throw new Error('dedicated evoloop_*_test database required');
const schema=`el_queue_${randomUUID().replaceAll('-','').slice(0,16)}`;
const pool=new pg.Pool({connectionString:url,options:`-c search_path=${schema}`});
const uow=new PostgresUnitOfWork(pool);
const hash=(text:string)=>createHash('sha256').update(text).digest('hex');
const workflow=new WorkflowService({uow,clock:{now:()=>new Date().toISOString()},ids:{next:randomUUID},hasher:{hash}});
const runtime=new RuntimeWorkflowService({uow,clock:{now:()=>new Date().toISOString()},ids:{next:randomUUID}});
const projectId=randomUUID();const queueId=randomUUID();
async function withExecutionProfile(projectId:string,sessionId:string,binding:Parameters<RuntimeWorkflowService['bindSession']>[2]){
  const saved=(await uow.read(projectId,reader=>reader.getRuntimeSession(sessionId)))!;
  return {...binding,resumeProfile:{actorId:saved.actorId,model:saved.model,sandbox:saved.sandbox,
    approvalPolicy:saved.approvalPolicy,executionProfileRevisionId:saved.executionProfile!.revision.revisionId}};
}

async function withWriteFault(table:'resident_queue_claim'|'resident_queue_entry'|'runtime_run'|'process_document'|'outbox_event'|'delivery',
  event:'INSERT'|'UPDATE',action:()=>Promise<void>):Promise<void>{
  const name=`queue_fault_${randomUUID().replaceAll('-','')}`;
  await pool.query(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected queue write fault'; END $$`);
  await pool.query(`CREATE TRIGGER ${name} BEFORE ${event} ON ${table} FOR EACH ROW EXECUTE FUNCTION ${name}()`);
  try{await action();}finally{
    await pool.query(`DROP TRIGGER ${name} ON ${table}`);
    await pool.query(`DROP FUNCTION ${name}()`);
  }
}
const leader=async()=>true;const grant=async()=>true;const binding=async()=>true;const input=async()=>'{\"fixed\":true}';
before(async()=>{
  await migrate(url,schema);
  await pool.query('INSERT INTO project(project_id,title,created_at) VALUES($1,$2,now())',[projectId,'Queue test']);
});
after(async()=>{await pool.end();const c=new pg.Client({connectionString:url});await c.connect();try{await c.query(`DROP SCHEMA "${schema}" CASCADE`);}finally{await c.end();}});
test('unadopted version is held and adoption is CAS',async()=>{
  const client=await pool.connect();try{await client.query('BEGIN');const store=new PgResidentQueue(client,projectId,grant,input,leader,binding);
    await store.createResidentQueue({projectId,id:queueId,version:1,adoptedVersion:null,maxRuns:2,reason:'ordered for value and dependency',actorId:'lead',entries:[]});
    assert.equal((await store.list(queueId))?.adoptedVersion,null);
    await store.adoptResidentQueue(queueId,1,'lead');
    assert.equal((await store.list(queueId))?.adoptedVersion,1);
    await assert.rejects(store.adoptResidentQueue(queueId,2,'lead'),/QUEUE_VERSION_CONFLICT/);
    assert.equal(await store.reorderResidentQueue(queueId,1,[],'lead','revisit order'),2);
    assert.equal((await store.list(queueId))?.adoptedVersion,null);
    await assert.rejects(store.reorderResidentQueue(queueId,1,[],'lead','stale order'),/QUEUE_VERSION_CONFLICT/);
    await client.query('COMMIT');
  }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
});

test('one intent survives duplicate dispatch and holds the Session after terminal Run',async()=>{
  const p=randomUUID(),task=randomUUID(),rev=randomUUID(),doc=randomUUID(),dr=randomUUID(),basis=randomUUID(),session=randomUUID(),role=randomUUID(),roleRev=randomUUID(),entry=randomUUID(),q=randomUUID();
  const setup=await pool.connect();try{
    await setup.query('BEGIN');
    await setup.query('INSERT INTO project(project_id,title,created_at) VALUES($1,$2,now())',[p,'Queue concurrency']);
    await setup.query(`INSERT INTO process_document(project_id,document_id,title,version,current_revision_id,adopted_revision_id,kind,status) VALUES($1,$2,'Task',1,$3,$3,'task','published')`,[p,doc,dr]);
    await setup.query(`INSERT INTO document_revision(project_id,document_id,revision_id,body,format,content_hash,author,created_at,reason,media_type,original_name,assets_manifest)
      VALUES($1,$2,$3,'# Task','markdown',repeat('a',64),'lead',now(),'fixed','text/markdown','task.md','[]'::jsonb)`,[p,doc,dr]);
    await setup.query(`INSERT INTO document_decision(project_id,decision_id,document_id,revision_id,actor_id,reason,created_at) VALUES($1,$2,$3,$4,'lead','adopt',now())`,[p,randomUUID(),doc,dr]);
    await setup.query(`INSERT INTO task(project_id,task_id,version,current_revision_id,title,acceptance,owner,state,kind,content_document_id,content_revision_id)
      VALUES($1,$2,1,$3,'Task','check',$6,'in_progress',NULL,$4,$5)`,[p,task,rev,doc,dr,role]);
    await setup.query(`INSERT INTO task_revision(project_id,task_id,revision_id,version,title,acceptance,owner,state,basis_set_id,actor_id,reason,created_at,kind,content_document_id,content_revision_id)
      VALUES($1,$2,$3,1,'Task','check',$7,'in_progress',$4,'lead','fixed',now(),NULL,$5,$6)`,[p,task,rev,basis,doc,dr,role]);
    await setup.query(`INSERT INTO basis_set(project_id,task_id,task_revision_id,basis_set_id,sealed) VALUES($1,$2,$3,$4,false)`,[p,task,rev,basis]);
    await setup.query(`INSERT INTO basis_member(project_id,task_id,task_revision_id,basis_set_id,document_id,document_revision_id) VALUES($1,$2,$3,$4,$5,$6)`,[p,task,rev,basis,doc,dr]);
    await setup.query(`UPDATE basis_set SET sealed=true WHERE project_id=$1 AND task_id=$2 AND basis_set_id=$3`,[p,task,basis]);
    await setup.query(`INSERT INTO runtime_session(project_id,session_id,role_id,cwd,authorization_scope,sandbox,approval_policy,state,version,native_thread_id,native_session_id,operation_id,actor_id,created_at,updated_at)
      VALUES($1,$2,$3,'/tmp/queue','project','read-only','on-request','ready',1,$4,$5,$6,'lead',now(),now())`,[p,session,role,'thread-'+session,'native-'+session,randomUUID()]);
    await setup.query(`INSERT INTO role_definition(project_id,role_id,version,current_revision_id,state,proposed_by,created_at_utc,review_at_utc,trial_started_at_utc)
      VALUES($1,$2,1,$3,'trial','lead',now(),now()+interval '1 day',now())`,[p,role,roleRev]);
    await setup.query(`INSERT INTO role_revision(project_id,role_id,revision_id,version,state,proposal,actor_id,reason,created_at_utc,review_at_utc)
      VALUES($1,$2,$3,1,'trial','{}'::jsonb,'lead','trial',now(),now()+interval '1 day')`,[p,role,roleRev]);
    await setup.query(`INSERT INTO role_session_binding(project_id,binding_id,role_id,session_id,role_revision_id,actor_id,note,created_at_utc)
      VALUES($1,$2,$3,$4,$5,'lead','owned',now())`,[p,randomUUID(),role,session,roleRev]);
    const store=new PgResidentQueue(setup,p,grant,input,leader,binding);await store.createResidentQueue({projectId:p,id:q,version:1,adoptedVersion:null,maxRuns:3,reason:'one bounded Task',actorId:'lead',entries:[{projectId:p,queueId:q,id:entry,taskId:task,taskRevisionId:rev,sourceInputJson:'{\"fixed\":true}',sessionId:session,roleId:role,position:0,dependsOn:[],consumerId:'consumer',useRequired:true,releaseRule:'accepted',state:'queued',holdCode:null,holdReason:null,claimId:null,version:1}]});await store.adoptResidentQueue(q,1,'lead');await store.reorderResidentQueue(q,1,[entry],'lead','new adopted order');await store.adoptResidentQueue(q,2,'lead');await store.holdResidentQueueEntry(q,entry,'manual_review','Lead review required');
    await setup.query('COMMIT');
  }catch(e){await setup.query('ROLLBACK');throw e;}finally{setup.release();}
  const ids={claimId:randomUUID(),runId:randomUUID(),operationId:randomUUID()};
  const a=await pool.connect(),b=await pool.connect();try{
    await a.query('BEGIN');const sa=new PgResidentQueue(a,p,grant,input,leader,binding);
    await assert.rejects(sa.claimResidentQueue(q,entry,1,ids.claimId,{runId:ids.runId,operationId:ids.operationId,taskRevisionId:rev}),/QUEUE_VERSION_CONFLICT/);
    await assert.rejects(sa.claimResidentQueue(q,entry,2,ids.claimId,{runId:ids.runId,operationId:ids.operationId,taskRevisionId:rev}),/QUEUE_HOLD_REQUIRES_DECISION/);
    const held=(await sa.list(q))!.entries[0]!;await sa.unholdResidentQueueEntry(q,entry,held.version,randomUUID(),'lead','Review complete');
    const first=await sa.claimResidentQueue(q,entry,2,ids.claimId,{runId:ids.runId,operationId:ids.operationId,taskRevisionId:rev});assert.equal(first?.claimId,ids.claimId);
    const competing=(async()=>{await b.query('BEGIN');const sb=new PgResidentQueue(b,p,grant,input,leader,binding);const result=await sb.claimResidentQueue(q,entry,2,ids.claimId,{runId:ids.runId,operationId:ids.operationId,taskRevisionId:rev});await b.query('COMMIT');return result;})();
    await a.query('COMMIT');assert.equal((await competing)?.claimId,ids.claimId);
    await a.query('BEGIN');assert.equal((await sa.listReconcile()).length,1);assert.equal((await sa.listResidentQueueAttempts(ids.claimId)).length,1);
    await assert.rejects(sa.claimResidentQueue(q,entry,2,ids.claimId,{runId:randomUUID(),operationId:randomUUID(),taskRevisionId:rev}),/OPERATION_CONFLICT/);
    assert.equal((await sa.listResidentQueueAttempts(ids.claimId)).length,1);
    await a.query(`INSERT INTO runtime_run(project_id,run_id,task_id,task_revision_id,basis_set_id,session_id,operation_id,input,input_hash,state,version,native_turn_id,interrupt_requested,actor_id,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,'fixed',repeat('b',64),'completed',1,$8,false,'lead',now(),now())`,[p,ids.runId,task,rev,basis,session,ids.operationId,'turn-'+ids.runId]);
    await sa.holdResidentQueueEntry(q,entry,'grant_revoked','Grant changed; Lead must review');
    await assert.rejects(sa.appendResidentQueueAttempt(ids.claimId,{runId:randomUUID(),operationId:randomUUID(),taskRevisionId:rev},3),/QUEUE_HOLD_REQUIRES_DECISION/);
    const claimedHold=(await sa.list(q))!.entries[0]!;await sa.unholdResidentQueueEntry(q,entry,claimedHold.version,randomUUID(),'lead','Question answered');
    const secondIds={runId:randomUUID(),operationId:randomUUID()};
    const next=await sa.appendResidentQueueAttempt(ids.claimId,{...secondIds,taskRevisionId:rev},3);
    assert.equal(next?.sequence,2);
    await a.query(`INSERT INTO runtime_run(project_id,run_id,task_id,task_revision_id,basis_set_id,session_id,operation_id,input,input_hash,state,version,interrupt_requested,actor_id,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,'fixed',repeat('b',64),'unknown',1,false,'lead',now(),now())`,[p,secondIds.runId,task,rev,basis,session,secondIds.operationId]);
    await assert.rejects(sa.appendResidentQueueAttempt(ids.claimId,{runId:randomUUID(),operationId:randomUUID(),taskRevisionId:rev},3),/explicitly permitted failed Run successor/);
    await a.query("UPDATE runtime_run SET state='completed',native_turn_id=$3,version=2,updated_at=now() WHERE project_id=$1 AND run_id=$2",[p,secondIds.runId,'turn-'+secondIds.runId]);
    await assert.rejects(sa.appendResidentQueueAttempt(ids.claimId,{runId:randomUUID(),operationId:randomUUID(),taskRevisionId:rev},3),/explicitly permitted failed Run successor/);
    assert.equal((await sa.listResidentQueueAttempts(ids.claimId)).length,2,'unknown readback preserves the blocked gate until a formal recovery decision');
    assert.equal(await sa.releaseResidentQueueAccepted(ids.claimId),false);await assert.rejects(sa.assertQueueVacant(task,session),/QUEUE_OCCUPIED/);await a.query('COMMIT');
  }catch(e){await a.query('ROLLBACK');await b.query('ROLLBACK');throw e;}finally{a.release();b.release();}
});

test('official Task and Run lifecycle releases A only after current consumer acceptance, then B can claim',async()=>{
  const p=randomUUID(),q=randomUUID(),role=randomUUID(),roleRev=randomUUID(),session=randomUUID(),taskA=randomUUID(),taskB=randomUUID(),entryA=randomUUID(),entryB=randomUUID(),runId=randomUUID();
  const principal={actorId:'lead',projectIds:[p],permissions:['read','write','review'] as Array<'read'|'write'|'review'>};
  const apply=async(command:Parameters<typeof workflow.execute>[1])=>{const result=await workflow.execute(principal,command);assert.equal(result.status,'applied',JSON.stringify(result));return result;};
  await apply({type:'project.create',projectId:p,operationId:randomUUID(),title:'Queue lifecycle'});
  const client=await pool.connect();try{await client.query('BEGIN');
    await client.query(`INSERT INTO role_definition(project_id,role_id,version,current_revision_id,state,proposed_by,created_at_utc,review_at_utc,trial_started_at_utc) VALUES($1,$2,1,$3,'trial','lead',now(),now()+interval '1 day',now())`,[p,role,roleRev]);
    await client.query(`INSERT INTO role_revision(project_id,role_id,revision_id,version,state,proposal,actor_id,reason,created_at_utc,review_at_utc) VALUES($1,$2,$3,1,'trial','{}'::jsonb,'lead','trial',now(),now()+interval '1 day')`,[p,role,roleRev]);
    await client.query('COMMIT');
  }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
  for(const [taskId,title] of [[taskA,'A'],[taskB,'B']] as const){
    await apply({type:'task.create',projectId:p,operationId:randomUUID(),taskId,title,content:`# ${title}`,acceptance:'Consumer uses result',owner:role});
    await apply({type:'task.start',projectId:p,operationId:randomUUID(),taskId,expectedVersion:1,reason:'Fix initial input'});
  }
  await apply({type:'runtime.session.reserve',projectId:p,operationId:randomUUID(),sessionId:session,roleId:role,cwd:'/tmp/queue',authorizationScope:'project',sandbox:'read-only',approvalPolicy:'on-request'});
  await runtime.beginSessionCreate(p,session);
  await runtime.bindSession(p,session,await withExecutionProfile(p,session,{owner:'evoloop-codex-app-server',projectId:p,sessionId:session,roleId:role,cwd:'/tmp/queue',authorizationScope:'project',nativeThreadId:'thread-'+session,nativeSessionId:'native-'+session}));
  const bind=await pool.connect();try{await bind.query('BEGIN');await bind.query(`INSERT INTO role_session_binding(project_id,binding_id,role_id,session_id,role_revision_id,actor_id,note,created_at_utc) VALUES($1,$2,$3,$4,$5,'lead','owned',now())`,[p,randomUUID(),role,session,roleRev]);await bind.query('COMMIT');}catch(e){await bind.query('ROLLBACK');throw e;}finally{bind.release();}
  const signatures=new Map<string,string>();for(const taskId of [taskA,taskB])signatures.set(taskId,await uow.read(p,async reader=>canonicalTaskInputJson(await taskInputSignature(reader,(await reader.getTask(taskId))!))));
  const input=async(_c:pg.PoolClient,_p:string,taskId:string)=>uow.read(p,async reader=>canonicalTaskInputJson(await taskInputSignature(reader,(await reader.getTask(taskId))!)));
  const work=await pool.connect();try{
    await work.query('BEGIN');const queue=new PgResidentQueue(work,p,grant,input,leader,binding);
    const revisionA=(await uow.read(p,r=>r.getTask(taskA)))!.currentRevisionId,revisionB=(await uow.read(p,r=>r.getTask(taskB)))!.currentRevisionId;
    await queue.createResidentQueue({projectId:p,id:q,version:1,adoptedVersion:null,maxRuns:2,reason:'A precedes B',actorId:'lead',entries:[
      {projectId:p,queueId:q,id:entryA,taskId:taskA,taskRevisionId:revisionA,sourceInputJson:signatures.get(taskA)!,sessionId:session,roleId:role,position:0,dependsOn:[],consumerId:'lead',useRequired:true,releaseRule:'accepted',state:'queued',holdCode:null,holdReason:null,claimId:null,version:1},
      {projectId:p,queueId:q,id:entryB,taskId:taskB,taskRevisionId:revisionB,sourceInputJson:signatures.get(taskB)!,sessionId:session,roleId:role,position:1,dependsOn:[entryA],consumerId:'lead',useRequired:true,releaseRule:'accepted',state:'queued',holdCode:null,holdReason:null,claimId:null,version:1}]});
    await queue.adoptResidentQueue(q,1,'lead');
    const claimId=randomUUID(),runOperationId=randomUUID();assert.equal((await queue.claimResidentQueue(q,entryA,1,claimId,{runId,operationId:runOperationId,taskRevisionId:revisionA}))?.claimId,claimId);
    assert.equal(await queue.claimResidentQueue(q,entryB,1,randomUUID(),{runId:randomUUID(),operationId:randomUUID(),taskRevisionId:revisionB}),null);
    await work.query('COMMIT');
    const task=(await uow.read(p,r=>r.getTask(taskA)))!;
    const ordinary=await workflow.execute(principal,{type:'runtime.run.reserve',projectId:p,operationId:randomUUID(),runId,taskId:taskA,sessionId:session,expectedVersion:task.version,input:'Execute fixed Task A'});
    assert.equal(ordinary.status,'rejected');if(ordinary.status==='rejected')assert.equal(ordinary.code,'QUEUE_OCCUPIED');
    await uow.transaction(p,async tx=>{const reserved=await reserveRuntime({tx,principal,now:new Date().toISOString(),nextId:randomUUID,hash,
      command:{type:'runtime.run.reserve',projectId:p,operationId:runOperationId,runId,taskId:taskA,sessionId:session,expectedVersion:task.version,input:'Execute fixed Task A'},
      queueClaim:{claimId,runId,operationId:runOperationId,taskId:taskA,sessionId:session}});
      await tx.insertOperation({projectId:p,id:runOperationId,actorId:'lead',commandHash:hash('queue fixture'),
        commandType:'queue.claim',result:reserved.result,createdAt:new Date().toISOString()});});
    await runtime.beginDispatch(p,runId);const stored=(await uow.read(p,r=>r.getRuntimeRun(runId)))!;
    await runtime.bindTurn(p,runId,{id:'turn-'+runId},{kind:'startReply',operationId:stored.operationId});
    await runtime.recordTurn(p,runId,'turn-'+runId,'completed','Fixed result observed');
    await work.query('BEGIN');assert.equal(await queue.releaseResidentQueueAccepted(claimId),false);await work.query('COMMIT');
    const afterRun=(await uow.read(p,r=>r.getTask(taskA)))!;
    const delivery=await apply({type:'delivery.record',projectId:p,operationId:randomUUID(),taskId:taskA,runId,expectedVersion:afterRun.version,artifactRef:'repo:task-a',artifactRevision:'abc123',contentHash:hash('A result'),technicalResult:'passed',technicalEvidence:'Tests passed',reason:'Deliver A'});
    await work.query('BEGIN');assert.equal(await queue.releaseResidentQueueAccepted(claimId),false);await work.query('COMMIT');
    await apply({type:'observation.record',projectId:p,operationId:randomUUID(),taskId:taskA,deliveryId:delivery.revisionId!,observer:'lead',observerKind:'agent',result:'used',evidence:'Read and applied output',reason:'Consumer used A'});
    const beforeClose=(await uow.read(p,r=>r.getTask(taskA)))!;
    await apply({type:'task.close',projectId:p,operationId:randomUUID(),taskId:taskA,expectedVersion:beforeClose.version,deliveryId:delivery.revisionId!,acceptanceResult:'met',acceptanceEvidence:'Current delivery used',reason:'A accepted'});
    await work.query('BEGIN');assert.equal(await queue.releaseResidentQueueAccepted(claimId),true);
    assert.equal((await queue.list(q))!.entries[0]!.claimId,claimId,'released entry retains claim provenance for dependency checks');
    assert.equal((await queue.getResidentQueueClaim(claimId))?.releaseKind,'accepted');
    const heldB=(await queue.list(q))!.entries.find(x=>x.id===entryB)!;
    await queue.unholdResidentQueueEntry(q,entryB,heldB.version,randomUUID(),'lead','A is accepted; resume B');
    const second=await queue.claimResidentQueue(q,entryB,1,randomUUID(),{runId:randomUUID(),operationId:randomUUID(),taskRevisionId:revisionB});assert.ok(second);await work.query('COMMIT');
    assert.equal(await queue.countResidentQueueAttempts(q),2);
    await assert.rejects(pool.query('INSERT INTO resident_queue_attempt(project_id,claim_id,sequence,run_id,operation_id,task_revision_id) VALUES($1,$2,2,$3,$4,$5)',[p,second!.claimId,randomUUID(),randomUUID(),revisionB]),/run budget exhausted/);
  }catch(e){await work.query('ROLLBACK');throw e;}finally{work.release();}
});

test('queue claim, old Loop Session, duplicate messages, Delivery and release faults preserve original intents',async()=>{
  const p=randomUUID(),role=randomUUID(),roleRev=randomUUID(),taskId=randomUUID(),taskBId=randomUUID(),sessionId=randomUUID();
  const queueId=randomUUID(),entryId=randomUUID(),entryBId=randomUUID();
  let claimId=queueIntentId('claim',p,queueId,entryId,'1','1');
  let runId=queueIntentId('run',p,queueId,entryId,'1','1','1');
  let operationId=queueIntentId('run.reserve',p,queueId,entryId,'1','1','1');
  const lead={actorId:'lead',projectIds:[p],permissions:['read','write','review'] as Array<'read'|'write'|'review'>};
  let grantEnabled=true,leadEnabled=true;
  const centralUow=new PostgresUnitOfWork(pool,{grant:async()=>grantEnabled,binding:async()=>true,lead:async()=>leadEnabled,
    input:async(reader,id)=>canonicalTaskInputJson(await taskInputSignature(reader,(await reader.getTask(id))!))});
  const central=new WorkflowService({uow:centralUow,clock:{now:()=>new Date().toISOString()},ids:{next:randomUUID},hasher:{hash},
    collaborationAuthority:{actorForRole:async()=> 'worker',isAuthorizedRoleActor:async()=>true,
      isProjectActor:async()=>true,hasEngineeringActionGrant:async()=>false}});
  const native=new RuntimeWorkflowService({uow:centralUow,clock:{now:()=>new Date().toISOString()},ids:{next:randomUUID}});
  const apply=async(command:Parameters<typeof central.execute>[1])=>{
    const result=await central.execute(lead,command);assert.equal(result.status,'applied',JSON.stringify(result));return result;};
  await apply({type:'project.create',projectId:p,operationId:randomUUID(),title:'Central queue'});
  const client=await pool.connect();try{await client.query('BEGIN');
    await client.query(`INSERT INTO role_definition(project_id,role_id,version,current_revision_id,state,proposed_by,created_at_utc,review_at_utc,trial_started_at_utc)
      VALUES($1,$2,1,$3,'trial','lead',now(),now()+interval '1 day',now())`,[p,role,roleRev]);
    await client.query(`INSERT INTO role_revision(project_id,role_id,revision_id,version,state,proposal,actor_id,reason,created_at_utc,review_at_utc)
      VALUES($1,$2,$3,1,'trial','{}'::jsonb,'lead','trial',now(),now()+interval '1 day')`,[p,role,roleRev]);
    await client.query('COMMIT');
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  await apply({type:'task.create',projectId:p,operationId:randomUUID(),taskId,title:'Build A',content:'Fixed work',acceptance:'Accepted result',owner:role});
  await apply({type:'task.start',projectId:p,operationId:randomUUID(),taskId,expectedVersion:1,reason:'Fix source'});
  await apply({type:'task.create',projectId:p,operationId:randomUUID(),taskId:taskBId,title:'Build B',content:'Wait for A',acceptance:'Accepted B',owner:role});
  await apply({type:'task.start',projectId:p,operationId:randomUUID(),taskId:taskBId,expectedVersion:1,reason:'Fix source'});
  await apply({type:'runtime.session.reserve',projectId:p,operationId:randomUUID(),sessionId,roleId:role,cwd:'/tmp/queue',authorizationScope:'project',sandbox:'read-only',approvalPolicy:'on-request'});
  await native.beginSessionCreate(p,sessionId);
  await native.bindSession(p,sessionId,await withExecutionProfile(p,sessionId,{owner:'evoloop-codex-app-server',projectId:p,sessionId,roleId:role,cwd:'/tmp/queue',authorizationScope:'project',nativeThreadId:`thread-${sessionId}`,nativeSessionId:`native-${sessionId}`}));
  await pool.query(`INSERT INTO role_session_binding(project_id,binding_id,role_id,session_id,role_revision_id,actor_id,note,created_at_utc)
    VALUES($1,$2,$3,$4,$5,'lead','owned',now())`,[p,randomUUID(),role,sessionId,roleRev]);
  const before=(await central.getTask(lead,p,taskId)).task;
  const beforeB=(await central.getTask(lead,p,taskBId)).task;
  await apply({type:'queue.create',projectId:p,operationId:randomUUID(),queueId,maxRuns:3,reason:'A then B with one answer continuation',entries:[{
    id:entryId,taskId,taskRevisionId:before.currentRevisionId,sessionId,roleId:role,dependsOn:[],consumerId:'lead',useRequired:true,releaseRule:'accepted'},
    {id:entryBId,taskId:taskBId,taskRevisionId:beforeB.currentRevisionId,sessionId,roleId:role,dependsOn:[entryId],
      consumerId:'lead',useRequired:false,releaseRule:'accepted'}]});
  await apply({type:'queue.adopt',projectId:p,operationId:randomUUID(),queueId,expectedVersion:1});
  const badOperationId=randomUUID(),badClaimId=randomUUID();
  const rolledBack=await central.execute(lead,{type:'queue.claim',projectId:p,operationId:badOperationId,queueId,entryId,
    expectedVersion:1,claimId:badClaimId,runId:randomUUID(),runOperationId:randomUUID()});
  assert.equal(rolledBack.status,'rejected');if(rolledBack.status==='rejected')assert.equal(rolledBack.code,'RUN_OPERATION_MISMATCH');
  assert.equal((await central.getResidentQueue(lead,p,queueId)).entries[0]?.state,'queued');
  assert.equal((await central.listResidentQueueAttempts(lead,p,badClaimId)).length,0);
  assert.equal((await pool.query('SELECT 1 FROM outbox_event WHERE project_id=$1 AND operation_id=$2',[p,badOperationId])).rowCount,0);
  grantEnabled=false;
  const pumpOptions={workflow:central,credentials:async()=>[lead],enabled:async()=>true,canWrite:()=>true,
    pollIntervalMs:60000,onError:(error:unknown)=>{throw error;}};
  await new ResidentQueuePump(pumpOptions).tick();
  const held=(await central.getResidentQueue(lead,p,queueId)).entries[0]!;
  assert.equal(held.holdCode,'grant_revoked');
  assert.equal((await central.listResidentQueueAttempts(lead,p,claimId)).length,0);
  grantEnabled=true;
  await new ResidentQueuePump(pumpOptions).tick();
  assert.equal((await central.getResidentQueue(lead,p,queueId)).entries[0]?.state,'held');
  await apply({type:'queue.unhold',projectId:p,operationId:randomUUID(),queueId,entryId,
    expectedEntryVersion:held.version,reason:'Current grant restored; Lead resumes'});
  const generation=String((await central.getResidentQueue(lead,p,queueId)).entries[0]!.version);
  claimId=queueIntentId('claim',p,queueId,entryId,'1',generation);
  runId=queueIntentId('run',p,queueId,entryId,'1',generation,'1');
  operationId=queueIntentId('run.reserve',p,queueId,entryId,'1',generation,'1');
  leadEnabled=false;
  const revoked=await central.execute(lead,{type:'queue.claim',projectId:p,operationId:randomUUID(),queueId,entryId,
    expectedVersion:1,claimId,runId,runOperationId:operationId});
  assert.equal(revoked.status,'rejected');if(revoked.status==='rejected')assert.equal(revoked.code,'QUEUE_AUTHORIZATION');
  assert.equal((await central.getResidentQueue(lead,p,queueId)).entries[0]?.state,'queued');
  leadEnabled=true;
  const command={type:'queue.claim' as const,projectId:p,operationId,queueId,entryId,expectedVersion:1,claimId,runId,runOperationId:operationId};
  for(const table of ['resident_queue_claim','runtime_run','process_document','outbox_event'] as const){
    await withWriteFault(table,'INSERT',async()=>{
      await assert.rejects(central.execute(lead,command),/injected queue write fault/);
    });
    assert.equal((await central.getResidentQueue(lead,p,queueId)).entries[0]?.state,'queued',`${table} rollback keeps entry queued`);
    for(const relation of ['resident_queue_claim','resident_queue_attempt','runtime_run','operation_journal','outbox_event']){
      const rows=await pool.query(`SELECT 1 FROM ${relation} WHERE project_id=$1 AND ${relation==='resident_queue_claim'?'claim_id=$2':relation==='resident_queue_attempt'?'claim_id=$2':relation==='runtime_run'?'run_id=$2':'operation_id=$2'}`,
        [p,relation==='resident_queue_claim'||relation==='resident_queue_attempt'?claimId:relation==='runtime_run'?runId:operationId]);
      assert.equal(rows.rowCount,0,`${table} rollback leaves no ${relation}`);
    }
  }
  await Promise.all([new ResidentQueuePump(pumpOptions).tick(),new ResidentQueuePump(pumpOptions).tick()]);
  const first=await apply(command);
  assert.deepEqual(await central.execute(lead,command),first);
  const queue=await central.getResidentQueue(lead,p,queueId);assert.equal(queue.entries[0]?.claimId,claimId);
  assert.equal((await central.listResidentQueueAttempts(lead,p,claimId)).length,1);
  const run=await central.getRuntimeRun(lead,p,runId);assert.equal(run.state,'requested');
  assert.match(run.input,/Task channel [0-9a-f-]{36}/);
  const journal=await pool.query('SELECT command_type FROM operation_journal WHERE project_id=$1 AND operation_id=$2',[p,operationId]);
  assert.equal(journal.rows[0]?.command_type,'queue.claim');
  const outbox=await pool.query('SELECT kind FROM outbox_event WHERE project_id=$1 AND operation_id=$2',[p,operationId]);
  assert.ok(outbox.rows.some(row=>row.kind==='runtime.run.requested'));
  assert.ok(outbox.rows.some(row=>row.kind==='discussion'));
  const channels=await central.listDiscussions(lead,p);assert.ok(channels.items.some(x=>x.collaboration?.runId===runId));
  const occupied=await central.execute(lead,{type:'runtime.run.reserve',projectId:p,operationId:randomUUID(),runId:randomUUID(),taskId,sessionId,
    expectedVersion:(await central.getTask(lead,p,taskId)).task.version,input:'outside reservation'});
  assert.equal(occupied.status,'rejected');if(occupied.status==='rejected')assert.equal(occupied.code,'QUEUE_OCCUPIED');
  const oldLoopDispatch=randomUUID(),oldLoopRun=loopIntentId(oldLoopDispatch,'run');
  const oldLoopOperation=loopIntentId(oldLoopDispatch,'run.reserve');
  const [queueReplay,oldLoopReserve]=await Promise.all([
    central.execute(lead,command),
    central.execute(lead,{type:'runtime.run.reserve',projectId:p,operationId:oldLoopOperation,
      runId:oldLoopRun,taskId:taskBId,sessionId,expectedVersion:(await central.getTask(lead,p,taskBId)).task.version,
      input:'Old Loop dispatch on the queue-owned Session'})]);
  assert.deepEqual(queueReplay,first);
  assert.equal(oldLoopReserve.status,'rejected');
  if(oldLoopReserve.status==='rejected')assert.equal(oldLoopReserve.code,'QUEUE_OCCUPIED');
  assert.equal((await pool.query('SELECT 1 FROM runtime_run WHERE project_id=$1 AND run_id=$2',
    [p,oldLoopRun])).rowCount,0,'old Loop cannot create a second Run on the claimed Session');
  const channel=channels.items.find(x=>x.collaboration?.runId===runId)!;
  const worker={actorId:'worker',projectIds:[p],permissions:['read','write'] as Array<'read'|'write'>};
  const fixedMessage=async(body:string)=>{
    const documentId=randomUUID(),revisionId=randomUUID();
    const client=await pool.connect();try{
      await client.query('BEGIN');
      await client.query('SET CONSTRAINTS ALL DEFERRED');
      await client.query(`INSERT INTO process_document(project_id,document_id,title,version,current_revision_id,kind,status)
        VALUES($1,$2,'Fixed message',1,$3,'discussion','draft')`,[p,documentId,revisionId]);
      await client.query(`INSERT INTO document_revision(project_id,document_id,revision_id,body,format,content_hash,author,
        created_at,reason,media_type,original_name,assets_manifest)
        VALUES($1,$2,$3,$4,'markdown',$5,'lead',now(),'fixed','text/markdown','message.md','[]'::jsonb)`,
        [p,documentId,revisionId,body,hash(body)]);
      await client.query('COMMIT');
    }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
    return {documentId,revisionId};
  };
  const questionBody=await fixedMessage('Which acceptance evidence should I include?');
  const questionCommand={type:'discussion.message.post' as const,projectId:p,operationId:randomUUID(),
    discussionId:channel.id,expectedVersion:1,kind:'question' as const,recipientActorId:'lead',body:questionBody};
  const originalInput=run.input,originalHash=run.inputHash;
  const question=await central.execute(worker,questionCommand);
  assert.equal(question.status,'applied',JSON.stringify(question));
  assert.deepEqual(await central.execute(worker,questionCommand),question);
  const questionEvent=(await central.listDiscussionEvents(lead,p,channel.id)).find(x=>x.collaborationPayload?.type==='message'&&
    x.collaborationPayload.kind==='question')!;
  const answerBody=await fixedMessage('Include the current passing test receipt and consumer use observation.');
  const answerCommand={type:'discussion.message.post' as const,projectId:p,operationId:randomUUID(),
    discussionId:channel.id,expectedVersion:2,kind:'answer' as const,recipientActorId:'worker',replyToEventId:questionEvent.id,body:answerBody};
  const answer=await central.execute(lead,answerCommand);
  assert.equal(answer.status,'applied',JSON.stringify(answer));
  assert.deepEqual(await central.execute(lead,answerCommand),answer);
  assert.equal((await central.listDiscussionEvents(lead,p,channel.id)).filter(x=>
    x.collaborationPayload?.type==='message').length,2,'duplicate arrivals produce no extra messages');
  assert.equal((await central.getRuntimeRun(lead,p,runId)).input,originalInput);
  assert.equal((await central.getRuntimeRun(lead,p,runId)).inputHash,originalHash);
  await new ResidentQueuePump(pumpOptions).tick();
  assert.equal((await central.listResidentQueueAttempts(lead,p,claimId)).length,1,'duplicate question and answer do not reserve a Turn');
  const answerEvent=(await central.listDiscussionEvents(lead,p,channel.id)).find(x=>x.collaborationPayload?.type==='message'&&
    x.collaborationPayload.kind==='answer')!;
  await native.beginDispatch(p,runId);
  await native.bindTurn(p,runId,{id:`turn-${runId}`},{kind:'startReply',operationId});
  await native.recordTurn(p,runId,`turn-${runId}`,'completed','Question left for issuer');
  const occupiedSession=await central.getRuntimeSession(lead,p,sessionId);
  const close=await central.execute(lead,{type:'runtime.session.close',projectId:p,operationId:randomUUID(),
    sessionId,expectedVersion:occupiedSession.version,reason:'ordinary close while queue claim is active'});
  assert.equal(close.status,'rejected');if(close.status==='rejected')assert.equal(close.code,'QUEUE_OCCUPIED');
  await new ResidentQueuePump(pumpOptions).tick();
  assert.equal((await central.getResidentQueue(lead,p,queueId)).entries.find(x=>x.id===entryBId)?.state,'queued');
  const continuationRunId=randomUUID(),continuationOperationId=randomUUID();
  const continued=await central.execute(lead,{type:'queue.continue',projectId:p,operationId:continuationOperationId,
    queueId,entryId,claimId,runId:continuationRunId,runOperationId:continuationOperationId,
    reason:'Use the fixed answer in the original Session',answeredQuestions:[{questionEventId:questionEvent.id,answerEventId:answerEvent.id}]});
  assert.equal(continued.status,'applied',JSON.stringify(continued));
  const continuation=await central.getRuntimeRun(lead,p,continuationRunId);
  assert.equal(continuation.sessionId,sessionId);
  assert.match(continuation.input,new RegExp(`\\[evoloop-task-answer ${channel.id} ${answerEvent.id} ${answerBody.documentId} ${answerBody.revisionId} ${hash('Include the current passing test receipt and consumer use observation.')}\\]`));
  await native.beginDispatch(p,continuationRunId);
  await native.bindTurn(p,continuationRunId,{id:`turn-${continuationRunId}`},{kind:'startReply',operationId:continuationOperationId});
  await native.recordTurn(p,continuationRunId,`turn-${continuationRunId}`,'completed','Used fixed answer');
  await new ResidentQueuePump(pumpOptions).tick();
  assert.equal((await central.getResidentQueue(lead,p,queueId)).entries.find(x=>x.id===entryBId)?.state,'queued');
  for(const [stage,expectedVersion] of [['received',3],['read',4],['adopted',5]] as const){
    const receipt=await central.execute(worker,{type:'discussion.receipt.record',projectId:p,operationId:randomUUID(),
      discussionId:channel.id,expectedVersion,messageEventId:answerEvent.id,stage,evidence:answerBody,
      ...(stage==='adopted'?{continuation:{runId:continuationRunId,taskRevisionId:continuation.taskRevisionId}}:{})});
    assert.equal(receipt.status,'applied',JSON.stringify(receipt));
  }
  const beforeDelivery=(await central.getTask(lead,p,taskId)).task;
  const deliveryCommand={type:'delivery.record' as const,projectId:p,operationId:randomUUID(),taskId,runId:continuationRunId,
    expectedVersion:beforeDelivery.version,artifactRef:'repo:task-a',artifactRevision:'abc123',contentHash:hash('A result'),
    technicalResult:'passed' as const,technicalEvidence:'Tests passed',reason:'Deliver A'};
  await withWriteFault('delivery','INSERT',async()=>{
    await assert.rejects(central.execute(lead,deliveryCommand),/injected queue write fault/);
  });
  assert.equal((await pool.query('SELECT 1 FROM delivery WHERE project_id=$1 AND task_id=$2',[p,taskId])).rowCount,0);
  assert.equal((await pool.query('SELECT 1 FROM operation_journal WHERE project_id=$1 AND operation_id=$2',
    [p,deliveryCommand.operationId])).rowCount,0);
  assert.equal((await central.getResidentQueue(lead,p,queueId)).entries.find(x=>x.id===entryId)?.state,'claimed');
  const delivery=await apply(deliveryCommand);
  await apply({type:'observation.record',projectId:p,operationId:randomUUID(),taskId,deliveryId:delivery.revisionId!,
    observer:'lead',observerKind:'agent',result:'used',evidence:'Read and used A',reason:'Consumer used A'});
  const beforeClose=(await central.getTask(lead,p,taskId)).task;
  await apply({type:'task.close',projectId:p,operationId:randomUUID(),taskId,expectedVersion:beforeClose.version,
    deliveryId:delivery.revisionId!,acceptanceResult:'met',acceptanceEvidence:'Current delivery used',reason:'A accepted'});
  const releaseOperationId=queueIntentId('release',p,queueId,entryId,continuationRunId,
    (await central.getTask(lead,p,taskId)).closures.at(-1)!.id);
  for(const table of ['resident_queue_claim','resident_queue_entry'] as const){
    await withWriteFault(table,'UPDATE',async()=>{
      await assert.rejects(new ResidentQueuePump(pumpOptions).tick(),/injected queue write fault/);
    });
    assert.equal((await central.getResidentQueue(lead,p,queueId)).entries.find(x=>x.id===entryId)?.state,'claimed');
    assert.equal((await pool.query('SELECT released_at FROM resident_queue_claim WHERE project_id=$1 AND claim_id=$2',
      [p,claimId])).rows[0]?.released_at,null);
    assert.equal((await pool.query('SELECT 1 FROM operation_journal WHERE project_id=$1 AND operation_id=$2',
      [p,releaseOperationId])).rowCount,0);
  }
  // Rebuild service and pump from committed PostgreSQL state, as after a process restart.
  const recoveredUow=new PostgresUnitOfWork(pool,{grant:async()=>grantEnabled,binding:async()=>true,lead:async()=>leadEnabled,
    input:async(reader,id)=>canonicalTaskInputJson(await taskInputSignature(reader,(await reader.getTask(id))!))});
  const recovered=new WorkflowService({uow:recoveredUow,clock:{now:()=>new Date().toISOString()},ids:{next:randomUUID},hasher:{hash},
    collaborationAuthority:{actorForRole:async()=> 'worker',isAuthorizedRoleActor:async()=>true,
      isProjectActor:async()=>true,hasEngineeringActionGrant:async()=>false}});
  await new ResidentQueuePump({...pumpOptions,workflow:recovered}).tick();
  assert.equal((await central.getResidentQueue(lead,p,queueId)).entries.find(x=>x.id===entryId)?.state,'released');
  assert.equal((await pool.query('SELECT 1 FROM operation_journal WHERE project_id=$1 AND operation_id=$2',
    [p,releaseOperationId])).rowCount,1);
  await new ResidentQueuePump(pumpOptions).tick();
  const afterB=(await central.getResidentQueue(lead,p,queueId)).entries.find(x=>x.id===entryBId)!;
  assert.equal(afterB.state,'claimed');
  await new ResidentQueuePump(pumpOptions).tick();
  assert.equal((await central.listResidentQueueAttempts(lead,p,afterB.claimId!)).length,1);
  const filler=await pool.connect();try{
    await filler.query('BEGIN');
    const store=new PgResidentQueue(filler,p,grant,input,leader,binding);
    for(let n=0;n<199;n++)await store.createResidentQueue({projectId:p,id:randomUUID(),version:1,
      adoptedVersion:null,maxRuns:1,reason:'Capacity boundary fixture',actorId:'lead',entries:[]});
    await filler.query('COMMIT');
  }catch(error){await filler.query('ROLLBACK');throw error;}finally{filler.release();}
  assert.equal((await central.listResidentQueues(lead,p)).length,200);
  const beforeLimit=await pool.query(`SELECT
    (SELECT count(*)::int FROM runtime_run WHERE project_id=$1) AS runs,
    (SELECT count(*)::int FROM resident_queue_attempt WHERE project_id=$1) AS attempts`,[p]);
  const currentB=(await central.getTask(lead,p,taskBId)).task;
  const overId=randomUUID(),overOperationId=randomUUID();
  const over=await central.execute(lead,{type:'queue.create',projectId:p,operationId:overOperationId,queueId:overId,
    maxRuns:1,reason:'Must report full project capacity',entries:[{id:randomUUID(),taskId:taskBId,
      taskRevisionId:currentB.currentRevisionId,sessionId,roleId:role,dependsOn:[],consumerId:'lead',
      useRequired:false,releaseRule:'accepted'}]});
  assert.equal(over.status,'rejected');if(over.status==='rejected')assert.equal(over.code,'QUEUE_LIMIT_REACHED');
  assert.equal((await central.listResidentQueues(lead,p)).length,200);
  const afterLimit=await pool.query(`SELECT
    (SELECT count(*)::int FROM runtime_run WHERE project_id=$1) AS runs,
    (SELECT count(*)::int FROM resident_queue_attempt WHERE project_id=$1) AS attempts`,[p]);
  assert.deepEqual(afterLimit.rows[0],beforeLimit.rows[0]);
  assert.equal((await pool.query('SELECT 1 FROM resident_queue WHERE project_id=$1 AND queue_id=$2',[p,overId])).rowCount,0);
  const limitedJournal=await pool.query('SELECT result FROM operation_journal WHERE project_id=$1 AND operation_id=$2',[p,overOperationId]);
  assert.equal(limitedJournal.rows[0]?.result?.code,'QUEUE_LIMIT_REACHED');
  // A preexisting overflow must fail visibly instead of silently omitting its 201st queue.
  await pool.query(`INSERT INTO resident_queue(project_id,queue_id,version,max_runs,reason,actor_id)
    VALUES($1,$2,1,1,'legacy overflow','lead')`,[p,randomUUID()]);
  await assert.rejects(central.listResidentQueues(lead,p),error=>
    error instanceof Error && 'code' in error && error.code==='QUEUE_LIMIT_EXCEEDED');
});

test('first queue claim and old Loop reserve serialize on an idle shared Session in either order',async t=>{
  for(const first of ['queue','loop'] as const){
    const p=randomUUID(),role=randomUUID(),roleRevision=randomUUID(),sessionId=randomUUID();
    const queuedTask=randomUUID(),loopTask=randomUUID(),queueId=randomUUID(),entryId=randomUUID();
    const lead={actorId:'lead',projectIds:[p],permissions:['read','write','review'] as Array<'read'|'write'|'review'>};
    const authority={grant:async()=>true,binding:async()=>true,lead:async()=>true,
      input:async(reader:Reader,id:string)=>
        canonicalTaskInputJson(await taskInputSignature(reader,(await reader.getTask(id))!))};
    const raceUow=new PostgresUnitOfWork(pool,authority);
    const deps={clock:{now:()=>new Date().toISOString()},ids:{next:randomUUID},hasher:{hash},
      collaborationAuthority:{actorForRole:async()=> 'worker',isAuthorizedRoleActor:async()=>true,
        isProjectActor:async()=>true,hasEngineeringActionGrant:async()=>false}};
    const service=new WorkflowService({uow:raceUow,...deps});
    const trusted=new RuntimeWorkflowService({uow:raceUow,clock:deps.clock,ids:deps.ids});
    const apply=async(command:Parameters<typeof service.execute>[1])=>{
      const result=await service.execute(lead,command);assert.equal(result.status,'applied',JSON.stringify(result));return result;};
    await apply({type:'project.create',projectId:p,operationId:randomUUID(),title:`First ${first} wins`});
    const roleClient=await pool.connect();try{
      await roleClient.query('BEGIN');
      await roleClient.query(`INSERT INTO role_definition(project_id,role_id,version,current_revision_id,state,proposed_by,created_at_utc,review_at_utc,trial_started_at_utc)
        VALUES($1,$2,1,$3,'trial','lead',now(),now()+interval '1 day',now())`,[p,role,roleRevision]);
      await roleClient.query(`INSERT INTO role_revision(project_id,role_id,revision_id,version,state,proposal,actor_id,reason,created_at_utc,review_at_utc)
        VALUES($1,$2,$3,1,'trial','{}'::jsonb,'lead','trial',now(),now()+interval '1 day')`,[p,role,roleRevision]);
      await roleClient.query('COMMIT');
    }catch(error){await roleClient.query('ROLLBACK');throw error;}finally{roleClient.release();}
    for(const [taskId,title] of [[queuedTask,'Queue Task'],[loopTask,'Loop Task']] as const){
      await apply({type:'task.create',projectId:p,operationId:randomUUID(),taskId,title,
        content:`Fixed ${title}`,acceptance:'One Run',owner:role});
      await apply({type:'task.start',projectId:p,operationId:randomUUID(),taskId,expectedVersion:1,reason:'Seal input'});
    }
    await apply({type:'runtime.session.reserve',projectId:p,operationId:randomUUID(),sessionId,roleId:role,
      cwd:'/tmp/queue-race',authorizationScope:'project',sandbox:'read-only',approvalPolicy:'on-request'});
    await trusted.beginSessionCreate(p,sessionId);
    await trusted.bindSession(p,sessionId,await withExecutionProfile(p,sessionId,{owner:'evoloop-codex-app-server',projectId:p,sessionId,roleId:role,
      cwd:'/tmp/queue-race',authorizationScope:'project',nativeThreadId:`thread-${sessionId}`,nativeSessionId:`native-${sessionId}`}));
    await pool.query(`INSERT INTO role_session_binding(project_id,binding_id,role_id,session_id,role_revision_id,actor_id,note,created_at_utc)
      VALUES($1,$2,$3,$4,$5,'lead','owned',now())`,[p,randomUUID(),role,sessionId,roleRevision]);
    const queued=(await service.getTask(lead,p,queuedTask)).task;
    await apply({type:'queue.create',projectId:p,operationId:randomUUID(),queueId,maxRuns:1,
      reason:'One initial queue claim',entries:[{id:entryId,taskId:queuedTask,taskRevisionId:queued.currentRevisionId,
        sessionId,roleId:role,dependsOn:[],consumerId:'lead',useRequired:true,releaseRule:'accepted'}]});
    await apply({type:'queue.adopt',projectId:p,operationId:randomUUID(),queueId,expectedVersion:1});
    assert.equal((await service.listRuntimeRuns(lead,p)).length,0);
    assert.equal((await service.getResidentQueue(lead,p,queueId)).entries[0]?.state,'queued');
    const queueClaim=queueIntentId('claim',p,queueId,entryId,'1','1');
    const queueRun=queueIntentId('run',p,queueId,entryId,'1','1','1');
    const queueOperation=queueIntentId('run.reserve',p,queueId,entryId,'1','1','1');
    const dispatch=randomUUID(),loopRun=loopIntentId(dispatch,'run'),loopOperation=loopIntentId(dispatch,'run.reserve');
    const claim={type:'queue.claim' as const,projectId:p,operationId:queueOperation,queueId,entryId,
      expectedVersion:1,claimId:queueClaim,runId:queueRun,runOperationId:queueOperation};
    const reserve={type:'runtime.run.reserve' as const,projectId:p,operationId:loopOperation,
      runId:loopRun,taskId:loopTask,sessionId,expectedVersion:(await service.getTask(lead,p,loopTask)).task.version,
      input:'Old Loop fixed dispatch'};
    let entered!:()=>void,release!:()=>void;
    const acquired=new Promise<void>(resolve=>{entered=resolve;});
    const allowed=new Promise<void>(resolve=>{release=resolve;});
    const gatedUow:UnitOfWork={read:raceUow.read.bind(raceUow),
      transaction:<T>(projectId:string,action:(tx:Transaction)=>Promise<T>)=>
        raceUow.transaction(projectId,async tx=>{entered();await allowed;return action(tx);})};
    const gated=new WorkflowService({uow:gatedUow,...deps});
    const firstCommand=first==='queue'?claim:reserve,secondCommand=first==='queue'?reserve:claim;
    const firstPromise=gated.execute(lead,firstCommand);
    await acquired; // the first command owns the actual project transaction lock
    const secondPromise=service.execute(lead,secondCommand);
    const waitingSql=`SELECT waiter.pid AS waiter_pid, blocker.pid AS holder_pid
      FROM pg_locks waiter
      JOIN pg_locks blocker ON blocker.locktype=waiter.locktype AND blocker.database=waiter.database
        AND blocker.classid=waiter.classid AND blocker.objid=waiter.objid AND blocker.objsubid=waiter.objsubid
        AND blocker.granted AND blocker.pid<>waiter.pid
      JOIN pg_stat_activity activity ON activity.pid=waiter.pid
      WHERE waiter.locktype='advisory' AND NOT waiter.granted
        AND waiter.database=(SELECT oid FROM pg_database WHERE datname=current_database())
        AND waiter.classid::text::bigint=((hashtextextended($1,0) >> 32) & 4294967295)
        AND waiter.objid::text::bigint=(hashtextextended($1,0) & 4294967295)
        AND waiter.objsubid=1 AND activity.wait_event_type='Lock' AND activity.wait_event='advisory'
        AND blocker.pid=ANY(pg_blocking_pids(waiter.pid))`;
    let waiting:{waiter_pid:number;holder_pid:number}|undefined;
    let waitError:unknown;
    try{
      const deadline=Date.now()+3000;
      while(Date.now()<deadline){
        waiting=(await pool.query(waitingSql,[p])).rows[0];
        if(waiting)break;
      }
      assert.ok(waiting,`${first} first: second command never waited on this project's advisory lock`);
      t.diagnostic(`${first} first: PG project advisory lock holder=${waiting.holder_pid} waiter=${waiting.waiter_pid}`);
    }catch(error){waitError=error;}
    finally{release();}
    const outcomes=await Promise.allSettled([firstPromise,secondPromise]);
    if(waitError)throw waitError;
    assert.equal(outcomes[0].status,'fulfilled');
    assert.equal(outcomes[1].status,'fulfilled');
    if(outcomes[0].status!=='fulfilled'||outcomes[1].status!=='fulfilled')throw new Error('racing command failed');
    const firstResult=outcomes[0].value,secondResult=outcomes[1].value;
    assert.equal(firstResult.status,'applied');
    const runs=await pool.query('SELECT run_id FROM runtime_run WHERE project_id=$1',[p]);
    assert.equal(runs.rowCount,1,'one shared Session has at most one initial Run');
    if(first==='queue'){
      assert.equal(runs.rows[0]?.run_id,queueRun);
      assert.equal(secondResult.status,'rejected');
      if(secondResult.status==='rejected')assert.equal(secondResult.code,'QUEUE_OCCUPIED');
      assert.equal((await pool.query('SELECT 1 FROM resident_queue_claim WHERE project_id=$1',[p])).rowCount,1);
      assert.equal((await pool.query('SELECT 1 FROM resident_queue_attempt WHERE project_id=$1',[p])).rowCount,1);
      assert.equal((await pool.query('SELECT 1 FROM outbox_event WHERE project_id=$1 AND operation_id=$2',[p,loopOperation])).rowCount,0);
      assert.equal((await pool.query('SELECT result FROM operation_journal WHERE project_id=$1 AND operation_id=$2',
        [p,loopOperation])).rows[0]?.result?.status,'rejected');
    }else{
      assert.equal(runs.rows[0]?.run_id,loopRun);
      assert.equal(secondResult.status,'applied');
      if(secondResult.status==='applied')assert.equal(secondResult.queue?.held,'run_in_flight');
      assert.equal((await service.getResidentQueue(lead,p,queueId)).entries[0]?.state,'held');
      assert.equal((await pool.query('SELECT 1 FROM resident_queue_claim WHERE project_id=$1',[p])).rowCount,0);
      assert.equal((await pool.query('SELECT 1 FROM resident_queue_attempt WHERE project_id=$1',[p])).rowCount,0);
      assert.equal((await pool.query(`SELECT 1 FROM outbox_event WHERE project_id=$1 AND operation_id=$2
        AND kind='runtime.run.requested'`,[p,queueOperation])).rowCount,0);
      const queueJournal=await pool.query('SELECT result FROM operation_journal WHERE project_id=$1 AND operation_id=$2',
        [p,queueOperation]);
      assert.equal(queueJournal.rows[0]?.result?.status,'applied');
      assert.equal(queueJournal.rows[0]?.result?.queue?.held,'run_in_flight');
    }
    assert.equal((await pool.query('SELECT 1 FROM runtime_run WHERE project_id=$1 AND run_id=$2',
      [p,first==='queue'?loopRun:queueRun])).rowCount,0,'losing entry creates no Run');
  }
});

test('failed consumer use can continue the same claim from amended input without inventing a question',async()=>{
  const p=randomUUID(),role=randomUUID(),roleRev=randomUUID(),taskId=randomUUID(),sessionId=randomUUID();
  const queueId=randomUUID(),entryId=randomUUID(),claimId=randomUUID(),firstRunId=randomUUID(),firstOperationId=randomUUID();
  const lead={actorId:'lead',projectIds:[p],permissions:['read','write','review'] as Array<'read'|'write'|'review'>};
  const centralUow=new PostgresUnitOfWork(pool,{grant:async()=>true,binding:async()=>true,lead:async()=>true,
    input:async(reader,id)=>canonicalTaskInputJson(await taskInputSignature(reader,(await reader.getTask(id))!))});
  const central=new WorkflowService({uow:centralUow,clock:{now:()=>new Date().toISOString()},ids:{next:randomUUID},hasher:{hash},
    collaborationAuthority:{actorForRole:async()=> 'worker',isAuthorizedRoleActor:async()=>true,
      isProjectActor:async()=>true,hasEngineeringActionGrant:async()=>false}});
  const native=new RuntimeWorkflowService({uow:centralUow,clock:{now:()=>new Date().toISOString()},ids:{next:randomUUID}});
  const apply=async(command:Parameters<typeof central.execute>[1])=>{
    const result=await central.execute(lead,command);assert.equal(result.status,'applied',JSON.stringify(result));return result;};
  await apply({type:'project.create',projectId:p,operationId:randomUUID(),title:'Queue remediation'});
  const client=await pool.connect();try{await client.query('BEGIN');
    await client.query(`INSERT INTO role_definition(project_id,role_id,version,current_revision_id,state,proposed_by,created_at_utc,review_at_utc,trial_started_at_utc)
      VALUES($1,$2,1,$3,'trial','lead',now(),now()+interval '1 day',now())`,[p,role,roleRev]);
    await client.query(`INSERT INTO role_revision(project_id,role_id,revision_id,version,state,proposal,actor_id,reason,created_at_utc,review_at_utc)
      VALUES($1,$2,$3,1,'trial','{}'::jsonb,'lead','trial',now(),now()+interval '1 day')`,[p,role,roleRev]);
    await client.query('COMMIT');
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  await apply({type:'task.create',projectId:p,operationId:randomUUID(),taskId,title:'Build A',
    content:'Initial fixed work',acceptance:'Consumer can use the result',owner:role});
  await apply({type:'task.start',projectId:p,operationId:randomUUID(),taskId,expectedVersion:1,reason:'Seal A input'});
  await apply({type:'runtime.session.reserve',projectId:p,operationId:randomUUID(),sessionId,roleId:role,
    cwd:'/tmp/queue',authorizationScope:'project',sandbox:'read-only',approvalPolicy:'on-request'});
  await native.beginSessionCreate(p,sessionId);
  await native.bindSession(p,sessionId,await withExecutionProfile(p,sessionId,{owner:'evoloop-codex-app-server',projectId:p,sessionId,roleId:role,
    cwd:'/tmp/queue',authorizationScope:'project',nativeThreadId:`thread-${sessionId}`,nativeSessionId:`native-${sessionId}`}));
  await pool.query(`INSERT INTO role_session_binding(project_id,binding_id,role_id,session_id,role_revision_id,actor_id,note,created_at_utc)
    VALUES($1,$2,$3,$4,$5,'lead','owned',now())`,[p,randomUUID(),role,sessionId,roleRev]);
  const initial=(await central.getTask(lead,p,taskId)).task;
  await apply({type:'queue.create',projectId:p,operationId:randomUUID(),queueId,maxRuns:2,
    reason:'One remediation attempt after failed use',entries:[{id:entryId,taskId,
      taskRevisionId:initial.currentRevisionId,sessionId,roleId:role,dependsOn:[],consumerId:'lead',
      useRequired:true,releaseRule:'accepted'}]});
  await apply({type:'queue.adopt',projectId:p,operationId:randomUUID(),queueId,expectedVersion:1});
  await apply({type:'queue.claim',projectId:p,operationId:firstOperationId,queueId,entryId,expectedVersion:1,
    claimId,runId:firstRunId,runOperationId:firstOperationId});
  const sourceChannel=(await central.listDiscussions(lead,p)).items.find(x=>x.collaboration?.runId===firstRunId)!;
  assert.ok(sourceChannel);
  assert.equal((await central.listDiscussionEvents(lead,p,sourceChannel.id)).filter(x=>
    x.collaborationPayload?.type==='message'&&x.collaborationPayload.kind==='question').length,0,
  'the first Run asked no question');
  await native.beginDispatch(p,firstRunId);
  await native.bindTurn(p,firstRunId,{id:`turn-${firstRunId}`},{kind:'startReply',operationId:firstOperationId});
  await native.recordTurn(p,firstRunId,`turn-${firstRunId}`,'completed','Delivered an output that consumer could not use');
  const afterRun=(await central.getTask(lead,p,taskId)).task;
  const delivery=await apply({type:'delivery.record',projectId:p,operationId:randomUUID(),taskId,runId:firstRunId,
    expectedVersion:afterRun.version,artifactRef:'repo:task-a',artifactRevision:'first',contentHash:hash('first result'),
    technicalResult:'passed',technicalEvidence:'Build passed',reason:'Present first result'});
  await apply({type:'observation.record',projectId:p,operationId:randomUUID(),taskId,deliveryId:delivery.revisionId!,
    observer:'lead',observerKind:'agent',result:'failed',evidence:'Consumer found a missing use case',reason:'Failed use'});
  const lifecycle=(await central.getTask(lead,p,taskId)).task;
  await apply({type:'task.reopen',projectId:p,operationId:randomUUID(),taskId,expectedVersion:lifecycle.version,
    reason:'Prepare remediation'});
  const reopened=(await central.getTask(lead,p,taskId)).task;
  await apply({type:'task.start',projectId:p,operationId:randomUUID(),taskId,expectedVersion:reopened.version,
    reason:'Lifecycle-only restart cannot buy another Run'});
  const sameInput=(await central.getTask(lead,p,taskId)).task;
  await apply({type:'queue.amend',projectId:p,operationId:randomUUID(),queueId,entryId,expectedVersion:1,
    taskRevisionId:sameInput.currentRevisionId,reason:'Record lifecycle-only revision'});
  await apply({type:'queue.adopt',projectId:p,operationId:randomUUID(),queueId,expectedVersion:2});
  const rejectedOperationId=randomUUID(),rejectedRunId=randomUUID();
  const noNewInput=await central.execute(lead,{type:'queue.continue',projectId:p,operationId:rejectedOperationId,
    queueId,entryId,claimId,runId:rejectedRunId,runOperationId:rejectedOperationId,
    reason:'Attempt to repeat unchanged work',answeredQuestions:[]});
  assert.equal(noNewInput.status,'rejected');
  if(noNewInput.status==='rejected')assert.equal(noNewInput.code,'CONTINUATION_INPUT_UNCHANGED');
  assert.equal((await central.listResidentQueueAttempts(lead,p,claimId)).length,1);
  assert.equal((await pool.query('SELECT 1 FROM runtime_run WHERE project_id=$1 AND run_id=$2',[p,rejectedRunId])).rowCount,0);
  assert.equal((await pool.query('SELECT 1 FROM outbox_event WHERE project_id=$1 AND operation_id=$2',[p,rejectedOperationId])).rowCount,0);
  assert.equal((await central.getResidentQueue(lead,p,queueId)).entries[0]?.holdCode,null);
  const beforeFix=(await central.getTask(lead,p,taskId)).task;
  await apply({type:'task.reopen',projectId:p,operationId:randomUUID(),taskId,expectedVersion:beforeFix.version,
    reason:'Revise failed use case'});
  const beforeUpdate=(await central.getTask(lead,p,taskId)).task;
  await apply({type:'task.update',projectId:p,operationId:randomUUID(),taskId,expectedVersion:beforeUpdate.version,
    title:beforeUpdate.title,content:'Initial fixed work\n\nRemediation: cover the missing consumer use case.',
    acceptance:beforeUpdate.acceptance,owner:beforeUpdate.owner,reason:'Fix failed consumer use'});
  const updated=(await central.getTask(lead,p,taskId)).task;
  await apply({type:'task.start',projectId:p,operationId:randomUUID(),taskId,expectedVersion:updated.version,
    reason:'Seal corrected input'});
  const fixed=(await central.getTask(lead,p,taskId)).task;
  await apply({type:'queue.amend',projectId:p,operationId:randomUUID(),queueId,entryId,expectedVersion:2,
    taskRevisionId:fixed.currentRevisionId,reason:'Adopt corrected business input'});
  await apply({type:'queue.adopt',projectId:p,operationId:randomUUID(),queueId,expectedVersion:3});
  const secondRunId=randomUUID(),secondOperationId=randomUUID(),reason='Repair the failed consumer use case';
  const withoutAnswers={type:'queue.continue' as const,projectId:p,operationId:secondOperationId,queueId,entryId,
    claimId,runId:secondRunId,runOperationId:secondOperationId,reason};
  assert.deepEqual(queueCommandSchema.parse(withoutAnswers).answeredQuestions,[]);
  await apply(withoutAnswers);
  assert.equal((await central.listResidentQueueAttempts(lead,p,claimId)).length,2);
  const resumed=await central.getRuntimeRun(lead,p,secondRunId);
  assert.equal(resumed.sessionId,sessionId);
  assert.match(resumed.input,new RegExp(`Continuation reason: ${reason}`));
  assert.match(resumed.input,new RegExp(`Previous Run ${firstRunId}; previous Task channel ${sourceChannel.id}`));
  assert.match(resumed.input,/Remediation: cover the missing consumer use case/);
  assert.match(resumed.input,/no answered question is claimed/);
});

test('two concurrent creators cannot both take the 200th project queue slot',async()=>{
  const p=randomUUID();
  await pool.query('INSERT INTO project(project_id,title,created_at) VALUES($1,$2,now())',[p,'Queue limit race']);
  const queue=(id:string)=>({projectId:p,id,version:1,adoptedVersion:null,maxRuns:1,
    reason:'Capacity test',actorId:'lead',entries:[]});
  const fill=await pool.connect();try{
    await fill.query('BEGIN');const store=new PgResidentQueue(fill,p,grant,input,leader,binding);
    for(let n=0;n<199;n++)await store.createResidentQueue(queue(randomUUID()));
    await fill.query('COMMIT');
  }catch(error){await fill.query('ROLLBACK');throw error;}finally{fill.release();}
  const attempt=async()=>{
    const client=await pool.connect();try{
      await client.query('BEGIN');
      await new PgResidentQueue(client,p,grant,input,leader,binding).createResidentQueue(queue(randomUUID()));
      await client.query('COMMIT');return 'created';
    }catch(error){await client.query('ROLLBACK');
      if(error instanceof Error && 'code' in error && error.code==='QUEUE_LIMIT_REACHED')return error.code;
      throw error;
    }finally{client.release();}
  };
  assert.deepEqual((await Promise.all([attempt(),attempt()])).sort(),['QUEUE_LIMIT_REACHED','created'].sort());
  const counts=await pool.query(`SELECT
    (SELECT count(*)::int FROM resident_queue WHERE project_id=$1) AS queues,
    (SELECT count(*)::int FROM resident_queue_attempt WHERE project_id=$1) AS attempts,
    (SELECT count(*)::int FROM runtime_run WHERE project_id=$1) AS runs`,[p]);
  assert.deepEqual(counts.rows[0],{queues:200,attempts:0,runs:0});
});
