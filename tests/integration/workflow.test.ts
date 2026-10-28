import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import pg from "pg";
import { WorkflowService } from "@evoloop/core";
import { PostgresUnitOfWork, migrate } from "@evoloop/adapter-postgres";
import type { Command, CommandResult, Principal, AppliedResult } from "@evoloop/contracts";
import type { Transaction, UnitOfWork } from "@evoloop/contracts/ports";
import { buildServer } from "../../apps/coordinator/src/server.js";
import { acquireCoordinatorLease } from "../../apps/coordinator/src/lease.js";
import { fixtureRoleId, seedFixtureRole } from "./role-fixture.test.js";

const url = process.env.TEST_DATABASE_URL;
if (!url || !/\/evoloop_[a-z0-9_]*test(?:\?|$)/.test(url)) throw new Error("TEST_DATABASE_URL must identify a dedicated evoloop_*test database.");
const pool = new pg.Pool({ connectionString: url, max: 6 });
const uow = new PostgresUnitOfWork(pool);
const makeService = (store: UnitOfWork = uow) => new WorkflowService({
  uow: store, clock: { now: () => new Date().toISOString() }, ids: { next: randomUUID },
  hasher: { hash: value => createHash("sha256").update(value).digest("hex") },
});
const service = makeService();
const applied = (result: CommandResult): AppliedResult => { assert.equal(result.status, "applied", JSON.stringify(result)); return result as AppliedResult; };
const projectId = randomUUID();
const principal: Principal = { actorId: "integration-owner", projectIds: [projectId], permissions: ["read", "write", "review"] };
const token = "integration-token-not-a-real-secret-000000000000000";
const app = await buildServer({ service, credentials: [{ token, ...principal }] });
async function send(input: Omit<Command, "projectId" | "operationId"> | Record<string, unknown>, operationId = randomUUID()) {
  const response = await app.inject({ method: "POST", url: "/api/commands", headers: { authorization: `Bearer ${token}` }, payload: { ...input, projectId, operationId } });
  return { response, body: response.json() as CommandResult, operationId };
}

test("real PostgreSQL/API: adopted requirement → two independent basis reviews → historical readback", async t => {
  await migrate(url);
  t.after(async () => { await app.close(); await pool.end(); });
  applied((await send({ type: "project.create", title: "Explicit synthetic integration fixture" })).body);
  const ownerRoleId = fixtureRoleId(principal.actorId);
  await seedFixtureRole(pool, projectId, ownerRoleId);
  const documentId = randomUUID();
  const r1 = applied((await send({ type: "document.create", documentId, title: "报告阅读需求", body: "# r1\n必须保留完整原件。" })).body);
  applied((await send({ type: "document.adopt", documentId, expectedVersion: 1, revisionId: r1.revisionId, reason: "采纳第一版需求" })).body);
  const taskIds = [randomUUID(), randomUUID()];
  const accepted = [];
  for (const [index, taskId] of taskIds.entries()) {
    applied((await send({ type: "task.create", taskId, title: `任务 ${index + 1}`, content: "# 读取完整需求\n验证固定原文。", acceptance: "能找到全部原文", owner: ownerRoleId, documentIds: [documentId] })).body);
    accepted.push(applied((await send({ type: "task.start", taskId, expectedVersion: 1, basis: [{ documentId, revisionId: r1.revisionId }], reason: "授权范围内开始" })).body));
  }
  const r2 = applied((await send({ type: "document.revise", documentId, expectedVersion: 2, body: "# r2\n必须保留完整原件，并显示旧版依据。", reason: "增加历史依据阅读" })).body);
  assert.equal((await service.listImpacts(principal, projectId)).length, 0, "draft must not change accepted task bases");
  const adopted = applied((await send({ type: "document.adopt", documentId, expectedVersion: 3, revisionId: r2.revisionId, reason: "采纳历史阅读要求" })).body);
  assert.equal(adopted.impactIds?.length, 2);
  const impacts = await service.listImpacts(principal, projectId);
  const before = await service.getTask(principal, projectId, taskIds[0]!);
  const chosen = impacts.find(x => x.taskId === taskIds[0])!;
  const command = { type: "task.reviewBasis", taskId: taskIds[0], expectedVersion: 2, impactId: chosen.id, decision: "adopt", reason: "此任务需要实现新增历史阅读", acceptance: "当前与历史依据均可完整阅读" };
  const operationId = randomUUID();
  const results = await Promise.all([send(command, operationId), send(command, operationId)]);
  const reviewed = applied(results[0]!.body);
  assert.deepEqual(results[0]!.body, results[1]!.body, "same command replay must return original receipt");
  const misuse = await send({ ...command, reason: "different intent" }, operationId);
  assert.equal(misuse.response.statusCode, 409);
  assert.equal((misuse.response.json() as { code: string }).code, "OPERATION_REUSED");
  const second = impacts.find(x => x.taskId === taskIds[1])!;
  applied((await send({ type: "task.reviewBasis", taskId: taskIds[1], expectedVersion: 2, impactId: second.id, decision: "retain", reason: "此任务仅回归原件保存，原版判据仍适用" })).body);
  const afterA = await service.getTask(principal, projectId, taskIds[0]!);
  const afterB = await service.getTask(principal, projectId, taskIds[1]!);
  assert.equal(afterA.basis?.members.find(x => x.documentId === documentId)?.revisionId, r2.revisionId);
  assert.equal(afterB.basis?.members.find(x => x.documentId === documentId)?.revisionId, r1.revisionId);
  assert.equal(afterA.task.content, "# 读取完整需求\n验证固定原文。");
  assert.equal(afterA.revision.contentDocumentId, afterA.task.contentDocumentId);
  assert.equal(afterA.revision.contentRevisionId, afterA.task.contentRevisionId);
  assert.equal(afterA.basis?.members.find(x => x.documentId === afterA.task.contentDocumentId)?.revisionId, afterA.task.contentRevisionId);
  assert.equal(afterA.decisions.length, 1);
  assert.equal(afterB.decisions[0]?.decision, "retain");
  assert.equal(afterA.task.state, "in_progress", "source review does not close or restart work");
  const old = await service.getTaskRevision(principal, projectId, taskIds[0]!, before.revision.id);
  assert.deepEqual(old.basis, before.basis);
  assert.equal(old.revision.acceptance, "能找到全部原文");
  assert.equal((await service.getDocumentRevision(principal, projectId, documentId, r1.revisionId!)).body, "# r1\n必须保留完整原件。");
  const recovery = await app.inject({ url: `/api/projects/${projectId}/operations/${operationId}`, headers: { authorization: `Bearer ${token}` } });
  assert.equal(recovery.statusCode, 200);
  assert.deepEqual(recovery.json().result, reviewed);

  await t.test("different operations at the same document version allow exactly one update", async () => {
    const attempts = await Promise.all([
      send({ type: "document.revise", documentId, expectedVersion: 4, body: "# candidate A", reason: "并发 A" }),
      send({ type: "document.revise", documentId, expectedVersion: 4, body: "# candidate B", reason: "并发 B" }),
    ]);
    assert.deepEqual(attempts.map(x => x.body.status).sort(), ["applied", "rejected"]);
    const rejected = attempts.find(x => x.body.status === "rejected")!;
    assert.equal((await service.getOperation(principal, projectId, rejected.operationId))?.result.status, "rejected");
  });
  await t.test("authorization is rechecked on historic reads, commands and operation replay", async () => {
    const readOnly: Principal = { ...principal, permissions: ["read"] };
    await assert.rejects(() => service.execute(readOnly, { ...command, type: "task.reviewBasis", decision: "adopt", taskId: taskIds[0]!, projectId, operationId } as Command), /Permission/);
    await assert.rejects(() => service.getTask({ ...principal, projectIds: [] }, projectId, taskIds[0]!), /Permission/);
    await assert.rejects(() => service.getOperation({ ...principal, actorId: "another-actor" }, projectId, operationId), /actor|Actor|operation|Operation/);
    const foreign = await app.inject({ url: `/api/projects/${randomUUID()}/tasks`, headers: { authorization: `Bearer ${token}` } });
    assert.equal(foreign.statusCode, 403);
  });
  await t.test("failure at outbox insertion rolls back all domain writes and journal", async () => {
    const broken: UnitOfWork = {
      read: uow.read.bind(uow),
      transaction: (p, fn) => uow.transaction(p, tx => fn(new Proxy(tx, {
        get(target, key) {
          if (key === "appendOutbox") return async () => { throw new Error("injected final write failure"); };
          const value = Reflect.get(target, key);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }) as Transaction)),
    };
    const failedId = randomUUID(); const op = randomUUID();
    await assert.rejects(() => makeService(broken).execute(principal, { type: "document.create", projectId, operationId: op, documentId: failedId, title: "must roll back", body: "not committed" }), /injected/);
    assert.equal(await service.getOperation(principal, projectId, op), null);
    await assert.rejects(() => service.getDocument(principal, projectId, failedId), /not found/);
  });
  await t.test("coordinator lock prevents two owners and becomes unavailable when its connection is lost", async () => {
    const first = await acquireCoordinatorLease(pool);
    await assert.rejects(() => acquireCoordinatorLease(pool), /Another coordinator/);
    const locks = await pool.query<{ pid: number }>("SELECT pid FROM pg_locks WHERE locktype = 'advisory' AND objid = 731209842 AND database = (SELECT oid FROM pg_database WHERE datname = current_database())");
    assert.equal(locks.rows.length, 1);
    await pool.query("SELECT pg_terminate_backend($1)", [locks.rows[0]!.pid]);
    const deadline = Date.now() + 4000;
    while (first.canWrite() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(first.canWrite(), false);
    await first.release();
    const secondLease = await acquireCoordinatorLease(pool);
    assert.equal(secondLease.canWrite(), true);
    await secondLease.release();
  });
});
