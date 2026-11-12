import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import pg from "pg";
import type { Principal } from "@evoloop/contracts";
import type { WorkflowService } from "@evoloop/core";
import { WorkflowService as RealWorkflow } from "@evoloop/core";
import { migrate, PostgresUnitOfWork } from "@evoloop/adapter-postgres";
import { buildServer } from "../../apps/coordinator/src/server.ts";
import { DrainControl, isInstanceMaintainer } from "../../apps/coordinator/src/drain/service.ts";

const url = process.env.TEST_DATABASE_URL;
if (!url || !/^evoloop(?:_[a-z0-9]+)*_test$/.test(decodeURIComponent(new URL(url).pathname.slice(1))))
  throw new Error("Drain tests require a dedicated evoloop test database");
const schema = `el_drain_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
const pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}` });
const projectId = randomUUID(), otherProject = randomUUID(), roleId = randomUUID(), sessionId = randomUUID();
const at = "2026-11-10T00:00:00.000Z";
const maintainer: Principal = { actorId: "maintainer", projectIds: [projectId, otherProject], permissions: ["read", "write", "review"] };
const business: Principal = { actorId: "business-session", projectIds: [projectId], permissions: ["read", "write", "review"] };

before(async () => {
  await migrate(url!, schema);
  for (const id of [projectId, otherProject]) await pool.query("INSERT INTO project(project_id,title,created_at) VALUES($1,'Drain',$2)", [id, at]);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const revision = randomUUID();
    await client.query(`INSERT INTO role_definition(project_id,role_id,version,current_revision_id,state,proposed_by,created_at_utc,review_at_utc) VALUES($1,$2,1,$3,'active','a',$4,'2026-12-06T00:00:00.000Z')`, [projectId, roleId, revision, at]);
    await client.query(`INSERT INTO role_revision(project_id,role_id,revision_id,version,state,proposal,actor_id,reason,created_at_utc,review_at_utc) VALUES($1,$2,$3,1,'active','{}'::jsonb,'a','t',$4,'2026-12-06T00:00:00.000Z')`, [projectId, roleId, revision, at]);
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  await pool.query(`INSERT INTO runtime_session(project_id,session_id,role_id,cwd,authorization_scope,sandbox,approval_policy,state,version,native_thread_id,native_session_id,operation_id,actor_id,created_at,updated_at)
    VALUES($1,$2,$3,'/tmp/drain','project','danger-full-access','never','ready',1,'thread','native',$4,'agent',now(),now())`, [projectId, sessionId, roleId, randomUUID()]);
});
after(async () => {
  await pool.end(); const client = new pg.Client({ connectionString: url! }); await client.connect();
  try { await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } finally { await client.end(); }
});

// One Turn at a time occupies a Session, so each in-flight Turn in these tests has its own.
async function otherSession(): Promise<string> {
  const id = randomUUID();
  await pool.query(`INSERT INTO runtime_session(project_id,session_id,role_id,cwd,authorization_scope,sandbox,approval_policy,state,version,native_thread_id,native_session_id,operation_id,actor_id,created_at,updated_at)
    VALUES($1,$2,$3,'/tmp/drain','project','danger-full-access','never','ready',1,$4,$5,$6,'agent',now(),now())`, [projectId, id, roleId, `thread-${id}`, `native-${id}`, randomUUID()]);
  return id;
}
async function message(state = "queued", target = sessionId): Promise<string> {
  const id = randomUUID();
  await pool.query(`INSERT INTO session_message(project_id,message_id,operation_id,target_kind,session_id,sender_actor_id,content,state,version,created_at,updated_at) VALUES($1,$2,$3,'owned',$4,'sender','hello',$5,1,now(),now())`, [projectId, id, randomUUID(), target, state]);
  return id;
}
async function turn(messageId: string, state: string, target: string): Promise<string> {
  const id = randomUUID();
  await pool.query(`INSERT INTO session_message_processing(project_id,processing_id,message_id,session_id,operation_id,receiver_actor_id,read_only_policy_fingerprint,state,version,started_at,updated_at) VALUES($1,$2,$3,$4,$5,'receiver',$7,$6,1,now(),now())`, [projectId, id, messageId, target, randomUUID(), state, "a".repeat(64)]);
  return id;
}

test("start and release are kept across restarts with who, when and why; repeating the state in force records nothing", async () => {
  const drain = new DrainControl(pool, { cacheMs: 0 });
  assert.deepEqual([(await drain.status()).state, await drain.holdNewStarts()], ["active", false]);
  await assert.rejects(drain.set(maintainer, "start", "  "), /reason is required/i);
  const started = await drain.set(maintainer, "start", "发布 0dd0baa");
  assert.equal(started.changed, true);
  assert.deepEqual([started.status.state, started.status.holding, started.status.actorId, started.status.reason, started.status.version], ["drained", true, "maintainer", "发布 0dd0baa", 2]);
  assert.equal(await drain.holdNewStarts(), true);
  // A new control (as after a restart) reads the same state from the database.
  const restarted = new DrainControl(pool, { cacheMs: 0 });
  assert.equal(await restarted.holdNewStarts(), true);
  const again = await restarted.set(business, "start", "someone else");
  assert.equal(again.changed, false, "already draining: nothing changes");
  assert.equal(again.status.actorId, "maintainer", "who started it is not overwritten");
  const released = await restarted.set(maintainer, "release", "发布完成");
  assert.deepEqual([released.changed, released.status.state, await restarted.holdNewStarts()], [true, "active", false]);
  assert.equal((await restarted.set(maintainer, "release", "again")).changed, false);
  const history = await restarted.history();
  assert.deepEqual(history.map(item => [item.action, item.version, item.actorId, item.reason]), [["release", 3, "maintainer", "发布完成"], ["start", 2, "maintainer", "发布 0dd0baa"]]);
  assert.ok(history.every(item => Number.isFinite(Date.parse(item.at))));
  await assert.rejects(pool.query("UPDATE instance_drain_event SET reason='x'"), /immutable/i, "the record cannot be edited");
});

test("a drain with work in flight is 'draining', becomes 'drained' only when the last Turn ends, and queued work waits untouched", async () => {
  const drain = new DrainControl(pool, { cacheMs: 0 });
  const queued = [await message(), await message(), await message()];
  const [s1, s2] = [await otherSession(), await otherSession()];
  const running = await message("processing", s1), dispatching = await message("processing", s2);
  const runningTurn = await turn(running, "running", s1), dispatchingTurn = await turn(dispatching, "dispatching", s2);
  await drain.set(maintainer, "start", "release test");
  let status = await drain.status();
  assert.deepEqual([status.state, status.safeToStop, status.inFlight.counts.messageTurns, status.queued.messages], ["draining", false, 2, 3]);
  assert.deepEqual(status.inFlight.messageTurns.map(item => item.messageId).sort(), [running, dispatching].sort(), "what is left is named");
  // The Turns finish normally: the instance drains without touching what is queued.
  await pool.query("UPDATE session_message_processing SET state='failed',failure='test: the Turn ended',version=version+1,updated_at=now() WHERE processing_id=$1", [dispatchingTurn]);
  assert.equal((await drain.status()).state, "draining", "one Turn is still running");
  await pool.query("UPDATE session_message_processing SET state='failed',failure='test: the Turn ended',version=version+1,updated_at=now() WHERE processing_id=$1", [runningTurn]);
  status = await drain.status();
  assert.deepEqual([status.state, status.safeToStop, status.inFlight.counts.total, status.queued.messages], ["drained", true, 0, 3]);
  // An unknown Turn is not safe to stop around, so it keeps the drain open.
  const s3 = await otherSession();
  const stray = await message("processing", s3); const strayTurn = await turn(stray, "unknown", s3);
  assert.deepEqual([(await drain.status()).state, (await drain.status()).inFlight.counts.messageTurns], ["draining", 1]);
  await pool.query("UPDATE session_message_processing SET state='failed',failure='test: reconciled',version=version+1,updated_at=now() WHERE processing_id=$1", [strayTurn]);
  assert.equal((await drain.status()).state, "drained");
  await drain.set(maintainer, "release", "done");
  assert.deepEqual(queued.length, 3);
});

test("a message is still saved while draining, and a drained instance releases back to normal", async () => {
  const drain = new DrainControl(pool, { cacheMs: 0 });
  const uow = new PostgresUnitOfWork(pool);
  const workflow = new RealWorkflow({ uow, clock: { now: () => at }, ids: { next: randomUUID }, hasher: { hash: id => id } });
  await drain.set(maintainer, "start", "saving test");
  const before = (await drain.status()).queued.messages;
  const messageId = randomUUID();
  const result = await workflow.execute({ ...business, permissions: ["read", "write"] }, { type: "session.message.post", projectId, operationId: randomUUID(), messageId, target: { kind: "owned", sessionId }, content: "排空时的新消息" });
  assert.equal(result.status, "applied", JSON.stringify(result));
  const saved = (await pool.query("SELECT state,content FROM session_message WHERE message_id=$1", [messageId])).rows[0];
  assert.deepEqual([saved.state, saved.content], ["queued", "排空时的新消息"], "saved and queued, nothing started");
  assert.equal((await drain.status()).queued.messages, before + 1);
  await drain.set(maintainer, "release", "saving test done");
});

test("only an instance maintainer may start or release; anyone may read the state; the lists are the maintainer's", async () => {
  assert.equal(await isInstanceMaintainer(pool, maintainer), true);
  assert.equal(await isInstanceMaintainer(pool, business), false, "a Session with review in one project is not a maintainer of the instance");
  assert.equal(await isInstanceMaintainer(pool, { ...maintainer, permissions: ["read", "write"] }), false);
  const drain = new DrainControl(pool, { cacheMs: 0 });
  const tokens = { maintainer: "m".repeat(40), business: "b".repeat(40) };
  const base = { getProject: async () => ({ id: projectId }) } as Record<string, unknown>;
  const service = new Proxy(base, { get: (target, name) => name in target ? target[name as string] : async () => undefined }) as unknown as WorkflowService;
  const app = await buildServer({ service, credentials: [{ token: tokens.maintainer, ...maintainer, projectIds: maintainer.projectIds, permissions: maintainer.permissions },
    { token: tokens.business, ...business, projectIds: business.projectIds, permissions: business.permissions }],
    drain: { control: drain, isMaintainer: principal => isInstanceMaintainer(pool, principal) } });
  const call = (method: "GET" | "POST", path: string, token: string, payload?: unknown) => app.inject({ method, url: path, headers: { authorization: `Bearer ${token}` }, ...(payload ? { payload } : {}) });
  try {
    assert.equal((await app.inject({ url: "/api/instance/drain" })).statusCode, 401);
    const refused = await call("POST", "/api/instance/drain", tokens.business, { action: "start", reason: "self-service" });
    assert.equal(refused.statusCode, 403);
    assert.equal((await drain.status()).state, "active", "a business Session cannot start a drain");
    assert.equal((await call("POST", "/api/instance/drain", tokens.maintainer, { action: "start" })).statusCode, 400, "a reason is required");
    const started = await call("POST", "/api/instance/drain", tokens.maintainer, { action: "start", reason: "route test" });
    assert.equal(started.statusCode, 200);
    assert.deepEqual([started.json().changed, started.json().status.holding], [true, true]);
    const seenByBusiness = (await call("GET", "/api/instance/drain", tokens.business)).json();
    assert.deepEqual([seenByBusiness.holding, seenByBusiness.maintainer, seenByBusiness.inFlight.runs, seenByBusiness.inFlight.messageTurns], [true, false, [], []]);
    const seenByMaintainer = (await call("GET", "/api/instance/drain", tokens.maintainer)).json();
    assert.equal(seenByMaintainer.maintainer, true);
    assert.equal((await call("GET", "/api/instance/drain/history", tokens.business)).statusCode, 403);
    assert.ok((await call("GET", "/api/instance/drain/history", tokens.maintainer)).json().items.length >= 1);
    assert.equal((await call("POST", "/api/instance/drain", tokens.business, { action: "release", reason: "x" })).statusCode, 403);
    assert.equal((await drain.status()).state === "active", false, "still drained: a business Session cannot release it either");
    assert.equal((await call("POST", "/api/instance/drain", tokens.maintainer, { action: "release", reason: "route test done" })).statusCode, 200);
  } finally { await app.close(); }
});
