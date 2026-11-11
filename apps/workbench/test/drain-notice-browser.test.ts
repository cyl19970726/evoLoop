// Opt-in built-app regression (build the workbench, then set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE): while the instance is
// being drained for a release, every project page says so, what is still in flight and when it is safe to stop.
import assert from "node:assert/strict";
import { test } from "node:test";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const modulePath = process.env.EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE;
const dist = resolve(import.meta.dirname, "../dist");
const fixtureDir = resolve(import.meta.dirname, "../../../scripts/frontend/fixture");

test("the page names a draining and a drained instance and says nothing otherwise", { skip: !modulePath && "Set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE after building the workbench" }, async t => {
  const { chromium } = (await import(pathToFileURL(modulePath!).href)).default;
  const { startFixtureServer } = await import(pathToFileURL(`${fixtureDir}/server.mjs`).href);
  const { projectId, token } = await import(pathToFileURL(`${fixtureDir}/common.mjs`).href);
  const fixture = await startFixtureServer(dist); t.after(() => fixture.close());
  const browser = await chromium.launch({ headless: true }); t.after(() => browser.close());
  const view = (state: string, total: number) => ({ state, holding: state !== "active", version: 2, actorId: "target-owner", reason: "发布 0dd0baa", changedAt: "2026-11-11T02:00:00.000Z",
    queued: { runs: 1, messages: 8 }, inFlight: { runs: [], messageTurns: [], counts: { runs: Math.min(total, 3), messageTurns: Math.max(total - 3, 0), total } }, safeToStop: state === "drained", observedAt: "2026-11-11T02:01:00.000Z", maintainer: false });
  for (const [state, total, expected] of [["draining", 5, /实例排空中：不再启动新的 Run 和消息 Turn[\s\S]*还有 5 项在途（3 个 Run、2 个消息 Turn）/], ["drained", 0, /实例已排空，可以停服：没有在途的 Run 和消息 Turn/], ["active", 0, null]] as const) {
    const page = await (await browser.newContext({ viewport: { width: 1195, height: 900 } })).newPage();
    const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
    await page.route("**/api/instance/drain", route => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(view(state, total)) }));
    await page.goto(`${fixture.base}/#/p/${projectId}/work`);
    await page.getByLabel("访问令牌").fill(token);
    await page.getByRole("button", { name: "进入", exact: true }).click();
    await page.getByRole("heading", { name: "任务", exact: true }).first().waitFor();
    if (expected) {
      const notice = page.getByText(expected).first();
      await notice.waitFor();
      assert.match(await page.locator("body").textContent() ?? "", /target-owner 于 .* 开启：发布 0dd0baa/, "who, when and why are on the page (under the notice's details)");
    } else {
      await page.waitForTimeout(500);
      assert.equal(await page.getByText(/实例排空中|实例已排空/).count(), 0, "an active instance shows no drain notice");
    }
    assert.deepEqual(errors, []);
  }
});
