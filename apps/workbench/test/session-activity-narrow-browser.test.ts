// Opt-in built-app regression: build workbench, then set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const modulePath = process.env.EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE;
const dist = resolve(import.meta.dirname, "../dist");
const projectId = "95000001-0000-4000-8000-000000000001";
const sessionId = "95000002-0000-4000-8000-000000000002";
const sessionKey = `owned:${sessionId}`;
const stamp = "2026-10-27T00:00:00.000Z";
const metadata = { generatedAt: stamp, sourceObservedAt: stamp, partial: false, limitations: [] };
const unavailable = { available: false, reason: "测试中不可用" };
const resources = Object.fromEntries(["configuredModel", "actualModel", "inputTokens", "outputTokens", "cost", "processMemory"]
  .map(key => [key, { value: null, unit: "", source: null, scope: "session", observedAt: null, interval: null, unavailableReason: "未记录" }]));
const runId = "95000003-0000-4000-8000-000000000003";
const messageId = "95000005-0000-4000-8000-000000000005";
const taskId = "95000004-0000-4000-8000-000000000004";
const olderResult = { deliveryId: "old-delivery", taskId, taskTitle: "最近真实成果", technicalResult: "failed",
  artifactRef: "old-report", artifactRevision: "old", contentHash: "a".repeat(64), submittedAt: "2026-10-27T05:32:41.000Z", latestUse: null,
  source: { kind: "delivery", id: "old-delivery", revision: null, evidence: "project-record", href: "" } };
const recentResult = { ...olderResult, deliveryId: "new-delivery", technicalResult: "passed", artifactRevision: "new",
  source: { ...olderResult.source, id: "new-delivery" },
  submittedAt: "2026-10-27T05:34:07.000Z", latestUse: { result: "used", observer: "reviewer", observerKind: "human",
    createdAt: "2026-10-27T05:41:08.000Z", source: { kind: "consumer-observation", id: "use-new", revision: null,
      evidence: "independent-use", href: "" } } };
const longUrl = `https://example.test/results/${"a".repeat(96)}?sha256=${"b".repeat(64)}`;
const activity = { id: "activity-long-run", sequence: "2", sessionKey, kind: "run.bound",
  summary: `旧 Run completed · ${longUrl} · ${"c".repeat(64)}`, occurredAt: stamp, recordedAt: stamp,
  actorId: "runtime-coordinator", taskId: null, importance: "important",
  source: { kind: "run", id: runId, revision: "d".repeat(80), evidence: "project-record", href: "" } };
const runActivity = { ...activity, id: "run-business", sequence: "1", kind: "runtime_run",
  summary: "业务运行 · running", actorId: "lead", taskId };
const messageActivity = { ...activity, id: "message-processing", sequence: "0", kind: "message", summary: "消息处理中",
  actorId: "reader", taskId: null, source: { ...activity.source, kind: "message", id: messageId } };
const snapshot = { session: { key: sessionKey, target: { kind: "owned", sessionId }, aliases: [], title: "窄屏活动测试会话",
  profile: { displayName: "窄屏活动测试会话", purpose: "按固定设计完成 Session 体验并交付独立验收。", tenure: "temporary", membership: "current" }, kind: "owned", roles: [], membership: "current", membershipReason: "测试", runtimeState: "ready", busy: true,
  currentTask: { id: taskId, title: "关联的真实任务", state: "in_progress", relation: "claimed" }, latestBusinessRun: { id: runId, taskId, state: "running", updatedAt: stamp }, lastProgressAt: stamp, capabilities: { observe: unavailable,
    send: { ...unavailable, mode: "unavailable" }, open: { ...unavailable, ref: null }, interrupt: unavailable, close: unavailable },
  source: { kind: "session", id: sessionId, revision: null, evidence: "project-record", href: "" }, metadata },
  observationCursor: "2", currentWork: { id: taskId, title: "关联的真实任务", state: "in_progress", relation: "claimed" }, assignments: [], roleTasks: [], queue: [], results: [], questions: [],
  activity: [activity, runActivity], resources: { ...resources, configuredModel: { ...resources.configuredModel, value: "gpt-6-sol" } }, metadata,
  nativeObservation: { projectId, sessionId, threadId: "fixture-thread", version: 1, observedAt: stamp, lastEventAt: stamp,
    freshness: "live", staleReason: null, status: "active", currentTurn: { id: "turn", status: "inProgress", source: { kind: "run",
      runId, taskId, actorId: "lead", operationId: runId, taskRevisionId: taskId } },
    items: [{ id: "tool", kind: "commandExecution", name: "检查工作区", status: "inProgress", summary: "读取文件", truncated: false }],
    plan: null, diff: null, usage: null } };

test("long Run activity and expanded source stay inside the Session page at mobile and desktop widths", {
  skip: !modulePath && "Set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE after building the workbench",
}, async t => {
  const { chromium } = (await import(pathToFileURL(modulePath!).href)).default;
  let denyTrace = true;
  let idle = false;
  let traceMode: "partial" | "long" | "complete" | "fresh" = "partial";
  let includeMessage = false, includeQuestion = false, messageReplied = false, runCompleted = false, holdTrace = false, traceHeld = false;
  let scenario: "normal" | "failed" | "unknown" = "normal";
  let lifecycle: "ready" | "closing" | "closed" = "ready";
  let lateMessage = false, completedClaim = false, messageWithoutWork = false;
  let releaseTrace: (() => void) | null = null;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname === "/__fixture/allow-trace") { denyTrace = false; res.end("ok"); return; }
    if (url.pathname === "/__fixture/idle") { idle = true; res.end("ok"); return; }
    if (url.pathname === "/__fixture/long-trace") { traceMode = "long"; res.end("ok"); return; }
    if (url.pathname === "/__fixture/complete-trace") { traceMode = "complete"; runCompleted = true; res.end("ok"); return; }
    if (url.pathname === "/__fixture/fresh-trace") { traceMode = "fresh"; res.end("ok"); return; }
    if (url.pathname === "/__fixture/include-message") { includeMessage = true; res.end("ok"); return; }
    if (url.pathname === "/__fixture/include-question") { includeQuestion = true; res.end("ok"); return; }
    if (url.pathname === "/__fixture/message-replied") { messageReplied = true; res.end("ok"); return; }
    if (url.pathname === "/__fixture/hold-trace") { holdTrace = true; res.end("ok"); return; }
    if (url.pathname === "/__fixture/trace-held") { res.end(String(traceHeld)); return; }
    if (url.pathname === "/__fixture/release-trace") { releaseTrace?.(); res.end("ok"); return; }
    if (url.pathname === "/__fixture/failed") { scenario = "failed"; res.end("ok"); return; }
    if (url.pathname === "/__fixture/unknown") { scenario = "unknown"; res.end("ok"); return; }
    if (url.pathname === "/__fixture/ready-message") { lifecycle = "ready"; lateMessage = true; messageWithoutWork = true; res.end("ok"); return; }
    if (url.pathname === "/__fixture/closing") { lifecycle = "closing"; lateMessage = true; res.end("ok"); return; }
    if (url.pathname === "/__fixture/closed") { lifecycle = "closed"; res.end("ok"); return; }
    if (url.pathname === "/__fixture/completed-claim") { lifecycle = "ready"; lateMessage = false; messageWithoutWork = false; completedClaim = true; runCompleted = true; res.end("ok"); return; }
    if (url.pathname === "/__fixture/active-run") { completedClaim = false; runCompleted = false; messageWithoutWork = false; res.end("ok"); return; }
    if (url.pathname.startsWith("/api/")) {
      const root = `/api/projects/${projectId}`;
      let value: unknown = { items: [], nextCursor: null, metadata }, status = 200;
      if (url.pathname === "/api/session") value = { principal: { actorId: "reader", projectIds: [projectId], permissions: ["read"] }, capabilities: {} };
      else if (url.pathname === root) value = { id: projectId, title: "测试项目", createdAt: stamp };
      else if (url.pathname === `${root}/session-work`) value = { items: [snapshot.session], nextCursor: null, observationCursor: "1", metadata,
        totals: { current: 1, historical: 0, unclassified: 0 }, attention: { unansweredQuestions: 0, pendingMessages: 0, pendingAcceptance: 0, unclassifiedSessions: 0 } };
      else if (url.pathname === `${root}/session-work/${encodeURIComponent(sessionKey)}`) {
        value = idle
        ? { ...snapshot, session: { ...snapshot.session, busy: false, currentTask: null, latestBusinessRun: null }, currentWork: null,
          results: [olderResult, recentResult],
          activity: [...snapshot.activity.map(item => item.id === "run-business" && runCompleted ? { ...item, summary: "业务运行 · completed" } : item.id === "activity-long-run" && runCompleted ? { ...item, source: { ...item.source, revision: "updated-source" } } : item), ...(includeMessage ? [messageActivity] : [])],
          nativeInputRequests: includeQuestion ? [{ id: "question-1", version: 1, sessionId, turnId: "turn", itemId: "item-1", isBlocking: true,
            state: "pending", canReply: false, reason: "当前不可回答", createdAt: stamp, response: null,
            source: { kind: "run", runId, taskId }, questions: [{ id: "q", header: "确认", question: "是否继续？", isOther: false, options: null }] }] : [],
          nativeObservation: { ...snapshot.nativeObservation, status: "idle", currentTurn: null, items: [] } }
        : { ...snapshot, currentWork: messageWithoutWork ? null : snapshot.currentWork,
          session: { ...snapshot.session, runtimeState: lifecycle, busy: !completedClaim,
          latestBusinessRun: { ...snapshot.session.latestBusinessRun, state: completedClaim ? "completed" : "running" } },
          nativeObservation: lateMessage ? { ...snapshot.nativeObservation, currentTurn: { ...snapshot.nativeObservation.currentTurn,
            source: { kind: "message", messageId, processingId: messageId, actorId: "reader", operationId: messageId } } } : snapshot.nativeObservation,
          activity: [...snapshot.activity.map(item => item.id === "run-business" && runCompleted ? { ...item, summary: "业务运行 · completed" } : item.id === "activity-long-run" && runCompleted ? { ...item, source: { ...item.source, revision: "updated-source" } } : item), ...(includeMessage ? [messageActivity] : [])] };
        if (scenario === "failed") value = { ...(value as object), session: { ...snapshot.session, busy: false,
          latestBusinessRun: { ...snapshot.session.latestBusinessRun, state: "failed" } }, nativeInputRequests: [] };
        if (scenario === "unknown") value = { ...(value as object), session: { ...snapshot.session, runtimeState: "unknown", busy: false,
          currentTask: null, latestBusinessRun: null }, currentWork: null, nativeInputRequests: [] };
      }
      else if (url.pathname === `${root}/tasks/${taskId}`) {
        const task = { projectId, id: taskId, version: 1, currentRevisionId: taskId, title: "关联的真实任务", content: "任务正文", contentDocumentId: taskId,
          contentRevisionId: taskId, kind: "implementation", acceptance: "可返回来源", owner: "reader", state: "in_progress", basisSetId: null,
          actorId: "reader", reason: "创建", createdAt: stamp };
        value = { task, revision: { ...task, taskId, id: taskId }, basis: null, links: [], impacts: [], decisions: [], deliveries: [], observations: [], closures: [] };
      }
      else if (url.pathname === `${root}/impacts` || url.pathname === `${root}/runtime/runs` || url.pathname === `${root}/runtime/sessions` || url.pathname.startsWith(`${root}/references/`)) value = [];
      else if (url.pathname === `${root}/runtime`) value = { available: false, error: null, allowedCwds: [], grants: [] };
      else if (url.pathname === `${root}/orchestration/work-status`) value = { items: [] };
      else if (url.pathname === `${root}/runtime/runs/${runId}/trace`) {
        if (denyTrace) { status = 403; value = { message: "没有轨迹读取权限" }; }
        else {
          const delayed = holdTrace && !url.searchParams.has("cursor");
          if (delayed) { holdTrace = false; traceHeld = true; await new Promise<void>(resolve => { releaseTrace = resolve; }); }
          const long = traceMode === "long" && !url.searchParams.has("cursor");
          const complete = traceMode === "complete" || traceMode === "fresh";
          const defaultItem = { id: url.searchParams.has("cursor") ? "second" : "first", kind: "command", name: "实际命令", status: "completed",
            exitCode: 0, text: null, output: delayed ? "迟到旧结果" : traceMode === "fresh" ? "新登录结果" : url.searchParams.has("cursor") ? "第二页真实输出" : "第一页真实输出", error: null,
            artifactRefs: [], startedAtUtc: stamp, completedAtUtc: stamp, durationMs: 1, truncated: !url.searchParams.has("cursor") };
          value = { runId, nativeTurnId: "turn", source: "owned-native-history", observedAt: stamp,
          turn: null, turnMetadata: { status: url.searchParams.has("cursor") ? "not_found" : "partial", nextTurnCursor: null },
          items: long ? [...Array.from({ length: 65 }, (_, index) => ({ ...defaultItem, id: `tool-${index}`, output: `工具正文${index}：${"x".repeat(1500)}` })),
            { ...defaultItem, id: "original-input", kind: "message", name: "user", text: `交接JSON${"y".repeat(1500)}`, output: null }] : [defaultItem],
          unsupportedCount: 0, truncated: !complete, nextCursor: complete || long || url.searchParams.has("cursor") ? null : "page-2",
          completeness: complete ? "complete" : "partial", limits: { maxPages: 2, maxItems: 100, maxFieldChars: 2000 } };
        }
      }
      else if (url.pathname === `${root}/session-messages/${messageId}`) value = { message: { id: messageId, projectId,
        target: { kind: "owned", sessionId }, content: "待处理消息正文", state: messageReplied ? "replied" : "processing" },
        processing: { response: messageReplied ? "最新回复正文" : null, failure: null }, metadata };
      else if (url.pathname.endsWith("/recovery")) { status = 404; value = { message: "无恢复记录" }; }
      res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); return;
    }
    try {
      const file = url.pathname === "/" ? "index.html" : url.pathname;
      const body = await readFile(join(dist, file));
      res.writeHead(200, { "content-type": ({ ".html": "text/html", ".js": "text/javascript", ".css": "text/css" } as Record<string, string>)[extname(file)] ?? "application/octet-stream" }); res.end(body);
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const browser = await chromium.launch({ headless: true, ...(process.env.EVOLOOP_BROWSER_TEST_EXECUTABLE_PATH
    ? { executablePath: process.env.EVOLOOP_BROWSER_TEST_EXECUTABLE_PATH } : {}) }); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.goto(`${base}/#/p/${projectId}/runtime?session=${encodeURIComponent(sessionKey)}&tab=activity`);
  await page.getByLabel("访问令牌").fill("fixture-token");
  await page.getByRole("button", { name: "进入", exact: true }).click();
  await page.getByRole("heading", { name: "窄屏活动测试会话" }).waitFor();
  await page.locator(".session-current-work").getByText("Run 已认领，本次运行中", { exact: false }).waitFor();
  await fetch(`${base}/__fixture/ready-message`);
  await page.getByRole("button", { name: "重新读取" }).click();
  await page.locator(".session-status-badge").getByText("消息处理中").waitFor();
  await page.locator(".session-current-work").getByText("正在回复消息").waitFor();
  await fetch(`${base}/__fixture/closing`);
  await page.getByRole("button", { name: "重新读取" }).click();
  await page.locator(".session-status-badge").getByText("关闭中").waitFor();
  assert.equal(await page.locator(".session-workspace-head").getByText("消息处理中").count(), 0, "late message does not mask closing");
  await fetch(`${base}/__fixture/closed`);
  await page.getByRole("button", { name: "重新读取" }).click();
  await page.locator(".session-status-badge").getByText("已关闭").waitFor();
  await fetch(`${base}/__fixture/completed-claim`);
  await page.getByRole("button", { name: "重新读取" }).click();
  await page.locator(".session-current-work").getByText("最近一次执行已结束，结果待核对", { exact: false }).waitFor();
  assert.equal(await page.locator(".session-current-work").getByText("Run／队列已认领或占用；当前运行待核对", { exact: false }).count(), 0, "completed claim is not pending run");
  await page.locator(".session-project-activity > summary").click();
  await page.locator(".session-activity-list").getByText("历史记录：已结束", { exact: false }).waitFor();
  await fetch(`${base}/__fixture/active-run`);
  await page.getByRole("button", { name: "重新读取" }).click();
  await page.locator(".session-current-work").getByText("Run 已认领，本次运行中", { exact: false }).waitFor();
  assert.equal(await page.locator('.project-sidebar [aria-current="page"]').count(), 1, "only the Session is selected in the project sidebar");
  const item = page.locator(".session-activity-list li").first();
  async function showTool(index: number) { const tool = page.locator(".session-feed:visible .session-trace-item").nth(index); await tool.locator("summary").waitFor(); if (await tool.getAttribute("open") === null) await tool.locator("summary").click(); }
  await item.getByText("关联的真实任务 · 运行中", { exact: false }).waitFor();
  assert.equal(await page.locator(".native-progress-card").isVisible(), false, "healthy progress is in collapsed Session information");
  assert.ok((await page.locator(".session-feed").boundingBox())!.width <= 390, "activity remains inside the mobile reading column");
  await page.locator(".session-information:visible > summary").click();
  await page.locator(".native-progress-card").waitFor({ state: "visible" });
  await page.getByRole("heading", { name: "原聊天入口" }).waitFor();
  await page.getByText("原生进度来源").click();
  await page.locator(".native-progress-card").getByRole("link", { name: "关联任务" }).click();
  await page.getByRole("link", { name: "返回【窄屏活动测试会话】" }).click();
  await page.getByRole("button", { name: "活动与对话" }).waitFor();
  await page.locator(".session-information:visible > summary").click();
  await page.locator(".session-information:visible > summary").click();
  if (process.env.EVOLOOP_CAPTURE_ACTIVITY_NARROW) for (const width of [390, 1280, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.screenshot({ path: `/tmp/evoloop-first-screen-active-${width}.png` });
  }
  const returnedActivity = page.locator(".session-project-activity:visible");
  if (await returnedActivity.getAttribute("open") === null) await returnedActivity.locator("> summary").click();
  const returnedItem = page.locator(".session-feed:visible .session-activity-list li").first();
  await returnedItem.getByRole("button", { name: /关联的真实任务 · 运行中/ }).click();
  await returnedItem.getByText("详情暂不可用").waitFor();
  await fetch(`${base}/__fixture/allow-trace`);
  await returnedItem.getByRole("button", { name: "重试" }).click();
  await returnedItem.locator(".session-trace-item").first().waitFor();
  assert.equal(await returnedItem.locator(".session-trace-item pre").count(), 0, "tool bodies are not mounted until selected");
  await showTool(0);
  await returnedItem.getByText("第一页真实输出").waitFor();
  await returnedItem.getByRole("button", { name: "继续读取执行轨迹" }).click();
  await showTool(1);
  await returnedItem.getByText("第二页真实输出").waitFor();
  await returnedItem.getByText("原始事件与来源").click();
  const text = await returnedItem.innerText();
  assert.ok(text.includes(longUrl), "the long URL remains readable rather than truncated");
  assert.ok(text.includes("c".repeat(64)), "the summary hash remains available");
  assert.ok(text.includes(runId), "the expanded source remains available");
  for (const width of [390, 1280, 1440]) {
    await page.setViewportSize({ width, height: 844 });
    const layout = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth,
      body: document.body.scrollWidth, activity: document.querySelector(".session-activity-list")?.scrollWidth,
      activityWidth: document.querySelector(".session-activity-list")?.clientWidth }));
    assert.ok(layout.document <= layout.viewport && layout.body <= layout.viewport, `${width}px page overflow: ${JSON.stringify(layout)}`);
    assert.ok((layout.activity ?? 0) <= (layout.activityWidth ?? 0), `${width}px activity overflow: ${JSON.stringify(layout)}`);
    if (process.env.EVOLOOP_CAPTURE_ACTIVITY_NARROW) await page.screenshot({ path: `/tmp/evoloop-activity-${width}.png`, fullPage: true });
  }
  await page.locator(".session-feed:visible").getByLabel("活动范围").selectOption("all");
  await page.setViewportSize({ width: 390, height: 520 });
  await page.evaluate(() => window.scrollTo(0, 500));
  await page.waitForFunction(() => window.scrollY > 0);
  await page.locator(".session-feed:visible").getByRole("link", { name: "查看任务" }).first().click();
  await page.getByRole("link", { name: "返回【窄屏活动测试会话】" }).waitFor();
  await page.getByRole("link", { name: "返回【窄屏活动测试会话】" }).click();
  await showTool(1);
  await page.locator(".session-feed:visible").getByText("第二页真实输出").waitFor();
  assert.equal(await page.locator(".session-feed:visible").getByLabel("活动范围").inputValue(), "all");
  await page.waitForFunction(() => window.scrollY > 0);
  assert.ok(await page.evaluate(() => window.scrollY) > 0, "return restores the Session reading position");
  assert.match(new URL(page.url()).hash, /open=/);
  await page.getByRole("link", { name: "查看任务" }).first().click();
  await page.goBack();
  await showTool(1);
  await page.getByText("第二页真实输出").waitFor();
  await page.reload();
  await page.getByLabel("访问令牌").fill("fixture-token");
  await page.getByRole("button", { name: "进入", exact: true }).click();
  const reloadedActivity = page.locator(".session-project-activity:visible");
  await reloadedActivity.waitFor();
  if (await reloadedActivity.getAttribute("open") === null) await reloadedActivity.locator("> summary").click();
  await showTool(0);
  await page.getByText("第一页真实输出").waitFor();
  await fetch(`${base}/__fixture/idle`);
  await page.reload();
  await page.getByLabel("访问令牌").fill("fixture-token");
  await page.getByRole("button", { name: "进入", exact: true }).click();
  await page.getByRole("heading", { name: "窄屏活动测试会话" }).waitFor();
  await page.locator(".session-status-badge").getByText("空闲").waitFor();
  const recentWork = page.locator(".session-current-work");
  await recentWork.getByText("最近真实成果", { exact: true }).waitFor();
  await recentWork.getByText("技术结果：passed · 已记录使用", { exact: false }).waitFor();
  assert.equal(await recentWork.getByText("已有交付待核对").count(), 0, "older failed Delivery cannot override newer used Delivery");
  const idleActivity = page.locator(".session-project-activity:visible");
  if (await idleActivity.getAttribute("open") === null) await idleActivity.locator("> summary").click();
  await page.locator(".session-feed:visible").getByLabel("活动范围").selectOption("important");
  const idleItem = page.locator(".session-feed:visible .session-activity-list li").first();
  await idleItem.getByText("历史记录：运行中").waitFor();
  if (await idleItem.getByRole("button", { name: /历史记录：运行中/ }).getAttribute("aria-expanded") === "true") await idleItem.getByRole("button", { name: /历史记录：运行中/ }).click();
  if (process.env.EVOLOOP_CAPTURE_ACTIVITY_NARROW) for (const width of [390, 1280, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: `/tmp/evoloop-first-screen-idle-${width}.png` });
  }
  await idleItem.getByRole("button", { name: /历史记录：运行中/ }).click();
  await idleItem.getByRole("button", { name: "重读执行轨迹" }).waitFor();
  await fetch(`${base}/__fixture/long-trace`);
  await idleItem.getByRole("button", { name: "重读执行轨迹" }).click();
  await idleItem.getByRole("button", { name: /显示更多工作记录（10\/65）/ }).waitFor();
  assert.equal(await idleItem.locator(".session-trace-list > .session-trace-item").count(), 10, "only the first bounded batch is mounted");
  assert.equal(await idleItem.locator(".session-trace-item pre").count(), 0, "long tool output stays unmounted");
  assert.ok((await idleItem.boundingBox())!.height < 3000, "the first detail batch stays scanable");
  if (process.env.EVOLOOP_CAPTURE_ACTIVITY_NARROW) {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await idleItem.scrollIntoViewIfNeeded();
    await page.screenshot({ path: "/tmp/evoloop-long-trace-1440.png" });
  }
  await idleItem.getByRole("button", { name: /显示更多工作记录（10\/65）/ }).click();
  assert.equal(await idleItem.locator(".session-trace-list > .session-trace-item").count(), 20);
  assert.equal(await idleItem.getByText("交接JSON", { exact: false }).count(), 0, "raw input stays closed");
  await idleItem.getByText("原始输入与消息记录 · 1 项").click();
  await idleItem.locator(".session-trace-input .session-trace-item summary").click();
  await idleItem.getByText("交接JSON", { exact: false }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "expanded raw input does not widen mobile view");
  await fetch(`${base}/__fixture/complete-trace`);
  await idleItem.getByRole("button", { name: "重读执行轨迹" }).click();
  await idleItem.getByText("当前已读完整").waitFor();
  await page.getByRole("button", { name: "重新读取", exact: true }).click();
  await idleItem.getByText("历史记录：已结束").waitFor();
  await idleItem.getByText("来源记录已更新", { exact: false }).waitFor();
  await idleItem.getByRole("button", { name: "重读执行轨迹" }).click();
  await page.waitForFunction(() => document.querySelectorAll(".session-trace-stale").length === 0);
  await fetch(`${base}/__fixture/include-message`);
  await page.getByRole("button", { name: "重新读取", exact: true }).click();
  const messageItem = page.locator(".session-activity-list li").filter({ hasText: "消息处理中" }).first();
  await messageItem.getByRole("button", { name: "消息处理中" }).click();
  await messageItem.getByText("消息状态：processing", { exact: false }).waitFor();
  await fetch(`${base}/__fixture/message-replied`);
  await messageItem.getByRole("button", { name: "重读消息" }).click();
  await messageItem.getByText("消息状态：replied", { exact: false }).waitFor();
  await messageItem.getByText("最新回复正文").waitFor();
  await fetch(`${base}/__fixture/include-question`);
  await page.getByRole("button", { name: "重新读取", exact: true }).click();
  const question = page.locator(".native-question-card").first();
  await question.getByText("是否继续？").waitFor();
  await question.getByRole("link", { name: "关联任务" }).click();
  await page.getByRole("link", { name: "返回【窄屏活动测试会话】" }).click();
  assert.equal(await page.getByLabel("活动范围").inputValue(), "important");
  await fetch(`${base}/__fixture/hold-trace`);
  await idleItem.getByRole("button", { name: "重读执行轨迹" }).click();
  await page.waitForFunction(async base => await (await fetch(`${base}/__fixture/trace-held`)).text() === "true", base);
  await page.getByRole("button", { name: "退出" }).click();
  await fetch(`${base}/__fixture/fresh-trace`);
  await fetch(`${base}/__fixture/release-trace`);
  await page.getByLabel("访问令牌").fill("fixture-token");
  await page.getByRole("button", { name: "进入", exact: true }).click();
  await page.getByRole("heading", { name: "窄屏活动测试会话" }).waitFor();
  const freshActivity = page.locator(".session-project-activity:visible");
  if (await freshActivity.getAttribute("open") === null) await freshActivity.locator("> summary").click();
  const newItem = page.locator(".session-feed:visible .session-activity-list li").first();
  if (await newItem.getByRole("button", { name: /历史记录：已结束/ }).getAttribute("aria-expanded") !== "true") await newItem.getByRole("button", { name: /历史记录：已结束/ }).click();
  await newItem.locator(".session-trace-item").first().locator("summary").click();
  await newItem.getByText("新登录结果").waitFor();
  assert.equal(await newItem.getByText("迟到旧结果").count(), 0, "a late response cannot repopulate a cleared scope");
  await newItem.getByRole("button", { name: /历史记录：已结束/ }).click();
  await fetch(`${base}/__fixture/failed`);
  await page.getByRole("button", { name: "重新读取", exact: true }).click();
  await page.getByText("最近运行失败", { exact: false }).waitFor();
  if (process.env.EVOLOOP_CAPTURE_ACTIVITY_NARROW) for (const width of [390, 1280, 1440]) {
    await page.setViewportSize({ width, height: 1000 }); await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: `/tmp/evoloop-first-screen-failed-${width}.png` });
  }
  await fetch(`${base}/__fixture/unknown`);
  await page.getByRole("button", { name: "重新读取", exact: true }).click();
  await page.locator(".session-status-badge").getByText("生命周期待核对").waitFor();
  assert.equal(await page.locator(".session-current-work").getByText("当前空闲").count(), 0);
  if (process.env.EVOLOOP_CAPTURE_ACTIVITY_NARROW) for (const width of [390, 1280, 1440]) {
    await page.setViewportSize({ width, height: 1000 }); await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: `/tmp/evoloop-first-screen-unknown-${width}.png` });
  }
});
