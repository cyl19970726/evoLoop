// Refuses a live or shared PostgreSQL server before this file opens TEST_DATABASE_URL (scripts/lib/database-target.mjs).
import "../../../scripts/test-database-guard.mjs";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import pg from "pg";
import { RuntimeWorkflowService, WorkflowService } from "@evoloop/core";
import type { Principal } from "@evoloop/contracts";
import { migrate, PostgresUnitOfWork } from "../src/index.ts";
import { SessionLinePump, type SessionLinePumpDeps } from "../../../apps/coordinator/src/session-line/pump.ts";
import { PgSessionMessages } from "../src/session-messages.ts";
import { AcceptanceRelayService } from "../../../apps/coordinator/src/acceptance-relay/service.ts";

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
  onError: error => { throw error; }, recipientActorId: async () => "worker", retryBackoffMs: () => 0 });
// W5 follow-up: what a line event does to the Leader. Only some become notices; the rest are records that wake no one.
const lineNotices = async (taskId: string) => (await pool.query(`SELECT kind, level, source_session_id FROM leader_result_notice WHERE project_id=$1 AND task_id=$2 AND kind LIKE 'line\\_%' ORDER BY occurred_at, kind`, [p, taskId])).rows;
const lineRecords = async (taskId: string) => (await pool.query(`SELECT kind, source_ref FROM leader_event_record WHERE project_id=$1 AND task_id=$2 AND kind LIKE 'line\\_%' ORDER BY occurred_at, source_ref`, [p, taskId])).rows;
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
  assert.ok(events.some(e => e.kind === "entry.runEnded" && e.taskId === a && e.detail.runState === "completed"), "one item's Run end is written once");
  assert.equal(events.filter(e => e.kind === "entry.runEnded" && e.taskId === a).length, 1);
  assert.ok(events.every((e, i) => i === 0 || e.seq > events[i - 1]!.seq), "events are ordered");
  // W5 follow-up: appended, started and ended are records (no notice); a returned confirmation is a digest notice for the Leader.
  assert.deepEqual(await lineNotices(a), [], "appending, starting and ending raise no notice");
  assert.deepEqual((await lineRecords(a)).map(row => row.kind), ["line_entry_appended", "line_entry_started", "line_entry_ended"], "they are recorded, in order");
  assert.deepEqual((await lineNotices(b)).map(row => [row.kind, row.level, String(row.source_session_id)]), [["line_confirmation_returned", "digest", session]],
    "the returned execution confirmation is a digest notice");
  assert.deepEqual((await lineRecords(b)).map(row => row.kind), ["line_entry_appended"]);
});

test("an unresolved business identity suspends the entry before any assignment or Run, with a reason that names the Session", async () => {
  const x = await newTask("Unresolved identity");
  await append(x);
  const reason = `Session ${session} shares its Role with 2 other live Session(s) and has no runtime.materialCli entry of its own; the business identity is not guessed from the Role`;
  const unresolved = new SessionLinePump({ workflow, credentials: async () => [lead, worker], enabled: async () => true, canWrite: () => true, pollIntervalMs: 1000,
    onError: error => { throw error; }, recipientActorId: async () => ({ unresolved: reason }) });
  await unresolved.tick(); await unresolved.tick();
  const suspended = await entryOf(x);
  assert.equal(suspended.state, "suspended"); assert.match(suspended.suspendReason!, /^RECIPIENT_UNAVAILABLE/);
  assert.match(suspended.suspendReason!, new RegExp(session)); assert.match(suspended.suspendReason!, /not guessed from the Role/);
  assert.equal((await task(x)).state, "todo", "nothing started");
  assert.equal(await workflow.getTaskAssignment(lead, p, x), null, "no assignment was written for another identity");
  assert.equal((await pool.query("SELECT count(*)::int n FROM runtime_run WHERE project_id=$1 AND task_id=$2", [p, x])).rows[0].n, 0, "no Run, so no preflight failure");
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
  // W5 follow-up: a suspended entry is an immediate notice for the Leader, once; the entry behind it raised none.
  assert.deepEqual((await lineNotices(x)).map(row => [row.kind, row.level]), [["line_entry_suspended", "immediate"]]);
  assert.deepEqual(await lineNotices(y), []);
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
  await pool.query(`INSERT INTO session_message(project_id,message_id,operation_id,target_kind,session_id,sender_actor_id,content,state,version,created_at,updated_at)
    VALUES($1,$2,$3,'owned',$4,'lead','an earlier question','queued',1,now()-interval '1 hour',now()-interval '1 hour')`, [p, randomUUID(), randomUUID(), session]);
  const fair = makePump();
  await fair.tick(); await fair.tick();
  assert.equal((await entryOf(other)).state, "queued", "an older message is served first");
  await pool.query("UPDATE session_message SET state='cancelled',version=version+1 WHERE project_id=$1 AND session_id=$2 AND state='queued'", [p, session]);
  await fair.tick();
  assert.equal((await entryOf(other)).state, "starting");
  const plain = await newTask("Plain ack");
  await apply({ type: "task.assignment.set", projectId: p, operationId: randomUUID(), taskId: plain, expectedTaskVersion: 1,
    target: { kind: "owned", sessionId: session }, recipientActorId: "worker", expectedVersion: 0, reason: "direct" });
  await apply({ type: "task.assignment.acknowledge", projectId: p, operationId: randomUUID(), taskId: plain, expectedVersion: 1, expectedTaskVersion: 1, evidence: "read" }, worker);
  assert.equal((await workflow.getTaskAssignment(lead, p, plain))!.state, "accepted", "an acknowledgement without a verdict is unchanged");
  assert.equal(await reject({ type: "task.assignment.acknowledge", projectId: p, operationId: randomUUID(), taskId: plain, expectedVersion: 2, expectedTaskVersion: 1,
    evidence: "read", verdict: "confirm", plan: "x", expectedRevisionId: randomUUID() }, worker), "ALREADY_ACCEPTED");
});

// ---- review 7851a79c -------------------------------------------------------------------------------------------------------------
const cleanLine = async () => {
  for (const left of await entries()) await apply({ type: "line.remove", projectId: p, operationId: randomUUID(), entryId: left.id, expectedVersion: left.version, reason: "cleanup" });
  // Requests of removed entries and other test messages are never delivered here: cancel them so they do not count as older work.
  for (const queued of (await pool.query("SELECT message_id,version FROM session_message WHERE project_id=$1 AND session_id=$2 AND state='queued'", [p, session])).rows)
    await apply({ type: "session.message.cancel", projectId: p, operationId: randomUUID(), messageId: queued.message_id, expectedVersion: queued.version, reason: "cleanup" });
};
const edit = async (taskId: string) => {
  const t = await task(taskId);
  await apply({ type: "task.update", projectId: p, operationId: randomUUID(), taskId, expectedVersion: t.version, title: t.title, content: `${t.title} edited`, acceptance: t.acceptance, owner: t.owner, reason: "edit" });
};
const makePump = (over: Partial<SessionLinePumpDeps> = {}, exec?: (real: WorkflowService["execute"], command: Parameters<WorkflowService["execute"]>[1]) => ReturnType<WorkflowService["execute"]> | null) => {
  const wf = exec ? new Proxy(workflow, { get: (target, key) => key === "execute"
    ? (principal: Principal, command: Parameters<WorkflowService["execute"]>[1]) => exec(target.execute.bind(target), command) ?? target.execute(principal, command)
    : (target as never)[key] }) as WorkflowService : workflow;
  return new SessionLinePump({ workflow: wf, credentials: async () => [lead, worker], enabled: async () => true, canWrite: () => true, pollIntervalMs: 1000,
    onError: error => { throw error; }, recipientActorId: async () => "worker", retryBackoffMs: () => 0, ...over });
};
const ticks = async (pumpUnderTest: SessionLinePump, n = 6) => { for (let i = 0; i < n; i++) await pumpUnderTest.tick(); };
const confirmTask = async (taskId: string) => {
  const assignment = (await workflow.getTaskAssignment(lead, p, taskId))!;
  const task0 = await task(taskId);
  await apply({ type: "task.assignment.acknowledge", projectId: p, operationId: randomUUID(), taskId, expectedVersion: assignment.version,
    expectedTaskVersion: task0.version, evidence: "read", verdict: "confirm", plan: "go", expectedRevisionId: task0.currentRevisionId }, worker);
};
const busyRun = async () => {
  const busy = await newTask("Busy " + randomUUID().slice(0, 4), true);
  const runId = randomUUID();
  await apply({ type: "runtime.run.reserve", projectId: p, operationId: randomUUID(), runId, taskId: busy, sessionId: session, expectedVersion: (await task(busy)).version, input: "busy" });
  return runId;
};
const runsOf = (taskId: string) => uow.read(p, r => r.listRuntimeRuns(taskId));

test("review 1: a refusal that only meant wait is retried under fresh ids and the entry starts", async () => {
  await cleanLine();
  const t = await newTask("Retry me"); await append(t);
  let blocked: string | null = null;
  // The first reserve meets a Session that became busy a moment earlier: a real, journalled SESSION_BUSY.
  const pumpUnderTest = makePump({}, (real, command) => {
    if (command.type === "runtime.run.reserve" && command.taskId === t && !blocked) {
      return (async () => { blocked = await busyRun(); return real(lead, command); })();
    }
    return null;
  });
  await ticks(pumpUnderTest, 3);
  await confirmTask(t);
  await ticks(pumpUnderTest, 2);
  assert.ok(blocked, "the busy Run was created right before the reserve");
  let entry = await entryOf(t);
  assert.equal(entry.state, "starting"); assert.equal(entry.stepTry, 1, "the refusal was retried, not replayed");
  assert.ok((await eventKinds()).includes("entry.retried"));
  await finishRun(blocked!);
  await ticks(pumpUnderTest, 4);
  entry = await entryOf(t);
  assert.equal(entry.state, "started", JSON.stringify(entry));
  assert.equal((await runsOf(t)).length, 1);
  await finishRun((await runsOf(t))[0]!.id); await ticks(pumpUnderTest, 2);
});

test("review 2: a Run that already exists is recorded, never reserved twice", async () => {
  await cleanLine();
  const t = await newTask("One Run only"); await append(t);
  let lost = false;
  const pumpUnderTest = makePump({}, (_real, command) => {
    if (command.type === "line.started" && !lost) { lost = true; return Promise.resolve({ status: "rejected", operationId: command.operationId, code: "VERSION_CONFLICT", message: "lost reply" }); }
    return null;
  });
  await ticks(pumpUnderTest, 3);
  await confirmTask(t);
  await ticks(pumpUnderTest, 6);
  assert.ok(lost);
  assert.equal((await entryOf(t)).state, "started");
  assert.equal((await runsOf(t)).length, 1, "exactly one Run");
  await finishRun((await runsOf(t))[0]!.id); await ticks(pumpUnderTest, 2);
});

test("review 3, 4, 5: a stale confirmation, a plain acknowledgement, a failed request and a missing answer; the start step can leave", async () => {
  await cleanLine();
  // 4a: a plain acknowledgement while the confirmation is awaited is refused.
  const a = await newTask("Awaiting"); await append(a);
  const wait = makePump();
  await ticks(wait, 2);
  const assignment = (await workflow.getTaskAssignment(lead, p, a))!;
  assert.equal(await reject({ type: "task.assignment.acknowledge", projectId: p, operationId: randomUUID(), taskId: a, expectedVersion: assignment.version,
    expectedTaskVersion: (await task(a)).version, evidence: "ok" }, worker), "CONFIRMATION_VERDICT_REQUIRED");
  // 4b: no answer in time suspends the entry.
  const late = makePump({ now: () => Date.now() + 2 * 60 * 60 * 1000, confirmationTimeoutMs: 60 * 60 * 1000 });
  await ticks(late, 2);
  assert.match((await entryOf(a)).suspendReason!, /^CONFIRMATION_TIMEOUT/);
  // 4c: a request that failed suspends it.
  await cleanLine();
  const b = await newTask("Undelivered"); await append(b);
  await ticks(wait, 2);
  const requestId = (await entryOf(b)).messageId!;
  const request = (await pool.query("SELECT version FROM session_message WHERE message_id=$1", [requestId])).rows[0];
  await apply({ type: "session.message.cancel", projectId: p, operationId: randomUUID(), messageId: requestId, expectedVersion: request.version, reason: "never delivered" });
  await ticks(wait, 2);
  assert.match((await entryOf(b)).suspendReason!, /^MESSAGE_UNDELIVERED/);
  // 3: the Task changed after the confirmation: the guard and the pump both refuse to start it.
  await cleanLine();
  const c = await newTask("Changed after confirm"); await append(c);
  await ticks(wait, 2); await confirmTask(c);
  const hold = await busyRun();
  await ticks(wait, 2);
  assert.equal((await entryOf(c)).step, "start", "waiting at the start step while the Session is busy");
  // 5: the start step can leave while no Run was reserved for it.
  const atStart = await entryOf(c);
  const before = await task(c);
  await edit(c);
  const changed = await task(c);
  assert.notEqual(changed.currentRevisionId, before.currentRevisionId);
  await finishRun(hold);
  await ticks(wait, 3);
  const after = await entryOf(c);
  assert.equal(after.state, "suspended"); assert.match(after.suspendReason!, /^CONFIRMATION_STALE/); assert.equal((await task(c)).state, "todo");
  assert.ok(atStart.step === "start");
  await cleanLine();
  const d = await newTask("Leaves at start"); await append(d);
  await ticks(wait, 2); await confirmTask(d);
  const hold2 = await busyRun();
  await ticks(wait, 2);
  const stuck = await entryOf(d); assert.equal(stuck.step, "start");
  await apply({ type: "line.remove", projectId: p, operationId: randomUUID(), entryId: stuck.id, expectedVersion: stuck.version, reason: "no longer wanted" });
  assert.equal((await entryOf(d)).state, "withdrawn");
  await finishRun(hold2);
});

test("review 8: a pending basis review suspends the head and the next entry moves up", async () => {
  await cleanLine();
  const bad = await newTask("Basis pending"), good = await newTask("Fine");
  await append(bad); await append(good);
  const pumpUnderTest = makePump();
  const old = (await pool.query("SELECT content_revision_id FROM task WHERE task_id=$1", [bad])).rows[0];
  await edit(bad);
  const row = (await pool.query("SELECT content_document_id,content_revision_id,current_revision_id FROM task WHERE task_id=$1", [bad])).rows[0];
  await pool.query(`INSERT INTO impact_review(project_id,impact_id,task_id,task_revision_id,document_id,from_revision_id,to_revision_id,state,created_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,'pending',now())`, [p, randomUUID(), bad, row.current_revision_id, row.content_document_id, old.content_revision_id, row.content_revision_id]);
  await ticks(pumpUnderTest, 2);
  await confirmTask(bad);
  await ticks(pumpUnderTest, 4);
  const suspended = await entryOf(bad);
  assert.equal(suspended.state, "suspended"); assert.match(suspended.suspendReason!, /^PENDING_BASIS_REVIEW/);
  assert.equal((await task(bad)).state, "todo");
  assert.ok((await workflow.listSessionLineEvents(lead, p, 0, 500, session)).some(e => e.kind === "entry.suspended" && e.entryId === suspended.id && e.detail.level === "immediate"));
  assert.notEqual((await entryOf(good)).state, "queued", "the entry behind it moved up");
  await cleanLine();
});

test("L1, L2, L4, L6 and fairness: exemptions only in their step, no swap with a starting entry, line version, older message, message pump yields", async () => {
  await cleanLine();
  const first = await newTask("First"), second = await newTask("Second"); await append(first); await append(second);
  const versionBefore = (await workflow.listSessionLines(lead, p))[0]!.version;
  const wait = makePump();
  await ticks(wait, 2);
  const head = await entryOf(first);
  assert.equal(head.step, "confirm");
  assert.ok((await workflow.listSessionLines(lead, p))[0]!.version > versionBefore, "the line version follows its entries");
  // L1: the start operation is not an exemption while the entry is at the confirm step.
  assert.equal(await reject({ type: "task.start", projectId: p, operationId: head.startOperationId!, taskId: first, expectedVersion: (await task(first)).version, reason: "early" }), "QUEUED_IN_SESSION_LINE");
  // L2: the waiting entry cannot be moved past the starting one.
  const behind = await entryOf(second);
  assert.equal(await reject({ type: "line.move", projectId: p, operationId: randomUUID(), entryId: behind.id, expectedVersion: behind.version, direction: "forward" }), "LINE_END");
  // Fairness: the message pump leaves a message newer than a waiting entry; the entry's own request is exempt.
  const client = await pool.connect();
  try {
    const messages = new PgSessionMessages(client, p);
    const pending = (await messages.listPendingSessionMessages(50)).map(m => m.id);
    assert.ok(pending.includes(head.messageId!), "the confirmation request itself is delivered");
    const newer = randomUUID();
    await client.query(`INSERT INTO session_message(project_id,message_id,operation_id,target_kind,session_id,sender_actor_id,content,state,version,created_at,updated_at)
      VALUES($1,$2,$3,'owned',$4,'lead','a later question','queued',1,now()+interval '1 minute',now()+interval '1 minute')`, [p, newer, randomUUID(), session]);
    assert.ok(!(await messages.listPendingSessionMessages(50)).some(m => m.id === newer), "an entry appended before the message goes first");
    // L6: a message queued before an entry was appended makes the line wait (real query, not a stub).
    assert.equal(await workflow.hasOlderQueuedMessage(lead, p, session, new Date(Date.now() + 2 * 60 * 1000).toISOString()), true);
    assert.equal(await workflow.hasOlderQueuedMessage(lead, p, session, new Date(Date.now() - 60 * 60 * 1000).toISOString()), false);
    await client.query("UPDATE session_message SET state='cancelled',version=version+1 WHERE message_id=$1", [newer]);
  } finally { client.release(); }
  await cleanLine();
});

test("review 6: the capacity view separates a busy Session from queued line items, and the line's own assignment is not unfinished work", async () => {
  await cleanLine();
  const relay = new AcceptanceRelayService({ pool, workflow, messages: {} as never, principals: async () => [lead], canWrite: () => true,
    leaderSession: async () => null, qualify: async () => null, capabilities: async () => [] });
  const view = async () => ((await relay.capacity(lead, p)) as Array<Record<string, unknown>>).find(row => row.sessionId === session)!;
  const base = await view();   // earlier tests leave an accepted assignment behind; it is the baseline
  const queued = await newTask("Queued only"), second = await newTask("Second queued");
  await append(queued); await append(second);
  let row = await view();
  assert.equal(row.lineQueued, 2); assert.equal(row.lineStarting, 0);
  assert.equal(row.persistedWorkIdle, base.persistedWorkIdle, "items waiting in the line do not change whether the Session is available");
  assert.equal(row.openAssignments, base.openAssignments); assert.equal(row.queueEntries, base.queueEntries);
  const start = makePump();
  await ticks(start, 2);
  row = await view();
  assert.equal(row.lineStarting, 1, "the entry being started is the Session's occupation");
  assert.equal(row.lineQueued, 1);
  assert.equal(row.openAssignments, base.openAssignments, "the assignment the line wrote before the Task started is not an unfinished arrangement");
  assert.equal(row.persistedWorkIdle, false);
  await cleanLine();
});

// ---- follow-up: retry cap, temporary blocks, confirmation re-check, pump read scope ------------------------------------------------
const refuseReserve = (code: string, log: string[] = []) => (_real: WorkflowService["execute"], command: Parameters<WorkflowService["execute"]>[1]) => {
  if (command.type !== "runtime.run.reserve") return null;
  log.push(code);
  return Promise.resolve({ status: "rejected" as const, code, message: `${code} (test)` }) as ReturnType<WorkflowService["execute"]>;
};
const countKind = async (kind: string, taskId: string) =>
  (await workflow.listSessionLineEvents(lead, p, 0, 500, session)).filter(e => e.kind === kind && (e as { taskId?: string }).taskId !== "other" && JSON.stringify(e).includes(taskId)).length;
/** Drive an entry to its start step: appended, requested, confirmed. */
const toStartStep = async (title: string, pumpUnderTest: SessionLinePump, startTask = false) => {
  const t = await newTask(title, startTask); await append(t);
  await ticks(pumpUnderTest, 2); await confirmTask(t); await ticks(pumpUnderTest, 1);
  assert.equal((await entryOf(t)).step, "start");
  return t;
};

test("follow-up 1a: a blocked recovery gate suspends the entry once, with no retry", async () => {
  await cleanLine();
  const log: string[] = [];
  const blocked = makePump({}, refuseReserve("RECOVERY_BLOCKED", log));
  const t = await toStartStep("Gate blocked", blocked);
  await ticks(blocked, 6);
  const entry = await entryOf(t);
  assert.equal(entry.state, "suspended"); assert.match(entry.suspendReason!, /^RECOVERY_BLOCKED/);
  assert.equal(log.length, 1, "the refused reserve was sent once");
  assert.equal(entry.stepTry, 0);
  assert.equal(await countKind("entry.retried", t), 0, "no entry.retried event");
  assert.equal(await countKind("entry.suspended", t), 1, "one immediate-level suspension");
});

test("follow-up 1b: a retryable refusal is retried within the cap, then the entry is suspended with the reason", async () => {
  await cleanLine();
  const log: string[] = [];
  const capped = makePump({ maxStepRetries: 3 }, refuseReserve("SESSION_BUSY", log));
  const t = await toStartStep("Busy forever", capped);
  await ticks(capped, 12);
  const entry = await entryOf(t);
  assert.equal(entry.state, "suspended"); assert.match(entry.suspendReason!, /^RETRY_LIMIT: .*SESSION_BUSY/);
  assert.equal(entry.stepTry, 3);
  assert.equal(await countKind("entry.retried", t), 3, "exactly the cap of retries were written");
  assert.equal(log.length, 4, "the first try plus three retries");
  const suspended = (await workflow.listSessionLineEvents(lead, p, 0, 500, session)).filter(e => e.kind === "entry.suspended" && JSON.stringify(e).includes(t));
  assert.equal(suspended.length, 1); assert.match(JSON.stringify(suspended[0]), /immediate/);
  await ticks(capped, 3);
  assert.equal(log.length, 4, "a suspended entry sends nothing more");
});

test("follow-up 1c: retries back off instead of repeating on every poll", async () => {
  await cleanLine();
  const log: string[] = [];
  const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
  const slow = makePump({ retryBackoffMs: n => 300 * n, maxStepRetries: 9 }, refuseReserve("SESSION_BUSY", log));
  const t = await toStartStep("Backoff", slow);
  await ticks(slow, 6); // polled six times at once: the first refusal is written, then nothing until the backoff passes
  assert.equal(log.length, 1); assert.equal((await entryOf(t)).stepTry, 1);
  await sleep(350); await ticks(slow, 1); assert.equal(log.length, 2); assert.equal((await entryOf(t)).stepTry, 2);
  await sleep(350); await ticks(slow, 3); assert.equal(log.length, 2, "the second backoff (600 ms) is longer than the first");
  await sleep(300); await ticks(slow, 1); assert.equal(log.length, 3);
  assert.equal(await countKind("entry.retried", t), 3, "one retry per refusal, none per poll");
});

test("follow-up 2: SESSION_INPUT_BUSY on the confirmation request keeps the entry waiting; any other reason suspends", async () => {
  await cleanLine();
  const wait = makePump();
  const t = await newTask("Parked request"); await append(t);
  await ticks(wait, 2);
  const requestId = (await entryOf(t)).messageId!;
  // The message pump records blockedReason on the message; the pump under test sees the record with it (a message cannot be edited in place).
  let reason: string | null = null;
  const seesBlock = new Proxy(workflow, { get: (target, key) => key === "getSessionMessageRecord"
    ? async (...args: unknown[]) => { const record = await (target.getSessionMessageRecord as (...a: unknown[]) => Promise<Record<string, unknown> | null>)(...args);
      return record && reason ? { ...record, blockedReason: reason } : record; }
    : (target as never)[key] }) as WorkflowService;
  const parked = makePump({ workflow: seesBlock });
  reason = "SESSION_INPUT_BUSY: another native send owns this Session";
  await ticks(parked, 3);
  assert.equal((await entryOf(t)).state, "starting", "waiting, not suspended");
  assert.equal(requestId, (await entryOf(t)).messageId);
  reason = null;
  await confirmTask(t); await ticks(wait, 6);
  const started = await entryOf(t);
  assert.equal(started.state, "started", JSON.stringify(started));
  await finishRun((await runsOf(t))[0]!.id); await ticks(wait, 2);
  await cleanLine();
  const u = await newTask("Other block"); await append(u);
  await ticks(wait, 2);
  reason = "GRANT_MISSING: no grant";
  await ticks(parked, 2);
  const other = await entryOf(u);
  assert.equal(other.state, "suspended"); assert.match(other.suspendReason!, /^MESSAGE_UNDELIVERED: .*GRANT_MISSING/);
});

test("follow-up 3: an in_progress Task revised after the Session confirmed it is CONFIRMATION_STALE and no Run is opened", async () => {
  await cleanLine();
  const wait = makePump();
  const t = await toStartStep("Started then revised", wait, true);
  assert.equal((await task(t)).state, "in_progress");
  const hold = await busyRun();
  await ticks(wait, 2);
  const before = await task(t);
  await apply({ type: "task.update", projectId: p, operationId: randomUUID(), taskId: t, expectedVersion: before.version, title: `${before.title} (retitled)`,
    content: before.content, acceptance: before.acceptance, owner: before.owner, reason: "retitle after the confirmation" });
  assert.notEqual((await task(t)).currentRevisionId, before.currentRevisionId, "the in_progress Task has a new revision");
  await finishRun(hold);
  await ticks(wait, 4);
  const entry = await entryOf(t);
  assert.equal(entry.state, "suspended", JSON.stringify(entry)); assert.match(entry.suspendReason!, /^CONFIRMATION_STALE/);
  assert.equal((await runsOf(t)).length, 0, "no Run was opened");
});

test("follow-up 3b: the revision made by the line's own task.start is not a change, also across a retry", async () => {
  await cleanLine();
  const log: string[] = [];
  let refuse = true;
  const own = makePump({ maxStepRetries: 4 }, (real, command) => command.type === "runtime.run.reserve" && refuse ? refuseReserve("SESSION_BUSY", log)(real, command) : null);
  const t = await toStartStep("Own start", own); // todo Task: the line starts it, then the reserve is refused and retried
  await ticks(own, 3);
  assert.equal((await task(t)).state, "in_progress"); assert.ok(log.length >= 2, "the reserve was retried after the Task started");
  assert.equal((await entryOf(t)).state, "starting", "its own start does not make the confirmation stale");
  refuse = false; await ticks(own, 3);
  assert.equal((await entryOf(t)).state, "started");
  await finishRun((await runsOf(t))[0]!.id); await ticks(own, 2);
});

test("follow-up 4: the pump reads only unfinished entries; finished old ones are no longer read", async () => {
  await cleanLine();
  const done = await newTask("Finished long ago"); await append(done);
  const quick = makePump();
  await ticks(quick, 2); await confirmTask(done); await ticks(quick, 4);
  await finishRun((await runsOf(done))[0]!.id); await ticks(quick, 2);
  assert.ok((await entryOf(done)).runEndedAt, "the old entry's Run end is recorded");
  const gone = await newTask("Withdrawn"); await append(gone);
  const g = await entryOf(gone); await apply({ type: "line.remove", projectId: p, operationId: randomUUID(), entryId: g.id, expectedVersion: g.version, reason: "no" });
  const waiting = await newTask("Waiting now"); await append(waiting);
  const seen: string[][] = []; const asked: string[] = [];
  const spy = new Proxy(workflow, { get: (target, key) => {
    if (key === "listSessionLineEntries") return (...args: unknown[]) => { asked.push("all"); return (target.listSessionLineEntries as (...a: unknown[]) => unknown)(...args); };
    if (key === "listUnfinishedSessionLineEntries") return async (...args: unknown[]) => {
      asked.push("unfinished");
      const rows = await (target.listUnfinishedSessionLineEntries as (...a: unknown[]) => Promise<Array<{ taskId: string }>>)(...args);
      seen.push(rows.map(row => row.taskId)); return rows;
    };
    return (target as never)[key];
  } }) as WorkflowService;
  await ticks(makePump({ workflow: spy }), 2);
  assert.deepEqual([...new Set(asked)], ["unfinished"], "the pump never asks for the whole history");
  for (const rows of seen) { assert.ok(!rows.includes(done), "the finished entry is not read"); assert.ok(!rows.includes(gone), "the withdrawn entry is not read"); }
  assert.ok(seen.some(rows => rows.includes(waiting)));
  // A started entry whose Run end is still unrecorded is read, so the end gets recorded.
  const live = (await workflow.listUnfinishedSessionLineEntries(lead, p, session)).map(e => e.taskId);
  assert.ok(!live.includes(done) && !live.includes(gone));
  const all = (await workflow.listSessionLineEntries(lead, p, session, true)).map(e => e.taskId);
  assert.ok(all.includes(done) && all.includes(gone), "the full history is still there for the workbench");
});
