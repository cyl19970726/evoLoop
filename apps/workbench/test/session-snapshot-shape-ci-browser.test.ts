// Task c3a8e5d1, in a real browser over the built workbench: a Session snapshot with a list, the resource block or the metadata block null or of the wrong type must not take the
// Session page into the error boundary. Found by sending each top-level field of the snapshot as null and as a wrong type (nine of them broke the page: assignments, roleTasks,
// queue, results, questions, resources, metadata). The page now shows the conversation and says the snapshot was incomplete. Needs EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE.
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
const FIELDS = ["assignments", "roleTasks", "queue", "results", "questions", "activity", "resources", "metadata"] as const;

test("a Session snapshot with a field null or of the wrong type never takes the Session page into the error boundary", { skip }, async t => {
  assert.ok(modulePath, "EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE is required when EVOLOOP_BROWSER_TEST_REQUIRED=1");
  const { chromium } = (await import(pathToFileURL(modulePath).href)).default;
  const { startFixtureServer } = await import(pathToFileURL(`${frontend}/fixture/server.mjs`).href);
  const { token } = await import(pathToFileURL(`${frontend}/fixture/common.mjs`).href);
  const { scenes } = await import(pathToFileURL(`${frontend}/pages.mjs`).href);
  const scene = scenes.find((candidate: { name: string }) => candidate.name === "agent");
  assert.ok(scene, "scene agent");
  const fixture = await startFixtureServer(dist); t.after(() => fixture.close());
  const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) }); t.after(() => browser.close());
  const failures: string[] = [];
  for (const field of FIELDS) for (const [label, bad] of [["null", null], ["wrong type", field === "resources" || field === "metadata" ? [] : {}]] as const) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "zh-CN" });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.route(/\/session-work\/owned%3A[^/?]+$/, async route => {
      const response = await route.fetch(); const body = await response.json();
      await route.fulfill({ response, body: JSON.stringify({ ...body, [field]: bad }) });
    });
    await page.goto(`${fixture.base}${scene.path}`);
    await page.getByLabel("访问令牌").fill(token); await page.getByRole("button", { name: "进入", exact: true }).click();
    await page.waitForTimeout(3500);
    const text = await page.locator("body").innerText();
    if (/这一页显示出错/.test(text)) failures.push(`${field}=${label}: error boundary (${errors[0] ?? "no page error"})`);
    else if (!text.includes("已核对：1024 下右栏默认收起")) failures.push(`${field}=${label}: the conversation is not on the page`);
    await context.close();
  }
  assert.deepEqual(failures, [], "no field takes the page into the boundary, and the conversation stays");
});
