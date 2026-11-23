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
test("real CLI: a Delivery whose only arrangement is stuck is closed by a new arrangement, a fresh use and acceptance.release", async t => {
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

  await workflow.execute(reviewer, { type: "project.create", projectId, title: "Release CLI", operationId: randomUUID() } as never);
  const owner = fixtureRoleId("release-cli-owner"); await seedFixtureRole(pool, projectId, owner);
  const taskId = randomUUID(), deliveryId = randomUUID();
  await command("reviewer", { type: "task.create", taskId, title: "Stuck arrangement", content: "# Stuck\n关闭后下一步：无", acceptance: "Used", owner, consumer: "named-human", useRequired: true, acceptanceMode: "human_required", acceptanceTarget: "human" });
  // The Task is being worked on, as dcd01bb1 was (in_progress), so observations are accepted.
  await command("reviewer", { type: "task.start", taskId, expectedVersion: Number((await workflow.getTask(reviewer, projectId, taskId)).task.version), reason: "start" });
  const task = (await workflow.getTask(reviewer, projectId, taskId)).task;
  await pool.query(`INSERT INTO delivery(project_id,delivery_id,task_id,task_revision_id,artifact_ref,artifact_revision,content_hash,technical_result,technical_evidence,reason,actor_id,created_at)
    VALUES($1,$2,$3,$4,'fixture:report','r1',$5,'passed','fixture','delivery','author',now())`, [projectId, deliveryId, taskId, task.currentRevisionId, "a".repeat(64)]);
  // The stuck candidate, as the formal instance has it: blocked, no linked observation.
  const stuckId = randomUUID();
  await pool.query(`INSERT INTO task_acceptance_relay(project_id,relay_id,operation_id,request_hash,task_id,task_revision_id,delivery_id,stage,scope_key,scope_description,publication_ref,reason,
    mode,recipient_actor_id,state,blocked_reason,arranged_by,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,'candidate','candidate-a','scope',NULL,'fixture','human','named-human','blocked','MESSAGE_BINDING_CHANGED','leader-reviewer',now(),now())`,
    [projectId, stuckId, randomUUID(), "b".repeat(64), taskId, task.currentRevisionId, deliveryId]);
  // The recipient's earlier used observation, recorded before any new arrangement exists.
  const early = (await command("human", { type: "observation.record", taskId, deliveryId, observer: "named-human", observerKind: "human", result: "used", evidence: "checked before the new arrangement", reason: "used" })) as Record<string, any>;
  assert.equal(early.status, "applied");
  const observationIds = async () => ((await cli("reviewer", ["task", taskId])).observations as Array<{ id: string }>).map(o => o.id);
  const [earlyId] = await observationIds();
  assert.ok(earlyId);

  const close = async (expected: number) => command("reviewer", { type: "task.close", taskId, expectedVersion: Number((await workflow.getTask(reviewer, projectId, taskId)).task.version), deliveryId, acceptanceResult: "met", acceptanceEvidence: "used", reason: "close per decision" }, expected);

  // 1. Before: closure is refused, and the only arrangement cannot be released (the last one).
  const stuck = (await relays(taskId)).find(r => r.relayId === stuckId)!;
  assert.deepEqual([stuck.state, stuck.blockedReason], ["blocked", "MESSAGE_BINDING_CHANGED"]);
  const refusedClose = await close(1);
  assert.match(JSON.stringify(refusedClose), /lacks linked consumer use|23514/, "the stuck arrangement blocks closure");
  const last = await request("reviewer", "acceptance.release", stuckId, { taskId, relayId: stuckId, operationId: randomUUID(), expectedVersion: stuck.version, reason: "stuck" }, 1);
  assert.equal(last.error?.code, "LAST_ARRANGEMENT", `releasing the only arrangement is refused: ${JSON.stringify(last)}`);

  // 2. A new candidate on the same Delivery (different scope), arranged and read by the recipient through the CLI.
  const newId = randomUUID();
  const taskNow = (await workflow.getTask(reviewer, projectId, taskId)).task;
  await request("reviewer", "acceptance.assign", taskId, { taskId, relayId: newId, operationId: randomUUID(), expectedTaskVersion: Number((taskNow as any).version), deliveryId, stage: "candidate",
    scopeKey: "candidate-b", scopeDescription: "replaces the stuck candidate", entrypoint: null, publicationRef: null, mode: "human", recipientActorId: "named-human", sessionId: null,
    senderActorId: null, messageId: null, messageOperationId: null, reason: "replaces candidate-a, stuck in blocked", supersedesRelayId: null });
  let fresh = (await relays(taskId)).find(r => r.relayId === newId)!;
  assert.equal(fresh.state, "pending");
  await request("human", "acceptance.read", newId, { taskId, relayId: newId, operationId: randomUUID(), expectedVersion: fresh.version, evidence: "read the delivery" });
  fresh = (await relays(taskId)).find(r => r.relayId === newId)!;

  // 3. The runbook's first idea does not work: an observation recorded before the new arrangement cannot be linked to it.
  const tooEarly = await request("human", "acceptance.observe", newId, { taskId, relayId: newId, operationId: randomUUID(), expectedVersion: fresh.version, observationId: earlyId }, 1);
  assert.equal(tooEarly.error?.code, "OBSERVATION_MISMATCH", `an earlier observation is refused: ${JSON.stringify(tooEarly)}`);

  // 4. A use recorded after the new arrangement links, and the stuck one can then be released.
  const later = (await command("human", { type: "observation.record", taskId, deliveryId, observer: "named-human", observerKind: "human", result: "used", evidence: "checked again for the new arrangement", reason: "used" })) as Record<string, any>;
  await request("human", "acceptance.observe", newId, { taskId, relayId: newId, operationId: randomUUID(), expectedVersion: fresh.version, observationId: (await observationIds()).find(id => id !== earlyId) });
  fresh = (await relays(taskId)).find(r => r.relayId === newId)!;
  assert.equal(fresh.observationResult, "used"); assert.ok(fresh.observationId, "the use is linked to the new arrangement");
  assert.match(JSON.stringify(await close(1)), /lacks linked consumer use|23514/, "the stuck arrangement still blocks closure until it is released");
  const before = (await relays(taskId)).find(r => r.relayId === stuckId)!;
  const released = await request("reviewer", "acceptance.release", stuckId, { taskId, relayId: stuckId, operationId: randomUUID(), expectedVersion: before.version, reason: "message binding changed; replaced by candidate-b" });
  assert.match(JSON.stringify(released), /"released"/, JSON.stringify(released));
  const after = (await relays(taskId)).find(r => r.relayId === stuckId)!;
  assert.equal(after.state, "released"); assert.match(after.blockedReason, /replaced by candidate-b/);
  const record = (await pool.query("SELECT actor_id, from_state, reason FROM task_acceptance_relay_release WHERE project_id=$1 AND relay_id=$2", [projectId, stuckId])).rows[0];
  assert.deepEqual([record.actor_id, record.from_state], ["leader-reviewer", "blocked"]);

  // 5. After: closure goes through, and the closure is read back.
  const closed = await close(0);
  assert.equal(closed.status, "applied", JSON.stringify(closed));
  const done = await cli("reviewer", ["task", taskId]);
  assert.equal(done.task.state, "done");
  assert.equal(done.closures.length, 1);
});
