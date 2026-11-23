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
  // Four tasks with a recorded use; the newest feedback is on the oldest revision (revisionDays) so a sort by the record's time would drop it.
  const feedback = [
    { taskId: "70000206-0000-4000-8000-000000000206", deliveryId: "70000a06-0000-4000-8000-000000000a06", result: "used", kind: "human", observer: "zhang", days: 0.1, revisionDays: 20 },
    { taskId: "70000202-0000-4000-8000-000000000202", deliveryId: "70000a02-0000-4000-8000-000000000a02", result: "failed", kind: "agent", observer: "acceptance-agent", days: 0.5, revisionDays: 8 },
    { taskId: "70000203-0000-4000-8000-000000000203", deliveryId: "70000a03-0000-4000-8000-000000000a03", result: "notUsed", kind: "agent", observer: "user-sim", days: 1, revisionDays: 4 },
    { taskId: "70000201-0000-4000-8000-000000000201", deliveryId: "70000a01-0000-4000-8000-000000000a01", result: "used", kind: "human", observer: "li", days: 2, revisionDays: 0 },
  ];
  const open = async (width: number, height: number, mode: "full" | "empty" | "failing" | "allfail" | "multi" | "outcomes" = "full", colorScheme: "light" | "dark" = "light") => {
    const context = await browser.newContext({ viewport: { width, height }, locale: "zh-CN", colorScheme });
    const page = await context.newPage(); page.on("pageerror", error => errors.push(error.message));
    await page.route(`${api}/decisions-for-me`, route => mode === "failing" || mode === "allfail" ? route.fulfill({ status: 500, json: { code: "X", message: "boom" } }) : route.fulfill({ json: { items: mode === "full" || mode === "multi" ? decisions : [], observedAt: at(0) } }));
    const loaded = mode === "full" || mode === "multi";
    const failAll = (route: Json) => route.fulfill({ status: 500, json: { code: "X", message: "boom" } });
    await page.route(`${api}/acceptance-relay/mine`, route => mode === "allfail" ? failAll(route) : route.fulfill({ json: loaded ? mine : { items: [] } }));
    await page.route(`${api}/runtime/provider-holds`, route => mode === "allfail" ? failAll(route)
      : route.fulfill({ json: mode === "multi" ? { ...holds, items: [{ ...holds.items[0], impact: [...holds.items[0].impact, { ...holds.items[0].impact[0], sessionId: "c0000002-0000-4000-8000-000000000002" }] }] } : mode === "full" ? holds : { items: [], observedAtUtc: at(0) } }));
    await page.route(`${api}/impacts`, route => mode === "allfail" ? failAll(route) : route.fulfill({ json: [] }));
    await page.route(`${api}/runtime/usage*`, route => route.fulfill({ status: 404, json: { code: "USAGE_UNAVAILABLE", message: "Usage accounting is unavailable" } }));
    await page.route(`${api}/work-management/index*`, async route => {
      const response = await route.fetch(); const value = await response.json();
      const items = value.items.map((item: Json) => {
        if (item.taskId === stuckId) return { ...item, latestProgress: { ...item.latestProgress, changedAt: at(mode === "empty" ? 0 : 4) }, dates: { ...item.dates, businessChangedAt: at(mode === "empty" ? 0 : 4) } };
        if (item.taskId === youngId) return { ...item, latestProgress: { ...item.latestProgress, changedAt: at(mode === "empty" ? 0 : 1) }, dates: { ...item.dates, businessChangedAt: at(mode === "empty" ? 0 : 1) } };
        // The first task's delivery declares the signed-in person as consumer; a copy makes a second one.
        return item.delivery && loaded ? { ...item, delivery: { ...item.delivery, consumer: "zhang-reviewer" } } : item;
      });
      if (mode === "outcomes") for (const item of items) {
        const known = feedback.find(entry => entry.taskId === item.taskId);
        if (!known) continue;
        item.delivery = { deliveryId: known.deliveryId, taskRevisionId: item.currentRevisionId, technicalResult: "passed", consumer: null, useRequired: false, observationResult: known.result, observationActorId: known.observer, observationKind: known.kind };
        item.timing = { ...item.timing, rounds: [{ number: 1, startedAt: at(9), endedAt: null, elapsedMs: null, intervals: [
          { stage: "awaiting_acceptance", startedAt: at(known.days + 1), endedAt: at(known.days), source: { kind: "observation", id: `o-${known.deliveryId}-0` }, waitingFor: { kind: "consumer", id: null } },
          { stage: "awaiting_acceptance", startedAt: at(known.days), endedAt: null, source: { kind: "observation", id: `o-${known.deliveryId}` }, waitingFor: { kind: "consumer", id: null } }] }] };
        // The record's own time says the opposite of the feedback time: the oldest feedback sits on the newest revision.
        item.dates = { ...item.dates, businessChangedAt: at(known.revisionDays) };
      }
      const copy = mode === "empty" || mode === "outcomes" ? null : items.find((item: Json) => item.delivery);
      if (copy) items.push({ ...copy, taskId: "70000299-0000-4000-8000-000000000299", title: "第二项要亲自用的交付", delivery: { ...copy.delivery, deliveryId: "70000599-0000-4000-8000-000000000599", useRequired: false } });
      await route.fulfill({ response, json: { ...value, items } });
    });
    if (mode === "outcomes") {
      await page.route(`${api}/orchestration/work-status*`, route => route.fulfill({ json: { items: feedback.map(known => ({ taskId: known.taskId, cognition: false, dispatchId: null, dispatchState: null, outcome: null, runId: null, runState: null,
        unsettledRunState: null, loopState: null, goalOutcome: null, stageDeliverable: null, sourceKind: null, sourceTaskId: null, sourceTaskTitle: null, decisionKind: null, decisionReason: null,
        useRequired: false, deliveryId: known.deliveryId, technicalResult: "passed", observationResult: known.result, observerKind: known.kind, hasClosure: false, readyForAcceptance: false })) } }));
      await page.route(`${api}/tasks/*`, async route => {
        const known = feedback.find(entry => route.request().url().endsWith(`/tasks/${entry.taskId}`));
        if (!known) return route.fallback();
        const response = await route.fetch(); const detail = await response.json();
        await route.fulfill({ response, json: { ...detail, deliveries: [{ ...(detail.deliveries?.[0] ?? {}), id: known.deliveryId, taskId: known.taskId, projectId }],
          observations: [{ id: `o-${known.deliveryId}`, deliveryId: known.deliveryId, result: known.result, observerKind: known.kind, observer: known.observer, createdAt: at(known.days) }] } });
      });
    }
    await page.goto(`${fx.base}/p/${projectId}/overview`);
    await page.getByLabel("访问令牌").fill(token); await page.getByRole("button", { name: "进入", exact: true }).click();
    await page.locator("[data-overview-stages] [data-stage-row], [data-overview-stages] [data-no-stages]").first().waitFor({ timeout: 15000 });
    await page.waitForTimeout(800);
    return page;
  };

  const readings: unknown[] = []; const orders: string[][] = [];
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
    // The header links to the latest 复盘 and, the fixture having a 简报, to the latest 每日简报 (overview-finish-ci-browser.test.ts covers the choice).
    assert.equal(await page.locator("[data-overview-latest-review]").count(), 1);
    assert.equal(await page.getByRole("link", { name: "每日简报" }).count(), 1);
    // The blocks come in the same order at both widths, and no rule reorders them.
    const order = await page.evaluate(`[...document.querySelectorAll("[data-overview-block], [data-overview-stages], [data-overview-goal], [data-overview-version]")].map(node => node.getAttribute("data-overview-block") ?? (node.hasAttribute("data-overview-stages") ? "stages" : node.hasAttribute("data-overview-goal") ? "goal" : "version"))`) as string[];
    orders.push(order);
    assert.deepEqual(order.slice(0, 4), ["priority", "use", "outcome", "stages"]);
    await page.context().close();
  }
  assert.deepEqual(orders[0], orders[1], "the same order at 1440 and 390");

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
  assert.match(await calm.locator("[data-overview-block=outcome]").innerText(), /最近没有使用反馈。/);
  assert.ok(await calm.locator("[data-overview-stages] [data-stage-row]").count() > 0, "with nothing waiting the whole 阶段 block is on the page");
  const calmRead = await calm.evaluate(`(() => { const b = s => Math.round(document.querySelector(s).getBoundingClientRect().bottom); return { stage: b("[data-overview-stages]"), edge: innerHeight }; })()`) as Record<string, number>;
  assert.ok(calmRead.stage <= calmRead.edge, `the whole 阶段 block is on the first screen when nothing waits ${JSON.stringify(calmRead)}`);
  await calm.context().close();

  // A read that fails never says "nothing": the failing list is named and can be read again.
  const failing = await open(1440, 900, "failing");
  await failing.locator("[data-overview-block=priority]").getByText(/没读到/).waitFor({ timeout: 20000 }); // the read is tried again before it counts as failed
  const text = await failing.locator("[data-overview-block=priority]").innerText();
  assert.match(text, /没读到（待我决定）/);
  assert.ok(!/现在没有等你决定或处理的事/.test(text));
  await failing.getByRole("button", { name: "重试" }).first().waitFor();
  await failing.context().close();
  // The numbers agree: ① (without the stalled row) + ② is what the entry says, and the 待我处理 page's own sections add up to the same.
  const agree = await open(1440, 900);
  const dot = Number((await agree.locator('a[href$="/inbox"]').filter({ hasText: "待我处理" }).first().innerText()).replace(/\D/g, ""));
  const inbox = Number((await agree.locator("[data-overview-block=priority] h2").innerText()).replace(/\D/g, "")) - 1 + await agree.locator("[data-overview-block=use] li").count();
  assert.equal(dot, inbox, "the entry's number is ①'s inbox rows plus ②'s rows");
  await agree.locator('a[href$="/inbox"]').filter({ hasText: "待我处理" }).first().click();
  await agree.locator("[data-inbox]").waitFor();
  await agree.waitForTimeout(800);
  let pageTotal = 0;
  for (const name of ["只有你能办的运行问题", "待我验收", "等我使用的交付", "待我决定", "依据变化", "用量与上下文告警"]) {
    const section = agree.locator(`section[aria-label="${name}"]`);
    if (await section.count()) pageTotal += Number((await section.locator("h2 + span").first().innerText()).replace(/\D/g, "") || 0);
  }
  assert.equal(pageTotal, dot, "the 待我处理 page's categories add up to the entry's number");
  await agree.context().close();

  // One hold that stops several agents has no single object: its row has the 受阻 mark and opens the runtime category of 待我处理, which is brought into view.
  const multi = await open(1440, 900, "multi");
  const holdRow = multi.locator("[data-overview-block=priority] li").first();
  assert.equal(await holdRow.locator("[data-tone=blocked]").innerText(), "受阻", "the runtime-problem row carries the 受阻 status mark");
  assert.equal(await holdRow.locator("a").getAttribute("href"), `/p/${projectId}/inbox#inbox-runtime`, "several agents: the runtime category, not the agent directory");
  await holdRow.locator("a").click();
  await multi.locator("section[aria-label='只有你能办的运行问题']").waitFor();
  assert.equal(new URL(multi.url()).hash, "#inbox-runtime");
  await multi.context().close();

  // The three most recently registered feedbacks, one of each result, by the feedback's own time (the newest is on the oldest revision; the fourth is dropped).
  const results = await open(1440, 900, "outcomes");
  const outcome = results.locator("[data-overview-block=outcome]");
  await outcome.locator("li").first().waitFor({ timeout: 15000 });
  const lines = await outcome.locator("li").allInnerTexts();
  assert.equal(lines.length, 3);
  assert.match(lines[0], /真人 zhang 已使用/); assert.match(lines[1], /智能体 acceptance-agent 使用失败/); assert.match(lines[2], /智能体 user-sim 未使用/);
  assert.ok(!(await outcome.innerText()).includes("真人 li"), "the oldest feedback is not shown");
  assert.match(await outcome.locator("li a").first().getAttribute("href") ?? "", /\/tasks\/70000206[^?]*\?tab=delivery/);
  await results.context().close();

  // The whole inbox column cannot be read: ① says so and offers a retry, and never says "nothing".
  const broken = await open(1440, 900, "allfail");
  await broken.locator("[data-overview-block=priority]").getByText(/读不到/).waitFor({ timeout: 25000 }); // each read is tried again before it counts as failed
  const brokenText = await broken.locator("[data-overview-block=priority]").innerText();
  assert.match(brokenText, /这一栏读不到/);
  assert.ok(!/现在没有等你决定或处理的事/.test(brokenText));
  await broken.locator("[data-overview-block=priority]").getByRole("button", { name: "重试" }).waitFor();
  await broken.context().close();

  assert.deepEqual(errors, []);
});
