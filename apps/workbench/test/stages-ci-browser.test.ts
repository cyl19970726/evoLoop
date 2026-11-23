// Built-app regression for the stage views (needs the built workbench and EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE; EVOLOOP_STAGES_SCREENSHOT_DIR keeps the shots):
// the overview's 阶段 block and the 目标与阶段 table read the project's own stages from the service: one current row, the five cells, the in-place
// expansion kept in `?stage=`, the unassigned area, the ladder (present / absent / unreadable), and the words the service did not give stay "未定/未登记".
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

const modulePath = process.env.EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE;
const required = process.env.EVOLOOP_BROWSER_TEST_REQUIRED === "1";
const shots = process.env.EVOLOOP_STAGES_SCREENSHOT_DIR;
const repo = resolve(import.meta.dirname, "../../..");
const skip = !required && !modulePath && "Set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE after building the workbench";
type Page = import("playwright-core").Page;
type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any

test("stages: overview block and journey table", { skip }, async t => {
  assert.ok(modulePath, "EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE is required when EVOLOOP_BROWSER_TEST_REQUIRED=1");
  const { projectId, token } = await import(pathToFileURL(resolve(repo, "scripts/frontend/fixture/common.mjs")).href);
  const { startFixtureServer } = await import(pathToFileURL(resolve(repo, "scripts/frontend/fixture/server.mjs")).href);
  const { chromium } = (await import(pathToFileURL(modulePath!).href)).default;
  const fx = await startFixtureServer(resolve(import.meta.dirname, "../dist")); t.after(() => fx.close());
  const executablePath = process.env.EVOLOOP_BROWSER_TEST_EXECUTABLE_PATH || process.env.EVOLOOP_BROWSER_TEST_CHROMIUM_EXECUTABLE || undefined;
  const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) }); t.after(() => browser.close());
  const errors: string[] = [];
  const api = `**/api/projects/${projectId}`;
  type Setup = { projection?: (value: Json) => Json; ladder?: "absent" | "error" | "none"; permissions?: string[]; work?: (value: Json) => Json; commands?: Json[]; timeZone?: string[] };
  const ladderRead = new WeakMap<Page, Promise<unknown>>();
  const open = async (path: string, width: number, height: number, setup: Setup = {}, colorScheme: "light" | "dark" = "light"): Promise<Page> => {
    const context = await browser.newContext({ viewport: { width, height }, colorScheme, locale: "zh-CN", timezoneId: "Asia/Tashkent" });
    const page = await context.newPage(); page.on("pageerror", error => errors.push(error.message));
    await page.route(`${api}/stages/milestones*`, async route => {
      setup.timeZone?.push(new URL(route.request().url()).searchParams.get("timeZone") ?? "");
      const response = await route.fetch(); const value = await response.json();
      await route.fulfill({ response, json: setup.projection ? setup.projection(value) : value });
    });
    if (setup.ladder === "absent") await page.route(`${api}/ladder`, route => route.fulfill({ json: { available: false, source: null, levels: [] } }));
    if (setup.ladder === "error") await page.route(`${api}/ladder`, route => route.fulfill({ status: 409, json: { code: "LADDER_UNREADABLE", message: "路线图读不到" } }));
    if (setup.work) await page.route(`${api}/work-management/index*`, async route => {
      const response = await route.fetch(); await route.fulfill({ response, json: setup.work!(await response.json()) });
    });
    if (setup.permissions) await page.route("**/api/session", async route => {
      const response = await route.fetch(); const value = await response.json();
      await route.fulfill({ response, json: { ...value, principal: { ...value.principal, permissions: setup.permissions } } });
    });
    if (setup.commands) await page.route("**/api/commands", async route => {
      const command = JSON.parse(route.request().postData() ?? "{}"); setup.commands!.push(command);
      await route.fulfill({ json: { status: "applied", operationId: command.operationId, entityId: command.taskId } });
    });
    ladderRead.set(page, page.waitForResponse(response => response.url().includes("/ladder"), { timeout: 20000 }).catch(() => null)); // the ladder has its own read; wait for it before asserting on it
    await page.goto(`${fx.base}/p/${projectId}/${path}`);
    await page.getByLabel("访问令牌").fill(token); await page.getByRole("button", { name: "进入", exact: true }).click();
    return page;
  };
  const overview = async (width: number, height: number, setup: Setup = {}, scheme: "light" | "dark" = "light") => {
    const page = await open("overview", width, height, setup, scheme); await page.locator("[data-overview-stages] [data-stage-row], [data-overview-stages] [data-no-stages]").first().waitFor({ timeout: 15000 }); await ladderRead.get(page); await page.waitForTimeout(150); return page;
  };
  const journey = async (query: string, width: number, height: number, setup: Setup = {}, scheme: "light" | "dark" = "light") => {
    const page = await open(`journey${query}`, width, height, setup, scheme); await page.locator("[data-stages] [data-stage-row]").first().waitFor({ timeout: 15000 }); await ladderRead.get(page); await page.waitForTimeout(150); return page;
  };
  const clean = async (page: Page) => { await page.context().close(); };
  const overflow = (page: Page) => page.evaluate(`({ over: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    past: [...document.querySelectorAll("main *")].filter(e => e.offsetParent && e.getBoundingClientRect().right > innerWidth + 0.5).length })`) as Promise<{ over: number; past: number }>;
  const readings: unknown[] = [];

  // Five stages due 12-02, 12-07, 12-09, 12-14, 12-16; only the one the service names is current; two have tasks.
  // Names and check methods as long as the project's real ones (about 6-14 characters, and one to three sentences), so the first-screen reading is the real one.
  const names = ["组织连续 7 天不用你催", "分工按负载收紧", "新版任务与文档页可真实使用", "第二个项目接入试用", "对外说明可交付"];
  const checks = ["组织里连续 7 天，没有人需要催着才推进工作；负责人逐日在工作台上能看到每项任务的下一责任。由验收者写结论。", "两个以上职责在同一周内按负载重新分配任务，没有职责被连续三天空等；记录分配理由和结果。", "使用者自己沿三条路径用一遍工作台：打开总览、处理待办、交付一项任务；任何一条卡住就算没到。", "接入第二个项目并跑通第一个任务，从登记到验收全程用工作台完成，不靠手工补记录。", "对外说明初稿经使用者通读，能回答三个常见问题，且没有一处需要口头补充。"];
  const five = (value: Json) => {
    const base = value.stages.find((stage: Json) => stage.inMainTable);
    const make = (n: number, due: string, tasks: Json, extra: Json = {}) => ({ ...base, id: `7a00000${n}-0000-4000-8000-00000000000${n}`, shortName: names[n - 1], dueOn: due, checkMethod: checks[n - 1], status: "accepted_no_tasks", statusLabel: "已接受还没有任务", latestReview: null, tasks, state: "active", inMainTable: true, ...extra });
    const zero = { inProgress: 0, blocked: 0, notStarted: 0, closed: 0, total: 0 };
    const stages = [make(1, "2026-12-02", { inProgress: 2, blocked: 1, notStarted: 0, closed: 0, total: 3 }, { status: "in_progress", statusLabel: "进行中" }), make(2, "2026-12-07", zero), make(3, "2026-12-09", { inProgress: 0, blocked: 0, notStarted: 2, closed: 0, total: 2 }), make(4, "2026-12-14", zero), make(5, "2026-12-16", zero)];
    return { ...value, stages, currentStageId: stages[0]!.id, currentNote: null };
  };

  for (const [width, height] of [[1440, 900], [390, 844]] as const) {
    const zones: string[] = [];
    const page = await overview(width, height, { projection: five, timeZone: zones });
    const rows = page.locator("[data-overview-stages] [data-stage-row]");
    assert.equal(await rows.count(), 5, "one row per stage, none hidden");
    assert.equal(await page.locator("[data-overview-stages] [data-current='true']").count(), 1, "exactly one current row");
    assert.equal(await page.locator("[data-overview-stages] [data-current='true']").getAttribute("data-stage-row"), "7a000001-0000-4000-8000-000000000001");
    const text = await page.locator("[data-overview-stages]").innerText();
    for (const part of ["12-02", "12-07", "12-09", "12-14", "12-16", "进行 2 · 卡住 1", "未开始 2", "还没有任务", "进行中", "当前"]) assert.ok(text.includes(part), part);
    assert.ok(zones.length > 0 && zones.every(zone => zone === "Asia/Tashkent"), "the browser time zone is sent");
    assert.doesNotMatch(await page.locator("main").innerText(), /里程碑/);
    assert.match(await page.locator("[data-unowned]").innerText(), /\d+ 项未关闭任务未归属阶段/);
    assert.equal(await page.locator("[data-unowned] a").getAttribute("href"), `/p/${projectId}/journey#unassigned`);
    for (const word of ["重要里程碑", "当前阶段未登记", "没有单一的当前阶段"]) assert.ok(!(await page.locator("main").innerText()).includes(word), word);
    // Each stage keeps its two rows at 390: the name line and the check method, all of them inside the block.
    if (width < 500) for (const index of [0, 1, 2, 3, 4]) { const box = await rows.nth(index).boundingBox(); assert.ok(box && box.height > 0 && box.x + box.width <= width + 0.5, `row ${index} is drawn inside the width`); }
    const flow = await overflow(page); assert.equal(flow.over <= 0, true, `no horizontal overflow at ${width}`); assert.equal(flow.past, 0);
    // The first screen (docs/frontend/pages/overview.md): the same order at both widths (the DOM order is the order seen), ①②③ whole and the 阶段 title row at 1440,
    // ① whole and the title of ② at 390 (the phone's 64px tab bar covers the bottom of 390x844).
    const edge = height - (width >= 1000 ? 0 : 64);
    const read = await page.evaluate(`(() => { const top = s => { const e = document.querySelector(s); return e ? Math.round(e.getBoundingClientRect().top) : null; }; const bottom = s => { const e = document.querySelector(s); return e ? Math.round(e.getBoundingClientRect().bottom) : null; };
      return { order: ["[data-overview-block=priority]", "[data-overview-block=use]", "[data-overview-block=outcome]", "[data-overview-stages]", "[data-overview-block=organisation]", "[data-overview-goal]", "[data-overview-version]"].map(top),
        priorityBottom: bottom("[data-overview-block=priority]"), useTitleBottom: bottom("[data-overview-block=use] h2"), useBottom: bottom("[data-overview-block=use]"), outcomeBottom: bottom("[data-overview-block=outcome]"), stagesTitleBottom: bottom("[data-overview-stages] h2") }; })()`) as
      { order: (number | null)[]; priorityBottom: number; useTitleBottom: number; useBottom: number; outcomeBottom: number; stagesTitleBottom: number };
    readings.push({ view: `overview ${width}x${height}, five stages`, scrollOver: flow.over, edge, ...read });
    assert.ok(read.order.every((value, index) => value !== null && (index === 0 || value > read.order[index - 1]!)), `the blocks follow one order at ${width}: ${JSON.stringify(read.order)}`);
    assert.ok(read.priorityBottom <= edge, `① is whole on the first screen at ${width}x${height} (bottom ${read.priorityBottom}, edge ${edge})`);
    assert.ok(read.useTitleBottom <= edge, `the title of ② is on the first screen at ${width}x${height} (bottom ${read.useTitleBottom}, edge ${edge})`);
    if (width >= 1000) for (const [name, value] of Object.entries({ useBottom: read.useBottom, outcomeBottom: read.outcomeBottom, stagesTitleBottom: read.stagesTitleBottom })) assert.ok(value <= edge, `${name} is on the first screen at ${width}x${height} (${value}, edge ${edge})`);
    assert.equal(await page.locator(".overview-attention").count(), 0, "本次优先核对 is gone");
    for (const [selector, open] of [["[data-overview-block=organisation]", false], ["[data-overview-goal]", false], ["[data-overview-version]", false]] as const) assert.equal(await page.locator(selector).evaluate(node => (node as HTMLDetailsElement).open), open, `${selector} starts folded`);
    if (shots) await page.screenshot({ path: `${shots}/overview-${width}-light.png` });
    // Clicking a row lands on that stage's row in the journey page, opened and in the address.
    await rows.nth(2).click(); await page.locator("[data-stages] [data-stage-row]").first().waitFor();
    assert.match(page.url(), /journey\?stage=7a000003-0000-4000-8000-000000000003$/);
    await clean(page);
  }

  // Dark: the same block, drawn from the design-language variables.
  const dark = await overview(1440, 900, { projection: five }, "dark");
  if (shots) await dark.screenshot({ path: `${shots}/overview-1440-dark.png` });
  await dark.mouse.move(0, 0); // the sign-in click left the pointer over a row, and a hovered row is drawn selected too
  const current = await dark.locator("[data-overview-stages] [data-current='true'] a").evaluate(node => getComputedStyle(node).backgroundColor);
  const plain = await dark.locator("[data-overview-stages] [data-stage-row]:not([data-current]) a").first().evaluate(node => getComputedStyle(node).backgroundColor);
  assert.notEqual(current, plain, "the current row is drawn as the selected state");
  await clean(dark);

  // The guard: two active stages with the service naming one → one current row, never two.
  const two = await overview(1440, 900, { projection: value => { const v = five(value); return { ...v, currentStageId: v.stages[2].id }; } });
  assert.equal(await two.locator("[data-overview-stages] [data-current='true']").count(), 1);
  assert.equal(await two.locator("[data-overview-stages] [data-current='true']").getAttribute("data-stage-row"), "7a000003-0000-4000-8000-000000000003");
  const none = await two.evaluate(() => 0); void none;
  await clean(two);
  const nobody = await overview(1440, 900, { projection: value => ({ ...five(value), currentStageId: null }) });
  assert.equal(await nobody.locator("[data-overview-stages] [data-current='true']").count(), 0, "no current stage named, none is drawn as current");
  await clean(nobody);

  // Missing data: no stages at all, and a stage with nothing registered.
  const empty = await overview(1440, 900, { projection: value => ({ ...value, stages: [], currentStageId: null, tasksNoStage: { unowned: 0, declared: 0 } }) });
  assert.match(await empty.locator("[data-overview-stages]").innerText(), /这个项目还没有阶段/);
  await clean(empty);
  const sparse = await overview(1440, 900, { projection: value => { const v = five(value); v.stages[0] = { ...v.stages[0], shortName: null, dueOn: null, checkMethod: null, latestReview: null, status: "review_missing", statusLabel: "暂无回看" }; return v; } });
  const sparseText = await sparse.locator("[data-overview-stages]").innerText();
  for (const word of ["未定", "未登记", "暂无回看"]) assert.ok(sparseText.includes(word), word);
  assert.ok(!/达成/.test(sparseText), "a stage without a review never shows an 达成 word");
  await clean(sparse);

  // The overdue status says which day and zone it counted.
  const late = await overview(1440, 900, { projection: value => { const v = five(value); v.stages[1] = { ...v.stages[1], status: "overdue_awaiting_review", statusLabel: "已到期待回看" }; return { ...v, today: "2026-12-08", timeZone: "Asia/Tashkent" }; } });
  assert.match(await late.locator("[data-overdue-note]").innerText(), /按 Asia\/Tashkent 的 2026-12-08 算/);
  await clean(late);

  // The ladder: one folded row when present, no element at all when absent, 阶梯读不到 when unreadable.
  const present = await overview(1440, 900);
  assert.equal(await present.locator("[data-overview-stages] [data-ladder]").count(), 1);
  assert.equal(await present.locator("[data-overview-stages] details[data-ladder]").evaluate(node => (node as HTMLDetailsElement).open), false);
  assert.match(await present.locator('[data-overview-stages] [data-ladder-mark="M0.5"]').innerText(), /未登记/, "a level with no status is marked 未登记");
  await clean(present);
  const absent = await overview(1440, 900, { ladder: "absent" });
  assert.equal(await absent.locator("[data-ladder], [data-ladder-error]").count(), 0, "no ladder element when the service says it is not available");
  assert.ok(!(await absent.locator("[data-overview-stages]").innerText()).includes("验证阶梯"));
  await clean(absent);
  const broken = await overview(1440, 900, { ladder: "error" });
  assert.equal(await broken.locator("[data-ladder-error]").innerText(), "阶梯读不到");
  assert.equal(await broken.locator("[data-ladder]").count(), 0);
  await clean(broken);

  // Journey: the same table on the first screen, the check method in full, expansion in place kept in the address.
  for (const [width, height] of [[1440, 900], [390, 844]] as const) {
    const page = await journey("", width, height, { projection: five });
    assert.equal(await page.locator("[data-stages] [data-stage-row]").count(), 5);
    const clamped = await page.locator("[data-stages] [data-stage-row]").first().evaluate(node => [...node.querySelectorAll("*")].some(e => /line-clamp/.test(e.className?.toString?.() ?? "")));
    assert.equal(clamped, false, "the check method is not truncated on this page");
    const first = page.locator("[data-stages] [data-stage-row]").first();
    if (width >= 1000) assert.equal(await page.locator("[data-stages] [data-stage-table] > [aria-hidden]").evaluate(node => getComputedStyle(node).display), "grid", "the journey table has its column header at 1440");
    // One set of status words: the service's, in the side list and the information panel too; and one count of tasks outside stages.
    const everything = await page.locator("main, [aria-label='目标与阶段的信息']").evaluateAll(nodes => nodes.map(node => (node as HTMLElement).innerText).join("\n"));
    assert.doesNotMatch(everything, /推进中|已回看/, "the old lifecycle words are not on the page");
    assert.match(everything, /未归属阶段的任务[\s\S]*未关闭、未归属[\s\S]*明确不属于阶段/);
    const top = await first.evaluate(node => Math.round(node.getBoundingClientRect().top));
    assert.ok(top < height, `the table starts on the first screen at ${width}x${height} (top ${top})`);
    await first.click();
    assert.match(page.url(), /\?stage=7a000001-0000-4000-8000-000000000001$/);
    const region = page.getByRole("region", { name: /任务与回看/ });
    await region.waitFor();
    const regionText = await region.innerText();
    for (const part of ["任务", "最新回看", "检查办法", "补哪一级"]) assert.ok(regionText.includes(part), part);
    assert.ok(await region.locator("a[href*='/task/']").count() > 0 || /还没有任务|没有读全/.test(regionText), "tasks link to the task page");
    assert.equal(await first.locator("button").getAttribute("aria-expanded"), "true");
    const flow = await overflow(page); assert.equal(flow.over <= 0, true); assert.equal(flow.past, 0);
    readings.push({ view: `journey open ${width}x${height}`, scrollOver: flow.over, firstRowTop: top });
    if (shots) await page.screenshot({ path: `${shots}/journey-open-${width}-light.png` });
    await page.reload(); await page.getByLabel("访问令牌").fill(token); await page.getByRole("button", { name: "进入", exact: true }).click(); // the token lives in page memory
    await page.locator("[data-stages] [data-stage-row]").first().waitFor();
    assert.equal(await page.locator("[data-stages] [data-stage-row] button").first().getAttribute("aria-expanded"), "true", "a reload lands on the same open row");
    await clean(page);
  }
  const darkJourney = await journey("", 1440, 900, {}, "dark");
  if (shots) await darkJourney.screenshot({ path: `${shots}/journey-1440-dark.png` });
  await clean(darkJourney);
  // The old stage without a short name sits in the folded 已回看的阶段, named by its first line; opening by address opens the fold.
  const folded = await journey("", 1440, 900);
  const foldedArea = folded.locator("[data-folded-stages]");
  assert.equal(await foldedArea.count(), 1);
  assert.equal(await foldedArea.evaluate(node => (node as HTMLDetailsElement).open), false);
  await clean(folded);
  const noLadder = await journey("", 1440, 900, { ladder: "error" });
  assert.equal(await noLadder.locator("[data-ladder-error]").innerText(), "阶梯读不到");
  await clean(noLadder);

  // Unassigned: one select per row; choosing files the Task with task.stage.set, and the row and the count go once the reread shows it owned.
  const commands: Json[] = []; let filed: string | null = null;
  const withUnassigned = (value: Json) => ({ ...value, items: value.items.filter((item: Json) => item.taskId !== filed) });
  const filing = await journey("#unassigned", 1440, 900, { commands, work: withUnassigned, projection: value => { const v = five(value); return filed ? { ...v, tasksNoStage: { ...v.tasksNoStage, unowned: Math.max(0, v.tasksNoStage.unowned - 1) } } : v; } });
  const area = filing.locator("#unassigned");
  await area.locator("summary").waitFor();
  await filing.locator("[data-unowned-task]").first().waitFor({ timeout: 10000 });
  const before = await filing.locator("[data-unowned-task]").count();
  assert.ok(before > 0, "the fixture has an open Task with no stage");
  {
    const row = filing.locator("[data-unowned-task]").first();
    filed = await row.getAttribute("data-unowned-task");
    await row.locator("select").selectOption({ index: 1 });
    await filing.locator(`[data-unowned-task="${filed}"]`).waitFor({ state: "detached", timeout: 8000 });
    assert.equal(commands.length, 1);
    assert.equal(commands[0].type, "task.stage.set"); assert.equal(commands[0].taskId, filed); assert.ok(commands[0].stageId); assert.ok(commands[0].reason);
    assert.equal(await filing.locator("[data-unowned-task]").count(), before - 1);
  }
  await clean(filing);
  // No task-write permission: the select is there but disabled, with the reason beside it, and nothing is sent.
  const denied = await journey("#unassigned", 1440, 900, { permissions: [], commands });
  const deniedRow = denied.locator("[data-unowned-task]").first();
  await deniedRow.waitFor({ timeout: 10000 });
  assert.equal(await deniedRow.count(), 1);
  {
    assert.equal(await deniedRow.locator("select").isDisabled(), true);
    assert.match(await deniedRow.innerText(), /没有任务写权限/);
  }
  await clean(denied);

  // The left rail of the overview: the current stage short name with its due date, drawn as selected, leading to that stage's row.
  const rail = await overview(1440, 900, { projection: five });
  assert.doesNotMatch(await rail.locator("main").innerText(), /里程碑/);
  await clean(rail);

  if (shots) { const { writeFile } = await import("node:fs/promises"); await writeFile(`${shots}/stages-readings.json`, JSON.stringify(readings, null, 1)); }
  assert.deepEqual(errors, []);
});
