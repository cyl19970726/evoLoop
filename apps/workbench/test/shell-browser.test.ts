// Opt-in built-app regression for the frame (docs/frontend/layout.md): switching spaces keeps each list's filter,
// search and selected row (M5); 在中间打开 turns the right column to 信息 (M7); closing the right drawer with Esc
// returns focus to the button that opened it (L3); 展开右栏 never covers the page header (L4); an address that names
// no page says so (L10); phones get a compact task list until the reader chooses the table (L13). Leaving the project
// or signing out with a draft asks in @evoloop/ui's ConfirmDialog, Back and Forward included (#229 F6).
// Build the workbench, then set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE; EVOLOOP_SHELL_SCREENSHOT_DIR keeps screenshots.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const modulePath = process.env.EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE;
const shots = process.env.EVOLOOP_SHELL_SCREENSHOT_DIR;
const dist = resolve(import.meta.dirname, "../dist");
const projectId = "34000001-0000-4000-8000-000000000001";
const roleId = "34000002-0000-4000-8000-000000000002";
const sessionId = "34000003-0000-4000-8000-000000000003";
const [taskA, taskB, taskC] = ["34000010", "34000011", "34000012"].map(prefix => `${prefix}-0000-4000-8000-000000000000`);
const [docA, docMap] = ["34000020", "34000021"].map(prefix => `${prefix}-0000-4000-8000-000000000000`);
const [revA, revMap] = ["34000030", "34000031"].map(prefix => `${prefix}-0000-4000-8000-000000000000`);
const stamp = "2026-11-09T00:00:00.000Z";

const task = (id: string, title: string, state: string) => ({
  projectId, id, version: 2, currentRevisionId: `${id.slice(0, 8)}-rev`, title, content: `# 目标\n${title}的正文。`, contentDocumentId: docA,
  contentRevisionId: revA, kind: "implementation", acceptance: "1. 外壳记住位置。", owner: roleId, state });
const tasks = [task(taskA, "甲：进行中的外壳任务", "in_progress"), task(taskB, "乙：待办的外壳任务", "todo"), task(taskC, "丙：已完成的外壳任务", "done")];
const projection = (item: ReturnType<typeof task>, phase: string) => ({
  kind: "task", taskId: item.id, version: item.version, currentRevisionId: item.currentRevisionId, workChangeSequence: 3, title: item.title,
  taskKind: item.kind, taskState: item.state, phase, nextAction: "", responsible: { kind: "role", id: roleId, label: "负责职责" },
  assignment: null, latestRun: null, delivery: null, pendingImpactCount: 0, queueHold: null, goal: null, stage: null,
  plan: { plannedStartAt: null, dueAt: null, priority: null }, dependencies: [], dependencyVersion: 0, review: null,
  dates: { createdAt: stamp, businessChangedAt: stamp, startedAt: null, completedAt: null, observedAt: stamp }, timing: null, actionKey: `task:${item.id}`,
});
const indexed = [projection(tasks[0]!, "awaiting_acceptance"), projection(tasks[1]!, "unassigned"), projection(tasks[2]!, "closed")];
const documents: Record<string, { title: string; kind: string; current: string; body: string }> = {
  [docA]: { title: "甲的主正文", kind: "task", current: revA, body: "# 目标\n甲的正文。" },
  [docMap]: { title: "需求总图：外壳修复", kind: "spec", current: revMap, body: "## 本轮切片\n总图正文：先修外壳，再修右栏。" },
};
const documentRecord = (id: string) => ({ projectId, id, title: documents[id]!.title, version: 1, currentRevisionId: documents[id]!.current,
  adoptedRevisionId: documents[id]!.current, kind: documents[id]!.kind, status: "published", createdAt: stamp, updatedAt: stamp });
const revisionRecord = (id: string) => ({ projectId, documentId: id, id: documents[id]!.current, body: documents[id]!.body, format: "markdown",
  mediaType: "text/markdown", originalName: "doc.md", payloadRef: null, entrypoint: null, assetsManifest: [], contentHash: "a".repeat(64),
  author: "reader", createdAt: stamp, previousRevisionId: null, reason: "夹具" });
const agent = (n: number, title: string) => ({
  key: `owned:${n === 1 ? sessionId : `34000004-0000-4000-8000-00000000000${n}`}`, target: { kind: "owned", sessionId }, aliases: [], title,
  profile: null, identity: null, kind: "owned", roles: [{ id: roleId, title: "开发", state: "active", roleClass: "business", templateKey: null, responsibility: "开发" }],
  membership: "current", membershipReason: "verified", runtimeState: "ready", busy: false, currentTask: null, latestBusinessRun: null, lastProgressAt: stamp,
  capabilities: { observe: { available: true, reason: null }, send: { available: true, reason: null, mode: "native" },
    open: { available: false, reason: null, ref: null }, interrupt: { available: false, reason: null }, close: { available: false, reason: null } },
  source: { kind: "session", id: sessionId, revision: null, evidence: "project-record", href: "" },
  metadata: { generatedAt: stamp, sourceObservedAt: null, partial: false, limitations: [] },
});
const agents = [agent(1, "开发智能体"), agent(2, "验收智能体")];

async function serve(t: { after: (fn: () => unknown) => void }) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, "http://127.0.0.1");
    if (url.pathname.startsWith("/api/")) {
      const root = `/api/projects/${projectId}`;
      const path = decodeURIComponent(url.pathname);
      let value: unknown = { items: [], nextCursor: null }, status = 200;
      const tail = (prefix: string) => path.slice(prefix.length).split("/");
      if (path === "/api/session") value = { principal: { actorId: "reader", projectIds: [projectId], permissions: ["read", "write", "review"] }, capabilities: {} };
      else if (path === "/api/projects") value = [{ id: projectId, title: "外壳夹具", createdAt: stamp }];
      else if (path === root) value = { id: projectId, title: "外壳夹具", createdAt: stamp };
      else if (path === `${root}/tasks`) value = { items: tasks, nextCursor: null };
      else if (path === `${root}/orchestration/work-status`) value = { items: (url.searchParams.get("taskIds") ?? "").split(",").filter(Boolean)
        .map(taskId => ({ taskId, cognition: false, hasClosure: false, readyForAcceptance: false })) };
      else if (path === `${root}/work-management/index`) value = { items: indexed, nextCursor: null, total: indexed.length,
        counts: { awaiting_acceptance: 1, unassigned: 1 }, changeSequence: 3, observedAt: stamp, partial: false };
      else if (path.startsWith(`${root}/work-management/tasks/`)) {
        const found = indexed.find(item => item.taskId === tail(`${root}/work-management/tasks/`)[0]);
        if (found) value = found; else { status = 404; value = { message: "未登记" }; }
      }
      else if (path.startsWith(`${root}/tasks/`)) {
        const [id, sub] = tail(`${root}/tasks/`);
        const found = tasks.find(item => item.id === id);
        if (!found) { status = 404; value = { message: "无此任务" }; }
        else if (sub === "assignment") value = null;
        else if (sub) { status = 404; value = { message: "夹具未提供" }; }
        else value = { task: found, revision: { ...found, taskId: found.id, id: found.currentRevisionId, actorId: "reader", reason: "夹具修订", createdAt: stamp, basisSetId: null },
          basis: null, links: id === taskA ? [{ projectId, id: "link-1", taskId: id, documentId: docMap, actorId: "reader", createdAt: stamp }] : [],
          impacts: [], decisions: [], deliveries: [], observations: [], closures: [] };
      }
      else if (path === `${root}/documents`) value = { items: Object.keys(documents).map(documentRecord), nextCursor: null };
      else if (path.startsWith(`${root}/documents/`)) {
        const [id, sub] = tail(`${root}/documents/`);
        if (!documents[id!]) { status = 404; value = { message: "无此文档" }; }
        else if (sub === "tasks") value = { items: id === docMap ? [{ projectId, id: taskA, title: tasks[0]!.title, state: "in_progress", owner: roleId,
          kind: "implementation", version: 2, currentRevisionId: tasks[0]!.currentRevisionId, relations: ["link"] }] : [], nextCursor: null };
        else if (sub === "revisions") value = revisionRecord(id!);
        else if (sub) { status = 404; value = { message: "夹具未提供" }; }
        else value = { document: documentRecord(id!), current: revisionRecord(id!), adopted: revisionRecord(id!) };
      }
      else if (path === `${root}/session-work`) {
        const search = url.searchParams.get("search") ?? "";
        const items = (url.searchParams.get("membership") ?? "current") === "current" ? agents.filter(item => item.title.includes(search)) : [];
        value = { items, nextCursor: null, observationCursor: "0", metadata: agents[0]!.metadata, totals: { current: agents.length, historical: 0, unclassified: 0 },
          attention: { unansweredQuestions: 0, pendingMessages: 0, pendingAcceptance: 0, unclassifiedSessions: 0 } };
      }
      else if (path === `${root}/resident-queues` || path === `${root}/impacts` || path.startsWith(`${root}/references/tasks/`)) value = [];
      else if (path === `${root}/roles/${roleId}`) value = { projectId, id: roleId, proposal: { title: "开发" } };
      res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); return;
    }
    try {
      const file = /^\/(?:$|p\/|ui$)/.test(url.pathname) ? "index.html" : url.pathname;
      res.writeHead(200, { "content-type": ({ ".html": "text/html", ".js": "text/javascript", ".css": "text/css" } as Record<string, string>)[extname(file)] ?? "application/octet-stream" });
      res.end(await readFile(join(dist, file)));
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); t.after(() => server.close());
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

type Page = import("playwright").Page;
const login = async (page: Page) => {
  await page.getByLabel("访问令牌").fill("fixture-token");
  await page.getByRole("button", { name: "进入", exact: true }).click();
};
/** In-app navigation, as a link click does: the page and its in-memory login stay. */
const go = (page: Page, path: string) => page.evaluate(target => {
  const link = Object.assign(document.createElement("a"), { href: target }); document.body.append(link); link.click(); link.remove();
}, path);
const shot = async (page: Page, name: string) => { if (shots) await page.screenshot({ path: join(shots, `${name}.png`), fullPage: false }); };
const pathOf = (page: Page) => { const url = new URL(page.url()); return `${url.pathname}${url.search}`; };
const overlap = (a: { x: number; y: number; width: number; height: number }, b: typeof a) =>
  Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));

test("the frame keeps each space's list, turns the right column to 信息, returns focus, and says when a page does not exist", {
  skip: !modulePath && "Set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE",
}, async t => {
  const { chromium } = (await import(pathToFileURL(modulePath!).href)).default;
  const base = await serve(t);
  const browser = await chromium.launch({ headless: true, ...(process.env.EVOLOOP_BROWSER_TEST_EXECUTABLE_PATH ? { executablePath: process.env.EVOLOOP_BROWSER_TEST_EXECUTABLE_PATH } : {}) });
  t.after(() => browser.close());
  const errors: string[] = [];
  const open = async (width: number, height: number, path: string) => {
    const page: Page = await (await browser.newContext({ viewport: { width, height } })).newPage();
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(`${base}${path}`);
    await login(page);
    return page;
  };

  // M5 at 1440: filter, search and selected row survive 工作 → 智能体 → 工作; the agents' directory search and the
  // document table's search survive the same round trip.
  const page = await open(1440, 900, `/p/${projectId}/work`);
  const main = page.getByRole("main");
  const spaces = page.getByRole("navigation", { name: "空间" });
  const rail = page.getByRole("region", { name: "任务列表" });
  await rail.getByRole("link").first().waitFor();
  await page.getByLabel("任务状态筛选").selectOption("all");
  await rail.getByRole("searchbox", { name: "搜索任务" }).fill("外壳任务");
  await main.getByRole("button", { name: tasks[2]!.title, exact: true }).click();
  await page.waitForFunction(id => location.search.includes(`selected=${id}`), taskC);
  const listAddress = pathOf(page);
  assert.match(listAddress, /state=all/);
  assert.match(listAddress, /q=/);
  await spaces.getByRole("link", { name: "智能体" }).click();
  await page.getByRole("heading", { name: "统筹安排" }).waitFor();
  const agentSearch = page.getByLabel("搜索智能体名称或职责");
  await agentSearch.fill("验收");
  await page.getByRole("region", { name: "智能体目录" }).getByRole("link", { name: /验收智能体/ }).waitFor();
  assert.equal(await spaces.getByRole("link", { name: "工作" }).getAttribute("href"), listAddress, "the work space link points where the list was left");
  await spaces.getByRole("link", { name: "工作" }).click();
  await page.getByRole("heading", { level: 1, name: "任务" }).waitFor({ timeout: 8000 }).catch(async () =>
    assert.fail(`work did not reopen: ${pathOf(page)} main=${(await main.innerText()).slice(0, 400)} pre=${await main.locator("pre").allTextContents()} errors=${errors.join(" | ")}`));
  assert.equal(pathOf(page), listAddress);
  assert.equal(await page.getByLabel("任务状态筛选").inputValue(), "all");
  assert.equal(await rail.getByRole("searchbox", { name: "搜索任务" }).inputValue(), "外壳任务");
  assert.equal(await main.getByRole("button", { name: tasks[2]!.title, exact: true }).getAttribute("aria-pressed"), "true");
  await page.getByRole("complementary", { name: "右栏" }).locator(`[data-task-facts="${taskC}"]`).waitFor();
  await shot(page, "shell-1440-01-list-kept");
  await spaces.getByRole("link", { name: "智能体" }).click();
  assert.equal(await page.getByLabel("搜索智能体名称或职责").inputValue(), "验收", "the agents' directory keeps its search");
  await spaces.getByRole("link", { name: "工作" }).click();
  await page.getByRole("heading", { level: 1, name: "任务" }).waitFor();
  // The document table keeps its search across the same round trip.
  await page.getByRole("navigation", { name: "工作分区" }).getByRole("link", { name: "文档与知识" }).click();
  const documentSearch = page.getByRole("searchbox", { name: "搜索文档" }).first();
  await documentSearch.fill("总图");
  await spaces.getByRole("link", { name: "智能体" }).click();
  await page.getByRole("heading", { name: "统筹安排" }).waitFor();
  await spaces.getByRole("link", { name: "工作" }).click();
  assert.match(pathOf(page), /\/documents$/);
  assert.equal(await page.getByRole("searchbox", { name: "搜索文档" }).first().inputValue(), "总图");

  // L10: an address that names no page says so, keeps the address, and offers the way back.
  await go(page, `/p/${projectId}/task/${taskA}`);
  await page.getByRole("heading", { level: 1, name: "找不到这个页面" }).waitFor();
  assert.equal(pathOf(page), `/p/${projectId}/task/${taskA}`);
  assert.match(await page.title(), /^找不到页面/);
  assert.equal(await main.getByRole("link", { name: "回到总览" }).getAttribute("href"), `/p/${projectId}/overview`);
  assert.equal(await main.getByRole("link", { name: "回到任务" }).getAttribute("href"), `/p/${projectId}/work`);
  await shot(page, "shell-1440-02-not-found");
  await spaces.getByRole("link", { name: "智能体" }).click();
  await page.getByRole("heading", { name: "统筹安排" }).waitFor();
  assert.match(await spaces.getByRole("link", { name: "工作" }).getAttribute("href") ?? "", /\/documents$/, "the wrong address is not where 工作 reopens");
  await go(page, `/p/${projectId}/task/${taskA}`);
  await main.getByRole("link", { name: "回到任务" }).click();
  await page.getByRole("heading", { level: 1, name: "任务" }).waitFor();

  // M7: a document opened beside the task, then 在中间打开 — the column shows the document's 信息, not its text again.
  await go(page, `/p/${projectId}/tasks/${taskA}`);
  await page.getByRole("heading", { level: 1, name: tasks[0]!.title }).waitFor();
  const panel = page.getByRole("complementary", { name: "右栏" });
  await panel.locator(`[data-task-facts="${taskA}"]`).getByRole("button", { name: /需求总图：外壳修复/ }).click();
  await panel.getByText("总图正文：先修外壳，再修右栏。").waitFor();
  await panel.getByRole("link", { name: "在中间打开" }).click();
  await main.getByText("总图正文：先修外壳，再修右栏。", { exact: true }).waitFor();
  assert.equal(pathOf(page), `/p/${projectId}/documents/${docMap}`);
  assert.equal(await panel.getByRole("tab", { name: "需求总图：外壳修复" }).count(), 0, "the tab of the document now in the center closes");
  assert.equal(await panel.getByRole("tab", { name: "信息" }).getAttribute("aria-selected"), "true");
  await panel.getByRole("region", { name: "文档版本、来源与关联" }).getByRole("link", { name: new RegExp(tasks[0]!.title) }).waitFor();
  assert.equal(await panel.getByText("总图正文：先修外壳，再修右栏。").count(), 0, "the right column does not repeat the text");
  await shot(page, "shell-1440-03-open-in-center");
  // The same for a task opened from 引用它的任务.
  await panel.getByRole("region", { name: "文档版本、来源与关联" }).getByRole("link", { name: new RegExp(tasks[0]!.title) }).click();
  await panel.getByRole("tab", { name: tasks[0]!.title }).waitFor();
  await panel.getByRole("link", { name: "在中间打开" }).click();
  await page.getByRole("heading", { level: 1, name: tasks[0]!.title }).waitFor();
  assert.equal(await panel.getByRole("tab", { name: tasks[0]!.title }).count(), 0);
  assert.equal(await panel.getByRole("tab", { name: "信息" }).getAttribute("aria-selected"), "true");
  await panel.locator(`[data-task-facts="${taskA}"]`).waitFor();

  // L4: with the right column collapsed (1280 inline, 1024 drawer), 展开右栏 leaves the header's buttons uncovered.
  for (const width of [1280, 1024]) {
    const narrow = await open(width, 800, `/p/${projectId}/work`);
    const create = narrow.getByRole("main").getByRole("link", { name: "新建任务" });
    await create.waitFor();
    const expand = narrow.getByRole("button", { name: "展开右栏" });
    await expand.waitFor();
    const [a, b] = [await expand.boundingBox(), await create.boundingBox()];
    assert.ok(a && b && overlap(a, b) === 0, `展开右栏 ${JSON.stringify(a)} covers 新建任务 ${JSON.stringify(b)} at ${width}`);
    assert.ok(await narrow.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await shot(narrow, `shell-${width}-04-header`);
    if (width === 1024) {
      // L3: the drawer opened from 所选任务信息 gives focus back to it when Esc closes it.
      const opener = narrow.getByRole("main").getByRole("button", { name: "所选任务信息" });
      await opener.click();
      await narrow.getByRole("dialog").locator("[data-task-facts]").waitFor();
      await shot(narrow, "shell-1024-05-drawer");
      await narrow.keyboard.press("Escape");
      await narrow.getByRole("dialog").waitFor({ state: "detached" });
      await narrow.waitForFunction(() => document.activeElement?.textContent === "所选任务信息", null, { timeout: 3000 }).catch(async () =>
        assert.fail(`focus after Esc: ${await narrow.evaluate(() => document.activeElement?.outerHTML.slice(0, 120))}`));
    }
    await narrow.context().close();
  }

  // L13 and L3 at 390: a compact list by default; the table once chosen, kept across a reload; Esc returns focus.
  const phone = await open(390, 844, `/p/${projectId}/work`);
  const phoneMain = phone.getByRole("main");
  const views = phoneMain.getByRole("navigation", { name: "任务视图" });
  await phoneMain.locator('[data-task-table="stacked"]').waitFor();
  assert.equal(await views.getByRole("link", { name: "列表" }).getAttribute("aria-current"), "page");
  assert.equal(await phoneMain.getByRole("columnheader", { name: "工作类型" }).count(), 0, "no six columns on a phone by default");
  await phoneMain.getByRole("row").filter({ hasText: tasks[0]!.title }).getByText("待验收").waitFor();
  assert.ok(await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await shot(phone, "shell-390-06-compact-list");
  const phoneOpener = phoneMain.getByRole("button", { name: "所选任务信息" });
  await phoneOpener.click();
  await phone.getByRole("dialog").locator("[data-task-facts]").waitFor();
  await phone.keyboard.press("Escape");
  await phone.getByRole("dialog").waitFor({ state: "detached" });
  await phone.waitForFunction(() => document.activeElement?.textContent === "所选任务信息", null, { timeout: 3000 }).catch(async () =>
    assert.fail(`focus after Esc at 390: ${await phone.evaluate(() => document.activeElement?.outerHTML.slice(0, 120))}`));
  await views.getByRole("link", { name: "表格" }).click();
  await phoneMain.getByRole("columnheader", { name: "工作类型" }).waitFor();
  assert.equal(await views.getByRole("link", { name: "表格" }).getAttribute("aria-current"), "page");
  await phone.reload();
  await login(phone);
  await phoneMain.getByRole("columnheader", { name: "工作类型" }).waitFor();
  assert.equal(await phoneMain.locator('[data-task-table="stacked"]').count(), 0, "the reader's choice of the table is kept");
  await shot(phone, "shell-390-07-table-chosen");
  await views.getByRole("link", { name: "列表" }).click();
  await phoneMain.locator('[data-task-table="stacked"]').waitFor();
  assert.deepEqual(errors, []);
});

test("leaving the project or signing out with a draft asks in the page's dialog; Back is asked too; staying keeps the draft", {
  skip: !modulePath && "Set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE",
}, async t => {
  const { chromium } = (await import(pathToFileURL(modulePath!).href)).default;
  const base = await serve(t);
  const browser = await chromium.launch({ headless: true, ...(process.env.EVOLOOP_BROWSER_TEST_EXECUTABLE_PATH ? { executablePath: process.env.EVOLOOP_BROWSER_TEST_EXECUTABLE_PATH } : {}) });
  t.after(() => browser.close());
  const errors: string[] = [];
  const page: Page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  page.on("pageerror", error => errors.push(error.message));
  let nativeDialogs = 0;
  page.on("dialog", dialog => { nativeDialogs += 1; void dialog.dismiss(); });
  await page.goto(`${base}/`);
  await login(page);
  await page.getByRole("heading", { name: "你的项目" }).waitFor();
  await go(page, `/p/${projectId}/tasks/new`);
  const title = page.getByRole("main").getByLabel("任务名称");
  await title.fill("还没保存的任务");
  await page.locator('[data-dirty="true"]').first().waitFor();
  const ask = page.getByRole("alertdialog");

  // 切换项目 asks; staying keeps the page and the draft. The safe answer has the focus.
  await page.getByRole("complementary", { name: "项目导航" }).getByRole("link", { name: /切换项目/ }).click();
  await ask.getByRole("heading", { name: "离开当前项目？" }).waitFor();
  assert.match(await ask.innerText(), /还有未提交的草稿。离开当前项目会清除页面草稿。/);
  assert.equal(await page.evaluate(() => document.activeElement?.textContent), "留在当前项目");
  await shot(page, "shell-1440-08-leave-confirm");
  await ask.getByRole("button", { name: "留在当前项目" }).click();
  await ask.waitFor({ state: "detached" });
  assert.equal(pathOf(page), `/p/${projectId}/tasks/new`);
  assert.equal(await title.inputValue(), "还没保存的任务");

  // Back to the project list is asked as well; Escape stays, and the address comes back to the form.
  await page.goBack();
  await ask.getByRole("heading", { name: "离开当前项目？" }).waitFor();
  await page.keyboard.press("Escape");
  await ask.waitFor({ state: "detached" });
  await page.waitForFunction(path => `${location.pathname}${location.search}` === path, `/p/${projectId}/tasks/new`);
  assert.equal(await title.inputValue(), "还没保存的任务");

  // Signing out asks; staying keeps the draft.
  await page.getByRole("complementary", { name: "项目导航" }).getByRole("button", { name: "设置与账号" }).click();
  await page.getByRole("menuitem", { name: "退出" }).click();
  await ask.getByRole("heading", { name: "退出并清除草稿？" }).waitFor();
  await ask.getByRole("button", { name: "先不退出" }).click();
  await ask.waitFor({ state: "detached" });
  assert.equal(await title.inputValue(), "还没保存的任务");

  // Confirming leaves: Back reaches the project list; with no draft left, signing out does not ask.
  await page.goBack();
  await ask.getByRole("button", { name: "离开并清除草稿" }).click();
  await page.getByRole("heading", { name: "你的项目" }).waitFor();
  assert.equal(pathOf(page), "/");
  await page.getByRole("button", { name: "退出" }).click();
  await page.getByRole("heading", { name: "进入项目工作台" }).waitFor();
  assert.equal(await ask.count(), 0);
  assert.equal(nativeDialogs, 0, "the browser's own confirm() is never used");
  assert.deepEqual(errors, []);
});
