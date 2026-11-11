import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { before, after, test } from 'node:test';
import pg from 'pg';
import { RuntimeWorkflowService, WorkflowService, canonicalJson } from '@evoloop/core';
import { submitOrdinaryRun } from '@evoloop/core/ordinary-run-submission';
import { migrate, PostgresUnitOfWork } from '../src/index.ts';
import { PgOrdinaryRunSubmissionStore } from '../src/ordinary-run-submission.ts';

const url = process.env.TEST_DATABASE_URL;
if (!url || !/^evoloop(?:_[a-z0-9]+)*_test$/.test(decodeURIComponent(new URL(url).pathname.slice(1))))
  throw new Error('run stop test requires a dedicated evoLoop test database');
const schema = `el_stop_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
const pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}` });
const uow = new PostgresUnitOfWork(pool);
const hasher = { hash: (value: string) => createHash('sha256').update(value).digest('hex') };
const deps = { uow, clock: { now: () => new Date().toISOString() }, ids: { next: randomUUID }, hasher };
const workflow = new WorkflowService(deps);
const runtime = new RuntimeWorkflowService(deps);
const project = randomUUID(), role = randomUUID();
const reviewer = { actorId: 'lead', projectIds: [project], permissions: ['read' as const, 'write' as const, 'review' as const] };
const writer = { actorId: 'worker', projectIds: [project], permissions: ['read' as const, 'write' as const] };

before(async () => {
  await migrate(url!, schema);
  await pool.query("INSERT INTO project(project_id,title,created_at) VALUES($1,'Run stop test',now())", [project]);
});
after(async () => {
  await pool.end();
  const c = new pg.Client({ connectionString: url }); await c.connect();
  try { await c.query(`DROP SCHEMA "${schema}" CASCADE`); } finally { await c.end(); }
});

interface Fixture { runId: string; sessionId: string; taskId: string; revisionId: string; operationId: string }
async function fixture(state: 'requested' | 'dispatching' | 'running', withMessage = false): Promise<Fixture> {
  const sessionId = randomUUID(), runId = randomUUID(), operationId = randomUUID(), taskId = randomUUID(), revisionId = randomUUID(),
    basisId = randomUUID(), documentId = randomUUID(), docRevisionId = randomUUID(), now = new Date().toISOString();
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query(`INSERT INTO runtime_session(project_id,session_id,role_id,cwd,authorization_scope,sandbox,approval_policy,state,version,
      native_thread_id,native_session_id,operation_id,actor_id,created_at,updated_at)
      VALUES($1,$2,$3,'/tmp/run-stop','project','danger-full-access','never','ready',1,$4,$4,$5,'worker',$6,$6)`,
      [project, sessionId, role, `native-${sessionId}`, randomUUID(), now]);
    await c.query("INSERT INTO process_document(project_id,document_id,title,version,current_revision_id,kind,status) VALUES($1,$2,'Fixed Task',1,$3,'task','draft')", [project, documentId, docRevisionId]);
    await c.query("INSERT INTO document_revision(project_id,document_id,revision_id,body,format,content_hash,author,created_at,reason) VALUES($1,$2,$3,'Fixed task','markdown',$4,'lead',$5,'fixture')", [project, documentId, docRevisionId, 'a'.repeat(64), now]);
    await c.query(`INSERT INTO task(project_id,task_id,version,current_revision_id,title,acceptance,owner,state,content_document_id,content_revision_id)
      VALUES($1,$2,1,$3,'Fixed Task','Result',$4,'in_progress',$5,$6)`, [project, taskId, revisionId, role, documentId, docRevisionId]);
    await c.query(`INSERT INTO task_revision(project_id,task_id,revision_id,version,title,acceptance,owner,state,basis_set_id,actor_id,reason,created_at,content_document_id,content_revision_id)
      VALUES($1,$2,$3,1,'Fixed Task','Result',$7,'in_progress',$4,'lead','fixture',$8,$5,$6)`, [project, taskId, revisionId, basisId, documentId, docRevisionId, role, now]);
    await c.query('INSERT INTO basis_set(project_id,task_id,task_revision_id,basis_set_id,sealed) VALUES($1,$2,$3,$4,true)', [project, taskId, revisionId, basisId]);
    await c.query(`INSERT INTO runtime_run(project_id,run_id,task_id,task_revision_id,basis_set_id,session_id,operation_id,input,input_hash,state,version,native_turn_id,actor_id,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,'Fixed input',$8,$9,1,$10,'worker',$11,$11)`,
      [project, runId, taskId, revisionId, basisId, sessionId, operationId, 'b'.repeat(64), state, state === 'running' ? `turn-${runId}` : null, now]);
    await c.query("INSERT INTO operation_journal(project_id,operation_id,actor_id,command_hash,command_type,result,created_at) VALUES($1,$2,'worker',$3,'runtime.run.reserve','{}',$4)", [project, operationId, 'c'.repeat(64), now]);
    if (withMessage) await c.query(`INSERT INTO session_message(project_id,message_id,operation_id,target_kind,session_id,sender_actor_id,content,context_task_id,context_task_revision_id,
      state,version,created_at,updated_at) VALUES($1,$2,$3,'owned',$4,'lead','Please also check X',$5,$6,'queued',1,$7,$7)`, [project, randomUUID(), randomUUID(), sessionId, taskId, revisionId, now]);
    await c.query('COMMIT');
  } catch (error) { await c.query('ROLLBACK'); throw error; } finally { c.release(); }
  return { runId, sessionId, taskId, revisionId, operationId };
}
async function fixtureRunOn(f: Fixture, state: string): Promise<string> {
  const id = randomUUID(), now = new Date().toISOString();
  const basis = (await pool.query('SELECT basis_set_id FROM runtime_run WHERE run_id=$1', [f.runId])).rows[0].basis_set_id;
  await pool.query(`INSERT INTO runtime_run(project_id,run_id,task_id,task_revision_id,basis_set_id,session_id,operation_id,input,input_hash,state,version,actor_id,created_at,updated_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,'Next',$8,$9,1,'worker',$10,$10)`, [project, id, f.taskId, f.revisionId, basis, f.sessionId, randomUUID(), 'f'.repeat(64), state, now]);
  return id;
}
const stop = (f: Fixture, expectedVersion = 1, who = reviewer) => workflow.execute(who, { type: 'runtime.run.stop', projectId: project, operationId: randomUUID(), runId: f.runId, expectedVersion, reason: 'Scope changed; stop this Run' } as never);
const run = (f: Fixture) => uow.read(project, r => r.getRuntimeRun(f.runId));
const gatePhase = async (f: Fixture) => (await pool.query('SELECT phase FROM session_recovery_gate WHERE project_id=$1 AND session_id=$2', [project, f.sessionId])).rows[0]?.phase;
const notices = async (f: Fixture) => (await pool.query("SELECT count(*)::int AS n FROM leader_result_notice WHERE project_id=$1 AND task_id=$2", [project, f.taskId])).rows[0].n;
const intent = (f: Fixture) => ({ projectId: project, operationId: randomUUID(), submissionId: randomUUID(), runId: f.runId, taskId: f.taskId, sessionId: f.sessionId,
  taskRevisionId: f.revisionId, runInputHash: 'b'.repeat(64), deliveryOperationId: randomUUID(),
  deliveryIntent: { artifactRef: 'repo:test', artifactRevision: 'r1', contentHash: 'a'.repeat(64), technicalResult: 'passed' as const, technicalEvidence: 'e', reason: 'r' } });
async function signedIntent(f: Fixture) {
  const command = intent(f);
  await pool.query(`INSERT INTO ordinary_run_submission(project_id,submission_id,run_id,task_id,session_id,task_revision_id,run_input_hash,operation_id,command_hash,
    delivery_operation_id,delivery_intent,submitted_by,state,version,created_at_utc,updated_at_utc)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,'worker','submitted',1,now(),now())`,
    [project, command.submissionId, f.runId, f.taskId, f.sessionId, f.revisionId, command.runInputHash, command.operationId,
      hasher.hash(canonicalJson({ actorId: 'worker', command })), command.deliveryOperationId, JSON.stringify(command.deliveryIntent)]);
  return command;
}
const insertDelivery = (f: Fixture, runId: string | null) => pool.query(`INSERT INTO delivery(project_id,delivery_id,task_id,task_revision_id,artifact_ref,artifact_revision,content_hash,
  technical_result,technical_evidence,reason,actor_id,created_at,run_id) VALUES($1,$2,$3,$4,'repo:test','r1',$5,'passed','e','r','worker',now(),$6)`,
  [project, randomUUID(), f.taskId, f.revisionId, 'a'.repeat(64), runId]);

test('stopping a Run that was never dispatched fails it without a notice or a closed gate, and the Task is free at once', async () => {
  const f = await fixture('requested');
  const result = await stop(f);
  assert.equal(result.status, 'applied', JSON.stringify(result));
  const stopped = (await run(f))!;
  assert.equal(stopped.state, 'failed');
  assert.ok(stopped.stopRequestedAt);
  assert.equal(stopped.stopRequestedBy, 'lead');
  assert.match(stopped.stopReason!, /Scope changed/);
  assert.equal(await gatePhase(f), 'open', 'an expected end does not close the Session');
  assert.equal(await notices(f), 0, 'no "no submission" or "blocked" notice for a stop');
  const events = await workflow.listRuntimeEvents(reviewer, project, f.runId);
  assert.ok(events.some(e => e.kind === 'run.stopRequested' && /Stopped before dispatch/.test(e.detail)), 'the record-level event');
  await assert.rejects(runtime.beginDispatch(project, f.runId), /already attempted|RUN_NOT_REQUESTED/i, 'it cannot be dispatched any more');
  // The Task is free at once: the stopped Run no longer holds the Task's single active-Run slot.
  const second = await fixtureRunOn(f, 'requested');
  assert.ok(second, 'a new Run can be reserved for the same Task straight away');
});

test('stopping a running Run interrupts it, voids its signed intent, and every later submission or Delivery is refused', async () => {
  const f = await fixture('running', true);
  const signed = await signedIntent(f);
  const result = await stop(f);
  assert.equal(result.status, 'applied', JSON.stringify(result));
  const stopped = (await run(f))!;
  assert.equal(stopped.state, 'running', 'no new Run state: the runtime still has to end it');
  assert.equal(stopped.interruptRequested, true, 'the existing interrupt path will act on it');
  const submission = (await pool.query('SELECT state,reason FROM ordinary_run_submission WHERE run_id=$1', [f.runId])).rows[0];
  assert.deepEqual(submission, { state: 'rejected', reason: 'RUN_STOPPED' }, 'the intent signed before the stop is voided in the same transaction');
  assert.match((await pool.query("SELECT blocked_reason FROM session_message WHERE session_id=$1", [f.sessionId])).rows[0].blocked_reason, /^SUPERSEDED/, 'its queued message is marked superseded');

  const store = (client: pg.PoolClient) => new PgOrdinaryRunSubmissionStore(client, project);
  const attempt = async (command: typeof signed) => {
    const client = await pool.connect();
    try { return await submitOrdinaryRun(store(client), writer, command, new Date().toISOString(), hasher); } finally { client.release(); }
  };
  await assert.rejects(attempt(signed), { code: 'RUN_STOPPED' });
  await assert.rejects(attempt(signed), { code: 'RUN_STOPPED' }, 'the replay with the old operation ID returns the same refusal');
  await assert.rejects(attempt(intent(f)), { code: 'RUN_STOPPED' }, 'a new submission is refused too');
  await assert.rejects(pool.query(`INSERT INTO ordinary_run_submission(project_id,submission_id,run_id,task_id,session_id,task_revision_id,run_input_hash,operation_id,command_hash,
    delivery_operation_id,delivery_intent,submitted_by,state,version,created_at_utc,updated_at_utc) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'{}'::jsonb,'worker','submitted',1,now(),now())`,
    [project, randomUUID(), f.runId, f.taskId, f.sessionId, f.revisionId, 'b'.repeat(64), randomUUID(), 'e'.repeat(64), randomUUID()]), /RUN_STOPPED/, 'the database refuses it even if a writer bypasses the service');
  await assert.rejects(insertDelivery(f, f.runId), /RUN_STOPPED/, 'no Delivery cites a stopped Run');
  await assert.rejects(insertDelivery(f, null), /RUN_STOPPED.*has not ended/, 'nor one without a Run while the stopped Run is unfinished');

  // The runtime observes the interrupt: the Run ends, the gate stays open, nothing is announced, and a Delivery without a Run is allowed again.
  await runtime.recordTurn(project, f.runId, `turn-${f.runId}`, 'interrupted', 'Interrupted on request', { completedAtUtc: new Date().toISOString() });
  assert.equal((await run(f))!.state, 'interrupted');
  assert.equal(await gatePhase(f), 'open', 'the Session can take its next Run at once');
  assert.equal(await notices(f), 0, 'only the record-level event, no failure notice');
  await insertDelivery(f, null);
  await assert.rejects(insertDelivery(f, f.runId), /RUN_STOPPED/, 'the stopped Run still cannot be cited');
});

test('a Run that is dispatching is marked, not failed, and its Turn is interrupted when it binds', async () => {
  const f = await fixture('dispatching');
  const result = await stop(f);
  assert.equal(result.status, 'applied', JSON.stringify(result));
  const marked = (await run(f))!;
  assert.equal(marked.state, 'dispatching', 'a native start may be in flight: it is not called failed');
  assert.equal(marked.interruptRequested, false);
  const bound = await runtime.bindTurn(project, f.runId, { id: `turn-${f.runId}`, status: 'running' }, { kind: 'startReply', operationId: f.operationId });
  assert.equal(bound.state, 'running');
  assert.equal(bound.interruptRequested, true, 'the Turn that binds after a stop is interrupted at once');
});

test('only a live, unstopped Run at its current version can be stopped; review permission is needed; the marker is final', async () => {
  const f = await fixture('running');
  await assert.rejects(stop(f, 1, writer), /Permission review is required/);
  assert.equal((await stop(f, 7) as { code: string }).code, 'VERSION_CONFLICT');
  assert.equal((await stop(f)).status, 'applied');
  const again = await stop(f, 2);
  assert.equal((again as { code: string }).code, 'STOP_ALREADY_REQUESTED');
  await assert.rejects(pool.query("UPDATE runtime_run SET stop_reason='something else' WHERE run_id=$1", [f.runId]), /RUN_STOPPED|origin is immutable/, 'the marker cannot be changed by a direct write');
  await assert.rejects(pool.query('UPDATE runtime_run SET stop_requested_at=NULL,stop_reason=NULL,stop_requested_by=NULL WHERE run_id=$1', [f.runId]), /RUN_STOPPED|origin is immutable|stop_marker/, 'nor withdrawn');
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM pg_trigger WHERE tgname='runtime_run_stop_marker_final' AND NOT tgisinternal")).rows[0].n, 1, 'the marker has its own guard');
  const ended = await fixture('requested');
  await runtime.rejectDispatch(project, ended.runId, 'Preflight failed');
  assert.equal((await stop(ended, 2) as { code: string }).code, 'RUN_TERMINAL');
});

test('migration 078 patches the existing trigger functions in place and leaves an unstopped Run exactly as before', async () => {
  const f = await fixture('running');
  await runtime.recordTurn(project, f.runId, `turn-${f.runId}`, 'failed', 'Real failure', { completedAtUtc: new Date().toISOString() });
  assert.equal(await gatePhase(f), 'blocked', 'an ordinary failure still closes the gate');
  assert.ok(await notices(f) >= 1, 'and still tells the Leader');
  const defs = (await pool.query(`SELECT proname, pg_get_functiondef(oid) AS def FROM pg_proc WHERE pronamespace=current_schema()::regnamespace
    AND proname IN ('session_recovery_run_outcome','leader_result_notice_from_terminal_run','leader_result_notice_from_submission')`)).rows;
  assert.equal(defs.length, 3);
  for (const row of defs) assert.match(row.def, /stop_requested_at/, `${row.proname} reads the stop marker`);
});
