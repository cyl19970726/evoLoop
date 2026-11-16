// Built-app regression (task f2c9a6d1), two places where the page said something other than the facts:
// 1. 分工与运行 › 执行服务 said only 已接通 while the service held an error and faults (`available` is true then). It now says both, lists the faults and links to the agent.
//    With no fault it reads as before.
// 2. The 已验收 node detail of 统筹安排 › 动态 told the reader to pick “已关闭” in the task list, a filter that does not exist. It now names the real one (已完成) and links to it.
// Over the screenshot fixture (scripts/frontend/fixture); the runtime read and the work board are answered by the test through page.route. Needs the built workbench and
// EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE; EVOLOOP_FAULT_SCREENSHOT_DIR keeps screenshots; EVOLOOP_BROWSER_TEST_EXECUTABLE_PATH picks a browser.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const modulePath = process.env.EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE;
const required = process.env.EVOLOOP_BROWSER_TEST_REQUIRED === "1";
const executablePath = process.env.EVOLOOP_BROWSER_TEST_EXECUTABLE_PATH || process.env.EVOLOOP_BROWSER_TEST_CHROMIUM_EXECUTABLE || undefined;
const shots = process.env.EVOLOOP_FAULT_SCREENSHOT_DIR;
const dist = resolve(import.meta.dirname, "../dist");
const frontend = resolve(import.meta.dirname, "../../../scripts/frontend");
const skip = !required && !modulePath && "Set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE after building the workbench";

test("执行服务 shows the faults behind 已接通 and the 已验收 detail points at a filter that exists", { skip }, async t => {
  assert.ok(modulePath, "EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE is required when EVOLOOP_BROWSER_TEST_REQUIRED=1");
  const { chromium } = (await import(pathToFileURL(modulePath).href)).default;
  const { startFixtureServer } = await import(pathToFileURL(`${frontend}/fixture/server.mjs`).href);
  const { projectId, token } = await import(pathToFileURL(`${frontend}/fixture/common.mjs`).href);
  const { fixtureBoard, fixtureEvents } = await import("../src/features/sessions/flow/flowFixtures");
  const fixture = await startFixtureServer(dist); t.after(() => fixture.close());
  const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) }); t.after(() => browser.close());
  if (shots) mkdirSync(shots, { recursive: true });

  const runtimeBody = (faulty: boolean) => ({ available: true, allowedCwds: ["/srv/evoloop/workbench"], grants: [], ...(faulty
    ? { error: "会话归档尚未核实；保留原关闭意图，只读对账等待恢复。", faults: [{ sessionId: "7000000a-0000-4000-8000-00000000000a", runId: null, phase: "session_close", category: "native_rejected",
      message: "会话归档尚未核实；保留原关闭意图，只读对账等待恢复。", observedAtUtc: "2026-11-10T02:50:00.000Z", nativeMethod: "thread/archive" }] }
    : { error: null, faults: [] }) });
  const open = async (width: number, height: number, faulty: boolean) => {
    const context = await browser.newContext({ viewport: { width, height }, locale: "zh-CN" });
    const page = await context.newPage();
    const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
    await page.route(new RegExp(`/api/projects/${projectId}/runtime$`), route => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(runtimeBody(faulty)) }));
    return { context, page, errors };
  };
  const signIn = async (page: any, path: string, base: string) => {
    await page.goto(`${base}${path}`);
    await page.getByLabel("访问令牌").fill(token);
    await page.getByRole("button", { name: "进入", exact: true }).click();
  };

  for (const [width, height] of [[1440, 900], [390, 844]] as const) {
    // With a fault: 已接通 and the fault, side by side, and a way into the agent.
    {
      const { context, page, errors } = await open(width, height, true);
      await signIn(page, `/p/${projectId}/runtime`, fixture.base);
      const section = page.locator("section", { has: page.getByRole("heading", { name: "执行服务" }) }).first();
      await section.getByText("执行服务已接通").waitFor({ timeout: 30000 });
      const faults = page.getByTestId("runtime-faults");
      await faults.waitFor({ timeout: 15000 });
      const text = (await faults.innerText()).replace(/\s+/g, " ");
      assert.match(text, /有 1 条运行故障未清除/, `${width}: the count`);
      assert.match(text, /关闭智能体 · 原生服务拒绝/, `${width}: the fault's phase and category`);
      assert.match(text, /会话归档尚未核实/, `${width}: the service's own sentence`);
      const link = faults.getByRole("link", { name: "查看这个智能体" });
      assert.equal(await link.getAttribute("href"), `/p/${projectId}/runtime?session=7000000a-0000-4000-8000-00000000000a`, `${width}: links to that agent`);
      assert.ok((await section.innerText()).includes("执行服务已接通"), `${width}: still says it is connected`);
      assert.ok(/已接通，但有 1 条故障未清除/.test(await page.locator("body").innerText()) || width < 1100, `${width}: the facts line says it too where the panel is on the page`);
      assert.ok((await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)) <= 0, `${width}: no horizontal overflow`);
      assert.deepEqual(errors, []);
      if (shots) await page.screenshot({ path: `${shots}/runtime-fault-${width}.png`, fullPage: true });
      await context.close();
    }
    // Without: as before, no notice.
    {
      const { context, page, errors } = await open(width, height, false);
      await signIn(page, `/p/${projectId}/runtime`, fixture.base);
      const section = page.locator("section", { has: page.getByRole("heading", { name: "执行服务" }) }).first();
      await section.getByText("执行服务已接通").waitFor({ timeout: 30000 });
      assert.equal(await page.getByTestId("runtime-faults").count(), 0, `${width}: no fault notice when there is none`);
      assert.ok(!/故障未清除/.test(await page.locator("body").innerText()), `${width}: no fault wording anywhere`);
      assert.deepEqual(errors, []);
      if (shots) await page.screenshot({ path: `${shots}/runtime-clean-${width}.png`, fullPage: true });
      await context.close();
    }
  }

  // The 已验收 node: read the instruction on the live page, follow it, and find the closed task.
  for (const [width, height] of [[1440, 900], [390, 844]] as const) {
    const context = await browser.newContext({ viewport: { width, height }, locale: "zh-CN" });
    const page = await context.newPage();
    const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
    const board = { ...fixtureBoard, projectId };
    await page.route(new RegExp(`/api/projects/${projectId}/work-board(\\?.*)?$`), route => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(board) }));
    await page.route(new RegExp(`/api/projects/${projectId}/work-board/events`), route => route.fulfill({ status: 200, contentType: "application/json",
      body: JSON.stringify({ items: fixtureEvents, cursor: fixtureBoard.eventSeq, head: fixtureBoard.eventSeq }) }));
    await page.route(new RegExp(`/api/projects/${projectId}/work-board/stream`), route => route.fulfill({ status: 200, contentType: "text/event-stream", body: ": idle\n\n" }));
    await signIn(page, `/p/${projectId}/sessions?view=flow`, fixture.base);
    const node = page.locator('[data-node="station:已验收"]');
    await node.waitFor({ timeout: 30000 });
    await node.click();
    const detail = page.locator("[data-node-detail]");
    await detail.waitFor();
    const text = (await detail.innerText()).replace(/\s+/g, " ");
    assert.ok(!/选“已关闭”/.test(text), `${width}: no longer sends the reader to a filter that is not there (${text})`);
    assert.match(text, /“已完成”/, `${width}: names the real filter`);
    if (shots) await page.screenshot({ path: `${shots}/accepted-node-${width}.png`, fullPage: true });
    await detail.getByRole("link", { name: "打开已完成的任务" }).click();
    await page.getByText("汇总试用反馈").first().waitFor({ timeout: 30000 });   // the fixture's one closed task
    assert.match(page.url(), /\/work\?state=done/, `${width}: the link opens the list on that filter`);
    const body = await page.locator("body").innerText();
    assert.ok(body.includes("汇总试用反馈"), `${width}: the closed task is in the list`);
    assert.ok(!body.includes("页面截图由脚本生成"), `${width}: and the filter really filters (a todo task is not there)`);
    if (shots) await page.screenshot({ path: `${shots}/accepted-list-${width}.png`, fullPage: true });
    assert.deepEqual(errors, []);
    await context.close();
  }
});
