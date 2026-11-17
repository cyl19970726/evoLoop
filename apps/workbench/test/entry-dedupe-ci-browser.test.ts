// Built-app regression (task 4f6c948f, report e786aafc step 3): one 新建任务 primary action per page, no section name said twice in a row, 文档 / 知识 switched once, the three reading
// entries told apart, and the old deep links still open. Over the screenshot fixture, at 1440×900 and 390×844. Needs the built workbench and EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE;
// EVOLOOP_DEDUPE_SCREENSHOT_DIR keeps screenshots; EVOLOOP_BROWSER_TEST_EXECUTABLE_PATH picks a browser.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const modulePath = process.env.EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE;
const required = process.env.EVOLOOP_BROWSER_TEST_REQUIRED === "1";
const executablePath = process.env.EVOLOOP_BROWSER_TEST_EXECUTABLE_PATH || process.env.EVOLOOP_BROWSER_TEST_CHROMIUM_EXECUTABLE || undefined;
const shots = process.env.EVOLOOP_DEDUPE_SCREENSHOT_DIR;
const dist = resolve(import.meta.dirname, "../dist");
const frontend = resolve(import.meta.dirname, "../../../scripts/frontend");
const skip = !required && !modulePath && "Set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE after building the workbench";

test("one 新建任务 action, one name per level, one 文档 / 知识 switch, three reading entries told apart, old deep links open", { skip }, async t => {
  assert.ok(modulePath, "EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE is required when EVOLOOP_BROWSER_TEST_REQUIRED=1");
  const { chromium } = (await import(pathToFileURL(modulePath).href)).default;
  const { startFixtureServer } = await import(pathToFileURL(`${frontend}/fixture/server.mjs`).href);
  const { token, projectId } = await import(pathToFileURL(`${frontend}/fixture/common.mjs`).href) as Record<string, any>;
  const { tasks, docs } = await import(pathToFileURL(`${frontend}/fixture/work.mjs`).href) as Record<string, any>;
  const { scenes } = await import(pathToFileURL(`${frontend}/pages.mjs`).href);
  const fixture = await startFixtureServer(dist); t.after(() => fixture.close());
  const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) }); t.after(() => browser.close());
  if (shots) mkdirSync(shots, { recursive: true });
  const scene = (name: string) => scenes.find((candidate: { name: string }) => candidate.name === name);

  const open = async (width: number, height: number, path: string, ready?: (page: any) => Promise<unknown>) => {
    const context = await browser.newContext({ viewport: { width, height }, locale: "zh-CN", timezoneId: "Asia/Shanghai" });
    const page = await context.newPage();
    const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
    await page.goto(`${fixture.base}${path}`); await page.getByLabel("访问令牌").fill(token); await page.getByRole("button", { name: "进入", exact: true }).click();
    if (ready) await ready(page); await page.waitForTimeout(500);
    return { page, context, errors };
  };
  // Visible elements whose own text is exactly `text`, links and buttons only.
  const visibleCount = (page: any, text: string, selector = "a, button, [role=tab]") => page.evaluate(`((text, selector) => [...document.querySelectorAll(selector)].filter(el => {
    const r = el.getBoundingClientRect(); const s = getComputedStyle(el); const label = (el.getAttribute("aria-label") || el.textContent || "").replace(/\\s+/g, " ").trim();
    return r.width > 2 && r.height > 2 && s.visibility !== "hidden" && s.display !== "none" && label === text; }).length)(${JSON.stringify(text)}, ${JSON.stringify(selector)})`) as Promise<number>;

  for (const [width, height] of [[1440, 900], [390, 844]] as const) {
    // 任务列表: the header's primary is the only 新建任务; the rail does not say 任务列表 a second time.
    {
      const { page, context, errors } = await open(width, height, scene("tasks").path, scene("tasks").ready);
      assert.equal(await visibleCount(page, "新建任务"), 1, `${width}: one 新建任务 on the task list`);
      assert.equal(await visibleCount(page, "任务列表", "a, button, h1, h2, [role=tab]"), width >= 1100 ? 1 : 0, `${width}: 任务列表 is said once (the section's entry), not again as the rail's heading`);
      if (shots) await page.screenshot({ path: `${shots}/tasks-${width}.png` });
      assert.deepEqual(errors, []); await context.close();
    }
    // A task's own page has no header primary: its one 新建任务 is the rail's (on a phone the rail is the drawer).
    if (width >= 1100) {
      const { page, context } = await open(width, height, scene("task").path, scene("task").ready);
      assert.equal(await visibleCount(page, "新建任务"), 1, `${width}: a task's page offers 新建任务 once, in the rail`);
      await context.close();
    }
    // 文档 and 知识: one switch. With the inner rail on screen it is the section navigation; the rail has no second one (it appears in the page only when the rail is not on screen).
    for (const name of ["documents", "knowledge"]) {
      const { page, context } = await open(width, height, scene(name).path, scene(name).ready);
      const switches = await page.locator('nav[aria-label="文档与知识"]').count();
      if (width >= 1100) assert.equal(switches, 0, `${width} ${name}: the rail has no second 文档/知识 switch`); else assert.ok(switches <= 1, `${width} ${name}: at most one 文档/知识 switch in the page (${switches})`);
      if (width >= 1100) {
        const nav = page.getByRole("navigation", { name: "工作分区" });
        for (const [label, hint] of [["过程文档", "工作依据与报告"], ["知识空间", "长期的知识页"], ["仓库规范", "固定 Git 来源"]])
          assert.ok(await nav.getByRole("link", { name: new RegExp(`^${label}`) }).filter({ hasText: hint }).count() === 1, `${width} ${name}: ${label} says "${hint}"`);
      }
      if (shots) await page.screenshot({ path: `${shots}/${name}-${width}.png` });
      await context.close();
    }
  }

  // On a phone the top bar names the page, so a page title that says the same is not shown a second time (screen readers still get it); on a wide screen every title stays.
  const visibleH1 = (page: any) => page.evaluate(`[...document.querySelectorAll("main h1")].filter(el => { const r = el.getBoundingClientRect(); return r.width > 2 && r.height > 2; }).map(el => el.textContent.trim())`) as Promise<string[]>;
  const barTitle = (page: any) => page.evaluate(`(document.querySelector("[data-shell=mobile-header] span")?.textContent ?? "").trim()`) as Promise<string>;
  for (const name of ["tasks", "documents", "task-new", "journey", "schedules", "repository", "team-runtime"]) {
    const phone = await open(390, 844, scene(name).path, scene(name).ready);
    const bar = await barTitle(phone.page);
    assert.ok(bar.length > 0, `${name}: the phone has a top bar title`);
    assert.ok(!(await visibleH1(phone.page)).includes(bar), `${name}: the top bar says "${bar}" and the page does not say it again (${JSON.stringify(await visibleH1(phone.page))})`);
    assert.equal(await phone.page.locator("main h1[data-echo]").count(), 1, `${name}: the repeated title is still in the page for screen readers`);
    if (shots && (name === "tasks" || name === "documents")) await phone.page.screenshot({ path: `${shots}/echo-${name}-390.png` });
    await phone.context.close();
    const wide = await open(1440, 900, scene(name).path, scene(name).ready);
    assert.ok((await visibleH1(wide.page)).length >= 1, `${name}: a wide screen keeps its page title`);
    await wide.context.close();
  }
  // A page whose title says more than the bar keeps it (a task's name under 任务).
  { const phone = await open(390, 844, scene("task").path, scene("task").ready); assert.deepEqual((await visibleH1(phone.page)).length > 0, true, "a task's own title stays"); await phone.context.close(); }

  // The old deep links still open (no 找不到这个页面), with their parameters.
  const links = [`/p/${projectId}/work?state=all&kind=all&sort=due`, `/p/${projectId}/tasks/${tasks.t1.id}?tab=delivery`, `/p/${projectId}/tasks/new`,
    `/p/${projectId}/documents/${docs.map.id}`, `/p/${projectId}/knowledge`, `/p/${projectId}/repository`];
  for (const path of links) {
    const { page, context, errors } = await open(1440, 900, path);
    await page.locator("main, h1").first().waitFor({ timeout: 30000 });
    const text = await page.locator("body").innerText();
    assert.ok(!/找不到这个页面/.test(text), `${path} opens`); assert.deepEqual(errors, [], `${path}: no page error`);
    await context.close();
  }
  // The two reading entries still lead to each other through the section navigation.
  {
    const { page, context } = await open(1440, 900, scene("documents").path, scene("documents").ready);
    const nav = page.getByRole("navigation", { name: "工作分区" });
    await nav.getByRole("link", { name: /^知识空间/ }).click(); await page.waitForURL(/\/knowledge/);
    await nav.getByRole("link", { name: /^过程文档/ }).click(); await page.waitForURL(/\/documents/);
    await context.close();
  }
});
