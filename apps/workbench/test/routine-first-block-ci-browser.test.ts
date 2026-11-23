// Built-app regression (Task 27f49bab): a routine that is not well shows in the overview's first block, and a Task made by a routine that nobody took up is
// marked in the schedule page's 例行健康 table. The fixture answers /routine-health with eight sample routines (a)–(h) and the paused and sample ones; the
// overview reads it once, says the first of the not-well ones, links to the table, and says a failed read as a failed kind. Needs the built workbench and
// EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE; EVOLOOP_ROUTINE_FIRST_SCREENSHOT_DIR keeps screenshots.
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

const modulePath = process.env.EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE;
const required = process.env.EVOLOOP_BROWSER_TEST_REQUIRED === "1";
const shots = process.env.EVOLOOP_ROUTINE_FIRST_SCREENSHOT_DIR;
const repo = resolve(import.meta.dirname, "../../..");
const skip = !required && !modulePath && "Set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE after building the workbench";
type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ago = (minutes: number) => new Date(Date.now() - minutes * 60000).toISOString();
const ahead = (minutes: number) => ago(-minutes);

test("例行工作 in the overview's first block, and 没人接 in the health table", { skip }, async t => {
  assert.ok(modulePath, "EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE is required when EVOLOOP_BROWSER_TEST_REQUIRED=1");
  const { projectId, token } = await import(pathToFileURL(resolve(repo, "scripts/frontend/fixture/common.mjs")).href);
  const { startFixtureServer } = await import(pathToFileURL(resolve(repo, "scripts/frontend/fixture/server.mjs")).href);
  const spaces = await import(pathToFileURL(resolve(repo, "scripts/frontend/fixture/spaces.mjs")).href) as Record<string, any>;
  const { chromium } = (await import(pathToFileURL(modulePath!).href)).default;
  const fx = await startFixtureServer(resolve(import.meta.dirname, "../dist")); t.after(() => fx.close());
  const executablePath = process.env.EVOLOOP_BROWSER_TEST_EXECUTABLE_PATH || process.env.EVOLOOP_BROWSER_TEST_CHROMIUM_EXECUTABLE || undefined;
  const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) }); t.after(() => browser.close());
  if (shots) mkdirSync(shots, { recursive: true });
  const errors: string[] = [];

  // The eight routines of the Task, in the server's order: (g) first, then (f)(a)(h) in one group, then the rest. Titles are 12 characters or more on purpose.
  const [template] = spaces.schedules.list();
  const names: Record<string, string> = { g: "每日应触发却没有记录的巡检", f: "夜间对账连续跳过三次的例行", a: "每日巡检三小时没有人接的例行", h: "每日重复的任务系列昨天那份没人接",
    b: "只过了一小时的例行工作", c: "已经排在智能体队伍里的例行", d: "已有分派但还没有运行的例行", e: "正在进行中的例行工作", paused: "已暂停但有没人接的任务", sample: "验收样本日程（没人接）" };
  const ids: Record<string, string> = Object.fromEntries(Object.keys(names).map((key, index) => [key, uuid(index + 1)]));
  const definition = (key: string, state = "active") => ({ ...template, id: ids[key], currentRevisionId: ids[key], state,
    revision: { ...template.revision, id: ids[key], scheduleId: ids[key], template: { ...template.revision.template, title: names[key] } } });
  const schedules = Object.keys(names).filter(key => key !== "h").map(key => definition(key, key === "paused" ? "paused" : "active"));
  const base = { kind: "schedule", rule: { kind: "daily", localTime: "07:30" }, timezone: "Asia/Shanghai", repeat: null, rootTaskId: null, misfire: "latest", skippedTotal: null,
    consecutiveSkips: 0, overdue: null, lastTaskOpen: false, watermarkUtc: ago(60), lastTaskUnreceived: null, nextAtUtc: ahead(60 * 20) };
  const made = (title: string, state: string, n: number, minutes: number) => ({ plannedAtUtc: ago(minutes), observedAtUtc: ago(minutes - 1), outcome: "created", reason: "scheduled", task: { taskId: uuid(100 + n), title, state } });
  const row = (key: string, over: Record<string, unknown>) => ({ ...base, id: ids[key], title: names[key], state: key === "paused" ? "paused" : "active", ...over });
  const items = () => [
    row("g", { overdue: { expectedAtUtc: ago(60 * 4) }, lastTrigger: null }),
    row("f", { consecutiveSkips: 3, lastTaskOpen: false, lastTrigger: { plannedAtUtc: ago(60 * 3), observedAtUtc: ago(60 * 3), outcome: "skipped", reason: "overlap skipped", task: null } }),
    row("a", { lastTaskOpen: true, lastTaskUnreceived: { sinceUtc: ago(60 * 3) }, lastTrigger: made("每日巡检任务", "todo", 1, 60 * 3) }),
    { ...base, kind: "timed_series", id: uuid(60), title: names.h, state: "active", rule: null, repeat: "daily", rootTaskId: uuid(61), misfire: null, watermarkUtc: null, lastTaskOpen: true,
      lastTaskUnreceived: { sinceUtc: ago(60 * 26) }, lastTrigger: made("昨天那份任务", "todo", 2, 60 * 26) },
    row("b", { lastTaskOpen: true, lastTrigger: made("一小时前的任务", "todo", 3, 60) }),
    row("c", { lastTaskOpen: true, lastTrigger: made("在队伍里的任务", "todo", 4, 60 * 3) }),
    row("d", { lastTaskOpen: true, lastTrigger: made("已分派的任务", "todo", 5, 60 * 3) }),
    row("e", { lastTaskOpen: true, lastTrigger: made("进行中的任务", "in_progress", 6, 60 * 3) }),
    row("paused", { lastTaskOpen: true, nextAtUtc: null, lastTrigger: made("暂停前的任务", "todo", 7, 60 * 9) }),
    row("sample", { lastTaskOpen: true, lastTrigger: made("样本任务", "todo", 8, 60 * 9) }),
  ];
  const withoutG = () => items().filter(item => item.id !== ids.g);
  const wellOnly = () => items().filter(item => ["b", "c", "d", "e", "paused", "sample"].some(key => ids[key] === item.id));

  const open = async (width: number, height: number, health: { value: Json }, path = "/overview", scheme: "light" | "dark" = "light") => {
    const context = await browser.newContext({ viewport: { width, height }, locale: "zh-CN", timezoneId: "Asia/Shanghai", reducedMotion: "reduce", colorScheme: scheme });
    const page = await context.newPage(); page.on("pageerror", error => errors.push(error.message));
    const reads: string[] = [];
    page.on("request", request => { if (/\/routine-health(\?|$)/.test(request.url())) reads.push(request.url()); });
    await page.route(new RegExp(`/api/projects/${projectId}/schedules$`), route => route.fulfill({ json: schedules }));
    await page.route(new RegExp(`/api/projects/${projectId}/routine-health$`), route => health.value === "fail"
      ? route.fulfill({ status: 500, json: { code: "RESULT_UNCONFIRMED" } })
      : route.fulfill({ json: { projectId, observedAt: new Date().toISOString(), complete: true, items: health.value } }));
    await page.goto(`${fx.base}/p/${projectId}${path}`);
    await page.getByLabel("访问令牌").fill(token); await page.getByRole("button", { name: "进入", exact: true }).click();
    await page.locator("#workspace-main").waitFor({ timeout: 15000 });
    return { page, context, reads };
  };
  const priority = (page: Json) => page.locator("[data-overview-block=priority]");
  const settled = async (page: Json) => { await priority(page).locator("h2").waitFor(); await page.waitForFunction(() => !/正在读取/.test(document.querySelector("[data-overview-block=priority]")?.textContent ?? ""), null, { timeout: 15000 }); };
  const rowsText = async (page: Json) => priority(page).locator("ul > li:not([data-overview-routine])").evaluateAll((nodes: Element[]) => nodes.map(node => node.textContent));
  /** "还有 K 项" (or null), then the fold opened so every row can be read. */
  const more = async (page: Json) => { const button = priority(page).getByRole("button", { name: /^还有 \d+ 项$/ });
    if (!await button.count()) return null; const text = await button.innerText(); await button.click(); return Number(/\d+/.exec(text)![0]); };
  const titleOf = async (page: Json) => (await priority(page).locator("h2").innerText()).trim();

  // ---- the baseline: no routine is not well ----
  const quiet = await open(1440, 900, { value: wellOnly() });
  await settled(quiet.page);
  assert.equal(await quiet.page.locator("[data-overview-routine]").count(), 0, "nothing not well: no row");
  const baselineTitle = await titleOf(quiet.page), baselineMore = await more(quiet.page), baselineRows = await rowsText(quiet.page);
  assert.ok(baselineMore !== null, "the fixture's own rows already fill the block, so the new row lands behind 还有 K 项");
  const baselineCount = Number(/· (\d+)$/.exec(baselineTitle)?.[1] ?? 0);
  await quiet.context.close();

  // ---- (g) is named, the count is four, the title counts it, the other rows are as before, one read ----
  const full = await open(1440, 900, { value: items() });
  await settled(full.page);
  const fullMore = await more(full.page);
  await full.page.locator("[data-overview-routine]").waitFor({ timeout: 15000 });
  assert.equal(fullMore, baselineMore! + 1, "还有 K 项 counts the routine row too");
  const line = (await full.page.locator("[data-overview-routine]").innerText()).replace(/\s+/g, " ").trim();
  assert.match(line, new RegExp(`^例行工作 4 条不正常：${names.g}，应在 \\d\\d/\\d\\d \\d\\d:\\d\\d 触发，没有记录$`), line);
  assert.equal(await full.page.locator("[data-overview-routine] a").getAttribute("href"), `/p/${projectId}/schedules#routine-health`);
  const title = await titleOf(full.page);
  assert.equal(Number(/· (\d+)$/.exec(title)?.[1]), baselineCount + 1, `the title counts the row: ${baselineTitle} -> ${title}`);
  assert.deepEqual(await rowsText(full.page), baselineRows, "the rows that were there are the same, in the same order");
  assert.equal(full.reads.length, 1, "the overview adds exactly one read of /routine-health");
  assert.equal((await full.page.locator("[data-overview-routine]").boundingBox()).width > 0, true);
  if (shots) await full.page.screenshot({ path: `${shots}/overview-1440.png` });
  // The row opens the schedule page at the table, and the table is in view.
  await full.page.locator("[data-overview-routine] a").click();
  await full.page.getByRole("region", { name: "例行健康" }).waitFor();
  assert.equal(new URL(full.page.url()).hash, "#routine-health");
  const box = await full.page.getByRole("region", { name: "例行健康" }).boundingBox();
  assert.ok(box.y >= 0 && box.y < 900 / 2, `the table is in view (top ${box.y})`);
  await full.context.close();

  // ---- (g) removed: the next one is named; fixed one by one the row goes ----
  const next = await open(1440, 900, { value: withoutG() });
  await settled(next.page); await more(next.page);
  await next.page.locator("[data-overview-routine]").waitFor({ timeout: 15000 });
  assert.match((await next.page.locator("[data-overview-routine]").innerText()).replace(/\s+/g, " "), new RegExp(`^例行工作 3 条不正常：${names.f}，连续跳过 3 次$`));
  await next.context.close();
  const third = await open(1440, 900, { value: withoutG().filter(item => item.id !== ids.f) });
  await settled(third.page); await more(third.page);
  await third.page.locator("[data-overview-routine]").waitFor({ timeout: 15000 });
  assert.match((await third.page.locator("[data-overview-routine]").innerText()).replace(/\s+/g, " "), new RegExp(`^例行工作 2 条不正常：${names.a}，生成的任务已 3 小时没人接$`));
  await third.context.close();

  // ---- a failed read: the other rows stay, the failure is said as a failed kind, one read ----
  const failed = await open(1440, 900, { value: "fail" });
  await failed.page.waitForFunction(() => /例行工作/.test(document.querySelector("[data-overview-block=priority]")?.textContent ?? ""), null, { timeout: 15000 });
  await settled(failed.page); await more(failed.page);
  assert.equal(await failed.page.locator("[data-overview-routine]").count(), 0);
  assert.match(await priority(failed.page).innerText(), /没读到（例行工作）|这一栏读不到/);
  assert.deepEqual(await rowsText(failed.page), baselineRows, "the other rows are as before");
  await failed.context.close();

  // ---- phone width: no sideways scroll, the row wraps ----
  const phone = await open(390, 844, { value: items() }, "/overview", "dark");
  await settled(phone.page); await more(phone.page);
  await phone.page.locator("[data-overview-routine]").waitFor({ timeout: 15000 });
  assert.equal(await phone.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  if (shots) await phone.page.screenshot({ path: `${shots}/overview-390-dark.png` });
  await phone.context.close();

  // ---- the health table: (a)(h) are marked in words; (b)(c)(d)(e) are not; the next-time column keeps its time on one line ----
  for (const [width, height, scheme] of [[1440, 900, "light"], [390, 844, "light"], [390, 844, "dark"]] as const) {
    const label = `${width}/${scheme}`;
    const { page, context } = await open(width, height, { value: items() }, "/schedules", scheme);
    const table = page.getByRole("region", { name: "例行健康" });
    await table.getByText(names.g).first().waitFor();
    const cell = (key: string) => table.locator(`[data-routine="${key === "h" ? uuid(60) : ids[key]}"]`);
    assert.match(await cell("a").locator("[data-cell=unreceived]").innerText(), /待办，已 3 小时没人接$/, `${label}: (a)`);
    assert.match(await cell("h").locator("[data-cell=unreceived]").innerText(), /待办，已 26 小时没人接$/, `${label}: (h)`);
    for (const key of ["a", "h"]) assert.match(await cell(key).innerText(), /需要注意/, `${label}: ${key} has the marker`);
    for (const key of ["b", "c", "d", "e"]) { assert.equal(await cell(key).locator("[data-cell=unreceived]").count(), 0, `${label}: ${key} not marked`);
      assert.doesNotMatch(await cell(key).innerText(), /没人接|需要注意/, `${label}: ${key} has no reminder`); }
    assert.match((await cell("a").locator("[data-cell=last]").innerText()).replace(/\s+/g, " "), /^\d\d\/\d\d \d\d:\d\d · 每日巡检任务 需要注意： ?待办，已 3 小时没人接$/, `${label}: the cell reads time · title · state`);
    // The order the server sent is kept: (g), then (f)(a)(h), then the rest.
    const order = await table.locator("[data-routine-health] > ul > li, ul > li[data-routine]").evaluateAll((nodes: Element[]) => nodes.map(node => node.getAttribute("data-routine")));
    assert.deepEqual(order.slice(0, 4), [ids.g, ids.f, ids.a, uuid(60)], `${label}: order`);
    if (width >= 1100) {
      for (const key of ["g", "f", "a", "h"]) {
        const next = cell(key).locator("[data-cell=next]");
        const lines = await next.evaluate((node: HTMLElement) => Math.round(node.getBoundingClientRect().height / parseFloat(getComputedStyle(node).lineHeight)));
        assert.equal(lines, 1, `${label}: the next time of ${key} is on one line`);
        assert.match(await next.innerText(), /^\d\d\/\d\d \d\d:\d\d$/);
      }
      // The name column is wide enough for twelve characters before it is cut off; the next-time column keeps its time on one line.
      const columns = await cell("a").evaluate((node: HTMLElement) => ({ cols: getComputedStyle(node).gridTemplateColumns.split(" ").map(parseFloat), size: parseFloat(getComputedStyle(node.querySelector("button span.truncate")!).fontSize) }));
      assert.ok(columns.cols[0]! / columns.size >= 12, `${label}: the name column fits 12 characters (${columns.cols[0]}px at ${columns.size}px)`);
      if (shots) console.log(`${label}: columns ${columns.cols.join(" ")}`);
    }
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${label}: no sideways scroll`);
    if (shots) await page.screenshot({ path: `${shots}/schedules-${width}-${scheme}.png` });
    await context.close();
  }
  assert.deepEqual(errors, [], "no page errors");
});
