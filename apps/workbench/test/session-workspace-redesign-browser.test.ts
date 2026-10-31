import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

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
  return { key, target: { kind: "owned", sessionId: id }, aliases: [], title, profile: null, kind: "owned", roles,
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
  const snapshot = { session: { ...currentItems[0], currentTask, busy: false }, observationCursor: "1", currentWork: currentTask,
    assignments: [{ assignment: { projectId, taskId, version: 1, taskRevisionId: currentTask.revisionId,
      target: { kind: "owned", sessionId }, recipientActorId: "reader", state: "accepted",
      ack: { method: "direct", actorId: "reader", observerActorId: "reader", evidence: "阅读固定输入后接手", sourceRef: null, at: stamp },
      actorId: "lead", reason: "fixture", updatedAt: stamp }, task: currentTask, stale: false }],
    roleTasks: [], queue: [], results: [], questions: [], activity: [], resources, metadata, nativeObservation: progress };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname.startsWith("/api/")) {
      const root = `/api/projects/${projectId}`;
      let value: unknown = { items: [], nextCursor: null, metadata }, status = 200;
      if (url.pathname === "/api/session") value = { principal: { actorId: "reader", projectIds: [projectId], permissions: ["read", "write"] }, capabilities: {} };
      else if (url.pathname === root) value = { id: projectId, title: "Sessions 设计测试", createdAt: stamp };
      else if (url.pathname === `${root}/session-work`) {
        const membership = url.searchParams.get("membership") ?? "current";
        value = { items: membership === "current" ? currentItems : [], nextCursor: null, observationCursor: "1", metadata,
          totals: { current: 3, historical: 0, unclassified: 1 }, attention: { unansweredQuestions: 0, pendingMessages: 0,
            pendingAcceptance: null, unclassifiedSessions: 1 } };
      } else if (url.pathname === `${root}/session-work/changes`) value = { items: [], nextCursor: "2", hasMore: false, resetRequired: false, metadata };
      else if (url.pathname === `${root}/session-work/${encodeURIComponent(sessionKey)}`) value = snapshot;
      else if (url.pathname === `${root}/session-work/${encodeURIComponent(sessionKey)}/messages`) {
        messageListReads++;
        value = { items: [messageListReads === 1 ? message : { ...message, processing: undefined }], nextCursor: null, metadata };
      }
      else if (url.pathname === `${root}/session-messages/${messageId}`) value = { message, processing: message.processing, metadata };
      else if (url.pathname === "/api/commands" && req.method === "POST") {
        let body = ""; for await (const chunk of req) body += String(chunk);
        const command = JSON.parse(body); posted.push(command);
        value = { status: "applied", operationId: command.operationId, entityId: command.messageId, version: 1 };
      } else if (url.pathname.includes("/recovery")) { status = 404; value = { message: "无恢复记录" }; }
      res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); return;
    }
    try {
      const file = url.pathname === "/" ? "index.html" : url.pathname;
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
  await page.goto(`${base}/#/p/${projectId}/sessions`);
  await page.getByLabel("访问令牌").fill("fixture-token");
  await page.getByRole("button", { name: "进入", exact: true }).click();
  await page.getByRole("heading", { name: "Sessions", exact: true }).waitFor();
  assert.deepEqual(await page.locator(".module-rail > a:not(.rail-brand)").allTextContents(), ["工作", "Sessions"]);
  const sidebar = page.locator(".project-sidebar .session-navigation");
  await sidebar.getByText("业务 Session · 1", { exact: true }).waitFor();
  await sidebar.getByText("System Session · 1", { exact: true }).waitFor();
  await sidebar.getByText("待归类 · 1", { exact: true }).waitFor();
  const workPage = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await workPage.goto(`${base}/#/p/${projectId}/work`);
  await workPage.getByLabel("访问令牌").fill("fixture-token");
  await workPage.getByRole("button", { name: "进入", exact: true }).click();
  await workPage.locator(".project-sidebar").waitFor();
  assert.equal(await workPage.locator(".session-navigation:visible").count(), 0, "Work does not duplicate the Session directory");
  await workPage.close();
  await page.getByRole("link", { name: "测试 Session", exact: true }).first().click();
  await page.getByRole("heading", { name: /测试 Session/ }).waitFor();
  await page.getByRole("link", { name: "验证 Sessions 阅读体验" }).first().waitFor();
  await page.getByText("已收到", { exact: false }).waitFor();
  await page.getByText("工具已完成", { exact: false }).waitFor();
  assert.equal(await page.locator(".session-turn-tools").count(), 1, await page.locator(".session-workspace").innerText());
  await page.getByText("核对图片", { exact: true }).first().waitFor();
  assert.equal(await page.getByText("未同步", { exact: true }).count() >= 2, true);
  await page.getByLabel("消息内容").fill("键盘发送");
  await page.getByLabel("消息内容").press("Control+Enter");
  await page.getByText("已保存，正在读取持久记录。", { exact: true }).waitFor();
  assert.equal(posted.length, 1);
  assert.equal(posted[0]?.type, "session.message.post");
  assert.deepEqual(posted[0]?.context, { taskId, taskRevisionId: currentTask.revisionId });
  await page.setViewportSize({ width: 390, height: 840 });
  await page.waitForTimeout(100);
  assert.equal(await page.locator("body").evaluate(element => element.scrollWidth <= innerWidth), true);
  await page.waitForTimeout(5200);
  await page.getByText("已收到", { exact: false }).waitFor();
  assert.equal(await page.locator(".session-turn-tools").count(), 1, "processing survives polling responses that use the legacy list shape");
});
