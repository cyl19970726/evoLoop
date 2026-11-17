/**
 * 实测（Task b6afe4a5）：Leader 停摆时，由需求 Session 一类的非 Leader 身份把已就绪的 Task 派给 Claude Session，这条路通不通。
 * 自建隔离实例：一次性 PostgreSQL、真实 WorkflowService / RuntimeWorkflowService / SessionLinePump / AcceptanceRelayService / SessionMessageService、真实协调服务（buildServer，
 * 含调度板）、**真实的 CLI 进程**（apps/cli/dist/main.js）。派活者用的是一个有读、写、审阅权限但不是 Leader 的身份（standin）；Leader 的身份只在最后“恢复”一步出场。
 * 替身（没有原生运行时）：Run 的原生步骤（开始派发、绑定 Turn、记录终态）由本脚本按 runner 的顺序直接调服务；交付行直接写入；验收者 Session 的消息处理与已读回执没有走。
 *   /tmp/nt/pgrun.sh 'node --import tsx tests/manual/leader-down-dispatch.ts' > transcript.log
 */
// Refuses a live or shared PostgreSQL server before this file opens TEST_DATABASE_URL (scripts/lib/database-target.mjs).
import "../../scripts/test-database-guard.mjs";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import pg from "pg";
import { migrate, PostgresUnitOfWork } from "@evoloop/adapter-postgres";
import { headSeq, readSchedEvents, readWorkBoard } from "@evoloop/adapter-postgres/work-board";
import { RuntimeWorkflowService, WorkflowService } from "@evoloop/core";
import { SessionMessageService } from "@evoloop/core/session-messages";
import { SessionObservationService } from "@evoloop/core/session-observation";
import type { Principal } from "@evoloop/contracts";
import { buildServer } from "../../apps/coordinator/src/server.js";
import { SchedEventHub } from "../../apps/coordinator/src/work-board/hub.js";
import { SessionLinePump } from "../../apps/coordinator/src/session-line/pump.js";
import { AcceptanceRelayService } from "../../apps/coordinator/src/acceptance-relay/service.js";

const url = process.env.TEST_DATABASE_URL;
if (!url || !/^\/evoloop(?:_[a-z0-9]+)*_test$/.test(new URL(url).pathname)) throw new Error("A dedicated evoloop_*_test database is required");
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const schema = `leaderdown_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
await migrate(url, schema);
const pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}` });
const uow = new PostgresUnitOfWork(pool);
const deps = { uow, clock: { now: () => new Date().toISOString() }, ids: { next: randomUUID }, hasher: { hash }, runtimeProviders: ["codex", "claude"] as const };
const workflow = new WorkflowService(deps), runtime = new RuntimeWorkflowService(deps);
const projectId = randomUUID();
const operator: Principal = { actorId: "instance-builder", projectIds: [projectId], permissions: ["task", "document", "session", "management"], decisions: true };
// The permission model on current main: task / document / session / management (+ decisions) replace read / write / review. A "reviewer" is management plus decisions; a plain writer has task, document, session.
const full = ["task", "document", "session", "management"] as const, plain = ["task", "document", "session"] as const;
const identities = {
  standin: { actorId: "standin-requirements", permissions: full, decisions: true, token: randomUUID() + randomUUID() },   // NOT the Leader
  leader: { actorId: "leader-actor", permissions: full, decisions: true, token: randomUUID() + randomUUID() },
  worker: { actorId: "claude-dev-worker", permissions: plain, token: randomUUID() + randomUUID() },
  acceptor: { actorId: "acceptor-agent", permissions: plain, token: randomUUID() + randomUUID() },
};
const principal = (who: keyof typeof identities): Principal => ({ actorId: identities[who].actorId, projectIds: [projectId], permissions: [...identities[who].permissions], ...((identities[who] as any).decisions ? { decisions: true } : {}) });
const apply = async (command: Record<string, unknown>, who: Principal = operator) => { const r = await workflow.execute(who, { projectId, operationId: randomUUID(), ...command } as never); assert.equal(r.status, "applied", JSON.stringify(r)); return r; };
await apply({ type: "project.create", title: "Leader down" });

// ---- roles and Sessions: the Leader is a Codex Session; the developer and the acceptor are Claude Sessions ----
async function role(title: string, templateKey: string | null, provider: "codex" | "claude") {
  const id = randomUUID(), rev = randomUUID(), c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query(`INSERT INTO role_definition(project_id,role_id,version,current_revision_id,state,proposed_by,created_at_utc,review_at_utc,trial_started_at_utc) VALUES($1,$2,1,$3,'trial','x',now(),now()+interval '1 day',now())`, [projectId, id, rev]);
    await c.query(`INSERT INTO role_revision(project_id,role_id,revision_id,version,state,proposal,actor_id,reason,created_at_utc,review_at_utc) VALUES($1,$2,$3,1,'trial',$4::jsonb,'x','trial',now(),now()+interval '1 day')`, [projectId, id, rev, JSON.stringify({ title, ...(templateKey ? { templateKey } : {}) })]);
    await c.query("COMMIT");
  } finally { c.release(); }
  await apply({ type: "role.runtime.set", roleId: id, expectedRevision: 0, provider, skills: { project: false, personal: false, builtin: false, add: [], remove: [] }, reason: `${provider} for this Role` });
  return id;
}
async function session(roleId: string, provider: "codex" | "claude") {
  const sessionId = randomUUID();
  await apply({ type: "runtime.session.reserve", sessionId, roleId, cwd: "/tmp/ld", authorizationScope: "project", sandbox: "danger-full-access", approvalPolicy: "never" });
  await runtime.beginSessionCreate(projectId, sessionId);
  const saved = (await uow.read(projectId, r => r.getRuntimeSession(sessionId)))!;
  await runtime.bindSession(projectId, sessionId, { owner: provider === "claude" ? "evoloop-claude-agent-sdk" : "evoloop-codex-app-server", projectId, sessionId, roleId, cwd: "/tmp/ld", authorizationScope: "project", nativeThreadId: `thread-${sessionId}`, nativeSessionId: `native-${sessionId}`,
    resumeProfile: { actorId: saved.actorId, model: saved.model, sandbox: saved.sandbox, approvalPolicy: saved.approvalPolicy, executionProfileRevisionId: saved.executionProfile!.revision.revisionId } });
  const roleVersion = Number((await pool.query("SELECT version FROM role_definition WHERE project_id=$1 AND role_id=$2", [projectId, roleId])).rows[0].version);
  await apply({ type: "role.bindSession", roleId, expectedVersion: roleVersion, sessionId, note: "bound" });
  const row = (await pool.query("SELECT runtime_provider FROM runtime_session WHERE project_id=$1 AND session_id=$2", [projectId, sessionId])).rows[0];
  assert.equal(row.runtime_provider, provider, `the ${provider} Session has provider ${row.runtime_provider}`);
  return sessionId;
}
const roles = { lead: await role("项目 Leader", "lead", "codex"), dev: await role("功能开发（Claude）", null, "claude"), acc: await role("验收（Claude）", null, "claude") };
const S = { leader: await session(roles.lead, "codex"), dev: await session(roles.dev, "claude"), dev2: await session(roles.dev, "claude"), acc: await session(roles.acc, "claude") };

// ---- the coordinator: real HTTP server; real session line pump with the NON-Leader credentials only ----
const messages = new SessionMessageService({ uow, clock: { now: () => new Date().toISOString() }, ids: { next: randomUUID }, grantFor: async () => null });
const relay = new AcceptanceRelayService({ pool, workflow, messages, principals: async () => [principal("standin")], canWrite: () => true, leaderSession: async () => S.leader, qualify: async () => null, capabilities: async () => [] });
const reads = { board: (id: string) => readWorkBoard(pool, id), events: (id: string, q: Parameters<typeof readSchedEvents>[2]) => readSchedEvents(pool, id, q) };
const hub = new SchedEventHub({ head: id => headSeq(pool, id), read: (id, after, limit) => readSchedEvents(pool, id, { after, limit }) }, 500);
const app = await buildServer({ service: workflow, acceptanceRelay: relay, sessionWork: new SessionObservationService({ uow }), workBoard: { reads, hub },
  // The execution service answers (a stand-in for the native runtime): without it `runtime.run.reserve` stops at RUNTIME_UNAVAILABLE before the Task guard is ever reached.
  runtime: { status: () => ({ available: true, error: null, faults: [] }) }, listRuntimeModels: async () => ({ status: "available", models: [], error: null, observedAtUtc: new Date().toISOString() }), hasRuntimeGrant: () => true,
  credentials: Object.values(identities).map(i => ({ token: i.token, actorId: i.actorId, projectIds: [projectId], permissions: [...i.permissions], ...((i as any).decisions ? { decisions: true } : {}) })) } as never);
const apiUrl = await app.listen({ host: "127.0.0.1", port: 0 });
const pump = new SessionLinePump({ workflow, credentials: async () => [principal("standin"), principal("worker")], enabled: async () => true, canWrite: () => true, pollIntervalMs: 1000,
  onError: error => { throw error; }, recipientActorId: async () => identities.worker.actorId, retryBackoffMs: () => 0 });
const settle = async () => { for (let i = 0; i < 4; i++) await pump.tick(); };

// ---- the transcript ----
const directory = await mkdtemp(join(tmpdir(), "ld-"));
const log = (text: string) => console.log(text);
async function cli(who: keyof typeof identities, args: string[], expect: number | "any" = 0): Promise<any> {
  const out = await new Promise<{ code: number | null; stdout: string; stderr: string }>((done, reject) => {
    const child = spawn(process.execPath, [resolve("apps/cli/dist/main.js"), ...args], { stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, EVOLOOP_API_URL: apiUrl, EVOLOOP_TOKEN: identities[who].token, EVOLOOP_PROJECT: projectId, EVOLOOP_STATE_DIR: join(directory, `s-${who}`) } });
    let stdout = "", stderr = ""; child.stdout.on("data", c => { stdout += String(c); }); child.stderr.on("data", c => { stderr += String(c); });
    child.once("error", reject); child.once("close", code => done({ code, stdout, stderr }));
  });
  const text = (out.stdout.trim() || out.stderr.trim().split("\n").at(-1) || "{}").split("\n").at(-1)!;
  if (expect !== "any") assert.equal(out.code, expect, `CLI ${args.join(" ")} exited ${out.code}: ${out.stderr}${out.stdout}`);
  let parsed: any; try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
  log(`$ [${identities[who].actorId}] evoloop ${args.map(a => a.startsWith("/tmp") ? "<file>" : a).join(" ").slice(0, 200)}  → exit ${out.code}\n  ${JSON.stringify(parsed).slice(0, 420)}`);
  return parsed;
}
async function command(who: keyof typeof identities, value: Record<string, unknown>, expect: number | "any" = 0) {
  const file = join(directory, `${randomUUID()}.json`);
  await writeFile(file, JSON.stringify({ projectId, operationId: randomUUID(), ...value }), { mode: 0o600 });
  log(`  command ${JSON.stringify(value).slice(0, 300)}`);
  return cli(who, ["command", "run", file], expect);
}
const request = async (who: keyof typeof identities, name: string, id: string, value: Record<string, unknown>, expect: number | "any" = 0) => {
  const file = join(directory, `${randomUUID()}.json`); await writeFile(file, JSON.stringify({ projectId, ...value }), { mode: 0o600 });
  log(`  request ${name} ${JSON.stringify(value).slice(0, 300)}`);
  return cli(who, ["request", name, "--project", projectId, "--id", id, "--file", file], expect);
};
const task = (id: string) => uow.read(projectId, r => r.getTask(id)).then(t => t!);
const runsOf = async (taskId: string) => Number((await pool.query("SELECT count(*)::int n FROM runtime_run WHERE project_id=$1 AND task_id=$2", [projectId, taskId])).rows[0].n);
const newTask = async (title: string, owner: string, extra: Record<string, unknown> = {}) => { const taskId = randomUUID(); await apply({ type: "task.create", taskId, title, content: `# ${title}`, acceptance: "Used by the acceptor", owner, consumer: identities.acceptor.actorId, useRequired: true, acceptanceMode: "independent_agent", acceptanceTarget: "business_session", ...extra }); return taskId; };
async function finishRun(runId: string, state: "completed" | "failed" = "completed", category?: string) {
  await runtime.beginDispatch(projectId, runId);
  const stored = (await uow.read(projectId, r => r.getRuntimeRun(runId)))!;
  await runtime.bindTurn(projectId, runId, { id: `turn-${runId}` }, { kind: "startReply", operationId: stored.operationId });
  await runtime.recordTurn(projectId, runId, `turn-${runId}`, state, state === "failed" ? `Native failure; category=${category}` : "done", { completedAtUtc: new Date().toISOString(), ...(category ? { failureCategory: category } : {}) } as never);
}

try {
  log("=== 0. 前置：Leader（Codex）因额度停摆——它的一次 Run 以 quota_exhausted 失败，Codex 提供方被暂停 ===");
  const leaderTask = await newTask("Leader 当时在做的任务", roles.lead);
  await apply({ type: "task.start", taskId: leaderTask, expectedVersion: 1, reason: "start" });
  const leaderRun = randomUUID();
  await apply({ type: "runtime.run.reserve", runId: leaderRun, taskId: leaderTask, sessionId: S.leader, expectedVersion: (await task(leaderTask)).version, input: "Leader work" });
  await finishRun(leaderRun, "failed", "quota_exhausted");
  const hold = (await pool.query("SELECT provider,category,state FROM runtime_provider_hold WHERE project_id=$1", [projectId])).rows;
  log(`  runtime_provider_hold: ${JSON.stringify(hold)}`);
  assert.deepEqual(hold.map(h => [h.provider, h.state]), [["codex", "held"]]);
  const board0 = await cli("standin", ["work", "board", "--project", projectId, "--brief"]);
  assert.ok(board0.sessions.some((s: any) => s.id === S.leader && s.held === true), "the Leader's Session is shown as provider-held");
  assert.ok(board0.sessions.filter((s: any) => s.id !== S.leader).every((s: any) => !s.held), "the Claude Sessions are not held");

  log("\n=== Q1. 非 Leader 身份把已就绪的 Task 追加给 Claude Session：能不能开始、交付 ===");
  const T = await newTask("已就绪、只需 Claude Session 的任务", roles.dev);
  const tBefore = await cli("standin", ["task", T, "--project", projectId]);
  log(`  task state before: ${tBefore.task.state} v${tBefore.task.version}`);
  const appended = await command("standin", { type: "line.append", sessionId: S.dev, taskId: T, expectedTaskVersion: tBefore.task.version, reason: "Leader 停摆，由需求 Session 代派（预案）" });
  assert.equal(appended.status, "applied");
  await settle();
  let entry = (await workflow.listSessionLineEntries(operator, projectId, S.dev, true)).find(e => e.taskId === T)!;
  log(`  line entry after the pump: state=${entry.state} step=${entry.step}`);
  assert.equal(entry.state, "starting"); assert.equal(entry.step, "confirm");
  const assignment = (await workflow.getTaskAssignment(operator, projectId, T))!;
  const taskNow = await task(T);
  const ack = await command("worker", { type: "task.assignment.acknowledge", taskId: T, expectedVersion: assignment.version, expectedTaskVersion: taskNow.version, evidence: "read the fixed Task", verdict: "confirm", plan: "do it", expectedRevisionId: taskNow.currentRevisionId });
  assert.equal(ack.status, "applied");
  await settle();
  entry = (await workflow.listSessionLineEntries(operator, projectId, S.dev, true)).find(e => e.taskId === T)!;
  log(`  line entry after the Claude Session confirmed: state=${entry.state} runId=${entry.runId}`);
  assert.equal(entry.state, "started");
  const runT = entry.runId!;
  assert.equal(await runsOf(T), 1, "exactly one Run");
  log("  [替身] 原生步骤：开始派发 → 绑定 Turn → 记录完成（真实环境由 runner 与 Claude 完成）");
  await finishRun(runT);
  // The Codex pause must not touch the Claude Session; a Codex Session cannot start (PROVIDER_HELD):
  const codexTask = await newTask("追加给 Codex Session 的任务（对照）", roles.lead);
  await command("standin", { type: "line.append", sessionId: S.leader, taskId: codexTask, expectedTaskVersion: (await task(codexTask)).version, reason: "对照：目标是被暂停的 Codex Session" });
  await settle();
  const codexEntry = (await workflow.listSessionLineEntries(operator, projectId, S.leader, true)).find(e => e.taskId === codexTask)!;
  log(`  对照：追加给被暂停的 Codex Session 的队伍项：state=${codexEntry.state} step=${codexEntry.step}（暂停只挡 Codex）`);
  assert.notEqual(codexEntry.state, "started"); assert.equal(await runsOf(codexTask), 0);
  log("  [替身] 交付行直接写入（真实交付要经 Run 的签名提交）");
  await pool.query(`INSERT INTO delivery(project_id,delivery_id,task_id,task_revision_id,run_id,artifact_ref,artifact_revision,content_hash,technical_result,technical_evidence,reason,actor_id,created_at) VALUES($1,$2,$3,$4,$5,'fixture:report','r1',$6,'passed','checked','delivery',$7,now())`,
    [projectId, randomUUID(), T, (await task(T)).currentRevisionId, runT, hash(T), identities.worker.actorId]);
  const delivered = await cli("standin", ["task", T, "--project", projectId]);
  log(`  deliveries read back: ${delivered.deliveries.map((d: any) => `${d.id.slice(0, 8)} ${d.technicalResult}`).join(", ")}`);
  assert.equal(delivered.deliveries.length, 1);

  log("\n=== Q2. 交付之后验收怎样安排（没有 Leader）：直接发消息够不够；用接力 ===");
  const deliveryId = delivered.deliveries[0].id;
  log("  (a) 只发一条普通消息提醒验收 Session：");
  const nudgeId = randomUUID();
  const nudge = await command("standin", { type: "session.message.post", messageId: nudgeId, target: { kind: "owned", sessionId: S.acc }, content: `Task ${T} 已交付（delivery ${deliveryId}），请验收。` });
  const nudgeRow = (await pool.query("SELECT state, sender_actor_id FROM session_message WHERE project_id=$1 AND message_id=$2", [projectId, nudgeId])).rows[0];
  log(`  消息行：${JSON.stringify(nudgeRow)}（它让验收 Session 知道有活，但没有登记“谁、对哪个交付、哪个范围”的验收安排）`);
  assert.equal(nudgeRow.state, "queued");
  const relayBefore = await cli("standin", ["get", `/api/projects/${projectId}/tasks/${T}/acceptance-relay`]);
  log(`  接力记录数：${relayBefore.items.length}`); assert.equal(relayBefore.items.length, 0);
  log("  (b) 用验收接力（acceptance.assign，session 模式，由同一个非 Leader 身份提交）：");
  const arranged = await request("standin", "acceptance.assign", T, { taskId: T, relayId: randomUUID(), operationId: randomUUID(), expectedTaskVersion: (await task(T)).version, deliveryId, stage: "candidate", scopeKey: "leader-down-check",
    scopeDescription: "Leader 停摆期间的候选验收", entrypoint: null, publicationRef: null, mode: "session", recipientActorId: identities.acceptor.actorId, sessionId: S.acc, senderActorId: identities.standin.actorId,
    messageId: randomUUID(), messageOperationId: randomUUID(), reason: "Leader 停摆，由需求 Session 代为安排验收" });
  const relays = await cli("standin", ["get", `/api/projects/${projectId}/tasks/${T}/acceptance-relay`]);
  const item = relays.items[0];
  log(`  接力读回：state=${item.state} stage=${item.stage} mode=${item.mode} recipient=${item.recipientActorId} messageState=${item.messageState}`);
  assert.equal(relays.items.length, 1); assert.equal(item.messageState, "queued");
  const mine = await cli("acceptor", ["get", `/api/projects/${projectId}/acceptance-relay/mine?direct=1`], "any");
  log(`  验收者自己读 acceptance-relay/mine：${JSON.stringify(mine).slice(0, 200)}`);
  log("\n=== Q3（返工复跑，当前 main）. Leader 恢复后对已交付的同一修订再派：三个外部入口都应被拒；一次性内部返工仍可用 ===");
  const holdRow = (await pool.query("SELECT hold_id,version FROM runtime_provider_hold WHERE project_id=$1 AND state='held'", [projectId])).rows[0];
  await command("leader", { type: "runtime.providerHold.release", provider: "codex", holdId: holdRow.hold_id, expectedVersion: Number(holdRow.version), evidenceRef: "quota restored", reason: "额度恢复" }, "any");
  log(`  hold 状态：${JSON.stringify((await pool.query("SELECT state FROM runtime_provider_hold WHERE project_id=$1", [projectId])).rows)}`);
  const leaderBoard = await cli("leader", ["work", "board", "--project", projectId, "--brief"]);
  const ready = (leaderBoard.ready ?? []).map((r: any) => r.task);
  log(`  Leader 的看板“已就绪、没在任何队伍里”的任务：${JSON.stringify(ready)}（T=${T}）`);
  assert.ok(!ready.includes(T), "T is not offered to the Leader as ready-but-unqueued");
  const lineOf = async () => (await workflow.listSessionLineEntries(operator, projectId, S.dev, true)).filter(e => e.taskId === T);
  const describe = (e: any) => `${e.source ?? "?"}/${e.state}/${e.step}${e.runId ? "/run" : ""}`;
  const assignmentSnapshot = async () => { const a = (await workflow.getTaskAssignment(operator, projectId, T))!; return { version: a.version, target: JSON.stringify(a.target), recipient: a.recipientActorId, state: a.state }; };
  const externalAttempts = async (label: string) => {
    const t = await task(T); const a = (await workflow.getTaskAssignment(operator, projectId, T))!;
    log(`  --- ${label}：Leader 对 T（修订 ${t.currentRevisionId.slice(0, 8)}）逐个尝试三个外部入口 ---`);
    const out: Array<[string, any]> = [
      ["line.append → Claude Session", await command("leader", { type: "line.append", sessionId: S.dev, taskId: T, expectedTaskVersion: t.version, reason: "Leader 恢复后重派" }, "any")],
      ["line.append → 同一职责的另一个 Claude Session", await command("leader", { type: "line.append", sessionId: S.dev2, taskId: T, expectedTaskVersion: t.version, reason: "Leader 恢复后重派到别处" }, "any")],
      ["task.assignment.set", await command("leader", { type: "task.assignment.set", taskId: T, expectedTaskVersion: t.version, target: { kind: "owned", sessionId: S.dev }, recipientActorId: identities.worker.actorId, expectedVersion: a.version, reason: "Leader 恢复后重设分派" }, "any")],
      ["runtime.run.reserve", await command("leader", { type: "runtime.run.reserve", runId: randomUUID(), taskId: T, sessionId: S.dev, expectedVersion: t.version, input: "again" }, "any")],
    ];
    for (const [name, r] of out) { const code = r.error?.data?.code ?? r.error?.data?.data?.code ?? r.error?.code; log(`  ${name} → ${code}`); assert.equal(code, "TASK_ALREADY_DELIVERED", `${name}: ${JSON.stringify(r)}`); }
  };
  const runsBefore = await runsOf(T), assignBefore = await assignmentSnapshot(), lineBefore = (await lineOf()).map(describe);
  log(`  尝试之前：Run 数 ${runsBefore}，assignment ${JSON.stringify(assignBefore)}，T 在 Claude Session 队伍里的项 ${JSON.stringify(lineBefore)}`);
  await externalAttempts("第一次（交付已登记，尚无验收结论）");
  await settle();
  const assignAfter = await assignmentSnapshot(), lineAfter = (await lineOf()).map(describe);
  log(`  尝试之后：Run 数 ${await runsOf(T)}，assignment ${JSON.stringify(assignAfter)}，队伍项 ${JSON.stringify(lineAfter)}`);
  assert.equal(await runsOf(T), 1, "still exactly one Run"); assert.deepEqual(assignAfter, assignBefore, "the assignment did not change"); assert.deepEqual(lineAfter, lineBefore, "no line entry was added");
  log("  通知行与 Leader 的通知泵：本实例里泵没有运行，不在这一项里证明。");

  log("\n  --- 一次性内部返工：声明的消费者（acceptor-agent）对当前交付记 notUsed ---");
  const deliveryOfT = (await cli("standin", ["task", T, "--project", projectId])).deliveries[0].id;
  const revisionBefore = (await task(T)).currentRevisionId;
  const obs = await command("acceptor", { type: "observation.record", taskId: T, deliveryId: deliveryOfT, observer: identities.acceptor.actorId, observerKind: "agent", result: "notUsed", evidence: "checked the fixed result", reason: "send it back once" });
  assert.equal(obs.status, "applied");
  const reworkEntries = (await lineOf()).filter(e => (e as any).source === "rework");
  log(`  观察之后 T 的队伍项：${JSON.stringify((await lineOf()).map(describe))}（source=rework 的有 ${reworkEntries.length} 条）`);
  assert.equal(reworkEntries.length, 1, "one Delivery has one internal rework entry");
  assert.equal((await task(T)).currentRevisionId, revisionBefore, "the Task revision is unchanged");
  await externalAttempts("返工项已登记、未开始时，外部三入口仍被拒");
  await settle();
  const a3 = (await workflow.getTaskAssignment(operator, projectId, T))!; const t3 = await task(T);
  log(`  返工项推进到确认：assignment state=${a3.state} v${a3.version}`);
  const ack3 = await command("worker", { type: "task.assignment.acknowledge", taskId: T, expectedVersion: a3.version, expectedTaskVersion: t3.version, evidence: "read the fixed Task and the notUsed observation", verdict: "confirm", plan: "fix it in the original Session", expectedRevisionId: t3.currentRevisionId }, "any");
  log(`  原 Session 确认返工：${ack3.status ?? JSON.stringify(ack3).slice(0, 120)}`);
  await settle();
  const runsAfterRework = await runsOf(T);
  log(`  返工之后 T 的 Run 数：${runsAfterRework}；队伍项 ${JSON.stringify((await lineOf()).map(describe))}`);
  assert.equal(runsAfterRework, 2, "the rework made exactly one new Run");
  const run2 = (await pool.query("SELECT run_id, task_revision_id, state FROM runtime_run WHERE project_id=$1 AND task_id=$2 ORDER BY created_at DESC LIMIT 1", [projectId, T])).rows[0];
  log(`  第二个 Run：${JSON.stringify(run2)}（修订与第一个相同：${run2.task_revision_id === revisionBefore}）`);
  log("  [替身] 原生步骤：第二个 Run 开始派发 → 绑定 Turn → 记录完成；新交付行直接写入");
  await finishRun(run2.run_id);
  await pool.query(`INSERT INTO delivery(project_id,delivery_id,task_id,task_revision_id,run_id,artifact_ref,artifact_revision,content_hash,technical_result,technical_evidence,reason,actor_id,created_at) VALUES($1,$2,$3,$4,$5,'fixture:report-2','r2',$6,'passed','checked','rework delivery',$7,now())`,
    [projectId, randomUUID(), T, (await task(T)).currentRevisionId, run2.run_id, hash(`${T}-2`), identities.worker.actorId]);
  const delivered2 = await cli("standin", ["task", T, "--project", projectId]);
  log(`  交付读回：${delivered2.deliveries.map((d: any) => `${d.id.slice(0, 8)} ${d.technicalResult}`).join(", ")}（两份）`);
  assert.equal(delivered2.deliveries.length, 2);
  await externalAttempts("返工完成、新交付登记后（同一修订第二次再派）");
  await settle();
  assert.equal(await runsOf(T), 2, "no third Run");
  log(`  最终：Run 数 ${await runsOf(T)}，队伍项 ${JSON.stringify((await lineOf()).map(describe))}`);
  log("\n=== Q4. 需要的授权：只有读写、没有审阅的身份做同样的事 ===");
  const T4 = await newTask("授权对照任务", roles.dev);
  const noReview = await command("worker", { type: "line.append", sessionId: S.dev, taskId: T4, expectedTaskVersion: (await task(T4)).version, reason: "no review permission" }, "any");
  log(`  读写但无审阅的身份 line.append → ${noReview.error?.data?.code ?? noReview.error?.code ?? noReview.status}`);
  assert.ok(noReview.error, "an identity without review authority cannot append to a line");
  const noReviewAssign = await request("worker", "acceptance.assign", T4, { taskId: T4, relayId: randomUUID(), operationId: randomUUID(), expectedTaskVersion: (await task(T4)).version, deliveryId: randomUUID(), stage: "candidate", scopeKey: "x", scopeDescription: "x", entrypoint: null, publicationRef: null, mode: "human", recipientActorId: identities.acceptor.actorId, sessionId: null, senderActorId: null, messageId: null, messageOperationId: null, reason: "x" }, "any");
  log(`  读写但无审阅的身份 acceptance.assign → ${noReviewAssign.error?.data?.code ?? noReviewAssign.error?.code ?? noReviewAssign.status}`);
  assert.ok(noReviewAssign.error);
  log("\nALL CHECKS PASSED");
} finally {
  await app.close(); await pool.end(); await rm(directory, { recursive: true, force: true });
  const admin = new pg.Client({ connectionString: url }); await admin.connect();
  try { await admin.query(`DROP SCHEMA "${schema}" CASCADE`); } finally { await admin.end(); }
}
