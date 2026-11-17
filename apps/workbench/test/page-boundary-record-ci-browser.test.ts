// Task c3a8e5d1, in a real browser over the built workbench: a Session page that throws while rendering shows the page-error state with the message, the route, the build commit,
// the time and the component stack; the same text is copied by one button; and exactly the agreed fields (no Session text) are posted to the service, whose record the page
// names by its number. The throw is injected by replacing the Session page's chunk with one whose component throws. The service side (redaction, bounds, read-back) is tested in
// apps/coordinator/test/client-errors.test.ts and packages/adapter-postgres/test/client-render-error.test.ts. Needs EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const modulePath = process.env.EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE;
const required = process.env.EVOLOOP_BROWSER_TEST_REQUIRED === "1";
const executablePath = process.env.EVOLOOP_BROWSER_TEST_EXECUTABLE_PATH || process.env.EVOLOOP_BROWSER_TEST_CHROMIUM_EXECUTABLE || undefined;
const shots = process.env.EVOLOOP_BOUNDARY_SCREENSHOT_DIR;
const dist = resolve(import.meta.dirname, "../dist");
const frontend = resolve(import.meta.dirname, "../../../scripts/frontend");
const skip = !required && !modulePath && "Set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE after building the workbench";
const thrown = "TypeError: 注入：会话页渲染时抛出";

test("a Session page that throws shows its cause, copies it, and the service is handed exactly the agreed fields", { skip }, async t => {
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

  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "zh-CN" });
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: fixture.base });
  const page = await context.newPage();
  const posted: Array<{ path: string; body: Record<string, unknown> }> = [];
  const stored: Array<Record<string, unknown>> = [];
  await page.route(/\/assets\/SessionWorkspace-[^/]+\.js$/, async route => {
    const response = await route.fetch(); const source = await response.text();
    const replaced = source.replace(/export\s*\{\s*(\w+)\s+as\s+SessionWorkspace\s*,/, `const __broken=()=>{throw new TypeError("注入：会话页渲染时抛出")};export{__broken as SessionWorkspace,`);
    assert.notEqual(replaced, source, "the Session page's export was found and replaced");
    await route.fulfill({ response, body: replaced });
  });
  await page.route(/\/client-errors(\?|$)/, async route => {
    const request = route.request();
    if (request.method() === "POST") {
      const body = JSON.parse(request.postData() ?? "{}"); posted.push({ path: new URL(request.url()).pathname, body });
      const id = "00000000-0000-4000-8000-0000000000aa"; stored.unshift({ id, ...body });
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ id, recordedAt: new Date().toISOString(), duplicate: false }) });
    }
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ items: stored }) });
  });
  await page.goto(`${fixture.base}${scene.path}`);
  await page.getByLabel("访问令牌").fill(token); await page.getByRole("button", { name: "进入", exact: true }).click();
  await page.getByRole("heading", { name: "这一页显示出错" }).waitFor({ timeout: 30000 });
  await page.locator("[data-page-error] summary").click();
  await page.waitForFunction(() => /已记录，编号/.test(document.querySelector("[data-page-error-text]")?.textContent ?? ""), null, { timeout: 15000 });
  const text = await page.locator("[data-page-error-text]").innerText();
  assert.match(text, new RegExp(`错误信息：${thrown}`));
  assert.match(text, /路由：\/p\/[^?\s]+\/sessions\?session=/, "the route with its query");
  assert.match(text, /构建 commit：0{40}/, "the build commit the service reports");
  assert.match(text, /时间：\d{4}-\d{2}-\d{2}T/);
  assert.match(text, /服务端记录：已记录，编号 00000000-0000-4000-8000-0000000000aa/);
  assert.match(text, /组件栈：[\s\S]*\bat\b/, "the component stack");
  if (shots) await page.screenshot({ path: `${shots}/boundary-1440.png` });

  await page.locator("[data-page-error-copy]").click();
  await page.getByRole("button", { name: "已复制" }).waitFor();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), text, "the copy button puts the shown text on the clipboard");

  assert.equal(posted.length, 1, "one record is handed to the service");
  assert.match(posted[0]!.path, /^\/api\/projects\/[^/]+\/client-errors$/);
  assert.deepEqual(Object.keys(posted[0]!.body).sort(), ["commit", "componentStack", "message", "occurredAt", "route"], "exactly the agreed fields, nothing else");
  assert.ok(!JSON.stringify(posted[0]!.body).includes(token), "no token in what is posted");
  assert.ok(!/已核对：1024 下右栏默认收起/.test(JSON.stringify(posted[0]!.body)), "no Session text in what is posted");
  assert.equal(stored.length, 1);

  // Reading back needs no console and no page: the same record is listed.
  const listed = await page.evaluate(async (path: string) => (await fetch(path)).json(), `/api/projects/${posted[0]!.path.split("/")[3]}/client-errors`);
  assert.equal(listed.items[0].message, `${thrown}`);
});
