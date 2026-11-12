// Built-app check of the 动态 sample (/ui/flow, hand-written fixtures; DEC-045 F1 first segment): both widths, both themes, reduced motion,
// the keyboard, no page-level horizontal scroll, the packet cap and long tasks. It proves the picture and its rules on fixtures only; it says
// nothing about a real instance (that is the second segment). Needs the built workbench and EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE.
// EVOLOOP_FLOW_SCREENSHOT_DIR=<dir> also writes the four screenshots (two widths x two themes) there.
import assert from "node:assert/strict";
import { test } from "node:test";
import { resolve } from "node:path";
import { mkdirSync } from "node:fs";
import { pathToFileURL } from "node:url";

const modulePath = process.env.EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE;
const required = process.env.EVOLOOP_BROWSER_TEST_REQUIRED === "1";
const executablePath = process.env.EVOLOOP_BROWSER_TEST_EXECUTABLE_PATH || process.env.EVOLOOP_BROWSER_TEST_CHROMIUM_EXECUTABLE || undefined;
const dist = resolve(import.meta.dirname, "../dist");
const fixtureDir = resolve(import.meta.dirname, "../../../scripts/frontend/fixture");
const shots = process.env.EVOLOOP_FLOW_SCREENSHOT_DIR;
const skip = !required && !modulePath && "Set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE after building the workbench";

async function launch(t: { after(fn: () => unknown): void }) {
  assert.ok(modulePath, "EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE is required when EVOLOOP_BROWSER_TEST_REQUIRED=1");
  const { chromium } = (await import(pathToFileURL(modulePath).href)).default;
  const { startFixtureServer } = await import(pathToFileURL(`${fixtureDir}/server.mjs`).href);
  const fixture = await startFixtureServer(dist); t.after(() => fixture.close());
  const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) }); t.after(() => browser.close());
  return { browser, base: fixture.base as string };
}
const open = async (browser: any, base: string, width: number, height: number, scheme: "light" | "dark", reducedMotion: "reduce" | "no-preference") => {
  const context = await browser.newContext({ viewport: { width, height }, colorScheme: scheme, reducedMotion, locale: "zh-CN", timezoneId: "Asia/Shanghai" });
  const page = await context.newPage();
  await page.goto(`${base}/ui/flow`);
  await page.evaluate((s: string) => { document.documentElement.dataset.theme = s; }, scheme);
  await page.getByRole("heading", { name: "动态", exact: true }).waitFor();
  return { context, page };
};

test("1440 and 390 wide, light and dark: the right layout, no page-level horizontal scroll, the fixture notice on screen, every node there", { skip }, async t => {
  const { browser, base } = await launch(t);
  if (shots) mkdirSync(shots, { recursive: true });
  for (const scheme of ["light", "dark"] as const) for (const [width, height, layout] of [[1440, 900, "canvas"], [390, 844, "lanes"]] as const) {
    const { context, page } = await open(browser, base, width, height, scheme, "no-preference");
    assert.equal(await page.locator("section[data-layout]").getAttribute("data-layout"), layout, `${width} ${scheme}`);
    assert.ok(await page.getByText("夹具数据 · 非真实").isVisible(), "the fixture notice is on screen");
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(overflow <= 0, `${width} ${scheme}: horizontal overflow ${overflow}px`);
    const nodes = await page.locator("[data-node]").count();
    assert.ok(nodes >= (layout === "canvas" ? 13 : 7), `${width} ${scheme}: ${nodes} nodes`);
    assert.ok(await page.locator("[data-event]").count() >= 10, "the event list is there");
    if (layout === "canvas") for (const text of ["调度板", "通知包", "使用者", "Leader"]) assert.ok(await page.getByText(text).first().isVisible(), text);
    if (shots) await page.screenshot({ path: `${shots}/flow-${width}-${scheme}.png`, fullPage: true });
    await context.close();
  }
});

test("reduced motion: no flowing packet and no animation element; the node flashes and the list still follows", { skip }, async t => {
  const { browser, base } = await launch(t);
  const { context, page } = await open(browser, base, 1440, 900, "light", "reduce");
  await page.getByRole("slider").fill("3");
  const before = await page.locator("[data-event]").count();
  await page.getByRole("button", { name: /回放/ }).click();
  await page.waitForTimeout(2600);
  assert.equal(await page.locator("animateMotion, [data-packet]").count(), 0, "nothing flows");
  assert.ok(await page.locator("[data-event]").count() > before, "the list still follows the replay");
  await context.close();
});

test("motion on: packets flow, never more than the cap at once; filters and 'only stuck' change the list and the counts", { skip }, async t => {
  const { browser, base } = await launch(t);
  const { context, page } = await open(browser, base, 1440, 900, "light", "no-preference");
  await page.getByRole("slider").fill("0");
  await page.getByRole("button", { name: /回放/ }).click();
  let most = 0, flowed = 0;
  for (let i = 0; i < 12; i++) { await page.waitForTimeout(500); const n = await page.locator("[data-packet]").count(); most = Math.max(most, n); flowed += n > 0 ? 1 : 0; }
  assert.ok(flowed > 0, "packets were drawn while replaying");
  assert.ok(most <= 12, `at most 12 packets at once (saw ${most})`);
  await page.getByRole("button", { name: "暂停" }).click();
  const all = await page.locator("[data-event]").count();
  await page.getByRole("button", { name: "只看卡住的" }).click();
  const stuck = await page.locator("[data-event]").count();
  assert.ok(stuck > 0 && stuck < all, `only stuck: ${stuck} of ${all}`);
  await page.getByRole("button", { name: "只看卡住的" }).click();
  await page.getByRole("button", { name: "消息", exact: true }).click();
  assert.ok(await page.locator("[data-event]").count() < all, "hiding a group removes its events from the list");
  await context.close();
});

test("the keyboard reaches every node and every event row, Enter opens the detail, and no long task runs while the picture replays", { skip }, async t => {
  const { browser, base } = await launch(t);
  const { context, page } = await open(browser, base, 1440, 900, "light", "no-preference");
  await page.evaluate(() => { (window as any).__long = 0; new PerformanceObserver(list => { (window as any).__long += list.getEntries().length; }).observe({ entryTypes: ["longtask"] }); });
  const want = new Set<string>();
  for (const key of await page.locator("[data-node]").evaluateAll(els => els.map(el => `n:${el.getAttribute("data-node")}`))) want.add(key);
  for (const key of await page.locator("[data-event]").evaluateAll(els => els.map(el => `e:${el.getAttribute("data-event")}`))) want.add(key);
  const reached = new Set<string>();
  await page.mouse.click(5, 5);
  for (let step = 0; step < 160 && reached.size < want.size; step++) {
    await page.keyboard.press("Tab");
    const key = await page.evaluate(() => { const el = document.activeElement as HTMLElement | null; return el?.getAttribute("data-node") ? `n:${el.getAttribute("data-node")}` : el?.getAttribute("data-event") ? `e:${el.getAttribute("data-event")}` : null; });
    if (key) reached.add(key);
  }
  const missing = [...want].filter(key => !reached.has(key));
  assert.deepEqual(missing, [], "every node and event row is reachable by Tab");
  await page.locator("[data-event]").first().focus();
  await page.keyboard.press("Enter");
  assert.ok(await page.getByLabel("事件详情").isVisible(), "Enter opens the event detail");
  await page.getByRole("slider").fill("0");
  await page.getByRole("button", { name: /回放/ }).click();
  await page.waitForTimeout(8000);
  const long = await page.evaluate(() => (window as any).__long as number);
  assert.equal(long, 0, "no main-thread task over 50 ms while replaying 8 s on the fixture");
  await context.close();
});

test("a tab in the background does not advance the replay or draw packets; coming back shows the state of the events up to the cursor", { skip }, async t => {
  const { browser, base } = await launch(t);
  const { context, page } = await open(browser, base, 1440, 900, "light", "no-preference");
  await page.getByRole("slider").fill("2");
  const before = await page.locator("[data-event]").count();
  await page.evaluate(String.raw`Object.defineProperty(document, "hidden", { configurable: true, get: () => true })`);
  await page.getByRole("button", { name: /回放/ }).click();
  await page.waitForTimeout(2500);
  assert.equal(await page.locator("[data-event]").count(), before, "nothing advanced while hidden");
  assert.equal(await page.locator("[data-packet]").count(), 0, "no packet was drawn while hidden");
  await page.evaluate(String.raw`Object.defineProperty(document, "hidden", { configurable: true, get: () => false })`);
  await page.waitForTimeout(2000);
  assert.ok(await page.locator("[data-event]").count() > before, "back in front the replay continues from where it was");
  await context.close();
});
