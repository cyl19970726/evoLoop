// Opt-in built-app regression: build workbench, then set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE.
// 统筹安排: the board, the right column's conflicts, links into Tasks and agents, and the narrow layout; then reads
// that are missing, failed, or failed again after an earlier answer.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { agents, id, inDays, internalWords, projectId, serve, stamp, tasks } from "./arrangement-fixture.ts";

const modulePath = process.env.EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE;
const shots = process.env.EVOLOOP_ARRANGEMENT_SCREENSHOT_DIR;
async function openBoard(t: { after: (fn: () => unknown) => void }, base: string) {
  const { chromium } = (await import(pathToFileURL(modulePath!).href)).default;
  const browser = await chromium.launch({ headless: true,
    executablePath: process.env.EVOLOOP_BROWSER_TEST_CHROMIUM_EXECUTABLE }); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(`${base}/p/${projectId}/arrangement`);
  await page.getByLabel("访问令牌").fill("fixture-token");
  await page.getByRole("button", { name: "进入", exact: true }).click();
  await page.getByRole("heading", { name: "统筹安排" }).waitFor();
  const board = page.getByRole("list", { name: "各智能体的安排" });
  await board.getByRole("link", { name: "前端实现" }).waitFor();
  return { page, board };
}

test("统筹安排 shows who works on what, the unassigned Tasks and the proven conflicts",
  { skip: !modulePath && "Set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE" }, async t => {
    const { base } = await serve(t);
    const { page, board } = await openBoard(t, base);
    await page.getByRole("region", { name: /没有承接者的任务/ }).waitFor();
    const rows = await board.locator(":scope > li").evaluateAll(items => items.map(item => item.querySelector("a")?.textContent));
    assert.deepEqual(rows, ["前端实现", "后端实现", "测试验收", "统筹", "文档整理"], "busiest first, free agents last");
    const frontend = board.locator(":scope > li").first();
    assert.match(await frontend.innerText(), /同时做 2 项/);
    assert.match(await frontend.innerText(), /新版任务页[\s\S]*P1/);
    const tester = board.locator(":scope > li").nth(2);
    assert.match(await tester.innerText(), /整理旧文档[\s\S]*第 1 位 · 暂停中/, "queued work shows under its agent");
    assert.match(await tester.getByRole("group", { name: "已分派" }).innerText(), /回归用例[\s\S]*待验收/);
    assert.doesNotMatch(await tester.getByRole("group", { name: "正在做" }).innerText(), /回归用例/,
      "a Task waiting for acceptance is not shown as being done, whatever the directory's current work says");
    const writer = board.locator(":scope > li").last();
    assert.doesNotMatch(await writer.innerText(), /新版文档页/, "entries of a queue not yet adopted are not queued work");
    const unassigned = page.getByRole("region", { name: /没有承接者的任务/ });
    const unassignedText = await unassigned.innerText();
    assert.match(unassignedText, /验收新版外壳[\s\S]*等验收者核对交付与实际使用[\s\S]*整理旧文档[\s\S]*等 Leader 指定承接的智能体/);
    assert.doesNotMatch(unassignedText, internalWords, "the server's next action for agents is not shown to people");
    assert.doesNotMatch(await page.locator(".arrangement-page").innerText(), internalWords);
    assert.doesNotMatch(await page.locator(".arrangement-page").innerText(), /智能体回报/);
    assert.match(await page.locator(".arrangement-page p", { hasText: "条待处理消息" }).innerText(),
      /项目里：3 条待处理消息 · 1 个待答问题 · 2 项待验收/, "the directory's project-wide counts stay visible");
    await page.getByRole("link", { name: "与 Leader 对话" }).waitFor();
    assert.equal(await page.getByRole("link", { name: "与 Leader 对话" }).getAttribute("href"),
      `/p/${projectId}/sessions?${new URLSearchParams({ session: `owned:${id(1)}`, return: `/p/${projectId}/arrangement`, actor: "reader" })}`,
      "the agent page offers 返回统筹安排");
    await page.getByText("系统还没有标出哪份文档是当前的编排总览").waitFor();

    const risks = page.getByRole("region", { name: "冲突与风险" });
    await risks.waitFor();
    assert.deepEqual(await risks.locator("li a").allTextContents(), [
      "前端实现 同时有 2 项进行中的任务",
      "「事件流接口」已开始，但依赖还没通过验收",
      "「验收新版外壳」待验收，但下一责任未登记",
      "「整理旧文档」已过截止时间",
    ]);
    assert.doesNotMatch(await risks.innerText(), internalWords);
    const idle = page.getByRole("region", { name: "空闲与过载" });
    assert.match(await idle.innerText(), /前端实现 · 同时做 2 项[\s\S]*文档整理[\s\S]*空闲/);
    assert.doesNotMatch(await idle.innerText(), /统筹/, "the Leader is not counted as free capacity");
    assert.match(await page.getByRole("region", { name: "截止临近" }).innerText(), /新版任务页/);
    assert.equal(await page.locator("[data-shell=frame] a[aria-current=page]", { hasText: "统筹安排" }).count(), 1,
      "the inner rail marks 统筹安排 as the current item");
    if (shots) await page.screenshot({ path: `${shots}/arrangement-1440.png` });

    // A Task link opens the Task; back returns to the board.
    await board.getByRole("link", { name: "事件流接口" }).click();
    await page.waitForURL(new RegExp(`/p/${projectId}/tasks`));
    await page.goBack();
    await page.getByRole("heading", { name: "统筹安排" }).waitFor();
    assert.equal(await page.getByRole("heading", { name: "统筹安排" }).isVisible(), true);

    await page.setViewportSize({ width: 1024, height: 800 });
    await page.getByRole("region", { name: "冲突与风险" }).waitFor({ state: "hidden" });
    if (shots) await page.screenshot({ path: `${shots}/arrangement-1024.png` });
    await page.getByRole("button", { name: /个冲突与风险/ }).click();
    await page.getByRole("region", { name: "冲突与风险" }).waitFor({ state: "visible" });
    if (shots) { await page.waitForTimeout(400); await page.screenshot({ path: `${shots}/arrangement-1024-panel.png` }); }
    await page.keyboard.press("Escape");

    await page.setViewportSize({ width: 390, height: 844 });
    const main = page.locator(".arrangement-page");
    assert.equal(await main.evaluate(element => element.scrollWidth <= element.clientWidth + 1), true, "no horizontal overflow at 390px");
    const narrowFirst = await board.locator(":scope > li").first().innerText();
    assert.match(narrowFirst, /正在做[\s\S]*新版任务页/, "narrow rows label each column");
    assert.doesNotMatch(narrowFirst, /已分派|排队/, "empty columns are left out on narrow widths");
    assert.match(await board.locator(":scope > li").last().innerText(), /没有在做、分派或排队的工作/);
    if (shots) await page.screenshot({ path: `${shots}/arrangement-390.png`, fullPage: true });
  });

test("统筹安排 does not conclude from reads that are missing, failed, or kept from before",
  { skip: !modulePath && "Set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE" }, async t => {
    const { base, fail } = await serve(t, { tasks: true, queues: true });
    const { page, board } = await openBoard(t, base);
    const stats = page.getByLabel("概况");
    const risks = page.getByRole("region", { name: "冲突与风险" });
    const idle = page.getByRole("region", { name: "空闲与过载" });
    const tester = board.locator(":scope > li").filter({ hasText: "测试验收" });

    // Neither Tasks nor queues can be read.
    await page.getByText("任务暂不可读取", { exact: true }).waitFor();
    await page.getByText("队列暂不可读取", { exact: true }).waitFor();
    const failedStats = await stats.innerText();
    assert.match(failedStats, /无法判断\s*谁空闲/);
    assert.doesNotMatch(failedStats, /0\s*个智能体空闲/);
    assert.match(failedStats, /\?\s*项任务没有承接者/);
    assert.match(failedStats, /\?\s*个冲突与风险/);
    assert.match(await risks.innerText(), /任务暂不可读取，无法判断冲突/);
    assert.doesNotMatch(await risks.innerText(), /没有看出冲突/);
    assert.match(await idle.innerText(), /无法判断谁空闲/);
    assert.doesNotMatch(await idle.innerText(), /文档整理/, "an agent is not free because its work could not be read");
    assert.equal(await page.getByRole("region", { name: /没有承接者的任务/ }).count(), 0, "no list of unassigned Tasks from nothing");
    assert.match(await tester.getByRole("group", { name: "已分派" }).innerText(),
      /回归用例[\s\S]*智能体目录记录：已接手 · 阶段未读取/, "the directory's current work stands in, with its source");
    assert.doesNotMatch(await tester.getByRole("group", { name: "正在做" }).innerText(), /回归用例/);
    assert.match(await tester.getByRole("group", { name: "排队" }).innerText(), /队列未读取/);
    assert.doesNotMatch(await page.locator(".arrangement-page").innerText(), /智能体回报/);
    if (shots) await page.screenshot({ path: `${shots}/arrangement-failed-1440.png` });

    // Tasks come back, queues still fail: conflicts can be judged, free capacity still cannot.
    fail.tasks = false;
    await page.locator(".arrangement-page > header").getByRole("button", { name: "重新读取" }).click();
    await page.getByRole("region", { name: /没有承接者的任务/ }).waitFor();
    await risks.locator("li").first().waitFor();
    // While the queues are reread they are 正在读取; once the retries fail they are 暂不可读取. Neither is free.
    assert.match(await idle.innerText(), /正在读取队列，暂不能判断谁空闲|队列暂不可读取，无法确认谁空闲/);
    await idle.getByText("队列暂不可读取，无法确认谁空闲。").waitFor();
    assert.doesNotMatch(await idle.innerText(), /文档整理/);
    assert.match(await stats.innerText(), /无法判断\s*谁空闲/);
    assert.match(await stats.innerText(), /2\s*项任务没有承接者/);
    assert.match(await page.getByRole("region", { name: /没有承接者的任务/ }).innerText(), /队列还没读到/);
    assert.doesNotMatch(await tester.innerText(), /智能体目录记录/, "with Tasks read, the directory's current work is not used");

    // Queues come back, then a Task reread fails: the previous Tasks stay, labelled, with no contradicting notice.
    fail.queues = false;
    await page.locator(".arrangement-page > header").getByRole("button", { name: "重新读取" }).click();
    await idle.getByText("空闲", { exact: true }).waitFor();
    fail.tasks = true;
    await page.locator(".arrangement-page > header").getByRole("button", { name: "重新读取" }).click();
    await page.getByText("任务重新读取失败 · 上次读回，当前待核对").waitFor();
    const pageText = await page.locator(".arrangement-page").innerText();
    assert.doesNotMatch(pageText, /任务暂不可读取|任务未读取|智能体目录记录/, "a kept answer is not described as missing");
    assert.match(await stats.innerText(), /项任务没有承接者 · 上次读回/);
    assert.match(await page.locator(".arrangement-panel").innerText(), /上次读回，当前待核对/);
    assert.match(await risks.innerText(), /前端实现 同时有 2 项进行中的任务/);
    if (shots) await page.screenshot({ path: `${shots}/arrangement-stale-1440.png` });
  });
