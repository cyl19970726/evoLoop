// Opt-in built-app regression: build workbench, then set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const modulePath = process.env.EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE;
const dist = resolve(import.meta.dirname, "../dist");
const projectId = "30000001-0000-4000-8000-000000000001";
const firstIds = Array.from({ length: 50 }, (_, index) => `30000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`);
const secondId = "30000000-0000-4000-8000-000000000051";
const stamp = "2026-10-25T00:00:00.000Z";
const task = (id: string, title: string) => ({ projectId, id, version: 1, currentRevisionId: id,
  title, content: "正文", contentDocumentId: id, contentRevisionId: id, kind: "implementation",
  acceptance: "确认", owner: "reader", state: "todo", createdAt: stamp });
const status = (taskId: string) => ({ taskId, cognition: false, hasClosure: false, readyForAcceptance: false });

test("a delayed retry preserves statuses from a newly loaded Task page", { skip: !modulePath && "Set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE" }, async t => {
  const { chromium } = (await import(pathToFileURL(modulePath!).href)).default;
  let firstStatusReads = 0, retryPending = false;
  let releaseRetry: (() => void) | null = null;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname === "/__fixture/retry-pending") { res.end(String(retryPending)); return; }
    if (url.pathname === "/__fixture/release-retry") { releaseRetry?.(); res.end("ok"); return; }
    if (url.pathname.startsWith("/api/")) {
      const root = `/api/projects/${projectId}`;
      let value: unknown = { items: [], nextCursor: null }, responseStatus = 200;
      if (url.pathname === "/api/session") value = { principal: { actorId: "reader", projectIds: [projectId], permissions: ["read"] }, capabilities: {} };
      else if (url.pathname === root) value = { id: projectId, title: "回归项目", createdAt: stamp };
      else if (url.pathname === `${root}/tasks`) value = url.searchParams.has("cursor")
        ? { items: [task(secondId, "第二页任务")], nextCursor: null }
        : { items: firstIds.map((id, index) => task(id, `首屏任务 ${index + 1}`)), nextCursor: "second" };
      else if (url.pathname === `${root}/impacts`) value = [];
      else if (url.pathname === `${root}/work-management/index`) value = {items:[],nextCursor:null,total:0,counts:{},changeSequence:0,observedAt:stamp,partial:false};
      else if (url.pathname === `${root}/session-work`) value = { items: [], nextCursor: null, observationCursor: "0",
        metadata: { generatedAt: stamp, sourceObservedAt: stamp, partial: false, limitations: [] },
        totals: { current: 0, historical: 0, unclassified: 0 },
        attention: { unansweredQuestions: 0, pendingMessages: 0, pendingAcceptance: null, unclassifiedSessions: 0 } };
      else if (url.pathname === `${root}/orchestration/work-status`) {
        const ids = url.searchParams.get("taskIds")?.split(",") ?? [];
        if (ids.includes(secondId)) value = { items: [status(secondId)] };
        else if (++firstStatusReads === 1) { responseStatus = 503; value = { message: "首屏状态暂不可读" }; }
        else { retryPending = true; await new Promise<void>(resolve => { releaseRetry = resolve; }); value = { items: firstIds.map(status) }; }
      }
      res.writeHead(responseStatus, { "content-type": "application/json" }); res.end(JSON.stringify(value)); return;
    }
    try {
      const path = url.pathname === "/" ? "index.html" : url.pathname;
      const body = await readFile(join(dist, path));
      res.writeHead(200, { "content-type": ({ ".html": "text/html", ".js": "text/javascript", ".css": "text/css" } as Record<string, string>)[extname(path)] ?? "application/octet-stream" });
      res.end(body);
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); t.after(() => { releaseRetry?.(); server.close(); });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const browser = await chromium.launch({ headless: true,
    executablePath: process.env.EVOLOOP_BROWSER_TEST_CHROMIUM_EXECUTABLE || undefined }); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto(`${base}/#/p/${projectId}/work`);
  await page.getByLabel("访问令牌").fill("fixture-token");
  await page.getByRole("button", { name: "进入", exact: true }).click();
  const warning = page.locator(".work-status-warning");
  await warning.waitFor({timeout:5000}).catch(async()=>assert.fail(`First status read: ${await page.locator("body").innerText()}`));
  await warning.getByRole("button", { name: "重试读取工作进度" }).click({timeout:5000}).catch(async()=>assert.fail(`Retry button: ${await page.locator("body").innerText()}`));
  let pending = false;
  for (let tries = 0; tries < 100 && !pending; tries++) {
    pending = await (await fetch(`${base}/__fixture/retry-pending`)).text() === "true";
    if (!pending) await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(pending, true, "retry did not become pending");
  await page.getByRole("button", { name: "加载更多" }).click();
  await page.locator(".work-status-section").first().getByRole("link", { name: "第二页任务" }).waitFor();
  assert.equal(await warning.isVisible(), true);
  await fetch(`${base}/__fixture/release-retry`);
  await warning.waitFor({ state: "detached" });
  await page.locator(".work-status-section").first().getByRole("link", { name: "第二页任务" }).waitFor();
  assert.equal(await page.getByRole("link", { name: "第二页任务" }).count(), 1);
});
