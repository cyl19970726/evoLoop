// Task c58b83e2: a rework link (?tab=delivery&delivery=ID&observation=ID) lands on the specific return opinion — it is marked and in view.
// Needs the built workbench and EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE (EVOLOOP_BROWSER_TEST_REQUIRED=1 in CI). Fixture only: FIXTURE_REWORK_OBS=1 adds one failed observation.
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

test("an observation link marks and scrolls to that return opinion; an unknown id marks nothing", { skip }, async t => {
  assert.ok(modulePath, "EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE is required when EVOLOOP_BROWSER_TEST_REQUIRED=1");
  process.env.FIXTURE_REWORK_OBS = "1"; t.after(() => { delete process.env.FIXTURE_REWORK_OBS; });
  const { chromium } = (await import(pathToFileURL(modulePath).href)).default;
  const { startFixtureServer } = await import(pathToFileURL(`${frontend}/fixture/server.mjs`).href);
  const { projectId, token } = await import(pathToFileURL(`${frontend}/fixture/common.mjs`).href);
  const { tasks, taskDetail } = await import(pathToFileURL(`${frontend}/fixture/work.mjs`).href);
  const fixture = await startFixtureServer(dist); t.after(() => fixture.close());
  const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) }); t.after(() => browser.close());
  const task = tasks.t1, detail = taskDetail(task);
  const deliveryId = detail.deliveries[0].id as string, observationId = detail.observations[0].id as string;
  for (const [observation, expectMarked] of [[observationId, true], ["00000000-0000-4000-8000-00000000dead", false]] as const) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 500 }, locale: "zh-CN", reducedMotion: "reduce" });
    const page = await context.newPage(); const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
    await page.goto(`${fixture.base}/p/${projectId}/tasks/${task.id}?tab=delivery&delivery=${deliveryId}&observation=${observation}`);
    await page.getByLabel("访问令牌").fill(token); await page.getByRole("button", { name: "进入", exact: true }).click();
    await page.getByRole("tab", { name: /^交付与使用/, selected: true }).waitFor();
    await page.locator("[data-observation]").first().waitFor();
    await page.waitForTimeout(500);
    assert.equal(await page.locator("[data-observation][data-observation-located]").count(), expectMarked ? 1 : 0);
    if (expectMarked) {
      assert.equal(await page.locator(`[data-observation="${observation}"][data-observation-located]`).count(), 1);
      const box = await page.locator(`[data-observation="${observation}"]`).boundingBox();
      assert.ok(box && box.y >= -1 && box.y < 500, `the return opinion is in view (y=${box?.y})`);
    }
    assert.deepEqual(errors, []);
    await context.close();
  }
});
