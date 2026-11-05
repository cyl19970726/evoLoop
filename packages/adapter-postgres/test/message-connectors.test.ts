import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import pg from "pg";
import type { ConnectorRoute } from "@evoloop/contracts/message-connectors";
import { migrate, PgConnectorRoutes } from "../src/index.ts";

const url = process.env.TEST_DATABASE_URL;
if (!url || !/^evoloop(?:_[a-z0-9]+)*_test$/.test(decodeURIComponent(new URL(url).pathname.slice(1))))
  throw new Error("Connector route tests require a dedicated evoloop test database");
const schema = `el_connector_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
const pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}` });
const routes = new PgConnectorRoutes(pool);
const create = (input: ConnectorRoute, operationId = randomUUID(), actorId = "lead") =>
  routes.create(input,operationId,actorId);
const update = (input: Parameters<PgConnectorRoutes["update"]>[0], expectedVersion: number,
  operationId = randomUUID(), actorId = "lead") => routes.update(input,expectedVersion,operationId,actorId);
const projectId = randomUUID(), otherProjectId = randomUUID();
const sessionId = randomUUID(), secondSessionId = randomUUID(), otherSessionId = randomUUID();
const now = new Date().toISOString();
const capabilities = { history: true, search: false, subscribe: true,
  sendText: false, sendMedia: false, receipt: "none" as const };
function route(project: string, session: string, conversation: string): ConnectorRoute {
  return { projectId: project, bindingId: randomUUID(),
    source: { provider: "wechat", connectionId: "connection-1", conversationId: conversation },
    targetSessionId: session, targetActorId: "receiver", senderActorId: "gateway",
    owner: "channel-owner", epoch: 1, sessionRef: "channel-session-1",
    state: "disabled", capabilities, policyHash: "a".repeat(64) };
}
before(async () => {
  await migrate(url!, schema);
  for (const id of [projectId,otherProjectId])
    await pool.query("INSERT INTO project(project_id,title,created_at) VALUES($1,'Connector',$2)", [id,now]);
  for (const [project,session] of [[projectId,sessionId],[projectId,secondSessionId],
    [otherProjectId,otherSessionId]])
    await pool.query(`INSERT INTO runtime_session(project_id,session_id,role_id,cwd,authorization_scope,
      sandbox,approval_policy,state,version,native_thread_id,native_session_id,operation_id,actor_id,created_at,updated_at)
      VALUES($1,$2,'worker','/tmp','project','danger-full-access','never','ready',1,$3,$4,$5,'lead',$6,$6)`,
      [project,session,`thread-${session}`,`native-${session}`,randomUUID(),now]);
});
after(async () => {
  await pool.end();
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try { await client.query(`DROP SCHEMA "${schema}" CASCADE`); } finally { await client.end(); }
});

test("disabled creation, project scoped reads, page cursor, and CAS", async () => {
  const createIntent = route(projectId,sessionId,"group-a"), createOperationId = randomUUID();
  const first = await create(createIntent,createOperationId);
  const second = await create(route(projectId,secondSessionId,"group-b"));
  assert.equal(first.version,1);
  assert.equal(first.state,"disabled");
  assert.deepEqual(await routes.get(projectId,first.bindingId),first);
  assert.equal(await routes.get(otherProjectId,first.bindingId),null);
  const page = await routes.list(projectId,1);
  assert.equal(page.items.length,1);
  assert.ok(page.nextCursor);
  assert.deepEqual([...page.items,...(await routes.list(projectId,1,page.nextCursor!)).items]
    .map(x=>x.bindingId).sort(),[first.bindingId,second.bindingId].sort());
  assert.equal((await routes.list(otherProjectId,10)).items.length,0);
  const badReferenceOperationId = randomUUID();
  await assert.rejects(create(route(otherProjectId,sessionId,"group-c"),badReferenceOperationId),
    (e: unknown) => !!e && typeof e === "object" && "code" in e && e.code === "CONNECTOR_ROUTE_REFERENCE");
  assert.equal(await routes.operation(otherProjectId,badReferenceOperationId),null);
  const updateIntent = { ...first, version:2, policyHash:"b".repeat(64) }, updateOperationId = randomUUID();
  const revised = await update(updateIntent,1,updateOperationId);
  assert.equal(revised.state,"disabled");
  assert.equal(revised.version,2);
  await assert.rejects(update({ ...first, version:2 },1),/Route version changed/);
  await assert.rejects(update({ ...revised, version:3, source:{ ...revised.source, conversationId:"other" } },2),
    /immutable/);
  const badEpochOperationId = randomUUID();
  await assert.rejects(update({ ...revised, version:3, owner:"new-owner" },2,badEpochOperationId),
    (e: unknown) => !!e && typeof e === "object" && "code" in e && e.code === "CONNECTOR_ROUTE_REFUSED");
  assert.equal(await routes.operation(projectId,badEpochOperationId),null);
  const transferred = await update({ ...revised, version:3, owner:"new-owner", epoch:2 },2);
  assert.equal(transferred.epoch,2);
  // Simulate a committed write whose response was lost, then retry after newer writes.
  assert.deepEqual(await create(createIntent,createOperationId),first);
  assert.deepEqual(await update(updateIntent,1,updateOperationId),revised);
  assert.equal((await routes.get(projectId,first.bindingId))?.version,3);
  const journal = await routes.operation(projectId,updateOperationId);
  assert.equal(journal?.kind,"update");
  assert.equal(journal?.actorId,"lead");
  assert.equal(journal?.requestHash.length,64);
  assert.deepEqual(journal?.result,revised);
  assert.equal(await routes.operation(otherProjectId,updateOperationId),null);
  await assert.rejects(update({ ...updateIntent, policyHash:"c".repeat(64) },1,updateOperationId),
    /different intent/);
  await assert.rejects(create(createIntent,createOperationId,"other-actor"),/different intent/);
});

test("concurrent same-operation create commits one route and one recoverable result", async () => {
  const intent = route(projectId,sessionId,"group-concurrent"), operationId = randomUUID();
  const [a,b] = await Promise.all([create(intent,operationId),create(intent,operationId)]);
  assert.deepEqual(a,b);
  assert.deepEqual((await routes.operation(projectId,operationId))?.result,a);
  const count = await pool.query(`SELECT count(*)::int AS n FROM connector_route_operation
    WHERE project_id=$1 AND operation_id=$2`,[projectId,operationId]);
  assert.equal(count.rows[0].n,1);
});

test("global live source and project receiver indexes reserve paused rows", async () => {
  const existing = (await routes.list(projectId,10)).items.find(x=>x.source.conversationId === "group-a")!;
  const sourceDuplicate = await create(route(otherProjectId,otherSessionId,"group-a"));
  const receiverDuplicate = await create(route(projectId,sessionId,"group-c"));
  await assert.rejects(update({ ...sourceDuplicate, version:2, state:"paused" },1),/unverified/);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Exercise the future live indexes inside a rolled back migration simulation.
    await client.query("ALTER TABLE connector_route DROP CONSTRAINT connector_route_activation_unproven");
    await client.query("UPDATE connector_route SET state='paused',version=version+1 WHERE project_id=$1 AND binding_id=$2",
      [projectId,existing.bindingId]);
    await client.query("SAVEPOINT source_duplicate");
    await assert.rejects(client.query("UPDATE connector_route SET state='paused',version=version+1 WHERE project_id=$1 AND binding_id=$2",
      [otherProjectId,sourceDuplicate.bindingId]),
      (e: unknown) => !!e && typeof e === "object" && "constraint" in e && e.constraint === "connector_route_source_live");
    await client.query("ROLLBACK TO SAVEPOINT source_duplicate");
    await client.query("SAVEPOINT receiver_duplicate");
    await assert.rejects(client.query("UPDATE connector_route SET state='paused',version=version+1 WHERE project_id=$1 AND binding_id=$2",
      [projectId,receiverDuplicate.bindingId]),
      (e: unknown) => !!e && typeof e === "object" && "constraint" in e && e.constraint === "connector_route_session_live");
    await client.query("ROLLBACK TO SAVEPOINT receiver_duplicate");
  } finally { await client.query("ROLLBACK"); client.release(); }
  assert.equal((await routes.get(projectId,existing.bindingId))?.state,"disabled");
  assert.equal((await routes.get(otherProjectId,sourceDuplicate.bindingId))?.state,"disabled");
});

test("activation requires restricted receiver proof and SQL independently blocks active state", async () => {
  const saved = await create(route(otherProjectId,otherSessionId,"group-d"));
  await assert.rejects(update({ ...saved, version:2, state:"active" },1),
    /exact owned Session lacks an active restricted profile/i);
  assert.equal((await routes.get(otherProjectId,saved.bindingId))?.state,"disabled");
  await assert.rejects(pool.query(`UPDATE connector_route SET state='active',version=version+1
    WHERE project_id=$1 AND binding_id=$2`,[otherProjectId,saved.bindingId]),
    (e: unknown) => !!e && typeof e === "object" && "constraint" in e &&
      e.constraint === "connector_route_activation_unproven");
  await assert.rejects(create({ ...route(projectId,secondSessionId,"group-e"), state:"active" }),
    /start disabled/);
});
