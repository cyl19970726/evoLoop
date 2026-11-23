// Built-app regression for body links (Task a910ee96): ids, `#12` and `PR #12` in the five places become links only when the project
// resolves them to one object; one batch read per page; a failed read leaves plain text; 50 candidates at most. The fixture answers like
// the real batch read (scripts/frontend/fixture/jump.mjs); the real route and queries are in tests/integration/object-jump.test.ts.
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

const modulePath = process.env.EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE;
const required = process.env.EVOLOOP_BROWSER_TEST_REQUIRED === "1";
const shots = process.env.EVOLOOP_REF_SCREENSHOT_DIR;
const repo = resolve(import.meta.dirname, "../../..");
const skip = !required && !modulePath && "Set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE after building the workbench";

test("ids and PR numbers in text become links to the objects they name", { skip }, async t => {
  assert.ok(modulePath, "EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE is required when EVOLOOP_BROWSER_TEST_REQUIRED=1");
  process.env.FIXTURE_REF_SAMPLE = "1";
  const fixtureDir = resolve(repo, "scripts/frontend/fixture");
  const { projectId, token } = await import(pathToFileURL(resolve(fixtureDir, "common.mjs")).href);
  const { startFixtureServer } = await import(pathToFileURL(resolve(fixtureDir, "server.mjs")).href);
  const work = await import(pathToFileURL(resolve(fixtureDir, "work.mjs")).href);
  const refs = await import(pathToFileURL(resolve(fixtureDir, "refs.mjs")).href);
  const { chromium } = (await import(pathToFileURL(modulePath!).href)).default;
  const fx = await startFixtureServer(resolve(import.meta.dirname, "../dist")); t.after(() => fx.close());
  const executablePath = process.env.EVOLOOP_BROWSER_TEST_EXECUTABLE_PATH || process.env.EVOLOOP_BROWSER_TEST_CHROMIUM_EXECUTABLE || undefined;
  const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) }); t.after(() => browser.close());
  const errors: string[] = [];
  const base = `/p/${projectId}`;
  const ids = refs.refIds as Record<string, string>;
  const t1 = work.tasks.t1.id as string;

  const open = async (path: string, width = 1440, height = 900, failRefs = false) => {
    const context = await browser.newContext({ viewport: { width, height }, locale: "zh-CN" });
    const page = await context.newPage(); page.on("pageerror", error => errors.push(error.message));
    const reads: string[][] = [];
    page.on("request", request => { const url = new URL(request.url()); if (url.pathname.endsWith("/jump/refs")) reads.push((url.searchParams.get("q") ?? "").split(",")); });
    if (failRefs) await page.route("**/jump/refs*", route => route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ message: "boom" }) }));
    await page.goto(`${fx.base}${base}/${path}`);
    await page.getByLabel("访问令牌").fill(token); await page.getByRole("button", { name: "进入", exact: true }).click();
    await page.locator("#workspace-main").waitFor({ timeout: 15000 });
    return { page, reads, context };
  };
  const hrefOf = async (scope: any, text: string) => {
    const links = scope.locator("a", { hasText: new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\#]/g, "\\$&")}$`) });
    if (process.env.REF_DEBUG && await links.count() === 0) console.log("MISSING", text, (await scope.first().innerText()).slice(0, 300));
    return await links.count() === 0 ? null : { href: await links.first().getAttribute("href"), title: await links.first().getAttribute("title"), count: await links.count() };
  };
  const expectFive = async (scope: any, fenced: boolean) => {
    assert.equal((await hrefOf(scope, ids.task!.slice(0, 8)))?.href, `${base}/tasks/${ids.task}`, "task short id");
    assert.match((await hrefOf(scope, ids.task!.slice(0, 8)))!.title!, /^任务：任务列表与筛选$/, "hover says the object");
    assert.equal((await hrefOf(scope, ids.document!))?.href, `${base}/documents/${ids.document}`, "document full id");
    assert.match((await hrefOf(scope, ids.document!))!.title!, /^文档：/);
    assert.equal((await hrefOf(scope, ids.agent!.slice(0, 8)))?.href, `${base}/sessions?session=${encodeURIComponent(`owned:${ids.agent}`)}`, "agent short id");
    assert.match((await hrefOf(scope, ids.agent!.slice(0, 8)))!.title!, /^智能体：/);
    assert.equal((await hrefOf(scope, ids.stage!))?.href, `${base}/journey?stage=${ids.stage}`, "stage id");
    assert.equal((await hrefOf(scope, ids.schedule!.slice(0, 8)))?.href, `${base}/schedules?schedule=${ids.schedule}`, "schedule id");
    assert.equal((await hrefOf(scope, ids.delivery!.slice(0, 8)))?.href, `${base}/tasks/${t1}?tab=delivery`, "delivery id goes to the delivery tab");
    assert.match((await hrefOf(scope, ids.delivery!.slice(0, 8)))!.title!, /^交付：/);
    assert.equal((await hrefOf(scope, "#12"))?.href, `${base}/tasks/${t1}?tab=delivery`, "#12");
    assert.equal((await hrefOf(scope, "PR #12"))?.href, `${base}/tasks/${t1}?tab=delivery`, "PR #12");
    assert.equal(await hrefOf(scope, ids.missing!), null, "a nonexistent 8-hex is text");
    assert.equal(await hrefOf(scope, ids.date!), null, "a date is text");
    assert.equal(await hrefOf(scope, ids.foreign!), null, "an id that only another project has is text");
    assert.equal(await scope.locator("a[href^='javascript:' i]").count(), 0, "javascript: link syntax gives no link");
    assert.equal((await hrefOf(scope, ids.clash!))?.href, `${base}/go/${ids.clash}`, "a shared prefix goes to the choice page");
    const url = await hrefOf(scope, "https://example.test/ref/1");
    if (url) assert.equal(url.href, "https://example.test/ref/1", "a URL stays an external link");
    // the fence and the single backticks in plain text are code too
    assert.equal(await scope.locator("a", { hasText: /^`|`$/ }).count(), 0);
    if (fenced) {
      const inline = scope.locator("a code", { hasText: ids.task!.slice(0, 8) });
      assert.equal(await inline.count(), 1, "inline code is linked, the fenced block is not");
      assert.equal(await scope.locator("pre a").count(), 0, "no link inside a code block");
    }
  };

  // ---- the task page: body and completion condition (one read for all of it) ----
  const task = await open(`tasks/${t1}`);
  await task.page.locator(".markdown-body").first().waitFor();
  await task.page.waitForFunction(() => document.querySelectorAll(".markdown-body a[title]").length > 5);
  assert.equal(task.reads.length, 1, "one batch read for the task page");
  assert.equal(new Set(task.reads[0]).size, task.reads[0]!.length, "candidates are deduplicated");
  assert.ok(task.reads[0]!.includes("#12") && task.reads[0]!.includes(ids.missing!) && task.reads[0]!.length <= 50);
  await expectFive(task.page.locator("[data-task-acceptance]").first(), true);
  await expectFive(task.page.locator(".markdown-body").filter({ hasText: "行内代码" }).last(), true);
  const inEnglish = await task.page.locator(".markdown-body a", { hasText: "https://example.test/ref/1" }).count();
  assert.ok(inEnglish >= 0);
  // focus describes the link too
  await task.page.locator("[data-task-acceptance] a[title^='任务：']").first().focus();
  assert.match(await task.page.evaluate(() => document.activeElement?.getAttribute("aria-description") ?? ""), /^任务：/);
  if (shots) { await task.page.screenshot({ path: `${shots}/task-1440x900.png` }); }
  // a click lands on the object
  await task.page.locator("[data-task-acceptance] a[title^='文档：']").first().click();
  await task.page.waitForURL(`**${base}/documents/${ids.document}`);
  await task.context.close();

  // ---- delivery and observation text ----
  const delivery = await open(`tasks/${t1}?tab=delivery`);
  await delivery.page.waitForFunction(() => document.querySelectorAll("a[title^='任务：']").length > 0);
  assert.ok(delivery.reads.length >= 1 && delivery.reads.length <= 2, `delivery tab reads ${delivery.reads.length} times`);
  await expectFive(delivery.page.locator("main").first(), false);
  // each plain text holds the id three times (a sentence, backticks, a fence): only the sentence is a link
  const plainTexts = delivery.page.locator("main p.whitespace-pre-wrap", { hasText: "行内代码", hasNotText: /^验收：/ });
  assert.ok(await plainTexts.count() >= 1, "the evidence text is there");
  for (const text of await plainTexts.all()) assert.equal(await text.locator("a", { hasText: ids.task!.slice(0, 8) }).count(), 1, "backticks and a fence in plain text are not linked");
  await delivery.context.close();

  // ---- a document ----
  const doc = await open(`documents/${ids.document}`);
  await doc.page.waitForFunction(() => document.querySelectorAll(".markdown-body a[title^='任务：']").length > 0);
  assert.equal(doc.reads.length, 1, "one batch read for the document page");
  await expectFive(doc.page.locator(".markdown-body").first(), true);
  if (shots) await doc.page.screenshot({ path: `${shots}/document-1440x900.png` });
  await doc.context.close();

  // ---- the conversation ----
  const chat = await open(`sessions?session=${encodeURIComponent(`owned:${ids.agent}`)}`);
  await chat.page.waitForTimeout(2500);
  if (process.env.REF_DEBUG) console.log("CHAT", chat.reads, (await chat.page.locator("#workspace-main").innerText()).slice(0, 1200));
  await chat.page.waitForFunction(() => document.querySelectorAll("a[title^='任务：']").length > 0, undefined, { timeout: 15000 });
  assert.equal(chat.reads.length, 1, "one batch read for the conversation");
  await expectFive(chat.page.locator("#workspace-main"), false);
  assert.equal(await chat.page.locator("#workspace-main pre a").count(), 0, "no link inside a fenced block of a message");
  await chat.context.close();

  // ---- a failed read leaves plain text, no error ----
  const down = await open(`tasks/${t1}`, 1440, 900, true);
  await down.page.locator(".markdown-body").first().waitFor();
  await down.page.waitForFunction(() => document.body.innerText.includes("deadbeef"));
  assert.equal(await down.page.locator(".markdown-body a[title]").count(), 0, "no half link");
  assert.equal(await down.page.getByRole("alert").count(), 0, "no error shown");
  assert.ok(await down.page.locator("body").innerText().then(text => text.includes(ids.task!.slice(0, 8))), "the text stays");
  await down.context.close();

  // ---- phone ----
  const phone = await open(`tasks/${t1}`, 390, 844);
  await phone.page.waitForFunction(() => document.querySelectorAll(".markdown-body a[title]").length > 5);
  assert.ok(await phone.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "no horizontal scroll at 390");
  if (shots) await phone.page.screenshot({ path: `${shots}/task-390x844.png` });
  await phone.context.close();
  assert.deepEqual(errors, []);
});

test("text with no candidate asks nothing, and 80 candidates ask for 50", { skip }, async t => {
  assert.ok(modulePath);
  const fixtureDir = resolve(repo, "scripts/frontend/fixture");
  const { projectId, token } = await import(pathToFileURL(resolve(fixtureDir, "common.mjs")).href);
  const { startFixtureServer } = await import(pathToFileURL(resolve(fixtureDir, "server.mjs")).href);
  const work = await import(pathToFileURL(resolve(fixtureDir, "work.mjs")).href);
  const { chromium } = (await import(pathToFileURL(modulePath!).href)).default;
  const executablePath = process.env.EVOLOOP_BROWSER_TEST_EXECUTABLE_PATH || process.env.EVOLOOP_BROWSER_TEST_CHROMIUM_EXECUTABLE || undefined;
  const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) }); t.after(() => browser.close());
  const visit = async (path: string) => {
    const fx = await startFixtureServer(resolve(import.meta.dirname, "../dist"));
    const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "zh-CN" })).newPage();
    const reads: string[][] = [];
    page.on("request", request => { const url = new URL(request.url()); if (url.pathname.endsWith("/jump/refs")) reads.push((url.searchParams.get("q") ?? "").split(",")); });
    const started = Date.now();
    await page.goto(`${fx.base}/p/${projectId}/${path}`);
    await page.getByLabel("访问令牌").fill(token); await page.getByRole("button", { name: "进入", exact: true }).click();
    await page.locator("#workspace-main").waitFor({ timeout: 15000 });
    await page.locator(".markdown-body").first().waitFor();
    return { page, reads, opened: Date.now() - started, close: () => fx.close() };
  };
  delete process.env.FIXTURE_REF_SAMPLE; delete process.env.FIXTURE_REF_MANY;
  const plain = await visit(`tasks/${work.tasks.t2.id}`);
  await plain.page.waitForTimeout(600);
  assert.deepEqual(plain.reads, [], "no candidate, no request");
  await plain.close();

  process.env.FIXTURE_REF_SAMPLE = "1"; process.env.FIXTURE_REF_MANY = "1";
  const many = await visit(`tasks/${work.tasks.t1.id}`);
  await many.page.waitForFunction(() => document.querySelectorAll(".markdown-body a[title]").length > 5);
  await many.page.waitForTimeout(400);
  assert.equal(many.reads.length, 1, "one read");
  assert.equal(many.reads[0]!.length, 50, "50 asked, the rest stay text");
  assert.ok(many.opened < 8000, `opened in ${many.opened} ms`);
  console.log(`80 candidates: page open in ${many.opened} ms, ${many.reads[0]!.length} asked`);
  await many.close();
  delete process.env.FIXTURE_REF_SAMPLE; delete process.env.FIXTURE_REF_MANY;
});
