// Built-app regression (set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE after building the workbench), Task f1e8829a-aba9-48fb-9673-5a4d912ec2a5:
// each row of the agent list is two lines — who it is, then one sentence of what it is doing now — with no provider, model or identifier,
// a status mark that is the page header's component, a 历史与待归类 fold that opens for a selected agent inside it, and "M 个等你处理".
// The screenshot fixture with FIXTURE_ROWS (nine more agents, one per state), at 1440×900 and 390×844, light and dark.
import assert from "node:assert/strict";
import { test } from "node:test";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const modulePath = process.env.EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE;
const executablePath = process.env.EVOLOOP_BROWSER_TEST_EXECUTABLE_PATH || process.env.EVOLOOP_BROWSER_TEST_CHROMIUM_EXECUTABLE || undefined;
const dist = resolve(import.meta.dirname, "../dist");
const fixtureDir = resolve(import.meta.dirname, "../../../scripts/frontend/fixture");
const skip = !modulePath && "Set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE after building the workbench";

test("agent rows say who and what now, in two lines; the history fold follows the selection; 等你处理 filters", { skip }, async t => {
  Object.assign(process.env, { FIXTURE_ROWS: "1", FIXTURE_HOLD: "1", FIXTURE_HOLD_PROVIDER: "claude" });
  t.after(() => { for (const key of ["FIXTURE_ROWS", "FIXTURE_HOLD", "FIXTURE_HOLD_PROVIDER"]) delete process.env[key]; });
  const { chromium } = (await import(pathToFileURL(modulePath!).href)).default;
  const { startFixtureServer } = await import(pathToFileURL(`${fixtureDir}/server.mjs`).href);
  const common = await import(pathToFileURL(`${fixtureDir}/common.mjs`).href);
  const fixture = await startFixtureServer(dist); t.after(() => fixture.close());
  const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) }); t.after(() => browser.close());
  for (const [width, height, scheme] of [[1440, 900, "light"], [1440, 900, "dark"], [390, 844, "light"], [390, 844, "dark"]] as const) {
    const label = `${width} ${scheme}`;
    const context = await browser.newContext({ viewport: { width, height }, locale: "zh-CN", reducedMotion: "reduce", colorScheme: scheme });
    const page = await context.newPage();
    await page.goto(`${fixture.base}/p/${common.projectId}/sessions?session=${encodeURIComponent(common.agentKey("dev"))}`);
    await page.getByLabel("访问令牌").fill(common.token);
    await page.getByRole("button", { name: "进入", exact: true }).click();
    await page.locator("[data-workspace-entry]").first().waitFor();
    if (width === 390) await page.getByRole("button", { name: "打开项目导航" }).click();
    else if (await page.locator("[data-shell=frame]").getAttribute("data-rail") !== "shown") await page.getByRole("button", { name: "展开项目导航" }).click();
    const nav = page.locator(width === 390 ? ".mobile-navigation .session-navigation" : "aside[aria-label=项目导航] .session-navigation");
    const row = (name: string, nth = 0) => nav.locator(".session-nav-item").filter({ has: page.locator(".session-nav-name", { hasText: name }) }).nth(nth);
    await row("长标题执行者").waitFor();
    // 1 + 2: line 1 the name, line 2 one sentence; nothing about provider, model or identifier.
    const sentence = async (name: string, nth = 0) => (await row(name, nth).locator(".session-nav-signal").innerText()).trim();
    assert.equal(await sentence("长标题执行者"), "正在做 把项目协作页的智能体列表改成每行写它是谁、现在在做什么，并把工程标识收进右栏", `${label}: task title in full text`);
    assert.equal(await sentence("回复消息者"), "在回复消息");
    assert.equal(await sentence("空闲值守者"), "空闲");
    assert.equal(await sentence("等你处理者"), "等你处理");
    assert.equal(await sentence("被暂停的智能体"), "已暂停（Claude 额度用完）");
    assert.equal(await sentence("状态未读者"), "状态未读到", `${label}: an unread status is not 空闲`);
    const text = await nav.innerText();
    assert.doesNotMatch(text.replace(/已暂停（.*）/, ""), /标识 [0-9a-f]|Codex|Claude|gpt-|sonnet|最近活动/, `${label}: no provider, model or identifier in rows`);
    // Same-named agents: four characters at the end of line 1, only on those two.
    assert.equal((await nav.locator(".session-nav-short").allInnerTexts()).length, 2, `${label}: only the two same-named agents carry a short id`);
    for (const short of await nav.locator(".session-nav-short").allInnerTexts()) assert.match(short, /^[0-9a-f]{4}$/);
    // The mark is the status component: its tone differs by state (colour + shape).
    const tones = await Promise.all(["长标题执行者", "空闲值守者", "等你处理者", "被暂停的智能体"].map(name => row(name).locator("[data-tone]").getAttribute("data-tone")));
    assert.deepEqual(tones, ["progress", "idle", "waiting", "blocked"]);
    // Rows: one height, no truncation of short names, no sideways scrolling, a short name is not cut.
    const heights = await nav.locator(".session-nav-item").evaluateAll(nodes => nodes.map(node => Math.round(node.getBoundingClientRect().height)));
    assert.equal(new Set(heights).size, 1, `${label}: one row height (${heights})`);
    for (const name of ["回复消息者", "等你处理者", "空闲值守者"]) {
      const cut = await row(name).locator(".session-nav-name > span").first().evaluate((el: Element) => el.scrollWidth > el.clientWidth);
      assert.equal(cut, false, `${label}: ${name} is not truncated`);
    }
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth), 0, `${label}: no sideways scrolling`);
    // Header marker: the same component as the row mark.
    // 历史与待归类: collapsed by default, no 测试与样本, no 已加载.
    assert.match(text, /历史与待归类 · 1/);
    assert.doesNotMatch(text, /测试与样本|已加载/);
    const fold = nav.locator(".session-nav-history");
    assert.equal(await fold.getAttribute("aria-expanded"), "false");
    assert.equal(await row("早先的智能体").count(), 0, `${label}: the fold is closed`);
    await fold.click();
    await row("早先的智能体").waitFor();
    assert.equal(await sentence("早先的智能体"), "空闲", "rows in the fold are written like the others");
    // 等你处理: shown with the count, filters, and goes away when none is left.
    const waiting = nav.locator(".session-nav-waiting");
    assert.equal((await waiting.innerText()).trim(), "1 个等你处理");
    await waiting.click();
    await row("等你处理者").waitFor();
    assert.equal(await nav.locator(".session-nav-item").count(), 1, `${label}: the filter keeps the agents waiting on you`);
    await waiting.click();
    assert.ok(await nav.locator(".session-nav-item").count() > 5);
    await context.close();
  }
});

test("a selected agent inside the history fold opens it, and the fold is absent when there is no history; the header mark is the status component", { skip }, async t => {
  Object.assign(process.env, { FIXTURE_ROWS: "1" });
  t.after(() => { delete process.env.FIXTURE_ROWS; });
  const { chromium } = (await import(pathToFileURL(modulePath!).href)).default;
  const { startFixtureServer } = await import(pathToFileURL(`${fixtureDir}/server.mjs`).href);
  const common = await import(pathToFileURL(`${fixtureDir}/common.mjs`).href);
  const { rowAgentId } = await import(pathToFileURL(`${fixtureDir}/agents.mjs`).href);
  const fixture = await startFixtureServer(dist); t.after(() => fixture.close());
  const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) }); t.after(() => browser.close());
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "zh-CN", reducedMotion: "reduce" })).newPage();
  await page.goto(`${fixture.base}/p/${common.projectId}/sessions?session=${encodeURIComponent(`owned:${rowAgentId(9)}`)}`);
  await page.getByLabel("访问令牌").fill(common.token);
  await page.getByRole("button", { name: "进入", exact: true }).click();
  const nav = page.locator("aside[aria-label=项目导航] .session-navigation");
  await nav.locator(".session-nav-item[aria-current=page]").waitFor({ timeout: 8000 }).catch(async () => assert.fail(await page.locator("body").innerText()));
  assert.equal(await nav.locator(".session-nav-history").getAttribute("aria-expanded"), "true", "the fold opens for a selected agent inside it");
  await page.reload();
  await page.getByLabel("访问令牌").fill(common.token);
  await page.getByRole("button", { name: "进入", exact: true }).click();
  await nav.locator(".session-nav-item[aria-current=page]").waitFor();
  assert.equal(await nav.locator(".session-nav-history").getAttribute("aria-expanded"), "true", "and stays open after a refresh");
  // Header: the status mark is the shared StatusTag (data-tone).
  await page.goto(`${fixture.base}/p/${common.projectId}/sessions?session=${encodeURIComponent(common.agentKey("dev"))}`);
  await page.getByLabel("访问令牌").fill(common.token);
  await page.getByRole("button", { name: "进入", exact: true }).click();
  await page.locator(".session-status-badge[data-tone]").waitFor();
});

test("each row and the page header make one judgement; names of twelve characters are not cut; a selected row is in view after a reload", { skip }, async t => {
  Object.assign(process.env, { FIXTURE_ROWS: "1", FIXTURE_HOLD: "1", FIXTURE_HOLD_PROVIDER: "claude" });
  t.after(() => { for (const key of ["FIXTURE_ROWS", "FIXTURE_HOLD", "FIXTURE_HOLD_PROVIDER"]) delete process.env[key]; });
  const { chromium } = (await import(pathToFileURL(modulePath!).href)).default;
  const { startFixtureServer } = await import(pathToFileURL(`${fixtureDir}/server.mjs`).href);
  const common = await import(pathToFileURL(`${fixtureDir}/common.mjs`).href);
  const { rowAgentId } = await import(pathToFileURL(`${fixtureDir}/agents.mjs`).href);
  const fixture = await startFixtureServer(dist); t.after(() => fixture.close());
  const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) }); t.after(() => browser.close());
  for (const [width, height] of [[1440, 900], [390, 844]] as const) {
    const page = await (await browser.newContext({ viewport: { width, height }, locale: "zh-CN", reducedMotion: "reduce" })).newPage();
    const open = async (n: number) => {
      await page.goto(`${fixture.base}/p/${common.projectId}/sessions?session=${encodeURIComponent(`owned:${rowAgentId(n)}`)}`);
      await page.getByLabel("访问令牌").fill(common.token);
      await page.getByRole("button", { name: "进入", exact: true }).click();
      await page.locator(".session-status-badge[data-tone]").waitFor({ timeout: 8000 });
    };
    // Per sample: the row's sentence and mark against the header's. The fixture has no native connection, so the header may only
    // say "连接不可用 · 状态待核对" where the judgement needs it, and the row says the short form of the same state.
    const samples: [number, string][] = [[1, "长标题执行者"], [2, "回复消息者"], [3, "空闲值守者"], [4, "等你处理者"], [5, "被暂停的智能体"], [6, "状态未读者"]];
    const pairs: string[] = [];
    for (const [n, name] of samples) {
      await open(n);
      const header = page.locator(".session-status-badge[data-tone]").first();
      const headerText = (await header.innerText()).trim(), headerTone = await header.getAttribute("data-tone");
      if (width === 390) await page.getByRole("button", { name: "打开项目导航" }).click();
      else if (await page.locator("[data-shell=frame]").getAttribute("data-rail") !== "shown") await page.getByRole("button", { name: "展开项目导航" }).click();
      const nav = page.locator(width === 390 ? ".mobile-navigation .session-navigation" : "aside[aria-label=项目导航] .session-navigation");
      const row = nav.locator(".session-nav-item").filter({ has: page.locator(".session-nav-name", { hasText: name }) }).first();
      const rowText = (await row.locator(".session-nav-signal").innerText()).trim(), rowTone = await row.locator("[data-tone]").getAttribute("data-tone");
      pairs.push(`${name}｜行 ${rowText}｜页头 ${headerText}｜${rowTone}/${headerTone}`);
      assert.equal(rowTone, headerTone, `${width}: ${name} — the row mark and the header mark are the same state (${pairs.at(-1)})`);
      const consistent: Record<string, RegExp> = {
        长标题执行者: /^(正在做 .*|状态待核对)$/, 回复消息者: /^(在回复消息|状态待核对)$/, 空闲值守者: /^(空闲|状态待核对)$/,
        等你处理者: /^等你处理$/, 被暂停的智能体: /^已暂停（.+）$/, 状态未读者: /^状态未读到$/,
      };
      assert.match(rowText, consistent[name]!, `${width}: ${name}`);
      if (rowText === "状态待核对") assert.equal(headerText, "连接不可用 · 状态待核对", `${width}: ${name} — where the header cannot verify, neither does the row`);
      if (name === "等你处理者") assert.equal(headerText, "等你处理");
      if (name === "被暂停的智能体") assert.equal(headerText, rowText);
      if (name === "状态未读者") assert.equal(headerText, "外部 · 状态未知");
    }
    console.log(pairs.join("\n"));
    // Names: twelve characters are whole, thirty are cut and carry the full name as a tooltip.
    await open(10);
    if (width === 390) await page.getByRole("button", { name: "打开项目导航" }).click();
    else if (await page.locator("[data-shell=frame]").getAttribute("data-rail") !== "shown") await page.getByRole("button", { name: "展开项目导航" }).click();
    const nav = page.locator(width === 390 ? ".mobile-navigation .session-navigation" : "aside[aria-label=项目导航] .session-navigation");
    const nameCell = (name: string) => nav.locator(".session-nav-item").filter({ has: page.locator(".session-nav-name", { hasText: name }) }).first().locator(".session-nav-name > span").first();
    assert.equal(await nameCell("一二三四五六七八九十一二").evaluate((el: Element) => el.scrollWidth > el.clientWidth), false, `${width}: twelve characters are not cut`);
    assert.equal(await nameCell("十六个字的显示名称用来测截断否十六个字的显示名称用来测截断否").evaluate((el: Element) => el.scrollWidth > el.clientWidth), true, `${width}: a longer name is cut`);
    assert.equal(await nameCell("十六个字的显示名称用来测截断否十六个字的显示名称用来测截断否").getAttribute("title"), "十六个字的显示名称用来测截断否十六个字的显示名称用来测截断否");
    // A selected agent inside the history fold is in view after a reload.
    await page.goto(`${fixture.base}/p/${common.projectId}/sessions?session=${encodeURIComponent(`owned:${rowAgentId(9)}`)}`);
    await page.getByLabel("访问令牌").fill(common.token);
    await page.getByRole("button", { name: "进入", exact: true }).click();
    if (width === 390) await page.getByRole("button", { name: "打开项目导航" }).click();
    else if (await page.locator("[data-shell=frame]").getAttribute("data-rail") !== "shown") await page.getByRole("button", { name: "展开项目导航" }).click();
    const selected = nav.locator(".session-nav-item[aria-current=page]");
    await selected.waitFor({ timeout: 8000 });
    await page.waitForTimeout(300);
    const box = await selected.boundingBox();
    assert.ok(box && box.y >= 0 && box.y + box.height <= height, `${width}: the selected history row is inside the viewport (${JSON.stringify(box)})`);
  }
});
