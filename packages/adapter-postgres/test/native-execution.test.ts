import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { runner } from 'node-pg-migrate';
import { migrate } from '../src/index.ts';

const url = process.env.TEST_DATABASE_URL;
if (!url || !/^evoloop(?:_[a-z0-9]+)*_test$/.test(decodeURIComponent(new URL(url).pathname.slice(1))))
  throw new Error('native retirement test requires a dedicated evoLoop test database');
const schema = `el_native_retire_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
const migrations = fileURLToPath(new URL('../migrations/', import.meta.url));
const client = new pg.Client({ connectionString: url, options: `-c search_path=${schema}` });
const ids = () => randomUUID();
const now = '2026-10-27T00:00:00.000Z';
const fingerprint = 'c'.repeat(64);
const project = ids(), role = ids();
const oldSession = ids(), oldMessage = ids(), oldProcessing = ids(), oldOperation = ids();
const control = { epoch: 9, owner: ids() };

async function rejectsSql(sql: string, values: unknown[], pattern: RegExp): Promise<void> {
  await client.query('SAVEPOINT expected_rejection');
  try { await assert.rejects(client.query(sql, values), pattern); }
  finally { await client.query('ROLLBACK TO SAVEPOINT expected_rejection'); await client.query('RELEASE SAVEPOINT expected_rejection'); }
}

after(async () => {
  await client.end();
  const cleanup = new pg.Client({ connectionString: url });
  await cleanup.connect();
  try { await cleanup.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); }
  finally { await cleanup.end(); }
});

test('036 retires 035 cold admission without rewriting historical epoch or bypassing recovery', async () => {
  // 035 was the last shipped cold-control schema. Keep its real fence active while
  // creating the historical observation, then migrate forward in place.
  await runner({ databaseUrl: url!, dir: migrations, migrationsTable: 'pgmigrations', schema,
    createSchema: true, createMigrationsSchema: true, direction: 'up', singleTransaction: true,
    count: 34, log: () => {} });
  await client.connect();
  await client.query('BEGIN');
  try {
    await client.query('INSERT INTO project(project_id,title,created_at) VALUES($1,$2,$3)',
      [project, 'Cold control retirement fixture', now]);
    await client.query(`INSERT INTO runtime_session(project_id,session_id,role_id,cwd,authorization_scope,model,
      sandbox,approval_policy,state,version,native_thread_id,native_session_id,operation_id,actor_id,created_at,updated_at)
      VALUES($1,$2,$3,'/tmp/native-retire','project','old-model','read-only','on-request','ready',1,$4,$4,$5,'worker',$6,$6)`,
      [project, oldSession, role, `native-${oldSession}`, ids(), now]);
    await client.query(`INSERT INTO session_message(project_id,message_id,operation_id,target_kind,session_id,
      sender_actor_id,content,state,version,created_at,updated_at)
      VALUES($1,$2,$3,'owned',$4,'sender','Historical message','queued',1,$5,$5)`,
      [project, oldMessage, ids(), oldSession, now]);
    await client.query(`INSERT INTO native_execution_environment(singleton,epoch,mode,target_purpose,target_project_id,
      target_session_id,target_thread_id,target_message_id,operation_id,owner_nonce,owner_pid,owner_start_identity,
      observed_policy_hash,verified_at,reason,updated_at)
      VALUES(true,$1,'message_verified','message',$2,$3,$4,$5,$6,$7,32001,'pid:32001:start:42',$8,$9,'035 verified fixture',$9)`,
      [control.epoch, project, oldSession, `native-${oldSession}`, oldMessage, oldOperation, control.owner, fingerprint, now]);
    await client.query('SELECT set_config($1,$2,true)', ['evoloop.native_execution_startup', JSON.stringify({
      kind: 'message', epoch: String(control.epoch), projectId: project, sessionId: oldSession,
      operationId: oldOperation, messageId: oldMessage,
    })]);
    await client.query(`INSERT INTO session_message_processing(project_id,processing_id,message_id,session_id,
      operation_id,receiver_actor_id,state,read_only_policy_fingerprint,version,started_at,updated_at)
      VALUES($1,$2,$3,$4,$5,'worker','dispatching',$6,1,$7,$7)`,
      [project, oldProcessing, oldMessage, oldSession, oldOperation, fingerprint, now]);
    await client.query(`UPDATE session_message_processing SET state='unknown',version=2,updated_at=now()
      WHERE project_id=$1 AND processing_id=$2`, [project, oldProcessing]);
    await client.query(`UPDATE native_execution_environment SET mode='unknown',reason='Original reply lost',updated_at=now()
      WHERE singleton=true`);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }

  const before = {
    control: (await client.query('SELECT to_jsonb(e) AS row FROM native_execution_environment e')).rows[0]?.row,
    processing: (await client.query('SELECT to_jsonb(p) AS row FROM session_message_processing p WHERE processing_id=$1',
      [oldProcessing])).rows[0]?.row,
    gate: (await client.query('SELECT to_jsonb(g) AS row FROM session_recovery_gate g WHERE session_id=$1',
      [oldSession])).rows[0]?.row,
  };
  assert.equal(before.control.mode, 'unknown');
  assert.equal(before.processing.native_environment_epoch, control.epoch);
  assert.equal(before.gate.phase, 'blocked');
  await migrate(url!, schema);
  assert.deepEqual((await client.query('SELECT to_jsonb(e) AS row FROM native_execution_environment e')).rows[0]?.row,
    before.control, 'migration preserves the historical control row');
  assert.deepEqual((await client.query('SELECT to_jsonb(p) AS row FROM session_message_processing p WHERE processing_id=$1',
    [oldProcessing])).rows[0]?.row, before.processing, 'migration preserves the original operation and epoch');
  assert.deepEqual((await client.query('SELECT to_jsonb(g) AS row FROM session_recovery_gate g WHERE session_id=$1',
    [oldSession])).rows[0]?.row, before.gate, 'migration preserves the unresolved recovery gate');
  const triggers = (await client.query(`SELECT tgname FROM pg_trigger WHERE tgrelid IN
    ('runtime_session'::regclass,'runtime_run'::regclass,'session_message_processing'::regclass)
    AND NOT tgisinternal`)).rows.map(row => row.tgname);
  assert.equal(triggers.some(name => name.startsWith('zz_') && name.endsWith('_native_execution_fence')), false);
  assert.equal(triggers.filter(name => name.endsWith('_epoch_guard')).length, 3);

  await client.query('BEGIN');
  try {
    const creating = ids(), runSession = ids(), messageSession = ids();
    const addSession = async (sessionId: string, state: 'reserved' | 'ready') => client.query(`
      INSERT INTO runtime_session(project_id,session_id,role_id,cwd,authorization_scope,model,sandbox,
        approval_policy,state,version,native_thread_id,native_session_id,operation_id,actor_id,created_at,updated_at)
      VALUES($1,$2,$3,'/tmp/native-retire','project','new-model','danger-full-access','never',$4,1,$5,$5,$6,'worker',$7,$7)`,
      [project, sessionId, role, state, state === 'ready' ? `native-${sessionId}` : null, ids(), now]);
    await addSession(creating, 'reserved');
    await client.query(`UPDATE runtime_session SET state='creating',version=2,updated_at=now()
      WHERE project_id=$1 AND session_id=$2`, [project, creating]);
    await addSession(runSession, 'ready');
    await addSession(messageSession, 'ready');
    const document = ids(), documentRevision = ids(), task = ids(), taskRevision = ids(), basis = ids(), run = ids();
    await client.query(`INSERT INTO process_document(project_id,document_id,title,version,current_revision_id,kind,status)
      VALUES($1,$2,'Run task',1,$3,'task','draft')`, [project, document, documentRevision]);
    await client.query(`INSERT INTO document_revision(project_id,document_id,revision_id,body,format,content_hash,author,created_at,reason)
      VALUES($1,$2,$3,'Fixed task','markdown',$4,'lead',$5,'fixture')`,
      [project, document, documentRevision, fingerprint, now]);
    await client.query(`INSERT INTO task(project_id,task_id,version,current_revision_id,title,acceptance,owner,state,
      content_document_id,content_revision_id) VALUES($1,$2,1,$3,'Run task','Review',$4,'in_progress',$5,$6)`,
      [project, task, taskRevision, role, document, documentRevision]);
    await client.query(`INSERT INTO task_revision(project_id,task_id,revision_id,version,title,acceptance,owner,state,
      basis_set_id,actor_id,reason,created_at,content_document_id,content_revision_id)
      VALUES($1,$2,$3,1,'Run task','Review',$7,'in_progress',$4,'lead','fixture',$8,$5,$6)`,
      [project, task, taskRevision, basis, document, documentRevision, role, now]);
    await client.query(`INSERT INTO basis_set(project_id,task_id,task_revision_id,basis_set_id,sealed)
      VALUES($1,$2,$3,$4,true)`, [project, task, taskRevision, basis]);
    await client.query(`INSERT INTO runtime_run(project_id,run_id,task_id,task_revision_id,basis_set_id,session_id,
      operation_id,input,input_hash,state,version,actor_id,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,'Fixed input','hash','requested',1,'worker',$8,$8)`,
      [project, run, task, taskRevision, basis, runSession, ids(), now]);
    await client.query(`UPDATE runtime_run SET state='dispatching',version=2,updated_at=now()
      WHERE project_id=$1 AND run_id=$2`, [project, run]);
    const message = ids();
    await client.query(`INSERT INTO session_message(project_id,message_id,operation_id,target_kind,session_id,
      sender_actor_id,content,state,version,created_at,updated_at)
      VALUES($1,$2,$3,'owned',$4,'sender','Current message','queued',1,$5,$5)`,
      [project, message, ids(), messageSession, now]);
    await client.query(`INSERT INTO session_message_processing(project_id,processing_id,message_id,session_id,
      operation_id,receiver_actor_id,state,read_only_policy_fingerprint,version,started_at,updated_at)
      VALUES($1,$2,$3,$4,$5,'worker','dispatching',$6,1,$7,$7)`,
      [project, ids(), message, messageSession, ids(), fingerprint, now]);
    const freshEpochs = await client.query(`SELECT native_environment_epoch FROM runtime_session
      WHERE project_id=$1 AND session_id=$2 UNION ALL SELECT native_environment_epoch FROM runtime_run
      WHERE project_id=$1 AND run_id=$3 UNION ALL SELECT native_environment_epoch FROM session_message_processing
      WHERE project_id=$1 AND message_id=$4`, [project, creating, run, message]);
    assert.deepEqual(freshEpochs.rows.map(row => row.native_environment_epoch), [null, null, null]);
    await rejectsSql(`INSERT INTO session_message_processing(project_id,processing_id,message_id,session_id,
      operation_id,receiver_actor_id,state,read_only_policy_fingerprint,version,started_at,updated_at)
      VALUES($1,$2,$3,$4,$5,'worker','dispatching',$6,1,$7,$7)`,
      [project, ids(), oldMessage, oldSession, ids(), fingerprint, now], /Session recovery gate blocks native startup/);
    await rejectsSql(`UPDATE session_message_processing SET native_environment_epoch=10
      WHERE project_id=$1 AND processing_id=$2`, [project, oldProcessing], /epoch is immutable/i);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
});
