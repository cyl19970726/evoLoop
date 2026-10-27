// Opt-in built-app regression for bounded native observation in the Session workspace.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const modulePath = process.env.EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE;
const dist = resolve(import.meta.dirname, "../dist");
const projectId = "94000001-0000-4000-8000-000000000001";
const sessionId = "94000002-0000-4000-8000-000000000002";
const taskId = "94000003-0000-4000-8000-000000000003";
const sessionKey = `owned:${sessionId}`;
const stamp = "2026-10-27T00:00:00.000Z";
const metadata = { generatedAt: stamp, sourceObservedAt: stamp, partial: false, limitations: [] };
const unavailable = { available: false, reason: "fixture unavailable" };
const resources = Object.fromEntries(["configuredModel", "actualModel", "inputTokens", "outputTokens", "cost", "processMemory"]
  .map(key => [key, { value: null, unit: "", source: null, scope: "session", observedAt: null, interval: null, unavailableReason: "未记录" }]));

test("native progress keeps source, freshness and cumulative usage separate from completion", {
  skip: !modulePath && "Set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE after building the workbench",
}, async t => {
  const { chromium } = (await import(pathToFileURL(modulePath!).href)).default;
  let mode: "live" | "waiting" | "recentTool" | "stale" | "notLoaded" | "foreign" | "fail" |
    "completed" | "failed" | "interrupted" = "live";
  const observation = () => ({ projectId, sessionId: mode === "foreign" ? "other-session" : sessionId,
    threadId: "thread-1", version: 3, observedAt: stamp, lastEventAt: stamp,
    freshness: mode === "stale" ? "stale" : "live", staleReason: mode === "stale" ? "disconnected" : null,
    status: mode === "notLoaded" ? "notLoaded" : "active",
    currentTurn: mode === "notLoaded" ? null : { id: "turn-1",
      status: mode === "completed" || mode === "failed" || mode === "interrupted" ? mode : "inProgress", startedAt: 1793059200,
      source: { kind: "run", runId: "94000004-0000-4000-8000-000000000004",
        operationId: "94000005-0000-4000-8000-000000000005", actorId: "operator", taskId,
        taskRevisionId: "94000006-0000-4000-8000-000000000006" } },
    items: mode === "notLoaded" ? [] : [{ id: "item-1", kind: "mcpToolCall", name: "Tool call",
      status: mode === "recentTool" ? "completed" : "inProgress", summary: "", truncated: false }],
    plan: mode === "notLoaded" ? null : { turnId: "turn-1", steps: [{ step: "读取资料", status: "completed" },
      { step: "整理结果", status: "inProgress" }], explanation: null, truncated: false, observedAt: stamp },
    diff: mode === "notLoaded" ? null : { turnId: "turn-1", text: "src/example.ts +1", truncated: true, observedAt: stamp },
    usage: mode === "notLoaded" ? null : { turnId: "turn-1", total: { inputTokens: 100, cachedInputTokens: 40,
      outputTokens: 50, reasoningOutputTokens: 20, totalTokens: 150 },
      last: { inputTokens: 20, cachedInputTokens: 5, outputTokens: 10, reasoningOutputTokens: 3, totalTokens: 30 },
      modelContextWindow: null, observedAt: stamp } });
  const snapshot = () => ({ session: { key: sessionKey, target: { kind: "owned", sessionId }, aliases: [],
    title: "进度测试会话", profile: null, kind: "owned", roles: [], membership: "current", membershipReason: "fixture",
    runtimeState: "busy", busy: true, currentTask: null, latestBusinessRun: null, lastProgressAt: null,
    capabilities: { observe: unavailable, send: { ...unavailable, mode: "unavailable" },
      open: { ...unavailable, ref: null }, interrupt: unavailable, close: unavailable },
    source: { kind: "session", id: sessionId, revision: null, evidence: "project-record", href: "" }, metadata },
    observationCursor: "0", currentWork: null, assignments: [], roleTasks: [], queue: [], results: [], questions: [], activity: [],
    resources, metadata, nativeInputRequests: mode === "waiting" ? [{ id: "94000007-0000-4000-8000-000000000007",
      sessionId, version: 1, turnId: "turn-1", itemId: "question-1", isBlocking: true, state: "pending",
      questions: [{ id: "answer", header: "请回答", question: "继续执行吗？", isOther: false, options: null }],
      source: null, canReply: false, reason: "等待授权回答者", response: null, createdAt: stamp, updatedAt: stamp }] : [],
    nativeObservation: observation() });
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname === "/__fixture/set") { const next = url.searchParams.get("mode");
      if (next === "live" || next === "waiting" || next === "recentTool" || next === "stale" || next === "notLoaded" || next === "foreign" || next === "fail" ||
        next === "completed" || next === "failed" || next === "interrupted") mode = next;
      res.end("ok"); return; }
    if (url.pathname.startsWith("/api/")) {
      const root = `/api/projects/${projectId}`;
      let value: unknown = { items: [], nextCursor: null, metadata }, status = 200;
      if (url.pathname === "/api/session") value = { principal: { actorId: "operator", projectIds: [projectId], permissions: ["read"] }, capabilities: {} };
      else if (url.pathname === root) value = { id: projectId, title: "测试项目", createdAt: stamp };
      else if (url.pathname === `${root}/session-work/${encodeURIComponent(sessionKey)}`) {
        if (mode === "fail") { status = 503; value = { message: "进度读取失败" }; } else value = snapshot();
      } else if (url.pathname.endsWith("/recovery")) { status = 404; value = { message: "无恢复记录" }; }
      else if (url.pathname.endsWith("/messages")) value = { items: [], nextCursor: null, metadata };
      res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); return;
    }
    try { const file = url.pathname === "/" ? "index.html" : url.pathname; const body = await readFile(join(dist, file));
      res.writeHead(200, { "content-type": ({ ".html": "text/html", ".js": "text/javascript", ".css": "text/css" } as Record<string, string>)[extname(file)] ?? "application/octet-stream" }); res.end(body);
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const browser = await chromium.launch({ headless: true, ...(process.env.EVOLOOP_BROWSER_TEST_EXECUTABLE_PATH
    ? { executablePath: process.env.EVOLOOP_BROWSER_TEST_EXECUTABLE_PATH } : {}) }); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 390, height: 840 } });
  await page.goto(`${base}/#/p/${projectId}/runtime?session=${encodeURIComponent(sessionKey)}`);
  await page.getByLabel("访问令牌").fill("fixture-token");
  await page.getByRole("button", { name: "进入", exact: true }).click();
  await page.getByRole("heading", { name: "进度测试会话" }).waitFor();
  const card = page.locator(".native-progress-card");
  await card.getByText("运行中", { exact: true }).waitFor();
  await card.getByText("Tool call · 进行中").first().waitFor();
  await card.getByText("1/2 步已完成").waitFor();
  await card.getByText("已观察到变更；内容需在受权原生历史核对").waitFor();
  assert.equal(await card.getByText("src/example.ts +1", { exact: false }).count(), 0,
    "raw native diff text is not shown to project readers");
  await card.getByText("输入 100 · 输出 50 · 总计 150", { exact: false }).waitFor();
  assert.equal(await card.getByText("未提供实际费用", { exact: false }).count(), 1);
  await card.getByText("原生进度来源").click();
  assert.equal(await card.locator(`a[href*="${taskId}"]`).count(), 1, "source Run links to its Task");
  assert.equal(await page.locator("body").evaluate(element => element.scrollWidth <= window.innerWidth), true,
    "mobile Session workspace has no horizontal overflow");
  if (process.env.EVOLOOP_CAPTURE_PROGRESS) {
    await page.screenshot({ path: "/tmp/evoloop-native-progress-mobile.png", fullPage: true });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.screenshot({ path: "/tmp/evoloop-native-progress-desktop.png", fullPage: true });
    await page.setViewportSize({ width: 390, height: 840 });
  }

  await fetch(`${base}/__fixture/set?mode=waiting`);
  await page.getByRole("button", { name: "重新读取" }).click();
  await card.getByText("等待回答").waitFor();
  assert.equal(await page.locator(".native-question-card").count(), 1, "question remains above progress");

  await fetch(`${base}/__fixture/set?mode=recentTool`);
  await page.getByRole("button", { name: "重新读取" }).click();
  await card.locator(".native-progress-facts small").filter({ hasText: "最近工具活动" }).waitFor();
  assert.equal(await card.locator(".native-progress-facts small").filter({ hasText: "当前工具" }).count(), 0,
    "a completed item is not presented as the current tool while the Turn continues");

  for (const [terminal, label] of [["completed", "Turn 已结束"], ["failed", "Turn 执行失败"], ["interrupted", "Turn 已中断"]] as const) {
    // Only the Turn ended: the fixture deliberately never supplies item/completed or a completed plan step.
    await fetch(`${base}/__fixture/set?mode=${terminal}`);
    await page.getByRole("button", { name: "重新读取" }).click();
    await card.getByText(label, { exact: true }).waitFor();
    await card.getByText("Tool call · Turn 结束时结果未确认", { exact: true }).first().waitFor({ timeout: 2000 });
    assert.equal(await card.locator(".native-progress-facts small").filter({ hasText: "当前工具" }).count(), 0);
    assert.equal(await card.getByText("Tool call · 进行中", { exact: true }).count(), 0);
    const plan = card.locator("details").filter({ hasText: "计划步骤 · Turn turn-1" });
    if (!await plan.evaluate(element => (element as HTMLDetailsElement).open)) await plan.locator("summary").click();
    await plan.getByText("Turn 结束时结果未确认 · 整理结果", { exact: true }).waitFor({ timeout: 2000 });
    assert.equal(await card.getByText("1/2 步已完成", { exact: true }).count(), 1,
      "ending a Turn does not invent tool results or completed plan steps");
  }

  await fetch(`${base}/__fixture/set?mode=stale`);
  await page.getByRole("button", { name: "重新读取" }).click();
  await card.getByText("观察待核对").waitFor();
  await card.getByText("不能代表当前仍在执行", { exact: false }).waitFor();
  assert.equal(await card.getByText("运行中", { exact: true }).count(), 0, "stale in-progress Turn is never shown as live");
  await card.getByText("Tool call · 当时进行中，当前待核对").first().waitFor();
  await card.getByText("上次记录：1/2 步已完成").waitFor();
  const stalePlan = card.locator("details").filter({ hasText: "计划步骤 · Turn turn-1" });
  if (!await stalePlan.evaluate(element => (element as HTMLDetailsElement).open)) await stalePlan.locator("summary").click();
  await card.getByText("当时进行中，当前待核对 · 整理结果").waitFor();

  await fetch(`${base}/__fixture/set?mode=notLoaded`);
  await page.getByRole("button", { name: "重新读取" }).click();
  await card.getByText("原生会话尚未加载").waitFor();
  await card.getByText("输入 未提供 · 输出 未提供 · 总计 未提供", { exact: false }).waitFor();

  await fetch(`${base}/__fixture/set?mode=foreign`);
  await page.getByRole("button", { name: "重新读取" }).click();
  await page.getByText("原生进度身份或新鲜度无法核实", { exact: false }).waitFor();
  assert.equal(await card.count(), 0, "foreign Session observation cannot appear");

  await fetch(`${base}/__fixture/set?mode=live`);
  await page.getByRole("button", { name: "重新读取" }).click();
  await card.getByText("运行中", { exact: true }).waitFor();
  await fetch(`${base}/__fixture/set?mode=fail`);
  await page.getByRole("button", { name: "重新读取" }).click();
  await card.getByText("观察待核对").waitFor();
  assert.equal(await card.getByText("运行中", { exact: true }).count(), 0, "failed reread cannot present cached activity as current");
});
