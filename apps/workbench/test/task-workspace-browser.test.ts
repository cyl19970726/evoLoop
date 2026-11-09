// Opt-in built-app regression for the task page's core paths (docs/frontend/scenarios.md 核心路径 1–3):
// the list's sort lives in the address and survives opening a task, Back and a reload; related documents open in
// the right column without leaving the task; an agent is bound from the right column and read back.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const modulePath = process.env.EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE;
const dist = resolve(import.meta.dirname, "../dist");
const projectId = "32000001-0000-4000-8000-000000000001";
const roleId = "32000002-0000-4000-8000-000000000002";
const sessionId = "32000003-0000-4000-8000-000000000003";
const [taskA, taskB, taskC] = ["32000010", "32000011", "32000012"].map(prefix => `${prefix}-0000-4000-8000-000000000000`);
const [docA, docMap, docRule] = ["32000020", "32000021", "32000022"].map(prefix => `${prefix}-0000-4000-8000-000000000000`);
const [revA, revMap, revRuleOld, revRuleNew] = ["32000030", "32000031", "32000032", "32000033"].map(prefix => `${prefix}-0000-4000-8000-000000000000`);
const stamp = "2026-11-09T00:00:00.000Z";
const task = (id: string, title: string, state: string, contentDocumentId = docA, contentRevisionId = revA) => ({
  projectId, id, version: 2, currentRevisionId: `${id.slice(0, 8)}-rev`, title, content: `# 目标\n${title}的正文。`, contentDocumentId, contentRevisionId,
  kind: "implementation", acceptance: "1. 列表可排序。2. 右栏能读文档。", owner: roleId, state });
const tasks = [task(taskA, "甲：进行中的任务", "in_progress"), task(taskB, "乙：待办的任务", "todo"), task(taskC, "丙：已完成的任务", "done")];
const projection = (item: ReturnType<typeof task>, phase: string, priority: number | null) => ({
  kind: "task", taskId: item.id, version: item.version, currentRevisionId: item.currentRevisionId, workChangeSequence: 3, title: item.title,
  taskKind: item.kind, taskState: item.state, phase, nextAction: `${item.title.slice(0, 1)}的下一步`,
  responsible: { kind: "role", id: roleId, label: "负责职责" }, assignment: null, latestRun: null, delivery: null, pendingImpactCount: 0,
  queueHold: null, goal: null, stage: null, plan: { plannedStartAt: null, dueAt: null, priority }, dependencies: [], dependencyVersion: 0, review: null,
  dates: { createdAt: stamp, businessChangedAt: stamp, startedAt: null, completedAt: null, observedAt: stamp },
  timing: null, actionKey: `task:${item.id}`,
});
const documents: Record<string, { title: string; kind: string; current: string; body: Record<string, string> }> = {
  [docA]: { title: "甲的主正文", kind: "task", current: revA, body: { [revA]: "# 目标\n甲的正文。" } },
  [docMap]: { title: "需求总图：本轮切片", kind: "spec", current: revMap, body: { [revMap]: "## 本轮切片\n总图正文：先做列表，再做右栏。" } },
  [docRule]: { title: "对账规则", kind: "spec", current: revRuleNew, body: { [revRuleOld]: "旧版规则正文。", [revRuleNew]: "新版规则正文。" } },
};

test("task list sort survives opening, Back and reload; documents open beside the task; an agent binds and reads back", {
  skip: !modulePath && "Set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE",
}, async t => {
  const { chromium } = (await import(pathToFileURL(modulePath!).href)).default;
  let assignment: Record<string, unknown> | null = null;
  const commands: Record<string, unknown>[] = [];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, "http://127.0.0.1");
    if (url.pathname.startsWith("/api/")) {
      const root = `/api/projects/${projectId}`;
      const path = decodeURIComponent(url.pathname);
      let value: unknown = { items: [], nextCursor: null }, status = 200;
      if (path === "/api/session") value = { principal: { actorId: "reader", projectIds: [projectId], permissions: ["read", "write", "review"] }, capabilities: {} };
      else if (path === root) value = { id: projectId, title: "核心路径夹具", createdAt: stamp };
      else if (path === `${root}/tasks`) value = { items: tasks, nextCursor: null };
      else if (path === `${root}/orchestration/work-status`) value = { items: (url.searchParams.get("taskIds") ?? "").split(",").filter(Boolean).map(taskId => ({ taskId, cognition: false, hasClosure: false, readyForAcceptance: false })) };
      else if (path === `${root}/work-management/index`) value = { items: [projection(tasks[0]!, "awaiting_acceptance", 2), projection(tasks[1]!, "unassigned", 1)],
        nextCursor: null, total: 2, counts: { awaiting_acceptance: 1, unassigned: 1 }, changeSequence: 3, observedAt: stamp, partial: false };
      else if (path.startsWith(`${root}/work-management/tasks/`)) { status = 404; value = { message: "未登记" }; }
      else if (path.startsWith(`${root}/tasks/`)) {
        const [id, sub] = path.slice(`${root}/tasks/`.length).split("/");
        const found = tasks.find(item => item.id === id);
        if (!found) { status = 404; value = { message: "无此任务" }; }
        else if (sub === "assignment") value = id === taskA ? assignment : null;
        else if (sub) { status = 404; value = { message: "夹具未提供" }; }
        else value = { task: found, revision: { ...found, taskId: found.id, id: found.currentRevisionId, actorId: "reader", reason: "夹具修订", createdAt: stamp, basisSetId: null },
          basis: id === taskA ? { projectId, taskId: id, taskRevisionId: found.currentRevisionId, id: "basis", sealed: true,
            members: [{ documentId: docA, revisionId: revA }, { documentId: docRule, revisionId: revRuleOld }] } : null,
          links: id === taskA ? [{ projectId, id: "link-1", taskId: id, documentId: docMap, actorId: "reader", createdAt: stamp }] : [],
          impacts: [], decisions: [], deliveries: [], observations: [], closures: [] };
      }
      else if (path.startsWith(`${root}/documents/`)) {
        const [id, , revision] = path.slice(`${root}/documents/`.length).split("/");
        const document = documents[id!];
        if (!document) { status = 404; value = { message: "无此文档" }; }
        else {
          const revisionOf = (rev: string) => ({ projectId, documentId: id, id: rev, body: document.body[rev], format: "markdown", mediaType: "text/markdown",
            originalName: "doc.md", payloadRef: null, entrypoint: null, assetsManifest: [], contentHash: "a".repeat(64), author: "reader", createdAt: stamp,
            previousRevisionId: null, reason: "夹具" });
          value = revision ? revisionOf(revision) : { document: { projectId, id, title: document.title, version: 1, currentRevisionId: document.current,
            adoptedRevisionId: document.current, kind: document.kind, status: "published" }, current: revisionOf(document.current), adopted: revisionOf(document.current) };
        }
      }
      else if (path === `${root}/session-work`) value = { items: [{ key: `owned:${sessionId}`, target: { kind: "owned", sessionId }, aliases: [], title: "开发智能体",
        profile: { displayName: "开发智能体" }, identity: null, kind: "owned", roles: [{ id: roleId, title: "开发" }], membership: "current",
        capabilities: { observe: { available: true, reason: null } } }], nextCursor: null };
      else if (path === `${root}/session-work/owned:${sessionId}`) value = { session: { key: `owned:${sessionId}`, target: { kind: "owned", sessionId }, aliases: [],
        title: "开发智能体", profile: { displayName: "开发智能体" }, roles: [{ id: roleId, title: "开发" }], kind: "owned" } };
      else if (path.startsWith(`${root}/references/tasks/`)) value = [];
      else if (path === `${root}/roles/${roleId}`) value = { projectId, id: roleId, proposal: { title: "开发" } };
      else if (path === "/api/commands" && req.method === "POST") {
        const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk as Buffer);
        const command = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
        commands.push(command);
        if (command.type === "task.assignment.set") assignment = { projectId, taskId: taskA, version: 1, taskRevisionId: tasks[0]!.currentRevisionId,
          target: command.target, recipientActorId: command.recipientActorId, state: "assigned", ack: null, actorId: "reader", reason: command.reason, updatedAt: stamp };
        value = { operationId: command.operationId, status: "applied", entityId: taskA, version: 1 };
      }
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
  page.on("console", message => { if (message.type() === "error" && !/Failed to load resource/.test(message.text())) errors.push(message.text()); });
  const login = async () => {
    await page.getByLabel("访问令牌").fill("fixture-token");
    await page.getByRole("button", { name: "进入", exact: true }).click();
  };
  await page.goto(`${base}/p/${projectId}/work`);
  await login();
  const rail = page.getByRole("region", { name: "任务列表" });
  const railTitles = async () => (await rail.getByRole("listitem").allInnerTexts()).map(text => text.split("\n")[0]);
  await rail.getByRole("link").first().waitFor();
  assert.deepEqual(await railTitles(), ["甲：进行中的任务", "乙：待办的任务"], "default: work in progress first, closed work filtered out");

  // Sort by priority: written to the address, scoped to the loaded pages, and kept across open → Back → reload.
  await page.getByLabel("任务排序").selectOption("priority");
  await rail.getByText(/按优先级排序只作用于已载入的 3 项/).waitFor();
  assert.deepEqual(await railTitles(), ["乙：待办的任务", "甲：进行中的任务"]);
  assert.match(page.url(), /\/work\?.*sort=priority/);
  await rail.getByRole("link", { name: /甲：进行中的任务/ }).click();
  await page.getByRole("heading", { level: 1, name: "甲：进行中的任务" }).waitFor({ timeout: 8000 }).catch(async () =>
    assert.fail(`task did not open: url=${page.url()} main=${(await page.getByRole("main").innerText()).slice(0, 300)} detail=${await page.locator("main pre").first().textContent().catch(() => "")} errors=${errors.join(" | ")}`));
  assert.match(page.url(), new RegExp(`/tasks/${taskA}\\?sort=priority$`));
  await page.getByLabel("任务排序").waitFor({ timeout: 5000 }).catch(async () =>
    assert.fail(`rail missing on the task: body=${(await page.locator("body").innerText()).slice(0, 700)} pre=${await page.locator("pre").allTextContents()} errors=${errors.join(" | ")}`));
  assert.equal(await page.getByLabel("任务排序").inputValue(), "priority");
  assert.equal(await rail.locator('[aria-current="page"]').innerText().then(text => text.split("\n")[0]), "甲：进行中的任务");
  // Center reading order: goal → completion conditions → body → progress and discussion.
  const headings = await page.getByRole("main").getByRole("heading", { level: 2 }).allInnerTexts();
  assert.deepEqual(headings.filter(text => ["目标", "完成条件", "正文", "进展与讨论"].includes(text)), ["目标", "完成条件", "正文", "进展与讨论"]);
  await page.goBack();
  await page.getByRole("heading", { level: 1, name: "任务" }).waitFor();
  assert.equal(await page.getByLabel("任务排序").inputValue(), "priority");
  assert.deepEqual(await railTitles(), ["乙：待办的任务", "甲：进行中的任务"]);
  await page.reload();
  await login();
  await rail.getByRole("link").first().waitFor();
  assert.equal(await page.getByLabel("任务排序").inputValue(), "priority", "a reload keeps the sort");
  await page.getByLabel("任务状态筛选").selectOption("all");
  assert.match(page.url(), /state=all/);
  assert.deepEqual(await railTitles(), ["乙：待办的任务", "甲：进行中的任务", "丙：已完成的任务"], "tasks without a priority go last");

  // Related documents open as tabs in the right column; the task stays in the center.
  await rail.getByRole("link", { name: /甲：进行中的任务/ }).click();
  await page.getByRole("heading", { level: 1, name: "甲：进行中的任务" }).waitFor();
  const panel = page.getByRole("complementary", { name: "右栏" });
  const facts = panel.locator(`[data-task-facts="${taskA}"]`);
  await facts.getByRole("button", { name: /需求总图：本轮切片/ }).click();
  await panel.getByRole("tab", { name: "需求总图：本轮切片" }).waitFor();
  await panel.getByText("总图正文：先做列表，再做右栏。").waitFor();
  assert.equal(await panel.getByRole("link", { name: "在中间打开" }).getAttribute("href"), `/p/${projectId}/documents/${docMap}`);
  assert.match(page.url(), new RegExp(`/tasks/${taskA}`), "opening a document does not leave the task");
  await panel.getByRole("tab", { name: "信息" }).click();
  await facts.getByRole("button", { name: /对账规则.*任务固定旧版 · 文档已有新版/ }).click();
  await panel.getByText("旧版规则正文。").waitFor();
  await panel.getByText(/文档已有新版；任务仍按这一版/).waitFor();
  assert.equal(await page.getByRole("heading", { level: 1, name: "甲：进行中的任务" }).isVisible(), true);

  // Bind an agent from the right column; the three facts are read back from the saved assignment.
  await panel.getByRole("tab", { name: "信息" }).click();
  const agent = facts.locator("[data-task-agent]");
  assert.match(await agent.innerText(), /已分派\s*未分派[\s\S]*已接受\s*未接受[\s\S]*正在运行\s*没有运行/);
  await agent.getByRole("button", { name: "绑定智能体" }).click();
  await agent.getByLabel("承接的智能体").selectOption(`owned:${sessionId}`);
  await agent.getByLabel("分派依据").fill("按职责安排开发智能体承接");
  await agent.getByRole("button", { name: "保存绑定" }).click();
  await agent.getByRole("button", { name: "保存绑定" }).waitFor({ state: "detached" });
  await agent.getByText("开发智能体", { exact: true }).waitFor();
  assert.match(await agent.innerText(), /已分派\s*已分派[\s\S]*已接受\s*待接受/, await agent.innerText());
  assert.equal(commands.length, 1);
  assert.deepEqual({ type: commands[0]!.type, taskId: commands[0]!.taskId, target: commands[0]!.target, reason: commands[0]!.reason },
    { type: "task.assignment.set", taskId: taskA, target: { kind: "owned", sessionId }, reason: "按职责安排开发智能体承接" });
  assert.equal(await agent.getByRole("link", { name: "进入对话" }).getAttribute("href"), `/p/${projectId}/sessions?session=${encodeURIComponent(`owned:${sessionId}`)}`);

  // Narrow: the facts open as a drawer from the page; the page never scrolls sideways.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("main").getByRole("button", { name: "任务信息" }).click();
  await page.getByRole("dialog").locator(`[data-task-facts="${taskA}"]`).getByText("开发智能体").waitFor();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= 390));
  assert.deepEqual(errors, []);
});
