// Opt-in built-app regression: build workbench, then set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE.
// A schedule's produced task opens with “返回日程：<名称>” back to that schedule (N2), and its run reaches the exact
// closed agent that ran it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const modulePath = process.env.EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE;
const dist = resolve(import.meta.dirname, "../dist");
const projectId = "77500001-0000-4000-8000-000000000001";
const scheduleId = "77500002-0000-4000-8000-000000000002";
const revisionId = "77500003-0000-4000-8000-000000000003";
const taskId = "77500004-0000-4000-8000-000000000004";
const runId = "77500005-0000-4000-8000-000000000005";
const sessionId = "77500006-0000-4000-8000-000000000006";
const otherSessionId = "77500007-0000-4000-8000-000000000007";
const roleId = "77500008-0000-4000-8000-000000000008";
const stamp = "2026-10-26T00:00:00.000Z";
const sessionKey = `owned:${sessionId}`;
const metadata = { generatedAt: stamp, sourceObservedAt: stamp, partial: false, limitations: [] };
const unavailable = { available: false, reason: "测试中不可用" };
const resources = Object.fromEntries(["configuredModel", "actualModel", "inputTokens", "outputTokens", "cost", "processMemory"]
  .map(key => [key, { value: null, unit: "", source: null, scope: "session", observedAt: null, interval: null, unavailableReason: "未记录" }]));
const revision = { projectId, scheduleId, id: revisionId, version: 5, timezone: "Asia/Taipei",
  rule: { kind: "once", atUtc: stamp }, misfire: { kind: "latest" }, overlap: "skip",
  template: { title: "旧日程创建的任务", content: "固定任务正文", acceptance: "由消费者验收", owner: roleId },
  authorization: { scopeId: "开发", roleId, authorizedBy: "reader", expiresAtUtc: null },
  reason: "历史修订", actorId: "reader", createdAtUtc: stamp };
const task = { projectId, id: taskId, version: 2, currentRevisionId: taskId, title: "旧日程创建的任务",
  content: "固定任务正文", contentDocumentId: taskId, contentRevisionId: taskId, kind: "implementation",
  acceptance: "由消费者验收", owner: roleId, state: "in_progress", createdAt: stamp };
const run = { projectId, id: runId, taskId, taskRevisionId: taskId, basisSetId: revisionId, sessionId,
  operationId: runId, input: "固定输入", inputHash: "fixture", state: "completed", version: 3,
  nativeTurnId: null, interruptRequested: false, resultSummary: "已产出技术结果", actorId: "reader", createdAt: stamp, updatedAt: stamp };
const session = { projectId, id: sessionId, roleId, cwd: "/tmp/old-session", authorizationScope: "历史任务",
  model: null, sandbox: "read-only", approvalPolicy: "on-request", state: "closed", version: 2,
  nativeThreadId: "native-old", nativeSessionId: null, operationId: sessionId, actorId: "reader", createdAt: stamp, updatedAt: stamp };

test("old Schedule occurrence reaches its exact closed Run Session workspace", {
  skip: !modulePath && "Set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE after building the workbench",
}, async t => {
  const { chromium } = (await import(pathToFileURL(modulePath!).href)).default;
  const requests: string[] = [];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname.startsWith("/api/")) {
      requests.push(url.pathname);
      const root = `/api/projects/${projectId}`;
      let value: unknown = { items: [], nextCursor: null };
      if (url.pathname === "/api/session") value = { principal: { actorId: "reader", projectIds: [projectId], permissions: ["read"] }, capabilities: {} };
      else if (url.pathname === root) value = { id: projectId, title: "旧日程项目", createdAt: stamp };
      else if (url.pathname === `${root}/schedules`) value = [{ projectId, id: scheduleId, version: 5, currentRevisionId: revisionId, state: "stopped", watermarkUtc: stamp, revision }];
      else if (url.pathname === `${root}/scheduling/status`) value = { state: "stopped", lastTickAt: stamp, lastError: null, lastCreated: 1, grants: [] };
      else if (url.pathname === `${root}/schedules/${scheduleId}/revisions`) value = [revision];
      else if (url.pathname === `${root}/schedules/${scheduleId}/occurrences`) value = [{ projectId, scheduleId, revisionId, plannedAtUtc: stamp,
        observedAtUtc: stamp, state: "created", taskId, operationId: scheduleId, reason: "旧修订创建" }];
      else if (url.pathname === `${root}/tasks/${taskId}`) value = { task,
        revision: { ...task, taskId, actorId: "reader", reason: "日程创建", createdAt: stamp },
        basis: null, links: [], impacts: [], decisions: [], deliveries: [], observations: [], closures: [] };
      else if (url.pathname === `${root}/runtime`) value = { available: false, error: "已停止", allowedCwds: [], grants: [] };
      else if (url.pathname === `${root}/runtime/sessions`) value = [session, { ...session, id: otherSessionId, state: "ready" }];
      else if (url.pathname === `${root}/runtime/runs`) value = [run];
      else if (url.pathname === `${root}/runtime/runs/${runId}`) value = run;
      else if (url.pathname === `${root}/references/tasks/${taskId}`) value = [];
      else if (url.pathname === `${root}/session-work/${encodeURIComponent(sessionKey)}`) value = {
        session: { key: sessionKey, target: { kind: "owned", sessionId }, aliases: [], title: "历史 Session 77500006",
          profile: null, kind: "owned", roles: [], membership: "historical", membershipReason: "已关闭", runtimeState: "closed", busy: false,
          currentTask: null, latestBusinessRun: null, lastProgressAt: null,
          capabilities: { observe: unavailable, send: { ...unavailable, mode: "unavailable" }, open: { ...unavailable, ref: null }, interrupt: unavailable, close: unavailable },
          source: { kind: "session", id: sessionId, revision: null, evidence: "project-record", href: "" }, metadata },
        observationCursor: "0", currentWork: null, assignments: [], roleTasks: [], queue: [], results: [], questions: [], activity: [], resources, metadata };
      res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(value)); return;
    }
    const file = /^\/(?:$|p\/|ui$)/.test(url.pathname) ? "index.html" : url.pathname;
    try { const body = await readFile(join(dist, file)); res.writeHead(200, { "content-type": ({ ".html": "text/html", ".js": "text/javascript", ".css": "text/css" } as Record<string, string>)[extname(file)] ?? "application/octet-stream" }); res.end(body); }
    catch { res.writeHead(404); res.end(); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const browser = await chromium.launch({ headless: true, ...(process.env.EVOLOOP_BROWSER_TEST_EXECUTABLE_PATH
    ? { executablePath: process.env.EVOLOOP_BROWSER_TEST_EXECUTABLE_PATH } : {}) }); t.after(() => browser.close());
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.stack ?? error.message));
  await page.goto(`${base}/p/${projectId}/schedules`);
  await page.getByLabel("访问令牌").fill("fixture-token");
  await page.getByRole("button", { name: "进入", exact: true }).click();
  // The schedule list sits in the inner rail; the selected schedule fills the center.
  const scheduleItem = page.getByRole("navigation", { name: "日程" }).getByRole("button", { name: /旧日程创建的任务/ });
  await scheduleItem.click();
  assert.equal(await scheduleItem.getAttribute("aria-current"), "true");
  await page.locator(".schedule-definition").waitFor();
  if (process.env.EVOLOOP_SCHEDULE_SCREENSHOT_DIR) {
    await page.getByRole("link", { name: "阅读此任务" }).waitFor();
    const dir = process.env.EVOLOOP_SCHEDULE_SCREENSHOT_DIR;
    await page.setViewportSize({ width: 1440, height: 900 });
    if (await page.getByRole("button", { name: "展开右栏" }).count()) await page.getByRole("button", { name: "展开右栏" }).click();
    await page.getByRole("region", { name: "触发条件" }).waitFor();
    await page.screenshot({ path: `${dir}/schedule-1440.png` });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: `${dir}/schedule-390.png`, fullPage: true });
    assert.equal(await page.evaluate("document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1"), true);
    await page.setViewportSize({ width: 1280, height: 720 });
  }
  // 阅读此任务 carries the way back to this schedule, for this reader (N2).
  const read = page.getByRole("link", { name: "阅读此任务" });
  const readHref = new URL(await read.getAttribute("href") ?? "", base);
  const scheduleHref = `/p/${projectId}/schedules?schedule=${scheduleId}`;
  assert.deepEqual([readHref.pathname, readHref.searchParams.get("return"), readHref.searchParams.get("actor"), readHref.searchParams.get("returnTitle")],
    [`/p/${projectId}/tasks/${taskId}`, scheduleHref, "reader", "旧日程创建的任务"]);
  await read.click();
  assert.equal(new URL(page.url()).pathname, `/p/${projectId}/tasks/${taskId}`);
  await page.getByRole("heading", { name: "旧日程创建的任务" }).waitFor({ timeout: 5000 }).catch(async () => {
    assert.fail(`Task did not open: ${page.url()} body=${await page.locator("body").innerHTML()} errors=${errors.join(" | ")} requests=${requests.slice(-15).join(",")}`);
  });
  const taskPage = page.locator(`[data-task-page="${taskId}"]`);
  const backToSchedule = taskPage.locator("[data-return-link]").filter({ hasText: "返回日程：旧日程创建的任务" });
  await backToSchedule.waitFor();
  // The way back opens 日程 on this schedule; a link opened from there comes back here again.
  await backToSchedule.click();
  assert.equal((url => url.pathname + url.search)(new URL(page.url())), scheduleHref);
  await page.locator(".schedule-definition").getByRole("heading", { name: "旧日程创建的任务" }).waitFor();
  assert.equal(await scheduleItem.getAttribute("aria-current"), "true");
  await page.getByRole("link", { name: "阅读此任务" }).click();
  await backToSchedule.waitFor();
  await page.getByRole("tab", { name: "运行与关联" }).waitFor({ timeout: 5000 }).catch(async () => {
    assert.fail(`Task tabs missing: ${page.url()} body=${await page.locator("body").innerHTML()} errors=${errors.join(" | ")} requests=${requests.slice(-15).join(",")}`);
  });
  await page.getByRole("tab", { name: "运行与关联" }).click();
  const card = page.locator(`#runtime-run-${taskId}-${runId}`);
  await card.locator(":scope > summary").waitFor();
  await card.locator(":scope > summary").click();
  // The run names the agent it ran on; the agents' own cards are on the agent's page, not the task's.
  const exact = card.getByRole("link", { name: "查看这次运行的智能体" });
  assert.equal((await exact.getAttribute("href"))?.split("&return=")[0], `/p/${projectId}/sessions?session=${encodeURIComponent(sessionKey)}`);
  const runAgentBack = new URLSearchParams((await exact.getAttribute("href"))!.split("?")[1]);
  assert.equal(runAgentBack.get("return"), `/p/${projectId}/tasks/${taskId}?tab=runtime`, "the agent page comes back to this task's 运行与关联");
  assert.equal(runAgentBack.get("returnTitle"), "旧日程创建的任务");
  assert.equal(runAgentBack.get("actor"), "reader");
  assert.match(await card.innerText(), /运行的状态不代表任务已验收/);
  await exact.click();
  await page.getByRole("heading", { name: "历史 Session 77500006" }).waitFor();
  assert.match(await page.locator(".session-detail-header").innerText(), /历史/);
  await page.locator("[data-return-link]").filter({ hasText: "返回任务：旧日程创建的任务" }).waitFor();
  assert.equal((url => url.pathname + url.search)(new URL(page.url())).split("&return=")[0], `/p/${projectId}/sessions?session=${encodeURIComponent(sessionKey)}`);
  assert.ok(requests.includes(`${rootPath(projectId)}/session-work/${encodeURIComponent(sessionKey)}`));
  assert.equal(requests.includes(`${rootPath(projectId)}/session-work/${encodeURIComponent(`owned:${otherSessionId}`)}`), false);
  assert.equal(errors.length, 0, errors.join(" | "));
});

function rootPath(id: string) { return `/api/projects/${id}`; }
