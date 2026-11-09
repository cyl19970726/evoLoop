// Opt-in built-app regression: build workbench, then set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE.
// 微信连接: routes, their delivery records and the create form in the settings layout.
import assert from "node:assert/strict";
import { test } from "node:test";
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
  targetThreadId: "thread-7", targetActorId: "agent-front", senderActorId: "agent-front", senderIds: ["wx-zhang"], sendTargets: ["room-42"],
  internalTargets: [], policyHash: "b".repeat(64), mode: "standard", state: "active", version: 3, updatedAt: stamp,
};

test("微信连接 lists routes with their deliveries and keeps the create form for reviewers",
  { skip: !modulePath && "Set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE" }, async t => {
    const { chromium } = (await import(pathToFileURL(modulePath!).href)).default;
    const server = createServer(async (req, res) => {
      const url = new URL(req.url!, "http://127.0.0.1");
      if (url.pathname.startsWith("/api/")) {
        const root = `/api/projects/${projectId}`, c = `${root}/message-connectors`;
        let value: unknown = { items: [], nextCursor: null };
        if (url.pathname === "/api/session") value = { principal: { actorId: "reviewer", projectIds: [projectId], permissions: ["read", "write", "review"] }, capabilities: {} };
        else if (url.pathname === root) value = { id: projectId, title: "连接回归项目", createdAt: stamp };
        else if (url.pathname === `${c}/routes`) value = { items: [route], nextCursor: null };
        else if (url.pathname === `${c}/routes/${route.bindingId}/deliveries`) value = { items: [{ deliveryId: 11, eventCount: 2, unhandledCount: 1, latestMessageState: "delivered", decision: null }] };
        else if (url.pathname.endsWith("/impacts")) value = [];
        res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(value)); return;
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
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(`${base}/p/${projectId}/connectors`);
    await page.getByLabel("访问令牌").fill("fixture-token");
    await page.getByRole("button", { name: "进入", exact: true }).click();
    await page.getByRole("heading", { name: "微信连接", exact: true }).waitFor();
    const card = page.locator(".connector-card").filter({ hasText: "前端改版群" });
    await card.waitFor();
    assert.match(await card.innerText(), /标准模式 · active · v3[\s\S]*群聊[\s\S]*智能体 36000003/);
    assert.equal(await card.getByRole("link", { name: /智能体 36000003/ }).getAttribute("href"),
      `/p/${projectId}/sessions?session=${encodeURIComponent(route.targetSessionId)}`);
    await card.getByRole("button", { name: "读取最近的投递" }).click();
    await card.getByRole("button", { name: /投递 11 · 2 个来源事件 · 1 个需人工处理/ }).waitFor();
    await card.getByRole("button", { name: "暂停订阅" }).waitFor();
    await page.getByText("创建标准模式路由").click();
    await page.getByLabel("微信连接 ID").waitFor();
    assert.equal(await page.getByLabel("允许内部转交的智能体 ID（每行一个；留空即禁止）").getAttribute("required"), null);
    if (shots) await page.screenshot({ path: `${shots}/connectors-1440.png` });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate("document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1"), true, "no horizontal overflow at 390px");
    assert.deepEqual(errors, []);
  });
