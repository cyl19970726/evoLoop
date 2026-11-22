// Built-app regression (task 34f2a392): the work navigation is 总览, 目标与阶段, 任务, 文档 with no children and a folded 运转 group (日程, 职责, 运行与接入);
// the fold is kept on this machine and opens on a page of the group; the account menu has neither 仓库规范 nor 结果未知的操作; 仓库规范 is in 项目设置;
// the old addresses 组织复盘 and 仓库规范 open their new place; 统筹安排 is the agents space's page. Over the screenshot fixture at 1440×900 and 390×844.
// Needs the built workbench and EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE; EVOLOOP_NAV_SCREENSHOT_DIR keeps screenshots; EVOLOOP_BROWSER_TEST_EXECUTABLE_PATH picks a browser.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const modulePath = process.env.EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE;
const required = process.env.EVOLOOP_BROWSER_TEST_REQUIRED === "1";
const executablePath = process.env.EVOLOOP_BROWSER_TEST_EXECUTABLE_PATH || process.env.EVOLOOP_BROWSER_TEST_CHROMIUM_EXECUTABLE || undefined;
const shots = process.env.EVOLOOP_NAV_SCREENSHOT_DIR;
const dist = resolve(import.meta.dirname, "../dist");
const frontend = resolve(import.meta.dirname, "../../../scripts/frontend");
const skip = !required && !modulePath && "Set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE after building the workbench";

test("导航清理: four top-level entries, a folded 运转 kept per machine, no 仓库规范 / 结果未知的操作 in the account menu, old addresses land in their new place", { skip }, async t => {
  assert.ok(modulePath, "EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE is required when EVOLOOP_BROWSER_TEST_REQUIRED=1");
  const { chromium } = (await import(pathToFileURL(modulePath).href)).default;
  const { startFixtureServer } = await import(pathToFileURL(`${frontend}/fixture/server.mjs`).href);
  const { token, projectId } = await import(pathToFileURL(`${frontend}/fixture/common.mjs`).href) as Record<string, any>;
  const fixture = await startFixtureServer(dist); t.after(() => fixture.close());
  const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) }); t.after(() => browser.close());
  if (shots) mkdirSync(shots, { recursive: true });
  const login = async (page: any) => { await page.getByLabel("访问令牌").fill(token); await page.getByRole("button", { name: "进入", exact: true }).click(); await page.waitForTimeout(600); };
  const open = async (width: number, height: number, path: string, context?: any) => {
    const ctx = context ?? await browser.newContext({ viewport: { width, height }, locale: "zh-CN", timezoneId: "Asia/Shanghai" });
    const page = await ctx.newPage();
    const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
    await page.goto(`${fixture.base}${path}`); await login(page);
    return { page, context: ctx, errors };
  };
  // The navigation lives in the rail on a wide screen and in the drawer on a phone.
  const nav = async (page: any, width: number) => {
    if (width < 760) { await page.getByRole("button", { name: "打开项目导航" }).click(); await page.waitForTimeout(300); }
    return page.getByRole("navigation", { name: "工作分区" });
  };
  const topLevel = (navigation: any) => navigation.locator("> ul > li > a").evaluateAll((links: Element[]) => links.map(link => link.textContent?.trim()));

  for (const [width, height] of [[1440, 900], [390, 844]] as const) {
    // 1. The shape: 总览, 目标与阶段, 任务, 文档 (no children), then 运转 folded.
    {
      const { page, context, errors } = await open(width, height, `/p/${projectId}/overview`);
      const navigation = await nav(page, width);
      const labels = await topLevel(navigation);
      assert.deepEqual(labels.slice(0, 4), ["总览", "目标与阶段", "任务", "文档"], `${width}: the top level`);
      assert.equal(await navigation.locator("ul ul a").count(), 0, `${width}: 运转 is folded, no child is listed`);
      assert.equal(await navigation.getByRole("button", { name: "运转" }).getAttribute("aria-expanded"), "false");
      assert.equal(await navigation.getByRole("link", { name: "团队", exact: true }).count(), 0);
      assert.equal(await navigation.getByRole("link", { name: "任务列表", exact: true }).count(), 0, "任务 has no children");
      if (shots) await page.screenshot({ path: `${shots}/nav-folded-${width}.png` });
      // Open it: the three entries; the choice is kept on this machine across a reload.
      await navigation.getByRole("button", { name: "运转" }).click();
      assert.deepEqual((await navigation.locator("ul ul a").evaluateAll((links: Element[]) => links.map(link => link.textContent?.trim()))).slice(0, 3), ["日程", "职责", "运行与接入"], `${width}: 运转 holds three entries`);
      assert.equal(await page.evaluate(() => localStorage.getItem("evoloop:nav:operations")), "open");
      if (shots) await page.screenshot({ path: `${shots}/nav-open-${width}.png` });
      await page.reload(); await login(page);
      const again = await nav(page, width);
      assert.equal(await again.getByRole("button", { name: "运转" }).getAttribute("aria-expanded"), "true", `${width}: the open fold survives a reload`);
      assert.deepEqual(errors, []); await context.close();
    }
    // 2. A page of the group opens it by itself, and marks the page it is on.
    {
      const { page, context } = await open(width, height, `/p/${projectId}/schedules`);
      const navigation = await nav(page, width);
      assert.equal(await navigation.getByRole("button", { name: "运转" }).getAttribute("aria-expanded"), "true", `${width}: 日程 is in 运转, which opens`);
      assert.equal(await navigation.locator("a[aria-current=page]").innerText(), "日程");
      await context.close();
    }
    // 3. The account menu: 项目设置 is there; 仓库规范 and 结果未知的操作 are not (the latter stays under 待我处理).
    {
      const { page, context } = await open(width, height, `/p/${projectId}/overview`);
      await page.getByRole("button", { name: width < 760 ? "我的：账号与设置" : "设置与账号" }).click();
      const menu = page.getByRole("menu");
      await menu.getByRole("menuitem", { name: "项目设置" }).waitFor();
      assert.equal(await menu.getByRole("menuitem", { name: /仓库规范/ }).count(), 0);
      assert.equal(await menu.getByRole("menuitem", { name: /结果未知的操作/ }).count(), 0);
      await context.close();
    }
  }
  // 4. Old addresses: each opens its new place, none says 找不到这个页面.
  const lands: Array<[string, RegExp, string?]> = [
    [`/p/${projectId}/repository`, /\/settings$/, "#settings-repository"],
    [`/p/${projectId}/reviews`, /\/documents\?kind=organization_review$/],
    [`/p/${projectId}/arrangement`, /\/arrangement$/],
    [`/p/${projectId}/evaluations`, /\/evaluations$/],
    [`/p/${projectId}/knowledge`, /\/knowledge$/],
    [`/p/${projectId}/discussions`, /\/discussions$/],
    [`/p/${projectId}/collaboration`, /\/collaboration$/],
  ];
  for (const [path, landing, hash] of lands) {
    const { page, context, errors } = await open(1440, 900, path);
    await page.locator("main").waitFor({ timeout: 30000 });
    const url = new URL(page.url());
    assert.match(url.pathname + url.search, landing, `${path} opens ${landing}`);
    if (hash) assert.equal(url.hash, hash);
    assert.ok(!/找不到这个页面/.test(await page.locator("body").innerText()), `${path} opens a page`);
    assert.deepEqual(errors, [], `${path}: no page error`); await context.close();
  }
  // 5. 仓库规范 reads inside 项目设置; 复盘 is a filter of 文档.
  {
    const { page, context } = await open(1440, 900, `/p/${projectId}/settings`);
    await page.getByRole("heading", { name: "仓库规范", exact: true }).waitFor();
    await page.getByText("登记 Git 固定来源").first().waitFor();
    await context.close();
    const docs = await open(1440, 900, `/p/${projectId}/reviews`);
    const filter = docs.page.getByRole("combobox", { name: "文档类型筛选" });
    await filter.waitFor();
    assert.equal(await filter.inputValue(), "organization_review", "the 复盘 filter is applied");
    assert.equal(await filter.locator("option:checked").innerText(), "复盘");
    await docs.context.close();
  }
  // 6. The agents space with no agent selected shows 统筹安排; there is no 团队 group.
  {
    const { page, context } = await open(1440, 900, `/p/${projectId}/sessions`);
    await page.getByRole("heading", { name: "统筹安排", exact: true }).waitFor();
    assert.equal(await page.getByRole("link", { name: "团队", exact: true }).count(), 0);
    await context.close();
  }
});
