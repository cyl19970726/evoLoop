// Task 69eefefa: the document list's 载入更多 reads the next page with the cursor the server issued (an opaque (time, id) position,
// not a UUID). When that page cannot be read, even with a 400, the page says so and offers a retry for that page alone; the rows already
// read stay, and the footer never keeps saying "后续页面未读" in silence. Needs EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const modulePath = process.env.EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE;
const required = process.env.EVOLOOP_BROWSER_TEST_REQUIRED === "1";
const dist = resolve(import.meta.dirname, "../dist");
const id = (n: number) => `46000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const projectId = id(1);
const stamp = "2026-11-10T08:00:00.000Z";
const document = (n: number) => ({ projectId, id: id(1000 + n), version: 1, title: `过程文档 ${String(n).padStart(3, "0")}`, kind: "report",
  status: "draft", currentRevisionId: id(5000 + n), adoptedRevisionId: null, primaryTaskId: null, origin: null });
const cursor = Buffer.from(JSON.stringify({ v: 1, t: "2026-11-10T07:00:00.000000Z", id: id(1050) })).toString("base64url");

test("载入更多 sends the issued cursor unchanged; a page that answers 400 is said out loud and retried alone", { skip: !required && !modulePath && "Set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE" }, async t => {
  assert.ok(modulePath, "EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE is required when EVOLOOP_BROWSER_TEST_REQUIRED=1");
  const { chromium } = (await import(pathToFileURL(modulePath).href)).default;
  const reads: Array<string | null> = [];
  let failures = 1;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, "http://127.0.0.1");
    const p = `/api/projects/${projectId}`;
    const send = (value: unknown, status = 200) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
    if (url.pathname.startsWith("/api/")) {
      if (url.pathname === "/api/session") return send({ principal: { actorId: "fixture", projectIds: [projectId], permissions: ["task", "document", "session", "management"], decisions: true }, capabilities: {} });
      if (url.pathname === p) return send({ id: projectId, title: "文档分页项目", createdAt: stamp });
      if (url.pathname === `${p}/documents`) {
        const sent = url.searchParams.get("cursor"); reads.push(sent);
        if (!sent) return send({ items: Array.from({ length: 50 }, (_, i) => document(i + 1)), nextCursor: cursor });
        if (failures > 0) { failures -= 1; return send({ code: "INVALID_INPUT", message: "cursor：Invalid UUID" }, 400); }
        return send({ items: Array.from({ length: 5 }, (_, i) => document(i + 51)), nextCursor: null });
      }
      if (url.pathname === `${p}/work-management/index`) return send({ items: [], nextCursor: null, total: 0, counts: {}, changeSequence: 0, observedAt: stamp, partial: false });
      return send({ items: [], nextCursor: null });
    }
    const file = join(dist, /^\/(?:$|p\/|ui$)/.test(url.pathname) ? "index.html" : url.pathname);
    try { const data = await readFile(file); res.writeHead(200, { "content-type": ({ ".html": "text/html", ".js": "text/javascript", ".css": "text/css" } as Record<string, string>)[extname(file)] ?? "application/octet-stream" }); res.end(data); }
    catch { res.writeHead(404); res.end(); }
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const browser = await chromium.launch({ headless: true, ...(process.env.EVOLOOP_BROWSER_TEST_EXECUTABLE_PATH ? { executablePath: process.env.EVOLOOP_BROWSER_TEST_EXECUTABLE_PATH } : {}) });
  t.after(async () => { await browser.close(); await new Promise<void>(done => server.close(() => done())); });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const errors: string[] = [];
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on("pageerror", (error: Error) => errors.push(error.message));
  await page.goto(`${base}/p/${projectId}/documents`);
  await page.getByLabel("访问令牌").fill("fixture-token");
  await page.getByRole("button", { name: "进入", exact: true }).click();
  const main = page.locator("main");
  const rows = main.locator("tbody tr");
  await main.getByRole("link", { name: "过程文档 050" }).waitFor();
  assert.match(await main.innerText(), /已载入 50 项 · 后续页面未读/);

  await main.getByRole("button", { name: "载入更多" }).click();
  await main.getByText("后面一页没有读回").waitFor();
  assert.equal(reads.at(-1), cursor, "the cursor the server issued is sent back unchanged");
  assert.equal(await rows.count(), 50, "the rows already read stay");
  await main.getByRole("button", { name: "重试这一页" }).click();
  await main.getByRole("link", { name: "过程文档 055" }).waitFor();
  assert.equal(await rows.count(), 55);
  assert.deepEqual(reads, [null, cursor, cursor], "a retry reads that page again, never the first page");
  assert.match(await main.innerText(), /已读完/);

  // 390: the same page says the same thing (the list sits in the page body, not a rail).
  failures = 1; reads.length = 0;
  const narrow = await browser.newPage({ viewport: { width: 390, height: 844 } });
  narrow.on("pageerror", (error: Error) => errors.push(error.message));
  await narrow.goto(`${base}/p/${projectId}/documents`);
  await narrow.getByLabel("访问令牌").fill("fixture-token");
  await narrow.getByRole("button", { name: "进入", exact: true }).click();
  await narrow.locator("main").getByRole("link", { name: "过程文档 050" }).waitFor();
  await narrow.locator("main").getByRole("button", { name: "载入更多" }).click();
  await narrow.locator("main").getByText("后面一页没有读回").waitFor();
  await narrow.locator("main").getByRole("button", { name: "重试这一页" }).click();
  await narrow.locator("main").getByRole("link", { name: "过程文档 055" }).waitFor();
  assert.equal(await narrow.evaluate("document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1"), true, "no horizontal overflow at 390");
  assert.deepEqual(errors, []);
});
