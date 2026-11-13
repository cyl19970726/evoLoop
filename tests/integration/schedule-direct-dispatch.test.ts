// Refuses a live or shared PostgreSQL server before this file opens TEST_DATABASE_URL (scripts/lib/database-target.mjs).
import "../../scripts/test-database-guard.mjs";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";
import { migrate, PostgresUnitOfWork } from "@evoloop/adapter-postgres";
import { PgSchedulingStore } from "@evoloop/adapter-postgres/scheduling";
import { RuntimeWorkflowService, WorkflowService } from "@evoloop/core";
import { SchedulingService } from "@evoloop/core/scheduling";
import type { Principal } from "@evoloop/contracts";
import { ScheduleDirectDispatcher } from "../../apps/coordinator/src/scheduling/direct-dispatch.js";
import { sessionDenial, type DirectAuthorizationConfig } from "../../apps/coordinator/src/scheduling/direct-authorization.js";
import { fixtureRoleId, seedFixtureRole } from "./role-fixture.test.js";

const database = process.env.TEST_DATABASE_URL;
if (!database || !/^\/evoloop(?:_[a-z0-9]+)*_test$/.test(new URL(database).pathname)) throw new Error("A dedicated evoloop_*_test database is required");
const HOUR = 3_600_000;

/**
 * The real path end to end: schedules and Tasks through WorkflowService, the occurrence made by SchedulingService and PgSchedulingStore (the Task, its
 * dispatch intent and the missing triage notice in one transaction), the coordinator's own ScheduleDirectDispatcher appending to a real Session line,
 * and the records and Leader notices the database makes. Only the clock is ours.
 */
async function rig(t: import("node:test").TestContext) {
  const schema = `direct_dispatch_${randomUUID().replaceAll("-", "")}`;
  await migrate(database!, schema);
  const pool = new pg.Pool({ connectionString: database, options: `-c search_path=${schema}` });
  t.after(async () => { await pool.end(); const admin = new pg.Client({ connectionString: database }); await admin.connect(); try { await admin.query(`DROP SCHEMA "${schema}" CASCADE`); } finally { await admin.end(); } });
  const projectId = randomUUID();
  const lead: Principal = { actorId: "lead", projectIds: [projectId], permissions: ["read", "write", "review"] };
  const writer: Principal = { actorId: "writer", projectIds: [projectId], permissions: ["read", "write"] };
  const deps = { uow: new PostgresUnitOfWork(pool), clock: { now: () => new Date().toISOString() }, ids: { next: randomUUID },
    hasher: { hash: (value: string) => createHash("sha256").update(value).digest("hex") } };
  const workflow = new WorkflowService(deps), runtime = new RuntimeWorkflowService(deps);
  const applied = async (who: Principal, command: Record<string, unknown>) => { const r = await workflow.execute(who, { ...command, projectId, operationId: randomUUID() } as never); assert.equal(r.status, "applied", JSON.stringify(r)); return r; };
  const refused = async (who: Principal, command: Record<string, unknown>) => workflow.execute(who, { ...command, projectId, operationId: randomUUID() } as never)
    .then(r => ({ code: (r as { code?: string }).code ?? r.status }), (error: { code?: string; message: string }) => ({ code: error.code ?? error.message }));
  await applied(lead, { type: "project.create", title: "Direct dispatch" });
  const role = fixtureRoleId("scheduled-role"); await seedFixtureRole(pool, projectId, role);
  const session = async (cwd = "/tmp/direct") => {
    const sessionId = randomUUID();
    await applied(lead, { type: "runtime.session.reserve", sessionId, roleId: role, cwd, authorizationScope: "project", sandbox: "danger-full-access", approvalPolicy: "never" });
    await runtime.beginSessionCreate(projectId, sessionId);
    const saved = (await deps.uow.read(projectId, r => r.getRuntimeSession(sessionId)))!;
    await runtime.bindSession(projectId, sessionId, { owner: "evoloop-codex-app-server", projectId, sessionId, roleId: role, cwd, authorizationScope: "project",
      nativeThreadId: `thread-${sessionId}`, nativeSessionId: `native-${sessionId}`, resumeProfile: { actorId: saved.actorId, model: saved.model, sandbox: saved.sandbox,
        approvalPolicy: saved.approvalPolicy, executionProfileRevisionId: saved.executionProfile!.revision.revisionId } });
    return sessionId;
  };
  const store = new PgSchedulingStore(pool);
  /** The private configuration as the dispatcher sees it, changeable between triggers: which Sessions' runtime grants exist. */
  const config = { enabled: true, granted: new Set<string>(), reads: 0, allGranted: true };
  const dispatcher = new ScheduleDirectDispatcher({ pool, workflow: { execute: (who, command) => workflow.execute(who, command as never) as never }, newId: randomUUID,
    sessionDenial: sessionDenial(pool, async (): Promise<DirectAuthorizationConfig> => { config.reads++; return { runtime: { enabled: config.enabled },
      hasRuntimeGrant: scope => config.allGranted || config.granted.has(scope.cwd), allowedRuntimeCwd: async () => true }; }) });
  const T0 = Date.now();
  let scheduleSeq = 0;
  /** An hourly schedule (skip while the previous occurrence is open) whose first trigger is one hour after T0. */
  const makeSchedule = async (overrides: Record<string, unknown> = {}) => {
    const scheduleId = randomUUID(); scheduleSeq++;
    await applied(lead, { type: "schedule.create", scheduleId, revisionId: randomUUID(), timezone: "UTC", rule: { kind: "interval", anchorUtc: new Date(T0).toISOString(), everyMinutes: 60 },
      misfire: { kind: "latest" }, overlap: "skip", template: { title: `Scheduled ${scheduleSeq}`, content: "# Scheduled work", acceptance: "Done", owner: role },
      authorization: { scopeId: "scope", roleId: role, authorizedBy: lead.actorId, expiresAtUtc: null }, watermarkUtc: new Date(T0).toISOString(), state: "active",
      reason: "direct dispatch test", ...overrides });
    return scheduleId;
  };
  const fire = async (hoursAfter: number) => new SchedulingService(store).tick(lead, projectId, new Date(T0 + hoursAfter * HOUR + 60_000).toISOString(), ["scope"]);
  const dispatchAt = async (hoursAfter: number) => dispatcher.process(projectId, lead, new Date(T0 + hoursAfter * HOUR + 120_000).toISOString());
  const setList = async (sessions: string[]) => {
    const current = await pool.query("SELECT version FROM direct_dispatch_list WHERE project_id=$1 AND role_id=$2", [projectId, role]);
    return applied(lead, { type: "schedule.directList.set", roleId: role, expectedVersion: current.rows[0]?.version ?? 0, sessionIds: sessions, reason: "direct list" });
  };
  const setPolicy = async (scheduleId: string, fields: Record<string, unknown> = {}) => {
    const current = await pool.query("SELECT version FROM schedule_dispatch_policy WHERE project_id=$1 AND schedule_id=$2", [projectId, scheduleId]);
    return applied(lead, { type: "schedule.dispatch.set", scheduleId, expectedVersion: current.rows[0]?.version ?? 0, mode: "direct", state: "active", reason: "approve direct dispatch", ...fields });
  };
  const taskOfOccurrence = async (scheduleId: string, n = 0) => String((await pool.query("SELECT task_id FROM schedule_occurrence WHERE project_id=$1 AND schedule_id=$2 AND task_id IS NOT NULL ORDER BY planned_at_utc OFFSET $3 LIMIT 1", [projectId, scheduleId, n])).rows[0]?.task_id);
  const notices = async (taskId: string) => (await pool.query("SELECT kind, level FROM leader_result_notice WHERE project_id=$1 AND task_id=$2 ORDER BY kind", [projectId, taskId])).rows as Array<{ kind: string; level: string }>;
  const logOf = async (scheduleId: string) => (await pool.query("SELECT state, reason, session_id FROM schedule_dispatch_log WHERE project_id=$1 AND schedule_id=$2 ORDER BY planned_at_utc", [projectId, scheduleId])).rows as Array<{ state: string; reason: string; session_id: string | null }>;
  const lineOf = async (sessionId: string) => (await pool.query("SELECT entry_id, task_id, state, source FROM session_line_entry WHERE project_id=$1 AND session_id=$2 ORDER BY position", [projectId, sessionId])).rows as Array<{ entry_id: string; task_id: string; state: string; source: string }>;
  const records = async (kind: string) => (await pool.query("SELECT task_id, source_ref FROM leader_event_record WHERE project_id=$1 AND kind=$2 ORDER BY occurred_at", [projectId, kind])).rows;
  const leaderTask = async (title: string) => { const taskId = randomUUID(); await applied(lead, { type: "task.create", taskId, title, content: `# ${title}`, acceptance: "ok", owner: role }); return taskId; };
  const appendLeader = async (sessionId: string, taskId: string) => applied(lead, { type: "line.append", sessionId, taskId, expectedTaskVersion: 1, source: "leader", reason: "arranged" });
  return { config, pool, projectId, lead, writer, workflow, role, session, makeSchedule, fire, dispatchAt, setList, setPolicy, taskOfOccurrence, notices, logOf, lineOf, records, leaderTask, appendLeader, applied, refused, T0 };
}

test("a direct schedule's Task is made without a triage notice, then appended to the line of the first idle Session on the list; the Leader gets a record, not a notice", async t => {
  const r = await rig(t);
  const a = await r.session(), b = await r.session();
  await r.setList([a, b]);
  const scheduleId = await r.makeSchedule();
  await r.setPolicy(scheduleId);
  const made = await r.fire(1);
  assert.equal(made[0]?.state, "created");
  const taskId = await r.taskOfOccurrence(scheduleId);
  assert.deepEqual(await r.notices(taskId), [], "no triage notice for a Task that goes straight to a line");
  assert.deepEqual((await r.logOf(scheduleId)).map(row => row.state), ["pending"], "the intent was written with the Task: a restart before the append loses nothing");
  // Restart in between: a fresh dispatcher finishes what is pending.
  const result = await r.dispatchAt(1);
  assert.deepEqual(result, { dispatched: 1, fellBack: 0 });
  assert.deepEqual((await r.logOf(scheduleId)).map(row => [row.state, row.session_id]), [["dispatched", a]], "idle Sessions tie on the line, so list order decides");
  assert.deepEqual((await r.lineOf(a)).map(row => [row.task_id, row.state, row.source]), [[taskId, "queued", "schedule"]]);
  assert.deepEqual(await r.lineOf(b), []);
  assert.deepEqual(await r.notices(taskId), [], "still no notice");
  assert.deepEqual((await r.records("direct_dispatched")).map(row => row.task_id), [taskId], "the Leader can see it in the records");
  assert.deepEqual(await r.dispatchAt(1), { dispatched: 0, fellBack: 0 }, "nothing is dispatched twice");
});

test("busy Sessions: an idle one first, then the shortest line, then list order", async t => {
  const r = await rig(t);
  const a = await r.session(), b = await r.session(), c = await r.session();
  await r.setList([a, b, c]);
  await r.appendLeader(a, await r.leaderTask("A one")); await r.appendLeader(a, await r.leaderTask("A two"));
  await r.appendLeader(b, await r.leaderTask("B one"));
  const chosen: string[] = [];
  for (let i = 0; i < 3; i++) {
    const scheduleId = await r.makeSchedule();
    await r.setPolicy(scheduleId);
    await r.fire(1); await r.dispatchAt(1);
    chosen.push((await r.logOf(scheduleId))[0]!.session_id!);
  }
  // Lines start A:2, B:1, C:0. C is idle, so it goes there first although A and B are earlier on the list; then B and C are tied at 1 (B is earlier);
  // then C (1) is shorter than B (2); A (2) is never chosen over a shorter line.
  assert.deepEqual(chosen, [c, b, c]);
  assert.deepEqual([(await r.lineOf(a)).length, (await r.lineOf(b)).length, (await r.lineOf(c)).length], [2, 2, 2]);
});

test("taking a scheduled Task out of its line needs a choice: cancel it, or hand it to the Leader (and then it gets the triage it never had)", async t => {
  const r = await rig(t);
  const a = await r.session();
  await r.setList([a]);
  const scheduleId = await r.makeSchedule({ overlap: "queue" });
  await r.setPolicy(scheduleId);
  await r.fire(1); await r.dispatchAt(1);
  const first = await r.taskOfOccurrence(scheduleId, 0);
  const entry = (await r.lineOf(a))[0]!;
  assert.equal((await r.refused(r.lead, { type: "line.remove", entryId: entry.entry_id, expectedVersion: 1, reason: "no choice" })).code, "SCHEDULE_CHOICE_REQUIRED", "the plain removal refuses a scheduled entry");
  await r.applied(r.lead, { type: "schedule.directEntry.withdraw", entryId: entry.entry_id, expectedVersion: 1, choice: "to_leader", reason: "I will arrange it" });
  assert.deepEqual((await r.notices(first)).map(row => row.kind), ["task_todo"], "handed to the Leader: it is offered for triage now");
  assert.equal((await r.lineOf(a))[0]!.state, "withdrawn");
  const secondSchedule = await r.makeSchedule();
  await r.setPolicy(secondSchedule);
  await r.fire(1); await r.dispatchAt(1);
  const second = await r.taskOfOccurrence(secondSchedule);
  const entry2 = (await r.lineOf(a)).find(row => row.task_id === second)!;
  await r.applied(r.lead, { type: "schedule.directEntry.withdraw", entryId: entry2.entry_id, expectedVersion: 1, choice: "cancel", reason: "not needed today" });
  assert.equal(((await r.pool.query("SELECT state FROM task WHERE project_id=$1 AND task_id=$2", [r.projectId, second])).rows[0]).state, "cancelled", "cancelled: the Task is closed");
  assert.deepEqual(await r.notices(second), [], "and the Leader is not asked about it");
  assert.equal((await r.refused(r.writer, { type: "schedule.directEntry.withdraw", entryId: entry2.entry_id, expectedVersion: 1, choice: "cancel", reason: "x" })).code, "FORBIDDEN");
});

test("changing the template returns the schedule to the Leader at once; a paused or revoked policy and a used-up daily budget do not dispatch", async t => {
  const r = await rig(t);
  const a = await r.session();
  await r.setList([a]);
  const scheduleId = await r.makeSchedule({ overlap: "queue" });
  await r.setPolicy(scheduleId, { dailyRunBudget: 1 });
  await r.fire(1); await r.dispatchAt(1);
  // The first Task is closed, so the second trigger of the same day is not an overlap: it is the budget that stops it.
  const firstTask = await r.taskOfOccurrence(scheduleId);
  await r.applied(r.lead, { type: "task.cancel", taskId: firstTask, expectedVersion: 1, reason: "closed" });
  await r.fire(2);
  assert.deepEqual((await r.logOf(scheduleId)).map(row => [row.state, row.reason]), [["dispatched", ""], ["skipped", "DAILY_BUDGET"]], "the second trigger of the same day is skipped");
  assert.equal((await r.records("direct_dispatch_skipped")).length, 1, "and recorded");
  // Revise the template: the policy reads "leader" immediately.
  const current = (await r.pool.query("SELECT version FROM schedule_definition WHERE project_id=$1 AND schedule_id=$2", [r.projectId, scheduleId])).rows[0].version;
  await r.applied(r.lead, { type: "schedule.revise", scheduleId, revisionId: randomUUID(), expectedVersion: current, state: "active", timezone: "UTC",
    rule: { kind: "interval", anchorUtc: new Date(r.T0).toISOString(), everyMinutes: 60 }, misfire: { kind: "latest" }, overlap: "queue",
    template: { title: "Changed", content: "# Different", acceptance: "Done", owner: r.role }, authorization: { scopeId: "scope", roleId: r.role, authorizedBy: "lead", expiresAtUtc: null }, reason: "edit template" });
  const policy = (await r.pool.query("SELECT mode, revert_reason FROM schedule_dispatch_policy WHERE project_id=$1 AND schedule_id=$2", [r.projectId, scheduleId])).rows[0];
  assert.deepEqual([policy.mode, policy.revert_reason], ["leader", "TEMPLATE_CHANGED"]);
  await r.fire(26);
  const changed = await r.taskOfOccurrence(scheduleId, 1);
  assert.deepEqual((await r.notices(changed)).map(row => row.kind), ["task_todo"], "the next Task goes to the Leader, with its triage notice");
  // Revoked and paused policies do not dispatch either.
  const other = await r.makeSchedule({ overlap: "queue" });
  await r.setPolicy(other, { state: "revoked" });
  await r.fire(27);
  const revoked = await r.taskOfOccurrence(other);
  assert.deepEqual((await r.notices(revoked)).map(row => row.kind), ["task_todo"], "revoked: to the Leader");
  assert.deepEqual((await r.logOf(other)).map(row => [row.state, row.reason]), [["fell_back", "POLICY_REVOKED"]]);
});

test("no Session can take it: the Task goes to the Leader and the dispatch is reported as blocked at once", async t => {
  const r = await rig(t);
  const a = await r.session();
  await r.setList([a]);
  await r.pool.query("UPDATE runtime_session SET state='closed',version=version+1 WHERE project_id=$1 AND session_id=$2", [r.projectId, a]).catch(() => undefined);
  await r.pool.query("INSERT INTO session_recovery_gate(project_id,session_id,version,phase,updated_at) VALUES($1,$2,1,'blocked',now()) ON CONFLICT (project_id,session_id) DO UPDATE SET phase='blocked'", [r.projectId, a]);
  const scheduleId = await r.makeSchedule();
  await r.setPolicy(scheduleId);
  await r.fire(1);
  const taskId = await r.taskOfOccurrence(scheduleId);
  assert.deepEqual(await r.dispatchAt(1), { dispatched: 0, fellBack: 1 });
  assert.deepEqual((await r.notices(taskId)).map(row => [row.kind, row.level]), [["direct_dispatch_blocked", "immediate"], ["task_todo", "digest"]]);
  assert.deepEqual((await r.logOf(scheduleId)).map(row => [row.state, row.reason]), [["fell_back", "NO_AVAILABLE_SESSION"]]);
});

test("two failed Runs in a row open the breaker; a stopped or completed one does not count; the second skip in a row is escalated; a Task waiting past its limit is reported once", async t => {
  const r = await rig(t);
  const a = await r.session();
  await r.setList([a]);
  const scheduleId = await r.makeSchedule({ overlap: "skip" });
  await r.setPolicy(scheduleId, { waitLimitMinutes: 1 });
  await r.fire(1); await r.dispatchAt(1);
  const first = await r.taskOfOccurrence(scheduleId);
  // The previous occurrence is still open, so the next two triggers skip; the second in a row is told to the Leader.
  await r.fire(2);
  assert.deepEqual((await r.notices(first)).filter(row => row.kind === "schedule_skips_escalated"), [], "one skip is only counted");
  await r.fire(3);
  assert.deepEqual((await r.notices(first)).filter(row => row.kind === "schedule_skips_escalated").map(row => row.level), ["digest"], "two in a row: escalated");
  assert.equal((await r.records("direct_dispatch_skipped")).length, 2);
  // The Task waits in the line past its limit (one minute): reported once.
  await r.dispatchAt(1.5);
  await r.dispatchAt(2);
  assert.equal((await r.notices(first)).filter(row => row.kind === "direct_dispatch_blocked").length, 1, "reported once, not on every pass");
  // The breaker: runEnded events of the dispatched entry.
  const entry = (await r.lineOf(a))[0]!;
  const event = (runState: string, runId: string | null = null) => r.pool.query(`INSERT INTO session_line_event(project_id,session_id,entry_id,task_id,kind,detail,actor_id,at)
    VALUES($1,$2,$3,$4,'entry.runEnded',$5::jsonb,'worker',now())`, [r.projectId, a, entry.entry_id, entry.task_id, JSON.stringify({ runState, runId })]);
  const failures = async () => Number((await r.pool.query("SELECT consecutive_failures AS n FROM schedule_dispatch_policy WHERE project_id=$1 AND schedule_id=$2", [r.projectId, scheduleId])).rows[0].n);
  await event("failed"); assert.equal(await failures(), 1);
  await event("completed"); assert.equal(await failures(), 0, "a completed Run resets the count");
  await event("failed"); await event("interrupted");
  const policy = (await r.pool.query("SELECT mode, state, revert_reason FROM schedule_dispatch_policy WHERE project_id=$1 AND schedule_id=$2", [r.projectId, scheduleId])).rows[0];
  assert.deepEqual([policy.mode, policy.state, policy.revert_reason], ["leader", "circuit_open", "CIRCUIT_OPEN"], "two failures in a row: back to the Leader, breaker open");
  assert.deepEqual((await r.notices(first)).filter(row => row.kind === "direct_circuit_open").map(row => row.level), ["immediate"]);
});

test("direct dispatch decisions need review authority, a Role's own Sessions and a non-empty list", async t => {
  const r = await rig(t);
  const a = await r.session();
  const scheduleId = await r.makeSchedule();
  assert.equal((await r.refused(r.writer, { type: "schedule.directList.set", roleId: r.role, expectedVersion: 0, sessionIds: [a], reason: "x" })).code, "FORBIDDEN");
  assert.equal((await r.refused(r.lead, { type: "schedule.dispatch.set", scheduleId, expectedVersion: 0, mode: "direct", state: "active", reason: "x" })).code, "DIRECT_LIST_EMPTY");
  assert.equal((await r.refused(r.lead, { type: "schedule.directList.set", roleId: r.role, expectedVersion: 0, sessionIds: [randomUUID()], reason: "x" })).code, "NOT_FOUND");
  await r.setList([a]);
  assert.equal((await r.refused(r.lead, { type: "schedule.directList.set", roleId: r.role, expectedVersion: 0, sessionIds: [a], reason: "stale" })).code, "VERSION_CONFLICT");
  await r.setPolicy(scheduleId);
  assert.equal((await r.refused(r.lead, { type: "schedule.dispatch.set", scheduleId, expectedVersion: 0, mode: "leader", state: "active", reason: "stale" })).code, "VERSION_CONFLICT");
});

test("execution authorization is read afresh at every trigger: a Session without it is passed over, none left means the Leader gets the Task with the reason, and a withdrawn grant is honoured at the next trigger", async t => {
  const r = await rig(t);
  const a = await r.session("/tmp/direct-a"), b = await r.session("/tmp/direct-b");
  await r.setList([a, b]);
  r.config.allGranted = false;
  // Only B's working directory has a runtime grant: A (first on the list, idle) is passed over for B.
  r.config.granted = new Set(["/tmp/direct-b"]);
  const first = await r.makeSchedule(); await r.setPolicy(first);
  const readsBefore = r.config.reads;
  await r.fire(1); await r.dispatchAt(1);
  assert.deepEqual((await r.logOf(first)).map(row => [row.state, row.session_id]), [["dispatched", b]], "an unauthorized Session is never sent work");
  assert.ok(r.config.reads > readsBefore, "the configuration was read at this trigger");
  // The grant of B is withdrawn: the next trigger finds nobody authorized; the Task goes to the Leader and the notice says why.
  r.config.granted = new Set();
  const second = await r.makeSchedule(); await r.setPolicy(second);
  await r.fire(1); const before = r.config.reads;
  assert.deepEqual(await r.dispatchAt(1), { dispatched: 0, fellBack: 1 });
  assert.ok(r.config.reads > before, "read again, not remembered from the last trigger");
  const taskId = await r.taskOfOccurrence(second);
  assert.deepEqual((await r.notices(taskId)).map(row => [row.kind, row.level]), [["direct_dispatch_blocked", "immediate"], ["task_todo", "digest"]]);
  assert.deepEqual((await r.logOf(second)).map(row => [row.state, row.reason]), [["fell_back", "NOT_AUTHORIZED:NO_EXECUTION_GRANT"]]);
  const notice = (await r.pool.query("SELECT source_ref FROM leader_result_notice WHERE project_id=$1 AND task_id=$2 AND kind='direct_dispatch_blocked'", [r.projectId, taskId])).rows[0];
  assert.match(notice.source_ref, /NOT_AUTHORIZED:NO_EXECUTION_GRANT/, "the reason is on the notice the Leader reads");
  // Runtime switched off altogether: the same.
  r.config.allGranted = true; r.config.enabled = false;
  const third = await r.makeSchedule(); await r.setPolicy(third);
  await r.fire(1); await r.dispatchAt(1);
  assert.deepEqual((await r.logOf(third)).map(row => row.reason), ["NOT_AUTHORIZED:RUNTIME_NOT_ENABLED"]);
});
