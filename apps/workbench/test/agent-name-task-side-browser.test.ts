// Opt-in built-app regression for one agent's name on both sides (N3, docs/frontend/principles.md 原始标识放在来源层): an
// external agent whose name is the service's generated title (“<职责> · 外部 a6dfc426”, saved back as its registered
// name) is “<职责> · 外部接入的智能体” in the task's header, the task table's 承接者 column, the phone's compact list,
// the right column and the agent's own page, and its short identifier is never in the text (only under 完整标识).
// When two agents of the table have the same name, the table tells them apart by the short identifier as secondary
// text, as the agent directory does (agentNameCollisions), and only then.
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const modulePath = process.env.EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE;
const dist = resolve(import.meta.dirname, "../dist");
const id = (n: number) => `36000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const projectId = id(1), roleId = id(2), docId = id(20), docRevision = id(21);
const stamp = "2026-11-10T00:00:00.000Z";
const metadata = { generatedAt: stamp, sourceObservedAt: stamp, partial: false, limitations: [] };
const roleTitle = "【合成示例】功能开发";
const shownName = `${roleTitle} · 外部接入的智能体`;

// The external connections' identifiers: the service writes their first eight characters into the generated title.
const links = { first: "a6dfc426-1111-4222-8333-444455556666", second: "7f3e0c11-1111-4222-8333-444455556666" };
const generatedTitle = (linkId: string) => `${roleTitle} · 外部 ${linkId.slice(0, 8)}`;
const agentKey = (linkId: string) => `external:${linkId}`;

interface Fixture { taskId: string; revisionId: string; title: string; linkId: string }
const first: Fixture = { taskId: id(10), revisionId: id(11), title: "【合成示例】进行中：右栏信息核对", linkId: links.first };
const second: Fixture = { taskId: id(12), revisionId: id(13), title: "【合成示例】进行中：表格同名区分", linkId: links.second };

const task = (f: Fixture) => ({ projectId, id: f.taskId, version: 3, currentRevisionId: f.revisionId, title: f.title, content: "# 目标\n核对右栏。",
  contentDocumentId: docId, contentRevisionId: docRevision, kind: "implementation", acceptance: "1. 右栏信息一致。", owner: roleId, state: "in_progress" });
const projection = (f: Fixture) => ({
  kind: "task", taskId: f.taskId, version: 3, currentRevisionId: f.revisionId, workChangeSequence: 4, title: f.title, taskKind: "implementation",
  taskState: "in_progress", phase: "awaiting_assignment", nextAction: "", responsible: { kind: "session", id: f.linkId, label: generatedTitle(f.linkId) },
  assignment: { state: "assigned", targetKind: "external", targetId: f.linkId, recipientActorId: null, taskRevisionId: f.revisionId },
  latestRun: null, delivery: null, pendingImpactCount: 0, queueHold: null, goal: null, stage: null, plan: null, dependencies: [], dependencyVersion: 0,
  review: null, dates: { createdAt: stamp, businessChangedAt: stamp, startedAt: stamp, completedAt: null, observedAt: stamp }, latestProgress: null,
  actionKey: `task:${f.taskId}`,
});
const session = (linkId: string) => ({
  key: agentKey(linkId), target: { kind: "external", linkId }, aliases: [], title: generatedTitle(linkId), identity: null, kind: "external",
  // The generated title saved back as the registered name (设置展示信息 before #229): still not a name of its own.
  profile: { projectId, target: { kind: "external", linkId }, version: 1, displayName: generatedTitle(linkId), purpose: null, membership: "current",
    tenure: "unknown", actorId: "lead", reason: "归入当前团队", updatedAt: stamp },
  roles: [{ id: roleId, title: roleTitle, state: "active", roleClass: "business", templateKey: null, responsibility: "开发" }],
  membership: "current", membershipReason: "verified", runtimeState: "unknown", busy: false, currentTask: null, latestBusinessRun: null, lastProgressAt: null,
  capabilities: { observe: { available: false, reason: "external" }, send: { available: true, reason: null, mode: "handoff" },
    open: { available: false, reason: "external", ref: null }, interrupt: { available: false, reason: "external" }, close: { available: false, reason: "external" } },
  source: { kind: "external", id: linkId, revision: null, evidence: "project-record", href: "" }, metadata,
});
const resources = Object.fromEntries(["configuredModel", "actualModel", "inputTokens", "outputTokens", "cost", "processMemory"]
  .map(key => [key, { value: null, unit: "", source: null, scope: "session", observedAt: null, interval: null, unavailableReason: "fixture" }]));

/** Serves the built app with the given tasks, each bound to its own external agent of the same role. */
async function start(t: TestContext, fixtures: Fixture[]) {
  const { chromium } = (await import(pathToFileURL(modulePath!).href)).default;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, "http://127.0.0.1");
    if (url.pathname.startsWith("/api/")) {
      const root = `/api/projects/${projectId}`;
      const path = decodeURIComponent(url.pathname);
      let value: unknown = { items: [], nextCursor: null, metadata }, status = 200;
      const fixture = fixtures.find(f => path === `${root}/tasks/${f.taskId}` || path.startsWith(`${root}/tasks/${f.taskId}/`) || path === `${root}/work-management/tasks/${f.taskId}`);
      const agent = fixtures.find(f => path === `${root}/session-work/${agentKey(f.linkId)}` || path === `${root}/session-work/${agentKey(f.linkId)}/profile`);
      if (path === "/api/session") value = { principal: { actorId: "lead", projectIds: [projectId], permissions: ["read", "write", "review"] }, capabilities: {} };
      else if (path === "/api/projects") value = [{ id: projectId, title: "名称夹具", createdAt: stamp }];
      else if (path === root) value = { id: projectId, title: "名称夹具", createdAt: stamp };
      else if (path === `${root}/tasks`) value = { items: fixtures.map(task), nextCursor: null };
      else if (path === `${root}/orchestration/work-status`) value = { items: fixtures.map(f => ({ taskId: f.taskId, cognition: false, hasClosure: false, readyForAcceptance: false })) };
      else if (path.startsWith(`${root}/orchestration/`)) { status = 404; value = { message: "Not Found" }; }
      else if (path === `${root}/work-management/index`) value = { items: fixtures.map(projection), nextCursor: null, total: fixtures.length,
        counts: { awaiting_assignment: fixtures.length }, changeSequence: 4, observedAt: stamp, partial: false };
      else if (fixture && path === `${root}/work-management/tasks/${fixture.taskId}`) value = projection(fixture);
      else if (fixture && path === `${root}/tasks/${fixture.taskId}/assignment`) value = { projectId, taskId: fixture.taskId, version: 1, taskRevisionId: fixture.revisionId,
        target: { kind: "external", linkId: fixture.linkId }, recipientActorId: null, state: "assigned", ack: null, actorId: "lead", reason: "按职责安排", updatedAt: stamp };
      else if (fixture && path.startsWith(`${root}/tasks/${fixture.taskId}/`)) value = path.endsWith("/revisions") ? [] : { items: [], nextCursor: null };
      else if (fixture) value = { task: task(fixture), revision: { ...task(fixture), taskId: fixture.taskId, id: fixture.revisionId, actorId: "lead", reason: "夹具修订",
        createdAt: stamp, basisSetId: null }, basis: null, links: [], impacts: [], decisions: [], deliveries: [], observations: [], closures: [] };
      else if (path.startsWith(`${root}/documents/`)) { status = 404; value = { message: "无此文档" }; }
      else if (path === `${root}/session-work`) value = { items: fixtures.map(f => session(f.linkId)), nextCursor: null, observationCursor: "0", metadata,
        totals: { current: fixtures.length, historical: 0, unclassified: 0 }, attention: { unansweredQuestions: 0, pendingMessages: 0, pendingAcceptance: 0, unclassifiedSessions: 0 } };
      else if (agent && path.endsWith("/profile")) value = session(agent.linkId).profile;
      else if (agent) value = { session: session(agent.linkId), observationCursor: "0", currentWork: null,
        assignments: [], roleTasks: [], queue: [], results: [], questions: [], activity: [], resources, metadata };
      else if (path === `${root}/runtime/sessions` || path.startsWith(`${root}/runtime/runs`) || path === `${root}/resident-queues`
        || path.startsWith(`${root}/references/tasks/`)) value = [];
      else if (path === `${root}/runtime`) value = { available: true };
      else if (path === `${root}/roles/${roleId}`) value = { projectId, id: roleId, version: 1, currentRevisionId: roleId, state: "active",
        proposal: { title: roleTitle }, proposedBy: "lead", createdAtUtc: stamp, trialStartedAtUtc: stamp, reviewAtUtc: stamp, mergeTargetRoleId: null };
      else if (path === `${root}/roles/${roleId}/bindings`) value = [];
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
  const errors: string[] = [];
  const open = async (path: string, width: number) => {
    const page = await browser.newPage({ viewport: { width, height: width === 390 ? 844 : 900 }, locale: "zh-CN", timezoneId: "Asia/Shanghai" });
    page.on("pageerror", (error: Error) => errors.push(error.message));
    await page.goto(`${base}${path}`);
    await page.getByLabel("访问令牌").fill("fixture-token");
    await page.getByRole("button", { name: "进入", exact: true }).click();
    return page;
  };
  return { open, errors };
}

// The short identifier, the identifier itself and the generated title are never in the text on screen.
const noShortId = (text: string, where: string) => {
  assert.doesNotMatch(text, /a6dfc426|7f3e0c11/, `${where}: no short identifier`);
  assert.doesNotMatch(text, /外部 [0-9a-f]{8}/, `${where}: not the generated title`);
};
const skip = !modulePath && "Set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE after building the workbench";

test("an external agent is named the same on the task side and the agent side, without its short identifier", { skip, timeout: 180_000 }, async t => {
  const { open, errors } = await start(t, [first]);

  // The task's header and its right column, at 1440.
  const taskPage = await open(`/p/${projectId}/tasks/${first.taskId}`, 1440);
  const header = taskPage.locator(`[data-task-page="${first.taskId}"] [data-task-header]`);
  await header.getByText(shownName, { exact: true }).waitFor({ timeout: 10000 });
  const facts = taskPage.getByRole("complementary", { name: "右栏" }).locator(`[data-task-facts="${first.taskId}"]`);
  await facts.locator("[data-task-agent]").getByText(shownName, { exact: true }).waitFor({ timeout: 10000 });
  await facts.getByText(shownName, { exact: true }).first().waitFor();
  assert.ok(await facts.getByText(shownName, { exact: true }).count() >= 2, "下一步 and 承接智能体 say the same name");
  noShortId(await taskPage.locator("body").innerText(), "task page");
  await taskPage.close();

  // The task table's 承接者 column at 1440, and the phone's compact list at 390: one agent, no identifier.
  const table = await open(`/p/${projectId}/work`, 1440);
  const ownerCell = table.locator(`[data-task-row="${first.taskId}"] [data-owner-cell]`);
  await ownerCell.getByRole("link", { name: shownName, exact: true }).waitFor({ timeout: 10000 });
  noShortId(await table.locator("body").innerText(), "task table");
  await table.close();
  const phone = await open(`/p/${projectId}/work`, 390);
  const row = phone.locator(`[data-task-row="${first.taskId}"]`);
  await row.getByRole("link", { name: shownName, exact: true }).waitFor({ timeout: 10000 });
  assert.match(await row.innerText(), new RegExp(`承接 · ${shownName}`));
  noShortId(await phone.locator("body").innerText(), "compact list");
  await phone.close();

  // The agent's own page says the same name.
  const agent = await open(`/p/${projectId}/sessions?session=${encodeURIComponent(agentKey(first.linkId))}`, 1440);
  await agent.getByRole("heading", { name: shownName }).first().waitFor({ timeout: 10000 });
  noShortId(await agent.locator("main").innerText(), "agent page");
  await agent.close();
  assert.deepEqual(errors, []);
});

test("two agents of the task table with the same name are told apart by their short identifiers, as secondary text", { skip, timeout: 180_000 }, async t => {
  const { open, errors } = await start(t, [first, second]);

  // At 1440 each 承接者 cell keeps the shared name as its link and adds “标识 …” on the line below it.
  const table = await open(`/p/${projectId}/work`, 1440);
  for (const f of [first, second]) {
    const cell = table.locator(`[data-task-row="${f.taskId}"] [data-owner-cell]`);
    await cell.getByRole("link", { name: shownName, exact: true }).waitFor({ timeout: 10000 });
    await cell.getByText(new RegExp(`^标识 ${f.linkId.slice(0, 8)} · `)).waitFor();
    assert.doesNotMatch(await cell.getByRole("link").innerText(), /[0-9a-f]{8}/, "the name itself carries no identifier");
    assert.doesNotMatch(await cell.innerText(), new RegExp(f.linkId), "only the short form, never the whole identifier");
  }
  await table.close();

  // The phone's compact list says it after the name.
  const phone = await open(`/p/${projectId}/work`, 390);
  for (const f of [first, second]) {
    const row = phone.locator(`[data-task-row="${f.taskId}"]`);
    await row.getByRole("link", { name: shownName, exact: true }).waitFor({ timeout: 10000 });
    assert.match(await row.innerText(), new RegExp(`承接 · ${shownName} · 标识 ${f.linkId.slice(0, 8)} · `));
  }
  await phone.close();
  assert.deepEqual(errors, []);
});
