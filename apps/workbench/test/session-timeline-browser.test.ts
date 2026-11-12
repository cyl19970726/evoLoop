// Opt-in built-app regressions for source-specific Session timeline paging and live merging.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { timelineAssistant, timelineMessage, timelinePage, timelineTool, timelineStamp } from "./session-timeline-fixtures";

const modulePath = process.env.EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE;
const dist = process.env.EVOLOOP_BROWSER_TEST_DIST ?? resolve(import.meta.dirname, "../dist");
const projectId = "97000001-0000-4000-8000-000000000001";
const sessionId = "97000002-0000-4000-8000-000000000002";
const sessionKey = `owned:${sessionId}`;
const sessionBId = "97000003-0000-4000-8000-000000000003";
const sessionBKey = `owned:${sessionBId}`;
const taskId = "97000004-0000-4000-8000-000000000004";
const taskTitle = "微信 Connector 首版：标准受管 Session 完整收取与使用微信消息";
const publicProgress = "标准模式的准入和原生执行分支已接上，路由与数据库约束并行实现同步扩展。接下来处理 delivery 的持久化状态和发送决定；这个环节决定重启、忙时和未知结果如何核对。";
const stamp = timelineStamp;
const metadata = { generatedAt: stamp, sourceObservedAt: stamp, partial: false, limitations: [] };
const unavailable = { available: false, reason: "fixture unavailable" };
const resources = Object.fromEntries(["configuredModel", "actualModel", "inputTokens", "outputTokens", "cost", "processMemory"]
  .map(key => [key, { value: null, unit: "", source: null, scope: "session", observedAt: null, interval: null, unavailableReason: "未记录" }]));
const snapshotFor = (key: string) => {
  const id = key === sessionBKey ? sessionBId : sessionId;
  return { session: { key, target: { kind: "owned", sessionId: id }, aliases: [], title: key === sessionBKey ? "乙时间线会话" : "时间线分页会话", profile: null,
    kind: "owned", roles: [], membership: "current", membershipReason: "fixture", runtimeState: "ready", busy: false,
    currentTask: null, latestBusinessRun: null, lastProgressAt: null,
    capabilities: { observe: unavailable, send: { available: true, reason: null, mode: "owned-conversation" },
      open: { ...unavailable, ref: null }, interrupt: unavailable, close: unavailable },
    source: { kind: "session", id, revision: null, evidence: "project-record", href: "" }, metadata },
    observationCursor: "0", currentWork: key === sessionKey ? { id: taskId, title: taskTitle, state: "in_progress", revisionId: taskId,
      owner: "reader", relation: "run", source: { kind: "task", id: taskId, revision: taskId, evidence: "project-record", href: "" } } : null,
    assignments: [], roleTasks: [], queue: [], results: [], questions: [], activity: [], resources, metadata };
};

test("dual-source history keeps the reader anchor, exhausts cursors, merges live completion, and fits supported viewports", {
  skip: !modulePath && "Set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE after building the workbench",
}, async t => {
  const { chromium } = (await import(pathToFileURL(modulePath!).href)).default;
  const requests: string[] = [];
  let updated = false;
  let sessionBMode: "empty" | "short" | "auto-cap" | "auto-fill" | "manual" = "empty";
  let sessionBAutoNativeReads = 0, sessionBAutoMessageReads = 0;
  let resetHistory = false;
  let resetSnapshot = false;
  let latestTimelineReads = 0;
  let latestTimelineActive = 0;
  let denyUpdates = false;
  let denyNativeHistoryB = false;
  let holdMessagePage = false, messagePageHeld = false, releaseMessagePage: (() => void) | undefined;
  let directEnabled = false, directPostCount = 0;
  let directPostMode: "lost-reply" | "server-error" | "invalid-input" = "lost-reply";
  let directReceipt: Record<string, unknown> | null = null;
  const nativeCurrent = Array.from({ length: 25 }, (_, index) => timelineAssistant(`current-${index}`, `当前会话内容 ${index}`, {
    turnId: `turn-${index}`, nativeItemId: `native-${index}`, occurredAt: new Date(Date.parse(stamp) + index * 1000).toISOString(),
  }));
  const liveAnswer = timelineAssistant("live-answer", publicProgress, { phase: "partial_answer", state: "running", freshness: "live", turnId: "live-turn" });
  const protectedTool = timelineTool("live-tool", "实时命令", "仍在运行", "running", { freshness: "live", turnId: "live-turn" });
  const longToolHistory = Array.from({ length: 100 }, (_, index) => timelineTool(`history-tool-${index}`, `工具 ${index}`, `已核目标 ${index}`,
    index === 3 ? "failed" : "completed", { freshness: "persisted", turnId: "live-turn" }));
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname.startsWith("/api/")) {
      const root = `/api/projects/${projectId}`;
      let value: unknown = { items: [], nextCursor: null, metadata }, status = 200;
      const directBase = `${root}/sessions/${sessionId}`;
      if (url.pathname === `${directBase}/direct-input-capability`) {
        value = { available: directEnabled, mode: directEnabled ? "start" : null, expectedTurnId: null,
          reasonCode: directEnabled ? "READY_TO_START" : "DIRECT_GRANT_MISSING", observedAt: stamp };
      } else if (url.pathname === `${directBase}/direct-inputs` && req.method === "POST") {
        directPostCount++;
        if (directPostMode !== "lost-reply") {
          status = directPostMode === "server-error" ? 503 : 400;
          value = directPostMode === "server-error"
            ? { code: "SERVICE_UNAVAILABLE", message: "result may have committed" }
            : { code: "INVALID_INPUT", message: "request rejected before reservation" };
        } else {
          const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk);
          const command = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          directReceipt = { projectId, sessionId, inputId: command.inputId, operationId: command.operationId,
            actorId: "reader", mode: "start", source: { kind: "message", id: command.inputId, processingId: "fixture-processing" },
            expectedTurnId: null, actualTurnId: null, nativeItemId: null, state: "unknown", reason: "lost acknowledgement",
            version: 2, createdAt: stamp, updatedAt: stamp };
          res.writeHead(200, { "content-type": "application/json" }); res.end("{"); return;
        }
      } else if (url.pathname.startsWith(`${directBase}/direct-inputs/`)) {
        if (!directReceipt || !url.pathname.includes(String(directReceipt.inputId))) { status = 404; value = { message: "Not found" }; }
        else {
          if (url.pathname.endsWith("/reconcile")) directReceipt = { ...directReceipt, state: "accepted", actualTurnId: "fixture-turn", nativeItemId: "fixture-item", version: 3 };
          value = directReceipt;
        }
      }
      else if (url.pathname === "/api/session") value = { principal: { actorId: "reader", projectIds: [projectId], permissions: ["read", "write"] }, capabilities: {} };
      else if (url.pathname === root) value = { id: projectId, title: "测试项目", createdAt: stamp };
      else if (url.pathname === `${root}/session-work`) {
        const membership = url.searchParams.get("membership") ?? "current";
        value = { items: membership === "current" ? [snapshotFor(sessionKey).session] : [], nextCursor: null,
          observationCursor: "0", metadata, totals: { current: 1, historical: 0, unclassified: 1 },
          attention: { unansweredQuestions: 0, pendingMessages: 0, pendingAcceptance: null, unclassifiedSessions: 1 } };
      } else if (url.pathname === `${root}/session-work/changes`) value = {
        items: [], nextCursor: "0", hasMore: false, resetRequired: false, metadata,
      };
      else if (url.pathname === `${root}/tasks/${taskId}`) {
        const task = { projectId, id: taskId, version: 1, currentRevisionId: taskId, title: taskTitle,
          content: "来源任务正文", contentDocumentId: taskId, contentRevisionId: taskId, kind: "implementation",
          acceptance: "可返回来源 Session", owner: "reader", state: "in_progress", basisSetId: null,
          actorId: "reader", reason: "fixture", createdAt: stamp };
        value = { task, revision: { ...task, taskId, id: taskId }, basis: null, links: [], impacts: [], decisions: [],
          deliveries: [], observations: [], closures: [] };
      } else if (url.pathname === `${root}/work-management/tasks/${taskId}`) {
        status = 404; value = { message: "当前工作安排暂不可读" };
      }
      else if (url.pathname === `${root}/impacts` || url.pathname === `${root}/runtime/runs` ||
        url.pathname === `${root}/runtime/sessions` || url.pathname.startsWith(`${root}/references/`)) value = [];
      else if (url.pathname === `${root}/runtime`) value = { available: false, error: null, allowedCwds: [], grants: [] };
      else if (url.pathname === `${root}/orchestration/work-status`) value = { items: [] };
      else if (url.pathname.startsWith(`${root}/session-work/`) && !url.pathname.includes("/timeline")) {
        const key = decodeURIComponent(url.pathname.slice(`${root}/session-work/`.length));
        value = snapshotFor(key);
      } else if (url.pathname.endsWith("/timeline")) {
        const key = decodeURIComponent(url.pathname.slice(`${root}/session-work/`.length, -"/timeline".length));
        const source = url.searchParams.get("source");
        if (!source) { latestTimelineReads++; latestTimelineActive++; }
        requests.push(`${source ?? "both"}:${url.searchParams.get("cursor") ?? ""}:${url.searchParams.get("messagesCursor") ?? ""}`);
        if (key === sessionBKey) {
          if (source === "native" && denyNativeHistoryB) value = timelinePage(key, { nextCursor: "b-native", history: false });
          else if (source === "native" && sessionBMode.startsWith("auto-")) {
            sessionBAutoNativeReads++;
            const pageNumber = Number(url.searchParams.get("cursor")?.split("-").at(-1));
            const count = sessionBMode === "auto-fill" ? 18 : 1;
            value = timelinePage(key, { entries: Array.from({ length: count }, (_, index) => timelineAssistant(
              `b-${sessionBMode}-native-${pageNumber}-${index}`, `乙的更早原生内容 ${pageNumber}-${index}${sessionBMode === "auto-fill" ? " 补充上下文以验证宽幅阅读区填充。".repeat(18) : ""}`)),
              nextCursor: `b-${sessionBMode}-native-${pageNumber + 1}` });
          }
          else if (source === "messages" && sessionBMode.startsWith("auto-")) {
            sessionBAutoMessageReads++;
            const pageNumber = Number(url.searchParams.get("messagesCursor")?.split("-").at(-1));
            const count = sessionBMode === "auto-fill" ? 18 : 1;
            value = timelinePage(key, { pending: Array.from({ length: count }, (_, index) => timelineMessage(
              `b-${sessionBMode}-message-${pageNumber}-${index}`, `乙的更早保存消息 ${pageNumber}-${index}${sessionBMode === "auto-fill" ? " 补充上下文以验证宽幅阅读区填充。".repeat(18) : ""}`)),
              messagesCursor: `b-${sessionBMode}-message-${pageNumber + 1}` });
          }
          else if (source === "native") value = timelinePage(key, { entries: [timelineAssistant("b-older-native", "乙的更早原生内容")], nextCursor: null });
          else if (source === "messages") value = timelinePage(key, { pending: [timelineMessage("b-older", "乙的更早保存消息")], messagesCursor: null });
          else {
            const entries = sessionBMode === "empty" ? [] : sessionBMode === "manual"
              ? Array.from({ length: 25 }, (_, index) => timelineAssistant(`b-manual-current-${index}`, `乙当前原生内容 ${index}`))
              : [timelineAssistant("b-current", "乙会话内容")];
            const autoPrefix = sessionBMode.startsWith("auto-") ? `b-${sessionBMode}` : "b";
            value = timelinePage(key, { title: "乙时间线会话", entries,
              nextCursor: sessionBMode === "short" || sessionBMode === "empty" ? null
                : sessionBMode === "manual" ? "b-native" : `${autoPrefix}-native-1`,
              messagesCursor: sessionBMode === "short" || sessionBMode === "empty" ? null
                : sessionBMode === "manual" ? "b-messages" : `${autoPrefix}-message-1`, cursor: "1",
              liveTurns: sessionBMode === "empty" ? [{ id: "b-live-turn", state: "running", startedAt: stamp, completedAt: null, origin: null }] : [] });
          }
        } else if (source === "messages" && holdMessagePage) {
          messagePageHeld = true;
          await new Promise<void>(resolve => { releaseMessagePage = resolve; });
          value = timelinePage(key, { pending: [{ id: "message:stale-a-page", kind: "message", role: "input", phase: "unknown", body: "STALE A PAGE",
            clientId: "stale-a-page", state: "completed", turnId: null, nativeItemId: null, nativeKind: null,
            author: { kind: "actor", id: "reader", label: "reader" },
            origin: { kind: "message", id: "stale-a-page", taskId: null, taskRevisionId: null, initiatingActorId: "reader" },
            occurredAt: stamp, observedAt: stamp, freshness: "persisted", truncated: false }], messagesCursor: null });
        }
        else if (source === "native" && url.searchParams.get("cursor") === "native-gap-1") {
          value = timelinePage(key, { entries: [timelineAssistant("reset-native-gap", "重置后补齐的原生历史")], nextCursor: null });
        } else if (source === "messages" && url.searchParams.get("messagesCursor") === "messages-gap-1") {
          value = timelinePage(key, { pending: [timelineMessage("reset-messages-gap", "重置后补齐的已保存消息")], messagesCursor: null });
        } else if (source === "native") {
          await new Promise(resolve => setTimeout(resolve, 180));
          value = timelinePage(key, { entries: Array.from({ length: 10 }, (_, index) => timelineAssistant(`older-native-${index}`, `较早原生内容 ${index}`, {
            turnId: `old-turn-${index}`, occurredAt: new Date(Date.parse(stamp) - (10 - index) * 1000).toISOString(),
            ...(index === 0 ? { origin: { kind: "run" as const, id: "97000005-0000-4000-8000-000000000005",
              taskId, taskRevisionId: taskId, initiatingActorId: "reader" } } : {}),
          })), pending: [timelineMessage("native-page-pg-input", "原生分页携带的权威已保存输入", {
            turnId: "old-turn-0", origin: { kind: "message", id: "native-page-pg-input", taskId: null,
              taskRevisionId: null, initiatingActorId: "reader" },
          })], cursor: "2", nextCursor: null, messagesCursor: null });
        } else if (source === "messages" && !holdMessagePage) {
          await new Promise(resolve => setTimeout(resolve, 850));
          value = timelinePage(key, { pending: Array.from({ length: 10 }, (_, index) => ({
            id: `message:older-${index}`, kind: "message", role: "input", phase: "unknown", body: `较早已保存消息 ${index}`,
            clientId: `older-${index}`, state: "completed", turnId: null, nativeItemId: null, nativeKind: null,
            author: { kind: "actor", id: "reader", label: "reader" },
            origin: { kind: "message", id: `older-${index}`, taskId: null, taskRevisionId: null, initiatingActorId: "reader" },
            occurredAt: new Date(Date.parse(stamp) - (30 - index) * 1000).toISOString(), observedAt: stamp,
            freshness: "persisted", truncated: false,
          })), cursor: "2", nextCursor: null, messagesCursor: null });
        } else if (source !== "native" && source !== "messages" && key === sessionKey) {
          if (resetSnapshot) {
            resetSnapshot = false;
            value = timelinePage(sessionKey, { title: "时间线分页会话", entries: nativeCurrent,
              turns: [...nativeCurrent.map((entry, index) => ({ id: `turn-${index}`, state: "completed" as const, startedAt: stamp, completedAt: stamp, origin: null })),
                { id: "historical-running-turn", state: "running", startedAt: stamp, completedAt: null, origin: null }],
              nextCursor: "native-gap-1", messagesCursor: "messages-gap-1", cursor: "3" });
          } else value = timelinePage(sessionKey, { title: "时间线分页会话", entries: nativeCurrent,
            turns: [...nativeCurrent.map((entry, index) => ({ id: `turn-${index}`, state: "completed" as const, startedAt: stamp, completedAt: stamp, origin: null })),
              { id: "historical-running-turn", state: "running", startedAt: stamp, completedAt: null, origin: null }],
            nextCursor: "native-1", messagesCursor: "messages-1", cursor: "1", liveEntries: [liveAnswer, ...longToolHistory, protectedTool],
            liveTurns: [{ id: "live-turn", state: "running", startedAt: stamp, completedAt: null,
              origin: { kind: "run", id: "97000005-0000-4000-8000-000000000005", taskId, taskRevisionId: taskId, initiatingActorId: "reader" } }] });
        }
      } else if (url.pathname.endsWith("/timeline/updates")) {
        const key = decodeURIComponent(url.pathname.slice(`${root}/session-work/`.length, -"/timeline/updates".length));
        if (denyUpdates && key === sessionKey) { status = 403; value = { message: "时间线读取权限已撤销" }; }
        else if (resetHistory && key === sessionKey) {
          resetHistory = false;
          resetSnapshot = true;
          value = { cursor: "3", resetRequired: true, entries: [], turns: [], freshness: "live", limitations: [], activeTurnId: null };
        }
        else value = key === sessionKey && updated ? {
          cursor: "2", resetRequired: false, entries: [{ ...liveAnswer, body: "最终回复已完成", phase: "final_answer", state: "completed" }],
          turns: [{ id: "live-turn", state: "completed", startedAt: stamp, completedAt: stamp, origin: null }], freshness: "live", limitations: [], activeTurnId: null,
        } : { cursor: "1", resetRequired: false, entries: [], turns: [], freshness: "live", limitations: [],
          activeTurnId: key === sessionKey ? "live-turn" : key === sessionBKey && sessionBMode === "empty" ? "b-live-turn" : null };
      }
      else if (url.pathname.endsWith("/timeline/items/live-tool")) { status = 403; value = { message: "原始工具证据需要复核权限" }; }
      else if (url.pathname.endsWith("/recovery")) { status = 404; value = { message: "无恢复记录" }; }
      if (url.pathname.endsWith("/timeline") && !url.searchParams.has("source")) latestTimelineActive--;
      res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); return;
    }
    if (url.pathname === "/__fixture/update") { updated = true; res.end("ok"); return; }
    if (url.pathname === "/__fixture/direct-enable") { directEnabled = true; res.end("ok"); return; }
    if (url.pathname === "/__fixture/direct-server-error") { directPostMode = "server-error"; res.end("ok"); return; }
    if (url.pathname === "/__fixture/direct-invalid-input") { directPostMode = "invalid-input"; res.end("ok"); return; }
    if (url.pathname === "/__fixture/direct-count") { res.end(String(directPostCount)); return; }
    if (["short", "auto-cap", "auto-fill", "manual"].some(mode => url.pathname === `/__fixture/session-b-${mode}`)) {
      sessionBMode = url.pathname.endsWith("-short") ? "short" : url.pathname.endsWith("-auto-cap") ? "auto-cap"
        : url.pathname.endsWith("-auto-fill") ? "auto-fill" : "manual";
      sessionBAutoNativeReads = 0; sessionBAutoMessageReads = 0; res.end("ok"); return;
    }
    if (url.pathname === "/__fixture/session-b-auto-counts") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ native: sessionBAutoNativeReads, messages: sessionBAutoMessageReads })); return;
    }
    if (url.pathname === "/__fixture/deny-native-history-b") { denyNativeHistoryB = true; res.end("ok"); return; }
    if (url.pathname === "/__fixture/allow-native-history-b") { denyNativeHistoryB = false; res.end("ok"); return; }
    if (url.pathname === "/__fixture/hold-message-page") { holdMessagePage = true; res.end("ok"); return; }
    if (url.pathname === "/__fixture/message-page-held") { res.end(String(messagePageHeld)); return; }
    if (url.pathname === "/__fixture/release-message-page") { releaseMessagePage?.(); res.end("ok"); return; }
    if (url.pathname === "/__fixture/latest-timeline-reads") { res.end(String(latestTimelineReads)); return; }
    if (url.pathname === "/__fixture/latest-timeline-active") { res.end(String(latestTimelineActive)); return; }
    if (url.pathname === "/__fixture/reset-history") { resetHistory = true; res.end("ok"); return; }
    if (url.pathname === "/__fixture/deny-updates") { denyUpdates = true; res.end("ok"); return; }
    if (url.pathname === "/__fixture/requests") { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(requests)); return; }
    try {
      const file = /^\/(?:$|p\/|ui$)/.test(url.pathname) ? "index.html" : url.pathname;
      const body = await readFile(join(dist, file));
      res.writeHead(200, { "content-type": ({ ".html": "text/html", ".js": "text/javascript", ".css": "text/css" } as Record<string, string>)[extname(file)] ?? "application/octet-stream" }); res.end(body);
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const browser = await chromium.launch({ headless: true, ...(process.env.EVOLOOP_BROWSER_TEST_EXECUTABLE_PATH
    ? { executablePath: process.env.EVOLOOP_BROWSER_TEST_EXECUTABLE_PATH } : {}) }); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1536, height: 900 } });
  const pageErrors: string[] = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  const baselinePage = await browser.newPage({ viewport: { width: 1536, height: 900 } });
  await baselinePage.goto(`${base}/p/${projectId}/tasks/${taskId}`);
  await baselinePage.getByLabel("访问令牌").fill("fixture-token");
  await baselinePage.getByRole("button", { name: "进入", exact: true }).click();
  await baselinePage.getByRole("heading", { name: taskTitle }).waitFor();
  const taskShellBaseline = await baselinePage.locator("[data-shell=frame]").evaluate(element => ({
    rail: element.getAttribute("data-rail"),
    columns: getComputedStyle(element).gridTemplateColumns.split(" ").slice(0, 2),
  }));
  assert.equal(taskShellBaseline.rail, "shown", "a fresh Task page shows the inner rail at this width");
  await baselinePage.close();
  await page.goto(`${base}/p/${projectId}/sessions`);
  await page.getByLabel("访问令牌").fill("fixture-token");
  await page.getByRole("button", { name: "进入", exact: true }).click();
  // Without a selected agent the Sessions space opens 统筹安排.
  await page.getByRole("heading", { name: "统筹安排", exact: true }).waitFor();
  if (await page.locator("[data-shell=frame]").getAttribute("data-rail") !== "shown") await page.getByRole("button", { name: "展开项目导航" }).click();
  const directory = page.locator("aside[aria-label=项目导航] .session-navigation");
  await directory.locator(".session-nav-item").filter({ hasText: "时间线分页会话" }).click();
  await page.getByRole("heading", { name: "时间线分页会话" }).waitFor();
  const shellLayout = async () => page.locator("[data-shell=frame]").evaluate(element => ({
    rail: element.getAttribute("data-rail"),
    columns: getComputedStyle(element).gridTemplateColumns.split(" ").slice(0, 2),
  }));
  const assertSessionReaderShell = async () => {
    const shell = await shellLayout();
    assert.deepEqual(shell, taskShellBaseline, "the selected Session uses the same frame as a Task");
  };
  const assertDefaultShell = async () => {
    const shell = await shellLayout();
    assert.deepEqual(shell, taskShellBaseline,
      `non-Session routes restore the fresh Task shell after a Session visit (baseline=${JSON.stringify(taskShellBaseline)}, current=${JSON.stringify(shell)})`);
  };
  await assertSessionReaderShell();
  // The live status line ends the flow: what runs now, how long, and the task the turn works on.
  const measureCurrent = async (target: typeof page) => target.evaluate(text => {
    const status = document.querySelector<HTMLElement>(".workspace-turn-state")!;
    const task = status.querySelector<HTMLElement>("a")!;
    const history = document.querySelector<HTMLElement>(".workspace-timeline-scroll")!;
    const composer = document.querySelector<HTMLElement>(".session-composer-host")!;
    const tabs = document.querySelector<HTMLElement>("[data-shell=tabs]");
    const progress = [...history.querySelectorAll<HTMLElement>("[data-workspace-entry]")].find(entry => entry.textContent?.includes(text));
    return { dpr: devicePixelRatio, width: innerWidth, scale: visualViewport?.scale ?? null,
      statusHeight: status.getBoundingClientRect().height, statusWidth: status.getBoundingClientRect().width, statusText: status.textContent ?? "",
      historyHeight: history.clientHeight, composerBottom: composer.getBoundingClientRect().bottom,
      tabsTop: tabs && getComputedStyle(tabs).display !== "none" ? tabs.getBoundingClientRect().top : innerHeight,
      taskText: task.textContent ?? "", progressShown: !!progress };
  }, publicProgress);
  const narrowMeasurements: Array<{ dpr: number; statusHeight: number; statusWidth: number; statusText: string; historyHeight: number;
    composerBottom: number; tabsTop: number; taskText: string; progressShown: boolean; width: number; scale: number | null }> = [];
  for (const dpr of [1, 2]) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: dpr });
    const narrow = await context.newPage();
    await narrow.goto(`${base}/p/${projectId}/sessions?session=${encodeURIComponent(sessionKey)}&tab=activity`);
    await narrow.getByLabel("访问令牌").fill("fixture-token");
    await narrow.getByRole("button", { name: "进入", exact: true }).click();
    await narrow.locator(".workspace-turn-state a").waitFor();
    const measure = await measureCurrent(narrow);
    narrowMeasurements.push(measure);
    if (process.env.EVOLOOP_TIMELINE_CAPTURE_DIR)
      await narrow.screenshot({ path: join(process.env.EVOLOOP_TIMELINE_CAPTURE_DIR, `narrow-dpr${dpr}.png`) });
    await context.close();
  }
  console.log("narrow live status", narrowMeasurements);
  for (const measurement of narrowMeasurements) {
    assert.equal(measurement.width, 390);
    assert.equal(measurement.scale, 1);
    assert.equal(measurement.taskText, `任务「${taskTitle}」`);
    assert.match(measurement.statusText, /正在执行 实时命令/);
    assert.ok(measurement.progressShown, "the turn's public progress reads in the flow");
    assert.ok(measurement.statusWidth <= 390 && measurement.statusHeight <= 90,
      `the live status line stays readable within the phone width at DPR${measurement.dpr}: ${JSON.stringify(measurement)}`);
    assert.ok(measurement.historyHeight >= 120 && measurement.composerBottom <= measurement.tabsTop + 1,
      `narrow layout reserves a scrollable history and a fully visible composer at DPR${measurement.dpr}: ${JSON.stringify(measurement)}`);
  }
  const desktopCurrent = await measureCurrent(page);
  assert.ok(desktopCurrent.statusHeight <= 40 && desktopCurrent.progressShown && desktopCurrent.historyHeight >= 200 && desktopCurrent.composerBottom <= 900,
    `normal window keeps the live status, progress and history readable: ${JSON.stringify(desktopCurrent)}`);
  const shortContext = await browser.newContext({ viewport: { width: 1280, height: 560 }, deviceScaleFactor: 1, reducedMotion: "reduce" });
  const short = await shortContext.newPage();
  await short.goto(`${base}/p/${projectId}/sessions?session=${encodeURIComponent(sessionKey)}&tab=activity`);
  await short.getByLabel("访问令牌").fill("fixture-token");
  await short.getByRole("button", { name: "进入", exact: true }).click();
  await short.locator(".workspace-turn-state a").waitFor();
  const shortCurrent = await measureCurrent(short);
  if (process.env.EVOLOOP_TIMELINE_CAPTURE_DIR)
    await short.screenshot({ path: join(process.env.EVOLOOP_TIMELINE_CAPTURE_DIR, "short-running-reduced.png") });
  assert.ok(shortCurrent.progressShown && shortCurrent.statusHeight <= 40 && shortCurrent.historyHeight >= 45 && shortCurrent.composerBottom <= 560,
    `short reduced-motion window keeps the current progress and composer usable: ${JSON.stringify(shortCurrent)}`);
  await shortContext.close();
  const timeline = page.getByRole("log", { name: "消息与工具时间线" });
  await timeline.locator('[data-workspace-entry="current-0"]').waitFor();
  assert.equal(await timeline.locator(".workspace-tool").count(), 2, "100+ tools fold into one line; the failure and the running step stay in sight");
  if (process.env.EVOLOOP_TIMELINE_CAPTURE_DIR) {
    console.log("desktop viewport", await page.evaluate(() => ({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio, scale: visualViewport?.scale ?? null })));
    await page.screenshot({ path: join(process.env.EVOLOOP_TIMELINE_CAPTURE_DIR, "desktop.png") });
  }
  assert.equal(await timeline.locator('[data-workspace-entry="live-answer"]').count(), 1);
  await timeline.locator(".workspace-turn-state").getByText("正在执行 实时命令", { exact: true }).waitFor();
  assert.ok(await timeline.locator(".workspace-turn-state").getByText("正在执行 实时命令", { exact: true }).count() === 1,
    "a running turn named by the live read activeTurnId shows the live status line");
  await timeline.getByRole("button", { name: "加载更早的消息与活动" }).waitFor();

  await page.evaluate(() => {
    const node = document.querySelector<HTMLElement>(".workspace-timeline-scroll")!;
    node.scrollTop = 0;
  });
  const anchor = await page.evaluate(() => {
    const node = document.querySelector<HTMLElement>(".workspace-timeline-scroll")!;
    const visible = [...node.querySelectorAll<HTMLElement>("[data-workspace-entry]")].find(item => item.getBoundingClientRect().bottom > node.getBoundingClientRect().top)!;
    return { id: visible.dataset.workspaceEntry, top: visible.getBoundingClientRect().top };
  });
  await timeline.getByRole("button", { name: "加载更早的消息与活动" }).click();
  await timeline.getByText("较早已保存消息 0", { exact: true }).waitFor();
  await timeline.getByText("较早原生内容 0", { exact: true }).waitFor();
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  assert.equal(await timeline.getByText("原生分页携带的权威已保存输入", { exact: true }).count(), 1,
    "authoritative PostgreSQL inputs returned in a native-only page remain visible once");
  const afterAnchor = await page.evaluate(id => {
    const node = document.querySelector<HTMLElement>(".workspace-timeline-scroll")!;
    const visible = node.querySelector<HTMLElement>(`[data-workspace-entry="${id}"]`)!;
    return { top: visible.getBoundingClientRect().top };
  }, anchor.id!);
  assert.ok(Math.abs(afterAnchor.top - anchor.top) <= 3,
    `the same timeline entry should stay at the same viewport position across both source responses (${anchor.top} -> ${afterAnchor.top})`);

  const toolGroup = timeline.locator(".workspace-tools");
  const toolToggle = toolGroup.locator(".workspace-tools-toggle");
  if (await toolToggle.getAttribute("aria-expanded") !== "true") await toolToggle.click();
  const sourceEntry = timeline.locator('[data-workspace-entry="older-native-0"]');
  const sourceTaskLink = sourceEntry.getByRole("link", { name: "查看来源任务" });
  await sourceTaskLink.waitFor();
  await sourceEntry.evaluate(element => {
    const node = element.closest<HTMLElement>(".workspace-timeline-scroll")!;
    node.scrollTop += element.getBoundingClientRect().top - node.getBoundingClientRect().top - 70;
  });
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  const roundtripAnchor = await sourceEntry.evaluate(element => element.getBoundingClientRect().top);
  await sourceTaskLink.click();
  await page.getByRole("heading", { name: taskTitle }).waitFor();
  await assertDefaultShell();
  const taskBack = page.getByRole("link", { name: /返回智能体：时间线分页会话/ });
  assert.equal(await taskBack.count(), 1,
    `Task route should retain its exact Session return; route=${page.url()}, errors=${pageErrors.join(" | ")}, page=${(await page.locator("body").innerText()).slice(0, 500)}`);
  await taskBack.click();
  await page.getByRole("heading", { name: "时间线分页会话" }).waitFor();
  const returnedTimeline = page.getByRole("log", { name: "消息与工具时间线" });
  const returnedEntry = returnedTimeline.locator('[data-workspace-entry="older-native-0"]');
  await returnedEntry.waitFor();
  await assertSessionReaderShell();
  let returnedTop = await returnedEntry.evaluate(element => element.getBoundingClientRect().top);
  for (let attempt = 0; attempt < 20 && Math.abs(returnedTop - roundtripAnchor) > 3; attempt++) {
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    returnedTop = await returnedEntry.evaluate(element => element.getBoundingClientRect().top);
  }
  assert.ok(Math.abs(returnedTop - roundtripAnchor) <= 3,
    `source Task roundtrip restores the same reading position (${roundtripAnchor} -> ${returnedTop})`);
  assert.equal(await returnedEntry.count(), 1, "the loaded native page remains single after returning from its source Task");
  assert.equal(await returnedTimeline.locator(".workspace-tools-toggle").getAttribute("aria-expanded"), "true",
    "expanded tools remain expanded after returning from the source Task");

  const readRequests = await (await fetch(`${base}/__fixture/requests`)).json() as string[];
  assert.ok(readRequests.includes("native:native-1:"), "native paging advances with its own cursor");
  assert.ok(readRequests.includes("messages::messages-1"), "saved message paging advances with its own cursor");
  assert.equal(await timeline.getByRole("button", { name: "加载更早的消息与活动" }).count(), 0, "both source cursors are exhausted");
  for (let attempt = 0; attempt < 180 && Number(await (await fetch(`${base}/__fixture/latest-timeline-reads`)).text()) < 2; attempt++)
    await page.waitForTimeout(100);
  assert.ok(Number(await (await fetch(`${base}/__fixture/latest-timeline-reads`)).text()) >= 2, "the timeline snapshot polling tick ran");
  assert.equal(await timeline.getByRole("button", { name: "加载更早的消息与活动" }).count(), 0,
    "live polling does not restore cursors for exhausted history sources");

  await fetch(`${base}/__fixture/update`);
  await timeline.getByText("最终回复已完成", { exact: true }).waitFor({ timeout: 5000 });
  assert.equal(await timeline.locator('[data-workspace-entry="live-answer"]').count(), 1,
    "a live update replaces the snapshot item with the same ID instead of adding a duplicate");
  await page.waitForFunction(() => document.querySelector(".workspace-turn-state") === null);
  assert.equal(await timeline.locator(".workspace-turn-state").count(), 0,
    "a historical running turn does not keep the processing footer after the qualified current turn completes with activeTurnId null");
  for (let attempt = 0; attempt < 100 && Number(await (await fetch(`${base}/__fixture/latest-timeline-active`)).text()) > 0; attempt++)
    await page.waitForTimeout(25);
  assert.equal(Number(await (await fetch(`${base}/__fixture/latest-timeline-active`)).text()), 0,
    "the ordinary snapshot poll settled before the reset signal is introduced");
  await fetch(`${base}/__fixture/reset-history`);
  await timeline.getByRole("button", { name: "加载更早的消息与活动" }).waitFor({ timeout: 5000 });
  const staleLiveAnswer = timeline.locator('[data-workspace-entry="live-answer"]');
  await staleLiveAnswer.getByText("最终回复已完成", { exact: true }).waitFor();
  await staleLiveAnswer.getByText("上次观察", { exact: true }).waitFor();
  await timeline.getByRole("button", { name: "加载更早的消息与活动" }).click();
  await timeline.getByText("重置后补齐的原生历史", { exact: true }).waitFor();
  await timeline.getByText("重置后补齐的已保存消息", { exact: true }).waitFor();
  const resetRequests = await (await fetch(`${base}/__fixture/requests`)).json() as string[];
  assert.ok(resetRequests.includes("native:native-gap-1:"), "a live reset rebases native history from its new first-page cursor");
  assert.ok(resetRequests.includes("messages::messages-gap-1"), "a live reset rebases saved-message history from its new first-page cursor");
  assert.equal(await timeline.getByRole("button", { name: "加载更早的消息与活动" }).count(), 0,
    "both reset gap cursors exhaust after their new pages load");

  await page.setViewportSize({ width: 390, height: 844 });
  const textarea = page.locator(".session-composer-host textarea");
  const mobileBefore = await page.evaluate(() => {
    const messages = document.querySelector<HTMLElement>(".workspace-timeline-scroll")!;
    const composer = document.querySelector<HTMLElement>(".session-composer-host")!;
    const input = composer.querySelector<HTMLTextAreaElement>("textarea")!;
    return { viewportHeight: innerHeight, messageHeight: messages.clientHeight, messageScrollHeight: messages.scrollHeight,
      messageBottom: messages.getBoundingClientRect().bottom, composerTop: composer.getBoundingClientRect().top,
      composerBottom: composer.getBoundingClientRect().bottom, composerHeight: composer.getBoundingClientRect().height,
      inputHeight: input.getBoundingClientRect().height, pageWidth: document.documentElement.scrollWidth };
  });
  if (process.env.EVOLOOP_TIMELINE_CAPTURE_DIR) {
    console.log("mobile viewport", await page.evaluate(() => ({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio, scale: visualViewport?.scale ?? null })));
    await page.screenshot({ path: join(process.env.EVOLOOP_TIMELINE_CAPTURE_DIR, "mobile.png") });
  }
  assert.ok(mobileBefore.messageHeight > 0 && mobileBefore.messageScrollHeight > mobileBefore.messageHeight,
    "long mobile history remains in a scrollable message pane");
  assert.ok(mobileBefore.composerBottom <= mobileBefore.viewportHeight + 1,
    `the composer stays within the phone viewport: ${JSON.stringify(mobileBefore)}`);
  assert.ok(mobileBefore.messageBottom <= mobileBefore.composerTop + 1, "the composer does not cover the message pane");
  assert.ok(mobileBefore.pageWidth <= 390, "the long mobile timeline has no horizontal overflow");
  await textarea.fill(Array.from({ length: 9 }, (_, index) => `手机输入行 ${index + 1}`).join("\n"));
  await page.waitForFunction(height => document.querySelector<HTMLTextAreaElement>(".session-composer-host textarea")!.getBoundingClientRect().height > height + 20,
    mobileBefore.inputHeight);
  const mobileAfter = await page.evaluate(() => {
    const messages = document.querySelector<HTMLElement>(".workspace-timeline-scroll")!;
    const composer = document.querySelector<HTMLElement>(".session-composer-host")!;
    const input = composer.querySelector<HTMLTextAreaElement>("textarea")!;
    return { viewportHeight: innerHeight, messageHeight: messages.clientHeight, messageScrollHeight: messages.scrollHeight,
      messageBottom: messages.getBoundingClientRect().bottom, composerTop: composer.getBoundingClientRect().top,
      composerBottom: composer.getBoundingClientRect().bottom, composerHeight: composer.getBoundingClientRect().height,
      inputHeight: input.getBoundingClientRect().height, pageWidth: document.documentElement.scrollWidth };
  });
  assert.ok(mobileAfter.inputHeight > mobileBefore.inputHeight && mobileAfter.composerHeight > mobileBefore.composerHeight,
    "a multiline draft grows the composer");
  assert.ok(mobileAfter.messageHeight < mobileBefore.messageHeight,
    `the message viewport gives space to the growing composer (${mobileBefore.messageHeight} -> ${mobileAfter.messageHeight})`);
  assert.ok(mobileAfter.messageScrollHeight > mobileAfter.messageHeight, "long history remains scrollable after the composer grows");
  assert.ok(mobileAfter.messageBottom <= mobileAfter.composerTop + 1, "the grown composer still does not cover history");
  assert.ok(mobileAfter.composerBottom <= mobileAfter.viewportHeight + 1 && mobileAfter.pageWidth <= 390,
    `the grown composer stays in the viewport without horizontal overflow: ${JSON.stringify(mobileAfter)}`);
  if (await toolGroup.locator(".workspace-tools-toggle").getAttribute("aria-expanded") !== "true") await toolGroup.locator(".workspace-tools-toggle").click();
  const toolDetailTrigger = toolGroup.getByRole("button", { name: "查看工具详情：实时命令" });
  await toolDetailTrigger.focus();
  await toolDetailTrigger.press("Enter");
  const inspector = toolGroup.locator(".workspace-tool-inline");
  await inspector.waitFor();
  await inspector.getByRole("button", { name: "读取原始输入与输出" }).click();
  await inspector.getByText("原始工具证据需要复核权限").waitFor();
  assert.equal(await inspector.getByText("秘密", { exact: false }).count(), 0, "a 403 detail response does not expose original tool evidence");
  await toolGroup.getByRole("button", { name: "收起工具详情：实时命令" }).click();
  await inspector.waitFor({ state: "detached" });
  assert.equal(await toolDetailTrigger.evaluate(element => document.activeElement === element), true,
    "closing inline details restores focus to its exact tool trigger");
  await page.setViewportSize({ width: 1280, height: 560 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  const shortLayout = await page.evaluate(() => ({ historyHeight: document.querySelector<HTMLElement>(".workspace-timeline-scroll")!.clientHeight,
    composerBottom: document.querySelector<HTMLElement>(".session-composer-host")!.getBoundingClientRect().bottom }));
  assert.ok(shortLayout.historyHeight >= 90 && shortLayout.composerBottom <= 560,
    `short window leaves a readable history viewport and visible composer: ${JSON.stringify(shortLayout)}`);
  assert.ok(Number.parseFloat(await toolGroup.locator(".workspace-tools-toggle > svg:first-child").evaluate(element => getComputedStyle(element).transitionDuration)) < .001,
    "reduced motion disables the tool disclosure transition");
  if (process.env.EVOLOOP_TIMELINE_CAPTURE_DIR) {
    console.log("short viewport", await page.evaluate(() => ({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio, scale: visualViewport?.scale ?? null })));
    await page.screenshot({ path: join(process.env.EVOLOOP_TIMELINE_CAPTURE_DIR, "short.png") });
  }
  if (await toolGroup.locator(".workspace-tools-toggle").getAttribute("aria-expanded") !== "true") await toolGroup.locator(".workspace-tools-toggle").click();
  await toolGroup.getByRole("button", { name: "查看工具详情：实时命令" }).click();
  const revokedInspector = toolGroup.locator(".workspace-tool-inline");
  await revokedInspector.waitFor();
  await fetch(`${base}/__fixture/deny-updates`);
  await revokedInspector.waitFor({ state: "detached", timeout: 5000 });
  await page.locator(".unified-session-timeline").getByText(/活动暂不可读取：时间线读取权限已撤销/).waitFor();
  assert.equal(await timeline.locator('[data-workspace-entry]').count(), 0,
    "a later denied timeline read clears prior entries and closes the inspector");

  for (const viewport of [{ width: 1536, height: 900 }, { width: 1440, height: 900 }, { width: 1171, height: 900 },
    { width: 871, height: 900 }, { width: 390, height: 844 }, { width: 1280, height: 560 }]) {
    await page.setViewportSize(viewport);
    const overflow = await page.evaluate(() => ({ width: document.body.scrollWidth, offenders: [...document.querySelectorAll<HTMLElement>("body *")]
      .filter(element => element.getBoundingClientRect().right > innerWidth + 1)
      .slice(0, 8).map(element => ({ tag: element.tagName, className: element.className, text: element.textContent?.slice(0, 80),
        parents: [element, element.parentElement, element.parentElement?.parentElement, element.parentElement?.parentElement?.parentElement]
          .filter(Boolean).map(node => ({ name: node!.tagName, className: (node as HTMLElement).className, left: node!.getBoundingClientRect().left, width: node!.getBoundingClientRect().width })),
        left: element.getBoundingClientRect().left, width: element.getBoundingClientRect().width,
        right: element.getBoundingClientRect().right })) }));
    assert.ok(overflow.width <= viewport.width,
      `no horizontal overflow at ${viewport.width}×${viewport.height}: ${JSON.stringify(overflow)}`);
    const composer = await page.locator(".session-composer-host").boundingBox();
    assert.ok(composer && composer.width > 0 && composer.height > 0, `composer remains visible at ${viewport.width}×${viewport.height}`);
  }

  const switchPage = await browser.newPage({ viewport: { width: 1171, height: 871 } });
  await switchPage.goto(`${base}/p/${projectId}/sessions?session=${encodeURIComponent(sessionKey)}&tab=activity`);
  await switchPage.getByLabel("访问令牌").fill("fixture-token");
  await switchPage.getByRole("button", { name: "进入", exact: true }).click();
  await switchPage.getByRole("heading", { name: "时间线分页会话" }).waitFor();
  await fetch(`${base}/__fixture/hold-message-page`);
  const switchTimeline = switchPage.getByRole("log", { name: "消息与工具时间线" });
  await switchTimeline.getByRole("button", { name: "加载更早的消息与活动" }).click();
  for (let attempt = 0; attempt < 60 && await (await fetch(`${base}/__fixture/message-page-held`)).text() !== "true"; attempt++)
    await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(await (await fetch(`${base}/__fixture/message-page-held`)).text(), "true", "Session A's messages page is held in flight");
  await switchPage.evaluate(([project, key]) => { location.hash = `/p/${project}/sessions?session=${encodeURIComponent(key)}&tab=activity`; }, [projectId, sessionBKey]);
  await switchPage.getByRole("heading", { name: "乙时间线会话" }).waitFor();
  const timelineB = switchPage.getByRole("log", { name: "消息与工具时间线" });
  await timelineB.locator(".workspace-turn-state").getByText("正在处理", { exact: true }).waitFor();
  assert.equal(await timelineB.locator("[data-workspace-entry]").count(), 0,
    "the active-turn empty-state case has no public timeline entries");
  assert.equal(await timelineB.locator(".session-conversation-empty").count(), 0,
    "an identified active turn does not show the start-a-conversation empty state");
  const openSessionB = async (mode: "short" | "auto-cap" | "auto-fill" | "manual", viewport: { width: number; height: number }) => {
    await fetch(`${base}/__fixture/session-b-${mode}`);
    const testPage = await browser.newPage({ viewport });
    await testPage.goto(`${base}/p/${projectId}/sessions?session=${encodeURIComponent(sessionBKey)}&tab=activity`);
    await testPage.getByLabel("访问令牌").fill("fixture-token");
    await testPage.getByRole("button", { name: "进入", exact: true }).click();
    await testPage.getByRole("heading", { name: "乙时间线会话" }).waitFor();
    return { page: testPage, timeline: testPage.getByRole("log", { name: "消息与工具时间线" }) };
  };
  const shortCase = await openSessionB("short", { width: 2880, height: 1772 });
  await shortCase.timeline.locator('[data-workspace-entry="b-current"]').waitFor();
  const shortThreadLayout = await shortCase.page.evaluate(() => {
    const workspace = [...document.querySelectorAll<HTMLElement>(".session-workspace")]
      .find(element => element.getClientRects().length > 0)!;
    const timeline = workspace.querySelector<HTMLElement>(".workspace-timeline-scroll")!;
    const entries = [...timeline.querySelectorAll<HTMLElement>("[data-workspace-entry]")];
    const latestReply = entries.at(-1)!;
    const composer = workspace.querySelector<HTMLElement>(".session-composer-host")!;
    return { workspaceWidth: workspace.getBoundingClientRect().width, entryCount: entries.length,
      replyBottom: latestReply.getBoundingClientRect().bottom, composerTop: composer.getBoundingClientRect().top,
      viewportBottom: innerHeight, composerBottom: composer.getBoundingClientRect().bottom };
  });
  assert.equal(shortThreadLayout.entryCount, 1, "the wide-layout case begins with a short loaded conversation");
  assert.ok(shortThreadLayout.workspaceWidth <= 1480,
    `wide displays keep the Session reading column bounded (${shortThreadLayout.workspaceWidth}px)`);
  assert.ok(shortThreadLayout.replyBottom <= shortThreadLayout.composerTop &&
    shortThreadLayout.composerTop - shortThreadLayout.replyBottom <= 80,
    `the latest reply stays close above the composer when the short thread fits the tall viewport: ${JSON.stringify(shortThreadLayout)}`);
  assert.ok(shortThreadLayout.composerBottom <= shortThreadLayout.viewportBottom + 1,
    `the composer stays within the tall viewport: ${JSON.stringify(shortThreadLayout)}`);

  await shortCase.page.close();
  await switchPage.setViewportSize({ width: 2880, height: 2400 });
  const capCase = await openSessionB("auto-cap", { width: 2880, height: 2400 });
  await capCase.timeline.getByText("乙的更早原生内容 3-0", { exact: true }).waitFor();
  await capCase.timeline.getByText("乙的更早保存消息 3-0", { exact: true }).waitFor();
  await capCase.page.waitForTimeout(350);
  const autoCapCounts = await (await fetch(`${base}/__fixture/session-b-auto-counts`)).json() as { native: number; messages: number };
  assert.deepEqual(autoCapCounts, { native: 3, messages: 3 },
    "wide underfilled history automatically reads up to three native and three saved-message pages per mounted Session");
  assert.equal(await capCase.timeline.getByRole("button", { name: "加载更早的消息与活动" }).count(), 1,
    "the three-page autofill budget leaves further history available for deliberate reading");
  await capCase.page.close();

  const fillCase = await openSessionB("auto-fill", { width: 2880, height: 1772 });
  await fillCase.timeline.getByText("乙的更早原生内容 1-17", { exact: false }).waitFor();
  await fillCase.timeline.getByText("乙的更早保存消息 1-17", { exact: false }).waitFor();
  const filledWideTimeline = await fillCase.page.evaluate(() => {
    const workspace = [...document.querySelectorAll<HTMLElement>(".session-workspace")]
      .find(element => element.getClientRects().length > 0)!;
    const timeline = workspace.querySelector<HTMLElement>(".workspace-timeline-scroll")!;
    return { clientHeight: timeline.clientHeight, scrollHeight: timeline.scrollHeight,
      entries: timeline.querySelectorAll("[data-workspace-entry]").length };
  });
  assert.ok(filledWideTimeline.entries > 1 && filledWideTimeline.scrollHeight > filledWideTimeline.clientHeight + 2,
    `available older pages fill the wide reading pane instead of leaving it blank: ${JSON.stringify(filledWideTimeline)}`);
  const fillCountsBeforeReading = await (await fetch(`${base}/__fixture/session-b-auto-counts`)).json() as { native: number; messages: number };
  assert.ok(fillCountsBeforeReading.native > 0 && fillCountsBeforeReading.native < 3 &&
    fillCountsBeforeReading.messages > 0 && fillCountsBeforeReading.messages < 3,
    `autofill stops once the pane is filled, before its three-page budget: ${JSON.stringify(fillCountsBeforeReading)}`);
  for (const viewport of [{ width: 390, height: 844 }, { width: 871, height: 871 }, { width: 2880, height: 1772 }]) {
    await fillCase.page.setViewportSize(viewport);
    await fillCase.page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    const followLayout = await fillCase.page.evaluate(() => {
      const workspace = [...document.querySelectorAll<HTMLElement>(".session-workspace")]
        .find(element => element.getClientRects().length > 0)!;
      const timeline = workspace.querySelector<HTMLElement>(".workspace-timeline-scroll")!;
      const latest = [...timeline.querySelectorAll<HTMLElement>("[data-workspace-entry]")].at(-1)!;
      const composer = workspace.querySelector<HTMLElement>(".session-composer-host")!;
      return { latestId: latest.dataset.workspaceEntry, latestBottom: latest.getBoundingClientRect().bottom,
        composerTop: composer.getBoundingClientRect().top, scrollTop: timeline.scrollTop,
        scrollHeight: timeline.scrollHeight, clientHeight: timeline.clientHeight };
    });
    assert.ok(followLayout.latestBottom <= followLayout.composerTop + 1,
      `follow-latest keeps the newest reply above the composer after resizing to ${viewport.width}×${viewport.height}: ${JSON.stringify(followLayout)}`);
  }
  await fillCase.timeline.evaluate(node => { node.scrollTop = 0; });
  await fillCase.page.waitForTimeout(100);
  await fillCase.page.setViewportSize({ width: 2880, height: 2400 });
  await fillCase.page.waitForTimeout(450);
  assert.deepEqual(await (await fetch(`${base}/__fixture/session-b-auto-counts`)).json(), fillCountsBeforeReading,
    "resizing after the reader moves to older history does not trigger more automatic pages");
  assert.equal(await fillCase.timeline.evaluate(node => node.scrollTop), 0,
    "the viewport resize keeps the reader at the older-history position");
  await fillCase.page.close();

  const manualCase = await openSessionB("manual", { width: 1171, height: 871 });
  const manualTimeline = manualCase.timeline;
  await manualTimeline.getByRole("button", { name: "加载更早的消息与活动" }).waitFor();
  await fetch(`${base}/__fixture/deny-native-history-b`);
  await manualTimeline.getByRole("button", { name: "加载更早的消息与活动" }).click();
  await manualTimeline.getByText("乙的更早保存消息", { exact: true }).waitFor();
  await manualCase.page.getByText(/历史尚未读完：原生来源暂不可读取/).waitFor();
  assert.equal(await manualTimeline.getByRole("button", { name: "加载更早的消息与活动" }).count(), 1,
    "an unreadable native continuation keeps its cursor and remains retryable");
  await fetch(`${base}/__fixture/allow-native-history-b`);
  await manualTimeline.getByRole("button", { name: "加载更早的消息与活动" }).click();
  await manualTimeline.getByText("乙的更早原生内容", { exact: true }).waitFor();
  assert.equal(await manualTimeline.getByRole("button", { name: "加载更早的消息与活动" }).count(), 0,
    "the native cursor exhausts only after the history capability succeeds");
  await fetch(`${base}/__fixture/release-message-page`);
  await new Promise(resolve => setTimeout(resolve, 120));
  assert.equal(await switchPage.getByText("STALE A PAGE", { exact: true }).count(), 0,
    "a response from the prior Session scope cannot enter the new timeline");
  await fetch(`${base}/__fixture/direct-enable`);
  const directPage = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await directPage.goto(`${base}/p/${projectId}/sessions?session=${encodeURIComponent(sessionKey)}&tab=activity`);
  await directPage.getByLabel("访问令牌").fill("fixture-token");
  await directPage.getByRole("button", { name: "进入", exact: true }).click();
  await directPage.getByText("Enter 立即开始一轮 · ⌘/Ctrl+Enter 保存为排队消息").waitFor();
  await directPage.getByRole("combobox", { name: "消息" }).fill("请核对这一条独立输入");
  await directPage.getByRole("combobox", { name: "消息" }).press("Enter");
  await directPage.getByText("发送结果未知，需核对原操作").waitFor();
  assert.equal(await (await fetch(`${base}/__fixture/direct-count`)).text(), "1");
  const originalInputId = String(directReceipt?.inputId);
  await directPage.reload();
  await directPage.getByLabel("访问令牌").fill("fixture-token");
  await directPage.getByRole("button", { name: "进入", exact: true }).click();
  await directPage.getByText("发送结果未知，需核对原操作").waitFor();
  await directPage.locator(".session-direct-receipt summary").click();
  assert.ok((await directPage.locator(".session-direct-receipt").innerText()).includes(originalInputId));
  await directPage.getByText("只按原输入核对，不会重发", { exact: false }).waitFor();
  await directPage.getByRole("button", { name: "核对结果（不会重发）" }).click();
  await directPage.getByText("已读到：运行时已记录这条输入的原生条目；不代表智能体已采用").waitFor();   // the checked receipt carries its Item
  assert.equal(await directPage.getByRole("combobox", { name: "消息" }).inputValue(), "", "a received input leaves nothing to send again");
  await directPage.getByRole("combobox", { name: "消息" }).fill("核对之后的新一条");
  await directPage.getByRole("button", { name: "发送", exact: true, disabled: false }).waitFor();
  assert.equal(await (await fetch(`${base}/__fixture/direct-count`)).text(), "1",
    "lost acknowledgement and reload never repost the original input");
  await directPage.close();
  await fetch(`${base}/__fixture/direct-server-error`);
  const uncertainPage = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await uncertainPage.goto(`${base}/p/${projectId}/sessions?session=${encodeURIComponent(sessionKey)}&tab=activity`);
  await uncertainPage.getByLabel("访问令牌").fill("fixture-token");
  await uncertainPage.getByRole("button", { name: "进入", exact: true }).click();
  await uncertainPage.getByText("Enter 立即开始一轮 · ⌘/Ctrl+Enter 保存为排队消息").waitFor();
  await uncertainPage.getByRole("combobox", { name: "消息" }).fill("保留未知的原输入");
  await uncertainPage.getByRole("combobox", { name: "消息" }).press("Enter");
  await uncertainPage.getByText("发送结果未知；保留原输入 ID，请核对后继续。").waitFor();
  await uncertainPage.locator(".session-direct-receipt summary").click();
  const uncertainId = /输入 ID\s*([0-9a-f-]{36})/.exec(await uncertainPage.locator(".session-direct-receipt").innerText())?.[1];
  assert.ok(uncertainId, "the 503 and missing readback retain the original input ID");
  const held = await uncertainPage.evaluate(([project, session]) => ({
    inputId: sessionStorage.getItem(`direct-input:${project}:${session}:reader`),
    operationId: sessionStorage.getItem(`direct-input:${project}:${session}:reader:operation`),
  }), [projectId, sessionId]);
  assert.equal(held.inputId, uncertainId);
  assert.match(held.operationId ?? "", /^[0-9a-f-]{36}$/, "the original operation ID survives the unknown response");
  await uncertainPage.reload();
  await uncertainPage.getByLabel("访问令牌").fill("fixture-token");
  await uncertainPage.getByRole("button", { name: "进入", exact: true }).click();
  await uncertainPage.locator(".session-direct-receipt summary").click();
  await uncertainPage.locator(".session-direct-receipt").getByText(uncertainId!, { exact: true }).waitFor();
  await uncertainPage.getByRole("combobox", { name: "消息" }).fill("保留未知的原输入");
  assert.equal(await uncertainPage.getByRole("button", { name: "发送", exact: true }).isDisabled(), true,
    "an unknown response cannot silently enable a second send");
  assert.equal(await (await fetch(`${base}/__fixture/direct-count`)).text(), "2", "reload does not repost a 503 intent");
  await uncertainPage.close();

  await fetch(`${base}/__fixture/direct-invalid-input`);
  const rejectedPage = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await rejectedPage.goto(`${base}/p/${projectId}/sessions?session=${encodeURIComponent(sessionKey)}&tab=activity`);
  await rejectedPage.getByLabel("访问令牌").fill("fixture-token");
  await rejectedPage.getByRole("button", { name: "进入", exact: true }).click();
  await rejectedPage.getByText("Enter 立即开始一轮 · ⌘/Ctrl+Enter 保存为排队消息").waitFor();
  await rejectedPage.getByRole("combobox", { name: "消息" }).fill("明确未接收的输入");
  await rejectedPage.getByRole("combobox", { name: "消息" }).press("Enter");
  await rejectedPage.getByText("明确未接收 · 查看审计回执", { exact: true }).click();
  const invalidAudit = await rejectedPage.locator(".session-direct-audit").innerText();
  assert.match(invalidAudit, /INVALID_INPUT/);
  assert.match(invalidAudit, /request rejected before reservation/);
  assert.match(invalidAudit, /输入 ID\s*[0-9a-f-]{36}/);
  assert.match(invalidAudit, /操作 ID\s*[0-9a-f-]{36}/);
  assert.equal(await rejectedPage.locator(".session-direct-receipt").count(), 0,
    "a server validation rejection before reservation frees the draft");
  const rejectedStorage = await rejectedPage.evaluate(([project, session]) => ({
    pending: sessionStorage.getItem(`direct-input:${project}:${session}:reader`),
    operation: sessionStorage.getItem(`direct-input:${project}:${session}:reader:operation`),
    audit: sessionStorage.getItem(`direct-input:${project}:${session}:reader:explicit-audit`),
  }), [projectId, sessionId]);
  assert.equal(rejectedStorage.pending, null);
  assert.equal(rejectedStorage.operation, null);
  assert.ok(rejectedStorage.audit);
  assert.equal(await rejectedPage.getByRole("button", { name: "发送", exact: true }).isEnabled(), true);
  assert.equal(await (await fetch(`${base}/__fixture/direct-count`)).text(), "3",
    "the explicit rejection is one POST and does not create a recovery send");
  await rejectedPage.close();
});

test("a reset survives a busy read, unavailable history and stale pagination responses", {
  skip: !modulePath && "Set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE after building the workbench",
}, async t => {
  const { chromium } = (await import(pathToFileURL(modulePath!).href)).default;
  const requests: string[] = [];
  const resetInitialEntries = Array.from({ length: 25 }, (_, index) => timelineAssistant(
    index === 0 ? "reset-anchor" : `reset-current-${index}`,
    index === 0 ? "当前原生内容" : `当前原生内容 ${index}`,
    { occurredAt: new Date(Date.parse(stamp) + index * 1000).toISOString() }));
  const updateAfter: string[] = [];
  let historyAvailable = true;
  let holdOldPages = false;
  let oldNativeHeld = false;
  let oldMessagesHeld = false;
  let oldPagesCompleted = 0;
  let releaseOldPages: (() => void) | undefined;
  const oldPagesGate = new Promise<void>(resolve => { releaseOldPages = resolve; });
  let holdNextSnapshot = false;
  let snapshotHeld = false;
  let snapshotReleased = false;
  let releaseSnapshot: (() => void) | undefined;
  const snapshotGate = new Promise<void>(resolve => { releaseSnapshot = resolve; });
  let resetQueued = false;
  let resetSent = false;
  let resetCommitted = false;
  let resetSnapshots = 0;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname.startsWith("/api/")) {
      const root = `/api/projects/${projectId}`;
      let value: unknown = { items: [], nextCursor: null, metadata }, status = 200;
      if (url.pathname === "/api/session") value = { principal: { actorId: "reader", projectIds: [projectId], permissions: ["read", "write"] }, capabilities: {} };
      else if (url.pathname === root) value = { id: projectId, title: "时间线重置竞态测试", createdAt: stamp };
      else if (url.pathname === `${root}/session-work`) value = { items: [snapshotFor(sessionKey).session], nextCursor: null,
        observationCursor: "0", metadata, totals: { current: 1, historical: 0, unclassified: 0 },
        attention: { unansweredQuestions: 0, pendingMessages: 0, pendingAcceptance: 0, unclassifiedSessions: 0 } };
      else if (url.pathname === `${root}/session-work/changes`) value = { items: [], nextCursor: "0", hasMore: false, resetRequired: false, metadata };
      else if (url.pathname === `${root}/session-work/${encodeURIComponent(sessionKey)}`) value = snapshotFor(sessionKey);
      else if (url.pathname === `${root}/work-management/index`) value = { items: [], nextCursor: null, total: 0, counts: {}, changeSequence: 1, observedAt: stamp, partial: false };
      else if (url.pathname === `${root}/impacts` || url.pathname === `${root}/runtime/runs` || url.pathname === `${root}/runtime/sessions` || url.pathname.startsWith(`${root}/references/`)) value = [];
      else if (url.pathname === `${root}/runtime`) value = { available: false, error: null, allowedCwds: [], grants: [] };
      else if (url.pathname === `${root}/orchestration/work-status`) value = { items: [] };
      else if (url.pathname.endsWith("/timeline/updates")) {
        const after = url.searchParams.get("after") ?? "";
        updateAfter.push(after);
        if (resetQueued) {
          resetQueued = false;
          resetSent = true;
          value = { cursor: "reset-live", resetRequired: true, entries: [], turns: [], freshness: "live", limitations: [] };
        } else value = { cursor: resetCommitted ? "fresh-live" : "reset-live", resetRequired: false,
          entries: [], turns: [], freshness: "live", limitations: [] };
      } else if (url.pathname.endsWith("/timeline")) {
        const source = url.searchParams.get("source");
        const cursor = url.searchParams.get("cursor");
        const messagesCursor = url.searchParams.get("messagesCursor");
        requests.push(`${source ?? "both"}:${cursor ?? ""}:${messagesCursor ?? ""}`);
        if (source === "native" && cursor === "old-native" && holdOldPages) {
          oldNativeHeld = true;
          await oldPagesGate;
          oldPagesCompleted++;
          value = timelinePage(sessionKey, { entries: [timelineAssistant("late-old-native", "迟到的旧原生页")], nextCursor: "old-native-after" });
        } else if (source === "messages" && messagesCursor === "old-messages" && holdOldPages) {
          oldMessagesHeld = true;
          await oldPagesGate;
          oldPagesCompleted++;
          value = timelinePage(sessionKey, { pending: [timelineMessage("late-old-message", "迟到的旧已保存页")], messagesCursor: "old-messages-after" });
        } else if (source === "native" && cursor === "new-native") {
          value = timelinePage(sessionKey, { entries: [timelineAssistant("new-native-gap", "重置后的新原生历史")], nextCursor: null });
        } else if (source === "messages" && messagesCursor === "new-messages") {
          value = timelinePage(sessionKey, { pending: [timelineMessage("new-message-gap", "重置后的新已保存消息")], messagesCursor: null });
        } else if (source === "native") value = timelinePage(sessionKey, { entries: [], nextCursor: null });
        else if (source === "messages") value = timelinePage(sessionKey, { pending: [], messagesCursor: null });
        else {
          if (holdNextSnapshot) {
            holdNextSnapshot = false;
            snapshotHeld = true;
            await snapshotGate;
            snapshotReleased = true;
          }
          if (resetSent && historyAvailable) {
            resetSnapshots++;
            resetCommitted = true;
            value = timelinePage(sessionKey, { title: "时间线分页会话", entries: [timelineAssistant("reset-anchor", "重置后的最新原生内容")],
              nextCursor: "new-native", messagesCursor: "new-messages", cursor: "fresh-live" });
          } else value = timelinePage(sessionKey, { title: "时间线分页会话", entries: resetInitialEntries,
            nextCursor: "old-native", messagesCursor: "old-messages", cursor: "initial-live", history: historyAvailable });
        }
      } else if (url.pathname.endsWith("/timeline/items/live-tool")) { status = 403; value = { message: "无工具详情权限" }; }
      if (!res.destroyed) { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); }
      return;
    }
    if (url.pathname === "/__fixture/hold-old-pages") { holdOldPages = true; res.end("ok"); return; }
    if (url.pathname === "/__fixture/old-pages-held") { res.end(String(oldNativeHeld && oldMessagesHeld)); return; }
    if (url.pathname === "/__fixture/release-old-pages") { releaseOldPages?.(); res.end("ok"); return; }
    if (url.pathname === "/__fixture/hold-next-snapshot") { holdNextSnapshot = true; res.end("ok"); return; }
    if (url.pathname === "/__fixture/snapshot-held") { res.end(String(snapshotHeld)); return; }
    if (url.pathname === "/__fixture/snapshot-released") { res.end(String(snapshotReleased)); return; }
    if (url.pathname === "/__fixture/old-pages-completed") { res.end(String(oldPagesCompleted)); return; }
    if (url.pathname === "/__fixture/release-snapshot") { historyAvailable = false; releaseSnapshot?.(); res.end("ok"); return; }
    if (url.pathname === "/__fixture/queue-reset") { resetQueued = true; res.end("ok"); return; }
    if (url.pathname === "/__fixture/reset-sent") { res.end(String(resetSent)); return; }
    if (url.pathname === "/__fixture/update-state") { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ updateAfter, resetSnapshots })); return; }
    if (url.pathname === "/__fixture/enable-history") { historyAvailable = true; res.end("ok"); return; }
    try {
      const file = /^\/(?:$|p\/|ui$)/.test(url.pathname) ? "index.html" : url.pathname;
      const body = await readFile(join(dist, file));
      res.writeHead(200, { "content-type": ({ ".html": "text/html", ".js": "text/javascript", ".css": "text/css" } as Record<string, string>)[extname(file)] ?? "application/octet-stream" }); res.end(body);
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const browser = await chromium.launch({ headless: true, ...(process.env.EVOLOOP_BROWSER_TEST_EXECUTABLE_PATH
    ? { executablePath: process.env.EVOLOOP_BROWSER_TEST_EXECUTABLE_PATH } : {}) });
  t.after(async () => {
    releaseOldPages?.();
    releaseSnapshot?.();
    await browser.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 850 } });
  await page.goto(`${base}/p/${projectId}/sessions?session=${encodeURIComponent(sessionKey)}&tab=activity`);
  await page.getByLabel("访问令牌").fill("fixture-token");
  await page.getByRole("button", { name: "进入", exact: true }).click();
  await page.getByRole("heading", { name: "时间线分页会话" }).waitFor();
  const timeline = page.getByRole("log", { name: "消息与工具时间线" });
  await timeline.getByText("当前原生内容", { exact: true }).waitFor();

  await fetch(`${base}/__fixture/hold-old-pages`);
  await timeline.getByRole("button", { name: "加载更早的消息与活动" }).click();
  for (let attempt = 0; attempt < 100 && await (await fetch(`${base}/__fixture/old-pages-held`)).text() !== "true"; attempt++)
    await page.waitForTimeout(20);
  assert.equal(await (await fetch(`${base}/__fixture/old-pages-held`)).text(), "true", "both source pages are held before the reset");

  await fetch(`${base}/__fixture/hold-next-snapshot`);
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  for (let attempt = 0; attempt < 100 && await (await fetch(`${base}/__fixture/snapshot-held`)).text() !== "true"; attempt++)
    await page.waitForTimeout(20);
  assert.equal(await (await fetch(`${base}/__fixture/snapshot-held`)).text(), "true", "a latest snapshot read is held in flight");
  const beforeReset = await (await fetch(`${base}/__fixture/update-state`)).json() as { updateAfter: string[] };
  await fetch(`${base}/__fixture/queue-reset`);
  for (let attempt = 0; attempt < 100 && await (await fetch(`${base}/__fixture/reset-sent`)).text() !== "true"; attempt++)
    await page.waitForTimeout(20);
  assert.equal(await (await fetch(`${base}/__fixture/reset-sent`)).text(), "true", "the reset delta arrives while the snapshot read is busy");
  await fetch(`${base}/__fixture/release-snapshot`);
  for (let attempt = 0; attempt < 100 && await (await fetch(`${base}/__fixture/snapshot-released`)).text() !== "true"; attempt++)
    await page.waitForTimeout(20);
  assert.equal(await (await fetch(`${base}/__fixture/snapshot-released`)).text(), "true", "the busy snapshot settles with history temporarily unavailable");

  let state = await (await fetch(`${base}/__fixture/update-state`)).json() as { updateAfter: string[]; resetSnapshots: number };
  const duringReset = state.updateAfter.slice(beforeReset.updateAfter.length);
  assert.equal(duringReset[0], "initial-live", "the reset delta is read from the last acknowledged transport cursor");
  await page.getByText(/历史尚未完成校准/).waitFor();
  const reconcilingButton = timeline.getByRole("button", { name: "正在校准历史…" });
  await reconcilingButton.waitFor();
  assert.equal(await reconcilingButton.isDisabled(), true, "older pages cannot load while the reset snapshot lacks native history");
  assert.equal(state.resetSnapshots, 0, "a snapshot with temporarily unavailable history cannot commit the reset");

  await fetch(`${base}/__fixture/enable-history`);
  for (let attempt = 0; attempt < 80; attempt++) {
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    const current = await (await fetch(`${base}/__fixture/update-state`)).json() as { resetSnapshots: number };
    if (current.resetSnapshots > 0) break;
    await page.waitForTimeout(50);
  }
  await timeline.getByText("重置后的最新原生内容", { exact: true }).waitFor();
  state = await (await fetch(`${base}/__fixture/update-state`)).json() as { updateAfter: string[]; resetSnapshots: number };
  assert.ok(state.resetSnapshots >= 1, "the pending reset commits only after a fresh capable history snapshot");
  await fetch(`${base}/__fixture/release-old-pages`);
  for (let attempt = 0; attempt < 100 && Number(await (await fetch(`${base}/__fixture/old-pages-completed`)).text()) < 2; attempt++)
    await page.waitForTimeout(20);
  assert.equal(Number(await (await fetch(`${base}/__fixture/old-pages-completed`)).text()), 2,
    "the pre-reset native and saved-message page responses finish after the new cursors are committed");
  assert.equal(await timeline.getByText("迟到的旧原生页", { exact: true }).count(), 0,
    "a pre-reset native response cannot repopulate stale history after reset commit");
  assert.equal(await timeline.getByText("迟到的旧已保存页", { exact: true }).count(), 0,
    "a pre-reset saved-message response cannot repopulate stale history after reset commit");
  await timeline.getByRole("button", { name: "加载更早的消息与活动" }).click();
  await timeline.getByText("重置后的新原生历史", { exact: true }).waitFor();
  await timeline.getByText("重置后的新已保存消息", { exact: true }).waitFor();
  const finalRequests = requests.join("\n");
  assert.match(finalRequests, /native:new-native:/, "native pagination uses the reset snapshot's new cursor");
  assert.match(finalRequests, /messages::new-messages/, "saved-message pagination uses the reset snapshot's new cursor");
  assert.doesNotMatch(finalRequests, /native:old-native-after:|messages::old-messages-after/,
    "a delayed pre-reset page cannot overwrite the reset cursors");
});

test("revocation invalidates a held homepage, inspector and cache until an explicit reread", {
  skip: !modulePath && "Set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE after building the workbench",
}, async t => {
  const { chromium } = (await import(pathToFileURL(modulePath!).href)).default;
  let holdHomepage = false, homepageHeld = false, denied = false, latestReads = 0;
  let releaseHomepage: (() => void) | undefined;
  const homepageGate = new Promise<void>(resolve => { releaseHomepage = resolve; });
  const protectedTool = timelineTool("revocation-tool", "Command", "公开工具摘要");
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1"), root = `/api/projects/${projectId}`;
    if (url.pathname.startsWith("/api/")) {
      let value: unknown = { items: [], nextCursor: null, metadata }, status = 200;
      if (url.pathname === "/api/session") value = { principal: { actorId: "reader", projectIds: [projectId], permissions: ["read", "write", "review"] }, capabilities: {} };
      else if (url.pathname === root) value = { id: projectId, title: "撤权竞态测试", createdAt: stamp };
      else if (url.pathname === `${root}/session-work`) value = { items: [snapshotFor(sessionKey).session], nextCursor: null,
        observationCursor: "0", metadata, totals: { current: 1, historical: 0, unclassified: 0 },
        attention: { unansweredQuestions: 0, pendingMessages: 0, pendingAcceptance: 0, unclassifiedSessions: 0 } };
      else if (url.pathname === `${root}/session-work/changes`) value = { items: [], nextCursor: "0", hasMore: false, resetRequired: false, metadata };
      else if (url.pathname === `${root}/session-work/${encodeURIComponent(sessionKey)}`) value = snapshotFor(sessionKey);
      else if (url.pathname === `${root}/runtime`) value = { available: false, error: null, allowedCwds: [], grants: [] };
      else if (url.pathname === `${root}/impacts` || url.pathname === `${root}/runtime/runs` || url.pathname === `${root}/runtime/sessions`) value = [];
      else if (url.pathname.endsWith("/timeline/updates")) {
        if (denied) { status = 403; value = { message: "时间线读取权限已撤销" }; }
        else value = { cursor: "live", resetRequired: false, entries: [], turns: [], freshness: "live", limitations: [], activeTurnId: null };
      } else if (url.pathname.endsWith("/timeline/items/revocation-tool")) value = { ...protectedTool,
        detail: { input: "PRIVATE_DETAIL_INPUT", output: "PRIVATE_DETAIL_OUTPUT", error: null, resources: [] } };
      else if (url.pathname.endsWith("/timeline")) {
        latestReads++;
        const held = holdHomepage;
        value = timelinePage(sessionKey, { entries: [timelineAssistant(held ? "stale-a" : "authorized", held ? "STALE_AUTHORIZED_A" : "CURRENT_AUTHORIZED_BODY"), timelineMessage("ordinary-own", "真正的本人普通消息"), timelineMessage("project-dispatch", "项目派发任务：保留固定来源", { turnId: "dispatch-turn", nativeItemId: "dispatch-item", nativeKind: "userMessage", origin: { kind: "run", id: "97000005-0000-4000-8000-000000000005", taskId, taskRevisionId: taskId, initiatingActorId: "reader" } }), protectedTool] });
        if (held) { homepageHeld = true; await homepageGate; }
      } else if (url.pathname.endsWith("/recovery")) { status = 404; value = { message: "无恢复记录" }; }
      res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); return;
    }
    try {
      const file = /^\/(?:$|p\/|ui$)/.test(url.pathname) ? "index.html" : url.pathname;
      const body = await readFile(join(dist, file));
      res.writeHead(200, { "content-type": ({ ".html": "text/html", ".js": "text/javascript", ".css": "text/css" } as Record<string, string>)[extname(file)] ?? "application/octet-stream" }); res.end(body);
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const browser = await chromium.launch({ headless: true, ...(process.env.EVOLOOP_BROWSER_TEST_EXECUTABLE_PATH ? { executablePath: process.env.EVOLOOP_BROWSER_TEST_EXECUTABLE_PATH } : {}) });
  t.after(() => browser.close()); t.after(() => releaseHomepage?.());
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(`${base}/p/${projectId}/sessions?session=${encodeURIComponent(sessionKey)}`);
  await page.getByLabel("访问令牌").fill("fixture-token"); await page.getByRole("button", { name: "进入", exact: true }).click();
  await page.getByText("CURRENT_AUTHORIZED_BODY", { exact: true }).waitFor();
  const dispatch = page.locator(".workspace-system-strip");
  assert.equal(await dispatch.count(), 1, "a Run input remains project dispatch even when the initiating actor is the current reader");
  assert.equal(await dispatch.getAttribute("data-turn-id"), "dispatch-turn");
  assert.equal(await dispatch.locator(".lucide-user-round").count(), 0, "project dispatch does not use the personal chat avatar");
  assert.match(await dispatch.innerText(), /系统派发 · 本轮任务/);
  assert.ok((await dispatch.getByRole("link", { name: "查看任务与指令" }).getAttribute("href"))?.includes(taskId));
  assert.equal(await page.getByRole("article", { name: "我发出的消息", exact: true }).count(), 1, "only the ordinary saved message is mine");
  await page.locator(".workspace-tools-toggle").click();
  await page.getByRole("button", { name: "查看工具详情：执行命令", exact: true }).click();
  await page.getByRole("button", { name: "读取原始输入与输出", exact: true }).click();
  await page.getByText("PRIVATE_DETAIL_OUTPUT", { exact: true }).waitFor();
  holdHomepage = true;
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await assertEventually(() => homepageHeld, "homepage A is in flight before the denial");
  denied = true;
  await page.getByText("活动暂不可读取：时间线读取权限已撤销", { exact: false }).waitFor();
  assert.equal(await page.locator("[data-workspace-entry]").count(), 0);
  assert.equal(await page.getByRole("dialog").count(), 0);
  const response = page.waitForResponse(r => new URL(r.url()).pathname.endsWith("/timeline") && r.status() === 200);
  releaseHomepage?.(); await (await response).finished();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await page.getByText("STALE_AUTHORIZED_A", { exact: true }).count(), 0, "held authorized response must not revive revoked content");
  assert.equal(await page.locator("[data-workspace-entry]").count(), 0, "entries stay empty after stale success");
  assert.equal(await page.getByRole("dialog").count(), 0, "the old inspector stays closed");
  const revokedReads = latestReads;
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await page.evaluate(id => { location.hash = `/p/${id}/sessions`; }, projectId);
  await page.locator(".unified-session-timeline").waitFor({ state: "detached" });
  await page.evaluate(({ id, key }) => { location.hash = `/p/${id}/sessions?session=${encodeURIComponent(key)}`; }, { id: projectId, key: sessionKey });
  await page.getByText("活动暂不可读取：时间线读取权限已撤销", { exact: false }).waitFor();
  assert.equal(latestReads, revokedReads, "remount and visibility cannot refill a revoked cache");
  assert.equal(await page.locator("[data-workspace-entry]").count(), 0);
  denied = false; holdHomepage = false;
  await page.getByRole("button", { name: "重新读取", exact: true }).click();
  await page.getByText("CURRENT_AUTHORIZED_BODY", { exact: true }).waitFor();
  assert.equal(await page.getByText("STALE_AUTHORIZED_A", { exact: true }).count(), 0);
  assert.ok(latestReads > revokedReads, "explicit top-level reread reauthorizes a new request");
});

async function assertEventually(predicate: () => boolean, message: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.ok(predicate(), message);
}
