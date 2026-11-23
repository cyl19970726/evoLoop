// Stage close-out (Task 523938fb). Without a browser: the old milestones block, its address and its API are gone from the code, and no screenshot test writes
// through an unset path. In the built app (needs EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE; EVOLOOP_CLOSEOUT_SCREENSHOT_DIR keeps the shots): the folded ladder row
// is one line of numbers and marks, and the two left columns read "短名 · 到期日" with a long name cut and the date still inside the column.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

const modulePath = process.env.EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE;
const required = process.env.EVOLOOP_BROWSER_TEST_REQUIRED === "1";
const shots = process.env.EVOLOOP_CLOSEOUT_SCREENSHOT_DIR;
const repo = resolve(import.meta.dirname, "../../..");
const skip = !required && !modulePath && "Set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE after building the workbench";
type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any

test("the old milestones block, its API and its address are gone from the repository", () => {
  const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: repo, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).split("\0").filter(Boolean);
  // Documents that explain the history of the block keep its name.
  const history = [/^docs\/frontend\/overview-top-design\.md$/, /^docs\/frontend\/milestones-design\.md$/, /^docs\/assets\/frontend-pages\/design\//, /^docs\/research\//,
    /^apps\/workbench\/test\/(stage-closeout|stages)-ci-browser\.test\.ts$/];
  const hits: string[] = [];
  for (const file of tracked) {
    if (!/\.(tsx?|mjs|js|md|json|html)$/.test(file) || history.some(pattern => pattern.test(file))) continue;
    let text: string; try { text = readFileSync(resolve(repo, file), "utf8"); } catch { continue; }
    for (const word of ["LegacyMilestones", "api().milestones", "重要里程碑", "milestoneRows", "buildMilestones", "MilestonesView"]) if (text.includes(word)) hits.push(`${file}: ${word}`);
    if (/\/api\/projects\/[^\s"'`]*(?<!stages)\/milestones\b(?!\/)/.test(text) || /projectPath\([^)]*\)\}\/milestones\b/.test(text)) hits.push(`${file}: the old /milestones address`);
  }
  assert.deepEqual(hits, []);
});

test("no screenshot is written outside its directory variable: every page.screenshot in a browser test sits under an EVOLOOP_*_DIR check", () => {
  const completion = readFileSync(resolve(repo, "apps/workbench/test/task-completion-boundary-browser.test.ts"), "utf8");
  for (const line of completion.split("\n").filter(item => item.includes("page.screenshot"))) {
    assert.match(line, /if \(process\.env\.EVOLOOP_COMPLETION_SCREENSHOT_DIR\) \{.*page\.screenshot.*\}\s*$/, line);
  }
});

test("close-out: folded ladder row and the two left columns", { skip }, async t => {
  assert.ok(modulePath, "EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE is required when EVOLOOP_BROWSER_TEST_REQUIRED=1");
  const { projectId, token } = await import(pathToFileURL(resolve(repo, "scripts/frontend/fixture/common.mjs")).href);
  const { startFixtureServer } = await import(pathToFileURL(resolve(repo, "scripts/frontend/fixture/server.mjs")).href);
  const { chromium } = (await import(pathToFileURL(modulePath!).href)).default;
  const fx = await startFixtureServer(resolve(import.meta.dirname, "../dist")); t.after(() => fx.close());
  const executablePath = process.env.EVOLOOP_BROWSER_TEST_EXECUTABLE_PATH || process.env.EVOLOOP_BROWSER_TEST_CHROMIUM_EXECUTABLE || undefined;
  const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) }); t.after(() => browser.close());
  const errors: string[] = [];
  const api = `**/api/projects/${projectId}`;

  const name24 = "第二个项目接入试用与对外说明第二轮第三轮第四轮五"; // exactly 24
  assert.equal([...name24].length, 24);
  const sentence = (key: string) => `${key} 级的状态整句：这一级在路线图状态表里写了足够长的一整句说明，超过三十个字，折叠时一个字也不应该出现。`;
  const levels = ["M0", "M0.5", "M1", "M2", "M3", "M4"].map((key, index) => ({ key, name: `级别 ${key}`, status: index === 1 ? null : index === 0 ? `已完成：${sentence(key)}` : index === 2 ? `部分达成：${sentence(key)}` : index === 3 ? `进行中：${sentence(key)}` : `未开始：${sentence(key)}`, evidenceStages: [] }));

  const open = async (path: string, width: number, height: number, scheme: "light" | "dark") => {
    const context = await browser.newContext({ viewport: { width, height }, colorScheme: scheme, locale: "zh-CN", timezoneId: "Asia/Tashkent" });
    const page = await context.newPage(); page.on("pageerror", error => errors.push(error.message));
    await page.route(`${api}/ladder`, route => route.fulfill({ json: { available: true, source: { commit: "0".repeat(40) }, levels } }));
    // All three stages active; the first has a 24-character short name, the other two are old stages: the second's text starts with "名称：", the third's does not.
    await page.route(`${api}/stages`, async route => {
      const response = await route.fetch(); const value: Json[] = await response.json();
      const text = [null, "名称：旧阶段的名字\n交付：旧的正文", "没有名称前缀的第一行正文，写得比较长比较长比较长比较长比较长比较长\n第二行"];
      await route.fulfill({ response, json: value.map((stage, index) => ({ ...stage, state: "active", ...(text[index] ? { deliverable: text[index] } : {}) })) });
    });
    await page.route(`${api}/stages/milestones*`, async route => {
      const response = await route.fetch(); const value: Json = await response.json();
      const stages = value.stages.map((stage: Json, index: number) => ({ ...stage, state: "active",
        ...(index === 0 ? { shortName: name24, dueOn: "2026-12-02" } : index === 1 ? { shortName: null, dueOn: null } : { shortName: null, dueOn: "2026-12-14" }),
        ...(index === 1 ? { inMainTable: true } : {}) }));
      await route.fulfill({ response, json: { ...value, stages } });
    });
    await page.goto(`${fx.base}/p/${projectId}/${path}`);
    await page.getByLabel("访问令牌").fill(token); await page.getByRole("button", { name: "进入", exact: true }).click();
    return page;
  };
  const noOverflow = async (page: import("playwright-core").Page) => assert.ok(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth) <= 0, "no horizontal overflow");

  for (const scheme of ["light", "dark"] as const) for (const [width, height] of [[1440, 900], [390, 844]] as const) {
    const page = await open("overview", width, height, scheme);
    const summary = page.locator("[data-ladder] > summary"); await summary.waitFor({ timeout: 20000 });
    // Folded: "验证阶梯 · 6 级", then each level's number and mark; one line; none of the status sentences.
    const folded = await summary.innerText();
    assert.match(folded, /^验证阶梯 · 6 级/);
    assert.equal(await summary.locator("[data-ladder-mark]").count(), 6);
    for (const key of ["M0", "M0.5", "M1", "M2", "M3", "M4"]) assert.ok(await summary.locator(`[data-ladder-mark="${key}"]`).count() === 1, key);
    assert.ok(!folded.includes("整句"), "no status sentence while folded");
    const box = await summary.boundingBox(); assert.ok(box && box.height < 28, `the folded row is one line at ${width} (height ${box?.height})`);
    const marks = await summary.locator("[data-ladder-mark]").evaluateAll(nodes => nodes.map(node => { const r = node.getBoundingClientRect(); return { right: r.right, top: r.top }; }));
    const nav = await summary.evaluate(node => node.getBoundingClientRect().right);
    assert.ok(marks.every(mark => mark.right <= nav + 0.5 && Math.abs(mark.top - marks[0]!.top) < 4), `six marks on the one line, inside the row at ${width}: ${JSON.stringify(marks)}`);
    if (width >= 1000) for (const label of ["已有", "未登记", "部分", "进行中", "未有"]) assert.ok(folded.includes(label), label);
    await noOverflow(page);
    if (shots) await page.screenshot({ path: `${shots}/closeout-overview-${width}-${scheme}.png` });
    // Expanded: the full sentences.
    await summary.click();
    const expanded = await page.locator("[data-ladder-levels]").innerText();
    for (const key of ["M0", "M1", "M2", "M3", "M4"]) assert.ok(expanded.includes(sentence(key)), `${key} full sentence`);
    assert.ok(expanded.includes("未登记"), "the level with no status says 未登记");
    if (width >= 1000) {
      // The overview's left column: "短名 · 到期日", the long name cut, the date still inside the column.
      const rail = page.locator('nav[aria-label="正在推进的阶段"]'); await rail.waitFor();
      const rows = rail.locator("[data-rail-stage]"); assert.equal(await rows.count(), 3);
      const read = async (row: import("playwright-core").Locator) => row.evaluate(node => { const label = node.querySelector("[data-stage-label]")!; const name = label.querySelector<HTMLElement>("[data-stage-label-name]")!; const due = label.querySelector<HTMLElement>("[data-stage-label-due]");
        const outer = node.getBoundingClientRect(); return { name: name.textContent, due: due?.textContent ?? null, cut: name.scrollWidth > name.clientWidth, dueRight: due ? due.getBoundingClientRect().right : null, rowRight: outer.right, rowLeft: outer.left, nameRight: name.getBoundingClientRect().right }; });
      const first = await read(rows.nth(0)); const second = await read(rows.nth(1)); const third = await read(rows.nth(2));
      assert.equal(first.name, name24); assert.equal(first.due, "· 12-02"); assert.ok(first.cut, "the 24-character name is cut"); assert.ok(first.dueRight! <= first.rowRight + 0.5, "the due date is inside the column");
      assert.equal(second.name, "旧阶段的名字", "the 名称： label is not part of the name"); assert.equal(second.due, "· 未定");
      assert.ok(third.name!.startsWith("没有名称前缀的第一行正文")); assert.equal(third.due, "· 12-14"); assert.ok(third.dueRight! <= third.rowRight + 0.5);
      // 目标与阶段's left column.
      await page.context().close();
      const journey = await open("journey", width, height, scheme);
      const journeyRail = journey.locator('nav[aria-label="目标与阶段"]'); await journeyRail.locator("[data-stage-label]").first().waitFor({ timeout: 20000 });
      const labels = journeyRail.locator("a:has([data-stage-label])"); assert.equal(await labels.count(), 3);
      const jr = await Promise.all([0, 1, 2].map(index => read(labels.nth(index))));
      assert.deepEqual(jr.map(item => item.due), ["· 12-02", "· 未定", "· 12-14"]);
      assert.equal(jr[0]!.name, name24); assert.ok(jr[0]!.cut); assert.equal(jr[1]!.name, "旧阶段的名字");
      for (const item of jr) assert.ok(item.dueRight! <= item.rowRight + 0.5, "the due date is inside the column");
      await noOverflow(journey);
      if (shots) await journey.screenshot({ path: `${shots}/closeout-journey-${width}-${scheme}.png` });
      await journey.context().close();
      continue;
    }
    await page.context().close();
  }
  assert.deepEqual(errors, []);
});
