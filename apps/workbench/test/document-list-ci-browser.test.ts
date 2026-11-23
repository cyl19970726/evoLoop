// Built-app regression for the document list (docs/frontend/pages/documents.md): newest change first, the type filter (简报,
// 复盘, 交付报告, …) and the title search are the server's, and type, status and search live in the address (refresh, back,
// a shared link). The fixture service answers the way the real one does (scripts/frontend/fixture/work.mjs documentList).
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

const modulePath = process.env.EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE;
const required = process.env.EVOLOOP_BROWSER_TEST_REQUIRED === "1";
const shots = process.env.EVOLOOP_DOCUMENTS_SCREENSHOT_DIR;
const repo = resolve(import.meta.dirname, "../../..");
const skip = !required && !modulePath && "Set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE after building the workbench";

test("document list: order, server filters, search and the address", { skip }, async t => {
  assert.ok(modulePath, "EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE is required when EVOLOOP_BROWSER_TEST_REQUIRED=1");
  const { projectId, token } = await import(pathToFileURL(resolve(repo, "scripts/frontend/fixture/common.mjs")).href);
  const { startFixtureServer } = await import(pathToFileURL(resolve(repo, "scripts/frontend/fixture/server.mjs")).href);
  const { chromium } = (await import(pathToFileURL(modulePath!).href)).default;
  const fx = await startFixtureServer(resolve(import.meta.dirname, "../dist")); t.after(() => fx.close());
  const executablePath = process.env.EVOLOOP_BROWSER_TEST_EXECUTABLE_PATH || process.env.EVOLOOP_BROWSER_TEST_CHROMIUM_EXECUTABLE || undefined;
  const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) }); t.after(() => browser.close());
  const errors: string[] = [];
  const open = async (width: number, height: number, path = "documents", colorScheme: "light" | "dark" = "light") => {
    const context = await browser.newContext({ viewport: { width, height }, locale: "zh-CN", colorScheme });
    const page = await context.newPage(); page.on("pageerror", error => errors.push(error.message));
    const requests: string[] = [];
    page.on("request", request => { const url = new URL(request.url()); if (url.pathname.endsWith(`/projects/${projectId}/documents`)) requests.push(url.search); });
    await page.goto(`${fx.base}/p/${projectId}/${path}`);
    await page.getByLabel("访问令牌").fill(token); await page.getByRole("button", { name: "进入", exact: true }).click();
    await page.locator("table tbody tr").first().waitFor({ timeout: 15000 });
    return { page, requests };
  };
  // The login lives in memory: a fresh page load (refresh, a pasted address) asks for the token again.
  const load = async (page: Awaited<ReturnType<typeof open>>["page"], path: string | null) => {
    if (path === null) await page.reload(); else await page.goto(`${fx.base}/p/${projectId}/${path}`);
    await page.getByLabel("访问令牌").fill(token); await page.getByRole("button", { name: "进入", exact: true }).click();
  };
  const titles = (page: Awaited<ReturnType<typeof open>>["page"]) => page.locator("table tbody tr td:first-child a").allInnerTexts();
  const search = (page: Awaited<ReturnType<typeof open>>["page"]) => page.locator('[aria-label="搜索文档"]:visible').first();
  const kind = (page: Awaited<ReturnType<typeof open>>["page"]) => page.locator('[aria-label="文档类型筛选"]:visible').first();
  const query = (page: Awaited<ReturnType<typeof open>>["page"]) => new URL(page.url()).search;

  const { page, requests } = await open(1440, 900);
  // Newest change first: the fixture's documents are one hour apart in list order; every row carries its time.
  const all = await titles(page);
  assert.equal(all[0], "本轮需求总图");
  assert.ok(all.length >= 8, `all documents: ${all.join("|")}`);
  assert.equal(await page.locator("table tbody tr td:last-child").filter({ hasText: "待核对" }).count(), 0, "every row has its time");
  assert.equal(requests[0], "?limit=50&status=active", "the default list asks for the 未归档 documents, newest first, nothing else");
  assert.deepEqual(await kind(page).locator("option").allInnerTexts(), ["全部类型", "简报", "复盘", "交付报告", "任务正文", "规范", "讨论", "问题", "其他报告"]);

  // 简报: a type of its own; the server filters and the address says so.
  await kind(page).selectOption("brief");
  await page.waitForFunction(() => document.querySelectorAll("table tbody tr").length === 1);
  assert.deepEqual(await titles(page), ["每日简报 2026-11-20"]);
  assert.equal(query(page), "?kind=brief");
  assert.ok(requests.some(request => request.includes("kind=brief")), "the type reached the server");
  // 交付报告 is a relation (a Delivery names the document); 其他报告 is a report that is not one: the two never overlap.
  await kind(page).selectOption("delivery_report");
  await page.waitForFunction(() => document.querySelectorAll("table tbody tr").length === 2);
  const delivered = await titles(page);
  assert.deepEqual([...delivered].sort(), ["试用反馈汇总", "首轮试用报告"].sort());
  await kind(page).selectOption("other_report");
  await page.getByLabel("过程文档").getByText("没有符合条件的文档").waitFor();
  assert.equal(query(page), "?kind=other_report");

  // Search: sent to the server (it covers every document), joins the type as an intersection, and is written to the address.
  await kind(page).selectOption("all");
  await search(page).fill("对账");
  await page.waitForFunction(() => document.querySelectorAll("table tbody tr").length === 1);
  assert.deepEqual(await titles(page), ["对账规则"]);
  await page.waitForFunction(() => location.search === "?q=%E5%AF%B9%E8%B4%A6");
  assert.ok(requests.some(request => request.includes("search=%E5%AF%B9%E8%B4%A6")), "the search reached the server");
  assert.equal(requests.filter(request => request.includes("search=")).length, 1, "typing is sent once it rests, not per letter");
  await kind(page).selectOption("spec");
  await page.waitForFunction(() => location.search.startsWith("?kind=spec&q="));
  assert.deepEqual(await titles(page), ["对账规则"], "type and search together: the intersection");
  await kind(page).selectOption("brief");
  await page.getByLabel("过程文档").getByText("没有符合条件的文档").waitFor();

  // Back undoes one step at a time; a refresh keeps the conditions.
  await page.goBack();
  await page.waitForFunction(() => location.search === "?kind=spec&q=%E5%AF%B9%E8%B4%A6");
  assert.equal(await kind(page).inputValue(), "spec");
  await page.goBack();
  await page.waitForFunction(() => location.search === "?q=%E5%AF%B9%E8%B4%A6");
  assert.equal(await search(page).inputValue(), "对账");
  assert.equal(await kind(page).inputValue(), "all");
  await page.goBack();
  await page.waitForFunction(() => location.search === "");
  assert.equal(await search(page).inputValue(), "");
  await load(page, "documents?kind=other_report");
  await page.getByLabel("过程文档").getByText("没有符合条件的文档").waitFor();
  await load(page, null);
  await page.getByLabel("过程文档").getByText("没有符合条件的文档").waitFor();
  assert.equal(await kind(page).inputValue(), "other_report");
  await load(page, `documents?kind=brief&status=all&q=${encodeURIComponent("简报")}`);
  await page.waitForFunction(() => document.querySelectorAll("table tbody tr").length === 1);
  assert.equal(await kind(page).inputValue(), "brief");
  assert.equal(await search(page).inputValue(), "简报");
  assert.equal(await page.locator('[aria-label="文档状态筛选"]:visible').first().inputValue(), "all");
  await page.context().close();

  // The old address of the organisation review still works; 390 wide and both colour schemes have no sideways overflow.
  const legacy = await open(1440, 900, "documents?kind=organization_review");
  assert.deepEqual(await titles(legacy.page), ["十一月第一周组织复盘"]);
  await legacy.page.context().close();
  for (const [width, height] of [[1440, 900], [390, 844]] as const) for (const scheme of ["light", "dark"] as const) {
    const view = await open(width, height, "documents", scheme);
    const overflow = await view.page.evaluate("document.documentElement.scrollWidth - window.innerWidth");
    assert.ok((overflow as number) <= 0, `no sideways overflow at ${width} ${scheme}: ${overflow}`);
    if (shots) await view.page.screenshot({ path: `${shots}/documents-${width}-${scheme}.png` });
    await view.page.context().close();
  }
  assert.deepEqual(errors, []);
});
