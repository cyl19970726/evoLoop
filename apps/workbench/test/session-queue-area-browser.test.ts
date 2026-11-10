// Opt-in built-app regression (build the workbench, then set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE): twelve queued Leader
// notices must not squeeze the conversation to nothing. The queue is bounded (three rows, “还有 N 条” for the rest, its own
// scroll when opened), the timeline keeps a scrollable height, the composer stays on screen, each row is a Chinese summary
// with the original behind “原文与标识”, and 撤回 still works — at 1195×914 and 390×844. Without a queue nothing is added.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { timelineAssistant, timelineMessage, timelinePage } from "./session-timeline-fixtures";

const modulePath = process.env.EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE;
const shots = process.env.EVOLOOP_QUEUE_SCREENSHOT_DIR;
const dist = resolve(import.meta.dirname, "../dist");
const projectId = "97000001-0000-4000-8000-000000000001";
const id = (n: number) => `97000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const sessionId = id(2), sessionKey = `owned:${sessionId}`;
const stamp = new Date(Date.now() - 64_000).toISOString();
const metadata = { generatedAt: stamp, sourceObservedAt: stamp, partial: false, limitations: [] };
const unavailable = { available: false, reason: "未开放" };
const resources = Object.fromEntries(["configuredModel", "actualModel", "inputTokens", "outputTokens", "cost", "processMemory"]
  .map(key => [key, { value: null, unit: "", source: null, scope: "session", observedAt: null, interval: null, unavailableReason: "未记录" }]));
const roles = [{ id: id(20), title: "项目统筹", state: "active", roleClass: "business", templateKey: null, responsibility: "统筹" }];
const leader = { key: sessionKey, target: { kind: "owned", sessionId }, aliases: [], title: "统筹", profile: null, identity: null, kind: "owned", roles,
  membership: "current", membershipReason: "fixture", runtimeState: "ready", busy: true, currentTask: null, latestBusinessRun: null, lastProgressAt: stamp,
  capabilities: { observe: { available: true, reason: null }, send: { available: true, reason: null, mode: "owned-conversation" },
    open: { ...unavailable, ref: null }, interrupt: unavailable, close: unavailable,
    ordinaryExecution: { state: "unverified", reasonCode: "fixture", reason: "执行前仍须核验。", observedAt: stamp } },
  source: { kind: "session", id: sessionId, revision: null, evidence: "project-record", href: "" }, metadata };
const taskIdOf = (n: number) => id(1000 + n);
const taskTitle = (n: number) => `第 ${n} 个新任务`;
const notice = (n: number) => `A Task was created for Leader triage.\nSource event: ${id(2000 + n)} at 2026-11-10T13:${String(10 + n).padStart(2, "0")}:00.000Z`
  + `\nSource Task revision: ${taskIdOf(n)}@${id(3000 + n)}\nSource actor: dev-claude-agent; source Session: ${id(4000 + n)}\nSource: task:${taskIdOf(n)}`
  + "\nThis is a historical source event that may have been superseded. Next responsibility: Leader reads the current Task, fixed source and any existing arrangement, then saves the next decision. This notice is not current acceptance, consumer use, or Task closure.";
const queuedId = (n: number) => id(500 + n);
const runningTurn = { id: "turn-2", state: "running", startedAt: stamp, completedAt: null, origin: { kind: "message", id: id(7), taskId: null, taskRevisionId: null, initiatingActorId: "reader" } };
const history = Array.from({ length: 30 }, (_, index) => [
  timelineMessage(`ask-${index}`, `第 ${index + 1} 个问题：请核对这一项并写出结论。`, { turnId: `turn-h${index}` }),
  timelineAssistant(`answer-${index}`, `第 ${index + 1} 个回答：已核对，结论如下。\n\n- 要点一\n- 要点二\n- 要点三`, { turnId: `turn-h${index}`, author: { kind: "session", id: sessionId, label: "统筹" } }),
]).flat();

async function run(queued: number, t: import("node:test").TestContext, withdrawals: string[]) {
  const { chromium } = (await import(pathToFileURL(modulePath!).href)).default;
  const pending = Array.from({ length: queued }, (_, index) => timelineMessage(queuedId(index + 1), notice(index + 1),
    { state: "pending", origin: { kind: "message", id: queuedId(index + 1), taskId: taskIdOf(index + 1), taskRevisionId: id(3000 + index + 1), initiatingActorId: "reader" } }));
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, "http://127.0.0.1"); const root = `/api/projects/${projectId}`;
    if (url.pathname.startsWith("/api/")) {
      let value: unknown = { items: [], nextCursor: null, metadata }, status = 200;
      const body = async () => { let text = ""; for await (const chunk of req) text += String(chunk); return JSON.parse(text) as Record<string, unknown>; };
      const taskMatch = new RegExp(`^${root}/tasks/${id(1000).slice(0, -4)}(\\d{4})$`).exec(url.pathname);
      if (url.pathname === "/api/session") value = { principal: { actorId: "reader", projectIds: [projectId], permissions: ["read", "write", "review"] }, capabilities: {} };
      else if (url.pathname === root) value = { id: projectId, title: "队列测试项目", createdAt: stamp };
      else if (url.pathname === "/api/commands" && req.method === "POST") {
        const command = await body(); if (command.type === "session.message.cancel") withdrawals.push(String(command.messageId));
        value = { status: "applied", operationId: command.operationId, entityId: String(command.messageId ?? "x"), version: 1 };
      } else if (url.pathname === `${root}/sessions/${sessionId}/direct-input-capability`)
        value = { available: false, mode: null, expectedTurnId: null, reasonCode: "DIRECT_STEER_DISABLED", observedAt: stamp };
      else if (url.pathname === `${root}/session-work`) value = { items: [leader], nextCursor: null, observationCursor: "1", metadata,
        totals: { current: 1, historical: 0, unclassified: 0 }, attention: { unansweredQuestions: 0, pendingMessages: 0, pendingAcceptance: null, unclassifiedSessions: 0 } };
      else if (url.pathname === `${root}/session-work/${encodeURIComponent(sessionKey)}`) value = { session: leader, observationCursor: "1", currentWork: null,
        assignments: [], roleTasks: [], queue: [], results: [], questions: [], activity: [], resources, metadata };
      else if (url.pathname === `${root}/session-work/${encodeURIComponent(sessionKey)}/timeline`)
        value = timelinePage(sessionKey, { title: "统筹", entries: history, pending, turns: [], liveTurns: [runningTurn], activeTurnId: "turn-2" });
      else if (url.pathname.endsWith("/timeline/updates")) value = { cursor: "1", resetRequired: false, entries: [], turns: [runningTurn], freshness: "live", limitations: [], activeTurnId: "turn-2" };
      else if (url.pathname.startsWith(`${root}/session-messages/`)) {
        const messageId = url.pathname.split("/").at(-1)!;
        value = { message: { projectId, id: messageId, operationId: messageId, target: { kind: "owned", sessionId }, senderActorId: "reader", content: "x", context: null,
          replyToMessageId: null, state: "queued", version: 3, blockedReason: null, readReceipt: null, createdAt: stamp, updatedAt: stamp }, processing: null, metadata };
      } else if (taskMatch) { const n = Number(taskMatch[1]) - 1000; value = { task: { projectId, id: taskIdOf(n), title: taskTitle(n), state: "todo", version: 1 } }; }
      else if (url.pathname.endsWith("/recovery")) { status = 404; value = { message: "无恢复记录" }; }
      else if (url.pathname === `${root}/runtime/runs` || url.pathname === `${root}/runtime/sessions` || url.pathname === `${root}/resident-queues`) value = [];
      else if (url.pathname === `${root}/runtime`) value = { available: true, error: null, allowedCwds: [], grants: [] };
      else if (url.pathname.startsWith(`${root}/work-management/tasks/`) || url.pathname.startsWith(`${root}/roles/`)) { status = 404; value = { message: "未登记" }; }
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
  const browser = await chromium.launch({ headless: true, ...(process.env.EVOLOOP_BROWSER_TEST_EXECUTABLE_PATH ? { executablePath: process.env.EVOLOOP_BROWSER_TEST_EXECUTABLE_PATH } : {}) });
  t.after(() => browser.close());
  return { base: `http://127.0.0.1:${(server.address() as { port: number }).port}`, browser };
}

// A string, not a function: the test runner's transform would add helpers that do not exist in the page.
const measure = `(() => {
  const rect = selector => { const node = document.querySelector(selector); return node ? node.getBoundingClientRect() : null; };
  const timeline = document.querySelector(".workspace-timeline-scroll");
  const queue = document.querySelector("[data-queued-count]");
  const list = queue ? queue.querySelector("[data-queued-list]") : null;
  const composer = rect(".session-composer-host");
  return { viewport: [innerWidth, innerHeight], overflowX: document.documentElement.scrollWidth > innerWidth,
    timeline: timeline && { client: timeline.clientHeight, scroll: timeline.scrollHeight },
    queue: queue && { height: Math.round(queue.getBoundingClientRect().height), rows: list ? list.children.length : 0, listClient: list ? list.clientHeight : 0, listScroll: list ? list.scrollHeight : 0 },
    composer: composer && { top: Math.round(composer.top), bottom: Math.round(composer.bottom), height: Math.round(composer.height) } };
})()`;

for (const viewport of [{ width: 1195, height: 914 }, { width: 390, height: 844 }]) {
  test(`${viewport.width}px: twelve queued notices keep the timeline scrollable and the composer on screen, with Chinese summaries and withdrawal`,
    { skip: !modulePath && "Set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE after building the workbench" }, async t => {
    const withdrawals: string[] = [];
    const { base, browser } = await run(12, t, withdrawals);
    const page = await (await browser.newContext({ viewport })).newPage();
    const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
    await page.goto(`${base}/p/${projectId}/sessions?${new URLSearchParams({ session: sessionKey })}`);
    await page.getByLabel("访问令牌").fill("fixture-token");
    await page.getByRole("button", { name: "进入", exact: true }).click();
    const queue = page.getByRole("region", { name: "排队消息" });
    await queue.waitFor();
    // Layout first: this is what the notices broke (timeline squeezed to 0, composer pushed off screen).
    const folded = await page.evaluate(measure);
    assert.equal(folded.overflowX, false, "nothing scrolls sideways");
    assert.ok(folded.timeline!.client >= 150, `timeline keeps a readable height: ${JSON.stringify(folded)}`);
    assert.ok(folded.timeline!.scroll > folded.timeline!.client, "the timeline has more to read than it shows");
    assert.ok(folded.queue!.height <= folded.viewport[1] * 0.4, `queue stays bounded: ${JSON.stringify(folded)}`);
    assert.ok(folded.composer!.bottom <= folded.viewport[1] && folded.composer!.height > 40, `composer on screen: ${JSON.stringify(folded)}`);
    await queue.getByText(taskTitle(1)).waitFor();
    // Folded: three rows and “还有 9 条”; the queue is still there (never hidden), with its count.
    assert.match(await queue.innerText(), /排队中 12 条/);
    assert.equal(await queue.locator("li").count(), 3);
    await queue.getByRole("button", { name: "还有 9 条 · 展开" }).waitFor();
    // Chinese summary: kind, task title, time — no raw English notice or long IDs in the row.
    const firstRow = await queue.locator("li").first().innerText();
    assert.match(firstRow, /新 Task 待安排 · 第 1 个新任务 · 2026\/11\/10/);
    const rowText = await queue.locator("li").first().evaluate(node => { const clone = node.cloneNode(true) as HTMLElement; clone.querySelectorAll("details").forEach(d => d.remove()); return clone.textContent ?? ""; });
    assert.doesNotMatch(rowText, /A Task was created|Source event|[0-9a-f]{8}-[0-9a-f]{4}-/);
    // The original is one click away.
    const details = queue.locator("li").first().locator("details");
    assert.equal(await details.evaluate(node => (node as HTMLDetailsElement).open), false);
    await details.locator("summary").click();
    await details.getByText(/A Task was created for Leader triage\.[\s\S]*Source event/).waitFor();
    await details.locator("summary").click();

    await page.getByRole("combobox", { name: "消息" }).fill("队列很长时也能输入");
    assert.equal(await page.getByRole("combobox", { name: "消息" }).inputValue(), "队列很长时也能输入");

    // Opened: all twelve, inside their own bounded, scrolling area.
    await queue.getByRole("button", { name: "还有 9 条 · 展开" }).click();
    assert.equal(await queue.locator("li").count(), 12);
    const opened = await page.evaluate(measure);
    assert.ok(opened.queue!.height <= opened.viewport[1] * 0.4, `opened queue stays bounded: ${JSON.stringify(opened)}`);
    assert.ok(opened.queue!.listScroll > opened.queue!.listClient, "the opened queue scrolls inside itself");
    assert.ok(opened.timeline!.client >= 120, `timeline still has height with the queue open: ${JSON.stringify(opened)}`);
    assert.ok(opened.composer!.bottom <= opened.viewport[1], "composer still on screen with the queue open");
    await queue.locator("[data-queued-list]").evaluate(node => { node.scrollTop = node.scrollHeight; });
    await queue.getByText(taskTitle(12)).waitFor();
    // The timeline reaches both ends.
    const ends = await page.locator(".workspace-timeline-scroll").evaluate(async node => {
      node.scrollTop = 0; await new Promise(done => setTimeout(done, 50)); const top = node.scrollTop;
      node.scrollTop = node.scrollHeight; await new Promise(done => setTimeout(done, 50));
      return { top, bottomGap: node.scrollHeight - node.clientHeight - node.scrollTop };
    });
    assert.deepEqual([ends.top, Math.round(ends.bottomGap) <= 2], [0, true], "scrolls to the earliest and the latest");
    await page.getByText("第 1 个问题").first().waitFor({ state: "attached" });
    if (shots) { await page.screenshot({ path: `${shots}/queue-open-${viewport.width}.png` }); await writeFile(`${shots}/measure-${viewport.width}.json`, JSON.stringify({ folded, opened }, null, 1)); }
    // Fold again.
    await queue.getByRole("button", { name: "收起" }).click();
    assert.equal(await queue.locator("li").count(), 3);
    // Withdraw still works, and names the message it withdraws.
    await queue.getByRole("button", { name: "撤回" }).first().click();
    await page.getByText("已撤回，正在读取消息记录。").waitFor();
    assert.deepEqual(withdrawals, [queuedId(1)]);
    assert.deepEqual(errors, []);
  });
}

test("without queued messages there is no queue area and the conversation keeps its height",
  { skip: !modulePath && "Set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE after building the workbench" }, async t => {
  const { base, browser } = await run(0, t, []);
  for (const viewport of [{ width: 1195, height: 914 }, { width: 390, height: 844 }]) {
    const page = await (await browser.newContext({ viewport })).newPage();
    await page.goto(`${base}/p/${projectId}/sessions?${new URLSearchParams({ session: sessionKey })}`);
    await page.getByLabel("访问令牌").fill("fixture-token");
    await page.getByRole("button", { name: "进入", exact: true }).click();
    await page.getByRole("combobox", { name: "消息" }).waitFor();
    assert.equal(await page.getByRole("region", { name: "排队消息" }).count(), 0);
    const plain = await page.evaluate(measure);
    assert.equal(plain.queue, null);
    assert.ok(plain.timeline!.client >= 250, JSON.stringify(plain));
    assert.ok(plain.composer!.bottom <= plain.viewport[1]);
  }
});
