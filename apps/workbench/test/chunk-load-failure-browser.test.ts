// Opt-in built-app regression: build workbench, then set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE.
// An old tab after a release: a page's chunk file is gone (404). The page says the workbench was updated and needs a refresh (no
// automatic refresh, the token lives in page memory), keeps the raw error behind a detail, and the failure is not remembered:
// once the file is back, 重试 (or entering the page again) opens it in the same tab. EVOLOOP_CHUNK_SCREENSHOT_DIR saves a screenshot per width.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const modulePath = process.env.EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE;
const shots = process.env.EVOLOOP_CHUNK_SCREENSHOT_DIR;
const dist = resolve(import.meta.dirname, "../dist");
const projectId = "34000001-0000-4000-8000-000000000001";
const stamp = new Date().toISOString();

test("a page chunk that cannot be fetched shows the updated-workbench state, is not remembered, and opens after a retry without a refresh", {
  skip: !modulePath && "Set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE after building the workbench",
}, async t => {
  const { chromium } = (await import(pathToFileURL(modulePath!).href)).default;
  let chunkAvailable = true; const chunkRequests: string[] = [];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, "http://127.0.0.1");
    if (url.pathname.startsWith("/api/")) {
      let value: unknown = { items: [], nextCursor: null };
      if (url.pathname === "/api/session") value = { principal: { actorId: "reader", projectIds: [projectId], permissions: ["read", "write", "review"], identityKind: "human" }, capabilities: {} };
      else if (url.pathname === `/api/projects/${projectId}`) value = { id: projectId, title: "分块加载回归项目", createdAt: stamp };
      else if (url.pathname.endsWith("/impacts")) value = [];
      res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(value)); return;
    }
    // The operations page chunk is the one that goes missing, as an old tab sees it after a release.
    if (/\/assets\/OperationsPage-[^/]+\.js$/.test(url.pathname)) {
      chunkRequests.push(url.pathname);
      if (!chunkAvailable) { res.writeHead(404, { "content-type": "text/plain" }); res.end("gone"); return; }
    }
    try {
      const path = /^\/(?:$|p\/|ui$)/.test(url.pathname) ? "index.html" : url.pathname;
      const body = await readFile(join(dist, path));
      res.writeHead(200, { "content-type": ({ ".html": "text/html", ".js": "text/javascript", ".css": "text/css" } as Record<string, string>)[extname(path)] ?? "application/octet-stream" });
      res.end(body);
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done)); t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const browser = await chromium.launch({ headless: true, ...(process.env.EVOLOOP_BROWSER_TEST_EXECUTABLE_PATH ? { executablePath: process.env.EVOLOOP_BROWSER_TEST_EXECUTABLE_PATH } : {}) });
  t.after(() => browser.close());

  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    chunkAvailable = true; chunkRequests.length = 0;
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    await page.goto(`${base}/`);
    await page.getByLabel("访问令牌").fill("fixture-token");
    await page.getByRole("button", { name: "进入", exact: true }).click();
    await page.getByRole("heading", { name: "你的项目" }).waitFor();
    await page.getByRole("list", { name: "项目" }).getByRole("link", { name: /分块加载回归项目/ }).click();
    await page.waitForURL(new RegExp(`/p/${projectId}/work`));
    const go = (path: string) => page.evaluate(`(() => { const a = Object.assign(document.createElement("a"), { href: ${JSON.stringify(path)} }); document.body.append(a); a.click(); a.remove(); })()`);
    const url = page.url();
    await page.evaluate("window.__sameDocument = true");
    const sameDocument = () => page.evaluate("window.__sameDocument === true");
    assert.equal(chunkRequests.length, 0, "the page was never visited, so its file was never requested");

    // The file is gone (a release replaced it); the tab opens the page for the first time.
    chunkAvailable = false;
    await go(`/p/${projectId}/operations`);
    const state = page.locator("[data-chunk-failed]");
    await state.waitFor();
    assert.match(await state.innerText(), /工作台已经更新到新版本/);
    assert.match(await state.innerText(), /这一页需要刷新后才能打开。刷新后需要重新输入访问令牌。/);
    assert.equal(await page.getByRole("heading", { name: "这一页显示出错" }).count(), 0, "not the generic page error");
    await state.getByRole("button", { name: "刷新页面" }).waitFor();
    await state.getByText("错误信息").click();
    assert.match(await state.locator("pre").innerText(), /dynamically imported module|Importing a module script failed|OperationsPage/i, "the raw error is behind the detail");
    // No automatic refresh: still the same document, token intact (the shell is still there).
    await page.waitForTimeout(1500);
    assert.equal(await sameDocument(), true, "the page did not reload by itself (a reload would lose the token)");
    assert.equal(page.url().startsWith(url.split("/p/")[0]!), true);
    const fits = await page.evaluate("document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1");
    assert.equal(fits, true, `${viewport.width}: the state fits the width`);
    if (shots) await page.screenshot({ path: join(shots, `chunk-failed-${viewport.width}.png`) });

    // Still gone: retry asks again and shows the state again (a second failure is shown, not hidden).
    const before = chunkRequests.length;
    await state.getByRole("button", { name: "重试" }).click();
    await state.waitFor();
    assert.ok(chunkRequests.length > before, `${viewport.width}: retry requested the chunk again instead of replaying the first failure`);

    // The file is back: retry opens the page in the same tab, no refresh.
    chunkAvailable = true;
    await state.getByRole("button", { name: "重试" }).click();
    await page.getByRole("heading", { name: "结果未知的操作", level: 1 }).waitFor();
    assert.equal(await page.locator("[data-chunk-failed]").count(), 0);
    assert.equal(await sameDocument(), true, "still the same document: no reload happened");
    if (shots) await page.screenshot({ path: join(shots, `chunk-recovered-${viewport.width}.png`) });

    await context.close();
  }

  // Entering the page again after a failure also asks again, without pressing 重试: leave for another page, bring the file back, come back.
  chunkAvailable = true; chunkRequests.length = 0;
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await page.goto(`${base}/`);
  await page.getByLabel("访问令牌").fill("fixture-token");
  await page.getByRole("button", { name: "进入", exact: true }).click();
  await page.getByRole("list", { name: "项目" }).getByRole("link", { name: /分块加载回归项目/ }).click();
  await page.waitForURL(new RegExp(`/p/${projectId}/work`));
  const go = (path: string) => page.evaluate(`(() => { const a = Object.assign(document.createElement("a"), { href: ${JSON.stringify(path)} }); document.body.append(a); a.click(); a.remove(); })()`);
  chunkAvailable = false;
  await go(`/p/${projectId}/operations`);
  await page.locator("[data-chunk-failed]").waitFor();
  await go(`/p/${projectId}/settings`);
  await page.getByRole("heading", { name: "项目设置" }).waitFor();
  chunkAvailable = true;
  await go(`/p/${projectId}/operations`);
  await page.getByRole("heading", { name: "结果未知的操作", level: 1 }).waitFor();
  assert.equal(await page.locator("[data-chunk-failed]").count(), 0, "re-entering the page asked for the chunk again and it opened");
  await context.close();
});
