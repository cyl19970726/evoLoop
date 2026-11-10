// Opt-in built-app regression (build the workbench, then set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE): 日程 lists the
// timed Tasks beside the schedule definitions, a timed Task opens with “返回日程：<名称>”, and the way back lands on the
// same item. Uses the screenshot fixture server (scripts/frontend/fixture), which only answers reads.
import assert from "node:assert/strict";
import { test } from "node:test";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const modulePath = process.env.EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE;
const dist = resolve(import.meta.dirname, "../dist");
const fixtureDir = resolve(import.meta.dirname, "../../../scripts/frontend/fixture");

test("日程 lists one-time, daily and stopped timed Tasks, opens one with the way back, and lands on it again",
  { skip: !modulePath && "Set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE after building the workbench" }, async t => {
  const { chromium } = (await import(pathToFileURL(modulePath!).href)).default;
  const { startFixtureServer } = await import(pathToFileURL(`${fixtureDir}/server.mjs`).href);
  const { projectId, token } = await import(pathToFileURL(`${fixtureDir}/common.mjs`).href);
  const fixture = await startFixtureServer(dist); t.after(() => fixture.close());
  const browser = await chromium.launch({ headless: true }); t.after(() => browser.close());
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    const page = await browser.newPage({ viewport }); t.after(() => page.close());
    const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
    await page.goto(`${fixture.base}/#/p/${projectId}/schedules`);
    await page.getByLabel("访问令牌").fill(token);
    await page.getByRole("button", { name: "进入", exact: true }).click();
    const section = page.getByRole("region", { name: "定时任务" });
    await section.getByText("页面截图由脚本生成").first().waitFor();
    const text = await section.innerText();
    for (const expected of ["一次定时", "每日重复", "进行中", "已停止", "已停止，不再复制后续时点", "验收新版外壳 · 进行中", "汇总试用反馈 · 已完成"]) assert.ok(text.includes(expected), `${viewport.width}: ${expected}`);
    assert.ok(!text.includes("右栏信息核对"), "a Task without timing does not appear");
    assert.equal(await section.locator("form, input, textarea").count(), 0, "no edit form on 日程");
    await section.getByRole("link", { name: "验收新版外壳" }).first().click();
    const back = page.getByRole("link", { name: "返回日程：验收新版外壳" }).first();
    await back.waitFor();
    await back.click();
    await page.getByRole("region", { name: "定时任务" }).waitFor();
    assert.match(page.url(), /\/schedules\?timing=/);
    assert.equal(await page.locator("li[id^='timing-']").filter({ hasText: "验收新版外壳" }).isVisible(), true, "lands on the item it came from");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${viewport.width}: no horizontal overflow`);
    assert.deepEqual(errors, []);
  }
});
