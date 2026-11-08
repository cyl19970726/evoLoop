import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { timelineAssistant, timelinePage, timelineStamp } from "./session-timeline-fixtures";

const modulePath = process.env.EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE;
const dist = resolve(import.meta.dirname, "../dist");
const projectId = "97100001-0000-4000-8000-000000000001";
const sessionId = "97100002-0000-4000-8000-000000000002";
const taskId = "97100003-0000-4000-8000-000000000003";
const key = `owned:${sessionId}`;
const title = "时间线分页会话";
const taskTitle = "微信 Connector 首版：标准受管 Session 完整收取与使用微信消息";
const metadata = { generatedAt: timelineStamp, sourceObservedAt: timelineStamp, partial: false, limitations: [] };
const unavailable = { available: false, reason: "fixture unavailable" };
const resources = Object.fromEntries(["configuredModel", "actualModel", "inputTokens", "outputTokens", "cost", "processMemory"]
  .map(name => [name, { value: null, unit: "", source: null, scope: "session", observedAt: null, interval: null, unavailableReason: "未记录" }]));

test("unknown direct input keeps a readable long history at the original window sizes", {
  skip: !modulePath && "Set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE after building the workbench",
}, async t => {
  const { chromium } = (await import(pathToFileURL(modulePath!).href)).default;
  let postCount = 0;
  const snapshot = { session: { key, target: { kind: "owned", sessionId }, aliases: [], title, profile: null,
    kind: "owned", roles: [], membership: "current", membershipReason: "fixture", runtimeState: "ready", busy: false,
    currentTask: null, latestBusinessRun: null, lastProgressAt: null,
    capabilities: { observe: unavailable, send: { available: true, reason: null, mode: "owned-conversation" },
      open: { ...unavailable, ref: null }, interrupt: unavailable, close: unavailable },
    source: { kind: "session", id: sessionId, revision: null, evidence: "project-record", href: "" }, metadata },
    observationCursor: "0", currentWork: { id: taskId, title: taskTitle, state: "in_progress", revisionId: taskId,
      owner: "reader", relation: "run", source: { kind: "task", id: taskId, revision: taskId, evidence: "project-record", href: "" } },
    assignments: [], roleTasks: [], queue: [], results: [], questions: [], activity: [], resources, metadata };
  const entries = Array.from({ length: 96 }, (_, index) => timelineAssistant(`history-${index}`,
    `历史消息 ${index}：这是固定的可阅读内容，用于验证待核对输入出现后仍能连续阅读原有活动。`));
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname.startsWith("/api/")) {
      const root = `/api/projects/${projectId}`;
      const direct = `${root}/sessions/${sessionId}`;
      let value: unknown = { items: [], nextCursor: null, metadata }, status = 200;
      if (url.pathname === "/api/session") value = { principal: { actorId: "reader", projectIds: [projectId], permissions: ["read", "write"] }, capabilities: {} };
      else if (url.pathname === root) value = { id: projectId, title: "测试项目", createdAt: timelineStamp };
      else if (url.pathname === `${direct}/direct-input-capability`) value = { available: true, mode: "start", expectedTurnId: null,
        reasonCode: "READY_TO_START", observedAt: timelineStamp };
      else if (url.pathname === `${direct}/direct-inputs` && req.method === "POST") {
        postCount++; status = 503; value = { code: "SERVICE_UNAVAILABLE", message: "result may have committed" };
      } else if (url.pathname.startsWith(`${direct}/direct-inputs/`)) { status = 404; value = { message: "Not found" }; }
      else if (url.pathname === `${root}/session-work`) value = { items: [snapshot.session], nextCursor: null,
        observationCursor: "0", metadata, totals: { current: 1, historical: 0, unclassified: 0 }, attention: {} };
      else if (url.pathname === `${root}/session-work/changes`) value = { items: [], nextCursor: "0", hasMore: false, resetRequired: false, metadata };
      else if (url.pathname === `${root}/session-work/${encodeURIComponent(key)}`) value = snapshot;
      else if (url.pathname === `${root}/session-work/${encodeURIComponent(key)}/timeline`)
        value = timelinePage(key, { title, entries, nextCursor: null, messagesCursor: null });
      else if (url.pathname.endsWith("/timeline/updates")) value = { cursor: "0", resetRequired: false,
        entries: [], turns: [], freshness: "live", limitations: [], activeTurnId: null };
      else if (url.pathname.endsWith("/recovery")) { status = 404; value = { message: "No recovery" }; }
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
  for (const viewport of [{ width: 390, height: 844, dpr: 1 }, { width: 390, height: 844, dpr: 2 },
    { width: 1536, height: 900, dpr: 1 }, { width: 1280, height: 560, dpr: 1 }]) {
    const context = await browser.newContext({ viewport, deviceScaleFactor: viewport.dpr,
      reducedMotion: viewport.height === 560 ? "reduce" : "no-preference" });
    const page = await context.newPage();
    await page.goto(`${base}/#/p/${projectId}/sessions?session=${encodeURIComponent(key)}&tab=activity`);
    await page.getByLabel("访问令牌").fill("fixture-token");
    await page.getByRole("button", { name: "进入", exact: true }).click();
    await page.getByLabel("即时发送到原 Session").fill("独立验收夹具：核对原输入未知结果，不启动模型。");
    await page.getByRole("button", { name: "开始一轮对话" }).click();
    await page.getByText("发送结果未知；保留原输入 ID，请核对后继续。").waitFor();
    const history = page.getByRole("log", { name: "Session 消息与工具时间线" });
    const layout = await page.evaluate(() => {
      const pane = document.querySelector<HTMLElement>(".workspace-timeline-scroll")!;
      const composer = document.querySelector<HTMLElement>(".session-composer-host")!;
      const receipt = composer.querySelector<HTMLElement>(".session-direct-receipt")!;
      return { width: innerWidth, height: innerHeight, dpr: devicePixelRatio, scale: visualViewport?.scale ?? null,
        historyHeight: pane.clientHeight, scrollHeight: pane.scrollHeight, composerHeight: composer.getBoundingClientRect().height,
        composerBottom: composer.getBoundingClientRect().bottom, receiptHeight: receipt.getBoundingClientRect().height };
    });
    console.log("unknown direct layout", layout);
    assert.equal(layout.scale, 1);
    assert.ok(layout.historyHeight >= (viewport.height === 560 ? 90 : viewport.width === 390 ? 180 : 240) &&
      layout.scrollHeight > layout.historyHeight && layout.composerBottom <= viewport.height + 1,
      `unknown result must leave a continuous reading area: ${JSON.stringify(layout)}`);
    assert.equal(await page.getByRole("button", { name: "按原输入核对" }).isVisible(), true);
    assert.equal(await (await page.locator(".session-direct-receipt small").first().innerText()).startsWith("输入 ID："), true);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "no horizontal overflow");
    const first = history.locator('[data-workspace-entry="history-0"]');
    const middle = history.locator('[data-workspace-entry="history-48"]');
    const last = history.locator('[data-workspace-entry="history-95"]');
    for (const [position, item] of [["first", first], ["middle", middle], ["last", last]] as const) {
      await item.evaluate(element => { element.scrollIntoView({ block: "center" }); });
      const visible = await item.evaluate(element => {
        const pane = element.closest<HTMLElement>(".workspace-timeline-scroll")!.getBoundingClientRect();
        const entry = element.getBoundingClientRect();
        return Math.min(entry.bottom, pane.bottom) - Math.max(entry.top, pane.top);
      });
      assert.ok(visible >= 30, `${position} history entry occupies a readable part of the pane (${visible}px)`);
      if (process.env.EVOLOOP_TIMELINE_CAPTURE_DIR)
        await page.screenshot({ path: join(process.env.EVOLOOP_TIMELINE_CAPTURE_DIR,
          `unknown-${viewport.width}-${viewport.height}-dpr${viewport.dpr}-${position}.png`) });
    }
    const disclosure = page.locator(".session-direct-pending-draft > summary");
    await disclosure.focus(); await disclosure.press("Enter");
    assert.equal(await page.getByLabel("即时发送到原 Session").isVisible(), true, "draft remains keyboard accessible");
    assert.equal(await page.getByRole("button", { name: "开始一轮对话" }).isDisabled(), true,
      "unknown original intent blocks another send even when the draft is expanded");
    await disclosure.press("Enter");
    assert.equal(await page.getByLabel("即时发送到原 Session").isVisible(), false);
    await context.close();
  }
  assert.equal(postCount, 4, "one POST per isolated viewport, with no resend after 503 and read 404");
});
