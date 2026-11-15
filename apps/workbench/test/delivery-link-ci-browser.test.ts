// The dynamic view's delivery link (?tab=delivery&delivery=ID, DEC-045 F1 rework of observation a150a6e6) in a real browser over the screenshot fixture:
// it opens the Task on its 交付与使用 tab and marks and scrolls to that delivery; an id that is not one of the Task's deliveries marks nothing and breaks nothing.
// Needs the built workbench and EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE (EVOLOOP_BROWSER_TEST_REQUIRED=1 in CI).
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

test("a delivery link lands on the Task's 交付与使用 tab with that delivery marked and in view; an unknown delivery id marks nothing", { skip }, async t => {
  assert.ok(modulePath, "EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE is required when EVOLOOP_BROWSER_TEST_REQUIRED=1");
  const { chromium } = (await import(pathToFileURL(modulePath).href)).default;
  const { startFixtureServer } = await import(pathToFileURL(`${frontend}/fixture/server.mjs`).href);
  const { projectId, token } = await import(pathToFileURL(`${frontend}/fixture/common.mjs`).href);
  const { tasks, taskDetail } = await import(pathToFileURL(`${frontend}/fixture/work.mjs`).href);
  const fixture = await startFixtureServer(dist); t.after(() => fixture.close());
  const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) }); t.after(() => browser.close());
  const task = tasks.t1, deliveryId = taskDetail(task).deliveries[0].id as string;
  for (const [delivery, expectMarked] of [[deliveryId, true], ["00000000-0000-4000-8000-00000000dead", false]] as const) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 700 }, locale: "zh-CN", reducedMotion: "reduce" });
    const page = await context.newPage(); const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
    await page.goto(`${fixture.base}/p/${projectId}/tasks/${task.id}?tab=delivery&delivery=${delivery}`);
    await page.getByLabel("访问令牌").fill(token); await page.getByRole("button", { name: "进入", exact: true }).click();
    await page.getByRole("tab", { name: /^交付与使用/, selected: true }).waitFor();
    await page.locator("[data-delivery]").first().waitFor();
    await page.waitForTimeout(500);
    const marked = await page.locator(`[data-delivery="${delivery}"][data-delivery-located]`).count();
    assert.equal(marked, expectMarked ? 1 : 0, `delivery ${delivery}`);
    if (expectMarked) {
      const box = await page.locator(`[data-delivery="${delivery}"]`).boundingBox();
      assert.ok(box && box.y >= -1 && box.y < 700, `the delivery is in view (y=${box?.y})`);
    }
    assert.deepEqual(errors, []);
    await context.close();
  }
});
