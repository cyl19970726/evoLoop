// Built-app regression for the overview's first screen (docs/frontend/pages/overview.md): ① 要你决定或处理的, ② 请你亲自用的, ③ 结果是否有效, the one
// organisation line, the folded goal and version lines. Needs the built workbench and EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE; the fixture service is
// answered over for the reads of 待我处理 so each kind has a known number of rows.
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

const modulePath = process.env.EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE;
const required = process.env.EVOLOOP_BROWSER_TEST_REQUIRED === "1";
const shots = process.env.EVOLOOP_OVERVIEW_SCREENSHOT_DIR; // keeps the screenshots and the readings of the first screen
const repo = resolve(import.meta.dirname, "../../..");
const skip = !required && !modulePath && "Set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE after building the workbench";
type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any

test("overview first screen: the rows, the counts and the links", { skip }, async t => {
  assert.ok(modulePath, "EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE is required when EVOLOOP_BROWSER_TEST_REQUIRED=1");
  const { projectId, token } = await import(pathToFileURL(resolve(repo, "scripts/frontend/fixture/common.mjs")).href);
  const { startFixtureServer } = await import(pathToFileURL(resolve(repo, "scripts/frontend/fixture/server.mjs")).href);
  const { chromium } = (await import(pathToFileURL(modulePath!).href)).default;
  const fx = await startFixtureServer(resolve(import.meta.dirname, "../dist")); t.after(() => fx.close());
  const executablePath = process.env.EVOLOOP_BROWSER_TEST_EXECUTABLE_PATH || process.env.EVOLOOP_BROWSER_TEST_CHROMIUM_EXECUTABLE || undefined;
  const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) }); t.after(() => browser.close());
  const errors: string[] = [];
  const api = `**/api/projects/${projectId}`;
  const day = 86_400_000, now = Date.now();
  const at = (days: number) => new Date(now - days * day).toISOString();
  const stuckId = "70000204-0000-4000-8000-000000000204", youngId = "70000203-0000-4000-8000-000000000203";
  const decisions = [
    { kind: "decision_request", id: "d0000001-0000-4000-8000-000000000001", title: "是否采用新的验收约定", detail: "需要你选", proposedBy: "leader", at: at(2), taskId: "70000202-0000-4000-8000-000000000202", options: ["采用", "不采用"], version: 1 },
    { kind: "role_proposal", id: "d0000002-0000-4000-8000-000000000002", title: "新增文档职责", detail: "提案", proposedBy: "leader", at: at(1), roleId: "d0000003-0000-4000-8000-000000000003", version: 1 },
  ];
  const mine = { items: [{ projectId, relayId: "a0000001-0000-4000-8000-000000000001", taskId: "70000206-0000-4000-8000-000000000206", taskRevisionId: "70000301-0000-4000-8000-000000000301", deliveryId: "70000501-0000-4000-8000-000000000501",
    stage: "candidate", scopeKey: "k", scopeDescription: "候选验收范围", entrypoint: null, publicationRef: null, version: 1, createdAt: at(1), readAt: null, observationId: null }] };
  const holds = { observedAtUtc: at(0), items: [{ projectId, id: "b0000001-0000-4000-8000-000000000001", provider: "claude", state: "held", category: "quota_exhausted", causeSessionId: null, causeMessageId: null,
    reason: "额度", version: 1, openedAt: at(1), releasedAt: null, releasedBy: null, releaseReason: null, releaseSummary: null,
    impact: [{ sessionId: "c0000001-0000-4000-8000-000000000001", gatePhase: null, blockedByQuotaFailure: true, queuedMessages: 1 }], queuedMessages: 1 }] };
  const open = async (width: number, height: number, mode: "full" | "empty" | "failing" = "full", colorScheme: "light" | "dark" = "light") => {
    const context = await browser.newContext({ viewport: { width, height }, locale: "zh-CN", colorScheme });
    const page = await context.newPage(); page.on("pageerror", error => errors.push(error.message));
    await page.route(`${api}/decisions-for-me`, route => mode === "failing" ? route.fulfill({ status: 500, json: { code: "X", message: "boom" } }) : route.fulfill({ json: { items: mode === "full" ? decisions : [], observedAt: at(0) } }));
    await page.route(`${api}/acceptance-relay/mine`, route => route.fulfill({ json: mode === "full" ? mine : { items: [] } }));
    await page.route(`${api}/runtime/provider-holds`, route => route.fulfill({ json: mode === "full" ? holds : { items: [], observedAtUtc: at(0) } }));
    await page.route(`${api}/impacts`, route => route.fulfill({ json: [] }));
    await page.route(`${api}/runtime/usage*`, route => route.fulfill({ status: 404, json: { code: "USAGE_UNAVAILABLE", message: "Usage accounting is unavailable" } }));
    await page.route(`${api}/work-management/index*`, async route => {
      const response = await route.fetch(); const value = await response.json();
      const items = value.items.map((item: Json) => {
        if (item.taskId === stuckId) return { ...item, latestProgress: { ...item.latestProgress, changedAt: at(mode === "empty" ? 0 : 4) }, dates: { ...item.dates, businessChangedAt: at(mode === "empty" ? 0 : 4) } };
        if (item.taskId === youngId) return { ...item, latestProgress: { ...item.latestProgress, changedAt: at(mode === "empty" ? 0 : 1) }, dates: { ...item.dates, businessChangedAt: at(mode === "empty" ? 0 : 1) } };
        // The first task's delivery declares the signed-in person as consumer; a copy makes a second one.
        return item.delivery && mode !== "empty" ? { ...item, delivery: { ...item.delivery, consumer: "zhang-reviewer" } } : item;
      });
      const copy = mode === "empty" ? null : items.find((item: Json) => item.delivery);
      if (copy) items.push({ ...copy, taskId: "70000299-0000-4000-8000-000000000299", title: "第二项要亲自用的交付", delivery: { ...copy.delivery, deliveryId: "70000599-0000-4000-8000-000000000599", useRequired: false } });
      await route.fulfill({ response, json: { ...value, items } });
    });
    await page.goto(`${fx.base}/p/${projectId}/overview`);
    await page.getByLabel("访问令牌").fill(token); await page.getByRole("button", { name: "进入", exact: true }).click();
    await page.locator("[data-overview-stages] [data-stage-row], [data-overview-stages] [data-no-stages]").first().waitFor({ timeout: 15000 });
    await page.waitForTimeout(800);
    return page;
  };

  const readings: unknown[] = [];
  for (const [width, height] of [[1440, 900], [390, 844]] as const) {
    const page = await open(width, height);
    // The first screen with this sample (each block 2 or more rows, ① 5 rows of which 3 show): bottoms against the lower edge (the phone's 64px tab bar covers the bottom of 390x844).
    const edge = height - (width >= 1000 ? 0 : 64);
    const read = await page.evaluate(`(() => { const b = s => { const e = document.querySelector(s); return e ? Math.round(e.getBoundingClientRect().bottom) : null; };
      return { priority: b("[data-overview-block=priority]"), useTitle: b("[data-overview-block=use] h2"), use: b("[data-overview-block=use]"), outcome: b("[data-overview-block=outcome]"), stagesTitle: b("[data-overview-stages] h2") }; })()`) as Record<string, number>;
    readings.push({ view: `${width}x${height}`, edge, ...read });
    assert.ok(read.priority! <= edge && read.useTitle! <= edge, `① whole and the title of ② are on the first screen at ${width}x${height} ${JSON.stringify(read)}`);
    if (width >= 1000) assert.ok(read.use! <= edge && read.outcome! <= edge && read.stagesTitle! <= edge, `①②③ and the 阶段 title row at ${width}x${height} ${JSON.stringify(read)}`);
    if (shots) await page.screenshot({ path: `${shots}/overview-first-${width}-light.png` });
    const priority = page.locator("[data-overview-block=priority]");
    // 1 运行问题 + 2 待决定 + 1 待验收 + 1 卡了 4 天 = 5; the 1-day task only counts in the one line; ② is 2 deliveries, so 待我处理 would show 5 + 2.
    assert.match(await priority.locator("h2").innerText(), /^要你决定或处理的 · 5$/);
    assert.equal(await priority.locator("li").count(), 3, "three rows at first");
    const rows = priority.locator("li a");
    assert.match(await rows.nth(0).innerText(), /Claude/, "the runtime problem is first");
    assert.match(await rows.nth(0).getAttribute("href") ?? "", /\/sessions\?session=owned%3Ac0000001/, "it opens the stopped agent");
    assert.match(await rows.nth(1).innerText(), /是否采用新的验收约定/);
    assert.match(await rows.nth(1).getAttribute("href") ?? "", new RegExp(`/tasks/70000202-0000-4000-8000-000000000202\\?.*return=%2Fp%2F${projectId}%2Foverview`), "a decision opens its own task and leads back here");
    assert.match(await rows.nth(2).innerText(), /新增文档职责/);
    assert.match(await rows.nth(2).getAttribute("href") ?? "", /\/roles\?role=d0000003/);
    await priority.getByRole("button", { name: "还有 2 项" }).click();
    assert.equal(await priority.locator("li").count(), 5, "the rest open in place");
    assert.match(await priority.locator("li").nth(3).innerText(), /候选验收|待你验收/);
    const stalled = priority.locator("li").nth(4);
    assert.match(await stalled.innerText(), /卡了 4 天/);
    assert.match(await stalled.locator("a").getAttribute("href") ?? "", /\/tasks\/70000204-0000-4000-8000-000000000204$/);
    assert.equal(await priority.getByRole("link", { name: "全部在待我处理" }).getAttribute("href"), `/p/${projectId}/inbox`);
    assert.doesNotMatch(await priority.innerText(), /卡了 1 天/, "a task stalled for under three days is not a row");
    const use = page.locator("[data-overview-block=use]");
    assert.equal(await use.locator("li").count(), 2);
    assert.match(await use.locator("li").first().innerText(), /必须使用才能关闭|只是声明的使用者/);
    assert.match(await use.locator("li a").first().getAttribute("href") ?? "", /\/tasks\/[^?]+\?tab=delivery/, "a delivery opens the task's 交付与使用");
    assert.match(await page.locator("[data-overview-block=outcome]").innerText(), /最近没有使用反馈。/);
    // ⑤ the counts are the index's own, the longest wait is the stalled task's; opening shows the 调度动态.
    const line = page.locator("[data-overview-block=organisation]");
    assert.match(await line.locator("summary").innerText(), /^组织自己在处理：运行中 1 · 待返工 1 · 待验收 1 · 受阻 1（最久 4 天）$/);
    assert.equal(await line.evaluate(node => (node as HTMLDetailsElement).open), false);
    await line.locator("summary").click();
    await line.getByRole("region", { name: "调度动态" }).waitFor();
    // ⑥ one line each, folded; the original cards are inside.
    assert.match(await page.locator("[data-overview-goal] > summary").innerText(), /^目标：/);
    assert.match(await page.locator("[data-overview-version] > summary").innerText(), /^线上版本/);
    await page.locator("[data-overview-goal] > summary").click();
    await page.locator("[data-overview-goal] .overview-goal").waitFor();
    assert.ok(await page.locator("[data-overview-goal]").innerText().then(text => text.includes("阶段交付") || text.includes("没有读到正在推进的阶段")), "the goal card keeps its content");
    // The right column is closed by default at every width.
    assert.equal(await page.getByRole("complementary", { name: "右栏" }).count() === 0 || !(await page.getByRole("complementary", { name: "右栏" }).isVisible()), true, "the information column starts closed");
    // The header links to the latest 复盘; there is no 每日简报 entry yet.
    assert.equal(await page.locator("[data-overview-latest-review]").count(), 1);
    assert.equal(await page.getByRole("link", { name: "每日简报" }).count(), 0);
    await page.context().close();
  }

  if (shots) {
    const dark = await open(1440, 900, "full", "dark");
    await dark.screenshot({ path: `${shots}/overview-first-1440-dark.png` });
    const darkPhone = await open(390, 844, "full", "dark");
    await darkPhone.screenshot({ path: `${shots}/overview-first-390-dark.png` });
    await dark.context().close(); await darkPhone.context().close();
    const { writeFile } = await import("node:fs/promises"); await writeFile(`${shots}/overview-first-readings.json`, JSON.stringify(readings, null, 1));
  }
  // Nothing waits: each block says so in one line, and the count is 0.
  const calm = await open(1440, 900, "empty");
  assert.match(await calm.locator("[data-overview-block=use]").innerText(), /现在没有等你亲自用的交付/);
  assert.match(await calm.locator("[data-overview-block=priority]").innerText(), /现在没有等你决定或处理的事。/);
  assert.match(await calm.locator("[data-overview-block=priority] h2").innerText(), /^要你决定或处理的 · 0$/);
  await calm.context().close();

  // A read that fails never says "nothing": the failing list is named and can be read again.
  const failing = await open(1440, 900, "failing");
  await failing.locator("[data-overview-block=priority]").getByText(/没读到/).waitFor({ timeout: 20000 }); // the read is tried again before it counts as failed
  const text = await failing.locator("[data-overview-block=priority]").innerText();
  assert.match(text, /没读到（待我决定）/);
  assert.ok(!/现在没有等你决定或处理的事/.test(text));
  await failing.getByRole("button", { name: "重试" }).first().waitFor();
  await failing.context().close();
  assert.deepEqual(errors, []);
});
