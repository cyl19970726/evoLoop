// Refuses a live or shared PostgreSQL server before this file opens TEST_DATABASE_URL (scripts/lib/database-target.mjs).
import "../../scripts/test-database-guard.mjs";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";
import { migrate, PostgresUnitOfWork } from "@evoloop/adapter-postgres";
import { headSeq, readSchedEvents, readWorkBoard } from "@evoloop/adapter-postgres/work-board";
import { RuntimeWorkflowService, WorkflowService } from "@evoloop/core";
import { noticeLevelOf, type LeaderNoticeKind } from "@evoloop/contracts/leader-notices";
import type { Principal } from "@evoloop/contracts";
import { buildServer } from "../../apps/coordinator/src/server.js";
import { SchedEventHub } from "../../apps/coordinator/src/work-board/hub.js";
import { createReserveRecipientCheck } from "../../apps/coordinator/src/runtime/recipient-preflight.js";
import { SessionObservationService } from "@evoloop/core/session-observation";
import { createSessionUsability } from "../../apps/coordinator/src/runtime/session-usability.js";
import { SessionAttentionPump, pgSessionAttentionStore } from "../../apps/coordinator/src/session-attention/pump.js";
import { PreflightError, safePreflightReport } from "../../apps/coordinator/src/runtime/preflight-report.js";

const url = process.env.TEST_DATABASE_URL;
if (!url || !/^\/evoloop(?:_[a-z0-9]+)*_test$/.test(new URL(url).pathname)) throw new Error("A dedicated evoloop_*_test database is required");

/**
 * Task 6612e287: a Session that cannot start work (no business identity, no native thread) used to show "ready", and every Run sent to it failed
 * before the model started. Real database, real WorkflowService / RuntimeWorkflowService, the real HTTP routes; only the private configuration is a value.
 */
test("a Session without a business identity or native thread is unusable and says why, a Run cannot be reserved on it, a fixed condition makes it usable, and the same cause three times raises one notice", async t => {
  const schema = `unusable_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  await migrate(url!, schema);
  const pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}` });
  t.after(async () => { await pool.end(); const admin = new pg.Client({ connectionString: url }); await admin.connect(); try { await admin.query(`DROP SCHEMA "${schema}" CASCADE`); } finally { await admin.end(); } });
  const uow = new PostgresUnitOfWork(pool);
  const hash = (text: string) => createHash("sha256").update(text).digest("hex");
  const deps = { uow, clock: { now: () => new Date().toISOString() }, ids: { next: randomUUID }, hasher: { hash } };
  const workflow = new WorkflowService(deps), runtime = new RuntimeWorkflowService(deps);
  const projectId = randomUUID(), token = randomUUID() + randomUUID();
  const lead: Principal = { actorId: "lead", projectIds: [projectId], permissions: ["read", "write", "review"] };
  const apply = async (command: Record<string, unknown>) => { const r = await workflow.execute(lead, { projectId, operationId: randomUUID(), ...command } as never); assert.equal(r.status, "applied", JSON.stringify(r)); return r; };
  await apply({ type: "project.create", title: "Unusable sessions" });
  const roleId = randomUUID(), revId = randomUUID();
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query(`INSERT INTO role_definition(project_id,role_id,version,current_revision_id,state,proposed_by,created_at_utc,review_at_utc,trial_started_at_utc) VALUES($1,$2,1,$3,'trial','lead',now(),now()+interval '1 day',now())`, [projectId, roleId, revId]);
    await c.query(`INSERT INTO role_revision(project_id,role_id,revision_id,version,state,proposal,actor_id,reason,created_at_utc,review_at_utc) VALUES($1,$2,$3,1,'trial','{}'::jsonb,'lead','trial',now(),now()+interval '1 day')`, [projectId, roleId, revId]);
    await c.query("COMMIT");
  } finally { c.release(); }
  const makeSession = async () => {
    const sessionId = randomUUID();
    await apply({ type: "runtime.session.reserve", sessionId, roleId, cwd: "/tmp/unusable", authorizationScope: "project", sandbox: "danger-full-access", approvalPolicy: "never" });
    await runtime.beginSessionCreate(projectId, sessionId);
    const saved = (await uow.read(projectId, r => r.getRuntimeSession(sessionId)))!;
    await runtime.bindSession(projectId, sessionId, { owner: "evoloop-codex-app-server", projectId, sessionId, roleId, cwd: "/tmp/unusable", authorizationScope: "project", nativeThreadId: `thread-${sessionId}`, nativeSessionId: `native-${sessionId}`,
      resumeProfile: { actorId: saved.actorId, model: saved.model, sandbox: saved.sandbox, approvalPolicy: saved.approvalPolicy, executionProfileRevisionId: saved.executionProfile!.revision.revisionId } });
    return sessionId;
  };
  // Two live Sessions of one Role: a Role's actor can no longer stand for either of them, each needs its own materialCli entry.
  const bound = await makeSession(), unbound = await makeSession();
  const callerActor = (await uow.read(projectId, r => r.getRuntimeSession(bound)))!.actorId;
  type Cfg = { materialCli: Array<{ projectId: string; sessionId?: string; roleId?: string; sessionActorId: string; cliActorId: string }>; roleActors: Array<{ projectId: string; roleId: string; actorId: string }> };
  let config: Cfg = { materialCli: [{ projectId, sessionId: bound, sessionActorId: callerActor, cliActorId: "worker" }], roleActors: [{ projectId, roleId, actorId: "worker" }] };
  let writers = ["worker", "late-worker"];
  const usability = createSessionUsability({ query: (sql, params) => pool.query(sql, params as never[]) as never, config: async () => config, projectWriter: async (_p, a) => writers.includes(a) });
  // The judgement the coordinator uses everywhere; the test can make it fail or say nothing to see that every reader fails closed.
  let judgeMode: "real" | "throws" | "empty" = "real";
  const judge: typeof usability = async (projectId, ids) => { if (judgeMode === "throws") throw new Error("integrations file unreadable"); return judgeMode === "empty" ? new Map() : usability(projectId, ids); };
  const reads = { board: (id: string) => readWorkBoard(pool, id), events: (id: string, q: Parameters<typeof readSchedEvents>[2]) => readSchedEvents(pool, id, q) };
  const hub = new SchedEventHub({ head: id => headSeq(pool, id), read: (id, after, limit) => readSchedEvents(pool, id, { after, limit }) }, 500);
  const app = await buildServer({ service: workflow, credentials: [{ token, actorId: "lead", projectIds: [projectId], permissions: ["read", "write", "review"] }],
    runtime: { status: () => ({ available: true, error: null, faults: [] }) } as never, listRuntimeModels: async () => ({ status: "available", models: [], error: null, observedAtUtc: new Date().toISOString() }),
    hasRuntimeGrant: () => true, workBoard: { reads, hub, usability: judge }, sessionWork: new SessionObservationService({ uow }), sessionUsability: judge,
    requireRunRecipient: createReserveRecipientCheck({ uow, loadIntegrations: async () => ({ runtime: { enabled: true, materialCli: config.materialCli as never } }), usability: judge,
      recordRefusal: async (project, session, task, cause) => { await pool.query("SELECT record_session_start_refusal($1,$2,$3,$4)", [project, session, task, cause]); } }) } as never);
  t.after(() => app.close());
  const headers = { authorization: `Bearer ${token}` };
  const board = async (brief = false) => (await app.inject({ url: `/api/projects/${projectId}/work-board${brief ? "?brief=true" : ""}`, headers })).json() as { sessions: Array<any>; graph?: { counts: Record<string, number> } } & { counts?: Record<string, number> };
  const newTask = async (acceptance: boolean) => {
    const taskId = randomUUID();
    await apply({ type: "task.create", taskId, title: acceptance ? "Needs a signer" : "Plain", content: "# T", acceptance: "Done", owner: roleId,
      ...(acceptance ? { consumer: "named-human", useRequired: true, acceptanceMode: "human_required", acceptanceTarget: "human" } : {}) });
    await apply({ type: "task.start", taskId, expectedVersion: 1, reason: "start" });
    return taskId;
  };
  const reserve = async (taskId: string, sessionId: string) => {
    const task = (await uow.read(projectId, r => r.getTask(taskId)))!;
    const response = await app.inject({ method: "POST", url: "/api/commands", headers, payload: { type: "runtime.run.reserve", projectId, operationId: randomUUID(), runId: randomUUID(), taskId, sessionId, expectedVersion: task.version, input: "go" } });
    return { status: response.statusCode, body: response.body };
  };
  const worker: Principal = { actorId: "worker", projectIds: [projectId], permissions: ["read", "write"] };
  /** The normal dispatch path: the Task is assigned to the Session with the signer named, and the Session confirms; only the reservation is left. */
  const assign = async (taskId: string, sessionId: string) => {
    const task = (await uow.read(projectId, r => r.getTask(taskId)))!;
    await apply({ type: "task.assignment.set", taskId, expectedTaskVersion: task.version, target: { kind: "owned", sessionId }, recipientActorId: "worker", expectedVersion: 0, reason: "dispatch" });
    const assignment = (await workflow.getTaskAssignment(lead, projectId, taskId))!;
    const r = await workflow.execute(worker, { projectId, operationId: randomUUID(), type: "task.assignment.acknowledge", taskId, expectedVersion: assignment.version, expectedTaskVersion: task.version,
      evidence: "read", verdict: "confirm", plan: "do it", expectedRevisionId: task.currentRevisionId } as never);
    assert.equal(r.status, "applied", JSON.stringify(r));
  };
  const runs = async () => Number((await pool.query("SELECT count(*)::int n FROM runtime_run WHERE project_id=$1", [projectId])).rows[0].n);

  // 1. The unusable Session says so on the board (full and brief) and is not in the usable set; the bound one is untouched.
  const full = await board();
  const byId = (b: typeof full, id: string) => b.sessions.find(s => s.sessionId === id)!;
  assert.equal(byId(full, bound).usable, true, "a bound Session is usable"); assert.equal(byId(full, bound).unusable, undefined);
  assert.equal(byId(full, unbound).usable, false); assert.equal(byId(full, unbound).state, "ready", "the stored state is unchanged; the board adds the judgement");
  assert.equal(byId(full, unbound).unusable[0].code, "BUSINESS_IDENTITY_UNBOUND"); assert.match(byId(full, unbound).unusable[0].reason, /没有绑定业务身份/);
  assert.equal(full.graph!.counts.unusableSessions, 1);
  const brief = await board(true);
  assert.equal(brief.sessions.find(s => s.id === unbound)!.unusable[0].code, "BUSINESS_IDENTITY_UNBOUND", "the Leader's brief carries the reason");
  assert.equal(brief.sessions.find(s => s.id === bound)!.unusable, undefined);

  // 2. A Run cannot be reserved on it, for any Task: refused at the reservation, no Run row. 
  const needsSigner = await newTask(true), plain = await newTask(false);
  await assign(needsSigner, unbound);
  const before = await runs();
  const refused = await reserve(needsSigner, unbound);
  assert.notEqual(refused.status, 200, refused.body); assert.match(refused.body, /SESSION_UNUSABLE/); assert.match(refused.body, /未创建 Run/); assert.match(refused.body, /没有绑定业务身份/);
  assert.equal(await runs(), before, "no Run was created by the refused reservation");

  // 3. A Session that is not ready (reserved, its native thread never bound) is unusable for every Task. A missing thread record is covered by the unit test:
  // once bound, the thread ID is immutable in the database, so it cannot be removed from a ready Session here.
  const notReady = randomUUID();
  await apply({ type: "runtime.session.reserve", sessionId: notReady, roleId, cwd: "/tmp/unusable", authorizationScope: "project", sandbox: "danger-full-access", approvalPolicy: "never" });
  config = { ...config, materialCli: [...config.materialCli, { projectId, sessionId: notReady, sessionActorId: callerActor, cliActorId: "worker" }] };
  const notReadyBoard = byId(await board(), notReady);
  assert.notEqual(notReadyBoard.state, "ready"); assert.equal(notReadyBoard.usable, false); assert.equal(notReadyBoard.unusable[0].code, "SESSION_NOT_READY");
  const beforeNotReady = await runs();
  const notReadyRefusal = await reserve(plain, notReady);
  assert.notEqual(notReadyRefusal.status, 200, notReadyRefusal.body); assert.equal(await runs(), beforeNotReady, "no Run was created");

  // 4. An identity that is not a project writer is not usable either; once it is, the Session is.
  config = { ...config, materialCli: [...config.materialCli, { projectId, sessionId: unbound, sessionActorId: callerActor, cliActorId: "late-worker" }] };
  writers = ["worker"];
  assert.equal(byId(await board(), unbound).unusable[0].code, "BUSINESS_IDENTITY_NOT_WRITER");
  // The identity is fixed to a project writer (the one the Task was dispatched to).
  config = { ...config, materialCli: config.materialCli.map(e => e.sessionId === unbound ? { ...e, cliActorId: "worker" } : e) };

  // 5. Recovery: with the identity bound (and a writer), the same Session is usable and the reservation is no longer refused for it.
  assert.equal(byId(await board(), unbound).usable, true);
  const afterBoard = await board();
  assert.deepEqual(afterBoard.sessions.filter(x => x.usable === false).map(x => x.sessionId), [notReady], "only the Session that is still not ready is unusable"); assert.equal(afterBoard.graph!.counts.unusableSessions, 1);
  const runsBefore = await runs();
  const afterFix = await reserve(needsSigner, unbound);
  assert.equal(afterFix.status, 200, afterFix.body); assert.equal(await runs(), runsBefore + 1, "the Run was reserved normally once the Session could start it");

  // 6. The same cause in a row: one notice at the third, none at the fourth and fifth, a new streak after a completed Run; one failure is not a streak.
  const failInPreflight = async (sessionId: string, code: "RECIPIENT_UNBOUND" | "CLI_ENTRY_UNAVAILABLE") => {
    const taskId = await newTask(false), runId = randomUUID();
    await apply({ type: "runtime.run.reserve", runId, taskId, sessionId, expectedVersion: (await uow.read(projectId, r => r.getTask(taskId)))!.version, input: "go" });
    await runtime.rejectDispatch(projectId, runId, safePreflightReport(new PreflightError(code, { kind: "task", id: taskId, revisionId: randomUUID() })).summary);
    await new Promise(done => setTimeout(done, 15)); // terminal Runs are ordered by time
  };
  const notices = async (sessionId: string) => (await pool.query(`SELECT kind, level, source_ref FROM leader_result_notice WHERE project_id=$1 AND source_session_id=$2 AND kind='session_repeated_failure' ORDER BY occurred_at`, [projectId, sessionId])).rows;
  const flaky = await makeSession();
  config = { ...config, materialCli: [...config.materialCli, { projectId, sessionId: flaky, sessionActorId: callerActor, cliActorId: "worker" }] };
  await failInPreflight(flaky, "RECIPIENT_UNBOUND");
  assert.equal(byId(await board(), flaky).usable, true, "one failed start does not make a bound Session unusable: usability is the Session's facts, not its failure history");
  await failInPreflight(flaky, "RECIPIENT_UNBOUND");
  assert.deepEqual(await notices(flaky), [], "two in a row raise nothing");
  await failInPreflight(flaky, "RECIPIENT_UNBOUND");
  const third = await notices(flaky);
  assert.equal(third.length, 1, "the third in a row raises exactly one notice"); assert.equal(third[0].level, noticeLevelOf("session_repeated_failure" as LeaderNoticeKind));
  assert.equal(noticeLevelOf("session_repeated_failure" as LeaderNoticeKind), "immediate");
  await failInPreflight(flaky, "RECIPIENT_UNBOUND"); await failInPreflight(flaky, "RECIPIENT_UNBOUND");
  assert.equal((await notices(flaky)).length, 1, "a longer streak does not repeat the notice");
  // Another cause breaks the streak; a completed Run does too.
  const mixed = await makeSession();
  await failInPreflight(mixed, "RECIPIENT_UNBOUND"); await failInPreflight(mixed, "CLI_ENTRY_UNAVAILABLE"); await failInPreflight(mixed, "RECIPIENT_UNBOUND");
  assert.deepEqual(await notices(mixed), [], "different causes are not the same cause three times");
  const reset = await makeSession();
  await failInPreflight(reset, "RECIPIENT_UNBOUND"); await failInPreflight(reset, "RECIPIENT_UNBOUND");
  const okTask = await newTask(false), okRun = randomUUID();
  await apply({ type: "runtime.run.reserve", runId: okRun, taskId: okTask, sessionId: reset, expectedVersion: (await uow.read(projectId, r => r.getTask(okTask)))!.version, input: "go" });
  await runtime.beginDispatch(projectId, okRun);
  const stored = (await uow.read(projectId, r => r.getRuntimeRun(okRun)))!;
  await runtime.bindTurn(projectId, okRun, { id: `turn-${okRun}` }, { kind: "startReply", operationId: stored.operationId });
  await runtime.recordTurn(projectId, okRun, `turn-${okRun}`, "completed", "done", { completedAtUtc: new Date().toISOString() });
  await new Promise(done => setTimeout(done, 15));
  await failInPreflight(reset, "RECIPIENT_UNBOUND");
  assert.deepEqual(await notices(reset), [], "a completed Run in between starts the count again");

  // ---- Rework (Task 6612e287, acceptance 0eba1d14) ----
  // 7. Every reader says the same: `list sessions`, the Session directory and snapshot, the work board. Bound and usable stay usable.
  const stuck = await makeSession();   // two live Sessions of the Role already: this one has no entry of its own (config has no entry for it)
  const get = async (path: string) => (await app.inject({ url: `/api/projects/${projectId}${path}`, headers })).json() as any;
  const listed = (await get("/runtime/sessions")) as Array<{ id: string; state: string; usable?: boolean; unusable?: Array<{ code: string }> }>;
  const of = (id: string) => listed.find(x => x.id === id)!;
  assert.equal(of(stuck).state, "ready", "the stored lifecycle is unchanged"); assert.equal(of(stuck).usable, false, "list sessions: unusable"); assert.equal(of(stuck).unusable![0]!.code, "BUSINESS_IDENTITY_UNBOUND");
  assert.equal(of(flaky).usable, true, "list sessions: a bound Session is usable");
  const directory = (await get("/session-work?membership=all&limit=50")) as { items: Array<{ key: string; dispatch?: { usable: boolean; reasons: Array<{ code: string }> } }> };
  const dir = (id: string) => directory.items.find(x => x.key === `owned:${id}`)!;
  assert.deepEqual([dir(stuck).dispatch?.usable, dir(stuck).dispatch?.reasons[0]?.code], [false, "BUSINESS_IDENTITY_UNBOUND"], "the Session directory carries the judgement");
  assert.equal(dir(flaky).dispatch?.usable, true);
  const snapshot = await get(`/session-work/${encodeURIComponent(`owned:${stuck}`)}`);
  assert.deepEqual([snapshot.session.dispatch.usable, snapshot.session.dispatch.reasons[0].code], [false, "BUSINESS_IDENTITY_UNBOUND"], "the Session snapshot carries it too");
  assert.equal(byId(await board(), stuck).usable, false, "the work board agrees");

  // 8. FAIL CLOSED: a judgement that throws, or says nothing, makes every reader and the reservation say so instead of letting the Session through.
  for (const mode of ["throws", "empty"] as const) {
    judgeMode = mode;
    const unknown = (await board()).sessions.every(x => x.usable === false && x.unusable[0].code === "USABILITY_UNKNOWN");
    assert.ok(unknown, `${mode}: the board marks every Session unusable (USABILITY_UNKNOWN), not as before`);
    assert.ok(((await get("/runtime/sessions")) as Array<{ usable?: boolean; unusable?: Array<{ code: string }> }>).every(x => x.usable === false && x.unusable![0]!.code === "USABILITY_UNKNOWN"), `${mode}: list sessions`);
    assert.ok((await get("/session-work?membership=all&limit=50")).items.every((x: any) => x.dispatch.usable === false && x.dispatch.reasons[0].code === "USABILITY_UNKNOWN"), `${mode}: directory`);
    const before = await runs(), task = await newTask(true);
    const refusal = await reserve(task, flaky);
    assert.notEqual(refusal.status, 200, refusal.body); assert.match(refusal.body, /SESSION_USABILITY_UNKNOWN/); assert.match(refusal.body, /未创建 Run/);
    assert.equal(await runs(), before, `${mode}: no Run was created`);
  }
  judgeMode = "real";
  assert.equal(byId(await board(), flaky).usable, true, "the judgement is back: the bound Session is usable again");

  // 9. Refusals count like failed starts: three in a row with one cause raise ONE attention item and ONE Leader notice, none more at the fourth and fifth;
  //    a failed start and refusals of the same cause are one streak; another cause starts again.
  const attention = async (sessionId: string) => (await pool.query("SELECT attention_id, cause FROM session_attention WHERE project_id=$1 AND session_id=$2 ORDER BY created_at", [projectId, sessionId])).rows;
  const events = async (sessionId: string) => (await pool.query("SELECT cause, source FROM session_start_event WHERE project_id=$1 AND session_id=$2 ORDER BY seq", [projectId, sessionId])).rows.map(r => `${r.source}:${r.cause}`);
  for (let i = 0; i < 2; i++) assert.equal((await reserve(await newTask(false), stuck)).status !== 200, true);
  assert.deepEqual(await attention(stuck), [], "two refusals are not yet an item");
  assert.equal((await reserve(await newTask(true), stuck)).status !== 200, true);
  const item = await attention(stuck);
  assert.equal(item.length, 1, "the third refusal in a row raises exactly one item"); assert.equal(item[0].cause, "BUSINESS_IDENTITY_UNBOUND");
  assert.equal((await notices(stuck)).length, 1, "and one Leader notice");
  for (let i = 0; i < 2; i++) await reserve(await newTask(false), stuck);
  assert.equal((await attention(stuck)).length, 1); assert.equal((await notices(stuck)).length, 1, "the fourth and fifth refusals add nothing");
  assert.deepEqual((await events(stuck)).slice(0, 3), Array(3).fill("refusal:BUSINESS_IDENTITY_UNBOUND"));
  // A failed start (the preflight said RECIPIENT_UNBOUND) and refusals are the same cause: one failed start + two refusals make the third.
  const mixedCause = await makeSession();
  await failInPreflight(mixedCause, "RECIPIENT_UNBOUND");
  for (let i = 0; i < 2; i++) await reserve(await newTask(false), mixedCause);
  assert.equal((await attention(mixedCause)).length, 1, `a failed start and two refusals of the same cause: ${(await events(mixedCause)).join(",")}`);
  // Another cause in between: not the same cause three times.
  const otherCause = await makeSession();
  await reserve(await newTask(false), otherCause); await reserve(await newTask(false), otherCause);
  config = { ...config, materialCli: [...config.materialCli, { projectId, sessionId: otherCause, sessionActorId: callerActor, cliActorId: "late-worker" }] }; writers = ["worker"];
  await reserve(await newTask(false), otherCause);   // now NOT_WRITER
  assert.deepEqual(await attention(otherCause), [], "UNBOUND, UNBOUND, NOT_WRITER is not one cause three times");
  writers = ["worker", "late-worker"];

  // 10. The item reaches the requirements Session(s): one message each, once; a failing post is kept and retried; nothing to tell is not a crash.
  const requirementsA = await makeSession(), requirementsB = await makeSession();
  const posts: Array<{ to: string; content: string; messageId: string }> = []; let failB = true;
  const pump = new SessionAttentionPump({ store: pgSessionAttentionStore(pool as never), canWrite: () => true, requirementsSessions: async () => [requirementsA, requirementsB],
    post: async (_p, to, content, messageId) => { if (to === requirementsB && failB) return { ok: false, reason: "MESSAGE_POST_REJECTED:FORBIDDEN" }; posts.push({ to, content, messageId }); return { ok: true }; } });
  await pump.tick();
  const mine = posts.filter(x => x.content.includes(item[0].attention_id));
  assert.deepEqual(mine.map(x => x.to), [requirementsA], "A got it; B's post failed");
  assert.match(mine[0]!.content, /BUSINESS_IDENTITY_UNBOUND/); assert.match(mine[0]!.content, new RegExp(stuck));
  const delivery = (to: string, id = item[0].attention_id) => pool.query("SELECT state, reason FROM session_attention_delivery WHERE project_id=$1 AND attention_id=$2 AND recipient_session_id=$3", [projectId, id, to]).then(r => r.rows[0]);
  assert.deepEqual([(await delivery(requirementsA)).state, (await delivery(requirementsB)).state], ["posted", "blocked"]); assert.match((await delivery(requirementsB)).reason, /FORBIDDEN/, "the reason is kept");
  failB = false; await pump.tick(); await pump.tick();
  const all = posts.filter(x => x.content.includes(item[0].attention_id));
  assert.deepEqual(all.map(x => x.to).sort(), [requirementsA, requirementsB].sort(), "each requirements Session got exactly one message; the retry reached B, A was not told again");
  assert.equal(new Set(all.map(x => x.messageId)).size, 2);
  const none = new SessionAttentionPump({ store: pgSessionAttentionStore(pool as never), canWrite: () => true, requirementsSessions: async () => [], post: async () => { throw new Error("must not post"); } });
  await assert.doesNotReject(none.tick(), "no requirements Session to tell: nothing posted, no crash");
});
