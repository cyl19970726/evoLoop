// Opt-in built-app regression (build the workbench, then set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE): the agent page's right
// column answers “在做哪项、接下来哪项” on its first screen for an agent running a Task, one idle with Tasks in its line and one
// idle with nothing, at 1440×900 and 390×844, without sideways scrolling; 执行配置 starts on the first screen at 1440; a failed
// line read is said and never turns into “没有排队的任务”. Everything is the screenshot fixture (scripts/frontend/fixture/).
import assert from "node:assert/strict";
import { test } from "node:test";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const modulePath = process.env.EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE;
const executablePath = process.env.EVOLOOP_BROWSER_TEST_EXECUTABLE_PATH || process.env.EVOLOOP_BROWSER_TEST_CHROMIUM_EXECUTABLE || undefined;
const dist = resolve(import.meta.dirname, "../dist");
const fixtureDir = resolve(import.meta.dirname, "../../../scripts/frontend/fixture");
// Playwright is not a dependency (it is loaded from the module path above), so its pages and locators go untyped here.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Browserless = any;

test("the agent's right column shows what it does now and next on its first screen", { skip: !modulePath && "Set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE after building the workbench" }, async t => {
  const { chromium } = (await import(pathToFileURL(modulePath!).href)).default;
  const { startFixtureServer } = await import(pathToFileURL(`${fixtureDir}/server.mjs`).href);
  const { projectId, token, agentKey } = await import(pathToFileURL(`${fixtureDir}/common.mjs`).href);
  const fixture = await startFixtureServer(dist); t.after(() => fixture.close());
  const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) }); t.after(() => browser.close());

  async function open(name: string, width: number, height: number, before?: (page: Browserless) => Promise<unknown>) {
    const page = await (await browser.newContext({ viewport: { width, height }, locale: "zh-CN", reducedMotion: "reduce" })).newPage();
    const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
    if (before) await before(page);
    await page.goto(`${fixture.base}/p/${projectId}/sessions?session=${encodeURIComponent(agentKey(name))}`);
    await page.getByLabel("访问令牌").fill(token);
    await page.getByRole("button", { name: "进入", exact: true }).click();
    await page.getByRole("heading", { level: 1 }).filter({ visible: true }).first().waitFor();
    // Below 1100px the column is a drawer (a sheet from the bottom on a phone) and opens only when asked.
    if (width < 1100) { await page.getByRole("button", { name: "展开右栏" }).filter({ visible: true }).first().click(); await page.getByRole("dialog").first().waitFor(); }
    const panel = page.locator(".session-panel").filter({ visible: true }).first();
    await panel.locator("section[aria-label=正在做]").waitFor();
    // The sheet slides in: measure once it has stopped moving.
    let last = -1;
    for (let tries = 0; tries < 40; tries++) {
      const top = (await panel.boundingBox())?.y ?? -1;
      if (top === last) break;
      last = top; await page.waitForTimeout(100);
    }
    return { page, panel, errors };
  }
  const bottom = async (locator: Browserless) => { const box = (await locator.boundingBox())!; return box.y + box.height; };
  const sideways = (page: Browserless) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

  const cases = [
    { name: "dev", now: [/运行中/, /任务列表与筛选/, /已接手（本人确认）/], next: [/日程提醒接入/, /执行队列第 2 位/, /已暂停/, /智能体返回入口/, /待返工/] },
    { name: "docs", now: [/空闲/, /没有正在做的任务或消息/], next: [/接下来\s*2 项/, /整理旧文档/, /队伍第 1 位 · 排队中/, /页面截图由脚本生成/, /已暂停/, /等页面说明的模板定稿/] },
    { name: "design", now: [/空闲/], next: [/没有排队的任务。/] },
  ];
  for (const item of cases) for (const [width, height] of [[1440, 900], [390, 844]] as const) {
    const { page, panel, errors } = await open(item.name, width, height);
    const now = panel.locator("section[aria-label=正在做]"), next = panel.locator(".session-next-work");
    await next.getByText(item.name === "design" ? "没有排队的任务。" : /队伍|执行队列/).first().waitFor();
    for (const pattern of item.now) assert.match(await now.innerText(), pattern, `${item.name} ${width}: 正在做`);
    for (const pattern of item.next) assert.match(await next.innerText(), pattern, `${item.name} ${width}: 接下来`);
    assert.ok(await bottom(now) <= height && await bottom(next) <= height, `${item.name} ${width}: 正在做 and 接下来 are on the first screen`);
    if (width === 1440) {
      const config = panel.locator("section[aria-label=执行配置]");
      assert.ok((await config.boundingBox())!.y < height - 60, `${item.name}: 执行配置 starts on the first screen, not at the bottom`);
      assert.match(await config.innerText(), /运行时\s*Codex[\s\S]*目标模型\s*gpt-6-sol[\s\S]*思考强度\s*high[\s\S]*执行权限/);
    }
    assert.ok(await sideways(page) <= 1, `${item.name} ${width}: no sideways scroll`);
    assert.deepEqual(await panel.evaluate(root => [...root.querySelectorAll("*")].filter(element => element.getBoundingClientRect().right > root.getBoundingClientRect().right + 1 && element.getClientRects().length).map(element => element.className).slice(0, 3)), [],
      `${item.name} ${width}: nothing sticks out of the right column`);
    // Every Task named here is a link to that Task, which returns to this agent.
    const link = next.locator("ol a").first();
    if (item.name !== "design") assert.match(await link.getAttribute("href") ?? "", new RegExp(`/p/${projectId}/tasks/[^?]+\\?return=`));
    assert.deepEqual(errors, []);
    await page.context().close();
  }

  // The rarely used 标识设置 is not on the first screen; it opens from 详情与来源.
  const { page, panel } = await open("dev", 1440, 900);
  assert.equal(await panel.locator(".session-identity-settings").isVisible(), false);
  await panel.locator(".session-information > summary").click();
  await panel.locator(".session-identity-settings > summary").waitFor();
  // Delivered and waiting for acceptance is not next work; it is kept folded with finished assignments.
  await panel.getByText("已交出或已结束的分派 · 1 项").click();
  assert.match(await panel.locator(".session-ended-assignments").innerText(), /右栏信息核对 · 已交付，等验收/);
  await page.context().close();

  // A line that cannot be read is said; what was read stays, and nothing claims the line is empty.
  const failed = await open("docs", 1440, 900, page => page.route(/\/session-lines$/, route => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ message: "服务暂不可用" }) })));
  const failedNext = failed.panel.locator(".session-next-work");
  await failedNext.getByText(/智能体队伍暂不可读取/).waitFor();
  assert.match(await failedNext.innerText(), /整理旧文档/, "the assignment the snapshot carries still shows");
  assert.doesNotMatch(await failedNext.innerText(), /没有排队的任务/);
  // Unread, the line may hold that Task: the row says only 已分派, never 未排进队伍.
  assert.match(await failedNext.innerText(), /整理旧文档\s*已分派 · 任务待开始/);
  assert.doesNotMatch(await failedNext.innerText(), /未排进队伍/);
  await failedNext.getByRole("button", { name: "重试" }).waitFor();
  await failed.page.context().close();

  // A pause the pump wrote as `CODE: English` reads as a sentence; the code and the original open from 暂停代码与原文.
  const raw = "RECIPIENT_UNAVAILABLE: Session 70000024 shares its Role with 1 other live Session(s) and has no runtime.materialCli entry of its own";
  const { sessionLines } = await import(pathToFileURL(`${fixtureDir}/agents.mjs`).href);
  const coded = sessionLines();
  coded.lines[0].entries[1].suspendReason = raw;
  const paused = await open("docs", 390, 844, page => page.route(/\/session-lines$/, route => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(coded) })));
  const pausedNext = paused.panel.locator(".session-next-work");
  await pausedNext.getByText("已暂停").waitFor();
  assert.match(await pausedNext.innerText(), /业务身份/);
  assert.doesNotMatch(await pausedNext.innerText(), /RECIPIENT_UNAVAILABLE|materialCli/, "no code or English on the row itself");
  await pausedNext.getByText("暂停代码与原文").click();
  assert.match(await pausedNext.innerText(), /代码\s*RECIPIENT_UNAVAILABLE[\s\S]*原文\s*RECIPIENT_UNAVAILABLE: Session 70000024/);
  assert.ok(await sideways(paused.page) <= 1, "the opened original wraps inside the column at 390");
  await paused.page.context().close();
});
