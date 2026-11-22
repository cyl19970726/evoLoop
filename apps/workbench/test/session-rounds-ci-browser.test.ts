// Task f2d82dfe, in a real browser over the built workbench and the fixture service: the Session timeline reads as rounds of work
// (source line → the agent's reply → result), opens on the last reply, shows every time, folds the Leader's coordination messages into one
// line (three or more in a row into a group), and says the same thing about a person's message in the header, the bubble and the right rail.
// Needs EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE (CI sets it with EVOLOOP_BROWSER_TEST_REQUIRED=1).
import assert from "node:assert/strict";
import { test } from "node:test";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const modulePath = process.env.EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE;
const required = process.env.EVOLOOP_BROWSER_TEST_REQUIRED === "1";
const executablePath = process.env.EVOLOOP_BROWSER_TEST_EXECUTABLE_PATH || process.env.EVOLOOP_BROWSER_TEST_CHROMIUM_EXECUTABLE || undefined;
const dist = resolve(import.meta.dirname, "../dist");
const frontend = resolve(import.meta.dirname, "../../../scripts/frontend");
const skip = !required && !modulePath && "Set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE after building the workbench";

type Json = Record<string, unknown>;

test("the timeline reads as rounds: last reply on open, times, task-named sources, folded coordination, one wording for a person's message", { skip }, async t => {
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

  // The fixture's own timeline gives the page its shape; the test replaces the entries and the saved messages.
  const taskId = "70000000-0000-4000-8000-000000000011";
  const runInput = (id: string, minutes: number, turnId: string) => ({ id: `message:${id}`, kind: "message", role: "input", phase: "unknown", body: "", clientId: null,
    state: "completed", turnId, nativeItemId: `in-${id}`, nativeKind: "userMessage", author: { kind: "native", id: null, label: "原生" },
    origin: { kind: "run", id, taskId, taskRevisionId: null, initiatingActorId: "leader-1" }, occurredAt: ago(minutes), observedAt: ago(minutes), freshness: "persisted", truncated: false });
  const input = (id: string, who: string, body: string, minutes: number, turnId: string | null) => ({ id: `message:${id}`, kind: "message", role: "input", phase: "unknown", body,
    clientId: id, state: "completed", turnId, nativeItemId: turnId ? `in-${id}` : null, nativeKind: turnId ? "userMessage" : null, author: { kind: "actor", id: who, label: who },
    origin: { kind: "message", id, taskId: null, taskRevisionId: null, initiatingActorId: who }, occurredAt: ago(minutes), observedAt: ago(minutes), freshness: "persisted", truncated: false });
  const reply = (id: string, body: string, minutes: number, turnId: string) => ({ id, kind: "message", role: "assistant", phase: "final_answer", body, clientId: null,
    state: "completed", turnId, nativeItemId: id, nativeKind: "agentMessage", author: { kind: "session", id: null, label: "前端实现" }, origin: null,
    occurredAt: ago(minutes), observedAt: ago(minutes), freshness: "persisted", truncated: false });
  const turn = (id: string, minutes: number, origin: Json | null, state = "completed") => ({ id, state, startedAt: ago(minutes), completedAt: state === "completed" ? ago(minutes - 1) : null, origin });
  const msgOrigin = (id: string, who: string) => ({ kind: "message", id, taskId: null, taskRevisionId: null, initiatingActorId: who });
  const dispatch = (n: number) => `Session 队伍轮到任务「任务 ${n}」（${n}），请先做执行确认`;

  const entries = (running: boolean) => [
    runInput("run-1", 300, "t-run"), reply("a-run", "Run 派发后的回复：已接手任务。", 298, "t-run"),
    input("l5", "leader-1", dispatch(5), 200, "t5"), reply("a5", "已确认任务 5。", 198, "t5"),
    input("l6", "leader-1", dispatch(6), 150, "t6"), reply("a6", "已确认任务 6。", 148, "t6"),
    input("l7", "leader-1", dispatch(7), 100, "t7"), reply("a7", "已确认任务 7。", 98, "t7"),
    { ...input("h1", actorId, "请先做表格视图。", 60, "t8"), state: running ? "running" : "completed" }, ...(running ? [] : [reply("a8", "收到，表格视图已开始。", 58, "t8")]),
  ];
  const turns = (running: boolean) => [turn("t-run", 300, { kind: "run", id: "run-1", taskId, taskRevisionId: null, initiatingActorId: "leader-1" }),
    turn("t5", 200, msgOrigin("l5", "leader-1")), turn("t6", 150, msgOrigin("l6", "leader-1")), turn("t7", 100, msgOrigin("l7", "leader-1")),
    turn("t8", 60, msgOrigin("h1", actorId), running ? "running" : "completed")];
  // Three Leader notices in a row with nothing between them: they fold into a group.
  const notices = ["g1", "g2", "g3"].map((id, index) => input(id, "leader-1", dispatch(index + 1), 400 - index, null));
  const items = [...["g1", "g2", "g3"].map((id, index) => ({ projectId: "p", id, operationId: id, target: { kind: "owned", sessionId: "s" }, senderActorId: "leader-1", senderClass: "leader",
      content: dispatch(index + 1), context: { taskId, taskRevisionId: null }, replyToMessageId: null, state: "replied", version: 1, blockedReason: null, readReceipt: null,
      createdAt: ago(400 - index), updatedAt: ago(400 - index) })),
    ...["l5", "l6", "l7"].map((id, index) => ({ projectId: "p", id, operationId: id, target: { kind: "owned", sessionId: "s" }, senderActorId: "leader-1", senderClass: "leader",
      content: dispatch(index + 5), context: { taskId, taskRevisionId: null }, replyToMessageId: null, state: "replied", version: 1, blockedReason: null, readReceipt: null,
      createdAt: ago(205 - index * 50), updatedAt: ago(205 - index * 50) })),
  ];
  let processedHuman = false;
  const humanFact = () => ({ projectId: "p", id: "h1", operationId: "h1", target: { kind: "owned", sessionId: "s" }, senderActorId: actorId, senderClass: "user",
    content: "请先做表格视图。", context: null, replyToMessageId: null, state: processedHuman ? "replied" : "queued", version: 1, blockedReason: null, readReceipt: null,
    createdAt: ago(65), updatedAt: ago(60), ...(processedHuman ? { processing: { startedAt: ago(60), updatedAt: ago(58), response: "收到，表格视图已开始。", responseKind: "native", nativeTurnId: "t8" } } : {}) });

  type Options = { running: boolean; empty?: boolean; humanOnly?: boolean };
  const open = async (width: number, height: number, options: Options) => {
    const context = await browser.newContext({ viewport: { width, height }, locale: "zh-CN" });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.route(/\/session-work\/owned%3A[^/?]+\/timeline(\?.*)?$/, async route => {
      const response = await route.fetch(); const body = await response.json() as Json;
      // A person's message waiting to be processed is only a saved message; once processing starts it has a native Turn and a reply.
      const waiting = options.humanOnly && !processedHuman;
      const all = options.humanOnly ? (waiting ? [] : [input("h1", actorId, "请先做表格视图。", 60, "t8"), reply("a8", "收到，表格视图已开始。", 58, "t8")]) : entries(options.running);
      const rounds = options.humanOnly ? (waiting ? [] : [turn("t8", 60, msgOrigin("h1", actorId))]) : turns(options.running);
      const pending = waiting ? [input("h1", actorId, "请先做表格视图。", 65, null)] : options.humanOnly ? [] : notices;
      await route.fulfill({ response, body: JSON.stringify(options.empty ? { ...body, entries: [], pending: [], turns: [] }
        : { ...body, entries: all, pending, turns: rounds }) });
    });
    await page.route(/\/session-work\/owned%3A[^/?]+\/messages(\?.*)?$/, async route => {
      const response = await route.fetch(); const body = await response.json() as Json;
      await route.fulfill({ response, body: JSON.stringify({ ...body, items: options.empty ? [] : options.humanOnly ? [humanFact()] : [...items, humanFact()], nextCursor: null }) });
    });
    if (options.running) {
      await page.route(/\/session-messages\/h1(\?.*)?$/, async route => route.fulfill({ contentType: "application/json", body: JSON.stringify({
        message: { ...humanFact(), id: "h1" }, processing: null, metadata: { generatedAt: ago(0), sourceObservedAt: ago(0), partial: false, limitations: [] } }) }));
      await page.route(/\/session-work\/owned%3A[^/?]+$/, async route => {
        const response = await route.fetch(); const body = await response.json() as Json;
        const observation = body.nativeObservation as Json | null;
        await route.fulfill({ response, body: JSON.stringify({ ...body, session: { ...(body.session as Json), busy: true },
          nativeObservation: observation && { ...observation, status: "active", freshness: "live", currentTurn: { id: "t8", status: "inProgress", source: { kind: "message", messageId: "h1", processingId: "pr-1", operationId: "op-1", actorId } } } }) });
      });
      await page.route(/\/runtime$/, async route => {
        const response = await route.fetch(); const body = await response.json() as Json;
        await route.fulfill({ response, body: JSON.stringify({ ...body, available: true, error: null }) });
      });
    }
    await page.goto(`${fixture.base}${scene.path}`);
    await page.getByLabel("访问令牌").fill(token); await page.getByRole("button", { name: "进入", exact: true }).click();
    await page.getByRole("log", { name: "消息与工具时间线" }).waitFor();
    await page.waitForTimeout(options.empty ? 1500 : 2500);
    return { page, context, errors, timeline: page.getByRole("log", { name: "消息与工具时间线" }) };
  };
  const inView = (page: import("playwright-core").Page, selector: string) => page.evaluate(sel => {
    const scroll = document.querySelector<HTMLElement>(".workspace-timeline-scroll")!; const box = scroll.getBoundingClientRect();
    const element = scroll.querySelector<HTMLElement>(sel); if (!element) return null;
    const rect = element.getBoundingClientRect();
    return { top: rect.top >= box.top - 1, visible: rect.top < box.bottom && rect.bottom > box.top, scrollBottom: scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight };
  }, selector);

  // 1 + 2 + 3 + 4 + 5: the first screen, at 1440 and 900 wide.
  for (const [width, height] of [[1440, 900], [900, 900]] as const) {
    const { page, context, errors, timeline } = await open(width, height, { running: false });
    const last = await inView(page, "[data-last-reply]");
    assert.ok(last?.visible, `${width}: the first screen shows the last reply (${JSON.stringify(last)})`);
    assert.match(await timeline.locator("[data-last-reply]").innerText(), /收到，表格视图已开始/, `${width}: the last reply is the agent's latest one`);

    const capture = process.env.EVOLOOP_TIMELINE_CAPTURE_DIR;
    if (capture) await page.screenshot({ path: resolve(capture, `rounds-${width}-open.png`) });
    // 5: dispatch notices are one line by default; three in a row group; expanding shows the full text in place.
    const lines = timeline.locator("[data-coordination-line]");
    assert.ok(await lines.count() >= 3, `${width}: at least three Leader coordination lines`);
    const firstLine = lines.nth(await lines.count() - 1);
    assert.match(await firstLine.innerText(), /执行确认请求 · 任务 7 · /, "the folded line says kind · task title");
    assert.ok((await firstLine.boundingBox())!.height < 64, `${width}: a folded notice is one line`);
    // 2: each coordination message is followed by the agent's reply, right below it.
    for (const [text, answer] of [["任务 5", "已确认任务 5。"], ["任务 6", "已确认任务 6。"], ["任务 7", "已确认任务 7。"]] as const) {
      const order = await page.evaluate(([notice, reply]) => {
        const scroll = document.querySelector<HTMLElement>(".workspace-timeline-scroll")!;
        const all = [...scroll.querySelectorAll<HTMLElement>("[data-workspace-entry]")];
        const line = all.findIndex(element => element.hasAttribute("data-coordination-line") && element.textContent!.includes(`· ${notice} ·`));
        const replyAt = all.findIndex(element => element.textContent!.includes(reply) && !element.hasAttribute("data-coordination-line"));
        return { line, replyAt };
      }, [`任务 ${text.slice(-1)}`, answer]);
      assert.ok(order.line >= 0 && order.replyAt === order.line + 1, `${width}: the reply to ${text} is right below it (${JSON.stringify(order)})`);
    }
    const group = timeline.locator("[data-coordination-group]");
    assert.equal(await group.count(), 1, `${width}: three bare notices in a row make one group`);
    assert.match(await group.innerText(), /3 条协调消息/);
    await group.scrollIntoViewIfNeeded();
    if (capture) await page.screenshot({ path: resolve(capture, `rounds-${width}-group-collapsed.png`) });
    await group.locator("summary, button").first().click();
    assert.ok(await group.locator("[data-coordination-line]").count() === 3, `${width}: the group lists its three lines`);
    const expandable = group.locator("[data-coordination-line]").first();
    const folded = (await expandable.boundingBox())!.height;
    await expandable.locator("summary, button").first().click();
    assert.ok((await expandable.boundingBox())!.height > folded, `${width}: a line expands in place to show the full text and times`);
    assert.match(await expandable.innerText(), /查看任务/);
    if (capture) await page.screenshot({ path: resolve(capture, `rounds-${width}-group-expanded.png`) });

    // 3: every reply has a time; a message's send time and the start of processing are shown apart.
    for (const answerText of ["已确认任务 5。", "已确认任务 6。", "Run 派发后的回复"]) {
      const entry = timeline.locator("[data-workspace-entry]").filter({ hasText: answerText }).first();
      assert.ok(await entry.locator("time").count() >= 1, `${width}: the reply "${answerText}" has a time`);
    }
    // 4: the Run's source line names the dispatcher and the task and links to it.
    const source = timeline.locator("[data-round-source]").first();
    assert.match(await source.innerText(), /统筹派发 · 任务「/);
    assert.ok((await source.getByRole("link").first().getAttribute("href"))?.includes("70000000-0000-4000-8000-000000000011"), "the source links to the specific task");
    assert.deepEqual(errors, [], `${width}: no page error`);
    await context.close();
  }

  // 3: the send time does not change when processing starts; the start is a separate label.
  const sentText = async (processed: boolean) => {
    processedHuman = processed;
    const { page, context, timeline } = await open(1440, 900, { running: false, humanOnly: true });
    const bubble = timeline.getByRole("article", { name: "我发出的消息", exact: true });
    const times = await bubble.locator("time").evaluateAll(nodes => nodes.map(node => ({ text: node.textContent, datetime: node.getAttribute("datetime"), label: node.parentElement?.textContent ?? "" })));
    await context.close();
    return times;
  };
  const before = await sentText(false), after = await sentText(true);
  assert.ok(before.some(item => /发出/.test(item.label)), "a queued message shows its send time");
  const sentBefore = before.find(item => /发出/.test(item.label))!, sentAfter = after.find(item => /发出/.test(item.label))!;
  assert.equal(sentAfter.datetime, sentBefore.datetime, "the send time is the same before and after processing starts");
  assert.ok(!before.some(item => /开始处理/.test(item.label)), "nothing is marked as started while the message waits");
  assert.ok(after.some(item => /开始处理/.test(item.label)), "the start of processing is marked separately");

  // 6: a session with only a person's message, and one with no history, show normally.
  processedHuman = true;
  const only = await open(1440, 900, { running: false, humanOnly: true });
  assert.equal(await only.timeline.locator("[data-coordination-line]").count(), 0, "a human-only session folds nothing");
  assert.match(await only.timeline.innerText(), /请先做表格视图。[\s\S]*收到，表格视图已开始/);
  assert.deepEqual(only.errors, []);
  await only.context.close();
  const empty = await open(1440, 900, { running: false, empty: true });
  assert.equal(await empty.page.locator("body").innerText().then(text => /这一页显示出错/.test(text)), false, "an empty-history session does not hit the error boundary");
  assert.deepEqual(empty.errors, []);
  await empty.context.close();

  // 4: during a person's message the header, the bubble and the right rail say the same thing.
  processedHuman = false;
  const running = await open(1440, 900, { running: true });
  const phrase = "正在回复你的消息";
  const header = await running.page.locator(".session-status-badge:visible").first().innerText();
  assert.match(header, new RegExp(phrase), `the header says ${phrase}`);
  assert.match(await running.timeline.innerText(), new RegExp(phrase), "the bubble says the same");
  assert.match(await running.page.locator("aside").last().innerText(), new RegExp(phrase), "the right rail says the same");
  await running.context.close();
});
