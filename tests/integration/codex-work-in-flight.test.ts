// Refuses a live or shared PostgreSQL server before this file opens TEST_DATABASE_URL (scripts/lib/database-target.mjs).
import "../../scripts/test-database-guard.mjs";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";
import { PostgresUnitOfWork, migrate } from "@evoloop/adapter-postgres";
import { codexWorkInFlight } from "../../apps/coordinator/src/runtime/codex-work.js";

const database = process.env.TEST_DATABASE_URL;
if (!database || !/\/evoloop_[a-z0-9_]*test(?:\?|$)/.test(database)) throw new Error("Use dedicated evoloop_[a-z0-9_]*test database");

/**
 * Defect 548712ac: the Codex child is only replaced when nothing else runs on it. This asks the real tables.
 */
test("Codex work in flight counts message Turns, Runs and live native Turns of Codex Sessions only, and not the message being retried", async t => {
  const schema = `codex_work_${randomUUID().replaceAll("-", "")}`;
  await migrate(database, schema);
  const pool = new pg.Pool({ connectionString: database, options: `-c search_path=${schema}` });
  const uow = new PostgresUnitOfWork(pool);
  t.after(async () => { await pool.end(); const admin = new pg.Client({ connectionString: database }); await admin.connect(); try { await admin.query(`DROP SCHEMA "${schema}" CASCADE`); } finally { await admin.end(); } });
  const projectId = randomUUID(), now = new Date().toISOString();
  await uow.transaction(projectId, async tx => { await tx.insertProject({ id: projectId, title: "Codex work", createdAt: now }); });
  const session = async (provider: "codex" | "claude") => {
    const id = randomUUID();
    await uow.transaction(projectId, async tx => tx.insertRuntimeSession({ projectId, id, roleId: "role", cwd: "/tmp/codex-work", authorizationScope: "project", model: null,
      sandbox: "danger-full-access", approvalPolicy: "never", state: "ready", version: 1, nativeThreadId: `thread-${id}`, nativeSessionId: `native-${id}`, operationId: randomUUID(),
      actorId: "receiver", createdAt: now, updatedAt: now, runtimeProvider: provider } as never));
    return id;
  };
  const retried = randomUUID();
  assert.equal(await codexWorkInFlight(pool, retried), false, "an empty instance has nothing in flight");
  const codex = await session("codex"), claude = await session("claude");
  const observe = (sessionId: string, status: string, freshness: "live" | "stale") => pool.query(`INSERT INTO session_native_observation(project_id,session_id,thread_id,connection_id,version,observed_at,last_event_at,
      freshness,stale_reason,projection) VALUES($1,$2,$3,$4,1,now(),now(),$5,$6,$7::jsonb) ON CONFLICT(project_id,session_id) DO UPDATE SET freshness=EXCLUDED.freshness,stale_reason=EXCLUDED.stale_reason,projection=EXCLUDED.projection`,
    [projectId, sessionId, `thread-${sessionId}`, randomUUID(), freshness, freshness === "stale" ? "connection_unavailable" : null, JSON.stringify({ currentTurn: { id: "turn-1", status } })]);
  await observe(codex, "completed", "live");
  assert.equal(await codexWorkInFlight(pool, retried), false, "a finished Turn is not work in flight");
  await observe(codex, "inProgress", "stale");
  assert.equal(await codexWorkInFlight(pool, retried), false, "a stale observation of an old connection is not live work");
  await observe(codex, "inProgress", "live");
  assert.equal(await codexWorkInFlight(pool, retried), true, "a live Turn in progress is");
  await observe(codex, "completed", "live");
  // A message Turn that is running on a Codex Session counts; a Claude Session's does not; the message being retried never counts.
  const message = async (sessionId: string, state: string) => {
    const messageId = randomUUID();
    await pool.query(`INSERT INTO session_message(project_id,message_id,operation_id,target_kind,session_id,sender_actor_id,content,state,version,created_at,updated_at)
      VALUES($1,$2,$3,'owned',$4,'sender','hello','processing',1,now(),now())`, [projectId, messageId, randomUUID(), sessionId]);
    await pool.query(`INSERT INTO session_message_processing(project_id,processing_id,message_id,session_id,operation_id,receiver_actor_id,state,read_only_policy_fingerprint,version,started_at,updated_at)
      VALUES($1,$2,$3,$4,$5,'receiver',$6,$7,1,now(),now())`, [projectId, randomUUID(), messageId, sessionId, randomUUID(), state, "a".repeat(64)]);
    return messageId;
  };
  const claudeMessage = await message(claude, "running");
  assert.equal(await codexWorkInFlight(pool, retried), false, "work on another provider does not stop a Codex replacement");
  const own = await message(codex, "dispatching");
  assert.equal(await codexWorkInFlight(pool, own), false, "the message being retried is excluded");
  assert.equal(await codexWorkInFlight(pool, claudeMessage), true, "another message dispatching on Codex counts");
});
