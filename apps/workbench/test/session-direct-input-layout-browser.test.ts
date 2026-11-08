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
        composerBottom: composer.getBoundingClientRect().bottom, receiptHeight: receipt.getBoundingClientRect().height,
        receiptChildren: [...receipt.children].map(child => ({ tag: child.tagName, text: child.textContent,
          height: child.getBoundingClientRect().height, width: child.getBoundingClientRect().width })) };
    });
    console.log("unknown direct layout", layout);
    assert.equal(layout.scale, 1);
    assert.ok(layout.historyHeight >= (viewport.height === 560 ? 90 : viewport.width === 390 ? 180 : 240) &&
      layout.scrollHeight > layout.historyHeight && layout.composerBottom <= viewport.height + 1,
      `unknown result must leave a continuous reading area: ${JSON.stringify(layout)}`);
    assert.equal(await page.getByText("只读取原 inputId，不会重发。").isVisible(), true);
    assert.equal(await page.getByRole("button", { name: "核对结果（不会重发）" }).isVisible(), true);
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

test("a pre-reservation direct grant denial clears unknown pending and leaves only an audit receipt", {
  skip: !modulePath && "Set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE after building the workbench",
}, async t => {
  const { chromium } = (await import(pathToFileURL(modulePath!).href)).default;
  let postCount = 0;
  let submitted: { inputId: string; operationId: string } | null = null;
  const snapshot = { session: { key, target: { kind: "owned", sessionId }, aliases: [], title, profile: null,
    kind: "owned", roles: [], membership: "current", membershipReason: "fixture", runtimeState: "ready", busy: false,
    currentTask: null, latestBusinessRun: null, lastProgressAt: null,
    capabilities: { observe: unavailable, send: { available: true, reason: null, mode: "owned-conversation" },
      open: { ...unavailable, ref: null }, interrupt: unavailable, close: unavailable },
    source: { kind: "session", id: sessionId, revision: null, evidence: "project-record", href: "" }, metadata },
    observationCursor: "0", currentWork: { id: taskId, title: taskTitle, state: "in_progress", revisionId: taskId,
      owner: "reader", relation: "run", source: { kind: "task", id: taskId, revision: taskId, evidence: "project-record", href: "" } },
    assignments: [], roleTasks: [], queue: [], results: [], questions: [], activity: [], resources, metadata };
  const entries = Array.from({ length: 60 }, (_, index) => timelineAssistant(`grant-history-${index}`,
    `授权拒绝前的历史消息 ${index}：此内容用于确认明确拒绝不会挤占原有阅读区。`));
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
        postCount++;
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        submitted = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        status = 409;
        value = { code: "DIRECT_GRANT_MISSING", message: "Exact direct grant is unavailable before reservation" };
      } else if (url.pathname.startsWith(`${direct}/direct-inputs/`)) {
        status = 404; value = { code: "NOT_FOUND", message: "No reservation was created" };
      } else if (url.pathname === `${root}/session-work`) value = { items: [snapshot.session], nextCursor: null,
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
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  await page.goto(`${base}/#/p/${projectId}/sessions?session=${encodeURIComponent(key)}&tab=activity`);
  await page.getByLabel("访问令牌").fill("fixture-token");
  await page.getByRole("button", { name: "进入", exact: true }).click();
  await page.getByLabel("即时发送到原 Session").fill("提前授权拒绝的输入");
  await page.getByRole("button", { name: "开始一轮对话" }).click();
  await page.getByText("明确未接收 · 查看审计回执", { exact: true }).click();
  const auditText = await page.locator(".session-direct-audit").innerText();
  assert.match(auditText, /DIRECT_GRANT_MISSING/);
  assert.match(auditText, /Exact direct grant is unavailable before reservation/);
  assert.match(auditText, new RegExp(String(submitted!.inputId)));
  assert.match(auditText, new RegExp(String(submitted!.operationId)));
  if (process.env.EVOLOOP_TIMELINE_CAPTURE_DIR)
    await page.screenshot({ path: join(process.env.EVOLOOP_TIMELINE_CAPTURE_DIR, "explicit-409-390-audit-open.png") });
  assert.equal(await page.locator(".session-direct-receipt").count(), 0, "explicit rejection is not an unknown pending receipt");
  assert.equal(await page.getByText("发送结果未知；保留原输入 ID，请核对后继续。").count(), 0);
  assert.equal(await page.getByRole("button", { name: "核对结果（不会重发）" }).count(), 0);
  assert.equal(await page.getByRole("button", { name: "开始一轮对话" }).isEnabled(), true);
  assert.equal(await page.getByLabel("即时发送到原 Session").inputValue(), "提前授权拒绝的输入");
  const retained = await page.evaluate(([project, session]) => ({
    pending: sessionStorage.getItem(`direct-input:${project}:${session}:reader`),
    operation: sessionStorage.getItem(`direct-input:${project}:${session}:reader:operation`),
    audit: sessionStorage.getItem(`direct-input:${project}:${session}:reader:explicit-audit`),
  }), [projectId, sessionId]);
  assert.equal(retained.pending, null, "the explicit rejection is not stored as an unknown draft");
  assert.equal(retained.operation, null, "the unknown operation key is cleared after explicit rejection");
  assert.deepEqual(JSON.parse(retained.audit!), {
    inputId: submitted!.inputId, operationId: submitted!.operationId,
    reason: "DIRECT_GRANT_MISSING：Exact direct grant is unavailable before reservation",
    observedAt: JSON.parse(retained.audit!).observedAt,
  });
  assert.equal(postCount, 1);
  await page.getByText("明确未接收 · 查看审计回执", { exact: true }).click();
  const geometry = await page.evaluate(() => {
    const history = document.querySelector<HTMLElement>(".workspace-timeline-scroll")!;
    const composer = document.querySelector<HTMLElement>(".session-composer-host")!;
    return { width: innerWidth, height: innerHeight, scale: visualViewport?.scale ?? null,
      historyHeight: history.clientHeight, composerBottom: composer.getBoundingClientRect().bottom };
  });
  console.log("explicit rejection layout", { ...geometry, auditHeight: await page.locator(".session-direct-audit").evaluate(element => element.getBoundingClientRect().height) });
  assert.equal(geometry.scale, 1);
  assert.ok(geometry.historyHeight >= 120 && geometry.composerBottom <= 844);
  if (process.env.EVOLOOP_TIMELINE_CAPTURE_DIR)
    await page.screenshot({ path: join(process.env.EVOLOOP_TIMELINE_CAPTURE_DIR, "explicit-409-390.png") });

  await page.reload();
  await page.getByLabel("访问令牌").fill("fixture-token");
  await page.getByRole("button", { name: "进入", exact: true }).click();
  await page.getByText("明确未接收 · 查看审计回执", { exact: true }).click();
  assert.match(await page.locator(".session-direct-audit").innerText(), new RegExp(String(submitted!.inputId)));
  await page.getByText("明确未接收 · 查看审计回执", { exact: true }).click();
  assert.equal(await page.getByRole("button", { name: "核对结果（不会重发）" }).count(), 0,
    "reload does not turn an explicit rejection into a recoverable unknown input");
  await page.getByLabel("即时发送到原 Session").fill("修正后重新发送");
  assert.equal(await page.getByRole("button", { name: "开始一轮对话" }).isEnabled(), true);
  assert.equal(postCount, 1, "reload and explicit rejection never post a new operation");
  if (process.env.EVOLOOP_TIMELINE_CAPTURE_DIR)
    await page.screenshot({ path: join(process.env.EVOLOOP_TIMELINE_CAPTURE_DIR, "explicit-409-390-reload.png") });
  await context.close();
});
