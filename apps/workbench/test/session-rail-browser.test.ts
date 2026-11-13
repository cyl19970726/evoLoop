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
      const config = panel.locator("section[aria-label=运行环境]");
      assert.ok((await config.boundingBox())!.y < height - 60, `${item.name}: 运行环境 starts on the first screen, not at the bottom`);
      // One line: runtime · model · effort, each said once with where it comes from; the record stays folded.
      assert.match(await config.innerText(), item.name === "dev" ? /Codex\s*·\s*gpt-6-sol\s*实际\s*·\s*high\s*目标/ : /Codex\s*·\s*gpt-6-sol\s*·\s*high\s*目标，尚无实际报告/);
      assert.equal(await config.locator(".session-config-record").evaluate(element => (element as HTMLDetailsElement).open), false);
      assert.match(await panel.locator("section[aria-label=上下文与用量]").innerText(), /^上下文与用量\s*上下文[\s\S]*今日/, "the card is titled 上下文与用量: context first, then today");
      // The adjust button is off for 文档整理 and 设计走查 (not full access): one line at the card's foot, with where to fix it.
      const blocked = config.locator(".session-adjust-blocked");
      if (item.name === "dev") assert.equal(await blocked.count(), 0, "a full-access agent can adjust: no reason shown");
      else {
        assert.equal((await blocked.innerText()).trim(), "不能调整：不是完整权限 · 去分工与运行");
        assert.match(await blocked.getByRole("link", { name: "去分工与运行" }).getAttribute("href") ?? "", /\/runtime$/);
        const box = (await blocked.boundingBox())!;
        assert.ok(box.height < 24, `${item.name}: the reason is one line (${box.height}px)`);
      }
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

  // 上下文与用量: the context bar comes first with its state; today is small figures; project-wide facts are not here.
  for (const [name, width, height] of [["verify", 1440, 900], ["lead", 390, 844], ["design", 390, 844]] as const) {
    const { page, panel, errors } = await open(name, width, height);
    const usage = panel.locator("section[aria-label=上下文与用量]");
    await usage.locator(".session-context").waitFor();
    const text = await usage.innerText();
    if (name === "verify") {
      assert.match(text, /上下文\s*接近交接[\s\S]*17\.2 万 \/ 20 万（86%）[\s\S]*今日\s*输入\s*8\.8 万\s*输出\s*9200\s*缓存输入\s*4\.4 万\s*费用\s*未报告/, text);
      assert.equal(await usage.getByRole("progressbar").getAttribute("aria-valuenow"), "86");
      // A new target waits: the line keeps what is in effect and the tag says what comes next.
      // The line in effect is labelled 现在 and the next target is its own row below it.
      const environment = panel.locator("section[aria-label=运行环境]");
      assert.match(await environment.innerText(), /现在：\s*Codex\s*·\s*gpt-6-sol\s*实际\s*·\s*high\s*已确认[\s\S]*下一轮改为 gpt-6-astra \/ max/);
      const now = (await environment.locator(".session-runtime-now").boundingBox())!, next = (await environment.locator(".session-runtime-next").boundingBox())!;
      assert.ok(next.y >= now.y + now.height, "the next-turn tag sits on its own row under the 现在 line");
    }
    if (name === "lead") {
      assert.match(text, /需交接新线程[\s\S]*21\.2 万 \/ 20 万（106%）[\s\S]*请交接新线程/, text);
      assert.match(await usage.getByRole("link", { name: "去分工与运行" }).getAttribute("href") ?? "", /\/runtime$/);
    }
    if (name === "design") assert.match(text, /上下文\s*没有记录[\s\S]*这个智能体还没有用量记录，不按 0 计/, text);
    for (const projectWide of ["每日上限", "用量时区", "项目用量", "Asia/Shanghai"]) assert.equal(text.includes(projectWide), false, `${name}: ${projectWide}`);
    assert.ok(await sideways(page) <= 1, `${name} ${width}: no sideways scroll`);
    assert.deepEqual(errors, []);
    await page.context().close();
  }
  // Only a project close to its daily limit is said here, in one line that leads to 统筹安排.
  const { usage: usageFixture } = await import(pathToFileURL(`${fixtureDir}/agents.mjs`).href);
  const nearLimit = usageFixture();
  nearLimit.budget = { ...nearLimit.budget, configured: true, state: "warning", limitKind: "input_tokens", limit: 1_000_000, used: 860_000, ratio: 0.86 };
  const budgeted = await open("dev", 1440, 900, page => page.route(/\/runtime\/usage\?/, route => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(nearLimit) })));
  const reminder = budgeted.panel.locator("section[aria-label=上下文与用量]").getByText(/项目今日用量接近每日上限（86%）/);
  await reminder.waitFor();
  const toUsage = budgeted.panel.getByRole("link", { name: "查看项目用量" });
  assert.match(await toUsage.getAttribute("href") ?? "", new RegExp(`/p/${projectId}/sessions#project-usage$`));
  // Following it lands on 统筹安排 with 项目用量 in view: the limit as a bar, seven days, the time zone below.
  await toUsage.click();
  const block = budgeted.page.locator("#project-usage");
  await block.getByText("今日与每日上限").waitFor();
  await budgeted.page.waitForTimeout(300);
  const blockBox = (await block.boundingBox())!;
  assert.ok(blockBox.y < 900 && blockBox.y + 40 > 0, `项目用量 is scrolled into view (${blockBox.y})`);
  const blockText = await block.innerText();
  assert.match(blockText, /接近上限[\s\S]*输入 86 万 \/ 100 万（86%）[\s\S]*近 7 天[\s\S]*11-10[\s\S]*11-04[\s\S]*按 Asia\/Shanghai 计日/, blockText);
  assert.equal(await block.locator("tbody tr").count(), 7);
  // 11-08 has no ledger rows: the row says so instead of showing 0.
  assert.match(await block.locator("tbody tr", { hasText: "11-08" }).innerText(), /11-08\s*没有记录/);
  await budgeted.page.context().close();

  // The skills chip is a link to the agent's Role, reachable and visibly focused from the keyboard.
  {
    const { page, panel } = await open("docs", 1440, 900);
    const skills = panel.getByRole("link", { name: "技能随职责“文档整理”" });
    assert.match(await skills.getAttribute("href") ?? "", new RegExp(`/p/${projectId}/roles\\?role=`));
    await skills.focus(); await page.keyboard.press("Shift+Tab"); await page.keyboard.press("Tab");
    assert.equal(await skills.evaluate(element => element === document.activeElement && element.matches(":focus-visible")), true);
    // An opaque accent edge (#2f4bb3) drawn inside the chip, with a surface-coloured band within it (WCAG 2.4.7).
    await page.waitForFunction(element => /rgb\(47, 75, 179\) 0px 0px 0px 2px inset/.test(getComputedStyle(element!).boxShadow), await skills.elementHandle(), { timeout: 3000 })
      .catch(() => undefined);
    assert.match(await skills.evaluate(element => getComputedStyle(element).boxShadow), /rgb\(47, 75, 179\) 0px 0px 0px 2px inset/);
    await page.context().close();
  }

  // A day without ledger rows is not 0: nothing recorded today (only yesterday) shows no figures and no 0% limit bar.
  {
    const noToday = usageFixture();
    noToday.daily = noToday.daily.filter((day: { day: string }) => day.day !== "2026-11-10");
    noToday.sessions = noToday.sessions.map((session: { days: Array<{ day: string }>; today: object }) => ({ ...session,
      days: session.days.filter(day => day.day !== "2026-11-10").concat([{ ...session.today, day: "2026-11-09" }]),
      today: { day: "2026-11-10", inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, costUsd: null, costReported: false } }));
    noToday.budget = { ...noToday.budget, used: 0, ratio: 0 };
    const quiet = await open("dev", 1440, 900, page => page.route(/\/runtime\/usage\?/, route => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(noToday) })));
    const card = quiet.panel.locator("section[aria-label=上下文与用量]");
    await card.getByText("今日没有用量记录，不按 0 计").waitFor();
    assert.equal(await card.locator(".session-usage-today dl").count(), 0, "no figure tiles");
    await quiet.page.goto(`${fixture.base}/p/${projectId}/sessions#project-usage`);
    await quiet.page.getByLabel("访问令牌").fill(token); await quiet.page.getByRole("button", { name: "进入", exact: true }).click();
    const block = quiet.page.locator("#project-usage");
    await block.getByText("今日没有记录，不按 0 计 · 每日上限 150 万").waitFor();
    assert.equal(await block.getByRole("progressbar").count(), 0);
    assert.doesNotMatch(await block.innerText(), /0 \/ 150 万|（0%）/);
    assert.match(await block.locator("tbody tr", { hasText: "11-10" }).innerText(), /11-10\s*没有记录/);
    await quiet.page.context().close();
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

  // A code the page has no words for still reads as a plain sentence pointing at the original below.
  const unknown = sessionLines();
  unknown.lines[0].entries[1].suspendReason = "FORBIDDEN: actor lacks review on project";
  const other = await open("docs", 1440, 900, page => page.route(/\/session-lines$/, route => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(unknown) })));
  const otherNext = other.panel.locator(".session-next-work");
  await otherNext.getByText("暂停原因暂无说明，见下方“暂停代码与原文”").waitFor();
  assert.doesNotMatch(await otherNext.innerText(), /翻译|FORBIDDEN|actor lacks/);
  await other.page.context().close();
});
