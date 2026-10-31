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
const taskIds = Array.from({ length: 50 }, (_, index) => `30000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`);
const diagnostic = `Route GET:/api/projects/${projectId}/orchestration/work-status?taskIds=${taskIds.join(",")} not found`;
const stamp = "2026-10-25T00:00:00.000Z";

test("missing work progress stays compact, retryable, and leaves read-only tasks available", { skip: !modulePath && "Set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE" }, async t => {
  const { chromium } = (await import(pathToFileURL(modulePath!).href)).default;
  let unavailable = true;
  let taskReads = 0;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname === "/__fixture/restore-work-status") { unavailable = false; res.end("ok"); return; }
    if (url.pathname === "/__fixture/task-reads") { res.end(String(taskReads)); return; }
    if (url.pathname.startsWith("/api/")) {
      const root = `/api/projects/${projectId}`;
      let value: unknown = { items: [], nextCursor: null }, status = 200;
      if (url.pathname === "/api/session") value = { principal: { actorId: "reader", projectIds: [projectId], permissions: ["read"] }, capabilities: {} };
      else if (url.pathname === root) value = { id: projectId, title: "回归项目", createdAt: stamp };
      else if (url.pathname === `${root}/tasks`) { taskReads++; value = { items: taskIds.map((id, index) => ({ projectId, id, version: 1, currentRevisionId: id,
        title: `可读任务 ${index + 1}`, content: "正文", contentDocumentId: id, contentRevisionId: id,
        kind: "implementation", acceptance: "确认", owner: "reader", state: "todo", createdAt: stamp })), nextCursor: null }; }
      else if (url.pathname === `${root}/impacts`) value = [];
      else if (url.pathname === `${root}/work-management/index`) value = {items:[],nextCursor:null,total:0,counts:{},changeSequence:0,observedAt:stamp,partial:false};
      else if (url.pathname === `${root}/session-work`) value = { items: [], nextCursor: null, observationCursor: "0",
        metadata: { generatedAt: stamp, sourceObservedAt: stamp, partial: false, limitations: [] },
        totals: { current: 0, historical: 0, unclassified: 0 },
        attention: { unansweredQuestions: 0, pendingMessages: 0, pendingAcceptance: null, unclassifiedSessions: 0 } };
      else if (url.pathname === `${root}/orchestration/work-status`) {
        if (unavailable) { status = 404; value = { message: diagnostic }; }
        else value = { items: taskIds.map(taskId => ({ taskId, cognition: false, hasClosure: false, readyForAcceptance: false })) };
      }
      res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); return;
    }
    try {
      const path = url.pathname === "/" ? "index.html" : url.pathname;
      const body = await readFile(join(dist, path));
      res.writeHead(200, { "content-type": ({ ".html": "text/html", ".js": "text/javascript", ".css": "text/css" } as Record<string, string>)[extname(path)] ?? "application/octet-stream" });
      res.end(body);
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const browser = await chromium.launch({ headless: true }); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto(`${base}/#/p/${projectId}/work`);
  await page.getByLabel("访问令牌").fill("fixture-token");
  await page.getByRole("button", { name: "进入", exact: true }).click();
  const warning = page.locator(".work-status-warning");
  await warning.getByText("工作进度暂时无法读取，已加载任务仍可查看。").waitFor({timeout:5000}).catch(async()=>assert.fail(`First status read: ${await page.locator("body").innerText()}`));
  await page.getByRole("button", { name: "可读任务 1", exact: true }).waitFor();
  assert.equal(await page.getByText(diagnostic).isVisible(), false);
  assert.equal(await warning.evaluate(element => element.getBoundingClientRect().height < 150), true);
  await warning.getByText("查看诊断信息").click();
  await page.getByText(diagnostic).waitFor();
  await warning.getByText("查看诊断信息").click();
  await page.getByRole("link", { name: "创建任务" }).click();
  await page.getByText("当前身份没有写入权限，不能创建任务。").waitFor();
  assert.equal(await page.getByRole("button", { name: "保存任务，继续安排" }).count(), 0);
  await page.getByRole("link", { name: "返回任务列表" }).first().click();
  await warning.waitFor();
  const readsBeforeRetry = await (await fetch(`${base}/__fixture/task-reads`)).text();
  await fetch(`${base}/__fixture/restore-work-status`);
  await warning.getByRole("button", { name: "重试读取工作进度" }).click();
  await warning.waitFor({ state: "detached" });
  assert.equal(await (await fetch(`${base}/__fixture/task-reads`)).text(), readsBeforeRetry);
  await page.getByRole("button", { name: "可读任务 1", exact: true }).waitFor();
});
