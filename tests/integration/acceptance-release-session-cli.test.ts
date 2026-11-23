// Refuses a live or shared PostgreSQL server before this file opens TEST_DATABASE_URL (scripts/lib/database-target.mjs).
import "../../scripts/test-database-guard.mjs";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import pg from "pg";
import { migrate, PostgresUnitOfWork } from "@evoloop/adapter-postgres";
import { WorkflowService } from "@evoloop/core";
import type { Principal } from "@evoloop/contracts";
import { buildServer } from "../../apps/coordinator/src/server.js";
import { AcceptanceRelayService } from "../../apps/coordinator/src/acceptance-relay/service.js";
import { fixtureRoleId, seedFixtureRole } from "./role-fixture.test.js";

const database = process.env.TEST_DATABASE_URL;
if (!database || !/^\/evoloop(?:_[a-z0-9]+)*_test$/.test(new URL(database).pathname)) throw new Error("A dedicated evoloop_*_test database is required");

/**
 * The dcd01bb1 situation, run through the real CLI process against a real coordinator HTTP server (only the PostgreSQL is a throwaway database):
 * a Delivery whose only arrangement is a candidate stuck in blocked (MESSAGE_BINDING_CHANGED), plus an observation the recipient recorded earlier.
 * The steps are the ones docs/development/runtime-operations.md gives, in order, with the refusals on the way.
 */
test("real CLI, session mode: a stuck arrangement whose message was replied is released by the real process; one whose message still runs is refused; closure then goes through", async t => {
  const schema = `relay_cli_${randomUUID().replaceAll("-", "")}`;
  await migrate(database!, schema);
  const pool = new pg.Pool({ connectionString: database, options: `-c search_path=${schema}` });
  const directory = await mkdtemp(join(tmpdir(), "evoloop-release-cli-"));
  const projectId = randomUUID();
  const tokens = { reviewer: randomUUID() + randomUUID(), human: randomUUID() + randomUUID() };
  const reviewer: Principal = { actorId: "leader-reviewer", projectIds: [projectId], permissions: ["task", "document", "session", "management"], decisions: true };
  const workflow = new WorkflowService({ uow: new PostgresUnitOfWork(pool), clock: { now: () => new Date().toISOString() }, ids: { next: randomUUID },
    hasher: { hash: (value: string) => createHash("sha256").update(value).digest("hex") } });
  const relayService = new AcceptanceRelayService({ pool, workflow, messages: {} as never, principals: async () => [], canWrite: () => false, leaderSession: async () => null, qualify: async () => null, capabilities: async () => [] });
  const app = await buildServer({ service: workflow, acceptanceRelay: relayService, credentials: [
    { token: tokens.reviewer, actorId: reviewer.actorId, projectIds: [projectId], permissions: ["task", "document", "session", "management"], decisions: true },
    { token: tokens.human, actorId: "named-human", projectIds: [projectId], permissions: ["task", "document", "session"], identityKind: "human" }] } as never);
  const apiUrl = await app.listen({ host: "127.0.0.1", port: 0 });
  t.after(async () => { await app.close(); await pool.end(); const admin = new pg.Client({ connectionString: database }); await admin.connect(); try { await admin.query(`DROP SCHEMA "${schema}" CASCADE`); } finally { await admin.end(); } await rm(directory, { recursive: true, force: true }); });

  /** One real CLI process per call: `node apps/cli/dist/main.js`, credentials from the environment, exit code and JSON read back. */
  const cli = async (who: keyof typeof tokens, args: string[], expected = 0): Promise<Record<string, any>> => {
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((done, reject) => {
      const child = spawn(process.execPath, [resolve("apps/cli/dist/main.js"), ...args], { stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, EVOLOOP_API_URL: apiUrl, EVOLOOP_TOKEN: tokens[who], EVOLOOP_PROJECT: projectId, EVOLOOP_STATE_DIR: join(directory, `state-${who}`) } });
      let stdout = "", stderr = "";
      child.stdout.on("data", chunk => { stdout += String(chunk); }); child.stderr.on("data", chunk => { stderr += String(chunk); });
      child.once("error", reject); child.once("close", code => done({ code, stdout, stderr }));
    });
    // EVOLOOP_RELEASE_CLI_TRANSCRIPT=1 prints every command as it was run (credentials come from the environment, so none is shown) with its exit code and output.
    if (process.env.EVOLOOP_RELEASE_CLI_TRANSCRIPT === "1")
      console.log(`$ evoloop ${args.map(arg => arg.startsWith(directory) ? "BODY.json" : arg).join(" ")}   # as ${who}\n  exit ${result.code}\n  ${(result.stdout.trim() || result.stderr.trim()).split("\n").at(-1)!.slice(0, 600)}`);
    assert.equal(result.code, expected, `CLI ${args.join(" ")} exited ${result.code}: ${result.stderr}${result.stdout}`);
    const text = result.stdout.trim() || result.stderr.trim().split("\n").at(-1) || "{}";
    return JSON.parse(text.split("\n").at(-1)!);
  };
  const body = async (value: Record<string, unknown>) => { const file = join(directory, `${randomUUID()}.json`); await writeFile(file, JSON.stringify(value), { mode: 0o600 }); return file; };
  const command = async (who: keyof typeof tokens, value: Record<string, unknown>, expected = 0) =>
    cli(who, ["command", "run", await body({ projectId, operationId: randomUUID(), ...value })], expected);
  const request = async (who: keyof typeof tokens, name: string, id: string, value: Record<string, unknown>, expected = 0) =>
    cli(who, ["request", name, "--project", projectId, "--id", id, "--file", await body({ projectId, ...value })], expected);
  const relays = async (taskId: string) => ((await cli("reviewer", ["get", `/api/projects/${projectId}/tasks/${taskId}/acceptance-relay`])).items as Array<Record<string, any>>);

  await workflow.execute(reviewer, { type: "project.create", projectId, title: "Release CLI session", operationId: randomUUID() } as never);
  const owner = fixtureRoleId("release-cli-session-owner"); await seedFixtureRole(pool, projectId, owner);
  const sessionId = randomUUID();
  await pool.query(`INSERT INTO runtime_session(project_id,session_id,role_id,cwd,authorization_scope,sandbox,approval_policy,state,version,native_thread_id,native_session_id,operation_id,actor_id,created_at,updated_at)
    VALUES($1,$2,$3,'/tmp/release-cli','project','danger-full-access','never','ready',1,$4,$4,$5,'acceptance-agent',now(),now())`, [projectId, sessionId, owner, randomUUID(), randomUUID()]);
  const taskId = randomUUID(), deliveryId = randomUUID();
  await command("reviewer", { type: "task.create", taskId, title: "Stuck session arrangement", content: "# Stuck\n关闭后下一步：无", acceptance: "Used", owner, consumer: "named-human", useRequired: true, acceptanceMode: "human_required", acceptanceTarget: "human" });
  await command("reviewer", { type: "task.start", taskId, expectedVersion: Number((await workflow.getTask(reviewer, projectId, taskId)).task.version), reason: "start" });
  const task = (await workflow.getTask(reviewer, projectId, taskId)).task;
  await pool.query(`INSERT INTO delivery(project_id,delivery_id,task_id,task_revision_id,artifact_ref,artifact_revision,content_hash,technical_result,technical_evidence,reason,actor_id,created_at)
    VALUES($1,$2,$3,$4,'fixture:report','r1',$5,'passed','fixture','delivery','author',now())`, [projectId, deliveryId, taskId, task.currentRevisionId, "a".repeat(64)]);
  // The declared consumer (a person) has used the Delivery, so the Task-level use gate passes and what is left is the arrangement guard (migration 070).
  await pool.query(`INSERT INTO consumer_observation(project_id,observation_id,task_id,delivery_id,observer,observer_kind,result,evidence,reason,actor_id,created_at)
    VALUES($1,$2,$3,$4,'named-human','human','used','checked','recorded','named-human',now())`, [projectId, randomUUID(), taskId, deliveryId]);
  /** A session-mode arrangement and its acceptance message, as the Leader made them; `used` also records and links a use by the recipient. */
  const arrange = async (scope: string, state: string, messageState: string, used: boolean) => {
    const relayId = randomUUID(), messageId = randomUUID(), messageOperation = randomUUID();
    await pool.query(`INSERT INTO session_message(project_id,message_id,operation_id,target_kind,session_id,sender_actor_id,content,context_task_id,context_task_revision_id,state,version,created_at,updated_at)
      VALUES($1,$2,$3,'owned',$4,'leader-reviewer','Please check the delivery',$5,$6,$7,1,now(),now())`, [projectId, messageId, messageOperation, sessionId, taskId, task.currentRevisionId, messageState]);
    await pool.query(`INSERT INTO task_acceptance_relay(project_id,relay_id,operation_id,request_hash,task_id,task_revision_id,delivery_id,stage,scope_key,scope_description,publication_ref,reason,
      mode,recipient_actor_id,session_id,native_thread_id,role_id,sender_actor_id,message_id,message_operation_id,state,blocked_reason,arranged_by,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,'candidate',$8,'scope',NULL,'fixture','session','acceptance-agent',$9,'thread-x','role-x','leader-reviewer',$10,$11,$12,$13,'leader-reviewer',now(),now())`,
      [projectId, relayId, randomUUID(), "b".repeat(64), taskId, task.currentRevisionId, deliveryId, scope, sessionId, messageId, messageOperation, state, state === "blocked" ? "MESSAGE_BINDING_CHANGED" : null]);
    if (used) {
      const observationId = randomUUID();
      await pool.query(`INSERT INTO consumer_observation(project_id,observation_id,task_id,delivery_id,observer,observer_kind,result,evidence,reason,actor_id,created_at)
        VALUES($1,$2,$3,$4,'acceptance-agent','agent','used','checked','recorded','acceptance-agent',now())`, [projectId, observationId, taskId, deliveryId]);
      await pool.query(`INSERT INTO task_acceptance_observation_link(project_id,relay_id,observation_id,operation_id,actor_id,evidence_level,linked_at) VALUES($1,$2,$3,$4,'acceptance-agent','actor_message_turn',now())`,
        [projectId, relayId, observationId, randomUUID()]);
    }
    return { relayId, messageId };
  };
  const version = async (relayId: string) => Number((await pool.query("SELECT version FROM task_acceptance_relay WHERE project_id=$1 AND relay_id=$2", [projectId, relayId])).rows[0].version);
  const close = async (expected: number) => command("reviewer", { type: "task.close", taskId, expectedVersion: Number((await workflow.getTask(reviewer, projectId, taskId)).task.version), deliveryId, acceptanceResult: "met", acceptanceEvidence: "used", reason: "close" }, expected);
  const release = async (relayId: string, expected: number) => request("reviewer", "acceptance.release", relayId, { taskId, relayId, operationId: randomUUID(), expectedVersion: await version(relayId), reason: "message binding changed; replaced by the new candidate" }, expected);

  // 1. Before: the stuck arrangement (message already replied) is the only one: it cannot be released, and closure is refused.
  const stuck = await arrange("candidate-a", "blocked", "replied", false);
  assert.equal((await release(stuck.relayId, 1)).error?.code, "LAST_ARRANGEMENT");
  assert.match(JSON.stringify(await close(1)), /lacks linked consumer use|23514/, "the stuck arrangement has no linked use: closure is refused");
  // 2. The replacement with a recorded use (linked). A stuck arrangement whose message still runs is refused; once replied it is released by the real process.
  await arrange("candidate-b", "pending", "replied", true);
  const moving = await arrange("candidate-c", "blocked", "processing", false);
  assert.equal((await release(moving.relayId, 1)).error?.code, "ACCEPTANCE_IN_FLIGHT", "a message still running is not released under");
  assert.match(JSON.stringify(await close(1)), /lacks linked consumer use|23514/, "still blocked by the stuck ones");
  const released = await release(stuck.relayId, 0);
  assert.match(JSON.stringify(released), /"released"/, JSON.stringify(released));
  assert.equal((await pool.query("SELECT state FROM session_message WHERE project_id=$1 AND message_id=$2", [projectId, stuck.messageId])).rows[0].state, "replied", "the settled message is untouched");
  // The moving one settles (the message was replied after all), then it is released too, and closure goes through.
  await pool.query("UPDATE session_message SET state='replied',version=version+1 WHERE project_id=$1 AND message_id=$2", [projectId, moving.messageId]);
  assert.match(JSON.stringify(await release(moving.relayId, 0)), /"released"/);
  const rows = (await cli("reviewer", ["get", `/api/projects/${projectId}/tasks/${taskId}/acceptance-relay`])).items as Array<Record<string, any>>;
  assert.deepEqual(rows.map(r => [r.scopeKey, r.state]).sort(), [["candidate-a", "released"], ["candidate-b", "pending"], ["candidate-c", "released"]]);
  const closed = await close(0);
  assert.equal(closed.status, "applied", JSON.stringify(closed));
  assert.equal((await cli("reviewer", ["task", taskId])).task.state, "done");
});
