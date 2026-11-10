// Opt-in built-app regression: build workbench, then set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE.
// 微信连接: routes, their delivery records and the create form in the settings layout.
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const modulePath = process.env.EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE;
const shots = process.env.EVOLOOP_CONNECTORS_SCREENSHOT_DIR;
const dist = resolve(import.meta.dirname, "../dist");
const projectId = "36000001-0000-4000-8000-000000000001";
const stamp = "2026-11-09T08:00:00.000Z";
const route = {
  projectId, bindingId: "36000002-0000-4000-8000-000000000002", conversationLabel: "前端改版群", conversationKind: "group",
  source: { provider: "wechat", connectionId: "wx-1", conversationId: "room-42" }, targetSessionId: "36000003-0000-4000-8000-000000000003",
  targetThreadId: "thread-7", targetActorId: "agent-front", senderActorId: "agent-front-out", owner: "wx-owner", epoch: 2, sessionRef: "wx-session-9",
  senderIds: ["wx-zhang"], sendTargets: ["room-42"], internalTargets: [], policyHash: "b".repeat(64), mode: "standard", state: "active", version: 3,
  createdAt: stamp, updatedAt: stamp,
};
// The longest connection ID the contract allows: 128 characters without a space.
const longId = `wx-${"a1b2c3d4".repeat(15)}12345`;
const longRoute = { ...route, bindingId: "36000004-0000-4000-8000-000000000004", conversationLabel: `长名称${"群".repeat(60)}`,
  source: { provider: "wechat", connectionId: longId, conversationId: "room-43" }, targetSessionId: "36000005-0000-4000-8000-000000000005",
  sendTargets: ["room-43"], state: "paused", version: 1 };
const agent = (sessionId: string, title: string, displayName: string | null) => ({ session: {
  key: `owned:${sessionId}`, target: { kind: "owned", sessionId }, aliases: [], title, profile: displayName ? { displayName } : null } });

type Answer = { status?: number; value: unknown };
const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

async function open(t: TestContext, answer: (path: string) => Answer | null, setup?: (page: { addInitScript(script: string): Promise<unknown> }) => Promise<unknown>) {
  const { chromium } = (await import(pathToFileURL(modulePath!).href)).default;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, "http://127.0.0.1");
    if (url.pathname.startsWith("/api/")) {
      const path = decodeURIComponent(url.pathname);
      let found: Answer = { value: { items: [], nextCursor: null } };
      if (path === "/api/session") found = { value: { principal: { actorId: "reviewer", projectIds: [projectId], permissions: ["read", "write", "review"] }, capabilities: {} } };
      else if (path === `/api/projects/${projectId}`) found = { value: { id: projectId, title: "连接回归项目", createdAt: stamp } };
      else if (path.endsWith("/impacts")) found = { value: [] };
      else found = answer(path) ?? found;
      res.writeHead(found.status ?? 200, { "content-type": "application/json" }); res.end(JSON.stringify(found.value)); return;
    }
    try {
      const path = /^\/(?:$|p\/|ui$)/.test(url.pathname) ? "index.html" : url.pathname;
      const body = await readFile(join(dist, path));
      res.writeHead(200, { "content-type":
        ({ ".html": "text/html", ".js": "text/javascript", ".css": "text/css" } as Record<string, string>)[extname(path)] ??
        "application/octet-stream" });
      res.end(body);
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const browser = await chromium.launch({ headless: true,
    executablePath: process.env.EVOLOOP_BROWSER_TEST_CHROMIUM_EXECUTABLE }); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors: string[] = [];
  page.on("pageerror", (error: Error) => errors.push(error.message));
  await setup?.(page);
  await page.goto(`${base}/p/${projectId}/connectors`);
  await page.getByLabel("访问令牌").fill("fixture-token");
  await page.getByRole("button", { name: "进入", exact: true }).click();
  await page.getByRole("heading", { name: "微信连接", exact: true }).waitFor();
  return { page, errors };
}

const noOverflow = "document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1";

test("微信连接 lists routes with their deliveries and keeps the create form for reviewers",
  { skip: !modulePath && "Set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE" }, async t => {
    const c = `/api/projects/${projectId}/message-connectors`;
    const { page, errors } = await open(t, path => {
      if (path === `${c}/routes`) return { value: { items: [route, longRoute], nextCursor: null } };
      if (path === `/api/projects/${projectId}/session-work/owned:${route.targetSessionId}`) return { value: agent(route.targetSessionId, "前端助手", "前端实现助手") };
      if (path.includes("/session-work/")) return { status: 404, value: { message: "not found" } };
      if (path === `${c}/routes/${route.bindingId}/deliveries`)
        return { value: { items: [{ deliveryId: 11, eventCount: 2, unhandledCount: 1, latestMessageState: "replied", decision: { decision: "reply", state: "observed", requestId: "req-1" } }] } };
      if (path === `${c}/routes/${route.bindingId}/deliveries/11`) return { value: { deliveryId: 11,
        messages: [{ eventCursor: 5, messageId: "36000006-0000-4000-8000-000000000006", messageState: "replied", processingState: "completed", nativeTurnId: "turn-1" }],
        unhandled: [{ eventCursor: 6, eventKind: "message_observed", direction: "incoming", reason: "sender_not_allowed", contentLength: 12 }],
        decision: { decision: "reply", state: "observed", requestId: "req-1" } } };
      return null;
    });
    const card = page.locator(".connector-card").filter({ hasText: "前端改版群" });
    await card.getByRole("link", { name: "前端实现助手" }).waitFor();
    const text = await card.innerText();
    assert.match(text, /启用\s*标准模式 · 第 3 版[\s\S]*微信 · 群聊 · 连接 wx-1[\s\S]*转给 前端实现助手/);
    assert.doesNotMatch(text, /active|wechat|v3|36000003/, "raw state, provider, version and agent ID stay out of the card body");
    const agentLink = new URLSearchParams((await card.getByRole("link", { name: "前端实现助手" }).getAttribute("href"))!.split("?")[1]);
    assert.equal(agentLink.get("session"), route.targetSessionId);
    assert.equal(agentLink.get("return"), `/p/${projectId}/connectors`, "the agent page offers 返回微信连接");
    await card.getByText("完整标识与范围").click();
    await card.getByText(route.targetSessionId, { exact: true }).waitFor();
    await card.getByRole("button", { name: "读取最近的投递" }).click();
    const delivery = card.getByRole("button", { name: /投递 11\s*2 条来源消息 · 1 条需人工处理 · 最新：已回复 · 出站：发送回复/ });
    await delivery.click();
    const details = card.getByText("投递 11 的明细").locator("..");
    const detail = await details.innerText();
    assert.match(detail, /事件 5：已回复 · 这一轮已结束/);
    assert.match(detail, /事件 6：收到的消息，发送者不在名单内，原长 12 字，没有转给智能体/);
    assert.match(detail, /出站：发送回复 · 本机可见、对方未确认/);
    assert.doesNotMatch(detail, /replied|completed|sender_not_allowed|message_observed|observed/);
    // The message, the agent's turn and the outbound request are identifiers: only under 完整标识.
    assert.doesNotMatch(detail, uuid);
    assert.doesNotMatch(detail, /req-1|turn-1/);
    await details.locator("summary", { hasText: "完整标识" }).click();
    assert.match(await details.innerText(), /事件 5 的消息\s*36000006-0000-4000-8000-000000000006[\s\S]*事件 5 的一轮\s*turn-1[\s\S]*出站原请求\s*req-1/);
    await card.getByRole("button", { name: "暂停订阅" }).waitFor();
    const long = page.locator(".connector-card").filter({ hasText: "长名称" });
    assert.match(await long.innerText(), /暂停\s*标准模式 · 第 1 版[\s\S]*转给 智能体（名称待读取）/);
    await page.getByText("创建标准模式路由").click();
    await page.getByLabel("微信连接 ID").waitFor();
    for (const label of ["接收身份", "发送身份", "对话线程 ID", "网关所有者", "网关轮次", "网关会话引用", "会话类型"]) await page.getByLabel(label, { exact: true }).waitFor();
    assert.equal(await page.getByLabel("允许内部转交的智能体 ID（每行一个；留空即禁止）").getAttribute("required"), null);
    const form = await page.locator(".connector-create").innerText();
    assert.doesNotMatch(form.split("\n").filter(line => !line.includes("（")).join("\n"), /actor|owner|epoch|session_ref|group|private/,
      "technical names only appear inside the hints");
    if (shots) await page.screenshot({ path: `${shots}/connectors-1440.png`, fullPage: true });
    await page.setViewportSize({ width: 1024, height: 800 });
    if (shots) await page.screenshot({ path: `${shots}/connectors-1024.png`, fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await long.scrollIntoViewIfNeeded();
    assert.equal(await page.evaluate(noOverflow), true, "no horizontal overflow at 390px");
    assert.equal(await long.evaluate((node: HTMLElement) => node.scrollWidth <= node.clientWidth + 1), true, "a 128-character connection ID wraps inside its card");
    if (shots) await page.screenshot({ path: `${shots}/connectors-390.png`, fullPage: true });
    assert.deepEqual(errors, []);
  });

test("微信连接 keeps an unconfirmed operation's ID under 完整标识, not in the notice",
  { skip: !modulePath && "Set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE" }, async t => {
    const operationId = "36000009-0000-4000-8000-000000000009";
    const { page, errors } = await open(t, path => path === `/api/projects/${projectId}/message-connectors/routes` ? { value: { items: [route], nextCursor: null } }
      : path.includes("/session-work/") ? { status: 404, value: { message: "not found" } } : null,
      target => target.addInitScript(`sessionStorage.setItem("connector-operation:${projectId}:reviewer", "${operationId}")`));
    const notice = page.getByRole("alert").filter({ hasText: "有一项操作的结果还没确认" });
    await notice.waitFor();
    assert.match(await notice.innerText(), /有一项操作的结果还没确认。查回之前不再提交新的修改。/);
    assert.doesNotMatch(await notice.innerText(), uuid, "no operation ID in the notice");
    assert.doesNotMatch(await page.locator(".connector-page").innerText(), uuid, "no identifier in the page's text");
    await notice.locator("summary", { hasText: "完整标识" }).click();
    assert.match(await notice.innerText(), new RegExp(`原操作\\s*${operationId}`));
    await notice.getByRole("button", { name: "按原 ID 查回" }).waitFor();
    assert.deepEqual(errors, []);
  });

test("微信连接 shows only the failure when the route list cannot be read",
  { skip: !modulePath && "Set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE" }, async t => {
    const { page, errors } = await open(t, path =>
      path === `/api/projects/${projectId}/message-connectors/routes` ? { status: 503, value: { message: "协调器暂不可用" } } : null);
    await page.getByText("无法读取路由").waitFor();
    assert.equal(await page.getByText("还没有路由").count(), 0, "a failed read never reads as an empty list");
    assert.match(await page.getByRole("region", { name: "当前路由" }).innerText(), /不能判断有没有路由/);
    if (shots) await page.screenshot({ path: `${shots}/connectors-503.png` });
    assert.deepEqual(errors, []);
  });
