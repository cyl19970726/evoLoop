import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import pg, { type PoolClient } from 'pg';
import { migrate } from '../src/index.ts';
import { PgNativeExecution } from '../src/native-execution.ts';

const url = process.env.TEST_DATABASE_URL;
if (!url || !/^evoloop(?:_[a-z0-9]+)*_test$/.test(decodeURIComponent(new URL(url).pathname.slice(1))))
  throw new Error('native execution test requires a dedicated evoLoop test database');
const schema = `el_native_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
const pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}` });
const project = randomUUID(), session = randomUUID(), reserved = randomUUID();
const role = randomUUID(), messageId = randomUUID(), messageOperation = randomUUID(), reservedOperation = randomUUID();
const transitionOperation = randomUUID(), owner = { nonce: randomUUID(), pid: 32001, startIdentity: 'pid:32001:start:42' };
const now = '2026-10-27T00:00:00.000Z', policyHash = 'a'.repeat(64), observedHash = 'c'.repeat(64);

async function rejected(client: PoolClient, sql: string, values: unknown[], pattern: RegExp = /Native execution|Native message|Native business|permit|verified/i): Promise<void> {
  await client.query('SAVEPOINT expected_rejection');
  try {
    await assert.rejects(client.query(sql, values), pattern);
  } finally {
    await client.query('ROLLBACK TO SAVEPOINT expected_rejection');
    await client.query('RELEASE SAVEPOINT expected_rejection');
  }
}

before(async () => {
  await migrate(url!, schema);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("INSERT INTO project(project_id,title,created_at) VALUES($1,'Native control test',$2)", [project, now]);
    await client.query(`INSERT INTO runtime_session(project_id,session_id,role_id,cwd,authorization_scope,sandbox,
      approval_policy,state,version,native_thread_id,native_session_id,operation_id,actor_id,created_at,updated_at)
      VALUES($1,$2,$3,'/tmp/native-control','project','workspace-write','on-request','ready',1,$4,$4,$5,'worker',$6,$6)`,
      [project, session, role, `native-${session}`, randomUUID(), now]);
    await client.query(`INSERT INTO runtime_session(project_id,session_id,role_id,cwd,authorization_scope,sandbox,
      approval_policy,state,version,operation_id,actor_id,created_at,updated_at)
      VALUES($1,$2,$3,'/tmp/native-control','project','workspace-write','on-request','reserved',1,$4,'worker',$5,$5)`,
      [project, reserved, role, reservedOperation, now]);
    await client.query(`INSERT INTO session_message(project_id,message_id,operation_id,target_kind,session_id,
      sender_actor_id,content,state,version,created_at,updated_at)
      VALUES($1,$2,$3,'owned',$4,'sender','Original message','queued',1,$5,$5)`,
      [project, messageId, messageOperation, session, now]);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
});
after(async () => {
  await pool.end();
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try { await client.query(`DROP SCHEMA "${schema}" CASCADE`); } finally { await client.end(); }
});

test('explicit adoption starts unknown, then a message environment needs exit, recorded owner, and exact verification', async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const control = new PgNativeExecution(client);
    assert.equal(await control.getNativeExecutionEnvironment(), null);
    const legacy = await client.query('SELECT native_environment_epoch FROM runtime_session WHERE project_id=$1 AND session_id=$2',
      [project, session]);
    assert.equal(legacy.rows[0]?.native_environment_epoch, null, 'pre-adoption Session has no inferred epoch');
    const adopted = await control.adoptUnknown('Explicit legacy adoption; no owner verified');
    assert.equal(adopted.mode, 'unknown');
    assert.equal(adopted.epoch, 1);
    await rejected(client, `INSERT INTO runtime_session(project_id,session_id,role_id,cwd,authorization_scope,
      sandbox,approval_policy,state,version,operation_id,actor_id,created_at,updated_at)
      VALUES($1,$2,$3,'/tmp/native-control','project','workspace-write','on-request','unknown',1,$4,'worker',$5,$5)`,
      [project, randomUUID(), role, randomUUID(), now], /requires a persisted original startup/i);
    await assert.rejects(control.adoptUnknown('No second adoption'), /already adopted/i);
    const transition = await control.beginTransition({ expectedEpoch: 1, operationId: transitionOperation,
      purpose: 'message', projectId: project, sessionId: session, nativeThreadId: `native-${session}`,
      messageId, expectedPolicyHash: policyHash, reason: 'Cold message environment' });
    assert.equal(transition.mode, 'transition');
    assert.equal(transition.epoch, 2);
    await assert.rejects(control.recordSpawnedOwner(2, transitionOperation, owner), /changed/i);
    await assert.rejects(control.recordOldOwnerExit(2, transitionOperation, 'none://no-prior-owned-child'), /changed/i);
    await control.markNativeAttempt(2, transitionOperation);
    await control.recordOldOwnerExit(2, transitionOperation, 'none://no-prior-owned-child');
    await assert.rejects(control.verifyEnvironment(2, transitionOperation, owner, observedHash, 'proof://config', policyHash), /changed/i);
    const spawned = await control.recordSpawnedOwner(2, transitionOperation, owner);
    assert.equal(spawned.mode, 'transition');
    assert.equal(spawned.ownerNonce, owner.nonce);
    assert.ok(spawned.spawnedOwnerRecordedAt);
    await assert.rejects(control.recordSpawnedOwner(2, transitionOperation, { ...owner, nonce: randomUUID() }), /changed/i);
    await assert.rejects(control.verifyEnvironment(2, transitionOperation, { ...owner, nonce: randomUUID() },
      observedHash, 'proof://wrong-owner', policyHash), /changed/i);
    await assert.rejects(control.verifyEnvironment(2, transitionOperation, owner,
      observedHash, 'proof://wrong-target', 'd'.repeat(64)), /changed/i);
    const verified = await control.verifyEnvironment(2, transitionOperation, owner,
      observedHash, 'proof://config', policyHash);
    assert.equal(verified.mode, 'message_verified');
    assert.equal(verified.observedPolicyHash, observedHash);
    assert.notEqual(verified.expectedPolicyHash, verified.observedPolicyHash);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
});

test('message startup requires exact epoch and original message; direct SQL cannot bypass permit', async () => {
  const client = await pool.connect();
  const processing = randomUUID(), operation = randomUUID();
  const insert = `INSERT INTO session_message_processing(project_id,processing_id,message_id,session_id,operation_id,
    receiver_actor_id,state,read_only_policy_fingerprint,version,started_at,updated_at)
    VALUES($1,$2,$3,$4,$5,'worker','dispatching',$6,1,$7,$7)`;
  const values = [project, processing, messageId, session, operation, observedHash, now];
  try {
    await client.query('BEGIN');
    const control = new PgNativeExecution(client);
    await rejected(client, insert, values);
    await rejected(client, insert.replace('started_at,updated_at)', 'started_at,updated_at,native_environment_epoch)')
      .replace('VALUES($1,$2,$3,$4,$5,\'worker\',\'dispatching\',$6,1,$7,$7)',
        'VALUES($1,$2,$3,$4,$5,\'worker\',\'dispatching\',$6,1,$7,$7,2)'), values,
      /epoch must be assigned/i);
    await assert.rejects(control.permitNativeStartup({ kind: 'message', expectedEpoch: 1, projectId: project,
      sessionId: session, operationId: operation, messageId }), /does not permit/i);
    await assert.rejects(control.permitNativeStartup({ kind: 'message', expectedEpoch: 2, projectId: project,
      sessionId: session, operationId: operation, messageId: randomUUID() }), /does not permit/i);
    await control.permitNativeStartup({ kind: 'message', expectedEpoch: 2, projectId: project,
      sessionId: session, operationId: operation, messageId });
    await rejected(client, insert, [project, processing, messageId, session, randomUUID(), observedHash, now]);
    await client.query(insert, values);
    assert.equal((await client.query('SELECT state FROM session_message_processing WHERE project_id=$1 AND processing_id=$2',
      [project, processing])).rows[0]?.state, 'dispatching');
    assert.equal((await client.query('SELECT native_environment_epoch FROM session_message_processing WHERE project_id=$1 AND processing_id=$2',
      [project, processing])).rows[0]?.native_environment_epoch, '2');
    await rejected(client, `UPDATE session_message_processing SET native_environment_epoch=3
      WHERE project_id=$1 AND processing_id=$2`, [project, processing], /epoch is immutable/i);
    await rejected(client, `UPDATE session_message_processing SET native_environment_epoch=NULL
      WHERE project_id=$1 AND processing_id=$2`, [project, processing], /epoch is immutable/i);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
});

test('transition blocks a new business Session until a separate verified business owner is recorded', async () => {
  const client = await pool.connect();
  const businessOp = randomUUID(), sessionOp = randomUUID();
  const newOwner = { nonce: randomUUID(), pid: 32002, startIdentity: 'pid:32002:start:43' };
  const sql = `UPDATE runtime_session SET state='creating',version=2,updated_at=now(),operation_id=operation_id
    WHERE project_id=$1 AND session_id=$2`;
  try {
    await client.query('BEGIN');
    const control = new PgNativeExecution(client);
    const next = await control.beginTransition({ expectedEpoch: 2, operationId: businessOp,
      purpose: 'business', projectId: project, sessionId: session, nativeThreadId: `native-${session}`,
      messageId: null, expectedPolicyHash: 'b'.repeat(64), reason: 'Return to business' });
    assert.equal(next.mode, 'transition');
    await rejected(client, sql, [project, reserved]);
    await client.query(`UPDATE session_message_processing SET state='unknown',version=2,updated_at=now()
      WHERE project_id=$1 AND message_id=$2`, [project, messageId]);
    assert.equal((await client.query(`SELECT native_environment_epoch FROM session_message_processing
      WHERE project_id=$1 AND message_id=$2`, [project, messageId])).rows[0]?.native_environment_epoch, '2',
      'old operation keeps its epoch after control moved to transition');
    await control.markNativeAttempt(3, businessOp);
    await control.recordOldOwnerExit(3, businessOp, 'exit://verified-old-owner');
    await control.recordSpawnedOwner(3, businessOp, newOwner);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }

  const resumed = await pool.connect();
  try {
    await resumed.query('BEGIN');
    const control = new PgNativeExecution(resumed);
    const unverified = await control.getNativeExecutionEnvironment();
    assert.equal(unverified?.mode, 'transition');
    assert.equal(unverified.ownerNonce, newOwner.nonce, 'spawned owner survives transaction/restart boundary');
    await assert.rejects(control.verifyEnvironment(3, businessOp, { ...newOwner, pid: 32003 },
      'd'.repeat(64), 'proof://wrong-process', 'b'.repeat(64)), /changed/i);
    await control.verifyEnvironment(3, businessOp, newOwner, 'd'.repeat(64), 'proof://business-config', 'b'.repeat(64));
    await assert.rejects(control.permitNativeStartup({ kind: 'session-create', expectedEpoch: 2,
      projectId: project, sessionId: reserved, operationId: sessionOp }), /does not permit/i);
    await control.permitNativeStartup({ kind: 'session-create', expectedEpoch: 3,
      projectId: project, sessionId: reserved, operationId: sessionOp });
    await rejected(resumed, sql, [project, reserved]); // stored Session operation differs from permit
    await control.permitNativeStartup({ kind: 'session-create', expectedEpoch: 3,
      projectId: project, sessionId: reserved, operationId: reservedOperation });
    await resumed.query(sql, [project, reserved]);
    assert.equal((await resumed.query('SELECT state FROM runtime_session WHERE project_id=$1 AND session_id=$2',
      [project, reserved])).rows[0]?.state, 'creating');
    assert.equal((await resumed.query('SELECT native_environment_epoch FROM runtime_session WHERE project_id=$1 AND session_id=$2',
      [project, reserved])).rows[0]?.native_environment_epoch, '3');
    await rejected(resumed, `UPDATE runtime_session SET native_environment_epoch=2
      WHERE project_id=$1 AND session_id=$2`, [project, reserved], /epoch is immutable/i);
    await resumed.query(`UPDATE runtime_session SET state='ready',version=3,native_thread_id=$3,
      native_session_id=$3,updated_at=now() WHERE project_id=$1 AND session_id=$2`,
      [project, reserved, `native-${reserved}`]);
    const document = randomUUID(), documentRevision = randomUUID(), task = randomUUID();
    const taskRevision = randomUUID(), basis = randomUUID(), run = randomUUID(), runOperation = randomUUID();
    await resumed.query(`INSERT INTO process_document(project_id,document_id,title,version,current_revision_id,kind,status)
      VALUES($1,$2,'Run task',1,$3,'task','draft')`, [project, document, documentRevision]);
    await resumed.query(`INSERT INTO document_revision(project_id,document_id,revision_id,body,format,content_hash,author,created_at,reason)
      VALUES($1,$2,$3,'Fixed task','markdown',$4,'lead',$5,'fixture')`,
      [project, document, documentRevision, policyHash, now]);
    await resumed.query(`INSERT INTO task(project_id,task_id,version,current_revision_id,title,acceptance,owner,state,
      content_document_id,content_revision_id) VALUES($1,$2,1,$3,'Run task','Review',$4,'in_progress',$5,$6)`,
      [project, task, taskRevision, role, document, documentRevision]);
    await resumed.query(`INSERT INTO task_revision(project_id,task_id,revision_id,version,title,acceptance,owner,state,
      basis_set_id,actor_id,reason,created_at,content_document_id,content_revision_id)
      VALUES($1,$2,$3,1,'Run task','Review',$7,'in_progress',$4,'lead','fixture',$8,$5,$6)`,
      [project, task, taskRevision, basis, document, documentRevision, role, now]);
    await resumed.query(`INSERT INTO basis_set(project_id,task_id,task_revision_id,basis_set_id,sealed)
      VALUES($1,$2,$3,$4,true)`, [project, task, taskRevision, basis]);
    await resumed.query(`INSERT INTO runtime_run(project_id,run_id,task_id,task_revision_id,basis_set_id,session_id,
      operation_id,input,input_hash,state,version,actor_id,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,'Fixed input','hash','requested',1,'worker',$8,$8)`,
      [project, run, task, taskRevision, basis, reserved, runOperation, now]);
    assert.equal((await resumed.query('SELECT native_environment_epoch FROM runtime_run WHERE project_id=$1 AND run_id=$2',
      [project, run])).rows[0]?.native_environment_epoch, null, 'requested Run has not started native work');
    await rejected(resumed, `UPDATE runtime_run SET native_environment_epoch=3 WHERE project_id=$1 AND run_id=$2`,
      [project, run], /epoch is immutable/i);
    await control.permitNativeStartup({ kind: 'run', expectedEpoch: 3, projectId: project,
      sessionId: reserved, operationId: runOperation });
    await resumed.query(`UPDATE runtime_run SET state='dispatching',version=2,updated_at=now()
      WHERE project_id=$1 AND run_id=$2`, [project, run]);
    assert.equal((await resumed.query('SELECT native_environment_epoch FROM runtime_run WHERE project_id=$1 AND run_id=$2',
      [project, run])).rows[0]?.native_environment_epoch, '3');
    await resumed.query('COMMIT');
  } catch (error) { await resumed.query('ROLLBACK'); throw error; } finally { resumed.release(); }
});
