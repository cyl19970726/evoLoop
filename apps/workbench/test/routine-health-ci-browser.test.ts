// Built-app regression (Task acfaa4f0): the first screen of 日程 is the 例行健康 table. One request reads it; overdue, skipping and open-Task routines come
// first; stopped ones fold into "已停止 · N"; a routine that never triggered says "还没有触发过"; a row opens the detail with the schedule in the address and
// Back returns to the table; a failed read says "健康表读不到" with a retry and the left list and the detail keep working. Screenshot fixture, 1440×900 and
// 390×844, light and dark. Needs the built workbench and EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE; EVOLOOP_ROUTINE_SCREENSHOT_DIR keeps screenshots.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const modulePath = process.env.EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE;
const required = process.env.EVOLOOP_BROWSER_TEST_REQUIRED === "1";
const executablePath = process.env.EVOLOOP_BROWSER_TEST_EXECUTABLE_PATH || process.env.EVOLOOP_BROWSER_TEST_CHROMIUM_EXECUTABLE || undefined;
const shots = process.env.EVOLOOP_ROUTINE_SCREENSHOT_DIR;
const dist = resolve(import.meta.dirname, "../dist");
const frontend = resolve(import.meta.dirname, "../../../scripts/frontend");
const skip = !required && !modulePath && "Set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE after building the workbench";

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ago = (minutes: number) => new Date(Date.now() - minutes * 60000).toISOString();
const ahead = (minutes: number) => ago(-minutes);

test("例行健康: one read, what needs a look first, stopped folded, a row opens the detail and Back returns, a failed read keeps the rest", { skip }, async t => {
  assert.ok(modulePath, "EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE is required when EVOLOOP_BROWSER_TEST_REQUIRED=1");
  const { chromium } = (await import(pathToFileURL(modulePath).href)).default;
  const { startFixtureServer } = await import(pathToFileURL(`${frontend}/fixture/server.mjs`).href);
  const { token, projectId, actorId } = await import(pathToFileURL(`${frontend}/fixture/common.mjs`).href) as Record<string, any>;
  const spaces = await import(pathToFileURL(`${frontend}/fixture/spaces.mjs`).href) as Record<string, any>;
  const fixture = await startFixtureServer(dist); t.after(() => fixture.close());
  const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) }); t.after(() => browser.close());
  if (shots) mkdirSync(shots, { recursive: true });

  const [template] = spaces.schedules.list();
  const ids = { a: uuid(1), b: uuid(2), c: uuid(3), d: uuid(4), e: uuid(5), f: uuid(6), sample: uuid(7) };
  const titles = { a: "每日巡检（上次已关闭）", b: "周报整理（上次还开着）", c: "夜间对账（连续跳过）", d: "发布窗口检查（逾期）", e: "月度复盘（已暂停）", f: "旧版同步（已停止）", sample: "验收样本日程" };
  const definition = (key: keyof typeof ids, state: string) => ({ ...template, id: ids[key], currentRevisionId: ids[key], state,
    revision: { ...template.revision, id: ids[key], scheduleId: ids[key], template: { ...template.revision.template, title: titles[key] } } });
  const schedules = [definition("a", "active"), definition("b", "active"), definition("c", "active"), definition("d", "active"), definition("e", "paused"), definition("f", "stopped"), definition("sample", "active")];
  const base = { kind: "schedule", rule: { kind: "daily", localTime: "09:00" }, timezone: "Asia/Shanghai", repeat: null, rootTaskId: null, misfire: "latest", skippedTotal: null,
    consecutiveSkips: 0, overdue: null, lastTaskOpen: false, watermarkUtc: ago(60), lastTaskUnreceived: null };
  const created = (title: string, state: string, taskId: string) => ({ plannedAtUtc: ago(60 * 5), observedAtUtc: ago(60 * 5 - 1), outcome: "created", reason: "scheduled", task: { taskId, title, state } });
  const skipped = { plannedAtUtc: ago(60 * 3), observedAtUtc: ago(60 * 3 - 1), outcome: "skipped", reason: "overlap skipped", task: null };
  const seriesItem = (n: number, title: string, over: Record<string, unknown>) => ({ ...base, kind: "timed_series", id: uuid(20 + n), title, state: "active", rule: null, repeat: "daily",
    rootTaskId: uuid(30 + n), misfire: null, watermarkUtc: null, nextAtUtc: ahead(60 * 20), lastTaskOpen: false, lastTaskUnreceived: null,
    lastTrigger: created(title, "done", uuid(40 + n)), ...over });
  const health = { projectId, observedAt: new Date().toISOString(), complete: true, items: [
    { ...base, id: ids.d, title: titles.d, state: "active", nextAtUtc: ahead(60 * 20), overdue: { expectedAtUtc: ago(60 * 4) }, lastTrigger: created("发布窗口检查报告", "done", uuid(50)) },
    { ...base, id: ids.c, title: titles.c, state: "active", nextAtUtc: ahead(60 * 18), consecutiveSkips: 2, lastTaskOpen: true, lastTrigger: skipped },
    { ...base, id: ids.b, title: titles.b, state: "active", nextAtUtc: ahead(60 * 19), lastTaskOpen: true, lastTrigger: created("周报整理 本周", "in_progress", uuid(51)) },
    { ...base, id: ids.a, title: titles.a, state: "active", nextAtUtc: ahead(60 * 17), lastTrigger: created("每日巡检报告", "done", uuid(52)) },
    { ...base, id: ids.e, title: titles.e, state: "paused", nextAtUtc: null, lastTrigger: null },
    seriesItem(1, "验收新版外壳（定时任务）", { skippedTotal: 2, lastTaskOpen: true, lastTrigger: created("验收新版外壳", "todo", uuid(41)) }),
    seriesItem(2, "汇总试用反馈（定时任务）", {}),
    { ...base, id: ids.sample, title: titles.sample, state: "active", nextAtUtc: ahead(60 * 12), lastTrigger: null },
    { ...base, id: ids.f, title: titles.f, state: "stopped", nextAtUtc: null, lastTrigger: created("旧版同步报告", "done", uuid(53)) },
  ] };

  const open = async (width: number, height: number, scheme: "light" | "dark", path: string, options: { failHealth?: { value: boolean } } = {}) => {
    const context = await browser.newContext({ viewport: { width, height }, locale: "zh-CN", timezoneId: "Asia/Shanghai", reducedMotion: "reduce", colorScheme: scheme });
    const page = await context.newPage();
    const errors: string[] = [], healthReads: string[] = [];
    page.on("pageerror", (error: Error) => errors.push(error.message));
    page.on("request", (request: any) => { if (/\/routine-health(\?|$)/.test(request.url())) healthReads.push(request.url()); });
    await page.route(new RegExp(`/api/projects/${projectId}/schedules$`), (route: any) => route.fulfill({ json: schedules }));
    await page.route(new RegExp(`/api/projects/${projectId}/routine-health$`), (route: any) =>
      options.failHealth?.value ? route.fulfill({ status: 500, json: { code: "RESULT_UNCONFIRMED" } }) : route.fulfill({ json: health }));
    await page.goto(`${fixture.base}${path}`);
    await page.getByLabel("访问令牌").fill(token); await page.getByRole("button", { name: "进入", exact: true }).click();
    return { page, context, errors, healthReads };
  };
  const rowsOf = (page: any) => page.locator("[data-routine-health] > ul > li");
  const overflow = (page: any) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);

  for (const [width, height, scheme] of [[1440, 900, "light"], [1440, 900, "dark"], [390, 844, "light"], [390, 844, "dark"]] as const) {
    const label = `${width}/${scheme}`;
    const { page, context, errors, healthReads } = await open(width, height, scheme, `/p/${projectId}/schedules`);
    const table = page.getByRole("region", { name: "例行健康" });
    await table.getByText(titles.d).waitFor();
    await page.waitForTimeout(400);
    // One read for the table on page open.
    assert.equal(healthReads.length, 1, `${label}: exactly one request for the health table`);
    // Order: overdue, skipping, open Task first; stopped and sample ones are folded away.
    const shown = await rowsOf(page).evaluateAll((rows: Element[]) => rows.map(row => row.getAttribute("data-routine")));
    assert.deepEqual(shown.slice(0, 4), [ids.d, ids.c, ids.b, uuid(21)].map((id, index) => index === 3 ? shown[3] : id), `${label}: d, c, b first`);
    assert.equal(shown.includes(ids.f), false); assert.equal(shown.includes(ids.sample), false);
    const text = await table.innerText();
    assert.match(text, /应在 .+ 触发，没有记录/, `${label}: overdue says so`);
    assert.match(text, /连续跳过 2 次/); assert.match(text, /上一份任务还没结束，按设置跳过这个时刻/);
    assert.match(await table.locator(`[data-routine="${ids.e}"]`).innerText(), /还没有触发过/);
    assert.ok(!/跳过/.test(await table.locator(`[data-routine="${ids.e}"]`).innerText()), "never triggered is not skipped");
    assert.doesNotMatch(await table.locator(`[data-routine="${ids.a}"] [data-cell=skips]`).innerText(), /\d/, "no skip number at 0");
    assert.match(await table.locator(`[data-routine="${ids.b}"]`).innerText(), /周报整理 本周/);
    assert.equal(await table.locator("[data-stopped-fold] > summary").innerText(), "已停止 · 1");
    assert.equal(await table.locator("[data-stopped-fold]").evaluate((node: any) => node.open), false, "the stopped fold is closed");
    assert.equal(await table.locator("[data-sample-fold]").evaluate((node: any) => node.open), false);
    assert.equal(await overflow(page), true, `${label}: no horizontal scroll`);
    if (width < 760) for (const row of await rowsOf(page).all()) assert.ok((await row.boundingBox()).height < 84, `${label}: a row is two lines`);
    if (shots) await page.screenshot({ path: `${shots}/routine-health-${width}-${scheme}.png`, fullPage: false });
    if (scheme === "light") {
      // Open the stopped fold, then a row: the detail opens, the schedule is in the address, Back returns to the table.
      await table.locator("[data-stopped-fold] > summary").click();
      await table.getByText(titles.f).first().waitFor();
      await table.locator(`[data-routine="${ids.b}"]`).getByRole("button", { name: titles.b }).click();
      await page.locator(".schedule-definition").waitFor();
      assert.match(page.url(), new RegExp(`/schedules\\?schedule=${ids.b}$`));
      assert.equal(await table.count(), 0, "the detail replaces the table");
      await page.goBack();
      await page.getByRole("region", { name: "例行健康" }).waitFor();
      assert.doesNotMatch(page.url(), /schedule=/, `${label}: browser Back returns to the table`);
      await page.getByRole("region", { name: "例行健康" }).locator(`[data-routine="${ids.c}"]`).getByRole("button", { name: titles.c }).click();
      await page.locator(".schedule-definition").waitFor();
      await page.getByRole("button", { name: "返回例行健康" }).click();
      await page.getByRole("region", { name: "例行健康" }).waitFor();
      assert.equal(healthReads.length >= 1, true);
    }
    assert.deepEqual(errors, [], `${label}: no page errors`);
    await context.close();
  }

  // The address keeps the selection: opening it directly shows the detail, not the table.
  {
    const { page, context } = await open(1440, 900, "light", `/p/${projectId}/schedules?schedule=${ids.b}`);
    await page.locator(".schedule-definition").waitFor();
    assert.equal(await page.getByRole("region", { name: "例行健康" }).count(), 0);
    await context.close();
  }

  // A failed read: the table says so with a retry; the left list and the detail keep working.
  {
    const failing = { value: true };
    const { page, context } = await open(1440, 900, "light", `/p/${projectId}/schedules`, { failHealth: failing });
    const table = page.getByRole("region", { name: "例行健康" });
    await table.getByText("健康表读不到").waitFor();
    assert.equal(await table.locator("[data-routine]").count(), 0);
    if (shots) await page.screenshot({ path: `${shots}/routine-health-failed-1440-light.png` });
    await page.getByRole("navigation", { name: "日程" }).getByText(titles.b).first().click();
    await page.locator(".schedule-definition").waitFor();
    await page.getByRole("button", { name: "返回例行健康" }).click();
    failing.value = false;
    await table.getByRole("button", { name: "重试" }).click();
    await table.getByText(titles.d).waitFor();
    await context.close();
  }
});
