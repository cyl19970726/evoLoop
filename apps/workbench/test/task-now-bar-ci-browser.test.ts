// Task 0b60a377: under the task title one "现在" line and one relation bar (阶段 · 来源 · 承接 · 交付 · 依据); the completion conditions are Markdown.
// Needs the built workbench and EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE (EVOLOOP_BROWSER_TEST_REQUIRED=1 in CI). Fixture only: the seven samples of fixture/work.mjs `nowTasks`.
import assert from "node:assert/strict";
import { test } from "node:test";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const modulePath = process.env.EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE;
const required = process.env.EVOLOOP_BROWSER_TEST_REQUIRED === "1";
const executablePath = process.env.EVOLOOP_BROWSER_TEST_EXECUTABLE_PATH || process.env.EVOLOOP_BROWSER_TEST_CHROMIUM_EXECUTABLE || undefined;
const dist = resolve(import.meta.dirname, "../dist");
const frontend = resolve(import.meta.dirname, "../../../scripts/frontend");
const skip = !required && !modulePath && "Set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE after building the workbench";

test("the now line and the relation bar say the same five things on every sample, and link to where they are", { skip }, async t => {
  assert.ok(modulePath, "EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE is required when EVOLOOP_BROWSER_TEST_REQUIRED=1");
  const { chromium } = (await import(pathToFileURL(modulePath).href)).default;
  const { startFixtureServer } = await import(pathToFileURL(`${frontend}/fixture/server.mjs`).href);
  const { projectId, token } = await import(pathToFileURL(`${frontend}/fixture/common.mjs`).href);
  const { nowTasks, stages } = await import(pathToFileURL(`${frontend}/fixture/work.mjs`).href);
  const fixture = await startFixtureServer(dist); t.after(() => fixture.close());
  const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) }); t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "zh-CN", reducedMotion: "reduce" });
  const page = await context.newPage(); const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  const open = async (key: string) => {
    const task = nowTasks[key];
    await page.goto(`${fixture.base}/p/${projectId}/tasks/${task.id}`);
    await page.getByLabel("访问令牌").fill(token); await page.getByRole("button", { name: "进入", exact: true }).click();
    await page.getByRole("heading", { level: 1, name: task.title }).waitFor();
    const bar = page.locator("[data-task-relations]");
    await bar.waitFor();
    // the assignment and the schedule origin are separate reads: wait until neither says it is still reading
    await page.waitForFunction(() => !/读取名称…/.test(document.querySelector("[data-task-relations]")?.textContent ?? ""));
    await page.waitForTimeout(300);
    const text = (name: string) => bar.locator(`[data-relation="${name}"]`).innerText();
    return { task, bar, text, now: page.locator("[data-task-now]"), header: page.locator("[data-task-header]") };
  };
  const order = async (bar: import("@playwright/test").Locator) =>
    assert.deepEqual(await bar.locator("[data-relation]").evaluateAll(nodes => nodes.map(node => node.getAttribute("data-relation"))), ["stage", "source", "agent", "delivery", "basis"]);

  // (a) rework, an agent for two days, the last acceptance failed
  let s = await open("a");
  await order(s.bar);
  assert.match(await s.now.innerText(), /^现在：[^\n]*返工[^\n]*等智能体[^\n]*已 2 天[^\n]*最新验收：使用失败 · [^\n]+ · /);
  assert.match(await s.text("delivery"), /^交付 第 1 份交付 · .+ · 使用失败$/);
  assert.match(await s.text("basis"), /^依据 固定依据 2 份$/);
  assert.match(await s.text("source"), /^来源 未登记$/);
  await s.bar.locator('[data-relation="stage"] a').click();
  await page.waitForURL(/\/journey\?stage=/);
  assert.match(page.url(), new RegExp(`stage=${stages.s1.id}`));

  // (b) awaiting acceptance by the declared consumer, three hours
  s = await open("b");
  // The first delivery was used; the second is the one waiting, so the line must not show the first one's 已使用.
  assert.match(await s.now.innerText(), /^现在：[^\n]*等待验收[^\n]*等指定验收者[^\n]*已 3 小时[^\n]*最新验收：还没有验收结论/);
  assert.doesNotMatch(await s.now.innerText(), /已使用/);
  assert.match(await s.text("delivery"), /第 2 份交付 · .+ · 待验收/);

  // (c) used, waiting for the close; the completion conditions are Markdown and nothing in them runs
  s = await open("c");
  assert.match(await s.now.innerText(), /等Leader[\s\S]*最新验收：已使用/);
  const acceptance = page.locator("[data-task-acceptance]");
  assert.equal(await acceptance.locator("ol > li").count(), 3);
  assert.match(await acceptance.locator("strong").innerText(), /^右栏$/);
  assert.match(await acceptance.locator("code").innerText(), /^data-task-facts$/);
  assert.equal(await acceptance.locator('a[href="https://example.test/design"]').count(), 1);
  assert.equal(await acceptance.locator("script").count(), 0);
  assert.match(await acceptance.innerText(), /<script>window\.__ran = true<\/script>/);
  assert.equal(await page.evaluate(() => (window as unknown as { __ran?: boolean }).__ran), undefined);
  await s.now.locator("a").click();
  await page.getByRole("tab", { name: /^交付与使用/, selected: true }).waitFor();

  // (d) nothing registered: the five items are still there, and say so
  s = await open("d");
  await order(s.bar);
  assert.deepEqual(await Promise.all(["stage", "source", "agent", "delivery", "basis"].map(s.text)), ["阶段 未归属", "来源 未登记", "承接 未登记", "交付 还没有交付", "依据 未登记"]);
  assert.match(await s.now.innerText(), /等Leader[\s\S]*最新验收：还没有验收结论/);

  // (e) made by a schedule: opened by its own address, the source links back to that schedule
  s = await open("e");
  assert.match(await s.text("source"), /^来源 日程 每日验收巡检$/);
  assert.equal(await s.bar.locator('[data-relation="agent"] a').count(), 1);
  assert.match(await s.text("stage"), /^阶段 不属于阶段（/);
  assert.doesNotMatch(await s.text("stage"), /不属于阶段（不属于阶段/);
  await s.bar.locator('[data-relation="source"] a').click();
  await page.waitForURL(/\/schedules\?schedule=/);

  // (f) a daily-repeat series member: the source is the series' previous task
  s = await open("f");
  assert.equal(await s.text("stage"), "阶段 不属于阶段（日程例行）", "a reason that already says 不属于阶段 is shown once");
  assert.equal(await s.text("source"), "来源 系列的上一份");
  assert.equal(await s.bar.locator('[data-relation="source"] a').getAttribute("href"), `/p/${projectId}/tasks/${nowTasks.a.id}`);

  // (g) closed: no "现在"
  s = await open("g");
  assert.match(await s.now.innerText(), /^已关闭 · /);
  assert.doesNotMatch(await s.header.innerText(), /现在：/);
  await order(s.bar);
  assert.equal(await page.getByText("现在：").count(), 0, "no second 现在 in the tabs");

  assert.deepEqual(errors, []);
});

test("the now line stays within two lines at 1440 and the bar wraps without sideways scrolling at 390", { skip }, async t => {
  assert.ok(modulePath, "EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE is required when EVOLOOP_BROWSER_TEST_REQUIRED=1");
  const { chromium } = (await import(pathToFileURL(modulePath).href)).default;
  const { startFixtureServer } = await import(pathToFileURL(`${frontend}/fixture/server.mjs`).href);
  const { projectId, token } = await import(pathToFileURL(`${frontend}/fixture/common.mjs`).href);
  const { nowTasks } = await import(pathToFileURL(`${frontend}/fixture/work.mjs`).href);
  const fixture = await startFixtureServer(dist); t.after(() => fixture.close());
  const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) }); t.after(() => browser.close());
  for (const [width, height] of [[1440, 900], [390, 844]] as const) {
    const context = await browser.newContext({ viewport: { width, height }, locale: "zh-CN", reducedMotion: "reduce" });
    const page = await context.newPage();
      for (const key of ["a", "b", "c", "d"]) {
      await page.goto(`${fixture.base}/p/${projectId}/tasks/${nowTasks[key].id}`);
      await page.getByLabel("访问令牌").fill(token); await page.getByRole("button", { name: "进入", exact: true }).click();
      await page.getByRole("heading", { level: 1, name: nowTasks[key].title }).waitFor();
      await page.locator("[data-task-relations]").waitFor();
      await page.waitForFunction(() => !/读取名称…/.test(document.querySelector("[data-task-relations]")?.textContent ?? ""));
      const lines = await page.locator("[data-task-now]").evaluate(node => {
        const style = getComputedStyle(node); return Math.round(node.getBoundingClientRect().height / parseFloat(style.lineHeight));
      });
      if (width === 1440) assert.ok(lines <= 2, `${key}: 现在 is ${lines} lines at ${width}`);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true, `${key}: no sideways scroll at ${width}`);
      const bar = await page.locator("[data-task-relations]").boundingBox();
      assert.ok(bar && bar.x + bar.width <= width, `${key}: the bar fits ${width}`);
    }
    await context.close();
  }
});
