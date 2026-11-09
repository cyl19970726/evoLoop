// Opt-in built-app regression: build workbench, then set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE.
// The document list reads page by page (shared/query.ts useProjectList): 载入更多 reads only the next page, a failed
// next page keeps the loaded rows and is retried alone (这一页没读到), a failed reread keeps the rows as 上次读回 with
// the service's English only in 诊断信息, and a list never read is not called 上次读回 — also after switching to
// another kind, whose first page failing never shows the last kind's rows. The coverage line says 已读完 only for a
// list that was just read. All data is synthetic.
// Screenshots: EVOLOOP_DOCUMENT_SCREENSHOT_DIR.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const modulePath = process.env.EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE;
const shots = process.env.EVOLOOP_DOCUMENT_SCREENSHOT_DIR;
const dist = resolve(import.meta.dirname, "../dist");
const id = (n: number) => `46000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const projectId = id(1);
const stamp = "2026-11-10T08:00:00.000Z";
const document = (n: number, kind = "report") => ({ projectId, id: id(1000 + n), version: 1, title: `${kind === "spec" ? "规范文档" : "过程文档"} ${String(n).padStart(3, "0")}`, kind,
  status: "draft", currentRevisionId: id(5000 + n), adoptedRevisionId: null, primaryTaskId: null, origin: null });
/** Three pages of 50: cursors p2 and p3. */
const pages: Record<string, { items: ReturnType<typeof document>[]; nextCursor: string | null }> = {
  first: { items: Array.from({ length: 50 }, (_, i) => document(i + 1)), nextCursor: "p2" },
  p2: { items: Array.from({ length: 50 }, (_, i) => document(i + 51)), nextCursor: "p3" },
  p3: { items: Array.from({ length: 20 }, (_, i) => document(i + 101)), nextCursor: null },
};
const specs = { items: [document(901, "spec"), document(902, "spec")], nextCursor: null };

test("the document list reads one more page at a time and keeps what it read when a page or a reread fails", {
  skip: !modulePath && "Set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE",
}, async t => {
  const { chromium } = (await import(pathToFileURL(modulePath!).href)).default;
  const reads: string[] = [];
  const fail: Record<string, number> = {};
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, "http://127.0.0.1");
    const p = `/api/projects/${projectId}`;
    const send = (value: unknown, status = 200) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
    if (url.pathname.startsWith("/api/")) {
      if (url.pathname === "/api/session") return send({ principal: { actorId: "fixture", projectIds: [projectId], permissions: ["read", "write", "review"] }, capabilities: {} });
      if (url.pathname === p) return send({ id: projectId, title: "文档分页项目", createdAt: stamp });
      if (url.pathname === `${p}/documents`) {
        const kind = url.searchParams.get("kind") ?? "all";
        const cursor = `${kind}:${url.searchParams.get("cursor") ?? "first"}`;
        reads.push(cursor);
        if ((fail[cursor] ?? 0) > 0) { fail[cursor]!--; return send({ message: "list store unavailable" }, 503); }
        if (kind === "spec") return send(specs);
        return send(pages[cursor.slice(4)] ?? { items: [], nextCursor: null });
      }
      if (url.pathname === `${p}/work-management/index`) return send({ items: [], nextCursor: null, total: 0, counts: {}, changeSequence: 0, observedAt: stamp, partial: false });
      return send({ items: [], nextCursor: null });
    }
    const file = join(dist, /^\/(?:$|p\/|ui$)/.test(url.pathname) ? "index.html" : url.pathname);
    try { const body = await readFile(file); res.writeHead(200, { "content-type": ({ ".html": "text/html", ".js": "text/javascript", ".css": "text/css" } as Record<string, string>)[extname(file)] ?? "application/octet-stream" }); res.end(body); }
    catch { res.writeHead(404); res.end(); }
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const browser = await chromium.launch({ headless: true, ...(process.env.EVOLOOP_BROWSER_TEST_EXECUTABLE_PATH
    ? { executablePath: process.env.EVOLOOP_BROWSER_TEST_EXECUTABLE_PATH } : {}) });
  t.after(async () => { await browser.close(); await new Promise<void>(done => server.close(() => done())); });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const errors: string[] = [];
  const open = async (viewport = { width: 1440, height: 900 }) => {
    const page = await browser.newPage({ viewport });
    page.on("pageerror", (error: Error) => errors.push(error.message));
    await page.goto(`${base}/p/${projectId}/documents`);
    await page.getByLabel("访问令牌").fill("fixture-token");
    await page.getByRole("button", { name: "进入", exact: true }).click();
    return page;
  };
  const count = (cursor: string) => reads.filter(item => item === cursor).length;

  // ---- A list never read says only that: no 上次读回, no English.
  fail["all:first"] = 1;
  const page = await open();
  const main = page.locator("main");
  await main.getByText("列表本次没有读回").waitFor();
  const unread = await main.innerText();
  assert.match(unread, /服务暂时出错[\s\S]*没有读回之前不能判断有哪些文档/);
  assert.doesNotMatch(unread, /上次读到的内容|只供核对|list store unavailable|已读完|已载入 0 项/);
  assert.match(unread, /列表没有读回，无法判断有多少/);
  await main.getByRole("button", { name: "重试", exact: true }).click();
  const rows = main.locator("tbody tr");
  await main.getByRole("link", { name: "过程文档 050" }).waitFor();
  assert.equal(await rows.count(), 50);

  // ---- 载入更多 reads only the next page; a failed next page keeps the rows and is retried alone.
  const firstReads = count("all:first");
  fail["all:p2"] = 1;
  await main.getByRole("button", { name: "载入更多" }).click();
  await main.getByText("后面一页没有读回").waitFor();
  assert.equal(await rows.count(), 50, "the loaded rows stay");
  assert.doesNotMatch(await main.innerText(), /上次读到的内容|只供核对|list store unavailable/, "a failed next page leaves the loaded rows current");
  if (shots) await page.screenshot({ path: `${shots}/document-list-page-failed-1440.png` });
  await main.getByRole("button", { name: "重试这一页" }).click();
  await main.getByRole("link", { name: "过程文档 100" }).waitFor();
  assert.equal(await rows.count(), 100);
  assert.equal(count("all:first"), firstReads, "loading more never reads the first page again");
  assert.equal(count("all:p2"), 2);
  assert.equal(count("all:p3"), 0, "no page is read ahead of the range asked for");

  // ---- A failed reread keeps the rows, marked, and the service's English is only in 诊断信息.
  fail["all:first"] = 1;
  await main.getByRole("button", { name: "重新读取" }).first().click();
  await main.getByText("列表本次没有读回").waitFor();
  const stale = await main.innerText();
  assert.match(stale, /下面仍是上次读到的内容/);
  assert.doesNotMatch(stale, /list store unavailable/);
  assert.equal(await rows.count(), 100);
  assert.match(stale, /上次读回 100 项 · 后续页面未读 · 当前待核对/);
  assert.doesNotMatch(stale, /已读完/);
  await main.getByText("诊断信息").click();
  await main.getByText("list store unavailable").waitFor();
  if (shots) await page.screenshot({ path: `${shots}/document-list-reread-failed-1440.png` });

  // ---- Another kind is another list: its first page failing is a failed read, never the last kind's rows as 上次读回.
  await main.getByRole("button", { name: "重试", exact: true }).click();
  await main.getByRole("link", { name: "过程文档 100" }).waitFor();
  fail["spec:first"] = 1;
  // At 1440 the filters sit in the inner rail.
  await page.locator("aside[aria-label=项目导航]").getByLabel("文档类型筛选").selectOption("spec");
  await main.getByText("列表本次没有读回").waitFor();
  const switched = await main.innerText();
  assert.equal(await rows.count(), 0, "the last kind's rows are not shown for this kind");
  assert.doesNotMatch(switched, /过程文档 0|上次读回|上次读到的内容|只供核对|已读完/);
  assert.match(switched, /没有读回之前不能判断有哪些文档/);
  const rail = page.locator("aside[aria-label=项目导航]");
  assert.doesNotMatch(await rail.innerText(), /过程文档 0|上次读回|已读完/, "the inner rail says the same");
  if (shots) await page.screenshot({ path: `${shots}/document-list-kind-failed-1440.png` });
  await main.getByRole("button", { name: "重试", exact: true }).click();
  await main.getByRole("link", { name: "规范文档 901" }).waitFor();
  assert.match(await main.innerText(), /已载入 2 项 · 匹配 2 项 · 已读完/);
  await page.close();

  // ---- 1024 and 390: the same list without horizontal overflow of the page.
  for (const viewport of [{ width: 1024, height: 768 }, { width: 390, height: 844 }]) {
    const narrow = await open(viewport);
    await narrow.locator("main").getByRole("link", { name: "过程文档 001" }).waitFor();
    assert.equal(await narrow.evaluate("document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1"), true, `${viewport.width}: no horizontal overflow`);
    if (shots) await narrow.screenshot({ path: `${shots}/document-list-${viewport.width}.png` });
    await narrow.close();
  }
  assert.deepEqual(errors, []);
});
