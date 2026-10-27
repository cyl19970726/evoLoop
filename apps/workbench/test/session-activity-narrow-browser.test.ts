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
const taskId = "95000004-0000-4000-8000-000000000004";
const longUrl = `https://example.test/results/${"a".repeat(96)}?sha256=${"b".repeat(64)}`;
const activity = { id: "activity-long-run", sequence: "1", sessionKey, kind: "run.completed",
  summary: `旧 Run completed · ${longUrl} · ${"c".repeat(64)}`, occurredAt: stamp, recordedAt: stamp,
  actorId: "worker", taskId, importance: "important",
  source: { kind: "run", id: runId, revision: "d".repeat(80), evidence: "project-record", href: "" } };
const snapshot = { session: { key: sessionKey, target: { kind: "owned", sessionId }, aliases: [], title: "窄屏活动测试会话",
  profile: null, kind: "owned", roles: [], membership: "current", membershipReason: "测试", runtimeState: "ready", busy: false,
  currentTask: null, latestBusinessRun: null, lastProgressAt: null, capabilities: { observe: unavailable,
    send: { ...unavailable, mode: "unavailable" }, open: { ...unavailable, ref: null }, interrupt: unavailable, close: unavailable },
  source: { kind: "session", id: sessionId, revision: null, evidence: "project-record", href: "" }, metadata },
  observationCursor: "1", currentWork: null, assignments: [], roleTasks: [], queue: [], results: [], questions: [],
  activity: [activity], resources, metadata };

test("long Run activity and expanded source stay inside the Session page at mobile and desktop widths", {
  skip: !modulePath && "Set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE after building the workbench",
}, async t => {
  const { chromium } = (await import(pathToFileURL(modulePath!).href)).default;
  let denyTrace = true;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname === "/__fixture/allow-trace") { denyTrace = false; res.end("ok"); return; }
    if (url.pathname.startsWith("/api/")) {
      const root = `/api/projects/${projectId}`;
      let value: unknown = { items: [], nextCursor: null, metadata }, status = 200;
      if (url.pathname === "/api/session") value = { principal: { actorId: "reader", projectIds: [projectId], permissions: ["read"] }, capabilities: {} };
      else if (url.pathname === root) value = { id: projectId, title: "测试项目", createdAt: stamp };
      else if (url.pathname === `${root}/session-work`) value = { items: [snapshot.session], nextCursor: null, observationCursor: "1", metadata,
        totals: { current: 1, historical: 0, unclassified: 0 }, attention: { unansweredQuestions: 0, pendingMessages: 0, pendingAcceptance: 0, unclassifiedSessions: 0 } };
      else if (url.pathname === `${root}/session-work/${encodeURIComponent(sessionKey)}`) value = snapshot;
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
        else value = { runId, nativeTurnId: "turn", source: "owned-native-history", observedAt: stamp,
          turn: null, turnMetadata: { status: url.searchParams.has("cursor") ? "not_found" : "partial", nextTurnCursor: null },
          items: [{ id: url.searchParams.has("cursor") ? "second" : "first", kind: "command", name: "实际命令", status: "completed",
            exitCode: 0, text: null, output: url.searchParams.has("cursor") ? "第二页真实输出" : "第一页真实输出", error: null,
            artifactRefs: [], startedAtUtc: stamp, completedAtUtc: stamp, durationMs: 1, truncated: !url.searchParams.has("cursor") }],
          unsupportedCount: 0, truncated: !url.searchParams.has("cursor"), nextCursor: url.searchParams.has("cursor") ? null : "page-2",
          completeness: url.searchParams.has("cursor") ? "partial" : "partial", limits: { maxPages: 2, maxItems: 100, maxFieldChars: 2000 } };
      }
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
  assert.equal(await page.locator('.project-sidebar [aria-current="page"]').count(), 1, "only the Session is selected in the project sidebar");
  const item = page.locator(".session-activity-list li").first();
  await item.getByText("旧 Run completed", { exact: false }).waitFor();
  await item.getByRole("button", { name: /旧 Run completed/ }).click();
  await item.getByText("详情暂不可用").waitFor();
  await fetch(`${base}/__fixture/allow-trace`);
  await item.getByRole("button", { name: "重试" }).click();
  await item.getByText("第一页真实输出").waitFor();
  await item.getByRole("button", { name: "继续读取执行轨迹" }).click();
  await item.getByText("第二页真实输出").waitFor();
  await item.getByText("原始事件与来源").click();
  const text = await item.innerText();
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
  await page.getByLabel("活动范围").selectOption("all");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => window.scrollTo(0, 500));
  await page.getByRole("link", { name: "查看任务" }).first().click();
  await page.getByRole("link", { name: "返回【窄屏活动测试会话】" }).waitFor();
  await page.getByRole("link", { name: "返回【窄屏活动测试会话】" }).click();
  await page.getByText("第二页真实输出").waitFor();
  assert.equal(await page.getByLabel("活动范围").inputValue(), "all");
  await page.waitForFunction(() => window.scrollY > 0);
  assert.ok(await page.evaluate(() => window.scrollY) > 0, "return restores the Session reading position");
  assert.match(new URL(page.url()).hash, /open=/);
  await page.getByRole("link", { name: "查看任务" }).first().click();
  await page.goBack();
  await page.getByText("第二页真实输出").waitFor();
  await page.reload();
  await page.getByLabel("访问令牌").fill("fixture-token");
  await page.getByRole("button", { name: "进入", exact: true }).click();
  await page.getByText("第一页真实输出").waitFor();
});
