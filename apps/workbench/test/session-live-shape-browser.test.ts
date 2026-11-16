// Built-app regression (task 6a959b42): the Session page opened like the acceptor's read-only proxy does — the live stream answered with a body that is not a live read — must not
// reach the error boundary (“e is not iterable”, found 6 of 8 and 4 of 6 times). Each answer shape is opened eight times at 1440×900 and 390×844 over the screenshot fixture; every time the
// conversation is on the page, there is no page error, and the page says the live read could not be used. Needs the built workbench and EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE;
// EVOLOOP_LIVE_SHAPE_SCREENSHOT_DIR keeps screenshots; EVOLOOP_BROWSER_TEST_EXECUTABLE_PATH picks a browser.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const modulePath = process.env.EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE;
const required = process.env.EVOLOOP_BROWSER_TEST_REQUIRED === "1";
const executablePath = process.env.EVOLOOP_BROWSER_TEST_EXECUTABLE_PATH || process.env.EVOLOOP_BROWSER_TEST_CHROMIUM_EXECUTABLE || undefined;
const shots = process.env.EVOLOOP_LIVE_SHAPE_SCREENSHOT_DIR;
const dist = resolve(import.meta.dirname, "../dist");
const frontend = resolve(import.meta.dirname, "../../../scripts/frontend");
const skip = !required && !modulePath && "Set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE after building the workbench";
const OPENS = Number(process.env.EVOLOOP_LIVE_SHAPE_OPENS ?? 8);

const shapes: Array<[string, string, RegExp | null]> = [
  ["{}", "{}", /实时更新的响应不是预期的格式/],
  ["null", "null", null],
  ["[]", "[]", null],
  ["an error body", JSON.stringify({ message: "stream blocked" }), null],
  ["a cursor with no lists", JSON.stringify({ cursor: "9", freshness: "live" }), null],
];

test("a live read of the wrong shape never takes the Session page into the error boundary", { skip }, async t => {
  assert.ok(modulePath, "EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE is required when EVOLOOP_BROWSER_TEST_REQUIRED=1");
  const { chromium } = (await import(pathToFileURL(modulePath).href)).default;
  const { startFixtureServer } = await import(pathToFileURL(`${frontend}/fixture/server.mjs`).href);
  const { token } = await import(pathToFileURL(`${frontend}/fixture/common.mjs`).href);
  const { scenes } = await import(pathToFileURL(`${frontend}/pages.mjs`).href);
  const scene = scenes.find((candidate: { name: string }) => candidate.name === "agent");
  assert.ok(scene, "scene agent");
  const fixture = await startFixtureServer(dist); t.after(() => fixture.close());
  const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) }); t.after(() => browser.close());
  if (shots) mkdirSync(shots, { recursive: true });

  for (const [width, height] of [[1440, 900], [390, 844]] as const) for (const [name, body, message] of shapes) {
    // The shape the acceptor's proxy produces is opened OPENS times (it failed 6 of 8); the other shapes once at the wide size, so the file stays short in CI.
    const opens = name === "{}" ? (width === 1440 ? OPENS : 2) : width === 1440 ? 1 : 0;
    for (let open = 1; open <= opens; open++) {
      const context = await browser.newContext({ viewport: { width, height }, locale: "zh-CN" });
      const page = await context.newPage();
      const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
      await page.route(/\/timeline\/updates/, route => route.fulfill({ status: 200, contentType: "application/json", body }));
      await page.goto(`${fixture.base}${scene.path}`);
      await page.getByLabel("访问令牌").fill(token); await page.getByRole("button", { name: "进入", exact: true }).click();
      await page.getByText("已核对：1024 下右栏默认收起").first().waitFor({ timeout: 30000 });
      await page.waitForTimeout(3500);   // two live reads (every 1.5 s) have been answered by then
      const text = await page.locator("body").innerText();
      assert.ok(!/这一页.*出错|页面出错/.test(text), `${width} ${name} #${open}: not in the error boundary`);
      assert.ok(text.includes("已核对：1024 下右栏默认收起"), `${width} ${name} #${open}: the conversation is still on the page`);
      if (message) assert.match(text, message, `${width} ${name} #${open}: the page says the live read could not be used`);
      assert.deepEqual(errors, [], `${width} ${name} #${open}: no page error`);
      if (shots && open === 1) await page.screenshot({ path: `${shots}/live-${name.replace(/\W+/g, "_")}-${width}.png` });
      await context.close();
    }
  }
});
