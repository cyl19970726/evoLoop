// Built-app regression for “跳到” (Task 5eb93990): the box (⌘K / Ctrl+K, the shell button, the phone header button), one match opens,
// several are chosen with the keys, none and fewer than 8 digits say so (and the short text sends no request), and an address
// that carries a short id is resolved by a replace. The fixture service answers like the real lookup
// (scripts/frontend/fixture/jump.mjs); the real route and queries are tested in tests/integration/object-jump.test.ts.
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

const modulePath = process.env.EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE;
const required = process.env.EVOLOOP_BROWSER_TEST_REQUIRED === "1";
const shots = process.env.EVOLOOP_JUMP_SCREENSHOT_DIR;
const repo = resolve(import.meta.dirname, "../../..");
const skip = !required && !modulePath && "Set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE after building the workbench";

test("jump box and short ids in the address", { skip }, async t => {
  assert.ok(modulePath, "EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE is required when EVOLOOP_BROWSER_TEST_REQUIRED=1");
  const fixtureDir = resolve(repo, "scripts/frontend/fixture");
  const { projectId, token, id, agents } = await import(pathToFileURL(resolve(fixtureDir, "common.mjs")).href);
  const { startFixtureServer } = await import(pathToFileURL(resolve(fixtureDir, "server.mjs")).href);
  const work = await import(pathToFileURL(resolve(fixtureDir, "work.mjs")).href);
  const jumpFixture = await import(pathToFileURL(resolve(fixtureDir, "jump.mjs")).href);
  const spaces = await import(pathToFileURL(resolve(fixtureDir, "spaces.mjs")).href);
  const { chromium } = (await import(pathToFileURL(modulePath!).href)).default;
  const fx = await startFixtureServer(resolve(import.meta.dirname, "../dist")); t.after(() => fx.close());
  const executablePath = process.env.EVOLOOP_BROWSER_TEST_EXECUTABLE_PATH || process.env.EVOLOOP_BROWSER_TEST_CHROMIUM_EXECUTABLE || undefined;
  const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) }); t.after(() => browser.close());
  const errors: string[] = [];
  const short = (full: string) => full.slice(0, 8);
  const base = `/p/${projectId}`;

  const open = async (width: number, height: number, path = "overview", colorScheme: "light" | "dark" = "light") => {
    const context = await browser.newContext({ viewport: { width, height }, locale: "zh-CN", colorScheme });
    const page = await context.newPage(); page.on("pageerror", error => errors.push(error.message));
    const jumpRequests: string[] = [];
    page.on("request", request => { const url = new URL(request.url()); if (url.pathname.endsWith("/jump")) jumpRequests.push(url.searchParams.get("q") ?? ""); });
    await page.goto(`${fx.base}${base}/${path}`);
    await page.getByLabel("访问令牌").fill(token); await page.getByRole("button", { name: "进入", exact: true }).click();
    await page.locator("#workspace-main").waitFor({ timeout: 15000 });
    return { page, jumpRequests, context };
  };
  // The box takes focus back in the tick after it unmounts.
  const closed = async (page: any) => { await page.getByRole("dialog").waitFor({ state: "detached" }); await page.waitForFunction(() => document.activeElement !== document.body); };
  const where = (page: any) => { const url = new URL(page.url()); return `${url.pathname}${url.search}`; };
  const box = (page: any) => page.getByRole("combobox", { name: /跳到/ });
  const jump = async (page: any, text: string, opener: "button" | "key" = "key") => {
    if (opener === "key") await page.keyboard.press("Control+k"); else await page.getByRole("button", { name: /^跳到/ }).first().click();
    await box(page).waitFor();
    await box(page).fill(text); await box(page).press("Enter");
  };

  // ---- wide screen: every kind lands on its page, by its first 8 digits and by the full id ----
  const wide = await open(1440, 900);
  const page = wide.page;
  const taskTitle = (taskId: string) => Object.values(work.tasks as Record<string, { id: string; title: string }>).find(task => task.id === taskId)!.title;
  assert.ok(await page.getByRole("button", { name: /^跳到/ }).first().isVisible(), "the rail has the entry");
  assert.match(await page.getByRole("button", { name: /^跳到/ }).first().innerText(), /跳到…\s*(⌘K|Ctrl K)/, "it says 跳到… and the shortcut");
  const documents = work.documentList({}) as Array<{ id: string }>;
  const stageIds = Object.values(work.stages as Record<string, { id: string }>).map(stage => stage.id);
  const scheduleIds = (spaces.schedules.list() as Array<{ id: string }>).map(schedule => schedule.id);
  const agentIds = Object.values(agents as Record<string, { sessionId: string }>).map(agent => agent.sessionId);
  const samples: Array<[string, string, string]> = [
    ["task", work.tasks.t1.id, `${base}/tasks/${work.tasks.t1.id}`], ["task", work.tasks.t2.id, `${base}/tasks/${work.tasks.t2.id}`],
    ["document", documents[0]!.id, `${base}/documents/${documents[0]!.id}`], ["document", documents[1]!.id, `${base}/documents/${documents[1]!.id}`],
    ["agent", agentIds[1]!, `${base}/sessions?session=owned%3A${agentIds[1]}`], ["agent", agentIds[2]!, `${base}/sessions?session=owned%3A${agentIds[2]}`],
    ["stage", stageIds[0]!, `${base}/journey?stage=${stageIds[0]}`], ["stage", stageIds[1]!, `${base}/journey?stage=${stageIds[1]}`],
    ["schedule", scheduleIds[0]!, `${base}/schedules?schedule=${scheduleIds[0]}`], ["schedule", scheduleIds[1]!, `${base}/schedules?schedule=${scheduleIds[1]}`],
  ];
  for (const [kind, objectId, address] of samples) {
    for (const text of [short(objectId), objectId]) {
      await jump(page, text); await page.waitForFunction(target => location.pathname + location.search === target, address, { timeout: 10000 });
      assert.equal(where(page), address, `${kind} ${text}`);
      await page.goto(`${fx.base}${base}/overview`);
      await page.getByLabel("访问令牌").fill(token); await page.getByRole("button", { name: "进入", exact: true }).click(); await page.locator("#workspace-main").waitFor();
    }
  }
  // A PR number and a delivery id land on the task's 交付与使用 tab.
  const deliveryTab = `${base}/tasks/${jumpFixture.prDelivery.taskId}?tab=delivery`;
  for (const text of ["#12", "12", short(jumpFixture.prDelivery.id), jumpFixture.prDelivery.id]) {
    await jump(page, text); await page.waitForFunction(target => location.pathname + location.search === target, deliveryTab, { timeout: 10000 });
    assert.equal(where(page), deliveryTab, text);
    assert.ok(await page.getByRole("tab", { name: "交付与使用" }).getAttribute("aria-selected") === "true" || (await page.getByText("交付与使用").count()) > 0, `${text}: the delivery tab`);
    await page.goto(`${fx.base}${base}/overview`);
    await page.getByLabel("访问令牌").fill(token); await page.getByRole("button", { name: "进入", exact: true }).click(); await page.locator("#workspace-main").waitFor();
  }

  // ---- several matches: two rows, type and title, keys choose ----
  const here = where(page);
  await jump(page, short(jumpFixture.clash.task));
  const options = page.getByRole("option");
  await options.first().waitFor();
  assert.equal(await options.count(), 2);
  assert.match(await options.nth(0).innerText(), /任务[\s\S]*撞号的任务/);
  assert.match(await options.nth(1).innerText(), /文档[\s\S]*撞号的文档/);
  assert.equal(where(page), here, "the list does not leave the page");
  assert.equal(await options.nth(0).getAttribute("aria-selected"), "true");
  await box(page).press("ArrowDown");
  assert.equal(await options.nth(1).getAttribute("aria-selected"), "true");
  assert.equal(await box(page).getAttribute("aria-activedescendant"), await options.nth(1).getAttribute("id"));
  await box(page).press("Enter");
  await page.waitForFunction(target => location.pathname === target, `${base}/documents/${jumpFixture.clash.document}`);
  await page.goBack(); await page.waitForFunction(target => location.pathname === target, base + "/overview");
  await jump(page, short(jumpFixture.clash.task)); await page.getByRole("option").first().waitFor();
  await box(page).press("ArrowDown"); await box(page).press("ArrowUp"); await box(page).press("Enter");
  await page.waitForFunction(target => location.pathname === target, `${base}/tasks/${jumpFixture.clash.task}`);

  // ---- nothing found, and too short ----
  await page.goto(`${fx.base}${base}/overview`);
  await page.getByLabel("访问令牌").fill(token); await page.getByRole("button", { name: "进入", exact: true }).click(); await page.locator("#workspace-main").waitFor();
  const stay = where(page);
  wide.jumpRequests.length = 0;
  await jump(page, "deadbeef");
  await page.getByRole("status").filter({ hasText: "没有找到以 deadbeef 开头的任务、文档、智能体、阶段或日程" }).waitFor();
  assert.equal(where(page), stay, `nothing found: the address is unchanged (${stay} -> ${where(page)})`);
  assert.equal(wide.jumpRequests.length, 1);
  await box(page).fill("0123abc"); await box(page).press("Enter");
  await page.getByRole("status").filter({ hasText: "至少要 8 位" }).waitFor();
  assert.equal(wide.jumpRequests.length, 1, "7 digits sent no request");
  await box(page).fill("hello"); await box(page).press("Enter");
  await page.getByRole("status").filter({ hasText: "不是编号" }).waitFor();
  assert.equal(wide.jumpRequests.length, 1, "text that is no id sent no request");
  assert.equal(where(page), stay);
  assert.equal(await box(page).getAttribute("aria-label"), "跳到：编号或 PR 号", "the input has a name");

  // ---- Esc closes and focus returns to where it was ----
  await page.keyboard.press("Escape");
  // The box gives focus back a tick after it is gone; moving focus before that lets the return overwrite it (Task 06868d2a).
  await closed(page);
  await page.getByRole("link", { name: "智能体" }).first().focus();
  const focusedLabel = await page.evaluate(() => (document.activeElement as HTMLElement).outerHTML.slice(0, 120));
  assert.match(focusedLabel, /^<a /, "a link had focus before the box opened");
  await page.keyboard.press("Control+k"); await box(page).waitFor();
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("role")), "combobox", "focus is in the box");
  await page.keyboard.press("Escape"); await closed(page);
  assert.equal(await page.evaluate(() => (document.activeElement as HTMLElement).outerHTML.slice(0, 120)), focusedLabel, "focus is back on the element that had it");
  // The shell button opens the same box.
  await page.getByRole("button", { name: /^跳到/ }).first().click(); await box(page).waitFor();
  await page.keyboard.press("Escape"); await closed(page);
  assert.equal(await page.evaluate(() => document.activeElement?.textContent?.includes("跳到")), true, "focus returns to the button that opened it");
  if (shots) { await jump(page, short(jumpFixture.clash.task)); await page.getByRole("option").first().waitFor(); await page.screenshot({ path: `${shots}/jump-wide-light.png` }); }

  // ---- addresses with a short id ----
  const length = async () => page.evaluate(() => history.length);
  const reopen = async (path: string) => { await page.goto(`${fx.base}${base}/${path}`); await page.getByLabel("访问令牌").fill(token); await page.getByRole("button", { name: "进入", exact: true }).click(); };
  const resolved = async (path: string, address: string) => {
    await reopen(path);
    await page.waitForFunction(target => location.pathname + location.search === target, address, { timeout: 10000 });
  };
  await resolved(`tasks/${short(work.tasks.t1.id)}`, `${base}/tasks/${work.tasks.t1.id}`);
  await resolved(`documents/${short(documents[0]!.id)}`, `${base}/documents/${documents[0]!.id}`);
  await resolved(`sessions?session=owned:${short(agentIds[1]!)}`, `${base}/sessions?session=owned%3A${agentIds[1]}`);
  await resolved(`sessions?session=${short(agentIds[1]!)}`, `${base}/sessions?session=${agentIds[1]}`);
  await resolved(`journey?stage=${short(stageIds[0]!)}`, `${base}/journey?stage=${stageIds[0]}`);
  await resolved(`schedules?schedule=${short(scheduleIds[0]!)}`, `${base}/schedules?schedule=${scheduleIds[0]}`);
  await resolved(`go/${short(work.tasks.t2.id)}`, `${base}/tasks/${work.tasks.t2.id}`);
  await resolved(`go/${encodeURIComponent("#12")}`, deliveryTab);
  // The resolved address replaced the short one: Back does not return to it. A fresh tab, because the browser keeps at most 50 entries.
  const fresh = await open(1440, 900, "overview");
  const history = fresh.page;
  const before = await history.evaluate(() => window.history.length);
  await history.evaluate(path => { window.history.pushState(null, "", path); window.dispatchEvent(new PopStateEvent("popstate")); }, `${base}/tasks/${short(work.tasks.t1.id)}`);
  await history.waitForFunction(target => location.pathname === target, `${base}/tasks/${work.tasks.t1.id}`, { timeout: 10000 });
  assert.equal(await history.evaluate(() => window.history.length), before + 1, `history length ${before} → ${before + 1}: the pushed short address, and the resolve added no entry`);
  await history.goBack(); await history.waitForFunction(target => location.pathname === target, `${base}/overview`);
  assert.equal(await history.evaluate(() => location.pathname.includes("tasks")), false, "Back goes to the page before, not the short address");
  await fresh.context.close();

  // ---- an unknown prefix: 找不到这个对象, not 任务读取失败 ----
  await reopen("tasks/deadbeef");
  await page.getByRole("heading", { name: "找不到这个对象" }).waitFor();
  assert.equal(await page.getByText("任务读取失败").count(), 0);
  assert.match(await page.locator("[data-not-found-object]").innerText(), /任务「deadbeef」/);
  assert.ok(await page.getByRole("link", { name: "回到任务列表" }).isVisible());
  assert.equal(where(page), `${base}/tasks/deadbeef`, "the address is kept for the reader to check");
  await page.getByRole("button", { name: "打开“跳到”" }).click();
  assert.equal(await box(page).inputValue(), "deadbeef", "the box opens with what was looked for");
  await page.keyboard.press("Escape");
  await reopen("tasks/abc");
  await page.getByRole("heading", { name: "找不到这个对象" }).waitFor();
  assert.match(await page.locator("[data-not-found-object]").innerText(), /至少要 8 位/);
  await reopen(`go/${short(jumpFixture.clash.task)}`);
  await page.getByRole("heading", { name: "找不到这个对象" }).waitFor();
  assert.equal(await page.locator("[data-not-found-object] li").count(), 2, "a prefix that names two objects lists both");
  assert.deepEqual(wide.jumpRequests.filter(text => text === "abc"), [], "a short text in an address sends no request");
  if (shots) await page.screenshot({ path: `${shots}/jump-notfound-wide-light.png` });
  await wide.context.close();

  // ---- phone width: the header button opens the same box ----
  for (const scheme of ["light", "dark"] as const) {
    const phone = await open(390, 844, "work", scheme);
    const button = phone.page.getByRole("banner").getByRole("button", { name: /^跳到/ });
    assert.ok(await button.isVisible(), "the phone header has the button");
    await button.click(); await box(phone.page).waitFor();
    await box(phone.page).fill(short(jumpFixture.clash.task)); await box(phone.page).press("Enter");
    await phone.page.getByRole("option").first().waitFor();
    assert.equal(await phone.page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true, `${scheme}: no horizontal overflow with the box open`);
    if (shots) await phone.page.screenshot({ path: `${shots}/jump-phone-${scheme}.png` });
    await box(phone.page).press("Escape"); await closed(phone.page);
    assert.equal(await phone.page.evaluate(() => document.activeElement?.getAttribute("aria-label")?.startsWith("跳到")), true, "focus is back on the header button");
    await phone.context.close();
  }
  if (shots) {
    const dark = await open(1440, 900, "overview", "dark");
    await jump(dark.page, short(jumpFixture.clash.task)); await dark.page.getByRole("option").first().waitFor();
    await dark.page.screenshot({ path: `${shots}/jump-wide-dark.png` });
    assert.equal(await dark.page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true, "no horizontal overflow, dark");
    await dark.context.close();
  }
  assert.deepEqual(errors, []);
});
