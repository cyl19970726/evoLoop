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
});
