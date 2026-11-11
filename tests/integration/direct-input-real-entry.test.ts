// Refuses a live or shared PostgreSQL server before this file opens TEST_DATABASE_URL (scripts/lib/database-target.mjs).
import "../../scripts/test-database-guard.mjs";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";
import { WorkflowService } from "@evoloop/core";
import { SessionObservationService } from "@evoloop/core/session-observation";
import { migrate, PostgresUnitOfWork } from "@evoloop/adapter-postgres";
import { PgDirectInputs } from "@evoloop/adapter-postgres/direct-input";
import type { RuntimeBinding, RuntimeCapabilities } from "@evoloop/contracts/runtime";
import type { NativeWorkspacePage } from "@evoloop/contracts/session-timeline";
import { buildServer } from "../../apps/coordinator/src/server.js";
import { DirectInputService } from "../../apps/coordinator/src/direct-input/service.js";
import { SessionTimelineService } from "../../apps/coordinator/src/session-timeline/index.js";
import { mapWorkspaceItem, mapWorkspaceTurn } from "../../packages/adapter-codex-app-server/src/workspace-map.js";

const database = process.env.TEST_DATABASE_URL;
if (!database || !/^evoloop(?:_[a-z0-9]+)*_test$/.test(decodeURIComponent(new URL(database).pathname.slice(1))))
  throw new Error("direct input real-entry test requires an isolated evoloop_*_test database");

/**
 * The real entries a person uses: HTTP into the coordinator's routes, the real direct-input service and store on PostgreSQL, the real
 * Session timeline service and the real native-Item mapper. Only the native Codex process is scripted: it keeps the Items it was sent
 * exactly as the materialized history does (a userMessage carries `clientId` and the text marker the service wrote).
 */
async function setup(t: import("node:test").TestContext, webRoot?: string) {
  const schema = `el_direct_entry_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  await migrate(database!, schema);
  const pool = new pg.Pool({ connectionString: database, options: `-c search_path=${schema}` });
  const uow = new PostgresUnitOfWork(pool);
  const projectId = randomUUID(), sessionId = randomUUID(), roleId = randomUUID(), key = `owned:${sessionId}`;
  const owner = "owner-human", receiver = "session-agent", token = randomUUID() + randomUUID();
  const threadId = `thread-${sessionId}`;
  const now = () => new Date().toISOString();
  t.after(async () => { await pool.end(); const admin = new pg.Client({ connectionString: database }); await admin.connect();
    try { await admin.query(`DROP SCHEMA "${schema}" CASCADE`); } finally { await admin.end(); } });
  await pool.query("INSERT INTO project(project_id,title,created_at) VALUES($1,'Direct input real entry',now())", [projectId]);
  await pool.query(`INSERT INTO runtime_session(project_id,session_id,role_id,cwd,authorization_scope,sandbox,approval_policy,state,version,
    native_thread_id,native_session_id,operation_id,actor_id,created_at,updated_at)
    VALUES($1,$2,$3,'/tmp/direct-real-entry','project','danger-full-access','never','ready',1,$4,$4,$5,$6,now(),now())`,
  [projectId, sessionId, roleId, threadId, randomUUID(), receiver]);
  const binding: RuntimeBinding = { projectId, sessionId, roleId, nativeThreadId: threadId, nativeSessionId: threadId, cwd: "/tmp/direct-real-entry",
    authorizationScope: "project", owner: "evoloop-codex-app-server" };

  // ---- the scripted native Codex: Items exactly as materialized history returns them ----
  type Item = { id: string; type: string; clientId?: string; content?: unknown[]; text?: string; phase?: string };
  const turns: Array<{ id: string; status: string; completedAt: number | null; items: Item[] }> = [];
  let itemCounter = 0;
  const capabilities = { provider: "codex", process: "shared", delivery: { midTurnInput: true, idleTurnStart: true, callerAssignedTurnKey: false, callerAssignedSessionId: false },
    errors: { notSent: true, rejected: true }, compaction: { autoCompacts: true, mode: "unavailable" }, history: { workTrace: true, workspace: true }, naming: true, archive: "native",
    nativeInput: false, executionProfileActivation: true, modelList: true, usage: "unavailable", cost: false } as RuntimeCapabilities;
  const runtime = {
    isReady: () => true, capabilities: () => capabilities, registerBinding: async () => undefined,
    qualifyConversationThread: async () => ({ available: true, reason: "ok", fingerprint: "b".repeat(64) }),
    startConversationTurn: async (_binding: RuntimeBinding, input: string, operationId: string) => {
      const turn = { id: `turn-${turns.length + 1}`, status: "inProgress", completedAt: null,
        items: [{ id: `item-${++itemCounter}`, type: "userMessage", clientId: operationId, content: [{ type: "text", text: input }] }] as Item[] };
      turns.push(turn); return { id: turn.id, status: "inProgress", completedAtUtc: null };
    },
    steerTurn: async (_binding: RuntimeBinding, turnId: string, input: string, inputId: string) => {
      const turn = turns.find(x => x.id === turnId)!;
      turn.items.push({ id: `item-${++itemCounter}`, type: "userMessage", clientId: inputId, content: [{ type: "text", text: input }] });
      return { turnId, itemId: null };    // the acknowledgement carries no Item
    },
    listTurns: async () => ({ data: [...turns].reverse().map(x => ({ id: x.id, status: x.status, completedAtUtc: x.completedAt === null ? null : new Date(x.completedAt * 1000).toISOString() })), nextCursor: null }),
    listItems: async (_binding: RuntimeBinding, turnId: string) => ({ data: turns.find(x => x.id === turnId)!.items.map(item => ({ ...item })), nextCursor: null }),
  };
  const endTurn = (id: string) => { const turn = turns.find(x => x.id === id)!; turn.status = "completed"; turn.completedAt = Math.floor(Date.now() / 1000);
    turn.items.push({ id: `item-${++itemCounter}`, type: "agentMessage", text: "Done", phase: "final_answer" }); };

  // ---- the real services ----
  const store = new PgDirectInputs(pool);
  const grant = { projectId, sessionId, senderActorId: owner, receiverRoleId: roleId, receiverActorId: receiver, cwd: binding.cwd, enabled: true, canSteer: true, canStart: true, maxTurns: 20 };
  const directInput = new DirectInputService({ store, runtime: () => runtime as never, canWrite: () => true,
    admission: async () => ({ grant, binding }), bindingFor: async () => binding });
  const history = async (_principal: unknown, _project: string, _session: string, options: { turnId?: string; itemId?: string }): Promise<NativeWorkspacePage> => {
    const selected = options.turnId ? turns.filter(x => x.id === options.turnId) : turns;
    const at = now();
    const entries = selected.flatMap(turn => turn.items.flatMap(item => {
      const entry = mapWorkspaceItem(item, turn.id, binding, at, turn.completedAt ?? undefined);
      return entry && (!options.itemId || entry.nativeItemId === options.itemId) ? [entry] : [];
    }));
    return { entries, turns: selected.map(turn => mapWorkspaceTurn({ id: turn.id, status: turn.status, startedAt: 1, completedAt: turn.completedAt })!).filter(Boolean),
      nextCursor: null, observedAt: at, historyMode: "paginated", method: "items", partial: false, itemEnumerationComplete: true, limitations: [], unsupportedKinds: [] };
  };
  const runner = { workspaceBinding: async () => ({ nativeThreadId: threadId, nativeSessionId: threadId }), workspaceHistory: history,
    nativeAdapter: () => ({ onWorkspaceUpdate: true }), status: () => ({ available: true }), onWorkspaceUpdate: () => () => undefined, onWorkspaceDisconnect: () => () => undefined };
  const principal = { actorId: owner, projectIds: [projectId], permissions: ["read", "write"] as Array<"read" | "write"> };
  const hash = (value: string) => createHash("sha256").update(value).digest("hex");
  const service = new WorkflowService({ uow, clock: { now }, ids: { next: randomUUID }, hasher: { hash } });
  const observation = new SessionObservationService({ uow });
  const timeline = new SessionTimelineService({ uow, observation, runner: runner as never, directInputs: store });
  const app = await buildServer({ service, credentials: [{ token, ...principal }], sessionWork: observation, sessionTimeline: timeline, directInput, ...(webRoot ? { webRoot } : {}) } as never);
  t.after(async () => { timeline.close(); await app.close(); });
  const auth = { authorization: `Bearer ${token}` };
  const root = `/api/projects/${projectId}`;
  const post = async (inputId: string, content: string, expectedTurnId: string | null) => {
    const response = await app.inject({ method: "POST", url: `${root}/sessions/${sessionId}/direct-inputs`, headers: auth,
      payload: { inputId, operationId: randomUUID(), content, expectedTurnId } });
    assert.equal(response.statusCode, 200, response.body); return response.json() as Record<string, unknown>;
  };
  const read = async (inputId: string) => (await app.inject({ method: "GET", url: `${root}/sessions/${sessionId}/direct-inputs/${inputId}`, headers: auth })).json() as Record<string, unknown>;
  const inputsOnTimeline = async () => {
    const response = await app.inject({ method: "GET", url: `${root}/session-work/${encodeURIComponent(key)}/timeline?source=native&limit=50`, headers: auth });
    assert.equal(response.statusCode, 200, response.body);
    return (response.json().entries as Array<Record<string, any>>).filter(entry => entry.nativeKind === "userMessage");
  };

  return { pool, app, turns, endTurn, directInput, projectId, sessionId, key, token, owner, binding, read, post, inputsOnTimeline, root, auth };
}

test("idle direct start and a later supplement both show their verified sender through the real routes; after the Turn ends the native Items are recorded; a forged identity still fails closed", async t => {
  const { pool, app, turns, endTurn, directInput, projectId, sessionId, key, owner, read, post, inputsOnTimeline } = await setup(t);
  // 1. The person sends to the idle Session: an idle start, through the route.
  const startId = randomUUID();
  const started = await post(startId, "请开始处理这件事", null);
  assert.equal(started.state, "accepted"); assert.equal(started.mode, "start");
  assert.equal(started.nativeItemId, null, "a start learns its Item only from history");
  // While the Turn runs the timeline cannot yet prove which Item is the business input (it never binds an unfinished Turn), so it says
  // "not associated" for every message alike; what it must not say is that the identities conflict.
  let inputs = await inputsOnTimeline();
  assert.equal(inputs.length, 1);
  assert.ok(!JSON.stringify(inputs).includes("冲突"), JSON.stringify(inputs[0]));

  // 2. While that Turn runs the person adds to it: a supplement, through the same route.
  const steerId = randomUUID();
  const steered = await post(steerId, "补充：只看右栏", "turn-1");
  assert.equal(steered.mode, "steer"); assert.equal(steered.state, "accepted");
  assert.ok(!JSON.stringify(await inputsOnTimeline()).includes("冲突"));

  // 3. Before the Turn ends no Item is recorded and nothing is claimed.
  assert.equal(await directInput.backfillItems(), 0);
  assert.equal((await read(startId)).nativeItemId, null); assert.equal((await read(steerId)).nativeItemId, null);

  // 4. The Turn ends; the service reads the history back and records both native Items.
  endTurn("turn-1");
  assert.equal(await directInput.backfillItems(), 2);
  const startItem = (await read(startId)).nativeItemId, steerItem = (await read(steerId)).nativeItemId;
  assert.equal(typeof startItem, "string"); assert.equal(typeof steerItem, "string"); assert.notEqual(startItem, steerItem);
  assert.deepEqual([startItem, steerItem], turns[0]!.items.filter(item => item.type === "userMessage").map(item => item.id));
  assert.equal((await directInput.backfillItems()), 0, "recorded once, not again");
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM session_direct_input WHERE project_id=$1 AND native_item_id IS NULL AND state='accepted'", [projectId])).rows[0].n, 0);
  // The Turn has ended: the timeline now names the sender of both inputs, the start and the supplement.
  inputs = await inputsOnTimeline();
  assert.equal(inputs.length, 2);
  assert.deepEqual(inputs.map(entry => entry.kind), ["message", "message"], JSON.stringify(inputs));
  assert.deepEqual(inputs.map(entry => entry.author.id), [owner, owner], "both inputs show their verified sender");
  assert.equal(inputs[0].origin?.kind, "message"); assert.equal(inputs[0].origin?.id, startId);
  assert.ok(!JSON.stringify(inputs).includes("冲突"));

  // 5. Not a way to hide the warning: the same real route still fails closed for an input that is not this source's.
  turns.push({ id: "turn-2", status: "completed", completedAt: 1, items: [
    { id: "item-forged-1", type: "userMessage", clientId: randomUUID(), content: [{ type: "text", text: `[evoloop-message-operation:${randomUUID()}]\nforged` }] }] });
  const rows = await inputsOnTimeline();
  assert.ok(rows.every(entry => entry.kind === "notice" ? entry.nativeItemId === "item-forged-1" : true), "only the forged input is not verified");
  assert.equal(rows.find(entry => entry.nativeItemId === "item-forged-1")?.kind, "notice");
  turns.pop();
  turns[0]!.items.push({ id: "item-conflict", type: "userMessage", clientId: startId, content: [{ type: "text", text: `[evoloop-message-operation:${randomUUID()}]\nsame client id, another operation` }] });
  const conflict = (await inputsOnTimeline()).find(entry => entry.nativeItemId === "item-conflict");
  assert.equal(conflict?.kind, "notice", "a client ID that matches while the marker names another operation is a real conflict");
  assert.match(conflict?.label ?? "", /冲突/);
});

/**
 * Opt-in (needs a Playwright module and the built workbench): the same real coordinator serves the built workbench, and a real browser
 * does what a person does: opens the Session, sends to the idle Session, and watches the receipt and the timeline.
 *   EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE=/path/to/playwright-core/index.js (and apps/workbench built, or EVOLOOP_BROWSER_TEST_DIST)
 */
const playwrightModule = process.env.EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE;
const dist = process.env.EVOLOOP_BROWSER_TEST_DIST ?? new URL("../../apps/workbench/dist", import.meta.url).pathname;
test("in a real browser: a direct send to the idle Session shows no identity conflict, the receipt turns from 'received' to 'read' once the Turn ends and the Item is recorded", {
  skip: !playwrightModule && "Set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE and build apps/workbench",
}, async t => {
  const { chromium } = (await import(new URL(`file://${playwrightModule}`).href)).default;
  const h = await setup(t, dist);
  await h.app.listen({ port: 0, host: "127.0.0.1" });
  const base = `http://127.0.0.1:${(h.app.server.address() as { port: number }).port}`;
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  await page.goto(`${base}/p/${h.projectId}/sessions?session=${encodeURIComponent(h.key)}`);
  await page.getByLabel("访问令牌").fill(h.token);
  await page.getByRole("button", { name: "进入", exact: true }).click();
  const box = page.getByRole("combobox", { name: "消息" });
  await box.waitFor();
  await page.screenshot({ path: process.env.EVOLOOP_BROWSER_TEST_SHOTS ? `${process.env.EVOLOOP_BROWSER_TEST_SHOTS}/1-idle.png` : "/dev/null" }).catch(() => undefined);
  await box.fill("请开始处理这件事（浏览器里发的）");
  await page.getByRole("button", { name: /直接发送|发送/ }).first().waitFor();
  await box.press("Enter");
  const receipt = page.locator(".session-direct-receipt");
  await receipt.getByText("运行时已接收；不代表智能体已阅读或采用").waitFor({ timeout: 20_000 });
  assert.equal(h.turns.length, 1, "the browser's send started one native Turn");
  // The Turn ends and the service reads its history back: the page looks again and says it was read, never adopted.
  h.endTurn("turn-1");
  assert.equal(await h.directInput.backfillItems(), 1);
  await receipt.getByText("已读到：运行时已记录这条输入的原生条目；不代表智能体已采用").waitFor({ timeout: 20_000 });
  await page.screenshot({ path: process.env.EVOLOOP_BROWSER_TEST_SHOTS ? `${process.env.EVOLOOP_BROWSER_TEST_SHOTS}/2-read.png` : "/dev/null" }).catch(() => undefined);
  // While the Turn ran, the page's timeline could not yet bind the input; after the Turn ended and the page reads again, it names the sender.
  await page.getByRole("button", { name: "重新读取" }).click();
  await page.waitForFunction(() => !document.querySelector(".unified-session-timeline")?.textContent?.includes("未关联的原生输入"), null, { timeout: 20_000 });
  await page.screenshot({ path: process.env.EVOLOOP_BROWSER_TEST_SHOTS ? `${process.env.EVOLOOP_BROWSER_TEST_SHOTS}/3-after-reread.png` : "/dev/null" }).catch(() => undefined);
  const timeline = await page.locator(".unified-session-timeline").innerText();
  assert.ok(!/标识冲突|标识互相冲突|无法核实发送者|未关联的原生输入/.test(timeline), timeline);
  assert.ok(timeline.includes("请开始处理这件事（浏览器里发的）"), `the timeline shows the sent input: ${timeline}`);
});
