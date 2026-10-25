import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import pg from 'pg';
import { migrate } from '../src/index.ts';
import { PgResidentQueue } from '../src/queues.ts';
const url=process.env.TEST_DATABASE_URL;
if(!url || !new URL(url).pathname.toLowerCase().includes('evoloop_test')) throw new Error('dedicated evoloop_test database required');
const schema=`el_queue_${randomUUID().replaceAll('-','').slice(0,16)}`;
const pool=new pg.Pool({connectionString:url,options:`-c search_path=${schema}`});
const projectId=randomUUID();const queueId=randomUUID();
const leader=async()=>true;const grant=async()=>true;
before(async()=>{
  await migrate(url,schema);
  await pool.query(readFileSync(new URL('../schema/027_resident_session_queue.sql',import.meta.url),'utf8'));
  await pool.query('INSERT INTO project(project_id,title,created_at) VALUES($1,$2,now())',[projectId,'Queue test']);
});
after(async()=>{await pool.end();const c=new pg.Client({connectionString:url});await c.connect();try{await c.query(`DROP SCHEMA "${schema}" CASCADE`);}finally{await c.end();}});
test('unadopted version is held and adoption is CAS',async()=>{
  const client=await pool.connect();try{await client.query('BEGIN');const store=new PgResidentQueue(client,projectId,grant,leader);
    await store.create(queueId,'lead','ordered for value and dependency',[]);
    assert.equal((await store.list(queueId))?.adoptedVersion,null);
    await store.adopt(queueId,1,'lead');
    assert.equal((await store.list(queueId))?.adoptedVersion,1);
    await assert.rejects(store.adopt(queueId,2,'lead'),/QUEUE_VERSION_CONFLICT/);
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
      VALUES($1,$2,1,$3,'Task','check','lead','in_progress',NULL,$4,$5)`,[p,task,rev,doc,dr]);
    await setup.query(`INSERT INTO task_revision(project_id,task_id,revision_id,version,title,acceptance,owner,state,basis_set_id,actor_id,reason,created_at,kind,content_document_id,content_revision_id)
      VALUES($1,$2,$3,1,'Task','check','lead','in_progress',$4,'lead','fixed',now(),NULL,$5,$6)`,[p,task,rev,basis,doc,dr]);
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
    const store=new PgResidentQueue(setup,p,grant,leader);await store.create(q,'lead','one bounded Task',[{id:entry,taskId:task,taskRevisionId:rev,sessionId:session,roleId:role,position:0,dependsOn:[],consumerId:'consumer',useRequired:true,releaseRule:'accepted'}]);await store.adopt(q,1,'lead');
    await setup.query('COMMIT');
  }catch(e){await setup.query('ROLLBACK');throw e;}finally{setup.release();}
  const ids={claimId:randomUUID(),runId:randomUUID(),operationId:randomUUID()};
  const a=await pool.connect(),b=await pool.connect();try{
    await a.query('BEGIN');const sa=new PgResidentQueue(a,p,grant,leader);const first=await sa.claim(q,entry,1,ids);assert.equal(first?.operationId,ids.operationId);
    const competing=(async()=>{await b.query('BEGIN');const sb=new PgResidentQueue(b,p,grant,leader);const result=await sb.claim(q,entry,1,ids);await b.query('COMMIT');return result;})();
    await a.query('COMMIT');assert.equal((await competing)?.claimId,ids.claimId);
    await a.query('BEGIN');assert.equal((await sa.listReconcile()).length,1);assert.equal(await sa.markClaim(ids.claimId,'intent','dispatching'),true);assert.equal(await sa.markClaim(ids.claimId,'dispatching','unknown','native response missing'),true);
    await assert.rejects(sa.markClaim(ids.claimId,'unknown','terminal',null,null),/original native Turn readback/);
    assert.equal(await sa.markClaim(ids.claimId,'unknown','terminal','original Turn readback','turn-'+session),true);
    assert.equal(await sa.releaseAccepted(ids.claimId),false);await assert.rejects(sa.assertQueueVacant(task,session),/QUEUE_OCCUPIED/);await a.query('COMMIT');
  }catch(e){await a.query('ROLLBACK');await b.query('ROLLBACK');throw e;}finally{a.release();b.release();}
});
