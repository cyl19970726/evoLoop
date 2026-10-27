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
const longUrl = `https://example.test/results/${"a".repeat(96)}?sha256=${"b".repeat(64)}`;
const activity = { id: "activity-long-run", sequence: "1", sessionKey, kind: "run.completed",
  summary: `旧 Run completed · ${longUrl} · ${"c".repeat(64)}`, occurredAt: stamp, recordedAt: stamp,
  actorId: "worker", taskId: null, importance: "detail",
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
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname.startsWith("/api/")) {
      const root = `/api/projects/${projectId}`;
      let value: unknown = { items: [], nextCursor: null, metadata }, status = 200;
      if (url.pathname === "/api/session") value = { principal: { actorId: "reader", projectIds: [projectId], permissions: ["read"] }, capabilities: {} };
      else if (url.pathname === root) value = { id: projectId, title: "测试项目", createdAt: stamp };
      else if (url.pathname === `${root}/session-work/${encodeURIComponent(sessionKey)}`) value = snapshot;
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
  const item = page.locator(".session-activity-list li").first();
  await item.getByText("旧 Run completed", { exact: false }).waitFor();
  await item.getByText("来源标识").click();
  const text = await item.innerText();
  assert.ok(text.includes(longUrl), "the long URL remains readable rather than truncated");
  assert.ok(text.includes("c".repeat(64)), "the summary hash remains available");
  assert.ok(text.includes(runId), "the expanded source remains available");
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 844 });
    const layout = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth,
      body: document.body.scrollWidth, activity: document.querySelector(".session-activity-list")?.scrollWidth,
      activityWidth: document.querySelector(".session-activity-list")?.clientWidth }));
    assert.ok(layout.document <= layout.viewport && layout.body <= layout.viewport, `${width}px page overflow: ${JSON.stringify(layout)}`);
    assert.ok((layout.activity ?? 0) <= (layout.activityWidth ?? 0), `${width}px activity overflow: ${JSON.stringify(layout)}`);
    if (process.env.EVOLOOP_CAPTURE_ACTIVITY_NARROW) await page.screenshot({ path: `/tmp/evoloop-activity-${width}.png`, fullPage: true });
  }
});
