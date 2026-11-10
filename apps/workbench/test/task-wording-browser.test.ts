// Opt-in built-app regression for #229 F4 on the task page: the right column's 版本 line says in Chinese who made the
// revision and why (a schedule's task: “由日程「名称」在 本地时间 生成”; the first revision: “新建任务”), with the
// service's wording and identifiers only in 完整标识; the history tab says the same; the body's Markdown headings sit
// below the page's single h1. Screenshots: EVOLOOP_TASK_WORDING_SCREENSHOT_DIR (1440, 1024, 390).
import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { plannedTime } from "../src/shared/revisionPresentation";

const modulePath = process.env.EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE;
const shots = process.env.EVOLOOP_TASK_WORDING_SCREENSHOT_DIR;
const dist = resolve(import.meta.dirname, "../dist");
const projectId = "98000001-0000-4000-8000-000000000001";
const roleId = "efd99e72-0000-4000-8000-000000000002";
const scheduleId = "9afc02f7-0000-4000-8000-000000000003";
const [scheduled, seeded] = ["98000010", "98000011"].map(prefix => `${prefix}-0000-4000-8000-000000000000`);
const [docA, docB] = ["98000020", "98000021"].map(prefix => `${prefix}-0000-4000-8000-000000000000`);
const plannedAt = "2026-11-10T02:28:00.000Z";
const stamp = "2026-11-10T02:28:01.000Z";
const scheduleReason = `schedule ${scheduleId} at ${plannedAt}`;
const body = "# 巡检要点\n\n## 第一步\n\n核对昨天的交付是否被使用。";
const task = (id: string, title: string, contentDocumentId: string) => ({ projectId, id, version: 1, currentRevisionId: `${id.slice(0, 8)}-0000-4000-8000-0000000000aa`,
  title, content: body, contentDocumentId, contentRevisionId: `${contentDocumentId.slice(0, 8)}-0000-4000-8000-0000000000bb`, kind: "implementation",
  acceptance: "1. 写明核对结果。", owner: roleId, state: "todo" });
const tasks = [task(scheduled, "每日巡检：交付使用核对", docA), task(seeded, "种子任务：初始版本", docB)];
const origin: Record<string, { actorId: string; reason: string }> = {
  [scheduled]: { actorId: `schedule:${roleId}`, reason: scheduleReason },
  [seeded]: { actorId: "test-owner", reason: "Initial task" },
};
const revisionOf = (item: typeof tasks[number]) => ({ ...item, taskId: item.id, id: item.currentRevisionId, basisSetId: null, createdAt: stamp, ...origin[item.id]! });
const projection = (item: typeof tasks[number]) => ({
  kind: "task", taskId: item.id, version: item.version, currentRevisionId: item.currentRevisionId, workChangeSequence: 1, title: item.title,
  taskKind: item.kind, taskState: item.state, phase: "unassigned", nextAction: "assign", responsible: { kind: "role", id: roleId, label: "负责职责" },
  assignment: null, latestRun: null, delivery: null, pendingImpactCount: 0, queueHold: null, goal: null, stage: null,
  plan: { plannedStartAt: null, dueAt: null, priority: null }, dependencies: [], dependencyVersion: 0, review: null,
  dates: { createdAt: stamp, businessChangedAt: stamp, startedAt: null, completedAt: null, observedAt: stamp }, timing: null, actionKey: `task:${item.id}` });
const schedule = { projectId, id: scheduleId, version: 1, currentRevisionId: "98000030-0000-4000-8000-000000000000", state: "active", watermarkUtc: plannedAt,
  revision: { projectId, scheduleId, id: "98000030-0000-4000-8000-000000000000", version: 1, timezone: "Asia/Shanghai", rule: { kind: "once", atUtc: plannedAt },
    misfire: { kind: "skip" }, overlap: "skip", template: { title: "每日巡检", content: body, acceptance: "写明核对结果", owner: roleId },
    authorization: { scopeId: "scope", roleId, authorizedBy: "lead", expiresAtUtc: null }, reason: "建立", actorId: "lead", createdAtUtc: stamp } };

test("a task's version line says in Chinese who made it and why; identifiers stay in 完整标识; the page keeps one h1", {
  skip: !modulePath && "Set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE after building the workbench",
}, async t => {
  const { chromium } = (await import(pathToFileURL(modulePath!).href)).default;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, "http://127.0.0.1");
    if (url.pathname.startsWith("/api/")) {
      const root = `/api/projects/${projectId}`;
      const path = decodeURIComponent(url.pathname);
      let value: unknown = { items: [], nextCursor: null }, status = 200;
      if (path === "/api/session") value = { principal: { actorId: "reader", projectIds: [projectId], permissions: ["read", "write", "review"] }, capabilities: {} };
      else if (path === root) value = { id: projectId, title: "任务用语夹具", createdAt: stamp };
      else if (path === `${root}/tasks`) value = { items: tasks, nextCursor: null };
      else if (path === `${root}/schedules`) value = [schedule];
      else if (path === `${root}/orchestration/work-status`) value = { items: (url.searchParams.get("taskIds") ?? "").split(",").filter(Boolean).map(taskId => ({ taskId, cognition: false, hasClosure: false, readyForAcceptance: false })) };
      else if (path === `${root}/work-management/index`) value = { items: tasks.map(projection), nextCursor: null, total: 2, counts: { unassigned: 2 }, changeSequence: 1, observedAt: stamp, partial: false };
      else if (path.startsWith(`${root}/work-management/tasks/`)) {
        const found = tasks.find(item => item.id === path.slice(`${root}/work-management/tasks/`.length));
        if (found) value = projection(found); else { status = 404; value = { message: "未登记" }; }
      } else if (path.startsWith(`${root}/tasks/`)) {
        const [id, sub] = path.slice(`${root}/tasks/`.length).split("/");
        const found = tasks.find(item => item.id === id);
        if (!found) { status = 404; value = { message: "无此任务" }; }
        else if (sub === "assignment" || sub === "timing") value = null;
        else if (sub === "revisions") value = [{ revision: revisionOf(found), basis: null }];
        else if (sub) { status = 404; value = { message: "夹具未提供" }; }
        else value = { task: found, revision: revisionOf(found), basis: null, links: [], impacts: [], decisions: [], deliveries: [], observations: [], closures: [] };
      } else if (path.startsWith(`${root}/documents/${docA}`)) {
        // The schedule's task body document: written by the schedule, as the service writes it.
        const revision = { projectId, documentId: docA, id: tasks[0]!.contentRevisionId, body, format: "markdown", mediaType: "text/markdown", originalName: "task.md",
          payloadRef: null, entrypoint: null, assetsManifest: [], contentHash: "a".repeat(64), author: `schedule:${roleId}`, createdAt: stamp, previousRevisionId: null, reason: scheduleReason };
        value = path.includes("/revisions/") ? revision : { document: { projectId, id: docA, title: "每日巡检：交付使用核对", version: 1, currentRevisionId: revision.id,
          adoptedRevisionId: null, kind: "task", status: "draft" }, current: revision, adopted: null };
      } else if (path.startsWith(`${root}/documents/`)) { status = 404; value = { message: "夹具未提供" }; }
      else if (path === `${root}/roles/${roleId}`) value = { projectId, id: roleId, proposal: { title: "巡检" } };
      res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); return;
    }
    try {
      const file = /^\/(?:$|p\/|ui$)/.test(url.pathname) ? "index.html" : url.pathname;
      res.writeHead(200, { "content-type": ({ ".html": "text/html", ".js": "text/javascript", ".css": "text/css" } as Record<string, string>)[extname(file)] ?? "application/octet-stream" });
      res.end(await readFile(join(dist, file)));
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done)); t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const browser = await chromium.launch({ headless: true, ...(process.env.EVOLOOP_BROWSER_TEST_EXECUTABLE_PATH ? { executablePath: process.env.EVOLOOP_BROWSER_TEST_EXECUTABLE_PATH } : {}) });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  const login = async () => {
    await page.getByLabel("访问令牌").fill("fixture-token");
    await page.getByRole("button", { name: "进入", exact: true }).click();
  };
  await page.goto(`${base}/p/${projectId}/tasks/${scheduled}`);
  await login();
  await page.getByRole("heading", { level: 1, name: "每日巡检：交付使用核对" }).waitFor();
  // The planned time, in the schedule's own zone as the schedule page writes it (plus the reader's clock when it differs).
  const planned = plannedTime(plannedAt, "Asia/Shanghai", await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone));

  // 版本: the schedule is named once its name is read; the service's wording and identifiers are not in the text.
  if (await page.getByRole("button", { name: "展开右栏" }).count()) await page.getByRole("button", { name: "展开右栏" }).click();
  const facts = page.getByRole("complementary", { name: "右栏" }).locator(`[data-task-facts="${scheduled}"]`);
  const line = facts.locator("[data-revision-origin]");
  await line.getByText(`按日程「每日巡检」生成，计划时间 ${planned}`, { exact: true }).waitFor();
  const text = await facts.innerText();
  for (const raw of [scheduleId, roleId, "schedule ", "schedule:", plannedAt]) assert.ok(!text.includes(raw), `“${raw}” is not in the right column's text`);
  await facts.locator("summary", { hasText: "来源与完整标识" }).last().click();
  for (const raw of [scheduleId, plannedAt, roleId, scheduleReason]) await facts.getByText(raw, { exact: true }).first().waitFor();

  // The task body's document, opened beside the task, names the schedule that wrote it, not schedule:<id>.
  await facts.getByRole("button", { name: /每日巡检：交付使用核对/ }).first().click();
  const peek = page.getByRole("complementary", { name: "右栏" }).getByRole("article", { name: "每日巡检：交付使用核对" });
  await peek.getByText(/任务固定的修订 · .* · 日程「每日巡检」/).waitFor();
  assert.doesNotMatch(await peek.innerText(), /schedule:/);
  await page.getByRole("complementary", { name: "右栏" }).getByRole("tab", { name: "信息" }).click();

  // The body's headings sit below the page title: one h1 on the page.
  assert.equal(await page.locator("h1").count(), 1, "the page has a single h1");
  await page.getByRole("main").getByRole("heading", { level: 3, name: "巡检要点" }).waitFor();
  await page.getByRole("main").getByRole("heading", { level: 4, name: "第一步" }).waitFor();
  if (shots) await page.screenshot({ path: `${shots}/task-schedule-version-1440.png` });

  // History says the same, with the original under 原始记录.
  await page.goto(`${base}/p/${projectId}/tasks/${scheduled}?tab=history`);
  await login();
  const history = page.getByRole("list", { name: "任务修订" });
  await history.getByText(`理由：按日程「每日巡检」自动生成，计划时间 ${planned}`, { exact: true }).waitFor();
  assert.ok(!(await history.innerText()).includes(scheduleId));

  // The first revision of a seeded task: “新建任务”, not “Initial task”.
  await page.goto(`${base}/p/${projectId}/tasks/${seeded}`);
  await login();
  await page.getByRole("heading", { level: 1, name: "种子任务：初始版本" }).waitFor();
  const seededFacts = page.getByRole("complementary", { name: "右栏" }).locator(`[data-task-facts="${seeded}"]`);
  await seededFacts.locator("[data-revision-origin]").getByText("test-owner · 新建任务", { exact: true }).waitFor();
  assert.ok(!(await seededFacts.innerText()).includes("Initial task"));

  // 1024: the facts are a drawer the reader opens; 390: no sideways scroll.
  await page.goto(`${base}/p/${projectId}/tasks/${scheduled}`);
  await login();
  await page.setViewportSize({ width: 1024, height: 800 });
  await page.getByRole("heading", { level: 1, name: "每日巡检：交付使用核对" }).waitFor();
  const opener = page.getByRole("main").getByRole("button", { name: "任务信息" });
  if (await opener.count()) await opener.click(); else if (await page.getByRole("button", { name: "展开右栏" }).count()) await page.getByRole("button", { name: "展开右栏" }).click();
  await page.locator(`[data-task-facts="${scheduled}"] [data-revision-origin]`).getByText(`按日程「每日巡检」生成，计划时间 ${planned}`, { exact: true }).last().waitFor();
  await page.waitForTimeout(500); // the drawer has finished sliding in
  if (shots) await page.screenshot({ path: `${shots}/task-schedule-version-1024.png` });
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(200);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "no sideways scroll at 390");
  if (shots) await page.screenshot({ path: `${shots}/task-schedule-version-390.png` });
  assert.deepEqual(errors, []);
});
