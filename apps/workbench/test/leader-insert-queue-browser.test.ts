// Opt-in built-app regression: build workbench, then set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE.
// The Leader's page while it works: two named buttons, 插入当前这一轮 and 排队, each followed by its own result line
// (已插入, 已排队, and 没有插入，已转排队 with the reason when the Turn changed); idle it has one 发送; another agent's
// page keeps the keys. EVOLOOP_AGENT_SCREENSHOT_DIR saves a screenshot per width.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { timelineAssistant, timelineMessage, timelinePage, timelineTool } from "./session-timeline-fixtures";

const modulePath = process.env.EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE;
const shots = process.env.EVOLOOP_AGENT_SCREENSHOT_DIR;
const dist = resolve(import.meta.dirname, "../dist");
const projectId = "96000001-0000-4000-8000-000000000001";
const id = (n: number) => `96000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const leaderId = id(2), workerId = id(3), runningMessageId = id(7), processingId = id(8);
const stamp = new Date(Date.now() - 64_000).toISOString();
const metadata = { generatedAt: stamp, sourceObservedAt: stamp, partial: false, limitations: [] };
const unavailable = { available: false, reason: "未开放" };
const resources = Object.fromEntries(["configuredModel", "actualModel", "inputTokens", "outputTokens", "cost", "processMemory"]
  .map(key => [key, { value: null, unit: "", source: null, scope: "session", observedAt: null, interval: null, unavailableReason: "未记录" }]));
const role = (n: number, title: string, templateKey: string | null) => ({ id: id(n), title, state: "active", roleClass: templateKey === "lead" ? "system" : "business", templateKey, responsibility: `${title}职责` });
function agent(sessionId: string, title: string, roles: ReturnType<typeof role>[], busy: boolean) {
  return { key: `owned:${sessionId}`, target: { kind: "owned", sessionId }, aliases: [], title, profile: null, identity: null, kind: "owned", roles,
    membership: "current", membershipReason: "fixture", runtimeState: "ready", busy, currentTask: null, latestBusinessRun: null, lastProgressAt: stamp,
    capabilities: { observe: { available: true, reason: null }, send: { available: true, reason: null, mode: "owned-conversation" },
      open: { ...unavailable, ref: null }, interrupt: unavailable, close: unavailable,
      ordinaryExecution: { state: "unverified", reasonCode: "fixture", reason: "执行前仍须核验。", observedAt: stamp } },
    source: { kind: "session", id: sessionId, revision: null, evidence: "project-record", href: "" }, metadata };
}

test("the Leader's page offers 插入当前这一轮 and 排队 while it works, tells each result, and keeps one 发送 when idle", {
  skip: !modulePath && "Set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE after building the workbench",
}, async t => {
  const { chromium } = (await import(pathToFileURL(modulePath!).href)).default;
  const commands: Array<Record<string, unknown>> = [];
  const directInputs = new Map<string, Record<string, unknown>>();
  let capability: "steer" | "start" | "none" = "steer", running = true, changed = false;
  const leader = agent(leaderId, "统筹", [role(20, "统筹", "lead")], true);
  const worker = agent(workerId, "前端实现", [role(21, "前端实现", null)], true);
  const directory = [leader, worker];
  const runningTurn = { id: "turn-2", state: "running", startedAt: stamp, completedAt: null,
    origin: { kind: "message", id: runningMessageId, taskId: null, taskRevisionId: null, initiatingActorId: "reader" } };
  const entries = [
    timelineMessage("first", "请安排今天的任务。", { turnId: "turn-1" }),
    timelineAssistant("reply-1", "好的，我先读调度板。", { turnId: "turn-1", author: { kind: "session", id: leaderId, label: "统筹" } }),
    timelineMessage(runningMessageId, "现在重排队列。", { turnId: "turn-2", state: "running" }),
    timelineTool("tool-3", "Command", "Command", "running", { turnId: "turn-2", freshness: "live" }),
  ];
  const receipt = (input: Record<string, unknown>, sessionId: string) => changed
    ? { projectId, sessionId, inputId: input.inputId, operationId: input.operationId, actorId: "reader", mode: "steer", source: { kind: "message", id: input.inputId, processingId: null },
      expectedTurnId: input.expectedTurnId, actualTurnId: null, nativeItemId: null, state: "rejected",
      reason: "TURN_CHANGED: the Turn changed before the input was added; saved as a queued ordinary message", queuedMessageId: input.inputId, version: 1, createdAt: stamp, updatedAt: stamp }
    : { projectId, sessionId, inputId: input.inputId, operationId: input.operationId, actorId: "reader", mode: input.expectedTurnId ? "steer" : "start",
      source: { kind: "message", id: runningMessageId, processingId }, expectedTurnId: input.expectedTurnId, actualTurnId: "turn-2", nativeItemId: "n", state: "accepted",
      reason: null, version: 2, createdAt: stamp, updatedAt: stamp };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, "http://127.0.0.1");
    if (url.pathname.startsWith("/api/")) {
      const root = `/api/projects/${projectId}`;
      let value: unknown = { items: [], nextCursor: null, metadata }, status = 200;
      const body = async () => { let text = ""; for await (const chunk of req) text += String(chunk); return JSON.parse(text) as Record<string, unknown>; };
      const sessionOf = (path: string) => path.includes(leaderId) ? leaderId : workerId;
      if (url.pathname === "/api/session") value = { principal: { actorId: "reader", projectIds: [projectId], permissions: ["read", "write", "review"] }, capabilities: {} };
      else if (url.pathname === root) value = { id: projectId, title: "发送方式测试项目", createdAt: stamp };
      else if (url.pathname === "/api/commands" && req.method === "POST") {
        const command = await body(); commands.push(command);
        value = { status: "applied", operationId: command.operationId, entityId: String(command.messageId ?? "x"), version: 1 };
      } else if (url.pathname.endsWith("/direct-input-capability")) value = capability === "steer"
        ? { available: true, mode: "steer", expectedTurnId: "turn-2", reasonCode: "READY_TO_STEER", observedAt: stamp }
        : capability === "start" ? { available: true, mode: "start", expectedTurnId: null, reasonCode: "READY_TO_START", observedAt: stamp }
          : { available: false, mode: null, expectedTurnId: null, reasonCode: "DIRECT_STEER_DISABLED", observedAt: stamp };
      else if (url.pathname.endsWith("/direct-inputs") && req.method === "POST") {
        const input = await body(); const made = receipt(input, sessionOf(url.pathname)); directInputs.set(String(input.inputId), made); value = made;
      } else if (/\/direct-inputs\/[^/]+$/.test(url.pathname)) {
        const found = directInputs.get(url.pathname.split("/").at(-1)!);
        if (!found) { status = 404; value = { message: "Not found" }; } else value = found;
      } else if (url.pathname === `${root}/session-work`) value = { items: directory, nextCursor: null, observationCursor: "1", metadata,
        totals: { current: directory.length, historical: 0, unclassified: 0 }, attention: { unansweredQuestions: 0, pendingMessages: 0, pendingAcceptance: null, unclassifiedSessions: 0 } };
      else if (/\/session-work\/[^/]+$/.test(url.pathname)) { const self = url.pathname.includes(leaderId) ? leader : worker;
        value = { session: { ...self, busy: running }, observationCursor: "1", currentWork: null, assignments: [], roleTasks: [], queue: [], results: [], questions: [], activity: [], resources, metadata }; }
      else if (/\/session-work\/[^/]+\/timeline$/.test(url.pathname)) value = timelinePage(decodeURIComponent(url.pathname.split("/").at(-2)!), { title: "统筹", entries, pending: [],
        turns: [], liveTurns: running ? [runningTurn] : [], activeTurnId: running ? "turn-2" : null });
      else if (url.pathname.endsWith("/timeline/updates")) value = { cursor: "1", resetRequired: false, entries: [], turns: running ? [runningTurn] : [], freshness: "live", limitations: [], activeTurnId: running ? "turn-2" : null };
      else if (url.pathname.endsWith("/recovery")) { status = 404; value = { message: "无恢复记录" }; }
      else if (url.pathname === `${root}/runtime/runs` || url.pathname === `${root}/runtime/sessions` || url.pathname === `${root}/resident-queues`) value = [];
      else if (url.pathname === `${root}/runtime`) value = { available: true, error: null, allowedCwds: [], grants: [] };
      else if (url.pathname.startsWith(`${root}/work-management/tasks/`)) { status = 404; value = { message: "未登记" }; }
      res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); return;
    }
    try {
      const file = /^\/(?:$|p\/|ui$)/.test(url.pathname) ? "index.html" : url.pathname;
      const content = await readFile(join(dist, file));
      res.writeHead(200, { "content-type": ({ ".html": "text/html", ".js": "text/javascript", ".css": "text/css" } as Record<string, string>)[extname(file)] ?? "application/octet-stream" });
      res.end(content);
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done)); t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const browser = await chromium.launch({ headless: true, ...(process.env.EVOLOOP_BROWSER_TEST_EXECUTABLE_PATH
    ? { executablePath: process.env.EVOLOOP_BROWSER_TEST_EXECUTABLE_PATH } : {}) }); t.after(() => browser.close());

  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    capability = "steer"; running = true; changed = false; commands.length = 0; directInputs.clear();
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
    const open = async (sessionId: string, title: string) => {
      await page.goto(`${base}/p/${projectId}/sessions?${new URLSearchParams({ session: `owned:${sessionId}` })}`);
      if (await page.getByLabel("访问令牌").isVisible().catch(() => false)) {
        await page.getByLabel("访问令牌").fill("fixture-token"); await page.getByRole("button", { name: "进入", exact: true }).click();
      }
      await page.getByRole("heading", { name: title }).waitFor();
    };
    await open(leaderId, "统筹");
    const box = page.getByRole("combobox", { name: "消息" });
    await box.waitFor();
    const way = page.getByRole("group", { name: "发送方式" });
    // Working, insert open: two named buttons, no hidden arrow.
    await way.getByRole("button", { name: "插入当前这一轮" }).waitFor();
    await way.getByRole("button", { name: "排队", exact: true }).waitFor();
    assert.equal(await way.getByRole("button").count(), 2);
    assert.equal(await page.locator("[data-send-way]").count(), 2);
    const sizes = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, width: innerWidth,
      group: document.querySelector<HTMLElement>("[aria-label='发送方式']")!.getBoundingClientRect().right }));
    assert.ok(sizes.scrollWidth <= sizes.width && sizes.group <= sizes.width, `${viewport.width}: the two buttons fit ${JSON.stringify(sizes)}`);
    if (shots) await page.screenshot({ path: join(shots, `leader-two-buttons-${viewport.width}.png`) });
    // 插入当前这一轮: goes to the running Turn, and says 已插入.
    await box.fill("补充：先看 PR 346");
    await way.getByRole("button", { name: "插入当前这一轮" }).click();
    await page.locator("[data-sent-result=inserted]").getByText("已插入当前这一轮").waitFor();
    assert.equal(directInputs.size, 1);
    const inserted = [...directInputs.values()][0]!;
    assert.equal(inserted.expectedTurnId, "turn-2"); assert.equal(inserted.state, "accepted");
    assert.equal(await box.inputValue(), "", "an inserted message clears the draft");
    if (shots) await page.screenshot({ path: join(shots, `leader-inserted-${viewport.width}.png`) });
    // 排队: an ordinary message, and says 已排队.
    await box.fill("这一轮之后再看文档");
    await way.getByRole("button", { name: "排队", exact: true }).click();
    await page.locator("[data-sent-result=queued]").getByText("已排队").waitFor();
    const posts = commands.filter(command => command.type === "session.message.post");
    assert.equal(posts.length, 1); assert.equal(posts[0]!.content, "这一轮之后再看文档");
    assert.equal(directInputs.size, 1, "queueing sends no direct input");
    // The Turn changed under the insert: no insert, one queued message, the reason, and the draft is gone.
    changed = true;
    await box.fill("刚好换了一轮");
    await way.getByRole("button", { name: "插入当前这一轮" }).click();
    const converted = page.locator("[data-sent-result=converted]");
    await converted.getByText("没有插入，已转排队").waitFor();
    assert.match(await converted.innerText(), /那一轮已经换了/); assert.match(await converted.innerText(), /只有一条/);
    assert.equal(await box.inputValue(), "", "the saved text is not left in the box to be sent twice");
    assert.equal(commands.filter(command => command.type === "session.message.post").length, 1, "the page sent no second copy; the service saved the one queued message");
    if (shots) await page.screenshot({ path: join(shots, `leader-converted-${viewport.width}.png`) });
    // Idle: one 发送, no pair.
    changed = false; running = false; capability = "start";
    await open(leaderId, "统筹");
    await page.getByRole("button", { name: "发送", exact: true }).waitFor();
    assert.equal(await page.locator("[data-send-way]").count(), 0, "idle: no insert/queue pair");
    // Another agent's page keeps the keys: no pair even while it works.
    running = true; capability = "steer";
    await open(workerId, "前端实现");
    await page.getByRole("combobox", { name: "消息" }).fill("补一句");
    await page.getByRole("button", { name: "补充到这一轮" }).waitFor();
    assert.equal(await page.locator("[data-send-way]").count(), 0, "a business agent's page is unchanged");
    assert.deepEqual(errors, [], `${viewport.width}: no page errors`);
    await context.close();
  }
});
