// Opt-in built-app regression for 跨空间返回 (scenarios.md 跳转规则): a task's 进入对话 (right column and 运行与关联)
// and the task table's right column open the agent with “返回任务：<名称>”, which comes back to the same page and tab;
// 统筹安排 opens tasks with “返回统筹安排” and shows an assignment fixed to an older revision as a risk; a document
// opened from a task names the task; 自动循环 that is not configured says so. Screenshots: EVOLOOP_RETURNS_SCREENSHOT_DIR.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { timelinePage } from "./session-timeline-fixtures";

const modulePath = process.env.EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE;
const shots = process.env.EVOLOOP_RETURNS_SCREENSHOT_DIR;
const dist = resolve(import.meta.dirname, "../dist");
const id = (n: number) => `33000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const projectId = id(1);
const roleId = id(2);
const sessionId = id(3);
const sessionKey = `owned:${sessionId}`;
const [taskA, taskB, taskC, taskD] = [id(10), id(11), id(12), id(13)];
const [docA, revA] = [id(20), id(30)];
const oldRevision = id(40);
const stamp = "2026-11-10T00:00:00.000Z";
const metadata = { generatedAt: stamp, sourceObservedAt: stamp, partial: false, limitations: [] };
const titleA = "【合成示例】右栏信息核对";
const titleB = "【合成示例】旧修订上的分派";
const titleC = "【合成示例】没人承接的任务";
const titleD = "【合成示例】已交付待验收";
const agentTitle = "【合成示例】开发智能体";

const task = (taskId: string, title: string, state = "in_progress") => ({
  projectId, id: taskId, version: 2, currentRevisionId: `${taskId.slice(0, 30)}999999`, title, content: `# 目标\n${title}的正文。`,
  contentDocumentId: docA, contentRevisionId: revA, kind: "implementation", acceptance: "1. 返回链接带名称。", owner: roleId, state,
});
const tasks = [task(taskA, titleA), task(taskB, titleB), task(taskC, titleC, "todo"), task(taskD, titleD)];
const fixedTo = (item: ReturnType<typeof task>, state: string, revision: string) =>
  ({ state, targetKind: "owned", targetId: sessionId, recipientActorId: null, taskRevisionId: revision });
const projection = (item: ReturnType<typeof task>, phase: string, assignment: unknown) => ({
  kind: "task", taskId: item.id, version: item.version, currentRevisionId: item.currentRevisionId, workChangeSequence: 3, title: item.title,
  taskKind: item.kind, taskState: item.state, phase, nextAction: "", responsible: { kind: "role", id: roleId, label: "开发" }, assignment,
  latestRun: null, delivery: null, pendingImpactCount: 0, queueHold: null, goal: null, stage: null, plan: null, dependencies: [],
  dependencyVersion: 0, review: null, dates: { createdAt: stamp, businessChangedAt: stamp, startedAt: null, completedAt: null, observedAt: stamp },
  actionKey: `task:${item.id}`,
});
const indexed = [
  projection(tasks[0]!, "ready", fixedTo(tasks[0]!, "accepted", tasks[0]!.currentRevisionId)),
  // Assigned before the task was revised: the server still calls it 待接手; the board must not.
  projection(tasks[1]!, "awaiting_assignment", fixedTo(tasks[1]!, "assigned", oldRevision)),
  projection(tasks[2]!, "unassigned", null),
  // Delivered: delivery.record made a new revision and left the accepted assignment behind. That is the normal flow.
  projection(tasks[3]!, "awaiting_acceptance", fixedTo(tasks[3]!, "accepted", oldRevision)),
];
const assignmentOf = (taskId: string) => {
  const found = indexed.find(item => item.taskId === taskId)!;
  if (!found.assignment) return null;
  const fixed = found.assignment as ReturnType<typeof fixedTo>;
  return { projectId, taskId, version: 1, taskRevisionId: fixed.taskRevisionId, target: { kind: "owned", sessionId }, recipientActorId: null,
    state: fixed.state, ack: null, actorId: "lead", reason: "按职责安排", updatedAt: stamp };
};
const session = {
  key: sessionKey, target: { kind: "owned", sessionId }, aliases: [], title: agentTitle, profile: null, identity: null, kind: "owned",
  roles: [{ id: roleId, title: "开发", state: "active", roleClass: "business", templateKey: null, responsibility: "开发" }],
  membership: "current", membershipReason: "verified", runtimeState: "ready", busy: false, currentTask: null, latestBusinessRun: null,
  lastProgressAt: stamp,
  capabilities: { observe: { available: true, reason: null }, send: { available: false, reason: "fixture", mode: null },
    open: { available: false, reason: "fixture", ref: null }, interrupt: { available: false, reason: "fixture" }, close: { available: false, reason: "fixture" } },
  source: { kind: "session", id: sessionId, revision: null, evidence: "project-record", href: "" }, metadata,
};
const resources = Object.fromEntries(["configuredModel", "actualModel", "inputTokens", "outputTokens", "cost", "processMemory"]
  .map(key => [key, { value: null, unit: "", source: null, scope: "session", observedAt: null, interval: null, unavailableReason: "fixture" }]));

test("跨空间返回: task → agent → task (same tab), table → agent, 统筹安排 → task, task → document", {
  skip: !modulePath && "Set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE after building the workbench",
}, async t => {
  const { chromium } = (await import(pathToFileURL(modulePath!).href)).default;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, "http://127.0.0.1");
    if (url.pathname.startsWith("/api/")) {
      const root = `/api/projects/${projectId}`;
      const path = decodeURIComponent(url.pathname);
      let value: unknown = { items: [], nextCursor: null, metadata }, status = 200;
      if (path === "/api/session") value = { principal: { actorId: "reader", projectIds: [projectId], permissions: ["read", "write", "review"] }, capabilities: {} };
      else if (path === "/api/projects") value = [{ id: projectId, title: "返回链接夹具", createdAt: stamp }];
      else if (path === root) value = { id: projectId, title: "返回链接夹具", createdAt: stamp };
      else if (path === `${root}/tasks`) value = { items: tasks, nextCursor: null };
      else if (path === `${root}/orchestration/work-status`) value = { items: (url.searchParams.get("taskIds") ?? "").split(",").filter(Boolean)
        .map(taskId => ({ taskId, cognition: false, hasClosure: false, readyForAcceptance: false })) };
      // Automatic loops are not configured: the coordinator registers none of their routes.
      else if (path.startsWith(`${root}/orchestration/`)) { status = 404; value = { message: "Not Found" }; }
      else if (path === `${root}/work-management/index`) value = { items: indexed, nextCursor: null, total: indexed.length,
        counts: {}, changeSequence: 3, observedAt: stamp, partial: false };
      else if (path.startsWith(`${root}/work-management/tasks/`)) {
        const found = indexed.find(item => item.taskId === path.slice(`${root}/work-management/tasks/`.length));
        if (found) value = found; else { status = 404; value = { message: "未登记" }; }
      }
      else if (path.startsWith(`${root}/tasks/`)) {
        const [taskId, sub] = path.slice(`${root}/tasks/`.length).split("/");
        const found = tasks.find(item => item.id === taskId);
        if (!found) { status = 404; value = { message: "无此任务" }; }
        else if (sub === "assignment" && !path.endsWith("/history")) value = assignmentOf(found.id);
        else if (sub) value = sub === "revisions" ? [] : { items: [], nextCursor: null };
        else value = { task: found, revision: { ...found, taskId: found.id, id: found.currentRevisionId, actorId: "reader", reason: "夹具修订", createdAt: stamp, basisSetId: null },
          basis: null, links: [], impacts: [], decisions: [], deliveries: [], observations: [], closures: [] };
      }
      else if (path.startsWith(`${root}/documents/${docA}`)) {
        const revision = { projectId, documentId: docA, id: revA, body: "# 主正文\n主正文的内容。", format: "markdown", mediaType: "text/markdown",
          originalName: "doc.md", payloadRef: null, entrypoint: null, assetsManifest: [], contentHash: "a".repeat(64), author: "reader", createdAt: stamp,
          previousRevisionId: null, reason: "夹具" };
        value = path.includes("/revisions/") ? revision : path === `${root}/documents/${docA}` ? { document: { projectId, id: docA, title: "右栏信息核对的主正文",
          version: 1, currentRevisionId: revA, adoptedRevisionId: revA, kind: "task", status: "published", primaryTaskId: taskA }, current: revision, adopted: revision }
          : { items: [], nextCursor: null };
      }
      else if (path === `${root}/session-work`) value = { items: [session], nextCursor: null, observationCursor: "0", metadata,
        totals: { current: 1, historical: 0, unclassified: 0 }, attention: { unansweredQuestions: 0, pendingMessages: 0, pendingAcceptance: 0, unclassifiedSessions: 0 } };
      else if (path === `${root}/session-work/${sessionKey}`) value = { session, observationCursor: "0", currentWork: null,
        assignments: [], roleTasks: [], queue: [], results: [], questions: [], activity: [], resources, metadata };
      else if (path === `${root}/session-work/${sessionKey}/profile`) value = null;
      else if (path === `${root}/session-work/${sessionKey}/timeline`) value = timelinePage(sessionKey, { title: agentTitle });
      else if (path.endsWith("/timeline/updates")) value = { cursor: "0", resetRequired: false, entries: [], turns: [], freshness: "live", limitations: [] };
      else if (path === `${root}/runtime/sessions` || path.startsWith(`${root}/runtime/runs`) || path === `${root}/resident-queues`
        || path.startsWith(`${root}/references/tasks/`)) value = [];
      else if (path === `${root}/runtime`) value = { available: true };
      else if (path === `${root}/roles/${roleId}`) value = { projectId, id: roleId, state: "active", proposal: { title: "开发" } };
      res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); return;
    }
    try {
      const file = /^\/(?:$|p\/|ui$)/.test(url.pathname) ? "index.html" : url.pathname;
      res.writeHead(200, { "content-type": ({ ".html": "text/html", ".js": "text/javascript", ".css": "text/css" } as Record<string, string>)[extname(file)] ?? "application/octet-stream" });
      res.end(await readFile(join(dist, file)));
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const browser = await chromium.launch({ headless: true, ...(process.env.EVOLOOP_BROWSER_TEST_EXECUTABLE_PATH ? { executablePath: process.env.EVOLOOP_BROWSER_TEST_EXECUTABLE_PATH } : {}) });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  const here = () => page.evaluate(() => location.pathname + location.search);
  const shoot = async (name: string) => { if (shots) await page.screenshot({ path: `${shots}/${name}.png` }); };
  const fail = async (what: string) => assert.fail(`${what}: url=${await here()} body=${(await page.locator("body").innerText()).slice(0, 900)} errors=${errors.join(" | ")}`);
  const taskPath = `/p/${projectId}/tasks/${taskA}`;
  const returnLink = (label: string) => page.locator("[data-return-link]").filter({ hasText: label });

  await page.goto(`${base}${taskPath}`);
  await page.getByLabel("访问令牌").fill("fixture-token");
  await page.getByRole("button", { name: "进入", exact: true }).click();
  await page.getByRole("heading", { level: 1, name: titleA }).waitFor({ timeout: 8000 }).catch(() => fail("task did not open"));

  // 1. The right column's 进入对话 → the agent offers “返回任务：<名称>” → the same task.
  const facts = page.getByRole("complementary", { name: "右栏" }).locator(`[data-task-facts="${taskA}"] [data-task-agent]`);
  await facts.getByRole("link", { name: "进入对话" }).waitFor({ timeout: 8000 }).catch(() => fail("right column 进入对话 missing"));
  await facts.getByRole("link", { name: "进入对话" }).click();
  await page.getByRole("heading", { name: agentTitle }).waitFor({ timeout: 8000 }).catch(() => fail("agent page did not open"));
  const backToTask = returnLink(`返回任务：${titleA}`);
  await backToTask.waitFor({ timeout: 5000 }).catch(() => fail("agent page has no way back to the task"));
  assert.equal(await backToTask.innerText(), `返回任务：${titleA}`, "the name once, no doubled brackets");
  assert.doesNotMatch(await page.locator("body").innerText(), /【【|Session/);
  await shoot("agent-from-task-1440");
  await backToTask.click();
  await page.getByRole("heading", { level: 1, name: titleA }).waitFor();
  assert.equal(await here(), taskPath);

  // 2. 运行与关联 › 进入对话 → back to the same tab. 自动循环 that is not configured says so.
  await page.getByRole("tab", { name: "运行与关联" }).click();
  assert.equal(await here(), `${taskPath}?tab=runtime`);
  const runtime = page.locator(`#task-panel-${projectId}-${taskA}-current-runtime`);
  await runtime.getByText("自动循环未配置或尚未启用，没有可观察的循环。").waitFor({ timeout: 8000 }).catch(() => fail("自动循环 not said as not configured"));
  assert.doesNotMatch(await runtime.innerText(), /不存在或已被移除/);
  await runtime.locator("[data-orchestration]").scrollIntoViewIfNeeded();
  await shoot("task-runtime-1440");
  await runtime.locator("[data-assignment]").getByRole("link", { name: "进入对话" }).click();
  await backToTask.waitFor({ timeout: 8000 }).catch(() => fail("agent page from 运行与关联 has no way back"));
  await backToTask.click();
  await page.getByRole("heading", { level: 1, name: titleA }).waitFor();
  assert.equal(await here(), `${taskPath}?tab=runtime`);
  assert.equal(await page.getByRole("tab", { name: "运行与关联" }).getAttribute("aria-selected"), "true", "the same tab");

  // 3. The task opens its main text beside it, then in the center: the document names the task it came from.
  await page.getByRole("tab", { name: "当前工作" }).click();
  await page.getByRole("button", { name: "在右栏核对固定原件" }).click();
  await page.getByRole("complementary", { name: "右栏" }).getByRole("link", { name: "在中间打开" }).click();
  await page.getByRole("heading", { level: 1, name: "右栏信息核对的主正文" }).waitFor({ timeout: 8000 }).catch(() => fail("document did not open"));
  const documentBack = page.locator(".document-reading-backlinks [data-return-link]");
  await documentBack.filter({ hasText: `返回任务：${titleA}` }).waitFor({ timeout: 5000 }).catch(() => fail("document does not name the task"));
  await shoot("document-from-task-1440");
  await documentBack.click();
  await page.getByRole("heading", { level: 1, name: titleA }).waitFor();

  // 4. The task table's right column → agent → back to the table with the same row.
  const table = `/p/${projectId}/work?state=all&selected=${taskA}`;
  await page.goto(`${base}${table}`);
  await page.getByLabel("访问令牌").fill("fixture-token");
  await page.getByRole("button", { name: "进入", exact: true }).click();
  const tableFacts = page.getByRole("complementary", { name: "右栏" }).locator(`[data-task-facts="${taskA}"] [data-task-agent]`);
  await tableFacts.getByRole("link", { name: "进入对话" }).waitFor({ timeout: 8000 }).catch(() => fail("table right column 进入对话 missing"));
  const tableAddress = await here();
  assert.match(tableAddress, new RegExp(`selected=${taskA}`));
  await tableFacts.getByRole("link", { name: "进入对话" }).click();
  await backToTask.waitFor({ timeout: 8000 }).catch(() => fail("agent page from the table has no way back"));
  await backToTask.click();
  await page.getByRole("heading", { level: 1, name: "任务" }).waitFor();
  assert.equal(await here(), tableAddress, "the table with the same filter and row");
  // Another row's agent, while row A stays selected: named after that row, and back with that row selected.
  await page.locator("tr", { hasText: titleB }).locator("[data-owner-cell] a").click();
  const backToRowB = returnLink(`返回任务：${titleB}`);
  await backToRowB.waitFor({ timeout: 8000 }).catch(() => fail("an agent from row B is not named after row B"));
  assert.equal(await page.locator("[data-return-link]:visible").filter({ hasText: `返回任务：${titleA}` }).count(), 0, "never named after the selected row");
  await backToRowB.click();
  await page.getByRole("heading", { level: 1, name: "任务" }).waitFor();
  assert.match(await here(), new RegExp(`selected=${taskB}`));
  assert.match(await here(), /state=all/, "the filter stays");

  // 5. 统筹安排: an assignment on an older revision is a risk; a task opened from the board comes back to it.
  await page.goto(`${base}/p/${projectId}/sessions`);
  await page.getByLabel("访问令牌").fill("fixture-token");
  await page.getByRole("button", { name: "进入", exact: true }).click();
  await page.getByRole("heading", { name: "统筹安排" }).waitFor();
  const board = page.getByRole("list", { name: "各智能体的安排" });
  const staleLine = board.locator("[data-stale-assignment]");
  await staleLine.waitFor({ timeout: 8000 }).catch(() => fail("stale assignment not marked on the board"));
  assert.match(await staleLine.innerText(), new RegExp(`${titleB}[\\s\\S]*分派属于旧修订 · 要重新指定`));
  assert.doesNotMatch(await staleLine.innerText(), /待接手/);
  assert.equal(await staleLine.count(), 1, "only the assignment that would stop the next dispatch");
  assert.match(await board.locator("li", { hasText: titleD }).last().innerText(), /待验收/, "a delivered task waiting for acceptance is not stale");
  const risks = page.getByRole("region", { name: "冲突与风险" });
  await risks.getByRole("link", { name: `「${titleB}」的分派属于旧修订，要重新指定` }).waitFor();
  assert.match(await page.getByLabel("概况").innerText(), /1\s*个冲突与风险/);
  await shoot("arrangement-stale-1440");
  await board.getByRole("link", { name: titleA }).click();
  await page.getByRole("heading", { level: 1, name: titleA }).waitFor();
  const backToBoard = returnLink("返回统筹安排");
  await backToBoard.waitFor({ timeout: 5000 }).catch(() => fail("task from 统筹安排 has no way back"));
  await page.getByRole("tab", { name: "历史" }).click();
  await backToBoard.waitFor();
  await shoot("task-from-arrangement-1440");
  await backToBoard.click();
  await page.getByRole("heading", { name: "统筹安排" }).waitFor();
  assert.equal(await here(), `/p/${projectId}/sessions`);
  await page.getByRole("region", { name: /没有承接者的任务/ }).getByRole("link", { name: titleC }).click();
  await page.getByRole("heading", { level: 1, name: titleC }).waitFor();
  await backToBoard.waitFor();
  await backToBoard.click();
  await page.getByRole("heading", { name: "统筹安排" }).waitFor();

  // 6. Narrow widths: the way back stays on screen and nothing scrolls sideways.
  const agentFromTask = `/p/${projectId}/sessions?${new URLSearchParams({ session: sessionKey, return: `${taskPath}?tab=runtime`, actor: "reader", returnTitle: titleA })}`;
  const taskFromBoard = `${taskPath}?${new URLSearchParams({ return: `/p/${projectId}/sessions`, actor: "reader" })}`;
  for (const width of [1024, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 800 });
    for (const [name, path, label] of [["agent-from-task", agentFromTask, `返回任务：${titleA}`], ["task-from-arrangement", taskFromBoard, "返回统筹安排"],
      ["arrangement-stale", `/p/${projectId}/sessions`, null]] as const) {
      await page.evaluate(next => { history.pushState(null, "", next); dispatchEvent(new PopStateEvent("popstate")); }, path);
      if (label) await returnLink(label).waitFor({ timeout: 8000 }).catch(() => fail(`${name} at ${width}`));
      else await page.locator("[data-stale-assignment]").waitFor();
      // The way back sits at the top of the page: show it (a cached page comes back at its old scroll position).
      await page.waitForTimeout(300);
      await page.evaluate(() => window.scrollTo(0, 0));
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `${name} overflows at ${width}px`);
      await shoot(`${name}-${width}`);
    }
  }
  assert.deepEqual(errors, []);
});
