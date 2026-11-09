// Opt-in built-app regression: build workbench, then set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE.
// 评价与后果: the list in the new page layout, the task filter, and the create form kept for writers.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const modulePath = process.env.EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE;
const shots = process.env.EVOLOOP_EVALUATIONS_SCREENSHOT_DIR;
const dist = resolve(import.meta.dirname, "../dist");
const projectId = "37000001-0000-4000-8000-000000000001";
const taskId = "37000002-0000-4000-8000-000000000002";
const stamp = "2026-11-09T08:00:00.000Z";
const evaluation = (n: number, question: string) => ({
  projectId, evaluationId: `37000000-0000-4000-8000-00000000010${n}`, id: `37000000-0000-4000-8000-00000000020${n}`, version: 1,
  definition: { question, case: { taskId, materials: [] } }, actorId: "reviewer", reason: "建立", createdAt: stamp,
});

test("评价与后果 lists evaluations in the new layout and keeps the task filter and create form",
  { skip: !modulePath && "Set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE" }, async t => {
    const { chromium } = (await import(pathToFileURL(modulePath!).href)).default;
    const requests: string[] = [];
    const server = createServer(async (req, res) => {
      const url = new URL(req.url!, "http://127.0.0.1");
      if (url.pathname.startsWith("/api/")) {
        const root = `/api/projects/${projectId}`;
        let value: unknown = { items: [], nextCursor: null };
        if (url.pathname === "/api/session") value = { principal: { actorId: "reviewer", projectIds: [projectId], permissions: ["read", "write", "review"] }, capabilities: {} };
        else if (url.pathname === root) value = { id: projectId, title: "评价回归项目", createdAt: stamp };
        else if (url.pathname === `${root}/evaluations`) { requests.push(url.search); value = { items: [evaluation(1, "加入固定 Wiki 后首轮修复是否更快？"), evaluation(2, "直接材料能否独立完成？")], nextCursor: null }; }
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
    await page.goto(`${base}/p/${projectId}/evaluations?taskId=${taskId}`);
    await page.getByLabel("访问令牌").fill("fixture-token");
    await page.getByRole("button", { name: "进入", exact: true }).click();
    await page.getByRole("heading", { name: "评价与后果", exact: true }).waitFor();
    const list = page.getByRole("list", { name: "评价" });
    await list.getByRole("link").first().waitFor();
    assert.equal(await list.getByRole("link").count(), 2);
    assert.match(await list.innerText(), /加入固定 Wiki 后首轮修复是否更快？[\s\S]*匹配定义 v1 · 共同任务 37000002/);
    assert.ok(requests.some(search => search.includes(`taskId=${taskId}`)), "the list is read for the source task only");
    assert.equal(await page.getByRole("link", { name: "返回来源任务" }).getAttribute("href"), `/p/${projectId}/tasks/${taskId}`);
    await page.getByText("需要时建立新的冻结评价").click();
    await page.locator("details .evaluation-page").waitFor({ state: "attached" });
    if (shots) await page.screenshot({ path: `${shots}/evaluations-1440.png` });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate("document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1"), true, "no horizontal overflow at 390px");
    assert.deepEqual(errors, []);
  });
