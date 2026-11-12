// Opt-in built-app regression (build the workbench, then set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE).
// 今日 in the agent's right column with a real day's magnitude (hundreds of millions to billions of tokens): the four figures and
// their unit stay readable, the exact value is available, nothing is cut and the page does not scroll sideways, at 1440×900 and 390×844.
// EVOLOOP_USAGE_SCREENSHOT_DIR saves a screenshot of the card per width.
import assert from "node:assert/strict";
import { test } from "node:test";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const modulePath = process.env.EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE;
const executablePath = process.env.EVOLOOP_BROWSER_TEST_EXECUTABLE_PATH || process.env.EVOLOOP_BROWSER_TEST_CHROMIUM_EXECUTABLE || undefined;
const dist = resolve(import.meta.dirname, "../dist");
const fixtureDir = resolve(import.meta.dirname, "../../../scripts/frontend/fixture");
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Browserless = any;

test("the 今日 figures stay readable with their unit at billion-scale token counts, at two widths", { skip: !modulePath && "Set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE after building the workbench" }, async t => {
  const { chromium } = (await import(pathToFileURL(modulePath!).href)).default;
  const { startFixtureServer } = await import(pathToFileURL(`${fixtureDir}/server.mjs`).href);
  const { projectId, token, agentKey } = await import(pathToFileURL(`${fixtureDir}/common.mjs`).href);
  const { usage: usageFixture } = await import(pathToFileURL(`${fixtureDir}/agents.mjs`).href);
  const fixture = await startFixtureServer(dist); t.after(() => fixture.close());
  const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) }); t.after(() => browser.close());

  async function open(width: number, height: number, body: unknown) {
    const context = await browser.newContext({ viewport: { width, height }, locale: "zh-CN", reducedMotion: "reduce" });
    const page = await context.newPage();
    const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
    await page.route(/\/runtime\/usage\?/, (route: Browserless) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) }));
    await page.goto(`${fixture.base}/p/${projectId}/sessions?session=${encodeURIComponent(agentKey("dev"))}`);
    await page.getByLabel("访问令牌").fill(token);
    await page.getByRole("button", { name: "进入", exact: true }).click();
    await page.getByRole("heading", { level: 1 }).filter({ visible: true }).first().waitFor();
    if (width < 1100) { await page.getByRole("button", { name: "展开右栏" }).filter({ visible: true }).first().click(); await page.getByRole("dialog").first().waitFor(); }
    const panel = page.locator(".session-panel").filter({ visible: true }).first();
    await panel.locator("section[aria-label=上下文与用量]").waitFor();
    let last = -1;
    for (let tries = 0; tries < 40; tries++) { const top = (await panel.boundingBox())?.y ?? -1; if (top === last) break; last = top; await page.waitForTimeout(100); }
    return { page, panel, errors, context };
  }

  for (const [width, height] of [[1440, 900], [390, 844]] as const) {
    const huge = usageFixture();
    for (const item of huge.sessions) item.today = { ...item.today, inputTokens: 231_390_851_234, outputTokens: 2_142_580_000, cachedInputTokens: 1_000_000_000 };
    const { page, panel, errors, context } = await open(width, height, huge);
    const today = panel.locator("section[aria-label=上下文与用量] .session-usage-today");
    await today.locator("dd").first().waitFor();
    const cells = await today.locator("dl > div").evaluateAll((nodes: Element[]) => nodes.map(node => {
      const value = node.querySelector("dd") as HTMLElement;
      const box = node.getBoundingClientRect(), host = node.closest("dl")!.getBoundingClientRect();
      return { label: node.querySelector("dt")!.textContent!.trim(), text: value.textContent!, shown: (value.firstChild?.textContent ?? "").trim(), title: value.getAttribute("title"),
        clipped: value.scrollWidth > value.clientWidth + 1, inside: box.left >= host.left - 1 && box.right <= host.right + 1, width: Math.round(box.width) };
    }));
    // The figure and its unit are both on screen (not "2313…"), for all four cells.
    assert.deepEqual(cells.map(cell => [cell.label, cell.shown]), [["输入", "2313.9 亿"], ["输出", "21.4 亿"], ["缓存输入", "10 亿"], ["费用", "未报告"]], `${width}: figure and unit shown`);
    for (const cell of cells) { assert.equal(cell.clipped, false, `${width} ${cell.label}: not cut`); assert.equal(cell.inside, true, `${width} ${cell.label}: inside the card`); }
    // The exact value is available to a pointer and to a screen reader; a cell with nothing rounded has no second value.
    assert.equal(cells[0]!.title, "231,390,851,234 个令牌");
    assert.match(cells[0]!.text, /完整值 231,390,851,234 个令牌/); assert.match(cells[1]!.text, /完整值 2,142,580,000 个令牌/);
    assert.equal(cells[3]!.title, null);
    assert.ok(cells.every(cell => cell.width >= 80), `${width}: the four cells stay distinguishable (${cells.map(cell => cell.width).join(",")}px)`);
    const sideways = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(sideways <= 1, `${width}: no sideways scroll (${sideways}px)`);
    assert.deepEqual(errors, []);
    if (process.env.EVOLOOP_USAGE_SCREENSHOT_DIR) await today.screenshot({ path: `${process.env.EVOLOOP_USAGE_SCREENSHOT_DIR}/usage-today-${width}.png` });
    await context.close();
  }

  // 项目用量 on 统筹安排 with the same magnitudes: the limit line, the bar and the day rows read in 亿, the exact counts are tooltips, and
  // neither the cells nor the page are cut or scroll sideways.
  for (const [width, height] of [[1440, 900], [390, 844]] as const) {
    const huge = usageFixture();
    huge.daily = huge.daily.map((day: Record<string, unknown>, index: number) => ({ ...day, inputTokens: 3_300_000_000 + index, outputTokens: 214_258_000_000, cachedInputTokens: 1_650_000_000 }));
    huge.budget = { ...huge.budget, configured: true, state: "warning", limitKind: "input_tokens", limit: 4_000_000_000, used: 3_300_000_000, ratio: 0.825 };
    const { page, errors, context } = await open(width, height, huge);
    await page.goto(`${fixture.base}/p/${projectId}/sessions#project-usage`);
    await page.getByLabel("访问令牌").fill(token); await page.getByRole("button", { name: "进入", exact: true }).click();
    const block = page.locator("#project-usage");
    await block.getByText("今日与每日上限").waitFor();
    await page.waitForTimeout(300);
    const text = await block.innerText();
    assert.match(text, /输入 33 亿 \/ 40 亿（83%）/, `${width}: the limit line reads in 亿 with its unit: ${text}`);
    assert.match(text, /2142\.6 亿/, `${width}: the day rows read in 亿`);
    // The limit line shows 33 亿 / 40 亿; the exact used amount and limit are observable on the line (tooltip, screen-reader text) and on the bar.
    const exact = "已用 3,300,000,000 / 上限 4,000,000,000 个令牌";
    const line = block.locator("[data-project-limit-line]");
    assert.equal(await line.getAttribute("title"), exact, `${width}: the limit line's tooltip is the exact used amount and limit`);
    assert.ok((await line.evaluate((node: Element) => node.textContent ?? "")).includes(`（${exact}）`), `${width}: the exact amounts are in the line's text for a screen reader`);
    const bar = block.getByRole("progressbar");
    assert.equal(await bar.getAttribute("aria-valuenow"), "83");
    assert.match(await bar.getAttribute("aria-valuetext") ?? "", new RegExp(`83%，${exact}`), `${width}: the bar says more than aria-valuenow`);
    const lineBox = await line.evaluate((node: Element) => ({ clipped: node.scrollWidth > node.clientWidth + 1 }));
    assert.equal(lineBox.clipped, false, `${width}: the limit line is not cut`);
    const cells = await block.locator("tbody tr").first().locator("td").evaluateAll((nodes: Element[]) => nodes.map(node => ({ text: node.textContent!.trim(), title: node.getAttribute("title"), clipped: node.scrollWidth > node.clientWidth + 1 })));
    assert.ok(cells.slice(0, 3).every(cell => /亿/.test(cell.text) && cell.title && /个令牌$/.test(cell.title)), `${width}: unit and exact value on every token cell: ${JSON.stringify(cells)}`);
    assert.ok(cells.every(cell => !cell.clipped), `${width}: no cell is cut`);
    const sideways = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(sideways <= 1, `${width}: no sideways page scroll (${sideways}px)`);
    assert.deepEqual(errors, []);
    if (process.env.EVOLOOP_USAGE_SCREENSHOT_DIR) await block.screenshot({ path: `${process.env.EVOLOOP_USAGE_SCREENSHOT_DIR}/project-usage-${width}.png` });
    await context.close();
  }

  // “Nothing recorded today” and “recorded today as 0” are different things, also next to big yesterday figures.
  {
    const base = usageFixture();
    const bigDay = (day: string) => ({ day, inputTokens: 231_390_851_234, outputTokens: 2_142_580_000, cachedInputTokens: 1_000_000_000, costUsd: null, costReported: false });
    const zero = { day: "2026-11-10", inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, costUsd: null, costReported: false };
    const variant = (recordedToday: boolean) => ({ ...base, sessions: base.sessions.map((session: { days: unknown[] }) => ({ ...session,
      days: recordedToday ? [bigDay("2026-11-09"), zero] : [bigDay("2026-11-09")], today: zero })) });
    const none = await open(1440, 900, variant(false));
    const noneCard = none.panel.locator("section[aria-label=上下文与用量]");
    await noneCard.getByText("今日没有用量记录，不按 0 计").waitFor();
    assert.equal(await noneCard.locator(".session-usage-today dl").count(), 0, "no recorded row for today: no figures, not zeros");
    await none.context.close();
    const recorded = await open(1440, 900, variant(true));
    const tiles = recorded.panel.locator("section[aria-label=上下文与用量] .session-usage-today dd");
    await tiles.first().waitFor();
    assert.deepEqual(await tiles.evaluateAll((nodes: Element[]) => nodes.map(node => (node.firstChild?.textContent ?? "").trim())), ["0", "0", "0", "未报告"], "a recorded 0 shows 0");
    await recorded.context.close();
  }
});
