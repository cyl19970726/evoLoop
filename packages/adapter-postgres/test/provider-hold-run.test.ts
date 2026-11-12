// A Task Run that fails on the model provider's account pauses the provider like a message does; a Run is never failed by a hold; one release frees the Run-caused gate.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { before, after, test } from 'node:test';
import pg from 'pg';
import { RuntimeWorkflowService, WorkflowService, canonicalJson } from '@evoloop/core';

import { migrate, PostgresUnitOfWork } from '../src/index.ts';





const url = process.env.TEST_DATABASE_URL;
if (!url || !/^evoloop(?:_[a-z0-9]+)*_test$/.test(decodeURIComponent(new URL(url).pathname.slice(1))))
  throw new Error('provider hold run test requires a dedicated evoLoop test database');
const schema = `el_hold_run_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
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

interface Fixture { runId: string; sessionId: string; taskId: string; revisionId: string; operationId: string; threadId: string }
async function fixture(state: 'requested' | 'dispatching' | 'running', withMessage = false): Promise<Fixture> {
  const sessionId = randomUUID(), runId = randomUUID(), operationId = randomUUID(), taskId = randomUUID(), revisionId = randomUUID(),
    basisId = randomUUID(), documentId = randomUUID(), docRevisionId = randomUUID(), now = new Date().toISOString(), threadId = randomUUID();
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query(`INSERT INTO runtime_session(project_id,session_id,role_id,cwd,authorization_scope,sandbox,approval_policy,state,version,
      native_thread_id,native_session_id,operation_id,actor_id,created_at,updated_at)
      VALUES($1,$2,$3,'/tmp/run-stop','project','danger-full-access','never','ready',1,$4,$4,$5,'worker',$6,$6)`,
      [project, sessionId, role, threadId, randomUUID(), now]);
    await c.query("INSERT INTO process_document(project_id,document_id,title,version,current_revision_id,kind,status) VALUES($1,$2,'Fixed Task',1,$3,'task','draft')", [project, documentId, docRevisionId]);
    await c.query("INSERT INTO document_revision(project_id,document_id,revision_id,body,format,content_hash,author,created_at,reason) VALUES($1,$2,$3,'Fixed task','markdown',$4,'lead',$5,'fixture')", [project, documentId, docRevisionId, 'a'.repeat(64), now]);
    await c.query(`INSERT INTO task(project_id,task_id,version,current_revision_id,title,acceptance,owner,state,content_document_id,content_revision_id)
      VALUES($1,$2,1,$3,'Fixed Task','Result',$4,'in_progress',$5,$6)`, [project, taskId, revisionId, role, documentId, docRevisionId]);
    await c.query(`INSERT INTO task_revision(project_id,task_id,revision_id,version,title,acceptance,owner,state,basis_set_id,actor_id,reason,created_at,content_document_id,content_revision_id)
      VALUES($1,$2,$3,1,'Fixed Task','Result',$7,'in_progress',$4,'lead','fixture',$8,$5,$6)`, [project, taskId, revisionId, basisId, documentId, docRevisionId, role, now]);
    await c.query('INSERT INTO basis_set(project_id,task_id,task_revision_id,basis_set_id,sealed) VALUES($1,$2,$3,$4,false)', [project, taskId, revisionId, basisId]);
    await c.query('INSERT INTO basis_member(project_id,task_id,task_revision_id,basis_set_id,document_id,document_revision_id) VALUES($1,$2,$3,$4,$5,$6)', [project, taskId, revisionId, basisId, documentId, docRevisionId]);
    await c.query('UPDATE basis_set SET sealed=true WHERE basis_set_id=$1', [basisId]);
    await c.query("INSERT INTO document_decision(project_id,decision_id,document_id,revision_id,actor_id,reason,created_at) VALUES($1,$2,$3,$4,'lead','fixture',$5)", [project, randomUUID(), documentId, docRevisionId, now]);
    await c.query('UPDATE process_document SET adopted_revision_id=$2,version=2 WHERE document_id=$1', [documentId, docRevisionId]);
    await c.query(`INSERT INTO runtime_run(project_id,run_id,task_id,task_revision_id,basis_set_id,session_id,operation_id,input,input_hash,state,version,native_turn_id,actor_id,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,'Fixed input',$8,$9,1,$10,'worker',$11,$11)`,
      [project, runId, taskId, revisionId, basisId, sessionId, operationId, 'b'.repeat(64), state, state === 'running' ? `turn-${runId}` : null, now]);
    await c.query("INSERT INTO operation_journal(project_id,operation_id,actor_id,command_hash,command_type,result,created_at) VALUES($1,$2,'worker',$3,'runtime.run.reserve','{}',$4)", [project, operationId, 'c'.repeat(64), now]);
    if (withMessage) await c.query(`INSERT INTO session_message(project_id,message_id,operation_id,target_kind,session_id,sender_actor_id,content,context_task_id,context_task_revision_id,
      state,version,created_at,updated_at) VALUES($1,$2,$3,'owned',$4,'lead','Please also check X',$5,$6,'queued',1,$7,$7)`, [project, randomUUID(), randomUUID(), sessionId, taskId, revisionId, now]);
    await c.query('COMMIT');
  } catch (error) { await c.query('ROLLBACK'); throw error; } finally { c.release(); }
  return { runId, sessionId, taskId, revisionId, operationId, threadId };
}
async function fixtureRunOn(f: Fixture, state: string): Promise<string> {
  const id = randomUUID(), now = new Date().toISOString();
  const basis = (await pool.query('SELECT basis_set_id FROM runtime_run WHERE run_id=$1', [f.runId])).rows[0].basis_set_id;
  await pool.query(`INSERT INTO runtime_run(project_id,run_id,task_id,task_revision_id,basis_set_id,session_id,operation_id,input,input_hash,state,version,actor_id,created_at,updated_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,'Next',$8,$9,1,'worker',$10,$10)`, [project, id, f.taskId, f.revisionId, basis, f.sessionId, randomUUID(), 'f'.repeat(64), state, now]);
  return id;
}

const gate = async (f: Fixture) => (await pool.query('SELECT phase,cause_kind FROM session_recovery_gate WHERE project_id=$1 AND session_id=$2', [project, f.sessionId])).rows[0];
const held = async () => (await pool.query("SELECT hold_id,version,category FROM runtime_provider_hold WHERE project_id=$1 AND state='held'", [project])).rows;
const runState = async (f: Fixture) => (await uow.read(project, r => r.getRuntimeRun(f.runId)))!;

test('a Run that fails on the account opens the provider hold; other Runs stay requested instead of failing; one release frees the gate it closed', async () => {
  const failing = await fixture('running');
  const waiting = await fixture('requested');
  const completedAt = new Date().toISOString();
  // 1. The 402 lands on a Task Run: the Run fails with its category, and the hold opens.
  const failed = await runtime.recordTurn(project, failing.runId, `turn-${failing.runId}`, 'failed', 'Native failure; category=quota_exhausted',
    { completedAtUtc: completedAt, failureCategory: 'quota_exhausted' });
  assert.equal(failed.state, 'failed'); assert.equal(failed.failureCategory, 'quota_exhausted');
  assert.equal((await runState(failing)).failureCategory, 'quota_exhausted', 'the category is kept on the Run');
  const [hold] = await held();
  assert.equal(hold?.category, 'quota_exhausted');
  assert.deepEqual(await gate(failing), { phase: 'blocked', cause_kind: 'run' }, 'the failed Run closes its Session gate as before');
  // 2. The gate view and the impact say why, so the recovery panel and the banner can.
  const view = await uow.read(project, r => r.recovery!.getRecoveryGate(failing.sessionId));
  assert.equal(view?.failureCategory, 'quota_exhausted');
  const impact = await uow.read(project, r => r.recovery!.providerHoldImpact('codex'));
  assert.equal(impact.find(item => item.sessionId === failing.sessionId)?.blockedByQuotaFailure, true, 'a Run-caused gate counts as blocked by the quota failure');
  // 3. Another Session's Run is not dispatched and not failed: it stays requested, nothing saved against it.
  await assert.rejects(runtime.beginDispatch(project, waiting.runId), { code: 'PROVIDER_HELD' });
  assert.equal((await runState(waiting)).state, 'requested');
  assert.equal((await gate(waiting))?.phase ?? 'open', 'open', 'no gate closes one by one');
  // 4. A second failure of the same provider finds the hold already there.
  const second = await fixture('running');
  await runtime.recordTurn(project, second.runId, `turn-${second.runId}`, 'failed', 'again', { completedAtUtc: completedAt, failureCategory: 'quota_exhausted' });
  assert.equal((await held()).length, 1, 'one hold however many Runs failed');
  // 5. One release frees the provider and resumes the gates the Run failures closed.
  const release = await workflow.execute(reviewer, { type: 'runtime.providerHold.release', projectId: project, operationId: randomUUID(), provider: 'codex',
    holdId: hold!.hold_id, expectedVersion: hold!.version, evidenceRef: 'ops://balance-restored', reason: 'Balance restored' } as never);
  assert.equal(release.status, 'applied', JSON.stringify(release));
  assert.equal((await held()).length, 0);
  const summary = (await pool.query("SELECT release_summary FROM runtime_provider_hold WHERE project_id=$1 AND hold_id=$2", [project, hold!.hold_id])).rows[0].release_summary;
  assert.ok(summary.resumed.includes(failing.sessionId), JSON.stringify(summary));
  assert.equal((await gate(failing))?.phase, 'open', 'the Run-caused gate is reopened by the same release');
  // 6. The waiting Run now dispatches.
  assert.equal((await runtime.beginDispatch(project, waiting.runId)).state, 'dispatching');
});

test('other failure categories of a Run neither open a hold nor are stored as quota', async () => {
  const f = await fixture('running');
  const before = (await held()).length;
  const failed = await runtime.recordTurn(project, f.runId, `turn-${f.runId}`, 'failed', 'context', { completedAtUtc: new Date().toISOString(), failureCategory: 'context_window_exceeded' });
  assert.equal(failed.failureCategory, 'context_window_exceeded');
  assert.equal((await held()).length, before, 'only quota and authentication pause the provider');
});
