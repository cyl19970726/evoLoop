// Opt-in built-app regression: build workbench, then set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE.
// An input the service did not check this time is shown with a neutral line (never "未能核实…发送者"); opening its source checks that one Item.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { timelinePage, timelineStamp } from "./session-timeline-fixtures";

const modulePath = process.env.EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE;
const dist = resolve(import.meta.dirname, "../dist");
const projectId = "94000001-0000-4000-8000-000000000001";
const sessionId = "94000002-0000-4000-8000-000000000002";
const roleId = "94000003-0000-4000-8000-000000000003";
const sessionKey = `owned:${sessionId}`;
const stamp = timelineStamp;
const metadata = { generatedAt: stamp, sourceObservedAt: stamp, partial: false, limitations: [] };
const unavailable = { available: false, reason: "未开放" };
const resources = Object.fromEntries(["configuredModel", "actualModel", "inputTokens", "outputTokens", "cost", "processMemory"]
  .map(key => [key, { value: null, unit: "", source: null, scope: "session", observedAt: null, interval: null, unavailableReason: "未记录" }]));
const role = { id: roleId, title: "模拟用户", state: "active", roleClass: "business", templateKey: null, responsibility: "模拟用户职责" };
const agent = { key: sessionKey, target: { kind: "owned", sessionId }, aliases: [], title: "模拟用户 · Codex 1", profile: null, identity: null, kind: "owned", roles: [role], membership: "current",
  membershipReason: "fixture", runtimeState: "ready", busy: false, currentTask: null, latestBusinessRun: null, lastProgressAt: stamp,
  capabilities: { observe: { available: true, reason: null }, send: { available: true, reason: null, mode: "owned-conversation" }, open: { ...unavailable, ref: null }, interrupt: unavailable, close: unavailable,
    ordinaryExecution: { state: "unverified", reasonCode: "fixture", reason: "执行前仍须核验。", observedAt: stamp } },
  source: { kind: "session", id: sessionId, revision: null, evidence: "project-record", href: "" }, metadata };
const entryBase = { turnId: "turn-16", nativeItemId: "input-16", nativeKind: "userMessage", occurredAt: stamp, observedAt: stamp, freshness: "persisted", truncated: false, state: "completed" };
const notice = { ...entryBase, id: "native:thread:turn-16:input-16", author: { kind: "native", id: null, label: "原生输入" }, origin: null, kind: "notice",
  label: "未核对的原生输入", body: "这条输入的绑定本次未核对，可展开核对。它的来源标记与处理记录一致，这不表示来源不明。" };
const checked = { ...entryBase, id: notice.id, kind: "message", role: "input", phase: "unknown", body: "【验收样本】第 16 条", clientId: "operation-16",
  author: { kind: "actor", id: "acceptance-sender", label: "acceptance-sender" }, origin: { kind: "message", id: "94000004-0000-4000-8000-000000000004", taskId: null, taskRevisionId: null, initiatingActorId: "acceptance-sender" } };

test("an unchecked input says it was not checked, and opening its source checks that one Item and shows the sender", {
  skip: !modulePath && "Set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE after building the workbench",
}, async t => {
  const { chromium } = (await import(pathToFileURL(modulePath!).href)).default;
  const itemReads: string[] = [];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, "http://127.0.0.1");
    const root = `/api/projects/${projectId}`;
    const json = (value: unknown, status = 200) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
    if (url.pathname.startsWith("/api/")) {
      if (url.pathname === "/api/session") return json({ principal: { actorId: "reader", projectIds: [projectId], permissions: ["read", "write", "review"] }, capabilities: {} });
      if (url.pathname === root) return json({ id: projectId, title: "核对测试项目", createdAt: stamp });
      if (url.pathname === `${root}/sessions/${sessionId}/direct-input-capability`) return json({ available: false, mode: null, expectedTurnId: null, reasonCode: "DIRECT_DISABLED", observedAt: stamp });
      if (url.pathname === `${root}/session-work`) return json({ items: [agent], nextCursor: null, observationCursor: "1", metadata,
        totals: { current: 1, historical: 0, unclassified: 0 }, attention: { unansweredQuestions: 0, pendingMessages: 0, pendingAcceptance: null, unclassifiedSessions: 0 } });
      if (url.pathname === `${root}/session-work/${encodeURIComponent(sessionKey)}`) return json({ session: agent, observationCursor: "1", currentWork: null,
        assignments: [], roleTasks: [], queue: [], results: [], questions: [], activity: [], resources, metadata });
      if (url.pathname === `${root}/session-work/${encodeURIComponent(sessionKey)}/timeline/items/input-16`) { itemReads.push(url.search); return json(checked); }
      if (url.pathname === `${root}/session-work/${encodeURIComponent(sessionKey)}/timeline`) return json(timelinePage(sessionKey, { title: agent.title, entries: [notice as never] }));
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
  const browser = await chromium.launch({ headless: true, ...(process.env.EVOLOOP_BROWSER_TEST_EXECUTABLE_PATH ? { executablePath: process.env.EVOLOOP_BROWSER_TEST_EXECUTABLE_PATH } : {}) });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(`${base}/p/${projectId}/sessions?session=${encodeURIComponent(sessionKey)}`);
  await page.getByLabel("访问令牌").fill("fixture-token");
  await page.getByRole("button", { name: "进入", exact: true }).click();
  const timeline = page.locator(".unified-session-timeline");
  await timeline.getByText("这条输入的绑定本次未核对，可展开核对").waitFor();
  assert.ok(!(await timeline.innerText()).includes("未能核实此原生输入的业务发送者"), "the page never says the sender could not be verified for an unchecked input");
  assert.deepEqual(itemReads, [], "nothing was read on demand until asked");
  await timeline.getByRole("button", { name: "查看来源" }).click();
  await page.getByText("acceptance-sender").first().waitFor({ timeout: 15_000 });
  assert.equal(itemReads.length, 1, "opening the source checked that one Item");
  assert.match(itemReads[0]!, /turnId=turn-16/);
});
