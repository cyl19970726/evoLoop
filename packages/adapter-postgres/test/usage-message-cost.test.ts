// Defect 44ba20f6: the daily usage ledger's cost covered Runs only; a message Turn added its tokens and a cost of 0, so for a Claude Session that answers mostly messages the cost was
// a fraction of what the tokens say. Real PostgreSQL, the real services: a Claude Session does one Run and two message Turns, and the day's row must carry all three costs.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import pg from 'pg';
import { RuntimeWorkflowService, UsageService } from '@evoloop/core';
import { SessionMessageService } from '@evoloop/core/session-messages';
import { migrate, PostgresUnitOfWork } from '../src/index.ts';

const url = process.env.TEST_DATABASE_URL;
if (!url || !/^evoloop(?:_[a-z0-9]+)*_test$/.test(decodeURIComponent(new URL(url).pathname.slice(1))))
  throw new Error('usage message cost test requires a dedicated evoLoop test database');
const schema = `el_usage_cost_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
const pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}` });
const uow = new PostgresUnitOfWork(pool);
const hasher = { hash: (value: string) => createHash('sha256').update(value).digest('hex') };
const clock = { now: () => new Date().toISOString() };
const ids = { next: randomUUID };
const usageDay = () => '2026-11-14';
const runtime = new RuntimeWorkflowService({ uow, clock, ids, hasher, usageDay } as never);
const project = randomUUID(), role = randomUUID();
const reviewer = { actorId: 'lead', projectIds: [project], permissions: ['read' as const, 'write' as const, 'review' as const] };

before(async () => {
  await migrate(url!, schema);
  await pool.query("INSERT INTO project(project_id,title,created_at) VALUES($1,'Usage cost test',now())", [project]);
});
after(async () => {
  await pool.end();
  const c = new pg.Client({ connectionString: url }); await c.connect();
  try { await c.query(`DROP SCHEMA "${schema}" CASCADE`); } finally { await c.end(); }
});

async function session(provider: 'claude' | 'codex'): Promise<string> {
  const sessionId = randomUUID();
  await pool.query(`INSERT INTO runtime_session(project_id,session_id,role_id,cwd,authorization_scope,sandbox,approval_policy,state,version,native_thread_id,native_session_id,operation_id,actor_id,created_at,updated_at,runtime_provider)
    VALUES($1,$2,$3,'/tmp/usage-cost','project','danger-full-access','never','ready',1,$4,$4,$5,'worker',now(),now(),$6)`, [project, sessionId, role, randomUUID(), randomUUID(), provider]);
  return sessionId;
}
/** A running Run on the Session, with its Task, basis and journal row (the shape the Run tests use). */
async function runningRun(sessionId: string): Promise<{ runId: string }> {
  const runId = randomUUID(), operationId = randomUUID(), taskId = randomUUID(), revisionId = randomUUID(), basisId = randomUUID(), documentId = randomUUID(), docRevisionId = randomUUID();
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query("INSERT INTO process_document(project_id,document_id,title,version,current_revision_id,kind,status) VALUES($1,$2,'Fixed Task',1,$3,'task','draft')", [project, documentId, docRevisionId]);
    await c.query("INSERT INTO document_revision(project_id,document_id,revision_id,body,format,content_hash,author,created_at,reason) VALUES($1,$2,$3,'Fixed task','markdown',$4,'lead',now(),'fixture')", [project, documentId, docRevisionId, 'a'.repeat(64)]);
    await c.query(`INSERT INTO task(project_id,task_id,version,current_revision_id,title,acceptance,owner,state,content_document_id,content_revision_id) VALUES($1,$2,1,$3,'Fixed Task','Result',$4,'in_progress',$5,$6)`, [project, taskId, revisionId, role, documentId, docRevisionId]);
    await c.query(`INSERT INTO task_revision(project_id,task_id,revision_id,version,title,acceptance,owner,state,basis_set_id,actor_id,reason,created_at,content_document_id,content_revision_id) VALUES($1,$2,$3,1,'Fixed Task','Result',$7,'in_progress',$4,'lead','fixture',now(),$5,$6)`, [project, taskId, revisionId, basisId, documentId, docRevisionId, role]);
    await c.query('INSERT INTO basis_set(project_id,task_id,task_revision_id,basis_set_id,sealed) VALUES($1,$2,$3,$4,false)', [project, taskId, revisionId, basisId]);
    await c.query('INSERT INTO basis_member(project_id,task_id,task_revision_id,basis_set_id,document_id,document_revision_id) VALUES($1,$2,$3,$4,$5,$6)', [project, taskId, revisionId, basisId, documentId, docRevisionId]);
    await c.query('UPDATE basis_set SET sealed=true WHERE basis_set_id=$1', [basisId]);
    await c.query(`INSERT INTO runtime_run(project_id,run_id,task_id,task_revision_id,basis_set_id,session_id,operation_id,input,input_hash,state,version,native_turn_id,actor_id,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,'Fixed input',$8,'running',1,$9,'worker',now(),now())`, [project, runId, taskId, revisionId, basisId, sessionId, operationId, 'b'.repeat(64), `turn-${runId}`]);
    await c.query("INSERT INTO operation_journal(project_id,operation_id,actor_id,command_hash,command_type,result,created_at) VALUES($1,$2,'worker',$3,'runtime.run.reserve','{}',now())", [project, operationId, 'c'.repeat(64)]);
    await c.query('COMMIT');
  } catch (error) { await c.query('ROLLBACK'); throw error; } finally { c.release(); }
  return { runId };
}
/** A queued message taken through the real service path: dispatch, then bind its native Turn; ready to be settled. */
async function boundMessage(sessionId: string): Promise<{ messageId: string; turnId: string }> {
  const messageId = randomUUID(), turnId = `turn-${messageId}`;
  await pool.query(`INSERT INTO session_message(project_id,message_id,operation_id,target_kind,session_id,sender_actor_id,content,state,version,created_at,updated_at)
    VALUES($1,$2,$3,'owned',$4,'lead','Please check the delivery','queued',1,now(),now())`, [project, messageId, randomUUID(), sessionId]);
  const service = messages(sessionId);
  await service.beginDispatch(project, messageId, randomUUID(), randomUUID(), 'a'.repeat(64));
  await service.bindTurn(project, messageId, { id: turnId, status: 'inProgress', startedAtUtc: new Date().toISOString(), completedAtUtc: null } as never);
  return { messageId, turnId };
}
const messages = (sessionId: string) => new SessionMessageService({ uow, clock, ids, usageDay,
  grantFor: async () => ({ projectId: project, sessionId, senderActorId: 'lead', receiverActorId: 'worker', receiverRoleId: role, cwd: "/tmp/usage-cost", maxTurns: 50, enabled: true }) } as never);
const turnWith = (turnId: string, usage: { inputTokens: number; outputTokens: number; cacheReadInputTokens: number; cacheCreationInputTokens: number }, costUsd: number | null) =>
  ({ id: turnId, status: 'completed' as const, startedAtUtc: new Date().toISOString(), completedAtUtc: new Date().toISOString(), usage, costUsd });
const ledger = async (sessionId: string) => (await pool.query(
  'SELECT day::text,input_tokens::int AS input,output_tokens::int AS output,cached_input_tokens::int AS cached,cost_usd::float AS cost,cost_reported,cost_scope FROM session_usage_daily WHERE project_id=$1 AND session_id=$2 ORDER BY day', [project, sessionId])).rows;

test('a Claude Session with one Run and two message Turns: the day\'s cost is the sum of all three, with the tokens', async () => {
  const sessionId = await session('claude');
  const { runId } = await runningRun(sessionId);
  // The Run: 100 + 400 + 100 input (inclusive of cache), 50 output, $0.30.
  await runtime.recordTurn(project, runId, `turn-${runId}`, 'completed', 'done', { completedAtUtc: new Date().toISOString(),
    usage: { inputTokens: 100, outputTokens: 50, cacheReadInputTokens: 400, cacheCreationInputTokens: 100 }, costUsd: 0.30 });
  // Two message Turns: $0.10 and $0.20.
  const service = messages(sessionId);
  const first = await boundMessage(sessionId);
  await service.settle(project, first.messageId, turnWith(first.turnId, { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 40, cacheCreationInputTokens: 10 }, 0.10) as never, 'reply one');
  const second = await boundMessage(sessionId); // one message occupies a Session at a time
  await service.settle(project, second.messageId, turnWith(second.turnId, { inputTokens: 20, outputTokens: 10, cacheReadInputTokens: 80, cacheCreationInputTokens: 20 }, 0.20) as never, 'reply two');
  const [row] = await ledger(sessionId);
  // Tokens: (100+500) + (10+50) + (20+100) = 780 input, 65 output, 650 cached... exact values below.
  assert.deepEqual([row!.input, row!.output, row!.cached], [600 + 60 + 120, 50 + 5 + 10, 500 + 50 + 100]);
  assert.ok(Math.abs(row!.cost - 0.60) < 1e-9, `the day's cost is $0.60 (Run 0.30 + messages 0.10 + 0.20), was ${row!.cost}`);
  assert.equal(row!.cost_reported, true);
  assert.equal(row!.cost_scope, 'all_turns', 'a day recorded after the change covers every Turn');
  // A Turn settled twice counts once: the second settle of the same message returns before it touches the ledger.
  await service.settle(project, second.messageId, turnWith(second.turnId, { inputTokens: 20, outputTokens: 10, cacheReadInputTokens: 80, cacheCreationInputTokens: 20 }, 0.20) as never, 'reply two');
  assert.ok(Math.abs((await ledger(sessionId))[0]!.cost - 0.60) < 1e-9, 'the same Turn is not counted twice');
  // The overview the workbench reads: the same cost, complete.
  const overview = await new UsageService({ uow, clock }).overview(reviewer, project, '2026-11-14', '2026-11-14', 'UTC', null);
  const mine = overview.sessions.find(s => s.sessionId === sessionId)!;
  assert.ok(Math.abs((mine.total.costUsd ?? 0) - 0.60) < 1e-9); assert.equal(mine.total.costScope, 'all_turns'); assert.equal(mine.total.costReported, true);
});

test('a message Turn that reports no cost keeps the day marked as not fully reported; Codex is not touched (its native observation counts the tokens and it reports no cost)', async () => {
  const sessionId = await session('claude');
  const bound = await boundMessage(sessionId);
  await messages(sessionId).settle(project, bound.messageId, turnWith(bound.turnId, { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 }, null) as never, 'reply');
  const [row] = await ledger(sessionId);
  assert.deepEqual([row!.input, row!.cost, row!.cost_reported], [10, 0, false], 'no reported cost: zero and not reported, never a made-up number');
  const codex = await session('codex');
  const codexBound = await boundMessage(codex);
  await messages(codex).settle(project, codexBound.messageId, turnWith(codexBound.turnId, { inputTokens: 999, outputTokens: 9, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 }, 5) as never, 'reply');
  assert.deepEqual(await ledger(codex), [], 'a Codex message Turn writes nothing here (the native observation counts it), so its cost is unchanged');
});

test('history is not rewritten: rows that existed before migration 112 are marked runs_only and say so in the overview; new days are all_turns', async () => {
  const sessionId = await session('claude');
  // A row as it was before the change: the column did not exist, so the migration gave it the then-default.
  await pool.query("INSERT INTO session_usage_daily(project_id,session_id,day,input_tokens,output_tokens,cached_input_tokens,cost_usd,cost_reported,cost_scope) VALUES($1,$2,'2026-11-10',1000,100,0,1.5,true,'runs_only')", [project, sessionId]);
  await pool.query("INSERT INTO session_usage_daily(project_id,session_id,day,input_tokens,output_tokens,cached_input_tokens,cost_usd,cost_reported) VALUES($1,$2,'2026-11-14',500,50,0,0.8,true)", [project, sessionId]);
  const rows = await ledger(sessionId);
  assert.deepEqual(rows.map(r => [r.day, r.cost_scope]), [['2026-11-10', 'runs_only'], ['2026-11-14', 'all_turns']], 'the default of a new row is all_turns; the history keeps its mark');
  const overview = await new UsageService({ uow, clock }).overview(reviewer, project, '2026-11-10', '2026-11-14', 'UTC', null);
  const mine = overview.sessions.find(s => s.sessionId === sessionId)!;
  assert.deepEqual(mine.days.map(d => [d.day, d.costScope]), [['2026-11-10', 'runs_only'], ['2026-11-14', 'all_turns']]);
  assert.equal(mine.total.costScope, 'runs_only', 'a total that includes a history day is marked runs_only');
  assert.ok(Math.abs((mine.total.costUsd ?? 0) - 2.3) < 1e-9, 'the numbers themselves are not changed');
});
