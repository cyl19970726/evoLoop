// Refuses a live or shared PostgreSQL server before this file opens TEST_DATABASE_URL (scripts/lib/database-target.mjs).
import "../../scripts/test-database-guard.mjs";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import pg from "pg";
import { migrate, PostgresUnitOfWork } from "@evoloop/adapter-postgres";
import { RuntimeWorkflowService, WorkflowService } from "@evoloop/core";
import { OpsAlertPump, type AlertSettings } from "../../apps/coordinator/src/ops-alerts/pump.js";
import type { AlertOutletConfig } from "../../apps/coordinator/src/ops-alerts/outlet.js";
import { fixtureRoleId, seedFixtureRole } from "./role-fixture.test.js";

const database = process.env.TEST_DATABASE_URL;
if (!database || !/^\/evoloop(?:_[a-z0-9]+)*_test$/.test(new URL(database).pathname)) throw new Error("A dedicated evoloop_*_test database is required");

/**
 * Task 5da8b6d9: when a provider pause opens or lifts, or the organisation stalls with work waiting, the system sends one message to a configured outlet
 * outside the workbench. The pauses here are the real ones (a Run failing on the account opens the hold; the real release command lifts it); the outlet is
 * a real HTTP receiver or a real local command; the database is real. Only the clock the pump is given is ours, to move past the stall time and the retry wait.
 */
async function harness(t: { after: (fn: () => Promise<void>) => void }) {
  const schema = `ops_alert_${randomUUID().replaceAll("-", "")}`;
  await migrate(database!, schema);
  const pool = new pg.Pool({ connectionString: database, options: `-c search_path=${schema}` });
  const directory = await mkdtemp(join(tmpdir(), "ops-alert-"));
  const received: Array<Record<string, any>> = [];
  const servers: Server[] = [];
  const receiver = async (status = 200): Promise<string> => {
    const server = createServer((request, response) => { const chunks: Buffer[] = []; request.on("data", c => chunks.push(c)); request.on("end", () => {
      if (status < 300) received.push({ ...JSON.parse(Buffer.concat(chunks).toString("utf8")), _auth: request.headers.authorization ?? null });
      response.statusCode = status; response.end("ignored body"); }); });
    await new Promise<void>(done => server.listen(0, "127.0.0.1", () => done())); servers.push(server);
    return `http://127.0.0.1:${(server.address() as { port: number }).port}/hook`;
  };
  t.after(async () => { for (const server of servers) server.close(); await pool.end(); const admin = new pg.Client({ connectionString: database }); await admin.connect();
    try { await admin.query(`DROP SCHEMA "${schema}" CASCADE`); } finally { await admin.end(); } await rm(directory, { recursive: true, force: true }); });
  const deps = { uow: new PostgresUnitOfWork(pool), clock: { now: () => new Date().toISOString() }, ids: { next: randomUUID }, hasher: { hash: (v: string) => createHash("sha256").update(v).digest("hex") } };
  const workflow = new WorkflowService(deps), runtime = new RuntimeWorkflowService(deps);
  const projectId = randomUUID(), role = fixtureRoleId("ops-alert-owner");
  await pool.query("INSERT INTO project(project_id,title,created_at) VALUES($1,'Ops alert',now())", [projectId]);
  await seedFixtureRole(pool, projectId, role);
  const reviewer = { actorId: "lead", projectIds: [projectId], permissions: ["read" as const, "write" as const, "review" as const] };
  const state = { outlet: { kind: "webhook", url: "http://127.0.0.1:1/unused", headers: {}, timeoutMs: 1500 } as AlertOutletConfig, stallMinutes: 30, offsetMs: 0, canWrite: true, gaveUp: [] as string[], errors: 0 };
  const pump = () => new OpsAlertPump({ pool, projects: async () => [projectId], canWrite: () => state.canWrite, now: () => new Date(Date.now() + state.offsetMs),
    settings: async (): Promise<AlertSettings> => ({ enabled: true, pollIntervalMs: 15000, stallMinutes: state.stallMinutes, outlet: state.outlet }),
    onGiveUp: line => state.gaveUp.push(line), onError: () => { state.errors++; } });
  /** A Session (provider codex) with a Task and a Run in the given state; returns what is needed to fail it. */
  async function run(runState: "requested" | "running" | "completed", createdAt = new Date().toISOString()) {
    const sessionId = randomUUID(), runId = randomUUID(), taskId = randomUUID(), revisionId = randomUUID(), basisId = randomUUID(), documentId = randomUUID(), docRev = randomUUID();
    const c = await pool.connect();
    try {
    await c.query("BEGIN");
    await c.query(`INSERT INTO runtime_session(project_id,session_id,role_id,cwd,authorization_scope,sandbox,approval_policy,state,version,native_thread_id,native_session_id,operation_id,actor_id,created_at,updated_at)
      VALUES($1,$2,$3,'/tmp/ops-alert','project','danger-full-access','never','ready',1,$4,$4,$5,'worker',$6,$6)`, [projectId, sessionId, role, randomUUID(), randomUUID(), createdAt]);
    await c.query("INSERT INTO process_document(project_id,document_id,title,version,current_revision_id,kind,status) VALUES($1,$2,'Fixed Task',1,$3,'task','draft')", [projectId, documentId, docRev]);
    await c.query("INSERT INTO document_revision(project_id,document_id,revision_id,body,format,content_hash,author,created_at,reason) VALUES($1,$2,$3,'Fixed task','markdown',$4,'lead',$5,'fixture')", [projectId, documentId, docRev, "a".repeat(64), createdAt]);
    await c.query(`INSERT INTO task(project_id,task_id,version,current_revision_id,title,acceptance,owner,state,content_document_id,content_revision_id) VALUES($1,$2,1,$3,'Fixed Task','Result',$4,'in_progress',$5,$6)`, [projectId, taskId, revisionId, role, documentId, docRev]);
    await c.query(`INSERT INTO task_revision(project_id,task_id,revision_id,version,title,acceptance,owner,state,basis_set_id,actor_id,reason,created_at,content_document_id,content_revision_id) VALUES($1,$2,$3,1,'Fixed Task','Result',$7,'in_progress',$4,'lead','fixture',$8,$5,$6)`, [projectId, taskId, revisionId, basisId, documentId, docRev, role, createdAt]);
    await c.query("INSERT INTO basis_set(project_id,task_id,task_revision_id,basis_set_id,sealed) VALUES($1,$2,$3,$4,false)", [projectId, taskId, revisionId, basisId]);
    await c.query("INSERT INTO basis_member(project_id,task_id,task_revision_id,basis_set_id,document_id,document_revision_id) VALUES($1,$2,$3,$4,$5,$6)", [projectId, taskId, revisionId, basisId, documentId, docRev]);
    await c.query("UPDATE basis_set SET sealed=true WHERE basis_set_id=$1", [basisId]);
    const operationId = randomUUID();
    await c.query(`INSERT INTO runtime_run(project_id,run_id,task_id,task_revision_id,basis_set_id,session_id,operation_id,input,input_hash,state,version,native_turn_id,actor_id,created_at,updated_at,result_summary)
      VALUES($1,$2,$3,$4,$5,$6,$7,'Fixed input',$8,$9,1,$10,'worker',$11,$11,$12)`, [projectId, runId, taskId, revisionId, basisId, sessionId, operationId, "b".repeat(64), runState,
      runState === "requested" ? null : `turn-${runId}`, createdAt, runState === "completed" ? "done" : null]);
    await c.query("INSERT INTO operation_journal(project_id,operation_id,actor_id,command_hash,command_type,result,created_at) VALUES($1,$2,'worker',$3,'runtime.run.reserve','{}',$4)", [projectId, operationId, "c".repeat(64), createdAt]);
    await c.query("COMMIT");
    } catch (error) { await c.query("ROLLBACK"); throw error; } finally { c.release(); }
    return { sessionId, runId, taskId };
  }
  /** A Task that is ready and in nobody's line: work waiting. */
  const readyTask = async (title = "Ready work") => { const taskId = randomUUID();
    const result = await workflow.execute(reviewer, { type: "task.create", projectId, operationId: randomUUID(), taskId, title, content: "# Work", acceptance: "Used", owner: role, consumer: "named-human",
      useRequired: true, acceptanceMode: "human_required", acceptanceTarget: "human" } as never);
    assert.equal(result.status, "applied", JSON.stringify(result)); return taskId; };
  const holds = async () => (await pool.query("SELECT hold_id,version,state FROM runtime_provider_hold WHERE project_id=$1 ORDER BY opened_at", [projectId])).rows;
  const alerts = async () => (await pool.query("SELECT alert_key,kind,state,open_attempts,open_delivered_at,resolved_attempts,resolved_delivered_at,last_error FROM ops_alert WHERE project_id=$1 ORDER BY opened_at", [projectId])).rows;
  return { pool, projectId, role, workflow, runtime, reviewer, state, pump, run, readyTask, holds, alerts, receiver, received, directory };
}

test("a provider pause and its release each send one message with the reason, the start, the affected Sessions and the work waiting; restarts and repeats send nothing more", async t => {
  const h = await harness(t);
  h.state.outlet = { kind: "webhook", url: await h.receiver(), headers: { authorization: "Bearer outlet-secret" }, timeoutMs: 2000 };
  const failing = await h.run("running"); await h.run("requested");
  await h.readyTask("Waiting for a Session");
  const pump = h.pump();
  await pump.tick();
  assert.equal(h.received.length, 0, "nothing is sent while nothing is wrong");
  // The real opening: a Run fails on the provider's account.
  await h.runtime.recordTurn(h.projectId, failing.runId, `turn-${failing.runId}`, "failed", "Native failure; category=quota_exhausted", { completedAtUtc: new Date().toISOString(), failureCategory: "quota_exhausted" });
  const [hold] = await h.holds(); assert.equal(hold?.state, "held");
  await pump.tick();
  assert.equal(h.received.length, 1);
  const opened = h.received[0]!;
  assert.deepEqual([opened.schema, opened.kind, opened.event, opened.key], ["evoloop.alert.v1", "provider_hold", "opened", `hold:${hold!.hold_id}`]);
  assert.equal(opened._auth, "Bearer outlet-secret", "the configured header reaches the receiver");
  assert.match(opened.text, /Codex 提供方已暂停（额度用完）/); assert.match(opened.text, /从 \d{4}-\d\d-\d\dT[\d:.]+Z 起/);
  assert.match(opened.text, /2 个 Session 受影响/); assert.match(opened.text, /压着 \d+ 件活（就绪未派 1，在队伍里排队 0，等验收 0）/);
  assert.equal(opened.facts.provider, "codex"); assert.equal(opened.facts.pending.ready, 1);
  assert.equal(JSON.stringify({ ...opened, _auth: undefined }).includes("outlet-secret"), false, "the credential is not in the message");
  // Repeats and a restart (a new pump on the same database) send nothing more for the same pause.
  await pump.tick(); await pump.tick(); await h.pump().tick();
  assert.equal(h.received.length, 1, "the same pause is not sent again");
  // The real release.
  const release = await h.workflow.execute(h.reviewer, { type: "runtime.providerHold.release", projectId: h.projectId, operationId: randomUUID(), provider: "codex", holdId: hold!.hold_id,
    expectedVersion: hold!.version, evidenceRef: "ops://balance-restored", reason: "Balance restored" } as never);
  assert.equal(release.status, "applied");
  await pump.tick();
  assert.equal(h.received.length, 2);
  assert.deepEqual([h.received[1]!.kind, h.received[1]!.event, h.received[1]!.key], ["provider_hold", "resolved", `hold:${hold!.hold_id}`]);
  assert.match(h.received[1]!.text, /已放行，共暂停 \d+ 分钟/); assert.match(h.received[1]!.text, /放行人 lead/); assert.match(h.received[1]!.text, /Balance restored/);
  await pump.tick(); await h.pump().tick();
  assert.equal(h.received.length, 2, "the release is sent once");
  assert.deepEqual((await h.alerts()).map(a => [a.state, a.open_attempts, a.resolved_attempts]), [["resolved", 1, 1]]);
});

test("an unreachable outlet changes nothing about the pause or its release; the message waits with a growing delay and goes out in order when the outlet is back", async t => {
  const h = await harness(t);
  h.state.outlet = { kind: "webhook", url: "http://127.0.0.1:1/closed", headers: {}, timeoutMs: 1000 };
  const failing = await h.run("running");
  const pump = h.pump();
  await h.runtime.recordTurn(h.projectId, failing.runId, `turn-${failing.runId}`, "failed", "Native failure; category=quota_exhausted", { completedAtUtc: new Date().toISOString(), failureCategory: "quota_exhausted" });
  await pump.tick();
  let [alert] = await h.alerts();
  assert.deepEqual([alert!.state, alert!.open_attempts, alert!.open_delivered_at], ["open", 1, null]);
  assert.match(alert!.last_error, /request failed|timed out/);
  assert.doesNotMatch(String(alert!.last_error), /127\.0\.0\.1/, "the address is not copied into the record");
  await pump.tick(); [alert] = await h.alerts();
  assert.equal(alert!.open_attempts, 1, "no second attempt within the wait");
  // The pause is untouched and can be released while the outlet is down.
  const [hold] = await h.holds(); assert.equal(hold?.state, "held");
  assert.equal((await h.workflow.execute(h.reviewer, { type: "runtime.providerHold.release", projectId: h.projectId, operationId: randomUUID(), provider: "codex", holdId: hold!.hold_id,
    expectedVersion: hold!.version, evidenceRef: "ops://restored", reason: "Restored while the outlet was down" } as never)).status, "applied");
  assert.equal((await h.holds())[0]!.state, "released");
  // The outlet comes back: the opening goes first, then the release.
  h.state.outlet = { kind: "webhook", url: await h.receiver(), headers: {}, timeoutMs: 2000 };
  h.state.offsetMs = 3600_000; // an hour on: well past the retry wait
  await pump.tick();
  assert.deepEqual(h.received.map(m => m.event), ["opened", "resolved"], "in order, both delivered");
  assert.equal(h.state.errors, 0);
  [alert] = await h.alerts(); assert.ok(alert!.open_delivered_at && alert!.resolved_delivered_at);
});

test("a server error or a command that fails is a recorded failure, not an exception; a command receives the alert as JSON on its standard input", async t => {
  const h = await harness(t);
  const failing = await h.run("running");
  h.state.outlet = { kind: "webhook", url: await h.receiver(500), headers: {}, timeoutMs: 2000 };
  const pump = h.pump();
  await h.runtime.recordTurn(h.projectId, failing.runId, `turn-${failing.runId}`, "failed", "Native failure; category=authentication_failed", { completedAtUtc: new Date().toISOString(), failureCategory: "authentication_failed" });
  await pump.tick();
  assert.equal((await h.alerts())[0]!.last_error, "HTTP 500");
  const out = join(h.directory, "stdin.json"), script = join(h.directory, "outlet.sh");
  await writeFile(script, `#!/bin/sh\ncat > "${out}"\n`); await chmod(script, 0o755);
  h.state.outlet = { kind: "command", argv: [script], timeoutMs: 5000 }; h.state.offsetMs = 3600_000;
  await pump.tick();
  const message = JSON.parse(await readFile(out, "utf8"));
  assert.deepEqual([message.kind, message.event, message.facts.category], ["provider_hold", "opened", "authentication_failed"]);
  assert.match(message.text, /认证失败/);
  assert.ok((await h.alerts())[0]!.open_delivered_at);
  // A command that exits non-zero, and one that is not there, are failures too.
  const failer = join(h.directory, "fail.sh"); await writeFile(failer, "#!/bin/sh\nexit 3\n"); await chmod(failer, 0o755);
  const hold = (await h.holds())[0]!;
  await h.workflow.execute(h.reviewer, { type: "runtime.providerHold.release", projectId: h.projectId, operationId: randomUUID(), provider: "codex", holdId: hold.hold_id, expectedVersion: hold.version, evidenceRef: "ops://x", reason: "ok" } as never);
  h.state.outlet = { kind: "command", argv: [failer], timeoutMs: 5000 }; h.state.offsetMs = 2 * 3600_000;
  await pump.tick(); assert.match((await h.alerts())[0]!.last_error, /command failed/);
  h.state.outlet = { kind: "command", argv: ["/nonexistent/outlet"], timeoutMs: 5000 }; h.state.offsetMs = 3 * 3600_000;
  await pump.tick(); assert.match((await h.alerts())[0]!.last_error, /command failed/);
  assert.equal(h.state.errors, 0, "none of it throws");
});

test("a stall is announced once after the configured time when work waits and nothing runs, and resolved when a Run starts; quiet time without work does not alert", async t => {
  const h = await harness(t);
  h.state.outlet = { kind: "webhook", url: await h.receiver(), headers: {}, timeoutMs: 2000 };
  const pump = h.pump();
  // No work and a long quiet time: no alert.
  h.state.offsetMs = 60 * 60_000; await pump.tick();
  assert.equal(h.received.length, 0, "a quiet project with nothing waiting is not a stall");
  // Work waits. Before the time: nothing. After it: one message.
  await h.readyTask("Waiting one");
  h.state.offsetMs = 10 * 60_000; await pump.tick(); assert.equal(h.received.length, 0, "not yet 30 minutes");
  h.state.offsetMs = 31 * 60_000; await pump.tick();
  assert.equal(h.received.length, 1);
  const stall = h.received[0]!;
  assert.deepEqual([stall.kind, stall.event], ["stall", "opened"]);
  assert.match(stall.text, /已超过 30 分钟没有新的 Run/); assert.match(stall.text, /压着 1 件活（就绪未派 1/);
  await pump.tick(); await h.pump().tick(); assert.equal(h.received.length, 1, "the same stall is not repeated");
  // A new Run starts (created at the pump's own time): the stall is over and one recovery goes out.
  const at = new Date(Date.now() + 40 * 60_000).toISOString();
  h.state.offsetMs = 40 * 60_000; await h.run("running", at); await pump.tick();
  assert.equal(h.received.length, 2);
  assert.deepEqual([h.received[1]!.kind, h.received[1]!.event], ["stall", "resolved"]);
  assert.match(h.received[1]!.text, /停摆已解除，共持续/);
  await pump.tick(); assert.equal(h.received.length, 2);
});

test("while a provider is paused the stall is not announced a second time, and the clock restarts at the release; a lease that is not ours sends nothing", async t => {
  const h = await harness(t);
  h.state.outlet = { kind: "webhook", url: await h.receiver(), headers: {}, timeoutMs: 2000 };
  const failing = await h.run("running"); await h.readyTask();
  await h.runtime.recordTurn(h.projectId, failing.runId, `turn-${failing.runId}`, "failed", "Native failure; category=quota_exhausted", { completedAtUtc: new Date().toISOString(), failureCategory: "quota_exhausted" });
  const pump = h.pump();
  h.state.offsetMs = 2 * 3600_000; await pump.tick();
  assert.deepEqual(h.received.map(m => m.kind), ["provider_hold"], "the pause explains the stillness; no stall message on top");
  h.state.canWrite = false; await pump.tick();
  const hold = (await h.holds())[0]!;
  h.state.canWrite = true;
  await h.workflow.execute(h.reviewer, { type: "runtime.providerHold.release", projectId: h.projectId, operationId: randomUUID(), provider: "codex", holdId: hold.hold_id, expectedVersion: hold.version, evidenceRef: "ops://x", reason: "ok" } as never);
  h.state.offsetMs = 10 * 60_000; await pump.tick(); // ten minutes after the release (the real release time is "now" here)
  assert.deepEqual(h.received.map(m => `${m.kind}:${m.event}`), ["provider_hold:opened", "provider_hold:resolved"], "work resumes after a release: the stall clock starts there, so no stall yet");
  h.state.offsetMs = 40 * 60_000; await pump.tick();
  assert.deepEqual(h.received.map(m => `${m.kind}:${m.event}`).slice(2), ["stall:opened"], "still nothing runs 31 minutes after the release, with work waiting");
});
