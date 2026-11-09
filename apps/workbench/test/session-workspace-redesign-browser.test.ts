import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { timelineAssistant, timelinePage, timelineTool } from "./session-timeline-fixtures";

const modulePath = process.env.EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE;
const dist = resolve(import.meta.dirname, "../dist");
const projectId = "95000001-0000-4000-8000-000000000001";
const sessionId = "95000002-0000-4000-8000-000000000002";
const systemId = "95000003-0000-4000-8000-000000000003";
const mixedId = "95000004-0000-4000-8000-000000000004";
const taskId = "95000005-0000-4000-8000-000000000005";
const messageId = "95000006-0000-4000-8000-000000000006";
const sessionKey = `owned:${sessionId}`;
const stamp = "2026-10-31T12:00:00.000Z";
const metadata = { generatedAt: stamp, sourceObservedAt: stamp, partial: false, limitations: [] };
const unavailable = { available: false, reason: "fixture unavailable" };
const resource = { value: null, unit: "", source: null, scope: "session", observedAt: null, interval: null, unavailableReason: "未记录" };
const resources = Object.fromEntries(["configuredModel", "actualModel", "inputTokens", "outputTokens", "cost", "processMemory"].map(key => [key, resource]));
const role = (id: string, title: string, roleClass: "system" | "business" | null) => ({ id, title, state: "active", roleClass, templateKey: null, responsibility: `${title}职责` });
const source = { kind: "session", id: sessionId, revision: null, evidence: "project-record", href: "" };

function observed(key: string, title: string, roles: ReturnType<typeof role>[]) {
  const id = key.split(":")[1]!;
  const color = id === sessionId ? "violet" : id === systemId ? "copper" : "blue";
  const mark = id === sessionId ? "diamond" : id === systemId ? "dot" : "layers";
  return { key, target: { kind: "owned", sessionId: id }, aliases: [], title, profile: null, kind: "owned", roles,
    identity: { projectId, target: { kind: "owned", sessionId: id }, version: 1, color, mark,
      actorId: "reader", reason: "fixture", updatedAt: stamp },
    membership: "current", membershipReason: "fixture", runtimeState: "ready", busy: false, currentTask: null,
    latestBusinessRun: null, lastProgressAt: null, capabilities: { observe: { available: true, reason: null },
      send: { available: true, reason: "fixture", mode: "owned-conversation" }, open: { ...unavailable, ref: null },
      interrupt: unavailable, close: unavailable }, source: { ...source, id }, metadata };
}

test("Sessions is the sole directory and renders conversation, source, reply and expanded tool evidence", {
  skip: !modulePath && "Set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE after building the workbench",
}, async t => {
  const { chromium } = (await import(pathToFileURL(modulePath!).href)).default;
  const posted: Array<Record<string, unknown>> = [];
  let messageListReads = 0;
  const currentItems = [
    observed(sessionKey, "测试 Session", [role("95000007-0000-4000-8000-000000000007", "功能开发负责人", "business")]),
    observed(`owned:${systemId}`, "Leader", [role("95000008-0000-4000-8000-000000000008", "Leader", "system")]),
    observed(`owned:${mixedId}`, "跨类责任", [role("95000009-0000-4000-8000-000000000009", "Leader", "system"), role("95000010-0000-4000-8000-000000000010", "产品负责人", "business")]),
  ];
  const currentTask = { id: taskId, title: "验证 Sessions 阅读体验", state: "in_progress", revisionId: "95000011-0000-4000-8000-000000000011",
    owner: "功能开发负责人", relation: "accepted", source: { kind: "task", id: taskId, revision: null, evidence: "project-record", href: "" } };
  const message = { projectId, id: messageId, operationId: messageId, target: { kind: "owned", sessionId }, senderActorId: "reader",
    content: "请说明当前进展。", context: { taskId, taskRevisionId: currentTask.revisionId }, replyToMessageId: null,
    state: "replied", version: 2, blockedReason: null, readReceipt: null, createdAt: stamp, updatedAt: stamp, contentTruncated: false,
    responseTruncated: false, processing: { projectId, id: "95000012-0000-4000-8000-000000000012", messageId, sessionId,
      operationId: messageId, state: "completed", nativeTurnId: "turn-1", response: "## 已收到\n\n- 工具已完成\n- 结果可核对",
      failure: null, version: 2, startedAt: stamp, updatedAt: stamp } };
  const progress = { projectId, sessionId, threadId: "thread-1", version: 1, observedAt: stamp, lastEventAt: stamp,
    freshness: "live", staleReason: null, status: "active",
    currentTurn: { id: "turn-1", status: "completed", source: { kind: "message", messageId, processingId: message.processing.id,
      operationId: message.operationId, actorId: "reader" } },
    items: [{ id: "tool-1", kind: "commandExecution", name: "读取固定文档", status: "completed", summary: "读取完成", truncated: false },
      { id: "tool-2", kind: "commandExecution", name: "核对图片", status: "failed", summary: "图片暂不可读", truncated: false }],
    plan: null, diff: null, usage: null };
  const longAnswer = timelineAssistant("long-answer", "截断预览", { turnId: "long-turn", nativeItemId: "long-item", truncated: true });
  const snapshot = { session: { ...currentItems[0], currentTask, busy: false }, observationCursor: "1", currentWork: currentTask,
    assignments: [{ assignment: { projectId, taskId, version: 1, taskRevisionId: currentTask.revisionId,
      target: { kind: "owned", sessionId }, recipientActorId: "reader", state: "accepted",
      ack: { method: "direct", actorId: "reader", observerActorId: "reader", evidence: "阅读固定输入后接手", sourceRef: null, at: stamp },
      actorId: "lead", reason: "fixture", updatedAt: stamp }, task: currentTask, stale: false }],
    roleTasks: [], queue: [], results: [], questions: [], activity: [], resources, metadata, nativeObservation: progress };
  const profileRevision = { projectId, sessionId, revisionId: "95000013-0000-4000-8000-000000000013",
    version: 1, previousRevisionId: null, model: "gpt-6-sol", reasoningEffort: "high",
    sandbox: "danger-full-access", approvalPolicy: "never", cwd: "/tmp/fixture",
    authorizationScope: "fixture", provenance: "reserved", operationId: messageId,
    actorId: "reader", reason: "fixture", evidenceRef: null, createdAt: stamp };
  const executionProfile = { revision: profileRevision, activationState: "active",
    activeRevisionId: profileRevision.revisionId, activeModel: "gpt-6-sol", activeReasoningEffort: "high",
    activationOperationId: null, attemptedAt: null, activationEvidence: "fixture" };
  let currentProfile = executionProfile;
  let currentRuntimeVersion = 1;
  let holdRuntimeRead = false;
  let releaseRuntimeRead: (() => void) | null = null;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname.startsWith("/api/")) {
      const root = `/api/projects/${projectId}`;
      let value: unknown = { items: [], nextCursor: null, metadata }, status = 200;
      if (url.pathname === "/api/session") value = { principal: { actorId: "reader", projectIds: [projectId], permissions: ["read", "write", "review"] }, capabilities: {} };
      else if (url.pathname === root) value = { id: projectId, title: "Sessions 设计测试", createdAt: stamp };
      else if (url.pathname === `${root}/impacts`) value = [];
      else if (url.pathname === `${root}/runtime/sessions`) {
        if (holdRuntimeRead) await new Promise<void>(resolve => { releaseRuntimeRead = resolve; });
        value = [{ projectId, id: sessionId,
          version: currentRuntimeVersion, state: "ready", sandbox: "danger-full-access", approvalPolicy: "never",
          model: currentProfile.revision.model, executionProfile: currentProfile }];
      }
      else if (url.pathname === `${root}/runtime/models`) value = { status: "available",
        models: ["gpt-6-sol", "gpt-6-astra"], options: [
          { model: "gpt-6-sol", supportedReasoningEfforts: ["high"], defaultReasoningEffort: "high" },
          { model: "gpt-6-astra", supportedReasoningEfforts: ["high", "max"], defaultReasoningEffort: "high" }],
        error: null, observedAtUtc: stamp };
      else if (url.pathname === `${root}/runtime/sessions/${sessionId}/recovery`) {
        value = { sessionId, executionProfile: currentProfile, gate: null, decisions: [], queues: [], nextAction: "normal_work",
          partial: false, observedAtUtc: stamp };
      }
      else if (url.pathname === `${root}/work-management/index`) value = {
        items: [], nextCursor: null, total: 0, counts: {}, changeSequence: 1, observedAt: stamp, partial: false,
      };
      else if (url.pathname === `${root}/session-work`) {
        const membership = url.searchParams.get("membership") ?? "current";
        value = { items: membership === "current" ? currentItems : [], nextCursor: null, observationCursor: "1", metadata,
          totals: { current: 3, historical: 0, unclassified: 1 }, attention: { unansweredQuestions: 0, pendingMessages: 0,
            pendingAcceptance: null, unclassifiedSessions: 1 } };
      } else if (url.pathname === `${root}/session-work/changes`) value = { items: [], nextCursor: "2", hasMore: false, resetRequired: false, metadata };
      else if (url.pathname === `${root}/session-work/${encodeURIComponent(sessionKey)}`) value = snapshot;
      else if (url.pathname === `${root}/session-work/${encodeURIComponent(sessionKey)}/timeline`) {
        const entries = [
          { ...timelineAssistant("answer-1", "## 已收到\n\n- 工具已完成\n- 结果可核对", { author: { kind: "session", id: sessionId, label: "测试 Session" } }), origin: { kind: "message" as const,
            id: messageId, taskId, taskRevisionId: currentTask.revisionId, initiatingActorId: "reader" } },
          longAnswer,
          timelineTool("tool-1", "读取固定文档", "工具已完成"),
          timelineTool("tool-2", "核对图片", "图片暂不可读", "failed"),
        ];
        value = timelinePage(sessionKey, { title: "测试 Session", entries, cursor: String(messageListReads + 1) });
      } else if (url.pathname.endsWith("/timeline/updates")) value = {
        cursor: "1", resetRequired: false, entries: [], turns: [], freshness: "live", limitations: [],
      };
      else if (url.pathname.endsWith("/timeline/items/long-item")) value = { ...longAnswer,
        body: "截断预览\n\n完整补充段落可以在同一条消息中读取。", truncated: false };
      else if (url.pathname === `${root}/session-work/${encodeURIComponent(sessionKey)}/messages`) {
        messageListReads++;
        value = { items: [messageListReads === 1 ? message : { ...message, processing: undefined }], nextCursor: null, metadata };
      }
      else if (url.pathname === `${root}/session-messages/${messageId}`) value = { message, processing: message.processing, metadata };
      else if (url.pathname === "/api/commands" && req.method === "POST") {
        let body = ""; for await (const chunk of req) body += String(chunk);
        const command = JSON.parse(body); posted.push(command);
        if (command.type === "runtime.session.executionProfile.revise") {
          if (command.expectedVersion !== currentRuntimeVersion ||
              command.expectedExecutionProfileRevisionId !== currentProfile.revision.revisionId) {
            value = { status: "rejected", operationId: command.operationId, code: "VERSION_CONFLICT", message: "stale profile" };
          } else {
            currentRuntimeVersion++;
            currentProfile = { ...currentProfile, revision: { ...currentProfile.revision,
              revisionId: `95000016-0000-4000-8000-${String(12 + currentRuntimeVersion).padStart(12, "0")}`,
              version: currentRuntimeVersion, model: command.model, reasoningEffort: command.reasoningEffort },
              activationState: "pending" };
            value = { status: "applied", operationId: command.operationId, entityId: sessionId, version: currentRuntimeVersion };
          }
        } else if (command.type === "session.identity.set") {
          const identity = currentItems[0]!.identity;
          if (command.expectedVersion !== identity.version) {
            value = { status: "rejected", operationId: command.operationId, code: "VERSION_CONFLICT", message: "stale identity" };
          } else {
            identity.version++;
            identity.color = command.color;
            identity.mark = command.mark;
            value = { status: "applied", operationId: command.operationId, entityId: sessionId, version: identity.version };
          }
        } else {
          value = { status: "applied", operationId: command.operationId, entityId: command.messageId, version: 1 };
        }
      } else if (url.pathname.includes("/recovery")) { status = 404; value = { message: "无恢复记录" }; }
      res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); return;
    }
    try {
      const file = /^\/(?:$|p\/|ui$)/.test(url.pathname) ? "index.html" : url.pathname;
      const body = await readFile(join(dist, file));
      res.writeHead(200, { "content-type": ({ ".html": "text/html", ".js": "text/javascript", ".css": "text/css" } as Record<string, string>)[extname(file)] ?? "application/octet-stream" });
      res.end(body);
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const browser = await chromium.launch({ headless: true, ...(process.env.EVOLOOP_BROWSER_TEST_EXECUTABLE_PATH
    ? { executablePath: process.env.EVOLOOP_BROWSER_TEST_EXECUTABLE_PATH } : {}) }); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(`${base}/p/${projectId}/sessions`);
  await page.getByLabel("访问令牌").fill("fixture-token");
  await page.getByRole("button", { name: "进入", exact: true }).click();
  // Without a selected agent the Sessions space opens 统筹安排, not a second directory.
  await page.getByRole("heading", { name: "统筹安排", exact: true }).waitFor();
  assert.deepEqual(await page.locator('[data-shell=rail] a:not([aria-label])').evaluateAll(links => links.map(link => link.firstChild?.nextSibling?.textContent ?? link.textContent)), ["工作", "智能体", "待我处理"]);
  if (await page.locator("[data-shell=frame]").getAttribute("data-rail") !== "shown") await page.getByRole("button", { name: "展开项目导航" }).click();
  const sidebar = page.locator("aside[aria-label=项目导航] .session-navigation");
  // The directory shows each agent with its role-based avatar; the saved colour mark stays on the agent page.
  await sidebar.locator(`.session-nav-item[href*="${sessionId}"]`).waitFor();
  await sidebar.getByText("业务智能体 · 已加载 1", { exact: true }).waitFor();
  await sidebar.getByText("系统智能体 · 已加载 1", { exact: true }).waitFor();
  await sidebar.getByText("待归类 · 已加载 1", { exact: true }).waitFor();
  const workPage = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const workPageErrors: string[] = [];
  workPage.on("pageerror", error => workPageErrors.push(error.message));
  workPage.on("console", message => { if (message.type() === "error") workPageErrors.push(message.text()); });
  await workPage.goto(`${base}/p/${projectId}/work`);
  await workPage.getByLabel("访问令牌").fill("fixture-token");
  await workPage.getByRole("button", { name: "进入", exact: true }).click();
  await workPage.waitForTimeout(500);
  assert.equal(await workPage.locator(".workbench-layout").count(), 1,
    `the Work route mounts the shared shell; errors=${workPageErrors.join(" | ")}; current page: ${(await workPage.locator("body").innerText()).slice(0, 500)}`);
  if (await workPage.locator("[data-shell=frame]").getAttribute("data-rail") !== "shown") await workPage.getByRole("button", { name: "展开项目导航" }).click();
  await workPage.locator("aside[aria-label=项目导航]").waitFor({ state: "visible" });
  assert.equal(await workPage.locator(".session-navigation:visible").count(), 0, "Work does not duplicate the Session directory");
  await workPage.close();
  await sidebar.getByRole("link").filter({ hasText: "测试 Session" }).first().click();
  await page.getByRole("heading", { name: /测试 Session/ }).waitFor();
  // The saved colour mark sits beside the name in the right column; the header shows the role avatar.
  if (await page.getByRole("button", { name: "展开右栏" }).count()) await page.getByRole("button", { name: "展开右栏" }).click();
  await page.locator(".session-panel section[aria-label=智能体] .session-identity-violet").waitFor();
  const identitySettings = page.locator(".session-identity-settings");
  await identitySettings.locator("summary").first().click();
  await identitySettings.locator(".command-disclosure > summary").click();
  await identitySettings.getByLabel("身份颜色").selectOption("teal");
  await identitySettings.getByLabel("图形标记").selectOption("grid");
  await identitySettings.getByLabel("变更依据").fill("same Session identity across clients");
  await identitySettings.getByRole("button", { name: "调整颜色与图标" }).click();
  await page.waitForTimeout(500);
  assert.equal(await page.locator(".session-panel section[aria-label=智能体] .session-identity-teal").count(), 1,
    JSON.stringify({ commands: posted.filter(command => command.type === "session.identity.set"),
      control: await identitySettings.innerText(), panel: await page.locator(".session-panel").innerText() }));
  const identityCommand = posted.find(command => command.type === "session.identity.set");
  assert.deepEqual([identityCommand?.target, identityCommand?.expectedVersion, identityCommand?.color, identityCommand?.mark],
    [{ kind: "owned", sessionId }, 1, "teal", "grid"]);
  await page.reload();
  await page.getByLabel("访问令牌").fill("fixture-token");
  await page.getByRole("button", { name: "进入", exact: true }).click();
  if (await page.getByRole("button", { name: "展开右栏" }).count()) await page.getByRole("button", { name: "展开右栏" }).click();
  await page.locator(".session-panel section[aria-label=智能体] .session-identity-teal").waitFor();
  assert.match(await page.locator(".session-panel section[aria-label=智能体] .session-identity-teal").getAttribute("aria-label") ?? "",
    /测试 Session.*青蓝色.*方格/, "the mark gives screen readers both stable identity properties");
  await page.getByRole("link", { name: "验证 Sessions 阅读体验" }).first().waitFor();
  await page.getByText("已收到", { exact: false }).waitFor();
  assert.equal(await page.locator('[data-workspace-entry="answer-1"] .session-identity-teal').count(), 1,
    "a reply with the exact Session author uses the saved identity");
  assert.equal(await page.locator('[data-workspace-entry="long-answer"] .session-identity-mark').count(), 0,
    "an unproven Session author does not inherit the selected Session mark");
  // Folded, the tool group is one line; the failed step stays in sight, the finished one folds away.
  await page.locator(".workspace-tools").getByText("图片暂不可读", { exact: true }).waitFor();
  assert.equal(await page.locator(".workspace-tools").getByText("工具已完成", { exact: true }).count(), 0);
  const fullMessage = page.locator('[data-workspace-entry="long-answer"]');
  await fullMessage.getByText("截断预览", { exact: true }).waitFor();
  await fullMessage.getByRole("button", { name: "读取完整回复" }).click();
  await fullMessage.getByText("完整补充段落可以在同一条消息中读取。", { exact: true }).waitFor();
  assert.equal(await page.getByRole("dialog", { name: "活动详情" }).count(), 0,
    "a full native message read expands inside its existing timeline bubble");
  const tools = page.locator(".workspace-tools");
  assert.equal(await tools.count(), 1, await page.locator(".session-workspace").innerText());
  await tools.getByText("图片暂不可读", { exact: true }).waitFor();
  assert.equal(await tools.getByText(/1 项失败或中断/).count(), 1, "failed tools remain visible in the collapsed preview");
  const toolToggle = tools.locator(".workspace-tools-toggle");
  await toolToggle.click();
  assert.equal(await toolToggle.getAttribute("aria-expanded"), "true");
  await tools.getByText("图片暂不可读", { exact: true }).waitFor();
  await tools.getByText("工具已完成", { exact: true }).waitFor();
  await tools.getByRole("button", { name: "查看工具详情：核对图片" }).click();
  const inlineTool = tools.getByRole("region", { name: "核对图片详情" });
  await inlineTool.getByText("来源标识与读取范围", { exact: true }).waitFor();
  await tools.getByRole("button", { name: "收起工具详情：核对图片" }).click();
  assert.equal(await inlineTool.count(), 0, "the selected tool detail collapses in place without leaving the timeline");
  await page.getByRole("button", { name: "会话详情" }).click();
  const informationPanel = page.locator(".session-information");
  assert.equal(await informationPanel.evaluate(element => (element as HTMLDetailsElement).open), true);
  assert.equal(await informationPanel.locator(".session-project-activity").count(), 1,
    "project audit remains reachable inside Session details");
  assert.equal(await page.locator(".unified-session-timeline:visible").count(), 1, "details open in the right column beside the conversation, which stays in place");
  const deepLinkPage = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await deepLinkPage.goto(`${base}/p/${projectId}/sessions?session=${encodeURIComponent(sessionKey)}&tab=activity&filter=important&open=${encodeURIComponent(`message:${messageId}`)}`);
  await deepLinkPage.getByLabel("访问令牌").fill("fixture-token");
  await deepLinkPage.getByRole("button", { name: "进入", exact: true }).click();
  await deepLinkPage.getByRole("heading", { name: /测试 Session/ }).waitFor();
  assert.equal(await deepLinkPage.locator(".session-information").evaluate(element => (element as HTMLDetailsElement).open), true,
    "an audit deep link restores the Session details panel");
  await deepLinkPage.close();
  await page.getByRole("button", { name: "会话详情" }).click();
  await page.getByRole("combobox", { name: "消息" }).fill("键盘发送");
  await page.getByRole("combobox", { name: "消息" }).press("Control+Enter");
  await page.getByText("已保存，正在读取持久记录。", { exact: true }).waitFor();
  const postedMessage = posted.find(command => command.type === "session.message.post");
  assert.equal(posted.filter(command => command.type === "session.message.post").length, 1);
  assert.deepEqual(postedMessage?.context, { taskId, taskRevisionId: currentTask.revisionId });
  const modelControl = page.locator(".session-model-control");
  await modelControl.getByText("gpt-6-sol / high", { exact: false }).first().waitFor();
  await modelControl.getByRole("button", { name: "调整模型与强度" }).click();
  const editor = modelControl.locator(".session-model-editor");
  await editor.locator("select").first().selectOption("gpt-6-astra");
  await editor.getByLabel("思考强度").selectOption("max");
  if (process.env.EVOLOOP_CAPTURE_MODEL_CONTROL) await page.screenshot({
    path: `${process.env.EVOLOOP_CAPTURE_MODEL_CONTROL}-wide.png`, fullPage: true });
  await page.setViewportSize({ width: 390, height: 840 });
  assert.equal(await page.locator("body").evaluate(element => element.scrollWidth <= innerWidth), true);
  // Below 1100px the right column is a drawer; its contents (and this half-filled editor) keep their state.
  await page.getByRole("button", { name: "展开右栏" }).click();
  if (process.env.EVOLOOP_CAPTURE_MODEL_CONTROL) await page.screenshot({
    path: `${process.env.EVOLOOP_CAPTURE_MODEL_CONTROL}-narrow.png`, fullPage: true });
  assert.equal(await editor.getByLabel("思考强度").inputValue(), "max", "the editor keeps its choice when the column becomes a drawer");
  await editor.getByLabel("调整理由").fill("固定测试中的受控换模");
  await editor.getByLabel("授权与模型能力依据").fill("fixture-model-list-and-grant");
  await editor.getByRole("button", { name: "保存下一轮的模型与强度" }).click();
  assert.equal(posted.filter(command => command.type === "runtime.session.executionProfile.revise").length, 1);
  assert.equal(posted.find(command => command.type === "runtime.session.executionProfile.revise")?.reasoningEffort, "max");
  await modelControl.getByText("gpt-6-astra / max", { exact: false }).first().waitFor();
  // Back to a wide window: the right column sits beside the page again, so page and column work together.
  await page.setViewportSize({ width: 1440, height: 900 });
  // A CLI writer changes the same Session while this page stays open. The top
  // reread must update both the summary and the editor's CAS baseline.
  currentRuntimeVersion++;
  currentProfile = { ...currentProfile, revision: { ...currentProfile.revision,
    revisionId: "95000015-0000-4000-8000-000000000015", version: currentRuntimeVersion,
    reasoningEffort: "high" } };
  await page.getByRole("button", { name: "重新读取", exact: true }).click();
  await page.locator(".session-panel").getByText("high", { exact: true }).first().waitFor();
  await modelControl.getByText("gpt-6-astra / high", { exact: false }).first().waitFor();
  assert.equal(await modelControl.getByText("页面两次读取的修订不一致").count(), 0);
  const adjust = modelControl.getByRole("button", { name: "调整模型与强度" });
  if (await adjust.count()) await adjust.click();
  const rereadEditor = modelControl.locator(".session-model-editor");
  await rereadEditor.getByLabel("思考强度").waitFor();
  assert.equal(await rereadEditor.getByLabel("思考强度").inputValue(), "high");
  assert.equal(await rereadEditor.getByRole("button", { name: "保存下一轮的模型与强度" }).isEnabled(), true);
  await rereadEditor.getByLabel("思考强度").selectOption("max");
  await rereadEditor.getByLabel("调整理由").fill("current reread baseline");
  await rereadEditor.getByLabel("授权与模型能力依据").fill("fixture catalog and grant");
  await rereadEditor.getByRole("button", { name: "保存下一轮的模型与强度" }).click();
  await modelControl.getByText("gpt-6-astra / max", { exact: false }).first().waitFor();
  const secondRevision = posted.filter(command => command.type === "runtime.session.executionProfile.revise")[1];
  assert.deepEqual([secondRevision?.expectedVersion, secondRevision?.expectedExecutionProfileRevisionId],
    [3, "95000015-0000-4000-8000-000000000015"], "the next write uses the CLI revision as its CAS base");
  // Native activation can change without another profile revision. Hold the
  // runtime response to prove recovery immediately blocks editing during lag.
  // Visibility reread uses the same parent read path as background polling
  // without resetting the control through the top refresh button.
  holdRuntimeRead = true;
  currentProfile = { ...currentProfile, activationState: "unknown" };
  try {
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    await modelControl.getByText("激活结果未知，需核对", { exact: false }).waitFor({ timeout: 12000 });
    assert.equal(await modelControl.getByRole("button", { name: "调整模型与强度" }).isDisabled(), true);
    assert.ok(releaseRuntimeRead, "runtime reread is still waiting while recovery already blocks editing");
  } finally {
    holdRuntimeRead = false;
    releaseRuntimeRead?.();
  }
  await page.setViewportSize({ width: 390, height: 840 });
  await page.waitForTimeout(100);
  assert.equal(await page.locator("body").evaluate(element => element.scrollWidth <= innerWidth), true);
  await page.waitForTimeout(5200);
  await page.getByText("已收到", { exact: false }).waitFor();
  assert.equal(await page.locator(".workspace-tools").count(), 1, "timeline polling preserves the grouped tool activity");
});
