// Task 13518ac6, in a real browser over the built workbench and the fixture service: business nodes (接手, 交付, 验收结论, 关闭) stand between the
// timeline rounds by time, each work round ends with what it delivered, older nodes come with older history, and coordination folding is unchanged.
// Needs EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE (CI sets it with EVOLOOP_BROWSER_TEST_REQUIRED=1). EVOLOOP_TIMELINE_CAPTURE_DIR saves screenshots.
import assert from "node:assert/strict";
import { test } from "node:test";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const modulePath = process.env.EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE;
const required = process.env.EVOLOOP_BROWSER_TEST_REQUIRED === "1";
const executablePath = process.env.EVOLOOP_BROWSER_TEST_EXECUTABLE_PATH || process.env.EVOLOOP_BROWSER_TEST_CHROMIUM_EXECUTABLE || undefined;
const captureDir = process.env.EVOLOOP_TIMELINE_CAPTURE_DIR;
const dist = resolve(import.meta.dirname, "../dist");
const frontend = resolve(import.meta.dirname, "../../../scripts/frontend");
const skip = !required && !modulePath && "Set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE after building the workbench";

type Json = Record<string, unknown>;

test("business nodes stand between the rounds by time; work rounds say what they delivered; older nodes come with older history", { skip }, async t => {
  assert.ok(modulePath, "EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE is required when EVOLOOP_BROWSER_TEST_REQUIRED=1");
  const { chromium } = (await import(pathToFileURL(modulePath).href)).default;
  const { startFixtureServer } = await import(pathToFileURL(`${frontend}/fixture/server.mjs`).href);
  const common = await import(pathToFileURL(`${frontend}/fixture/common.mjs`).href);
  const { scenes } = await import(pathToFileURL(`${frontend}/pages.mjs`).href);
  const scene = scenes.find((candidate: { name: string }) => candidate.name === "agent");
  assert.ok(scene, "scene agent");
  const { token, actorId, ago } = common as { token: string; actorId: string; ago: (minutes: number) => string };
  const fixture = await startFixtureServer(dist); t.after(() => fixture.close());
  const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) }); t.after(() => browser.close());

  const taskId = "70000000-0000-4000-8000-000000000011";
  const otherTask = "70000000-0000-4000-8000-0000000000ff";
  const title = "做表格视图";
  const dispatchOf = { source: "leader", actorId: "leader-1", viaController: true, scheduleId: null, scheduleTitle: null, reworkObservationId: null, reworkDeliveryId: null };
  const runOrigin = (id: string) => ({ kind: "run", id, taskId, taskRevisionId: null, initiatingActorId: "leader-1", dispatch: dispatchOf });
  const runInput = (id: string, minutes: number, turnId: string) => ({ id: `message:${id}`, kind: "message", role: "input", phase: "unknown", body: "", clientId: null,
    state: "completed", turnId, nativeItemId: `in-${id}`, nativeKind: "userMessage", author: { kind: "native", id: null, label: "原生" },
    origin: runOrigin(id), occurredAt: ago(minutes), observedAt: ago(minutes), freshness: "persisted", truncated: false });
  const input = (id: string, who: string, body: string, minutes: number, turnId: string | null) => ({ id: `message:${id}`, kind: "message", role: "input", phase: "unknown", body,
    clientId: id, state: "completed", turnId, nativeItemId: turnId ? `in-${id}` : null, nativeKind: turnId ? "userMessage" : null, author: { kind: "actor", id: who, label: who },
    origin: { kind: "message", id, taskId: null, taskRevisionId: null, initiatingActorId: who }, occurredAt: ago(minutes), observedAt: ago(minutes), freshness: "persisted", truncated: false });
  const reply = (id: string, body: string, minutes: number, turnId: string) => ({ id, kind: "message", role: "assistant", phase: "final_answer", body, clientId: null,
    state: "completed", turnId, nativeItemId: id, nativeKind: "agentMessage", author: { kind: "session", id: null, label: "前端实现" }, origin: null,
    occurredAt: ago(minutes), observedAt: ago(minutes), freshness: "persisted", truncated: false });
  const turn = (id: string, minutes: number, origin: Json) => ({ id, state: "completed", startedAt: ago(minutes), completedAt: ago(minutes - 1), origin });
  const dispatch = (n: number) => `Session 队伍轮到任务「任务 ${n}」（${n}），请先做执行确认`;

  const newer = { entries: [runInput("run-3", 150, "t3"), reply("a3", "这一轮只做了确认。", 148, "t3"),
      input("h1", actorId, "请先做表格视图。", 100, "t4"), reply("a4", "收到，表格视图已开始。", 98, "t4")],
    turns: [turn("t3", 150, runOrigin("run-3")), turn("t4", 100, { kind: "message", id: "h1", taskId: null, taskRevisionId: null, initiatingActorId: actorId })],
    pending: ["g1", "g2", "g3"].map((id, index) => input(id, "leader-1", dispatch(index + 1), 130 - index * 0.5, null)) };
  const older = { entries: [runInput("run-1", 300, "t1"), reply("a1", "第一份已提交。", 298, "t1"), runInput("run-2", 200, "t2"), reply("a2", "返工后提交第二份。", 198, "t2")],
    turns: [turn("t1", 300, runOrigin("run-1")), turn("t2", 200, runOrigin("run-2"))], pending: [] };
  const fact = (id: string, who: string, content: string, minutes: number) => ({ projectId: "p", id, operationId: id, target: { kind: "owned", sessionId: "s" }, senderActorId: who, senderClass: who === actorId ? "user" : "leader",
    content, context: null, replyToMessageId: null, state: "replied", version: 1, blockedReason: null, readReceipt: null, createdAt: ago(minutes + 3), updatedAt: ago(minutes) });
  const facts = [...["g1", "g2", "g3"].map((id, index) => fact(id, "leader-1", dispatch(index + 1), 130 - index * 0.5)), fact("h1", actorId, "请先做表格视图。", 100)];

  const node = (id: string, kind: string, minutes: number, body: Json, deliveryNumber = 0) => ({ id: `p:node:${id}`, sequence: "0", sessionKey: "k", kind: `business_${kind}`, summary: "", occurredAt: ago(minutes), recordedAt: ago(minutes),
    actorId: "leader-1", taskId, importance: "important", source: { kind: "task", id: taskId, href: "x", evidence: "project-record", observedAt: ago(0), revision: null }, node: { kind, taskId, title, ...body }, deliveryNumber });
  const nodes = [
    node("close", "closed", 90, { cancelled: false, by: "acceptance-1" }),
    node("used", "observed", 129.2, { deliveryId: "d2", deliveryNumber: 2, result: "used", observer: "acceptance-1", reason: null }),
    node("d2", "delivered", 199.5, { deliveryId: "d2", number: 2, artifact: { kind: "document", label: "表格视图交付报告" }, technicalResult: "passed", by: "dev" }),
    node("fail", "observed", 280, { deliveryId: "d1", deliveryNumber: 1, result: "failed", observer: "acceptance-1", reason: "表头没有对齐。" }),
    node("d1", "delivered", 299.5, { deliveryId: "d1", number: 1, artifact: { kind: "pr", label: "PR #537" }, technicalResult: "passed", by: "dev" }),
    node("acc", "accepted", 310, { by: "leader-1", method: "leader" }),
  ].map(({ deliveryNumber: _ignored, ...rest }) => rest);
  const foreign = { ...nodes[0]!, id: "p:node:foreign", taskId: otherTask, node: { ...(nodes[0]!.node as Json), taskId: otherTask, title: "别的任务" } };

  const open = async (width: number, height: number, colorScheme: "light" | "dark") => {
    const context = await browser.newContext({ viewport: { width, height }, locale: "zh-CN", colorScheme });
    const page = await context.newPage();
    const errors: string[] = []; const nodeRequests: URL[] = []; const timelineRequests: URL[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.route(/\/session-work\/owned%3A[^/?]+\/timeline(\?.*)?$/, async route => {
      const response = await route.fetch(); const body = await response.json() as Json;
      const url = new URL(route.request().url()); timelineRequests.push(url);
      const page2 = url.searchParams.has("cursor");
      const part = page2 ? older : newer;
      await route.fulfill({ response, body: JSON.stringify({ ...body, ...part, nextCursor: page2 ? null : "c1", messagesCursor: null }) });
    });
    await page.route(/\/session-work\/owned%3A[^/?]+\/messages(\?.*)?$/, async route => {
      const response = await route.fetch(); const body = await response.json() as Json;
      await route.fulfill({ response, body: JSON.stringify({ ...body, items: facts, nextCursor: null }) });
    });
    await page.route(/\/session-work\/owned%3A[^/?]+\/activities\?.*business=1/, async route => {
      const response = await route.fetch(); const body = await response.json() as Json;
      const url = new URL(route.request().url()); nodeRequests.push(url);
      const since = url.searchParams.get("since"); const floor = since ? Date.parse(since) : -Infinity;
      // Another agent's Task never reaches the page from the real reader; this one would, so the page must show it only if the reader sent it.
      const items = [...nodes, ...(url.searchParams.get("foreign") ? [foreign] : [])].filter(item => Date.parse(item.occurredAt) >= floor - 1000);
      await route.fulfill({ response, body: JSON.stringify({ ...body, items, nextCursor: null }) });
    });
    await page.goto(`${fixture.base}${scene.path}`);
    await page.getByLabel("访问令牌").fill(token); await page.getByRole("button", { name: "进入", exact: true }).click();
    const timeline = page.getByRole("log", { name: "消息与工具时间线" });
    await timeline.waitFor();
    await page.waitForTimeout(2500);
    return { page, context, errors, nodeRequests, timelineRequests, timeline };
  };
  const nodeLines = (timeline: import("playwright-core").Locator) => timeline.locator("[data-business-node]").evaluateAll(els => els.map(el => ({
    kind: el.getAttribute("data-business-node"), text: (el.textContent ?? "").replace(/\s+/g, " ").trim(), href: el.querySelector("a")?.getAttribute("href") ?? null })));

  await t.test("newest page: only nodes in range, in time order, outside the folded group; the history comes with its nodes", async () => {
    const { page, context, errors, nodeRequests, timeline } = await open(1440, 900, "light");
    t.after(() => context.close());
    let lines = await nodeLines(timeline);
    assert.deepEqual(lines.map(line => line.kind), ["observed", "closed"], "only the nodes inside the loaded range");
    assert.match(lines[0]!.text, /验收.*已使用.*acceptance-1/); assert.match(lines[1]!.text, /任务已关闭 · acceptance-1/);
    assert.match(lines[0]!.href ?? "", new RegExp(`${taskId}.*tab=delivery.*delivery=d2|tab=delivery.*delivery=d2.*${taskId}|delivery=d2`));
    assert.ok(lines[1]!.href?.includes(taskId) && !lines[1]!.href?.includes("tab=delivery"), "closing lands on the Task");
    assert.ok(nodeRequests.length >= 1); assert.ok(nodeRequests.every(url => url.searchParams.get("business") === "1" && url.searchParams.get("since")), "business read with since");
    const olderTimes = Date.parse(nodeRequests[0]!.searchParams.get("since")!);
    assert.ok(Math.abs(olderTimes - Date.parse(ago(150))) < 5000, "since is the earliest loaded round");
    // Rounds: the work round with no delivery says so; the reply round says neither.
    const text = (await timeline.innerText());
    assert.match(text, /这一轮没有交付/); assert.equal((text.match(/这一轮没有交付/g) ?? []).length, 1);
    assert.doesNotMatch(text, /交付了第/);
    // Folding unchanged and nodes outside the group: the group stays one line and the used node comes after it in the DOM.
    assert.match(text, /Leader 的 3 条协调消息/);
    const order = await timeline.evaluate(el => { const all = [...el.querySelectorAll("[data-business-node], [data-coordination-group], article, section")]; return all.length; });
    assert.ok(order > 0);
    const usedAfterGroup = await page.evaluate(() => {
      const root = document.querySelector("[role=log]")!; const walker = [...root.querySelectorAll("*")];
      const group = walker.find(el => /Leader 的 3 条协调消息/.test(el.textContent ?? "") && el.children.length < 8 && !el.querySelector("[data-business-node]"));
      const used = root.querySelector("[data-business-node=observed]");
      return !!group && !!used && !!(group.compareDocumentPosition(used) & Node.DOCUMENT_POSITION_FOLLOWING) && !group.contains(used);
    });
    assert.ok(usedAfterGroup, "the conclusion stands after the folded group, not inside it");
    if (captureDir) await page.screenshot({ path: `${captureDir}/business-nodes-1440-light.png` });

    await page.getByRole("button", { name: "加载更早的消息与活动" }).click();
    await page.waitForTimeout(2500);
    lines = await nodeLines(timeline);
    assert.deepEqual(lines.map(line => line.kind), ["accepted", "delivered", "observed", "delivered", "observed", "closed"], "older nodes arrive with the older history, in time order");
    assert.match(lines[0]!.text, /接手了「做表格视图」 · leader-1分派/);
    assert.match(lines[1]!.text, /提交了第 1 份交付 · PR #537/); assert.match(lines[2]!.text, /验收：使用失败（第 1 份） · acceptance-1 · 表头没有对齐。/);
    assert.match(lines[3]!.text, /提交了第 2 份交付 · 表格视图交付报告/);
    for (const index of [1, 2, 3]) assert.ok(lines[index]!.href?.includes("tab=delivery"), `node ${index} lands on 交付与使用`);
    assert.ok(lines[0]!.href?.includes(taskId) && !lines[0]!.href?.includes("tab=delivery"));
    assert.ok(nodeRequests.some(url => !url.searchParams.get("since")), "once no history is left the read is unbounded in the past");
    const full = await timeline.innerText();
    assert.match(full, /交付了第 1 份（PR #537）/); assert.match(full, /交付了第 2 份（表格视图交付报告）/);
    assert.equal((full.match(/这一轮没有交付/g) ?? []).length, 1);
    assert.match(full, /Leader 的 3 条协调消息/);
    const links = await timeline.locator("a[data-turn-delivery]").evaluateAll(els => els.map(el => el.getAttribute("href")));
    assert.equal(links.length, 2); assert.ok(links.every(href => href?.includes("tab=delivery") && href.includes(taskId)));
    assert.deepEqual(errors, []);
  });

  for (const [width, height, scheme] of [[390, 844, "light"], [1440, 900, "dark"], [390, 844, "dark"]] as const) {
    await t.test(`no horizontal overflow and nodes readable at ${width} ${scheme}`, async () => {
      const { page, context, errors, timeline } = await open(width, height, scheme);
      t.after(() => context.close());
      await page.getByRole("button", { name: "加载更早的消息与活动" }).click();
      await page.waitForTimeout(2500);
      assert.equal((await nodeLines(timeline)).length, 6);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), "no page-level horizontal overflow");
      if (captureDir) {
        await timeline.locator("[data-business-node]").first().scrollIntoViewIfNeeded();
        await page.screenshot({ path: `${captureDir}/business-nodes-${width}-${scheme}.png` });
      }
      assert.deepEqual(errors, []);
    });
  }
});
