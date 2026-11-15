/**
 * 统筹安排 › 动态 on a self-built instance (DEC-045 F1, second segment). Nothing here is a fixture of the page's data: a throwaway PostgreSQL, the
 * real WorkflowService / RuntimeWorkflowService / SessionLinePump / AcceptanceRelayService, the real coordinator HTTP server (`buildServer`, the work board
 * routes with the real reads and hub, the built workbench as its web root) and a real browser. The flow is made with real commands (tasks, a
 * Session line, runs, deliveries, a human acceptance and its closure, a provider pause), then read back from the page and checked against the event table.
 *
 *   /tmp/nt/pgrun.sh 'EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE=… EVOLOOP_FLOW_SCREENSHOT_DIR=… node --import tsx tests/manual/flow-real-instance.ts'
 * Needs the built workbench (npm run build). Prints the cross-check table as JSON on the last line; exits non-zero on the first failed check.
 */
// Refuses a live or shared PostgreSQL server before this file opens TEST_DATABASE_URL (scripts/lib/database-target.mjs).
import "../../scripts/test-database-guard.mjs";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import pg from "pg";
import { migrate, PostgresUnitOfWork } from "@evoloop/adapter-postgres";
import { headSeq, readSchedEvents, readWorkBoard } from "@evoloop/adapter-postgres/work-board";
import { RuntimeWorkflowService, WorkflowService } from "@evoloop/core";
import { SessionObservationService } from "@evoloop/core/session-observation";
import type { Principal } from "@evoloop/contracts";
import type { SchedEvent } from "@evoloop/contracts/work-board";
import { buildServer } from "../../apps/coordinator/src/server.js";
import { SchedEventHub } from "../../apps/coordinator/src/work-board/hub.js";
import { SessionLinePump } from "../../apps/coordinator/src/session-line/pump.js";
import { AcceptanceRelayService } from "../../apps/coordinator/src/acceptance-relay/service.js";

const url = process.env.TEST_DATABASE_URL;
if (!url || !/^\/evoloop(?:_[a-z0-9]+)*_test$/.test(new URL(url).pathname)) throw new Error("A dedicated evoloop_*_test database is required");
const modulePath = process.env.EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE;
if (!modulePath) throw new Error("EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE is required");
const shots = process.env.EVOLOOP_FLOW_SCREENSHOT_DIR;
if (shots) mkdirSync(shots, { recursive: true });
const sleep = (ms: number) => new Promise(done => setTimeout(done, ms));
const hash = (text: string) => createHash("sha256").update(text).digest("hex");

const schema = `flow_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
await migrate(url, schema);
const pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}` });
const uow = new PostgresUnitOfWork(pool);
const deps = { uow, clock: { now: () => new Date().toISOString() }, ids: { next: randomUUID }, hasher: { hash } };
const workflow = new WorkflowService(deps), runtime = new RuntimeWorkflowService(deps);
const projectId = randomUUID();
const lead: Principal = { actorId: "leader-actor", projectIds: [projectId], permissions: ["task", "document", "session", "management"], decisions: true };
const dev: Principal = { actorId: "dev-actor", projectIds: [projectId], permissions: ["task", "document", "session"] };
const human: Principal = { actorId: "named-human", projectIds: [projectId], permissions: ["task", "document", "session"], identityKind: "human" };
const token = randomUUID() + randomUUID();
const apply = async (command: Record<string, unknown>, who: Principal = lead) => {
  const r = await workflow.execute(who, { projectId, operationId: randomUUID(), ...command } as never);
  assert.equal(r.status, "applied", JSON.stringify(r)); return r as Extract<typeof r, { status: "applied" }>;
};
await apply({ type: "project.create", title: "Flow instance" });

// ---- Roles and Sessions: a Leader, two developers, an acceptance Session ----
async function role(title: string, templateKey: string | null) {
  const id = randomUUID(), rev = randomUUID();
  const proposal = JSON.stringify({ title, ...(templateKey ? { templateKey } : {}) });
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query(`INSERT INTO role_definition(project_id,role_id,version,current_revision_id,state,proposed_by,created_at_utc,review_at_utc,trial_started_at_utc)
      VALUES($1,$2,1,$3,'trial','leader-actor',now(),now()+interval '1 day',now())`, [projectId, id, rev]);
    await c.query(`INSERT INTO role_revision(project_id,role_id,revision_id,version,state,proposal,actor_id,reason,created_at_utc,review_at_utc)
      VALUES($1,$2,$3,1,'trial',$4::jsonb,'leader-actor','trial',now(),now()+interval '1 day')`, [projectId, id, rev, proposal]);
    await c.query("COMMIT");
  } catch (error) { await c.query("ROLLBACK"); throw error; } finally { c.release(); }
  return id;
}
async function makeSession(roleId: string) {
  const sessionId = randomUUID();
  await apply({ type: "runtime.session.reserve", sessionId, roleId, cwd: "/tmp/flow", authorizationScope: "project", sandbox: "danger-full-access", approvalPolicy: "never" });
  await runtime.beginSessionCreate(projectId, sessionId);
  const saved = (await uow.read(projectId, r => r.getRuntimeSession(sessionId)))!;
  await runtime.bindSession(projectId, sessionId, { owner: "evoloop-codex-app-server", projectId, sessionId, roleId, cwd: "/tmp/flow", authorizationScope: "project",
    nativeThreadId: `thread-${sessionId}`, nativeSessionId: `native-${sessionId}`,
    resumeProfile: { actorId: saved.actorId, model: saved.model, sandbox: saved.sandbox, approvalPolicy: saved.approvalPolicy, executionProfileRevisionId: saved.executionProfile!.revision.revisionId } });
  await apply({ type: "role.bindSession", roleId, expectedVersion: 1, sessionId, note: "bound for the flow instance" });
  return sessionId;
}
const roles = { lead: await role("项目 Leader", "lead"), dev: await role("功能开发", null), dev2: await role("功能开发（第二个）", null), acc: await role("验收", null) };
const sessions = { leader: await makeSession(roles.lead), dev: await makeSession(roles.dev), dev2: await makeSession(roles.dev2), acc: await makeSession(roles.acc) };

// ---- the flow, with real commands ----
const newTask = async (title: string, owner: string) => {
  const taskId = randomUUID();
  await apply({ type: "task.create", taskId, title, content: `# ${title}`, acceptance: "Used", owner, consumer: "named-human", useRequired: true, acceptanceMode: "human_required", acceptanceTarget: "human" });
  return taskId;
};
const task = (id: string) => uow.read(projectId, r => r.getTask(id)).then(t => t!);
const pump = (session: string, actor: Principal) => new SessionLinePump({ workflow, credentials: async () => [lead, actor], enabled: async () => true, canWrite: () => true, pollIntervalMs: 1000,
  onError: error => { throw error; }, recipientActorId: async () => actor.actorId, retryBackoffMs: () => 0 });
const pumps = { dev: pump(sessions.dev, dev), dev2: pump(sessions.dev2, { ...dev, actorId: "dev2-actor" }) };
const settle = async (p: SessionLinePump) => { for (let i = 0; i < 4; i++) await p.tick(); };
async function finishRun(runId: string, state: "completed" | "failed" = "completed", category?: string) {
  await runtime.beginDispatch(projectId, runId);
  const stored = (await uow.read(projectId, r => r.getRuntimeRun(runId)))!;
  await runtime.bindTurn(projectId, runId, { id: `turn-${runId}` }, { kind: "startReply", operationId: stored.operationId });
  await runtime.recordTurn(projectId, runId, `turn-${runId}`, state, state === "failed" ? `Native failure; category=${category}` : "done",
    { completedAtUtc: new Date().toISOString(), ...(category ? { failureCategory: category } : {}) } as never);
}
/** A Task through a Session's line: appended, confirmed by the Session, its Run started; returns the Run. */
async function lineTask(title: string, sessionKey: "dev" | "dev2", actor: Principal) {
  const owner = sessionKey === "dev" ? roles.dev : roles.dev2, sessionId = sessions[sessionKey];
  const taskId = await newTask(title, owner);
  await apply({ type: "line.append", sessionId, taskId, expectedTaskVersion: (await task(taskId)).version, reason: "arranged by the Leader" });
  const p = pumps[sessionKey]; await settle(p);
  const assignment = (await workflow.getTaskAssignment(lead, projectId, taskId))!;
  await apply({ type: "task.assignment.acknowledge", taskId, expectedVersion: assignment.version, expectedTaskVersion: (await task(taskId)).version, evidence: "read the fixed Task",
    verdict: "confirm", plan: "Do it", expectedRevisionId: (await task(taskId)).currentRevisionId }, actor);
  await settle(p);
  const run = (await uow.read(projectId, r => r.listRuntimeRuns(taskId)))[0]!;
  return { taskId, runId: run.id };
}
/** A real delivery needs the Run's signed submission (a Run input hash and the submitting identity), which the instance cannot make without a native runtime: the row is written directly, and the database trigger raises task.delivered as it does for a real one. */
async function deliver(taskId: string, runId: string | null, actor: Principal) {
  await pool.query(`INSERT INTO delivery(project_id,delivery_id,task_id,task_revision_id,run_id,artifact_ref,artifact_revision,content_hash,technical_result,technical_evidence,reason,actor_id,created_at)
    VALUES($1,$2,$3,$4,$5,'fixture:report','r1',$6,'passed','checked','delivery',$7,now())`, [projectId, randomUUID(), taskId, (await task(taskId)).currentRevisionId, runId, hash(taskId), actor.actorId]);
}
const relayService = new AcceptanceRelayService({ pool, workflow, messages: {} as never, principals: async () => [], canWrite: () => false, leaderSession: async () => sessions.leader, qualify: async () => null, capabilities: async () => [] });
async function acceptAndClose(taskId: string) {
  const delivery = (await pool.query("SELECT delivery_id FROM delivery WHERE project_id=$1 AND task_id=$2 ORDER BY created_at DESC LIMIT 1", [projectId, taskId])).rows[0].delivery_id as string;
  const relayId = randomUUID();
  await relayService.arrange(lead, { projectId, operationId: randomUUID(), relayId, taskId, expectedTaskVersion: (await task(taskId)).version, deliveryId: delivery, stage: "candidate", scopeKey: "check",
    scopeDescription: "use it", entrypoint: null, publicationRef: null, mode: "human", recipientActorId: "named-human", sessionId: null, senderActorId: null, messageId: null, messageOperationId: null, reason: "arranged" });
  await relayService.humanRead(human, projectId, taskId, relayId, randomUUID(), 2 - 1, "read it");
  await apply({ type: "observation.record", taskId, deliveryId: delivery, observer: "named-human", observerKind: "human", result: "used", evidence: "used it", reason: "used" }, human);
  const obs = (await pool.query("SELECT observation_id FROM consumer_observation WHERE project_id=$1 AND task_id=$2 ORDER BY created_at DESC LIMIT 1", [projectId, taskId])).rows[0].observation_id as string;
  const version = Number((await pool.query("SELECT version FROM task_acceptance_relay WHERE project_id=$1 AND relay_id=$2", [projectId, relayId])).rows[0].version);
  await relayService.linkObservation(human, projectId, taskId, relayId, obs, randomUUID(), version);
  await apply({ type: "task.close", taskId, expectedVersion: (await task(taskId)).version, deliveryId: delivery, acceptanceResult: "met", acceptanceEvidence: "used", reason: "closed after use" });
}

// History before the page opens: eight Tasks end to end on two Sessions, one closed after a human use, then a provider pause.
const history: Array<{ title: string }> = [];
for (let i = 1; i <= 8; i++) {
  const sessionKey = i % 2 ? "dev" : "dev2", actor = i % 2 ? dev : { ...dev, actorId: "dev2-actor" };
  const { taskId, runId } = await lineTask(`历史任务 ${i}`, sessionKey, actor);
  await finishRun(runId); await settle(pumps[sessionKey]);
  // The Tasks that are closed get a delivery without a source Run (closing a Task checks the Run's own signed submission, which needs a native runtime).
  await deliver(taskId, i <= 3 ? null : runId, actor);
  if (i <= 3) await acceptAndClose(taskId);
  history.push({ title: `历史任务 ${i}` });
}
const pauseTask = await lineTask("遇到额度暂停的任务", "dev", dev);
await finishRun(pauseTask.runId, "failed", "quota_exhausted"); await settle(pumps.dev);
const waiting = await newTask("还没派发的任务", roles.dev);

// ---- the real coordinator, serving the built workbench ----
const reads = { board: (id: string) => readWorkBoard(pool, id), events: (id: string, q: Parameters<typeof readSchedEvents>[2]) => readSchedEvents(pool, id, q) };
const hub = new SchedEventHub({ head: id => headSeq(pool, id), read: (id, after, limit) => readSchedEvents(pool, id, { after, limit }) }, 500);
const app = await buildServer({ service: workflow, sessionWork: new SessionObservationService({ uow }), workBoard: { reads, hub, keepAliveMs: 2000 },
  webRoot: resolve(import.meta.dirname, "../../apps/workbench/dist"),
  credentials: [{ token, actorId: lead.actorId, projectIds: [projectId], permissions: ["task", "document", "session", "management"], decisions: true }] } as never);
let refuse = false, openStreams = 0, streamsOpened = 0;
app.addHook("onRequest", async (request, reply) => {
  if (refuse && request.url.includes("/work-board/")) return reply.code(503).send({ message: "stopped for the test" });
  if (request.url.includes("/work-board/stream")) { openStreams++; streamsOpened++; request.raw.once("close", () => { openStreams--; }); }
});
const base = await app.listen({ host: "127.0.0.1", port: 0 });

const { chromium } = (await import(pathToFileURL(modulePath).href)).default;
const browser = await chromium.launch({ headless: true, ...(process.env.EVOLOOP_BROWSER_TEST_EXECUTABLE_PATH ? { executablePath: process.env.EVOLOOP_BROWSER_TEST_EXECUTABLE_PATH } : {}) });
const table: Record<string, unknown> = {};
const check = (name: string, ok: unknown, detail: unknown) => { table[name] = { ok: !!ok, detail }; assert.ok(ok, `${name}: ${JSON.stringify(detail)}`); };
const db = async (): Promise<SchedEvent[]> => { const out: SchedEvent[] = []; let after: number | undefined; for (;;) { const page = await readSchedEvents(pool, projectId, { limit: 500, ...(after === undefined ? {} : { after }) }); out.push(...page.items); if (!page.more) return out; after = page.cursor; } };

async function openFlow(width: number, height: number, scheme: "light" | "dark", reducedMotion: "reduce" | "no-preference" = "no-preference") {
  const context = await browser.newContext({ viewport: { width, height }, colorScheme: scheme, reducedMotion, locale: "zh-CN", timezoneId: "Asia/Shanghai" });
  const page = await context.newPage();
  await page.addInitScript(() => { (window as any).__long = 0; try { new PerformanceObserver(list => { (window as any).__long += list.getEntries().length; }).observe({ entryTypes: ["longtask"] }); } catch { /* not supported */ } });
  // The token lives in page memory only (a reload asks again), so sign in on the address wanted and move around inside the app afterwards.
  await page.goto(`${base}/p/${projectId}/sessions?view=flow`);
  await page.locator("input").first().fill(token); await page.keyboard.press("Enter");
  try {
    await page.getByRole("heading", { name: "动态", exact: true }).waitFor({ timeout: 30000 });
    await page.locator("[data-connection=live]").waitFor({ timeout: 30000 });
  } catch (error) {
    console.error("PAGE URL", page.url(), "\nPAGE TEXT", (await page.locator("body").innerText()).slice(0, 1200));
    if (shots) await page.screenshot({ path: `${shots}/debug.png`, fullPage: true });
    throw error;
  }
  await page.evaluate((s: string) => { document.documentElement.dataset.theme = s; }, scheme);
  return { context, page };
}
const go = (page: any, path: string) => page.evaluate((p: string) => { window.history.pushState({}, "", p); window.dispatchEvent(new PopStateEvent("popstate")); }, path);
const listedKinds = (page: any) => page.locator("[data-event]").evaluateAll((els: Element[]) => els.map(el => el.getAttribute("data-event")));

try {
  // 1. Replay a real stretch: the picture's numbers and list equal the event table and the board.
  const { context, page } = await openFlow(1440, 900, "light");
  await sleep(1500);
  const events = await db();
  const shown = await listedKinds(page);
  check("事件列表条数 = 事件表条数", shown.length === events.length, { list: shown.length, table: events.length });
  check("事件列表序号与事件表一致（新的在上）", JSON.stringify(shown) === JSON.stringify(events.map(e => String(e.seq)).reverse()), { first: shown.slice(0, 3), table: events.slice(-3).map(e => e.seq).reverse() });
  const board = await readWorkBoard(pool, projectId);
  const stationText = await page.getByLabel("对象轨道").first().innerText();
  const c = board.graph.counts;
  const closed = events.filter(e => e.kind === "acceptance.closed").length;
  const wantStations = { 待派发: board.readyNotQueued.length, 运行中: c.running, 待验收: c.pendingAcceptance, 已验收: closed };
  const stationOk = Object.entries(wantStations).every(([name, n]) => new RegExp(`${n}\\s*${name}`).test(stationText.replace(/\n/g, "")));
  check("对象轨道的数量 = 快照/事件表", stationOk, { stationText: stationText.replace(/\n/g, " "), wantStations });
  check("已合并、已发布写“读不到”，不写 0", /读不到\s*已合并/.test(stationText.replace(/\n/g, "")) && /读不到\s*已发布/.test(stationText.replace(/\n/g, "")), stationText.replace(/\n/g, " "));
  const stuckDom = Number((await page.getByLabel("调度板").locator("dd").last().innerText()).trim());
  const heldSessions = board.sessions.filter(s => s.health.providerHeld || s.health.recoveryGate !== "open").length;
  check("卡住的地方数 = 快照里受阻的 Session 数", stuckDom >= 1 && stuckDom === board.sessions.reduce((n, s) => n + (s.health.recoveryGate !== "open" ? 1 : 0) + (s.health.providerHeld ? 1 : 0) + s.queue.filter(q => q.state === "held").length, 0) + board.awaitingLeader.filter(i => i.kind === "blocked_packet").length, { stuckDom, heldSessions });
  const nodeCards = await page.locator("[data-node^='session:']").count();
  check("右列 Session 卡 = 快照里除 Leader 外的 Session 数", nodeCards === board.sessions.length - 1 && !(await page.locator(`[data-node='session:${sessions.leader}']`).count()), { cards: nodeCards, sessions: board.sessions.length });
  check("受阻的 Session 卡写“受阻”", (await page.locator(`[data-node='session:${sessions.dev}']`).innerText()).includes("受阻"), await page.locator(`[data-node='session:${sessions.dev}']`).innerText());
  if (shots) await page.screenshot({ path: `${shots}/flow-live-1440-light.png`, fullPage: true });

  // 2. Open real objects from an event and from a packet.
  await page.locator("[data-event]").first().click();
  const open = page.locator("[data-open]").first();
  const taskId = events.at(-1)!.taskId;
  check("点事件：详情给出真实任务链接", (await open.getAttribute("href"))?.includes(`/tasks/${taskId}`) ?? false, await open.getAttribute("href"));
  await open.click();
  await page.waitForURL(new RegExp(`/tasks/${taskId}`), { timeout: 15000 });
  const title = (await task(taskId!)).title;
  const titled = await page.getByText(title).first().waitFor({ timeout: 20000 }).then(() => true, () => false);
  check("链接打开的是该任务页（页面上有该任务的标题）", titled, { url: page.url(), title });
  await page.goBack(); await page.getByRole("heading", { name: "动态", exact: true }).waitFor(); await page.locator("[data-connection=live]").waitFor();

  // 3. Live: a new dispatch shows within 3 seconds, as a packet that can be clicked.
  const before = (await listedKinds(page)).length;
  const live = await newTask("实时新来的任务", roles.dev2);
  await apply({ type: "line.append", sessionId: sessions.dev2, taskId: live, expectedTaskVersion: (await task(live)).version, reason: "arranged live" });
  const t0 = Date.now();
  await page.waitForFunction((n: number) => document.querySelectorAll("[data-event]").length > n, before, { timeout: 3000 });
  const latency = Date.now() - t0;
  check("实时：新派发 3 秒内出现", latency < 3000, { ms: latency });
  const packet = page.locator("[data-packet]").first();
  await page.waitForSelector("[data-packet]", { timeout: 4000 }).catch(() => undefined);
  const packetShown = await packet.count();
  check("新事件在画面上是一个包", packetShown > 0, { packets: packetShown });
  // A real pointer click on where the packet is drawn (its box after the animation has ended), after checking that the packet is what is at that point.
  await sleep(1800);
  const spot = await page.evaluate(() => {
    const g = [...document.querySelectorAll("[data-packet]")].at(-1) as SVGGElement | undefined;
    if (!g) return null;
    const r = (g.querySelector("circle:last-of-type") as SVGElement).getBoundingClientRect(), x = r.x + r.width / 2, y = r.y + r.height / 2;
    return { x, y, hit: !!document.elementFromPoint(x, y)?.closest("[data-packet]") };
  });
  check("包停在目标旁边，指针点得到它", !!spot?.hit, spot);
  await page.mouse.click(spot!.x, spot!.y);
  const detailText = await page.getByLabel("事件详情").innerText();
  check("点包：详情是这条事件", /追加进队伍|任务建立|消息/.test(detailText) || detailText.includes("task."), detailText.slice(0, 80));

  // 4. Resume: cut the stream and refuse reconnects while events happen; on return nothing is lost and nothing repeats.
  refuse = true; app.server.closeAllConnections();
  await page.locator("[data-connection=reconnecting]").waitFor({ timeout: 15000 });
  check("断线时提示并带续传位置", /续传/.test(await page.locator("[data-connection]").innerText()), await page.locator("[data-connection]").innerText());
  const during = await newTask("断线期间的任务", roles.dev);
  await apply({ type: "line.append", sessionId: sessions.dev, taskId: during, expectedTaskVersion: (await task(during)).version, reason: "while down" });
  await sleep(2500); refuse = false;
  await page.locator("[data-connection=live]").waitFor({ timeout: 30000 });
  await sleep(2000);
  const all = await db();
  const after = await listedKinds(page);
  const sorted = [...after].sort((a, b) => Number(b) - Number(a));
  check("续传不丢：事件列表 = 事件表", after.length === all.length && JSON.stringify(after) === JSON.stringify(all.map(e => String(e.seq)).reverse()), { list: after.length, table: all.length });
  check("续传不重：序号无重复", new Set(after).size === after.length && JSON.stringify(after) === JSON.stringify(sorted), { unique: new Set(after).size, list: after.length });
  check("已重连次数写在画面上", /已重连 [1-9]/.test(await page.locator("[data-connection]").innerText()), await page.locator("[data-connection]").innerText());

  // 5. Replay from the start, at the end of the list: the button says 从头回放 and really plays.
  await page.getByRole("button", { name: "暂停", exact: true }).click();
  const total = (await db()).length;
  const label = await page.getByRole("button", { name: /^(从头)?回放$/ }).innerText();
  check("在末尾，按钮写“从头回放”", label.includes("从头回放"), label);
  await page.getByRole("button", { name: /^(从头)?回放$/ }).click();
  await sleep(300);
  const afterClick = (await listedKinds(page)).length;
  check("点“从头回放”游标回到起点并重新播放（不是只切换状态）", afterClick < total && await page.getByRole("button", { name: "回放", exact: true }).getAttribute("aria-pressed") === "true", { shown: afterClick, total });
  await sleep(3500);
  check("回放在向前推进", (await listedKinds(page)).length > afterClick, { before: afterClick, now: (await listedKinds(page)).length });
  await page.getByRole("button", { name: "实时", exact: true }).click();
  check("回到实时：显示全部事件", (await listedKinds(page)).length === (await db()).length, null);

  // 6. Long tasks while a real 60-second foreground replay runs (needs enough events: the stretch above plus more).
  for (let i = 0; i < 12; i++) { const t = await newTask(`填充 ${i}`, roles.dev2); await apply({ type: "line.append", sessionId: sessions.dev2, taskId: t, expectedTaskVersion: (await task(t)).version, reason: "fill" }); }
  await sleep(2500);
  const eventsNow = (await db()).length;
  await page.getByRole("slider").fill("0"); await page.getByRole("button", { name: /^(从头)?回放$/ }).click();
  const started = Date.now(); let packetsMost = 0;
  while (Date.now() - started < 60_000) { packetsMost = Math.max(packetsMost, await page.locator("[data-packet]").count()); await sleep(500); }
  const long = await page.evaluate(() => (window as any).__long as number);
  check("前台回放 60 秒，主线程超过 50 毫秒的长任务 = 0", long === 0, { long, events: eventsNow });
  check("同屏的包不超过 12", packetsMost <= 12, { packetsMost });
  await page.getByRole("button", { name: "实时", exact: true }).click();

  // 7. Only while the page is open: leaving closes the stream; a hidden tab draws no packet.
  const withPage = openStreams;
  await go(page, `/p/${projectId}/overview`);
  await page.getByRole("heading", { name: "项目总览" }).waitFor({ timeout: 30000 });
  await page.locator("section[aria-label=调度动态]").waitFor({ timeout: 30000 });
  await sleep(2500);
  const glance = await page.locator("section[aria-label=调度动态]").innerText();
  check("总览小卡片：写卡住的地方和最近事件，并链到动态", /卡住的地方 · [1-9]/.test(glance) && /最近事件/.test(glance) && (await page.getByRole("link", { name: "查看动态" }).getAttribute("href"))!.includes("view=flow"), glance.slice(0, 160));
  const streamsAway = openStreams;
  check("只在页面打开时订阅：动态页打开时有 1 条流，离开后 0 条", withPage === 1 && streamsAway === 0, { withPage, streamsAway, streamsOpened });
  if (shots) await page.screenshot({ path: `${shots}/overview-glance-1440-light.png`, fullPage: true });
  await page.getByRole("link", { name: "查看动态" }).click();
  await page.getByRole("heading", { name: "动态", exact: true }).waitFor({ timeout: 30000 });
  await context.close();

  // 8. Two widths x two themes; narrow lanes; no page-level horizontal scroll.
  for (const scheme of ["light", "dark"] as const) for (const [w, h, layout] of [[1440, 900, "canvas"], [390, 844, "lanes"]] as const) {
    const c2 = await openFlow(w, h, scheme);
    check(`${w}x${h} ${scheme}: 版面是 ${layout}，没有页面级横向滚动`, (await c2.page.locator("section[data-layout]").getAttribute("data-layout")) === layout && (await c2.page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)) <= 0, { w, scheme });
    if (shots) await c2.page.screenshot({ path: `${shots}/flow-live-${w}-${scheme}.png`, fullPage: true });
    await c2.context.close();
  }

  // 9. Reduced motion: nothing flows (no packet, no animation element), the list still follows live events.
  const r = await openFlow(1440, 900, "light", "reduce");
  const n0 = (await listedKinds(r.page)).length;
  const reduced = await newTask("减少动态效果下的任务", roles.dev2);
  await apply({ type: "line.append", sessionId: sessions.dev2, taskId: reduced, expectedTaskVersion: (await task(reduced)).version, reason: "reduced motion" });
  await r.page.waitForFunction((n: number) => document.querySelectorAll("[data-event]").length > n, n0, { timeout: 5000 });
  check("减少动态效果：没有流动动画，列表仍随实时事件更新", (await r.page.locator("animateMotion, [data-packet]").count()) === 0, null);

  // 10. Keyboard: every node and every row reachable by Tab; Enter opens the detail.
  const want = new Set<string>();
  for (const key of await r.page.locator("[data-node]").evaluateAll((els: Element[]) => els.map(el => `n:${el.getAttribute("data-node")}`))) want.add(key);
  for (const key of (await listedKinds(r.page)).slice(0, 30)) want.add(`e:${key}`);
  const reached = new Set<string>();
  await r.page.locator("[data-ui] h2").first().click();
  for (let step = 0; step < 220 && [...want].some(k => !reached.has(k)); step++) {
    await r.page.keyboard.press("Tab");
    const key = await r.page.evaluate(() => { const el = document.activeElement as HTMLElement | null; return el?.getAttribute("data-node") ? `n:${el.getAttribute("data-node")}` : el?.getAttribute("data-event") ? `e:${el.getAttribute("data-event")}` : null; });
    if (key) reached.add(key);
  }
  check("键盘能走完所有节点和前 30 条事件行", [...want].every(k => reached.has(k)), { missing: [...want].filter(k => !reached.has(k)) });
  await r.page.locator("[data-event]").first().focus(); await r.page.keyboard.press("Enter");
  check("Enter 打开事件详情", await r.page.getByLabel("事件详情").isVisible(), null);
  await r.context.close();

  // 11. Code splitting: the dynamic page is its own chunk (the others do not carry it).
  const c3 = await browser.newContext({ viewport: { width: 1440, height: 900 } }); const p3 = await c3.newPage();
  const loaded: string[] = []; p3.on("response", resp => { if (/\.js(\?|$)/.test(resp.url())) loaded.push(resp.url().split("/").pop()!); });
  await p3.goto(`${base}/p/${projectId}/documents`); await p3.locator("input").first().fill(token); await p3.keyboard.press("Enter"); await sleep(3500);
  const flowLoadedOnOtherPage = loaded.some(f => /^FlowPage|^FlowView/.test(f));
  check("其他页面不加载动态页的代码", !flowLoadedOnOtherPage, loaded.filter(f => /Flow/.test(f)));
  await c3.close();
  table.summary = { events: (await db()).length, projectId };
  console.log("FLOW_TABLE " + JSON.stringify(table));
} finally {
  await browser.close(); await app.close(); await pool.end();
  const admin = new pg.Client({ connectionString: url }); await admin.connect();
  try { await admin.query(`DROP SCHEMA "${schema}" CASCADE`); } finally { await admin.end(); }
  void waiting; void history;
}
