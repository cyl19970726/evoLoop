// Task 13462b20: the relation bar under the title of the document, agent, stage and schedule pages (the task page's is task-now-bar-ci-browser.test.ts).
// Needs the built workbench and EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE (EVOLOOP_BROWSER_TEST_REQUIRED=1 in CI). Fixture only.
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

test("every document, agent, stage and schedule page says the same five things under its title, and says 未登记 or 读取失败 where it cannot", { skip }, async t => {
  assert.ok(modulePath, "EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE is required when EVOLOOP_BROWSER_TEST_REQUIRED=1");
  const { chromium } = (await import(pathToFileURL(modulePath).href)).default;
  const { startFixtureServer } = await import(pathToFileURL(`${frontend}/fixture/server.mjs`).href);
  const common = await import(pathToFileURL(`${frontend}/fixture/common.mjs`).href);
  const { projectId, token, id } = common;
  const { relationDocs, nowTasks, stages } = await import(pathToFileURL(`${frontend}/fixture/work.mjs`).href);
  const env = ["FIXTURE_ROUTINES", "FIXTURE_HOLD", "FIXTURE_USE", "FIXTURE_RESULT_AGENT"];
  t.after(() => { for (const name of env) delete process.env[name]; });
  const fixture = await startFixtureServer(dist); t.after(() => fixture.close());
  const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) }); t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "zh-CN", reducedMotion: "reduce" });
  const page = await context.newPage(); const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));

  const open = async (path: string, kind: string) => {
    await page.goto(`${fixture.base}/p/${projectId}${path}`);
    await page.getByLabel("访问令牌").fill(token); await page.getByRole("button", { name: "进入", exact: true }).click();
    const bar = page.locator(`[data-relations="${kind}"]`);
    await bar.waitFor();
    await page.waitForFunction(selector => !/读取名称…|正在读取…/.test(document.querySelector(selector)?.textContent ?? ""), `[data-relations="${kind}"]`);
    await page.waitForTimeout(300);
    return bar;
  };
  const order = async (bar: import("@playwright/test").Locator, ids: string[]) =>
    assert.deepEqual(await bar.locator("[data-relation]").evaluateAll(nodes => nodes.map(node => node.getAttribute("data-relation"))), ids);
  const text = async (bar: import("@playwright/test").Locator) => (await bar.innerText()).replace(/\s+/g, " ").trim();

  // documents
  const doc = (d: { id: string }) => `/documents/${d.id}`;
  let bar = await open(doc(relationDocs.a), "document");
  await order(bar, ["task", "stage", "source", "delivery", "basis"]);
  assert.match(await text(bar), /^任务 返工：选中行字重 · 阶段 新版任务与文档页 · 来源 .+写入 · 交付 .+的交付 · 已使用 · 依据 被 2 项任务固定为依据$/);
  assert.equal(await page.locator("main h1 ~ *").getByText("所属任务 →").count(), 0, "the info row no longer repeats 所属任务");
  await bar.locator('[data-relation="stage"] a').click();
  await page.waitForURL(/\/journey\?stage=/); assert.match(page.url(), new RegExp(`stage=${stages.s1.id}`));

  bar = await open(doc(relationDocs.b), "document");
  assert.match(await text(bar), /^任务 被 3 项任务引用 · 阶段 未登记 · 来源 未登记 · 交付 未作为交付提交 · 依据 没有任务固定它为依据$/);
  await bar.locator('[data-relation="task"] a, [data-relation="task"] button').first().click();
  assert.ok(await page.locator("#document-referencing-tasks").evaluate(node => (node.closest("details") ?? node as HTMLDetailsElement).hasAttribute("open") || node.tagName !== "DETAILS"), "the count opens 引用它的任务");

  bar = await open(doc(relationDocs.c), "document");
  assert.match(await text(bar), /^任务 未登记 · 阶段 未登记 · 来源 未登记 · 交付 未作为交付提交 · 依据 没有任务固定它为依据$/);

  bar = await open(doc(relationDocs.d), "document");
  assert.match(await text(bar), /^任务 每日验收巡检（今日） · 阶段 不属于阶段 · 来源 未登记 · /);

  // the owning task cannot be read: only 阶段 says so
  await page.route(`**/work-management/tasks/${nowTasks.a.id}`, route => route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ message: "boom" }) }));
  bar = await open(doc(relationDocs.a), "document");
  assert.match(await text(bar), /阶段 读取失败/);
  assert.match(await text(bar), /来源 .+写入 · 交付 .+已使用 · 依据 被 2 项任务固定为依据$/);
  await page.unroute(`**/work-management/tasks/${nowTasks.a.id}`);

  // the page asks for the owning task once and its detail once, not more
  const seen: string[] = []; const listener = (request: import("@playwright/test").Request) => seen.push(new URL(request.url()).pathname);
  page.on("request", listener); await open(doc(relationDocs.a), "document"); page.off("request", listener);
  assert.ok(seen.filter(path => path.endsWith(`/work-management/tasks/${nowTasks.a.id}`)).length <= 1, seen.join("\n"));

  // agents
  const session = (name: string) => `/sessions?session=${encodeURIComponent(common.agentKey(name))}`;
  bar = await open(session("dev"), "agent");
  await order(bar, ["roles", "doing", "stage", "line", "delivery"]);
  assert.match(await text(bar), /^职责 功能开发 · 在做 任务列表与筛选 · 阶段 新版任务与文档页 · 队伍 队伍是空的 · 交付 右栏信息核对 · 待验收$/);
  process.env.FIXTURE_HOLD = "1";
  bar = await open(session("dev"), "agent");
  assert.match(await text(bar), /在做 模型服务暂停/);
  delete process.env.FIXTURE_HOLD;
  process.env.FIXTURE_USE = "failed";
  bar = await open(session("dev"), "agent");
  assert.match(await text(bar), /交付 右栏信息核对 · 使用失败$/);
  process.env.FIXTURE_USE = "used"; process.env.FIXTURE_RESULT_AGENT = "design";
  bar = await open(session("design"), "agent");
  assert.match(await text(bar), /^职责 体验设计 · 在做 空闲 · 阶段 未登记 · 队伍 队伍是空的 · 交付 右栏信息核对 · 已使用$/);
  delete process.env.FIXTURE_USE; delete process.env.FIXTURE_RESULT_AGENT;
  bar = await open(session("docs"), "agent");
  assert.match(await text(bar), /在做 空闲 · 阶段 未登记 · 队伍 队伍里 2 项 · 交付 还没有交付$/);
  await bar.locator('[data-relation="line"] a').click();
  await page.waitForURL(/\/arrangement#agent-/);

  // stages
  const stage = (s: { id: string }) => `/journey?stage=${s.id}`;
  bar = await open(stage(stages.s1), "stage");
  await order(bar, ["goal", "due", "tasks", "delivery", "ladder"]);
  assert.match(await text(bar), /^目标 让试用团队每天用上新版工作台 · 到期 \d\d-\d\d到期 · 还有 \d+ 天 · 任务 进行中 4 · 受阻 1 · 未开始 0 · 已关闭 0 · 交付 待验收 1 项 · 验证阶梯 补 M1$/);
  await bar.locator('[data-relation="tasks"] a').click();
  assert.match(page.url(), new RegExp(`stage=${stages.s1.id}`), "the address keeps naming the stage");
  assert.ok(await page.locator("#stage-tasks").evaluate(node => node.getBoundingClientRect().top < window.innerHeight), "the tasks section is in view");
  bar = await open(stage(stages.s2), "stage");
  assert.match(await text(bar), /到期 未登记 · 任务 .*已关闭 1 · 交付 没有等验收的交付 · 验证阶梯 未登记$/);

  // schedules
  process.env.FIXTURE_ROUTINES = "1";
  const schedule = (n: number) => `/schedules?schedule=${id(n)}`;
  bar = await open(schedule(1400), "schedule");
  await order(bar, ["role", "taking", "last", "next", "health"]);
  assert.match(await text(bar), /^职责 独立验收 · 承接 由 Leader 分派 · 上一次 .+ · 验收新版外壳 · 进行中 · 下次 .+ · 健康 正常$/);
  bar = await open(schedule(1401), "schedule");
  assert.match(await text(bar), /上一次 还没有触发过 · 下次 已停用 · 健康 正常$/);
  bar = await open(schedule(1402), "schedule");
  assert.match(await text(bar), /承接 直派 设计走查 · 上一次 .+ · 汇总试用反馈 · 已完成 · /);
  bar = await open(schedule(1403), "schedule");
  assert.match(await text(bar), /上一次 .+ · 跳过 · 下次 .+ · 健康 连续跳过 3 次$/);
  assert.equal(await page.getByText("责任 ", { exact: false }).filter({ hasText: /^· 责任/ }).count(), 0);

  // size: at most two lines at 1440, no sideways scroll at 390, on every kind
  const targets: [string, string][] = [[doc(relationDocs.a), "document"], [session("dev"), "agent"], [stage(stages.s1), "stage"], [schedule(1403), "schedule"]];
  for (const [path, kind] of targets) {
    bar = await open(path, kind);
    const lines = await bar.evaluate(node => { const style = getComputedStyle(node); return Math.round(node.getBoundingClientRect().height / parseFloat(style.lineHeight)); });
    assert.ok(lines <= 2, `${kind} bar is ${lines} lines at 1440`);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  for (const [path, kind] of targets) {
    await open(path, kind);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(overflow <= 0, `${kind} page scrolls sideways at 390 by ${overflow}px`);
  }
  assert.deepEqual(errors, []);
});
