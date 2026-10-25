import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import pg from 'pg';
import { migrate } from '../src/index.ts';
import { PgResidentQueue } from '../src/queues.ts';
import { PostgresUnitOfWork } from '../src/index.ts';
import { RuntimeWorkflowService, WorkflowService } from '@evoloop/core';
import { canonicalTaskInputJson, taskInputSignature } from '../../core/src/task-input.ts';
import { createHash } from 'node:crypto';
const url=process.env.TEST_DATABASE_URL;
if(!url || !new URL(url).pathname.toLowerCase().includes('evoloop_test')) throw new Error('dedicated evoloop_test database required');
const schema=`el_queue_${randomUUID().replaceAll('-','').slice(0,16)}`;
const pool=new pg.Pool({connectionString:url,options:`-c search_path=${schema}`});
const uow=new PostgresUnitOfWork(pool);
const hash=(text:string)=>createHash('sha256').update(text).digest('hex');
const workflow=new WorkflowService({uow,clock:{now:()=>new Date().toISOString()},ids:{next:randomUUID},hasher:{hash}});
const runtime=new RuntimeWorkflowService({uow,clock:{now:()=>new Date().toISOString()},ids:{next:randomUUID}});
const projectId=randomUUID();const queueId=randomUUID();
const leader=async()=>true;const grant=async()=>true;const binding=async()=>true;const input=async()=>'{\"fixed\":true}';
before(async()=>{
  await migrate(url,schema);
  await pool.query(readFileSync(new URL('../schema/027_resident_session_queue.sql',import.meta.url),'utf8'));
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
    const store=new PgResidentQueue(setup,p,grant,input,leader,binding);await store.createResidentQueue({projectId:p,id:q,version:1,adoptedVersion:null,maxRuns:3,reason:'one bounded Task',actorId:'lead',entries:[{projectId:p,queueId:q,id:entry,taskId:task,taskRevisionId:rev,sourceInputJson:'{\"fixed\":true}',sessionId:session,roleId:role,position:0,dependsOn:[],consumerId:'consumer',useRequired:true,releaseRule:'accepted',state:'queued',holdCode:null,holdReason:null,claimId:null,version:1}]});await store.adoptResidentQueue(q,1,'lead');
    await setup.query('COMMIT');
  }catch(e){await setup.query('ROLLBACK');throw e;}finally{setup.release();}
  const ids={claimId:randomUUID(),runId:randomUUID(),operationId:randomUUID()};
  const a=await pool.connect(),b=await pool.connect();try{
    await a.query('BEGIN');const sa=new PgResidentQueue(a,p,grant,input,leader,binding);const first=await sa.claimResidentQueue(q,entry,ids.claimId,{runId:ids.runId,operationId:ids.operationId,taskRevisionId:rev});assert.equal(first?.claimId,ids.claimId);
    const competing=(async()=>{await b.query('BEGIN');const sb=new PgResidentQueue(b,p,grant,input,leader,binding);const result=await sb.claimResidentQueue(q,entry,ids.claimId,{runId:ids.runId,operationId:ids.operationId,taskRevisionId:rev});await b.query('COMMIT');return result;})();
    await a.query('COMMIT');assert.equal((await competing)?.claimId,ids.claimId);
    await a.query('BEGIN');assert.equal((await sa.listReconcile()).length,1);assert.equal((await sa.listResidentQueueAttempts(ids.claimId)).length,1);
    await a.query(`INSERT INTO runtime_run(project_id,run_id,task_id,task_revision_id,basis_set_id,session_id,operation_id,input,input_hash,state,version,native_turn_id,interrupt_requested,actor_id,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,'fixed',repeat('b',64),'completed',1,$8,false,'lead',now(),now())`,[p,ids.runId,task,rev,basis,session,ids.operationId,'turn-'+ids.runId]);
    const secondIds={runId:randomUUID(),operationId:randomUUID()};
    const next=await sa.appendResidentQueueAttempt(ids.claimId,{...secondIds,taskRevisionId:rev},3);
    assert.equal(next?.sequence,2);
    await a.query(`INSERT INTO runtime_run(project_id,run_id,task_id,task_revision_id,basis_set_id,session_id,operation_id,input,input_hash,state,version,interrupt_requested,actor_id,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,'fixed',repeat('b',64),'unknown',1,false,'lead',now(),now())`,[p,secondIds.runId,task,rev,basis,session,secondIds.operationId]);
    assert.equal(await sa.appendResidentQueueAttempt(ids.claimId,{runId:randomUUID(),operationId:randomUUID(),taskRevisionId:rev},3),null);
    await a.query("UPDATE runtime_run SET state='completed',native_turn_id=$3,version=2,updated_at=now() WHERE project_id=$1 AND run_id=$2",[p,secondIds.runId,'turn-'+secondIds.runId]);
    assert.equal((await sa.appendResidentQueueAttempt(ids.claimId,{runId:randomUUID(),operationId:randomUUID(),taskRevisionId:rev},3))?.sequence,3);
    assert.equal(await sa.appendResidentQueueAttempt(ids.claimId,{runId:randomUUID(),operationId:randomUUID(),taskRevisionId:rev},3),null);
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
  await runtime.bindSession(p,session,{owner:'evoloop-codex-app-server',projectId:p,sessionId:session,roleId:role,cwd:'/tmp/queue',authorizationScope:'project',nativeThreadId:'thread-'+session,nativeSessionId:'native-'+session});
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
    const claimId=randomUUID();assert.equal((await queue.claimResidentQueue(q,entryA,claimId,{runId,operationId:randomUUID(),taskRevisionId:revisionA}))?.claimId,claimId);
    assert.equal(await queue.claimResidentQueue(q,entryB,randomUUID(),{runId:randomUUID(),operationId:randomUUID(),taskRevisionId:revisionB}),null);
    await work.query('COMMIT');
    const task=(await uow.read(p,r=>r.getTask(taskA)))!;
    await apply({type:'runtime.run.reserve',projectId:p,operationId:randomUUID(),runId,taskId:taskA,sessionId:session,expectedVersion:task.version,input:'Execute fixed Task A'});
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
    await work.query('BEGIN');assert.equal(await queue.releaseResidentQueueAccepted(claimId),true);const second=await queue.claimResidentQueue(q,entryB,randomUUID(),{runId:randomUUID(),operationId:randomUUID(),taskRevisionId:revisionB});assert.ok(second);await work.query('COMMIT');
    assert.equal(await queue.countResidentQueueAttempts(q),2);
    await assert.rejects(pool.query('INSERT INTO resident_queue_attempt(project_id,claim_id,sequence,run_id,operation_id,task_revision_id) VALUES($1,$2,2,$3,$4,$5)',[p,second!.claimId,randomUUID(),randomUUID(),revisionB]),/run budget exhausted/);
  }catch(e){await work.query('ROLLBACK');throw e;}finally{work.release();}
});
