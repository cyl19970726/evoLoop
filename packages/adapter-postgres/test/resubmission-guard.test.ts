import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { before, after, test } from 'node:test';
import pg from 'pg';
import { WorkflowService, canonicalJson } from '@evoloop/core';
import { submitOrdinaryRun } from '@evoloop/core/ordinary-run-submission';
import { assertNotRejectedResubmission } from '@evoloop/core/resubmission-guard';
import { migrate, PostgresUnitOfWork } from '../src/index.ts';
import { PgOrdinaryRunSubmissionStore } from '../src/ordinary-run-submission.ts';

/**
 * Task 399fdac2: a delivery that repeats an artifact the consumer already sent back, against a Task that has not changed, is refused at both entries
 * (the signed submission and delivery.record) with one error code that names the observation. Everything here is the real database and the real services.
 */
const url = process.env.TEST_DATABASE_URL;
if (!url || !/^evoloop(?:_[a-z0-9]+)*_test$/.test(decodeURIComponent(new URL(url).pathname.slice(1))))
  throw new Error('resubmission guard test requires a dedicated evoLoop test database');
const schema = `el_resub_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
const pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}` });
const uow = new PostgresUnitOfWork(pool);
const hasher = { hash: (value: string) => createHash('sha256').update(value).digest('hex') };
const workflow = new WorkflowService({ uow, clock: { now: () => new Date().toISOString() }, ids: { next: randomUUID }, hasher });
const project = randomUUID(), role = randomUUID();
const writer = { actorId: 'worker', projectIds: [project], permissions: ['task', 'document', 'session'] as ('task' | 'document' | 'session')[] };
const HASH = 'a'.repeat(64);
const CODE = 'RESUBMIT_REJECTED_ARTIFACT';
const minutes = (n: number) => new Date(Date.now() + n * 60_000).toISOString();

before(async () => {
  await migrate(url!, schema);
  await pool.query("INSERT INTO project(project_id,title,created_at) VALUES($1,'Resubmission guard',now())", [project]);
});
after(async () => {
  await pool.end();
  const c = new pg.Client({ connectionString: url }); await c.connect();
  try { await c.query(`DROP SCHEMA "${schema}" CASCADE`); } finally { await c.end(); }
});

interface Fixture { runId: string; sessionId: string; taskId: string; revisionId: string; basisId: string; documentId: string; docRevisionId: string }
/** An in-progress Task with one fixed revision and one Run in the given state (the signed recipient is the Session's assignment). */
async function fixture(runState: 'running' | 'completed'): Promise<Fixture> {
  const sessionId = randomUUID(), runId = randomUUID(), taskId = randomUUID(), revisionId = randomUUID(),
    basisId = randomUUID(), documentId = randomUUID(), docRevisionId = randomUUID(), at = minutes(-60);
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query(`INSERT INTO runtime_session(project_id,session_id,role_id,cwd,authorization_scope,sandbox,approval_policy,state,version,
      native_thread_id,native_session_id,operation_id,actor_id,created_at,updated_at)
      VALUES($1,$2,$3,'/tmp/resub','project','danger-full-access','never','ready',1,$4,$4,$5,'worker',$6,$6)`, [project, sessionId, role, randomUUID(), randomUUID(), at]);
    await c.query("INSERT INTO process_document(project_id,document_id,title,version,current_revision_id,kind,status) VALUES($1,$2,'Fixed Task',1,$3,'task','draft')", [project, documentId, docRevisionId]);
    await c.query("INSERT INTO document_revision(project_id,document_id,revision_id,body,format,content_hash,author,created_at,reason) VALUES($1,$2,$3,'Fixed task','markdown',$4,'lead',$5,'fixture')", [project, documentId, docRevisionId, HASH, at]);
    await c.query(`INSERT INTO task(project_id,task_id,version,current_revision_id,title,acceptance,owner,state,content_document_id,content_revision_id)
      VALUES($1,$2,1,$3,'Fixed Task','Result',$4,'in_progress',$5,$6)`, [project, taskId, revisionId, role, documentId, docRevisionId]);
    await c.query(`INSERT INTO task_revision(project_id,task_id,revision_id,version,title,acceptance,owner,state,basis_set_id,actor_id,reason,created_at,content_document_id,content_revision_id)
      VALUES($1,$2,$3,1,'Fixed Task','Result',$7,'in_progress',$4,'lead','fixture',$8,$5,$6)`, [project, taskId, revisionId, basisId, documentId, docRevisionId, role, at]);
    await c.query('INSERT INTO basis_set(project_id,task_id,task_revision_id,basis_set_id,sealed) VALUES($1,$2,$3,$4,false)', [project, taskId, revisionId, basisId]);
    await c.query('INSERT INTO basis_member(project_id,task_id,task_revision_id,basis_set_id,document_id,document_revision_id) VALUES($1,$2,$3,$4,$5,$6)', [project, taskId, revisionId, basisId, documentId, docRevisionId]);
    await c.query('UPDATE basis_set SET sealed=true WHERE basis_set_id=$1', [basisId]);
    const operationId = randomUUID();
    await c.query(`INSERT INTO runtime_run(project_id,run_id,task_id,task_revision_id,basis_set_id,session_id,operation_id,input,input_hash,state,version,native_turn_id,actor_id,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,'Fixed input',$8,$9,1,$10,'worker',$11,$11)`, [project, runId, taskId, revisionId, basisId, sessionId, operationId, 'b'.repeat(64), runState, `turn-${runId}`, at]);
    await c.query("INSERT INTO operation_journal(project_id,operation_id,actor_id,command_hash,command_type,result,created_at) VALUES($1,$2,'worker',$3,'runtime.run.reserve','{}',$4)", [project, operationId, 'c'.repeat(64), at]);
    await c.query(`INSERT INTO task_session_assignment(project_id,task_id,version,task_revision_id,target_kind,target_id,recipient_actor_id,state,actor_id,reason,updated_at)
      VALUES($1,$2,1,$3,'owned',$4,'worker','assigned','worker','fixed recipient',now())`, [project, taskId, revisionId, sessionId]);
    await c.query('COMMIT');
  } catch (error) { await c.query('ROLLBACK'); throw error; } finally { c.release(); }
  return { runId, sessionId, taskId, revisionId, basisId, documentId, docRevisionId };
}
/** A recorded delivery and, after it, an observation of `result` with a reason of two sentences. Returns their ids. */
async function judged(f: Fixture, result: 'failed' | 'notUsed' | 'used', artifactRevision = 'r1', ago = -30) {
  const deliveryId = randomUUID(), observationId = randomUUID();
  await pool.query(`INSERT INTO delivery(project_id,delivery_id,task_id,task_revision_id,artifact_ref,artifact_revision,content_hash,technical_result,technical_evidence,reason,actor_id,created_at)
    VALUES($1,$2,$3,$4,'repo:test',$5,$6,'passed','e','r','worker',$7)`, [project, deliveryId, f.taskId, f.revisionId, artifactRevision, HASH, minutes(ago - 5)]);
  await pool.query(`INSERT INTO consumer_observation(project_id,observation_id,task_id,delivery_id,observer,observer_kind,result,evidence,reason,actor_id,created_at)
    VALUES($1,$2,$3,$4,'checker','agent',$5,'checked the sample','Condition two is not met. See the second sample for details.','checker',$6)`, [project, observationId, f.taskId, deliveryId, result, minutes(ago)]);
  return { deliveryId, observationId };
}
/** The consumer's Task changed after the observation: a new revision with another acceptance condition (a business input), same basis. */
async function reviseAcceptance(f: Fixture, acceptance = 'A new acceptance condition') {
  const revisionId = randomUUID(), basisId = randomUUID(), at = minutes(-10);
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query(`INSERT INTO task_revision(project_id,task_id,revision_id,version,title,acceptance,owner,state,basis_set_id,actor_id,reason,created_at,content_document_id,content_revision_id)
      VALUES($1,$2,$3,2,'Fixed Task',$8,$7,'in_progress',$4,'lead','criteria changed',$9,$5,$6)`, [project, f.taskId, revisionId, basisId, f.documentId, f.docRevisionId, role, acceptance, at]);
    await c.query('INSERT INTO basis_set(project_id,task_id,task_revision_id,basis_set_id,sealed) VALUES($1,$2,$3,$4,false)', [project, f.taskId, revisionId, basisId]);
    await c.query('INSERT INTO basis_member(project_id,task_id,task_revision_id,basis_set_id,document_id,document_revision_id) VALUES($1,$2,$3,$4,$5,$6)', [project, f.taskId, revisionId, basisId, f.documentId, f.docRevisionId]);
    await c.query('UPDATE basis_set SET sealed=true WHERE basis_set_id=$1', [basisId]);
    await c.query('UPDATE task SET version=2,current_revision_id=$3,acceptance=$4 WHERE project_id=$1 AND task_id=$2', [project, f.taskId, revisionId, acceptance]);
    await c.query('COMMIT');
  } catch (error) { await c.query('ROLLBACK'); throw error; } finally { c.release(); }
}
const taskVersion = async (f: Fixture) => (await uow.read(project, r => r.getTask(f.taskId)))!.version;
const deliveries = async (f: Fixture) => (await uow.read(project, r => r.listDeliveries(f.taskId))).length;
const record = async (f: Fixture, artifactRevision = 'r1') => workflow.execute({ ...writer, decisions: true } as never, { type: 'delivery.record', projectId: project, operationId: randomUUID(), taskId: f.taskId,
  expectedVersion: await taskVersion(f), artifactRef: 'repo:test', artifactRevision, contentHash: HASH, technicalResult: 'passed', technicalEvidence: 'e', reason: 'r' } as never);
const intent = async (f: Fixture, artifactRevision = 'r1') => {
  const run = (await uow.read(project, r => r.getRuntimeRun(f.runId)))!;
  return { projectId: project, operationId: randomUUID(), submissionId: randomUUID(), runId: f.runId, taskId: f.taskId, sessionId: f.sessionId,
    taskRevisionId: f.revisionId, runInputHash: run.inputHash, deliveryOperationId: randomUUID(),
    deliveryIntent: { artifactRef: 'repo:test', artifactRevision, contentHash: HASH, technicalResult: 'passed' as const, technicalEvidence: 'e', reason: 'r' } };
};
/** The same wiring the coordinator service uses: the guard runs inside the signed submission, reading the project on its own connection. */
const submit = async (f: Fixture, artifactRevision = 'r1') => {
  const client = await pool.connect();
  try {
    return await submitOrdinaryRun(new PgOrdinaryRunSubmissionStore(client, project), writer, await intent(f, artifactRevision), new Date().toISOString(), hasher,
      next => uow.read(project, reader => assertNotRejectedResubmission(reader, next.taskId, { artifactRevision: next.deliveryIntent.artifactRevision, contentHash: next.deliveryIntent.contentHash })));
  } finally { client.release(); }
};
const submissions = async (f: Fixture) => (await pool.query('SELECT count(*)::int AS n FROM ordinary_run_submission WHERE run_id=$1', [f.runId])).rows[0].n;

test('the same artifact again after a failed observation, on an unchanged Task, is refused at both entries and leaves nothing behind', async () => {
  const f = await fixture('running'), g = await fixture('completed');
  const a = await judged(f, 'failed'), b = await judged(g, 'failed');
  // Signed submission.
  await assert.rejects(submit(f), (error: Error & { code?: string }) => {
    assert.equal(error.code, CODE);
    assert.ok(error.message.includes(a.observationId), 'the observation id is in the message');
    assert.ok(error.message.includes(a.deliveryId), 'the rejected delivery is named');
    assert.ok(error.message.includes('Condition two is not met.'), 'the first sentence of the reason');
    assert.ok(!error.message.includes('See the second sample'), 'only the first sentence');
    assert.match(error.message, /验收条件/, 'how to continue');
    return true;
  });
  assert.equal(await submissions(f), 0, 'a refused submission is not stored');
  assert.equal((await uow.read(project, r => r.getRuntimeRun(f.runId)))!.state, 'running', 'the Run is untouched');
  // delivery.record.
  const refused = await record(g);
  assert.equal(refused.status, 'rejected'); assert.equal((refused as { code?: string }).code, CODE);
  assert.ok(JSON.stringify(refused).includes(b.observationId));
  assert.equal(await deliveries(g), 1, 'no delivery was recorded by the refused attempt');
  assert.equal(await taskVersion(g), 1, 'and the Task did not move');
  // notUsed is sent back as well.
  const h = await fixture('completed'); await judged(h, 'notUsed');
  assert.equal((await record(h) as { code?: string }).code, CODE);
});

test('not refused: a changed artifact, a Task that changed after the observation, a last observation of used, and another Task', async () => {
  // 1. The artifact changed.
  const changed = await fixture('completed'); await judged(changed, 'failed');
  assert.equal((await record(changed, 'r2')).status, 'applied');
  assert.equal(await deliveries(changed), 2);
  // 2. The same artifact, but the Task has a new revision with another acceptance condition since the observation.
  const revised = await fixture('completed'); await judged(revised, 'failed', 'r1', -30); await reviseAcceptance(revised);
  assert.equal((await record(revised)).status, 'applied', 'a fair new check against the new condition');
  const revisedRunning = await fixture('running'); await judged(revisedRunning, 'failed', 'r1', -30); await reviseAcceptance(revisedRunning);
  assert.equal((await submit(revisedRunning)).state, 'submitted', 'the signed submission passes too');
  // 3. The last observation was used.
  const used = await fixture('completed'); await judged(used, 'used');
  assert.equal((await record(used)).status, 'applied');
  const failedThenUsed = await fixture('completed'); await judged(failedThenUsed, 'failed', 'r1', -40); await judged(failedThenUsed, 'used', 'r2', -20);
  assert.equal((await record(failedThenUsed)).status, 'applied', 'a later used observation means the judgement moved on');
  // 4. Another Task with the same artifact.
  const sent = await fixture('completed'); await judged(sent, 'failed');
  const other = await fixture('completed');
  assert.equal((await record(other)).status, 'applied', 'another Task is not affected');
  assert.equal((await record(sent) as { code?: string }).code, CODE, 'while the first one still is');
});

test('a revision the system makes with the same content does not count as a change', async () => {
  const f = await fixture('completed'); await judged(f, 'failed');
  // A same-content revision (as a Run start makes) after the observation: only ids and versions differ.
  await reviseAcceptance(f, 'Result');
  assert.equal((await record(f) as { code?: string }).code, CODE);
});
