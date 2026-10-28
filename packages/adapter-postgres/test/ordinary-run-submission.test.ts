import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { before, after, test } from 'node:test';
import pg from 'pg';
import { migrate } from '../src/index.ts';
import { PgOrdinaryRunSubmissionStore, type OrdinaryRunSubmissionRecord } from '../src/ordinary-run-submission.ts';

const url=process.env.TEST_DATABASE_URL;
if(!url||!/^evoloop(?:_[a-z0-9]+)*_test$/.test(decodeURIComponent(new URL(url).pathname.slice(1))))
  throw new Error('ordinary Run submission tests require a dedicated evoloop test database');
const schema=`el_ordinary_submission_${randomUUID().replaceAll('-','').slice(0,12)}`;
const pool=new pg.Pool({connectionString:url,options:`-c search_path=${schema}`});
const projectId=randomUUID(),taskId=randomUUID(),revisionId=randomUUID(),basisId=randomUUID();
const sessionId=randomUUID(),runId=randomUUID(),runOperationId=randomUUID(),documentId=randomUUID(),documentRevisionId=randomUUID();
const now='2026-10-29T00:00:00.000Z';
const hash='a'.repeat(64);
const intent={artifactRef:'artifact',artifactRevision:'1',contentHash:hash,technicalResult:'passed' as const,
  technicalEvidence:'check passed',reason:'ready for review'};

before(async()=>{
  await migrate(url!,schema);
  const setup=await pool.connect();
  try{
  await setup.query('BEGIN');
  await setup.query('INSERT INTO project(project_id,title,created_at) VALUES($1,$2,$3)',[projectId,'Submission test',now]);
  await setup.query(`INSERT INTO process_document(project_id,document_id,title,version,current_revision_id,adopted_revision_id,kind,status)
    VALUES($1,$2,'Task',1,$3,NULL,'task','draft')`,[projectId,documentId,documentRevisionId]);
  await setup.query(`INSERT INTO document_revision(project_id,document_id,revision_id,body,format,content_hash,author,created_at,reason,media_type,original_name,assets_manifest)
    VALUES($1,$2,$3,'# Task','markdown',$4,'lead',$5,'fixed','text/markdown','task.md','[]'::jsonb)`,
    [projectId,documentId,documentRevisionId,hash,now]);
  await setup.query(`INSERT INTO task(project_id,task_id,version,current_revision_id,title,acceptance,owner,state,kind,content_document_id,content_revision_id)
    VALUES($1,$2,1,$3,'Task','check','worker','in_progress',NULL,$4,$5)`,
    [projectId,taskId,revisionId,documentId,documentRevisionId]);
  await setup.query(`INSERT INTO task_revision(project_id,task_id,revision_id,version,title,acceptance,owner,state,basis_set_id,actor_id,reason,created_at,kind,content_document_id,content_revision_id)
    VALUES($1,$2,$3,1,'Task','check','worker','in_progress',$4,'lead','fixed',$5,NULL,$6,$7)`,
    [projectId,taskId,revisionId,basisId,now,documentId,documentRevisionId]);
  await setup.query(`INSERT INTO basis_set(project_id,task_id,task_revision_id,basis_set_id,sealed)
    VALUES($1,$2,$3,$4,false)`,[projectId,taskId,revisionId,basisId]);
  await setup.query(`INSERT INTO basis_member(project_id,task_id,task_revision_id,basis_set_id,document_id,document_revision_id)
    VALUES($1,$2,$3,$4,$5,$6)`,[projectId,taskId,revisionId,basisId,documentId,documentRevisionId]);
  await setup.query('UPDATE basis_set SET sealed=true WHERE project_id=$1 AND task_id=$2 AND basis_set_id=$3',
    [projectId,taskId,basisId]);
  await setup.query(`INSERT INTO runtime_session(project_id,session_id,role_id,cwd,authorization_scope,sandbox,approval_policy,
    state,version,native_thread_id,native_session_id,operation_id,actor_id,created_at,updated_at)
    VALUES($1,$2,'worker','/tmp','project','danger-full-access','never','ready',1,'thread','native',$3,'reserver',$4,$4)`,
    [projectId,sessionId,randomUUID(),now]);
  await setup.query(`INSERT INTO runtime_run(project_id,run_id,task_id,task_revision_id,basis_set_id,session_id,operation_id,
    input,input_hash,state,version,native_turn_id,actor_id,created_at,updated_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,'fixed',$8,'completed',1,'turn','reserver',$9,$9)`,
    [projectId,runId,taskId,revisionId,basisId,sessionId,runOperationId,hash,now]);
  await setup.query('COMMIT');
  }catch(e){await setup.query('ROLLBACK');throw e;}finally{setup.release();}
});
after(async()=>{await pool.end();const c=new pg.Client({connectionString:url});await c.connect();
  try{await c.query(`DROP SCHEMA "${schema}" CASCADE`);}finally{await c.end();}});

test('first signed intent is unique, fixed, versioned and scoped to explicit recipient authority',async()=>{
  const client=await pool.connect();
  try{
    const store=new PgOrdinaryRunSubmissionStore(client,projectId);
    assert.equal((await store.getRun(runId))?.inputHash,hash);
    assert.equal(await store.hasManagedDispatch(runId),false);
    assert.equal(await store.getFixedRecipient(runId),null,'Run reservation actor is not recipient authority');
    await client.query(`INSERT INTO task_session_assignment(project_id,task_id,version,task_revision_id,target_kind,target_id,
      recipient_actor_id,state,actor_id,reason,updated_at) VALUES($1,$2,1,$3,'owned',$4,'worker','assigned','lead','assigned',$5)`,
      [projectId,taskId,revisionId,sessionId,now]);
    assert.equal(await store.getFixedRecipient(runId),'worker');
    const first:OrdinaryRunSubmissionRecord={projectId,id:randomUUID(),runId,taskId,sessionId,taskRevisionId:revisionId,
      runInputHash:hash,operationId:randomUUID(),commandHash:hash,deliveryOperationId:randomUUID(),deliveryIntent:intent,
      submittedBy:'worker',state:'submitted',version:1,expectedTaskVersion:null,terminalRunVersion:null,
      sealedBy:null,deliveryId:null,reason:null,createdAtUtc:now,updatedAtUtc:now};
    await assert.rejects(store.insert({...first,state:'blocked',reason:'forged initial settlement'}),
      /First Run submission must be an unsealed intent/);
    await store.insert(first);
    assert.deepEqual(await store.get(runId),first);
    assert.equal((await store.getByOperationId(first.operationId))?.id,first.id);
    assert.equal((await store.listUnsettled()).length,1);
    await assert.rejects(store.insert({...first,id:randomUUID(),operationId:randomUUID(),deliveryOperationId:randomUUID()}),
      /duplicate key/);
    await assert.rejects(store.insert({...first,runId:randomUUID()}),/fixed binding|foreign key/);
    await assert.rejects(store.update({...first,submittedBy:'reserver',state:'sealing',version:2},1),/original intent/);
    await assert.rejects(store.update({...first,state:'sealing',version:2},2),/version changed/);
    const sealFields={expectedTaskVersion:1,terminalRunVersion:1,sealedBy:'coordinator'};
    await store.update({...first,...sealFields,state:'sealing',version:2,updatedAtUtc:'2026-10-29T00:01:00.000Z'},1);
    assert.equal((await store.get(runId))?.version,2);
    const blockedReason='Delivery receipt is unresolved; reconcile before retry';
    await store.update({...first,...sealFields,state:'unknown',version:3,reason:blockedReason,
      updatedAtUtc:'2026-10-29T00:02:00.000Z'},2);
    assert.equal((await store.get(runId))?.reason,blockedReason);
    await store.update({...first,...sealFields,state:'sealing',version:4,reason:blockedReason,
      updatedAtUtc:'2026-10-29T00:03:00.000Z'},3);
    assert.equal((await store.get(runId))?.state,'sealing');
    assert.equal((await store.get(runId))?.reason,blockedReason,'retry retains the blocked reason for review');
    await assert.rejects(client.query('DELETE FROM ordinary_run_submission WHERE project_id=$1 AND run_id=$2',[projectId,runId]),
      /cannot be deleted/);
  }finally{client.release();}
});

test('reserved Delivery operation is checked against the workflow journal',async()=>{
  const client=await pool.connect();
  const operationId=randomUUID();
  try{
    const store=new PgOrdinaryRunSubmissionStore(client,projectId);
    assert.equal(await store.hasWorkflowOperation(operationId),false);
    await client.query(`INSERT INTO operation_journal(project_id,operation_id,actor_id,command_hash,command_type,result,created_at)
      VALUES($1,$2,'worker',$3,'document.create',$4::jsonb,$5)`,
      [projectId,operationId,hash,JSON.stringify({status:'applied',operationId,entityId:documentId,version:1}),now]);
    assert.equal(await store.hasWorkflowOperation(operationId),true);
  }finally{client.release();}
});

test('a later workflow command cannot consume the signed Delivery operation ID',async()=>{
  const client=await pool.connect();
  try{
    const saved=await new PgOrdinaryRunSubmissionStore(client,projectId).get(runId);
    assert.ok(saved);
    await client.query('BEGIN');
    await client.query(`INSERT INTO operation_journal(project_id,operation_id,actor_id,command_hash,command_type,result,created_at)
      VALUES($1,$2,'worker',$3,'document.create',$4::jsonb,$5)`,
      [projectId,saved.deliveryOperationId,hash,
        JSON.stringify({status:'applied',operationId:saved.deliveryOperationId,entityId:documentId,version:1}),now]);
    await assert.rejects(client.query('COMMIT'),/reserved for a signed Run submission/);
    await client.query('ROLLBACK');
    assert.equal(await new PgOrdinaryRunSubmissionStore(client,projectId).hasWorkflowOperation(saved.deliveryOperationId),false);
  }finally{client.release();}
});

test('the signer can read a definite rejection of the reserved Delivery operation',async()=>{
  const client=await pool.connect();
  try{
    const saved=await new PgOrdinaryRunSubmissionStore(client,projectId).get(runId);
    assert.ok(saved);
    await client.query('BEGIN');
    await client.query(`INSERT INTO operation_journal(project_id,operation_id,actor_id,command_hash,command_type,result,created_at)
      VALUES($1,$2,$3,$4,'delivery.record',$5::jsonb,$6)`,
      [projectId,saved.deliveryOperationId,saved.submittedBy,hash,
        JSON.stringify({status:'rejected',operationId:saved.deliveryOperationId,code:'VERSION_CONFLICT',message:'Task changed'}),now]);
    await client.query('COMMIT');
    assert.equal(await new PgOrdinaryRunSubmissionStore(client,projectId).hasWorkflowOperation(saved.deliveryOperationId),true);
  }catch(error){await client.query('ROLLBACK');throw error;}
  finally{client.release();}
});

test('queue attempt requires its exact collaboration recipient, not the Run or Session creator',async()=>{
  const client=await pool.connect();
  const queueId=randomUUID(),entryId=randomUUID(),claimId=randomUUID(),roleId=randomUUID(),roleRevisionId=randomUUID();
  const discussionId=randomUUID(),channelDocumentId=randomUUID(),channelRevisionId=randomUUID();
  const queueRunId=randomUUID(),queueRunOperationId=randomUUID();
  try{
    await client.query('BEGIN');
    const store=new PgOrdinaryRunSubmissionStore(client,projectId);
    assert.equal((await store.getRun(runId))?.actorId,'reserver');
    const session=await client.query('SELECT actor_id FROM runtime_session WHERE project_id=$1 AND session_id=$2',
      [projectId,sessionId]);
    assert.equal(session.rows[0].actor_id,'reserver');
    assert.equal(await store.getFixedRecipient(runId),'worker','static owned assignment supports this Run before queue linkage');

    const fixedInput=JSON.stringify({protocol:'evoloop-run-v2',taskId,taskRevisionId:revisionId,basisSetId:basisId,
      kind:'queue.claim',reason:null,previousRun:null,answers:[],
      channel:{discussionId,recipientActorId:'queue-recipient',issuerActorId:'lead'}});
    await client.query(`INSERT INTO runtime_run(project_id,run_id,task_id,task_revision_id,basis_set_id,session_id,operation_id,
      input,input_hash,state,version,native_turn_id,actor_id,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'completed',1,'queue-turn','reserver',$10,$10)`,
      [projectId,queueRunId,taskId,revisionId,basisId,sessionId,queueRunOperationId,fixedInput,
        createHash('sha256').update(fixedInput).digest('hex'),now]);

    await client.query(`INSERT INTO role_definition(project_id,role_id,version,current_revision_id,state,proposed_by,
      created_at_utc,review_at_utc,trial_started_at_utc)
      VALUES($1,$2,1,$3,'trial','lead',$4,$4,$4)`,[projectId,roleId,roleRevisionId,now]);
    await client.query(`INSERT INTO role_revision(project_id,role_id,revision_id,version,state,proposal,actor_id,reason,
      created_at_utc,review_at_utc) VALUES($1,$2,$3,1,'trial','{}'::jsonb,'lead','queue role',$4,$4)`,
      [projectId,roleId,roleRevisionId,now]);
    await client.query(`INSERT INTO resident_queue(project_id,queue_id,version,max_runs,reason,actor_id,created_at,updated_at)
      VALUES($1,$2,1,1,'queue recipient fixture','lead',$3,$3)`,[projectId,queueId,now]);
    await client.query(`INSERT INTO resident_queue_entry(project_id,queue_id,entry_id,task_id,task_revision_id,
      source_input_json,session_id,role_id,position,consumer_id,use_required,release_rule,state,claim_id,
      created_at,updated_at) VALUES($1,$2,$3,$4,$5,'fixed',$6,$7,0,'lead',false,'accepted','claimed',$8,$9,$9)`,
      [projectId,queueId,entryId,taskId,revisionId,sessionId,roleId,claimId,now]);
    await client.query(`INSERT INTO resident_queue_claim(project_id,queue_id,entry_id,claim_id,task_id,session_id,
      role_id,claimed_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
      [projectId,queueId,entryId,claimId,taskId,sessionId,roleId,now]);
    await client.query(`INSERT INTO resident_queue_attempt(project_id,claim_id,sequence,run_id,operation_id,
      task_revision_id,reserved_at) VALUES($1,$2,1,$3,$4,$5,$6)`,
      [projectId,claimId,queueRunId,queueRunOperationId,revisionId,now]);
    assert.equal(await store.getFixedRecipient(queueRunId),null,
      'a queue attempt must not fall back to the static assignment without its channel');

    await client.query(`INSERT INTO process_document(project_id,document_id,title,version,current_revision_id,
      adopted_revision_id,kind,status) VALUES($1,$2,'Queue channel',1,$3,NULL,'discussion','draft')`,
      [projectId,channelDocumentId,channelRevisionId]);
    await client.query(`INSERT INTO document_revision(project_id,document_id,revision_id,body,format,content_hash,
      author,created_at,reason,media_type,original_name,assets_manifest)
      VALUES($1,$2,$3,'# Queue channel','markdown',$4,'lead',$5,'fixed','text/markdown','channel.md','[]'::jsonb)`,
      [projectId,channelDocumentId,channelRevisionId,hash,now]);
    await client.query(`INSERT INTO discussion(project_id,discussion_id,version,kind,status,document_id,
      prepared_document_revision_id,current_document_revision_id,task_id,task_revision_id,question,options,
      authorization_boundary,target_session_label,actor_id,created_at,updated_at,collaboration_run_id,
      collaboration_session_id,collaboration_issuer_actor_id,collaboration_recipient_actor_id)
      VALUES($1,$2,1,'task_collaboration','prepared',$3,$4,$5,$6,$7,'','[]'::jsonb,'','',
        'lead',$8,$8,$9,$10,'lead','queue-recipient')`,
      [projectId,discussionId,channelDocumentId,channelRevisionId,channelRevisionId,taskId,revisionId,now,queueRunId,sessionId]);
    assert.equal(await store.getFixedRecipient(queueRunId),'queue-recipient');
    assert.notEqual(await store.getFixedRecipient(queueRunId),session.rows[0].actor_id);
    assert.notEqual(await store.getFixedRecipient(queueRunId),'worker');
    const extraDiscussionId=randomUUID(),extraDocumentId=randomUUID(),extraRevisionId=randomUUID();
    await client.query(`INSERT INTO process_document(project_id,document_id,title,version,current_revision_id,
      adopted_revision_id,kind,status) VALUES($1,$2,'Other channel',1,$3,NULL,'discussion','draft')`,
      [projectId,extraDocumentId,extraRevisionId]);
    await client.query(`INSERT INTO document_revision(project_id,document_id,revision_id,body,format,content_hash,
      author,created_at,reason,media_type,original_name,assets_manifest)
      VALUES($1,$2,$3,'# Other','markdown',$4,'lead',$5,'fixed','text/markdown','other.md','[]'::jsonb)`,
      [projectId,extraDocumentId,extraRevisionId,hash,now]);
    await client.query(`INSERT INTO discussion(project_id,discussion_id,version,kind,status,document_id,
      prepared_document_revision_id,current_document_revision_id,task_id,task_revision_id,question,options,
      authorization_boundary,target_session_label,actor_id,created_at,updated_at,collaboration_run_id,
      collaboration_session_id,collaboration_issuer_actor_id,collaboration_recipient_actor_id)
      VALUES($1,$2,1,'task_collaboration','prepared',$3,$4,$4,$5,$6,'','[]'::jsonb,'','',
        'lead',$7,$7,$8,$9,'lead','other-recipient')`,
      [projectId,extraDiscussionId,extraDocumentId,extraRevisionId,taskId,revisionId,now,queueRunId,sessionId]);
    assert.equal(await store.getFixedRecipient(queueRunId),'queue-recipient',
      'another channel for this Run cannot replace its input-pinned recipient');
    await client.query('COMMIT');
  }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
});
