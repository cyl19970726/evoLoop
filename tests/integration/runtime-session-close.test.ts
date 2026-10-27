import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import pg from "pg";
import { WorkflowService } from "@evoloop/core";
import { migrate, PostgresUnitOfWork } from "@evoloop/adapter-postgres";
import { buildServer } from "../../apps/coordinator/src/server.js";
import type { RuntimeRunner } from "../../apps/coordinator/src/runtime/runner.js";

const runFile = promisify(execFile);
const database = process.env.TEST_DATABASE_URL;
if (!database || !/^\/evoloop(?:_[a-z0-9]+)*_test$/.test(new URL(database).pathname))
  throw new Error("dedicated evoloop test database required");

test("CLI close command reaches HTTP admission and stores one durable owned close intent in PostgreSQL", async t => {
  const schema = `el_sessionclose_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  const directory = await mkdtemp(join(tmpdir(), "evoloop-session-close-"));
  await migrate(database!, schema);
  const pool = new pg.Pool({ connectionString: database, options: `-c search_path=${schema}` });
  const uow = new PostgresUnitOfWork(pool);
  const workflow = new WorkflowService({ uow, clock: { now: () => new Date().toISOString() },
    ids: { next: randomUUID }, hasher: { hash: (value: string) => createHash("sha256").update(value).digest("hex") } });
  const projectId = randomUUID(), sessionId = randomUUID(), operationId = randomUUID();
  const actorId = "close-reviewer", cwd = "/tmp/evoloop-session-close";
  const token = randomUUID() + randomUUID();
  const principal = { actorId, projectIds: [projectId], permissions: ["read", "write", "review"] as Array<"read" | "write" | "review"> };
  const created = await workflow.execute(principal, { type: "project.create", projectId,
    operationId: randomUUID(), title: "Session close fixture" });
  assert.equal(created.status, "applied");
  const now = new Date().toISOString();
  await uow.transaction(projectId, tx => tx.insertRuntimeSession({ projectId, id: sessionId,
    roleId: "operator", cwd, authorizationScope: "project", model: null, sandbox: "danger-full-access",
    approvalPolicy: "never", state: "ready", version: 2, nativeThreadId: "owned-thread",
    nativeSessionId: "owned-session", operationId: randomUUID(), actorId, createdAt: now, updatedAt: now }));
  const runtime = { status: () => ({ available: true, error: null }) } as RuntimeRunner;
  const app = await buildServer({ service: workflow, credentials: [{ token, actorId,
    projectIds: [projectId], permissions: ["read", "write", "review"] }], runtime,
    hasRuntimeGrant: scope => scope.projectId === projectId && scope.actorId === actorId &&
      scope.roleId === "operator" && scope.authorizationScope === "project" && scope.cwd === cwd && scope.sandbox === "danger-full-access" });
  const origin = await app.listen({ host: "127.0.0.1", port: 0 });
  t.after(async () => {
    await app.close(); await pool.end(); await rm(directory, { recursive: true, force: true });
    const admin = new pg.Client({ connectionString: database }); await admin.connect();
    try { await admin.query(`DROP SCHEMA "${schema}" CASCADE`); } finally { await admin.end(); }
  });
  const file = join(directory, "close.json");
  await writeFile(file, JSON.stringify({ type: "runtime.session.close", projectId, operationId,
    sessionId, expectedVersion: 2, reason: "Fixture work complete" }));
  const cli = async () => runFile(process.execPath, [resolve("apps/cli/dist/main.js"), "command", "run", file],
    { env: { ...process.env, EVOLOOP_API_URL: origin, EVOLOOP_TOKEN: token, EVOLOOP_STATE_DIR: join(directory, "receipts") } });
  const first = await cli();
  assert.match(first.stdout, /"applied"/);
  const saved = await workflow.getRuntimeSession(principal, projectId, sessionId);
  assert.equal(saved.state, "closing");
  assert.equal(saved.closeOperationId, operationId);
  assert.equal(saved.closeAttemptedAt, null, "command never calls native archive");
  const repeated = await cli();
  assert.match(repeated.stdout, /"applied"/);
  assert.equal((await workflow.getRuntimeSession(principal, projectId, sessionId)).version, 3);
  assert.equal((await workflow.listRuntimeSessionEvents(principal, projectId, sessionId)).filter(e => e.kind === "session.closeRequested").length, 1);
});
