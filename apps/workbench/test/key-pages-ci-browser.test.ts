// Built-app regression that runs in CI (the `browser` job in .github/workflows/app.yml): the four pages a React hook-order
// mistake would take down — 总览, 任务列表, 任务详情 and 智能体详情 — each opened twice over the screenshot fixture:
// first with every project read held (the page is in its "reading" state and must not throw), then released
// (the page must read back into its real content). A hook placed after an early return passes the first state and
// throws React #310 at the switch to the second, which is the failure this guards (PR #386).
// Needs the built workbench and EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE; EVOLOOP_BROWSER_TEST_EXECUTABLE_PATH (or the older
// EVOLOOP_BROWSER_TEST_CHROMIUM_EXECUTABLE) points at a browser Playwright did not download itself. CI sets the module,
// so a missing module there is a failure, not a skip (EVOLOOP_BROWSER_TEST_REQUIRED=1).
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

// scene name in scripts/frontend/pages.mjs → text that shows while its reads are held (null: only "no content yet, no error")
const pages: Array<[string, string | null]> = [["overview", null], ["tasks", null], ["task", null], ["agent", "正在读取智能体…"]];

test("key pages read their way from 读取中 to the real content without a page error", { skip }, async t => {
  assert.ok(modulePath, "EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE is required when EVOLOOP_BROWSER_TEST_REQUIRED=1");
  const { chromium } = (await import(pathToFileURL(modulePath).href)).default;
  const { startFixtureServer } = await import(pathToFileURL(`${frontend}/fixture/server.mjs`).href);
  const { projectId, token } = await import(pathToFileURL(`${frontend}/fixture/common.mjs`).href);
  const { scenes } = await import(pathToFileURL(`${frontend}/pages.mjs`).href);
  const fixture = await startFixtureServer(dist); t.after(() => fixture.close());
  const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) }); t.after(() => browser.close());

  for (const [name, reading] of pages) {
    await t.test(name, async () => {
      const scene = scenes.find((candidate: { name: string }) => candidate.name === name);
      assert.ok(scene, `scene ${name} exists in scripts/frontend/pages.mjs`);
      const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "zh-CN" })).newPage();
      const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
      let release!: () => void; const gate = new Promise<void>(done => { release = done; });
      // The sign-in check is not a project read; everything under the project is held until released.
      await page.route(new RegExp(`/api/projects/${projectId}/`), async route => { await gate; await route.continue().catch(() => undefined); });
      await page.goto(`${fixture.base}${scene.path}`);
      await page.getByLabel("访问令牌").fill(token);
      await page.getByRole("button", { name: "进入", exact: true }).click();
      if (reading) await page.getByText(reading, { exact: true }).waitFor({ timeout: 15_000 });
      else await page.waitForTimeout(1_000);
      assert.deepEqual(errors, [], `${name}: no page error while the reads are held`);
      release();
      await scene.ready(page);
      assert.deepEqual(errors, [], `${name}: no page error after the reads come back`);
    });
  }
});
