// Refuses a live or shared PostgreSQL server before this file opens TEST_DATABASE_URL (scripts/lib/database-target.mjs).
import "../../../scripts/test-database-guard.mjs";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import pg from "pg";
import { RuntimeWorkflowService, WorkflowService } from "@evoloop/core";
import type { Principal } from "@evoloop/contracts";
import { migrate, PostgresUnitOfWork } from "../src/index.ts";
import { SessionLinePump } from "../../../apps/coordinator/src/session-line/pump.ts";

const url = process.env.TEST_DATABASE_URL;
if (!url || !/^\/evoloop(?:_[a-z0-9]+)*_test$/i.test(new URL(url).pathname)) throw new Error("dedicated evoloop_*_test database required");
const schema = `el_line_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
const pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}` });
const uow = new PostgresUnitOfWork(pool);
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const deps = { uow, clock: { now: () => new Date().toISOString() }, ids: { next: randomUUID }, hasher: { hash } };
const workflow = new WorkflowService(deps);
const runtime = new RuntimeWorkflowService(deps);
const p = randomUUID(), role = randomUUID(), roleRev = randomUUID(), session = randomUUID();
const lead: Principal = { actorId: "lead", projectIds: [p], permissions: ["read", "write", "review"] };
const worker: Principal = { actorId: "worker", projectIds: [p], permissions: ["read", "write"] };

before(async () => {
  await migrate(url!, schema);
  await workflow.execute(lead, { type: "project.create", projectId: p, operationId: randomUUID(), title: "Session line" });
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query(`INSERT INTO role_definition(project_id,role_id,version,current_revision_id,state,proposed_by,created_at_utc,review_at_utc,trial_started_at_utc)
      VALUES($1,$2,1,$3,'trial','lead',now(),now()+interval '1 day',now())`, [p, role, roleRev]);
    await c.query(`INSERT INTO role_revision(project_id,role_id,revision_id,version,state,proposal,actor_id,reason,created_at_utc,review_at_utc)
      VALUES($1,$2,$3,1,'trial','{}'::jsonb,'lead','trial',now(),now()+interval '1 day')`, [p, role, roleRev]);
    await c.query("COMMIT");
  } catch (error) { await c.query("ROLLBACK"); throw error; } finally { c.release(); }
  await apply({ type: "runtime.session.reserve", projectId: p, operationId: randomUUID(), sessionId: session, roleId: role, cwd: "/tmp/line",
    authorizationScope: "project", sandbox: "danger-full-access", approvalPolicy: "never" });
  await runtime.beginSessionCreate(p, session);
  const saved = (await uow.read(p, r => r.getRuntimeSession(session)))!;
  await runtime.bindSession(p, session, { owner: "evoloop-codex-app-server", projectId: p, sessionId: session, roleId: role, cwd: "/tmp/line",
    authorizationScope: "project", nativeThreadId: `thread-${session}`, nativeSessionId: `native-${session}`,
    resumeProfile: { actorId: saved.actorId, model: saved.model, sandbox: saved.sandbox, approvalPolicy: saved.approvalPolicy,
      executionProfileRevisionId: saved.executionProfile!.revision.revisionId } });
});
after(async () => {
  await pool.end();
  const c = new pg.Client({ connectionString: url }); await c.connect();
  try { await c.query(`DROP SCHEMA "${schema}" CASCADE`); } finally { await c.end(); }
});

async function apply(command: Parameters<WorkflowService["execute"]>[1], who: Principal = lead) {
  const result = await workflow.execute(who, command);
  assert.equal(result.status, "applied", JSON.stringify(result));
  return result;
}
const reject = async (command: Parameters<WorkflowService["execute"]>[1], who: Principal = lead) => {
  const result = await workflow.execute(who, command).catch(error => ({ status: "rejected" as const, code: (error as { code: string }).code, message: String(error) }));
  assert.equal(result.status, "rejected", JSON.stringify(result));
  return (result as { code: string }).code;
};
const newTask = async (title: string, start = false) => {
  const taskId = randomUUID();
  await apply({ type: "task.create", projectId: p, operationId: randomUUID(), taskId, title, content: `# ${title}`, acceptance: "Result", owner: role });
  if (start) await apply({ type: "task.start", projectId: p, operationId: randomUUID(), taskId, expectedVersion: 1, reason: "start" });
  return taskId;
};
const task = (id: string) => uow.read(p, r => r.getTask(id)).then(t => t!);
const append = async (taskId: string) => apply({ type: "line.append", projectId: p, operationId: randomUUID(), sessionId: session, taskId,
  expectedTaskVersion: (await task(taskId)).version, reason: "arranged by the Leader" });
const entries = (ended = false) => workflow.listSessionLineEntries(lead, p, session, ended);
const entryOf = async (taskId: string) => (await entries(true)).find(e => e.taskId === taskId)!;
const eventKinds = async () => (await workflow.listSessionLineEvents(lead, p, 0, 500, session)).map(e => e.kind);
async function finishRun(runId: string) {
  await runtime.beginDispatch(p, runId);
  const stored = (await uow.read(p, r => r.getRuntimeRun(runId)))!;
  await runtime.bindTurn(p, runId, { id: `turn-${runId}` }, { kind: "startReply", operationId: stored.operationId });
  await runtime.recordTurn(p, runId, `turn-${runId}`, "completed", "done", { completedAtUtc: new Date().toISOString() });
}
const pump = new SessionLinePump({ workflow, credentials: async () => [lead, worker], enabled: async () => true, canWrite: () => true, pollIntervalMs: 1000,
  onError: error => { throw error; }, recipientActorId: async () => "worker" });
const settle = async () => { for (let i = 0; i < 4; i++) await pump.tick(); };

test("entries keep their order, move one step, and a queued Task cannot be started, reserved or reassigned another way", async () => {
  const a = await newTask("A"), b = await newTask("B"), c = await newTask("C");
  const first = await append(a); await append(b); await append(c);
  assert.deepEqual((await entries()).map(e => e.taskId), [a, b, c]);
  assert.equal(await reject({ type: "line.append", projectId: p, operationId: randomUUID(), sessionId: session, taskId: a,
    expectedTaskVersion: (await task(a)).version, reason: "again" }), "TASK_ALREADY_QUEUED");
  const entryC = await entryOf(c);
  await apply({ type: "line.move", projectId: p, operationId: randomUUID(), entryId: entryC.id, expectedVersion: entryC.version, direction: "forward" });
  assert.deepEqual((await entries()).map(e => e.taskId), [a, c, b], "relative move: C passes B");
  const top = await entryOf(a);
  assert.equal(await reject({ type: "line.move", projectId: p, operationId: randomUUID(), entryId: top.id, expectedVersion: top.version, direction: "forward" }), "LINE_END");
  // Direct arrangements are refused while the Task waits; the line's own path is the only way in.
  assert.equal(await reject({ type: "task.start", projectId: p, operationId: randomUUID(), taskId: a, expectedVersion: 1, reason: "start" }), "QUEUED_IN_SESSION_LINE");
  assert.equal(await reject({ type: "runtime.run.reserve", projectId: p, operationId: randomUUID(), runId: randomUUID(), taskId: a, sessionId: session,
    expectedVersion: 1, input: "x" }), "QUEUED_IN_SESSION_LINE");
  assert.equal(await reject({ type: "task.assignment.set", projectId: p, operationId: randomUUID(), taskId: a, expectedTaskVersion: 1,
    target: { kind: "owned", sessionId: session }, recipientActorId: "worker", expectedVersion: 0, reason: "reassign" }), "QUEUED_IN_SESSION_LINE");
  // Removing the entry frees the Task for an ordinary arrangement.
  const removed = await entryOf(b);
  await apply({ type: "line.remove", projectId: p, operationId: randomUUID(), entryId: removed.id, expectedVersion: removed.version, reason: "Leader decided otherwise" });
  await apply({ type: "task.start", projectId: p, operationId: randomUUID(), taskId: b, expectedVersion: 1, reason: "start directly" });
  assert.equal((await task(b)).state, "in_progress");
  for (const entry of await entries()) await apply({ type: "line.remove", projectId: p, operationId: randomUUID(), entryId: entry.id, expectedVersion: entry.version, reason: "cleanup" });
  assert.equal((await entries()).length, 0);
  assert.ok(first.entityId);
  assert.ok((await eventKinds()).includes("entry.appended") && (await eventKinds()).includes("entry.moved") && (await eventKinds()).includes("entry.removed"));
});

test("a busy Session makes entries wait; on its Run's end the first entry is confirmed, started, and the next follows after its Run", async () => {
  const busy = await newTask("Busy", true);
  const busyRun = randomUUID();
  await apply({ type: "runtime.run.reserve", projectId: p, operationId: randomUUID(), runId: busyRun, taskId: busy, sessionId: session,
    expectedVersion: (await task(busy)).version, input: "Current work" });
  const a = await newTask("Line A"), b = await newTask("Line B");
  await append(a); await append(b);
  await settle();
  assert.deepEqual((await entries()).map(e => e.state), ["queued", "queued"], "busy: both wait, nothing is suspended");

  await finishRun(busyRun);
  await settle();
  let entryA = await entryOf(a);
  assert.equal(entryA.state, "starting"); assert.equal(entryA.step, "confirm", "the Session is asked first");
  assert.equal((await task(a)).state, "todo", "not started before the confirmation");
  const message = (await pool.query("SELECT content,context_task_id FROM session_message WHERE message_id=$1", [entryA.messageId])).rows[0];
  assert.equal(message.context_task_id, a); assert.match(message.content, /执行确认/);

  const assignment = (await workflow.getTaskAssignment(lead, p, a))!;
  await apply({ type: "task.assignment.acknowledge", projectId: p, operationId: randomUUID(), taskId: a, expectedVersion: assignment.version,
    expectedTaskVersion: (await task(a)).version, evidence: "read the fixed Task", verdict: "confirm", plan: "Do A in two steps",
    expectedRevisionId: (await task(a)).currentRevisionId }, worker);
  await settle();
  entryA = await entryOf(a);
  assert.equal(entryA.state, "started", JSON.stringify(entryA));
  const runA = (await uow.read(p, r => r.listRuntimeRuns(a)))[0]!;
  assert.equal(runA.id, entryA.runId); assert.equal((await task(a)).state, "in_progress");
  assert.equal((await entryOf(b)).state, "queued", "B waits while A's Run is live");

  await finishRun(runA.id);
  await settle();
  const entryB = await entryOf(b);
  assert.equal(entryB.state, "starting", "A's Run ended: B is next");
  assert.equal(entryB.step, "confirm");

  // The Session returns B: it leaves the line and stays unstarted.
  const assignmentB = (await workflow.getTaskAssignment(lead, p, b))!;
  assert.equal(await reject({ type: "task.assignment.acknowledge", projectId: p, operationId: randomUUID(), taskId: b, expectedVersion: assignmentB.version,
    expectedTaskVersion: (await task(b)).version, evidence: "read", verdict: "return", expectedRevisionId: (await task(b)).currentRevisionId }, worker), "MISSING_REQUIRED");
  await apply({ type: "task.assignment.acknowledge", projectId: p, operationId: randomUUID(), taskId: b, expectedVersion: assignmentB.version,
    expectedTaskVersion: (await task(b)).version, evidence: "read", verdict: "return", missing: ["which repository?"],
    expectedRevisionId: (await task(b)).currentRevisionId }, worker);
  await settle();
  const returned = await entryOf(b);
  assert.equal(returned.state, "withdrawn"); assert.match(returned.withdrawnReason!, /returned/);
  assert.equal((await task(b)).state, "todo");
  const events = await workflow.listSessionLineEvents(lead, p, 0, 500, session);
  assert.ok(events.some(e => e.kind === "entry.returned" && e.detail.level === "summary"));
  assert.ok(events.some(e => e.kind === "entry.started"));
  assert.ok(events.every((e, i) => i === 0 || e.seq > events[i - 1]!.seq), "events are ordered");
});

test("an entry that cannot start is suspended with its reason and an immediate event, and the next entry moves up; resume puts it back", async () => {
  const x = await newTask("Blocked"), y = await newTask("Next");
  await append(x); await append(y);
  let recipient: string | null = null;
  const blocked = new SessionLinePump({ workflow, credentials: async () => [lead, worker], enabled: async () => true, canWrite: () => true, pollIntervalMs: 1000,
    onError: error => { throw error; }, recipientActorId: async () => recipient });
  await blocked.tick(); await blocked.tick();
  const suspended = await entryOf(x);
  assert.equal(suspended.state, "suspended"); assert.match(suspended.suspendReason!, /^RECIPIENT_UNAVAILABLE/);
  recipient = "worker";
  await blocked.tick(); await blocked.tick();
  assert.equal((await entryOf(y)).state, "starting", "the entry behind it moves up");
  assert.equal((await entryOf(y)).step, "confirm");
  assert.equal((await task(x)).state, "todo", "the suspended Task was not started");
  const events = await workflow.listSessionLineEvents(lead, p, 0, 500, session);
  assert.ok(events.some(e => e.kind === "entry.suspended" && e.detail.level === "immediate" && e.entryId === suspended.id));
  assert.equal(await reject({ type: "line.move", projectId: p, operationId: randomUUID(), entryId: (await entryOf(y)).id, expectedVersion: (await entryOf(y)).version, direction: "back" }), "ENTRY_STARTING");
  const again = await entryOf(x);
  await apply({ type: "line.resume", projectId: p, operationId: randomUUID(), entryId: again.id, expectedVersion: again.version, reason: "recipient configured" });
  assert.equal((await entryOf(x)).state, "queued");
});

test("an older queued message goes first; a Task is queued in one place only; a plain acknowledgement is unchanged", async () => {
  for (const left of await entries()) await apply({ type: "line.remove", projectId: p, operationId: randomUUID(), entryId: left.id, expectedVersion: left.version, reason: "cleanup" });
  const other = await newTask("Other");
  const entry = await append(other);
  assert.ok(entry.entityId);
  await assert.rejects(pool.query(`INSERT INTO session_line_entry(project_id,entry_id,session_id,task_id,position,state,source,source_actor_id,version,appended_at,updated_at)
    VALUES($1,$2,$3,$4,99,'queued','leader','lead',1,now(),now())`, [p, randomUUID(), session, other]), /session_line_entry_task_live/, "the database refuses a second live entry");
  // The Session serves whichever arrived first: with an older message still queued the entry stays queued.
  let older = true;
  const fair = new SessionLinePump({ workflow, credentials: async () => [lead, worker], enabled: async () => true, canWrite: () => true, pollIntervalMs: 1000,
    onError: error => { throw error; }, recipientActorId: async () => "worker", olderMessageWaiting: async () => older });
  const heldEntry = await entryOf(other);
  await fair.tick(); await fair.tick();
  assert.equal((await entryOf(other)).state, "queued", "an older message is served first");
  older = false;
  await fair.tick();
  assert.equal((await entryOf(other)).state, "starting");
  assert.equal(heldEntry.state, "queued");
  const plain = await newTask("Plain ack");
  await apply({ type: "task.assignment.set", projectId: p, operationId: randomUUID(), taskId: plain, expectedTaskVersion: 1,
    target: { kind: "owned", sessionId: session }, recipientActorId: "worker", expectedVersion: 0, reason: "direct" });
  await apply({ type: "task.assignment.acknowledge", projectId: p, operationId: randomUUID(), taskId: plain, expectedVersion: 1, expectedTaskVersion: 1, evidence: "read" }, worker);
  assert.equal((await workflow.getTaskAssignment(lead, p, plain))!.state, "accepted", "an acknowledgement without a verdict is unchanged");
  assert.equal(await reject({ type: "task.assignment.acknowledge", projectId: p, operationId: randomUUID(), taskId: plain, expectedVersion: 2, expectedTaskVersion: 1,
    evidence: "read", verdict: "confirm", plan: "x", expectedRevisionId: randomUUID() }, worker), "ALREADY_ACCEPTED");
});
