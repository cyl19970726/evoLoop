// Opt-in built-app regression: build workbench, then set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE.
// The agent page's composer at 1440, 1024 and 390: Enter adds to the running turn where the runtime says it can,
// Cmd/Ctrl+Enter queues an ordinary message, the stop button interrupts the turn, / lists skills and commands, @ sends a
// copy to another agent, and where the runtime cannot take additions Enter queues and says so. The checklist and the
// queued messages sit above the composer, which stays fully visible; the agents drawer keeps the account row below a
// long list. EVOLOOP_AGENT_SCREENSHOT_DIR saves a screenshot per width.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
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
const sessionId = id(2), otherId = id(3), leaderId = id(4), taskId = id(5), queuedId = id(6), runningMessageId = id(7), processingId = id(8), runId = id(10);
const sessionKey = `owned:${sessionId}`;
const stamp = new Date(Date.now() - 64_000).toISOString();
const metadata = { generatedAt: stamp, sourceObservedAt: stamp, partial: false, limitations: [] };
const unavailable = { available: false, reason: "未开放" };
const resources = Object.fromEntries(["configuredModel", "actualModel", "inputTokens", "outputTokens", "cost", "processMemory"]
  .map(key => [key, { value: null, unit: "", source: null, scope: "session", observedAt: null, interval: null, unavailableReason: "未记录" }]));
const role = (n: number, title: string, roleClass: "business" | "system") => ({ id: id(n), title, state: "active", roleClass, templateKey: null, responsibility: `${title}职责` });
const internalWords = /\b(Session|Turn|Run|Thread|Agent|queue|operation|assignment|nextAction)\b|PG/;

function agent(n: number, title: string, roles: ReturnType<typeof role>[], busy: boolean) {
  const sid = id(n);
  return { key: `owned:${sid}`, target: { kind: "owned", sessionId: sid }, aliases: [], title, profile: null, identity: null, kind: "owned", roles,
    membership: "current", membershipReason: "fixture", runtimeState: "ready", busy, currentTask: null, latestBusinessRun: null, lastProgressAt: stamp,
    capabilities: { observe: { available: true, reason: null }, send: { available: true, reason: null, mode: "owned-conversation" },
      open: { ...unavailable, ref: null }, interrupt: unavailable, close: unavailable,
      ordinaryExecution: { state: "unverified", reasonCode: "fixture", reason: "执行前仍须核验。", observedAt: stamp } },
    source: { kind: "session", id: sid, revision: null, evidence: "project-record", href: "" }, metadata };
}

test("the composer sends, adds, queues, stops, lists skills and agents, and says when it cannot add, at three widths", {
  skip: !modulePath && "Set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE after building the workbench",
}, async t => {
  const { chromium } = (await import(pathToFileURL(modulePath!).href)).default;
  const commands: Array<Record<string, unknown>> = [];
  const directInputs: Array<Record<string, unknown>> = [];
  let steer = true, canSave = true, loseCopy = false, itemRecorded = false;
  const currentTask = { id: taskId, title: "新版智能体页", state: "in_progress", revisionId: id(9), owner: "前端实现", relation: "accepted",
    source: { kind: "task", id: taskId, revision: null, evidence: "project-record", href: "" } };
  const self = { ...agent(2, "前端实现", [role(20, "前端实现", "business")], true), currentTask };
  const externalKey = `external:${id(50)}`;
  const external = { ...agent(50, "外部协作者", [role(23, "外部协作", "business")], false), key: externalKey, kind: "external",
    target: { kind: "external", linkId: id(50) }, runtimeState: null, busy: null,
    capabilities: { observe: { available: true, reason: null }, send: { available: true, reason: null, mode: "manual-handoff" },
      open: { ...unavailable, ref: null }, interrupt: unavailable, close: unavailable,
      ordinaryExecution: { state: "manual", reasonCode: "EXTERNAL_HANDOFF", reason: "需人工转交原会话。", observedAt: stamp } } };
  const directory = [self, agent(3, "架构", [role(21, "架构", "business")], false), agent(4, "统筹", [role(22, "统筹", "system")], false),
    ...Array.from({ length: 30 }, (_, index) => agent(100 + index, `业务智能体 ${index + 1}`, [role(200 + index, `职责 ${index + 1}`, "business")], false))];
  const runningTurn = { id: "turn-2", state: "running", startedAt: stamp, completedAt: null,
    origin: { kind: "message", id: runningMessageId, taskId: null, taskRevisionId: null, initiatingActorId: "reader" } };
  const finishedTurn = { id: "turn-1", state: "completed", startedAt: stamp, completedAt: stamp, origin: null };
  const plan = { id: "plan:turn-2", kind: "plan", label: "Plan", body: "先读再改\n1. [completed] 读取设计文档\n2. [inProgress] 重写输入框\n3. [pending] 跑浏览器测试",
    state: "running", turnId: "turn-2", nativeItemId: null, nativeKind: "turnPlanUpdated", author: { kind: "session", id: sessionId, label: "前端实现" },
    origin: null, occurredAt: null, observedAt: stamp, freshness: "live", truncated: false };
  const entries = [
    timelineMessage("first", "请把输入框换成新组件。", { turnId: "turn-1" }),
    timelineAssistant("reply-1", "好的，我先读设计文档。", { turnId: "turn-1", author: { kind: "session", id: sessionId, label: "前端实现" } }),
    timelineTool("tool-1", "Read file", "Read file docs/frontend/pages/sessions.md", "completed", { turnId: "turn-1" }),
    timelineTool("tool-2", "Command", "Command", "failed", { turnId: "turn-1" }),
    timelineMessage(runningMessageId, "现在重写右栏。", { turnId: "turn-2", state: "running" }),
    plan,
    timelineTool("tool-3", "Command", "Command", "running", { turnId: "turn-2", freshness: "live" }),
  ];
  const pending = [timelineMessage(queuedId, "顺便看一下 390 宽。", { state: "pending" })];
  const live = () => ({ cursor: "1", resetRequired: false, entries: [], turns: [runningTurn], freshness: "live", limitations: [], activeTurnId: "turn-2" });
  const message = (messageId: string, state: string) => ({ message: { projectId, id: messageId, operationId: messageId, target: { kind: "owned", sessionId },
    senderActorId: "reader", content: "x", context: null, replyToMessageId: null, state, version: 3, blockedReason: null, readReceipt: null, createdAt: stamp, updatedAt: stamp },
    processing: state === "processing" ? { projectId, id: processingId, messageId, sessionId, operationId: messageId, state: "running", nativeTurnId: "turn-2",
      response: null, failure: null, version: 4, startedAt: stamp, updatedAt: stamp } : null, metadata });
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, "http://127.0.0.1");
    if (url.pathname.startsWith("/api/")) {
      const root = `/api/projects/${projectId}`;
      let value: unknown = { items: [], nextCursor: null, metadata }, status = 200;
      const body = async () => { let text = ""; for await (const chunk of req) text += String(chunk); return JSON.parse(text) as Record<string, unknown>; };
      if (url.pathname === "/api/session") value = { principal: { actorId: "reader", projectIds: [projectId], permissions: ["read", "write", "review"] }, capabilities: {} };
      else if (url.pathname === root) value = { id: projectId, title: "输入框测试项目", createdAt: stamp };
      else if (url.pathname === "/api/commands" && req.method === "POST") {
        const command = await body(); commands.push(command);
        // The answer to a copy for 架构 can be lost on the way back: its result is then unknown, not refused.
        if (loseCopy && (command.target as { sessionId?: string } | undefined)?.sessionId === otherId) { res.writeHead(200, { "content-type": "application/json" }); res.end(""); return; }
        value = { status: "applied", operationId: command.operationId, entityId: String(command.messageId ?? command.runId ?? "x"), version: 1 };
      } else if (url.pathname === `${root}/sessions/${sessionId}/direct-input-capability`) value = steer
        ? { available: true, mode: "steer", expectedTurnId: "turn-2", reasonCode: "READY_TO_STEER", observedAt: stamp }
        : { available: false, mode: null, expectedTurnId: null, reasonCode: "DIRECT_STEER_DISABLED", observedAt: stamp };
      else if (url.pathname === `${root}/sessions/${sessionId}/direct-inputs` && req.method === "POST") {
        const input = await body(); directInputs.push(input);
        value = { projectId, sessionId, inputId: input.inputId, operationId: input.operationId, actorId: "reader", mode: "steer",
          source: { kind: "message", id: runningMessageId, processingId }, expectedTurnId: input.expectedTurnId, actualTurnId: "turn-2", nativeItemId: null,   // the acknowledgement of a supplement carries no Item yet
          state: "accepted", reason: null, version: 2, createdAt: stamp, updatedAt: stamp };
      } else if (url.pathname.startsWith(`${root}/sessions/${sessionId}/direct-inputs/`)) {
        const input = directInputs.find(item => url.pathname.endsWith(String(item.inputId)));
        if (!input) { status = 404; value = { message: "Not found" }; }
        else value = { projectId, sessionId, inputId: input.inputId, operationId: input.operationId, actorId: "reader", mode: "steer",
          source: { kind: "message", id: runningMessageId, processingId }, expectedTurnId: input.expectedTurnId, actualTurnId: "turn-2", nativeItemId: itemRecorded ? "n" : null,   // the Item is recorded only after the Turn ends
          state: "accepted", reason: null, version: 2, createdAt: stamp, updatedAt: stamp };
      } else if (url.pathname === `${root}/session-work`) value = { items: directory, nextCursor: null, observationCursor: "1", metadata,
        totals: { current: directory.length, historical: 0, unclassified: 0 }, attention: { unansweredQuestions: 0, pendingMessages: 0, pendingAcceptance: null, unclassifiedSessions: 0 } };
      else if (url.pathname === `${root}/session-work/${encodeURIComponent(externalKey)}`) value = { session: external, observationCursor: "1", currentWork: null,
        assignments: [], roleTasks: [], queue: [], results: [], questions: [], activity: [], resources, metadata };
      else if (url.pathname === `${root}/session-work/${encodeURIComponent(externalKey)}/timeline`) value = timelinePage(externalKey, { title: "外部协作者", live: false });
      else if (url.pathname === `${root}/session-work/${encodeURIComponent(sessionKey)}`) value = { session: { ...self,
        capabilities: { ...self.capabilities, send: canSave ? self.capabilities.send : { available: false, reason: "这个智能体现在不收普通消息。", mode: "unavailable" } } },
        observationCursor: "1", currentWork: currentTask,
        assignments: [], roleTasks: [], queue: [], results: [], questions: [], activity: [], resources, metadata };
      else if (url.pathname === `${root}/session-work/${encodeURIComponent(sessionKey)}/timeline`) value = { ...timelinePage(sessionKey, { title: "前端实现", entries, pending,
        turns: [finishedTurn], liveTurns: [runningTurn], activeTurnId: "turn-2" }) };
      else if (url.pathname.endsWith("/timeline/updates")) value = live();
      else if (url.pathname === `${root}/session-messages/${queuedId}`) value = message(queuedId, "queued");
      else if (url.pathname === `${root}/session-messages/${runningMessageId}`) value = message(runningMessageId, "processing");
      else if (url.pathname === `${root}/roles/${id(20)}/runtime`) value = { projectId, roleId: id(20), binding: null, history: [], provider: "codex",
        providerSource: "default", availableProviders: ["codex"], providerAvailable: true, selection: { project: true, personal: false, builtin: true, add: [], remove: [] },
        selectionSource: "default", workDirectory: null, missing: [], skillsReportedBy: "files", plugins: [], mcpServers: [], notes: [], observedAtUtc: stamp,
        skills: [{ name: "frontend-design", source: "project", selected: true, reason: "switch", description: "界面设计方向", location: null, contentHash: null, delivery: "native" },
          { name: "unused-skill", source: "personal", selected: false, reason: "switch_off", description: null, location: null, contentHash: null, delivery: "none" }] };
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
  const posted = (type: string) => commands.filter(command => command.type === type);

  for (const viewport of [{ width: 1440, height: 900 }, { width: 1024, height: 768 }, { width: 390, height: 844 }]) {
    steer = true;
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    // Opened from the task: the page offers the way back to it.
    const taskPath = `/p/${projectId}/tasks/${taskId}`;
    await page.goto(`${base}/p/${projectId}/sessions?${new URLSearchParams({ session: sessionKey, return: taskPath, actor: "reader", returnTitle: "新版智能体页" })}`);
    await page.getByLabel("访问令牌").fill("fixture-token");
    await page.getByRole("button", { name: "进入", exact: true }).click();
    await page.getByRole("heading", { name: "前端实现" }).waitFor();
    const box = page.getByRole("combobox", { name: "消息" });
    await box.waitFor();
    assert.equal(await page.getByRole("link", { name: "返回任务：新版智能体页", exact: true }).getAttribute("href"), taskPath);
    // The running turn: its checklist and what runs now; my queued message above the composer, withdrawable.
    const todo = page.getByRole("region", { name: "待办清单" });
    await todo.getByText("重写输入框").waitFor();
    assert.match(await todo.innerText(), /读取设计文档[\s\S]*重写输入框[\s\S]*跑浏览器测试/);
    await page.locator(".workspace-turn-state").getByText("正在执行命令").waitFor();
    await page.getByRole("region", { name: "排队消息" }).getByText("顺便看一下 390 宽。").waitFor();
    await page.getByRole("button", { name: "停止这一轮" }).waitFor();
    await page.getByText("Enter 补充到这一轮 · ⌘/Ctrl+Enter 排到下一轮").waitFor();
    // Layout: the whole composer is on screen (above the bottom tabs on a phone) and nothing scrolls sideways.
    const layout = await page.evaluate(() => {
      const composer = document.querySelector<HTMLElement>(".session-composer-host")!.getBoundingClientRect();
      const tabs = document.querySelector<HTMLElement>("[data-shell=tabs]");
      const tabsTop = tabs && getComputedStyle(tabs).display !== "none" ? tabs.getBoundingClientRect().top : innerHeight;
      const history = document.querySelector<HTMLElement>(".workspace-timeline-scroll")!.clientHeight;
      const header = document.querySelector<HTMLElement>(".session-detail-header")!;
      const pill = header.querySelector<HTMLElement>(".session-detail-heading")!.getBoundingClientRect();
      const actions = header.querySelector<HTMLElement>(".session-workspace-actions")!.getBoundingClientRect();
      return { composerTop: composer.top, composerBottom: composer.bottom, tabsTop, history, scrollWidth: document.documentElement.scrollWidth, width: innerWidth,
        overlap: pill.right > actions.left + 1 && pill.bottom > actions.top && pill.top < actions.bottom };
    });
    assert.ok(layout.composerBottom <= layout.tabsTop + 1 && layout.composerTop >= 0, `${viewport.width}: the composer is fully visible ${JSON.stringify(layout)}`);
    assert.ok(layout.history >= (viewport.width === 390 ? 120 : 200), `${viewport.width}: the flow keeps room to read ${JSON.stringify(layout)}`);
    assert.ok(layout.scrollWidth <= layout.width, `${viewport.width}: no horizontal scroll ${JSON.stringify(layout)}`);
    assert.equal(layout.overlap, false, `${viewport.width}: the header actions do not cover the agent's name and state`);
    if (shots) await page.screenshot({ path: join(shots, `composer-${viewport.width}.png`) });
    // The right column: inline from 1100px, a drawer that opens only when asked below that.
    if (viewport.width < 1100) {
      assert.equal(await page.locator(".session-panel").isVisible(), false, `${viewport.width}: the right column does not open by itself`);
      await page.getByRole("button", { name: "展开右栏" }).click();
    }
    const panel = page.locator(".session-panel");
    await panel.getByRole("tab", { name: "动态" }).waitFor();
    await panel.getByText("新版智能体页").first().waitFor();
    assert.doesNotMatch(await panel.innerText(), internalWords, `${viewport.width}: no internal words in the right column`);
    if (shots) { await page.waitForTimeout(600); await page.screenshot({ path: join(shots, `panel-${viewport.width}.png`) }); }
    await panel.getByRole("tab", { name: "资料库" }).click();
    await panel.getByRole("heading", { name: "成果与使用" }).waitFor();
    assert.equal(new URLSearchParams(page.url().split("?")[1]).get("return"), taskPath, "switching the right column keeps the way back");
    await panel.getByRole("tab", { name: "动态" }).click();
    if (viewport.width < 1100) await page.getByRole("button", { name: "关闭右栏" }).click();
    assert.doesNotMatch(await page.locator(".unified-session-timeline").innerText(), internalWords, `${viewport.width}: no internal words in the flow`);

    // Enter while a turn runs and the runtime takes additions: the text goes into this turn.
    itemRecorded = false;   // each width starts with a supplement whose Item is not recorded yet
    const before = { direct: directInputs.length, posts: posted("session.message.post").length };
    await box.fill("把颜色改成 token");
    await page.getByRole("button", { name: "补充到这一轮" }).waitFor();
    await box.press("Enter");
    await page.waitForFunction(count => document.querySelector<HTMLTextAreaElement>("[aria-label='消息']")?.value === "" , before.direct);
    assert.equal(directInputs.length, before.direct + 1, "Enter adds to the running turn");
    assert.deepEqual([directInputs.at(-1)!.content, directInputs.at(-1)!.expectedTurnId], ["把颜色改成 token", "turn-2"]);
    await page.locator(".session-direct-receipt").getByText("运行时已接收；不代表智能体已阅读或采用").waitFor();
    itemRecorded = true;
    // The turn ends and the service reads the Item back: the page looks again and now says it was read (never "adopted").
    await page.locator(".session-direct-receipt").getByText("已读到：运行时已记录这条输入的原生条目；不代表智能体已采用").waitFor({ timeout: 20_000 });
    assert.doesNotMatch(await page.locator(".session-direct-receipt").innerText(), /(?<!不代表智能体)已采用/, "never claims adoption");
    // Cmd/Ctrl+Enter: an ordinary message for the next turn, tied to the current task.
    await box.fill("下一轮再处理窄屏");
    await box.press(process.platform === "darwin" ? "Meta+Enter" : "Control+Enter");
    await page.getByText("已保存，正在读取持久记录。").waitFor();
    const queuedPost = posted("session.message.post").at(-1)!;
    assert.equal(posted("session.message.post").length, before.posts + 1);
    assert.deepEqual([queuedPost.content, queuedPost.context], ["下一轮再处理窄屏", { taskId, taskRevisionId: currentTask.revisionId }]);
    assert.equal(directInputs.length, before.direct + 1, "Cmd/Ctrl+Enter never goes through the runtime's additions");

    // / lists the role's selected skills and the commands; choosing a skill names it in the message.
    await box.fill("/");
    const commandMenu = page.getByRole("listbox", { name: "技能与命令" });
    await commandMenu.getByText("frontend-design").waitFor();
    assert.equal(await commandMenu.getByText("unused-skill").count(), 0, "a skill the role does not load is not offered");
    await commandMenu.getByText("停止这一轮").waitFor();
    await commandMenu.getByText("撤回排队消息").waitFor();
    await commandMenu.getByText("frontend-design").click();
    await page.getByText("技能 · frontend-design").waitFor();
    await box.fill("按设计方向检查右栏");
    await box.press("Control+Enter");
    await page.waitForFunction(() => document.querySelector<HTMLTextAreaElement>("[aria-label='消息']")?.value === "");
    assert.equal(posted("session.message.post").at(-1)!.content, "使用技能：frontend-design（项目）\n按设计方向检查右栏");

    // @ lists other agents (统筹 after them) and sends a copy of the message to the chosen one.
    await box.fill("请 @");
    const agentMenu = page.getByRole("listbox", { name: "选择智能体" });
    await agentMenu.getByText("架构", { exact: true }).waitFor();
    assert.equal(await agentMenu.getByText("前端实现", { exact: true }).count(), 0, "the agent on this page is not offered");
    const names = await agentMenu.getByRole("option").allInnerTexts();
    assert.ok(names.findIndex(text => text.includes("统筹")) > names.findIndex(text => text.includes("架构")), "统筹 is listed after the business agents");
    await agentMenu.getByText("架构", { exact: true }).click();
    await page.waitForFunction(() => document.querySelector<HTMLTextAreaElement>("[aria-label='消息']")?.value === "请 @架构 ");
    await page.waitForTimeout(100);
    await box.press("End");
    await box.type("看一下右栏的数据");
    const postsBeforeMention = posted("session.message.post").length;
    await box.press("Control+Enter");
    await page.getByText("已另发一份给 架构。", { exact: false }).waitFor();
    assert.equal(posted("session.message.post").length - postsBeforeMention, 2, "exactly one message and one copy");
    const [mine, copy] = posted("session.message.post").slice(postsBeforeMention);
    assert.deepEqual([mine?.target, copy?.target], [{ kind: "owned", sessionId }, { kind: "owned", sessionId: otherId }]);
    assert.equal(copy?.content, "请 @架构 看一下右栏的数据");

    // Withdraw the queued message from above the composer.
    await page.getByRole("region", { name: "排队消息" }).getByRole("button", { name: "撤回" }).click();
    await page.getByText("已撤回，正在读取消息记录。").waitFor();
    assert.deepEqual([posted("session.message.cancel").at(-1)?.messageId, posted("session.message.cancel").at(-1)?.expectedVersion], [queuedId, 3]);

    // Stop: with an empty box the send button becomes 停止这一轮; confirming interrupts this turn's message processing.
    await box.fill("");
    await page.getByRole("button", { name: "停止这一轮" }).click();
    const dialog = page.getByRole("dialog", { name: "停止这一轮" });
    await dialog.getByRole("button", { name: "停止这一轮" }).click();
    await dialog.waitFor({ state: "detached" });
    const interrupt = posted("session.message.interrupt").at(-1)!;
    assert.deepEqual([interrupt.messageId, interrupt.sessionId, interrupt.processingId, interrupt.nativeTurnId, interrupt.expectedMessageVersion, interrupt.expectedProcessingVersion],
      [runningMessageId, sessionId, processingId, "turn-2", 3, 4]);

    // A runtime that cannot take additions: Enter queues for the next turn, and the page says why.
    steer = false;
    await page.getByRole("button", { name: "重新读取", exact: true }).click();
    await page.getByText("这个智能体的即时输入授权不包含补入这一轮，需要在私有配置里为它开启补入；Enter 排到下一轮").waitFor({ timeout: 8000 });
    await box.fill("没法补充时排队");
    await page.getByRole("button", { name: "发送，排到下一轮" }).waitFor();
    const directBefore = directInputs.length;
    await box.press("Enter");
    await page.waitForFunction(() => document.querySelector<HTMLTextAreaElement>("[aria-label='消息']")?.value === "");
    assert.equal(directInputs.length, directBefore, "without the runtime's support nothing is added to the running turn");
    assert.equal(posted("session.message.post").at(-1)!.content, "没法补充时排队");
    if (shots) await page.screenshot({ path: join(shots, `composer-no-steer-${viewport.width}.png`) });
    // Cmd/Ctrl+Enter where the runtime still runs the turn: also queued as an ordinary message, never added to the turn.
    await box.fill("不支持补充时也能排队");
    await box.press("Control+Enter");
    await page.waitForFunction(() => document.querySelector<HTMLTextAreaElement>("[aria-label='消息']")?.value === "");
    assert.equal(directInputs.length, directBefore);
    assert.equal(posted("session.message.post").at(-1)!.content, "不支持补充时也能排队");

    // No ordinary message can be saved but the turn takes additions: Cmd/Ctrl+Enter does nothing and says why.
    steer = true; canSave = false;
    await page.getByRole("button", { name: "重新读取", exact: true }).click();
    await page.getByText("Enter 补充到这一轮", { exact: true }).waitFor({ timeout: 8000 });
    const noQueue = { direct: directInputs.length, posts: commands.length };
    await box.fill("不能排队的一句");
    await box.press("Control+Enter");
    await page.getByText("现在不能排到下一轮：这个智能体现在不收普通消息。").waitFor();
    assert.deepEqual([directInputs.length, commands.length], [noQueue.direct, noQueue.posts], "Cmd/Ctrl+Enter neither adds to the turn nor saves");
    assert.equal(await box.inputValue(), "不能排队的一句");
    await box.fill("");
    canSave = true;

    // A turn started by a task run: stopping it interrupts that run.
    runningTurn.origin = { kind: "run", id: runId, taskId, taskRevisionId: currentTask.revisionId, initiatingActorId: null } as typeof runningTurn.origin;
    await page.waitForTimeout(2000);
    await page.getByRole("button", { name: "停止这一轮" }).click();
    const runDialog = page.getByRole("dialog", { name: "停止这一轮" });
    await runDialog.getByText("请求中断这次任务运行", { exact: false }).waitFor();
    await runDialog.getByRole("button", { name: "停止这一轮" }).click();
    await runDialog.waitFor({ state: "detached" });
    assert.equal(posted("runtime.run.interrupt").at(-1)?.runId, runId);
    runningTurn.origin = { kind: "message", id: runningMessageId, taskId: null, taskRevisionId: null, initiatingActorId: "reader" } as typeof runningTurn.origin;

    if (viewport.width === 390) {
      // The agents drawer: a long list scrolls with the drawer and the account row stays below it.
      await page.getByRole("button", { name: "打开项目导航" }).click();
      const drawer = page.locator(".mobile-navigation");
      await drawer.locator(".session-nav-item").filter({ hasText: "业务智能体 30" }).waitFor();
      const geometry = await drawer.evaluate(element => {
        const items = [...element.querySelectorAll<HTMLElement>(".session-nav-item")];
        const account = element.querySelector<HTMLElement>("aside > div:last-child")!;
        return { lastItemBottom: Math.max(...items.map(item => item.getBoundingClientRect().bottom + element.scrollTop)),
          accountTop: account.getBoundingClientRect().top + element.scrollTop, scrollable: element.scrollHeight > element.clientHeight };
      });
      assert.ok(geometry.scrollable && geometry.accountTop >= geometry.lastItemBottom - 1, `the account row stays below the agent list: ${JSON.stringify(geometry)}`);
      if (shots) await page.screenshot({ path: join(shots, "composer-drawer-390.png") });
    }
    if (viewport.width === 1440) {
      // An external agent: the message is actually saved for manual handoff.
      await page.goto(`${base}/p/${projectId}/sessions?session=${encodeURIComponent(externalKey)}`);
      await page.getByLabel("访问令牌").fill("fixture-token");
      await page.getByRole("button", { name: "进入", exact: true }).click();
      await page.getByRole("heading", { name: "外部协作者" }).waitFor();
      await page.getByText("Enter 保存，保存后需人工转交").waitFor();
      await page.getByRole("combobox", { name: "消息" }).fill("请转交给外部协作者");
      await page.getByRole("combobox", { name: "消息" }).press("Enter");
      await page.getByText("已保存，正在读取持久记录。").waitFor();
      assert.deepEqual([posted("session.message.post").at(-1)?.target, posted("session.message.post").at(-1)?.content],
        [{ kind: "external", linkId: id(50) }, "请转交给外部协作者"]);

      // @ whose copy has an unknown result: said as unconfirmed, with the way to check it, never as failed; sent once.
      await page.goto(`${base}/p/${projectId}/sessions?session=${encodeURIComponent(sessionKey)}`);
      await page.getByLabel("访问令牌").fill("fixture-token");
      await page.getByRole("button", { name: "进入", exact: true }).click();
      await page.getByRole("heading", { name: "前端实现" }).waitFor();
      loseCopy = true;
      const mention = page.getByRole("combobox", { name: "消息" });
      await mention.fill("@");
      await page.getByRole("listbox", { name: "选择智能体" }).getByText("架构", { exact: true }).click();
      await page.waitForFunction(() => document.querySelector<HTMLTextAreaElement>("[aria-label='消息']")?.value === "@架构 ");
      await page.waitForTimeout(100);
      await mention.press("End");
      await mention.type("结果会丢的一份");
      const postsBefore = posted("session.message.post").length;
      await mention.press("Control+Enter");
      await page.getByText("另发给 架构 的结果未确认", { exact: false }).waitFor();
      assert.equal(await page.getByText("没有成功", { exact: false }).count(), 0, "an unknown copy is not called a failure");
      assert.equal(await page.getByRole("link", { name: "按原操作核对" }).count(), 1);
      await page.waitForTimeout(500);
      assert.equal(posted("session.message.post").length - postsBefore, 2, "the message and its copy are each sent once");
      loseCopy = false;
    }
    assert.deepEqual(errors, []);
    await context.close();
  }
});

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
// Mirrors core's canonicalJson, so the lost answer can be confirmed by its operation digest.
const canonical = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonical).join(",")}]`
  : value && typeof value === "object" ? `{${Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}` : JSON.stringify(value);

test("a send whose answer was lost, once checked as received or applied, clears the composer and is never sent again", {
  skip: !modulePath && "Set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE after building the workbench",
}, async t => {
  const { chromium } = (await import(pathToFileURL(modulePath!).href)).default;
  const directPosts: Array<Record<string, unknown>> = [];
  const commandPosts: Array<Record<string, unknown>> = [];
  const operations = new Map<string, unknown>();
  let receipt: Record<string, unknown> | null = null;
  const idle = { ...agent(2, "前端实现", [role(20, "前端实现", "business")], false), currentTask: null };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, "http://127.0.0.1");
    const root = `/api/projects/${projectId}`;
    const json = (value: unknown, status = 200) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
    const body = async () => { let text = ""; for await (const chunk of req) text += String(chunk); return JSON.parse(text) as Record<string, unknown>; };
    if (url.pathname.startsWith("/api/")) {
      if (url.pathname === "/api/session") return json({ principal: { actorId: "reader", projectIds: [projectId], permissions: ["read", "write", "review"] }, capabilities: {} });
      if (url.pathname === root) return json({ id: projectId, title: "输入框测试项目", createdAt: stamp });
      if (url.pathname === "/api/commands" && req.method === "POST") {
        // The ordinary message is applied, but its answer is lost on the way back.
        const command = await body(); commandPosts.push(command);
        operations.set(String(command.operationId), { id: command.operationId, projectId, actorId: "reader", commandType: command.type,
          commandHash: sha(canonical({ actorId: "reader", command })), createdAt: stamp,
          result: { status: "applied", operationId: command.operationId, entityId: command.messageId } });
        res.writeHead(200, { "content-type": "application/json" }); res.end(""); return;
      }
      if (url.pathname.startsWith(`${root}/operations/`)) {
        const operation = operations.get(url.pathname.split("/").at(-1)!);
        return json(operation ?? { code: "OPERATION_NOT_FOUND", message: "没有这个操作" }, operation ? 200 : 404);
      }
      const direct = `${root}/sessions/${sessionId}`;
      if (url.pathname === `${direct}/direct-input-capability`) return json({ available: true, mode: "start", expectedTurnId: null, reasonCode: "READY_TO_START", observedAt: stamp });
      if (url.pathname === `${direct}/direct-inputs` && req.method === "POST") {
        // The runtime receives it, but the answer is cut: the page only learns it by checking the original input.
        const input = await body(); directPosts.push(input);
        receipt = { projectId, sessionId, inputId: input.inputId, operationId: input.operationId, actorId: "reader", mode: "start",
          source: { kind: "message", id: input.inputId, processingId: null }, expectedTurnId: null, actualTurnId: null, nativeItemId: null,
          state: "unknown", reason: null, version: 1, createdAt: stamp, updatedAt: stamp };
        res.writeHead(200, { "content-type": "application/json" }); res.end("{"); return;
      }
      if (url.pathname.startsWith(`${direct}/direct-inputs/`)) {
        if (!receipt || !url.pathname.includes(String(receipt.inputId))) return json({ message: "Not found" }, 404);
        if (url.pathname.endsWith("/reconcile")) receipt = { ...receipt, state: "accepted", actualTurnId: "turn-9", nativeItemId: "item-9", version: 2 };
        return json(receipt);
      }
      if (url.pathname === `${root}/session-work`) return json({ items: [idle], nextCursor: null, observationCursor: "1", metadata,
        totals: { current: 1, historical: 0, unclassified: 0 }, attention: { unansweredQuestions: 0, pendingMessages: 0, pendingAcceptance: null, unclassifiedSessions: 0 } });
      if (url.pathname === `${root}/session-work/${encodeURIComponent(sessionKey)}`) return json({ session: idle, observationCursor: "1", currentWork: null,
        assignments: [], roleTasks: [], queue: [], results: [], questions: [], activity: [], resources, metadata });
      if (url.pathname === `${root}/session-work/${encodeURIComponent(sessionKey)}/timeline`) return json(timelinePage(sessionKey, { title: "前端实现" }));
      if (url.pathname.endsWith("/timeline/updates")) return json({ cursor: "1", resetRequired: false, entries: [], turns: [], freshness: "live", limitations: [], activeTurnId: null });
      if (url.pathname.endsWith("/recovery")) return json({ message: "无恢复记录" }, 404);
      if (url.pathname === `${root}/runtime`) return json({ available: true, error: null, allowedCwds: [], grants: [] });
      return json({ items: [], nextCursor: null, metadata });
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
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(`${base}/p/${projectId}/sessions?session=${encodeURIComponent(sessionKey)}`);
  await page.getByLabel("访问令牌").fill("fixture-token");
  await page.getByRole("button", { name: "进入", exact: true }).click();
  const box = page.getByRole("combobox", { name: "消息" });
  const boxValue = () => box.inputValue();

  // 即时输入: the answer is lost; the draft stays and nothing can be sent until the original input is checked.
  await page.getByText("Enter 立即开始一轮 · ⌘/Ctrl+Enter 保存为排队消息").waitFor();
  await box.fill("第一条即时输入");
  await box.press("Enter");
  await page.getByText("发送结果未知，需核对原操作").waitFor();
  assert.equal(await boxValue(), "第一条即时输入", "an unknown result keeps the draft");
  assert.equal(await page.getByRole("button", { name: "发送", exact: true }).isDisabled(), true);
  // Checked by its original input: received, so the box and its kept draft are cleared.
  await page.getByRole("button", { name: "核对结果（不会重发）" }).click();
  await page.getByText("已读到：运行时已记录这条输入的原生条目；不代表智能体已采用").waitFor();   // the checked receipt carries its Item
  await page.waitForFunction(() => document.querySelector<HTMLTextAreaElement>("[aria-label='消息']")?.value === "");
  await box.press("Enter");
  await page.getByRole("link", { name: "统筹安排" }).first().click();
  await page.getByRole("heading", { name: "统筹安排", exact: true }).waitFor();
  await page.goBack();
  await box.waitFor();
  assert.equal(await boxValue(), "", "coming back does not bring the sent text back");
  assert.equal(directPosts.length, 1, "the received input is never sent again");
  assert.equal(commandPosts.length, 0, "a 即时输入 never goes out as an ordinary message");

  // Ordinary message: the answer is lost; the project waits for the operation to be checked by its original ID.
  await box.fill("第二条普通消息");
  await box.press("Control+Enter");
  await page.getByRole("link", { name: "按原操作 ID 核对" }).first().waitFor();
  assert.equal(await boxValue(), "第二条普通消息", "an unknown result keeps the draft");
  assert.equal(await box.isDisabled(), true, "nothing else is sent while the result is unknown");
  await page.getByRole("link", { name: "按原操作 ID 核对" }).first().click();
  await page.getByRole("button", { name: "按操作 ID 核对" }).click();
  await page.getByText(/已应用；正在回读当前数据/).waitFor();
  await page.goBack();
  await page.getByText("原操作已核对为已应用，这份草稿已清除。").waitFor();
  assert.equal(await boxValue(), "", "the applied message leaves the composer");
  await box.press("Control+Enter");
  await page.waitForTimeout(300);
  assert.equal(commandPosts.length, 1, "the applied message is never sent again");
  assert.equal(directPosts.length, 1);
});
