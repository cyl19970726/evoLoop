// Opt-in built-app regression (Task 1aeed4a2): on a 390-wide screen the Team pages show their five sub-pages in the page itself, and the wide frame
// keeps its rail unchanged. Uses the synthetic fixture API (scripts/frontend/fixture). Needs the built workbench and EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE;
// EVOLOOP_TEAM_SCREENSHOT_DIR=<dir> saves the screenshots.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const modulePath = process.env.EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE;
const shots = process.env.EVOLOOP_TEAM_SCREENSHOT_DIR;
const dist = resolve(import.meta.dirname, "../dist");
const fixtureDir = resolve(import.meta.dirname, "../../../scripts/frontend/fixture");
const skip = !modulePath && "Set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE after building the workbench";
const pages: Array<[string, string]> = [["runtime", "分工与运行"], ["roles", "职责"], ["discussions", "分工讨论"], ["reviews", "组织复盘"], ["collaboration", "协作回执"]];

test("390 wide: every Team page lists the five sub-pages in itself, marks the current one, wraps without sideways scroll and navigates; 1440 keeps the rail and adds nothing", { skip }, async t => {
  const { chromium } = (await import(pathToFileURL(modulePath!).href)).default;
  const { startFixtureServer } = await import(pathToFileURL(`${fixtureDir}/server.mjs`).href);
  const { projectId, token } = await import(pathToFileURL(`${fixtureDir}/common.mjs`).href);
  const fixture = await startFixtureServer(dist); t.after(() => fixture.close());
  const browser = await chromium.launch({ headless: true, ...(process.env.EVOLOOP_BROWSER_TEST_EXECUTABLE_PATH ? { executablePath: process.env.EVOLOOP_BROWSER_TEST_EXECUTABLE_PATH } : {}) }); t.after(() => browser.close());
  if (shots) mkdirSync(shots, { recursive: true });
  const open = async (width: number, height: number, scheme: "light" | "dark", section: string) => {
    const context = await browser.newContext({ viewport: { width, height }, locale: "zh-CN" });
    const page = await context.newPage();
    const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
    await page.goto(`${fixture.base}/p/${projectId}/${section}`);
    await page.getByLabel("访问令牌").fill(token); await page.getByRole("button", { name: "进入", exact: true }).click();
    await page.locator("#workspace-main").waitFor({ timeout: 30000 });
    await page.evaluate((mode: string) => { document.documentElement.dataset.theme = mode; }, scheme);
    return { page, context, errors };
  };
  for (const scheme of ["light", "dark"] as const) for (const [section, label] of pages) {
    const { page, context, errors } = await open(390, 844, scheme, section);
    const nav = page.getByRole("navigation", { name: "团队子页" });
    await nav.waitFor({ timeout: 30000 });
    const links = await nav.locator("a").evaluateAll((els: Element[]) => els.map(el => ({ text: el.textContent!.trim(), current: el.getAttribute("aria-current"), href: el.getAttribute("href") })));
    assert.deepEqual(links.map(l => l.text), ["分工与运行", "职责", "分工讨论", "组织复盘", "协作回执"], `${section} ${scheme}: all five sub-pages are listed`);
    assert.deepEqual(links.filter(l => l.current === "page").map(l => l.text), [label], `${section} ${scheme}: exactly the current one is marked`);
    assert.ok((await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)) <= 0, `${section} ${scheme}: no sideways scroll`);
    assert.deepEqual(errors, []);
    if (shots && scheme === "light" || shots && section === "runtime") await page.screenshot({ path: `${shots}/team-390-${section}-${scheme}-after.png`, fullPage: false });
    if (section === "runtime" && scheme === "light") {   // navigating from the strip reaches the page
      await nav.getByRole("link", { name: "协作回执", exact: true }).click();
      await page.waitForURL(/\/collaboration/, { timeout: 15000 });
      assert.equal(await page.getByRole("navigation", { name: "团队子页" }).locator("a[aria-current=page]").innerText(), "协作回执", "the strip follows the page after navigating");
    }
    await context.close();
  }
  // Wide: the rail still lists them, and the page has no strip of its own.
  for (const [section, label] of pages) {
    const { page, context } = await open(1440, 900, "light", section);
    await page.locator("aside[aria-label=项目导航]").waitFor({ timeout: 30000 });
    assert.equal(await page.getByRole("navigation", { name: "团队子页" }).count(), 0, `${section}: no page strip on the wide frame`);
    for (const [, name] of pages) assert.ok(await page.locator("aside[aria-label=项目导航]").getByRole("link", { name, exact: true }).count() >= 1, `${section}: the rail lists ${name}`);
    assert.equal(await page.locator("aside[aria-label=项目导航] a[aria-current=page]").filter({ hasText: label }).count(), 1);
    if (shots && section === "runtime") await page.screenshot({ path: `${shots}/team-1440-runtime-after.png` });
    await context.close();
  }
  // Other sections are not touched: no strip on the task list at 390.
  const other = await open(390, 844, "light", "work");
  assert.equal(await other.page.getByRole("navigation", { name: "团队子页" }).count(), 0);
  await other.context.close();
});
