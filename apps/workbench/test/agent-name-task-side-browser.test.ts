// Opt-in built-app regression for one agent's name on both sides (N3, docs/frontend/principles.md 原始标识放在来源层): an
// external agent whose name is the service's generated title (“<职责> · 外部 a6dfc426”, saved back as its registered
// name) is “<职责> · 外部接入的智能体” in the task's header, the task table's 承接者 column, the phone's compact list,
// the right column and the agent's own page, and its short identifier is never in the text (only under 完整标识).
import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const modulePath = process.env.EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE;
const dist = resolve(import.meta.dirname, "../dist");
const id = (n: number) => `36000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const projectId = id(1), roleId = id(2), taskId = id(10), revisionId = id(11), docId = id(20), docRevision = id(21);
// The external connection's identifier: the service writes its first eight characters into the generated title.
const linkId = "a6dfc426-1111-4222-8333-444455556666";
const agentKey = `external:${linkId}`;
const generatedTitle = "【合成示例】功能开发 · 外部 a6dfc426";
const shownName = "【合成示例】功能开发 · 外部接入的智能体";
const taskTitle = "【合成示例】进行中：右栏信息核对";
const stamp = "2026-11-10T00:00:00.000Z";
const metadata = { generatedAt: stamp, sourceObservedAt: stamp, partial: false, limitations: [] };

const task = { projectId, id: taskId, version: 3, currentRevisionId: revisionId, title: taskTitle, content: "# 目标\n核对右栏。", contentDocumentId: docId,
  contentRevisionId: docRevision, kind: "implementation", acceptance: "1. 右栏信息一致。", owner: roleId, state: "in_progress" };
const assignment = { state: "assigned", targetKind: "external", targetId: linkId, recipientActorId: null, taskRevisionId: revisionId };
const projection = {
  kind: "task", taskId, version: 3, currentRevisionId: revisionId, workChangeSequence: 4, title: taskTitle, taskKind: "implementation",
  taskState: "in_progress", phase: "awaiting_assignment", nextAction: "", responsible: { kind: "session", id: linkId, label: generatedTitle }, assignment,
  latestRun: null, delivery: null, pendingImpactCount: 0, queueHold: null, goal: null, stage: null, plan: null, dependencies: [], dependencyVersion: 0,
  review: null, dates: { createdAt: stamp, businessChangedAt: stamp, startedAt: stamp, completedAt: null, observedAt: stamp }, latestProgress: null,
  actionKey: `task:${taskId}`,
};
const session = {
  key: agentKey, target: { kind: "external", linkId }, aliases: [], title: generatedTitle, identity: null, kind: "external",
  // The generated title saved back as the registered name (设置展示信息 before #229): still not a name of its own.
  profile: { projectId, target: { kind: "external", linkId }, version: 1, displayName: generatedTitle, purpose: null, membership: "current", tenure: "unknown",
    actorId: "lead", reason: "归入当前团队", updatedAt: stamp },
  roles: [{ id: roleId, title: "【合成示例】功能开发", state: "active", roleClass: "business", templateKey: null, responsibility: "开发" }],
  membership: "current", membershipReason: "verified", runtimeState: "unknown", busy: false, currentTask: null, latestBusinessRun: null, lastProgressAt: null,
  capabilities: { observe: { available: false, reason: "external" }, send: { available: true, reason: null, mode: "handoff" },
    open: { available: false, reason: "external", ref: null }, interrupt: { available: false, reason: "external" }, close: { available: false, reason: "external" } },
  source: { kind: "external", id: linkId, revision: null, evidence: "project-record", href: "" }, metadata: { ...metadata, sourceObservedAt: stamp },
};
const resources = Object.fromEntries(["configuredModel", "actualModel", "inputTokens", "outputTokens", "cost", "processMemory"]
  .map(key => [key, { value: null, unit: "", source: null, scope: "session", observedAt: null, interval: null, unavailableReason: "fixture" }]));

test("an external agent is named the same on the task side and the agent side, without its short identifier", {
  skip: !modulePath && "Set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE after building the workbench", timeout: 180_000,
}, async t => {
  const { chromium } = (await import(pathToFileURL(modulePath!).href)).default;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, "http://127.0.0.1");
    if (url.pathname.startsWith("/api/")) {
      const root = `/api/projects/${projectId}`;
      const path = decodeURIComponent(url.pathname);
      let value: unknown = { items: [], nextCursor: null, metadata }, status = 200;
      if (path === "/api/session") value = { principal: { actorId: "lead", projectIds: [projectId], permissions: ["read", "write", "review"] }, capabilities: {} };
      else if (path === "/api/projects") value = [{ id: projectId, title: "名称夹具", createdAt: stamp }];
      else if (path === root) value = { id: projectId, title: "名称夹具", createdAt: stamp };
      else if (path === `${root}/tasks`) value = { items: [task], nextCursor: null };
      else if (path === `${root}/orchestration/work-status`) value = { items: [{ taskId, cognition: false, hasClosure: false, readyForAcceptance: false }] };
      else if (path.startsWith(`${root}/orchestration/`)) { status = 404; value = { message: "Not Found" }; }
      else if (path === `${root}/work-management/index`) value = { items: [projection], nextCursor: null, total: 1, counts: { awaiting_assignment: 1 },
        changeSequence: 4, observedAt: stamp, partial: false };
      else if (path === `${root}/work-management/tasks/${taskId}`) value = projection;
      else if (path === `${root}/tasks/${taskId}/assignment`) value = { projectId, taskId, version: 1, taskRevisionId: revisionId, target: { kind: "external", linkId },
        recipientActorId: null, state: "assigned", ack: null, actorId: "lead", reason: "按职责安排", updatedAt: stamp };
      else if (path.startsWith(`${root}/tasks/${taskId}/`)) value = path.endsWith("/revisions") ? [] : { items: [], nextCursor: null };
      else if (path === `${root}/tasks/${taskId}`) value = { task, revision: { ...task, taskId, id: revisionId, actorId: "lead", reason: "夹具修订", createdAt: stamp, basisSetId: null },
        basis: null, links: [], impacts: [], decisions: [], deliveries: [], observations: [], closures: [] };
      else if (path.startsWith(`${root}/documents/`)) { status = 404; value = { message: "无此文档" }; }
      else if (path === `${root}/session-work`) value = { items: [session], nextCursor: null, observationCursor: "0", metadata,
        totals: { current: 1, historical: 0, unclassified: 0 }, attention: { unansweredQuestions: 0, pendingMessages: 0, pendingAcceptance: 0, unclassifiedSessions: 0 } };
      else if (path === `${root}/session-work/${agentKey}`) value = { session, observationCursor: "0", currentWork: null,
        assignments: [], roleTasks: [], queue: [], results: [], questions: [], activity: [], resources, metadata };
      else if (path === `${root}/session-work/${agentKey}/profile`) value = session.profile;
      else if (path === `${root}/runtime/sessions` || path.startsWith(`${root}/runtime/runs`) || path === `${root}/resident-queues`
        || path.startsWith(`${root}/references/tasks/`)) value = [];
      else if (path === `${root}/runtime`) value = { available: true };
      else if (path === `${root}/roles/${roleId}`) value = { projectId, id: roleId, version: 1, currentRevisionId: roleId, state: "active",
        proposal: { title: "【合成示例】功能开发" }, proposedBy: "lead", createdAtUtc: stamp, trialStartedAtUtc: stamp, reviewAtUtc: stamp, mergeTargetRoleId: null };
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
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(`${base}${path}`);
    await page.getByLabel("访问令牌").fill("fixture-token");
    await page.getByRole("button", { name: "进入", exact: true }).click();
    return page;
  };
  // The short identifier, the identifier itself and the generated title are never in the text on screen.
  const noShortId = (text: string, where: string) => {
    assert.doesNotMatch(text, /a6dfc426/, `${where}: no short identifier`);
    assert.doesNotMatch(text, /外部 [0-9a-f]{8}/, `${where}: not the generated title`);
  };

  // The task's header and its right column, at 1440.
  const taskPage = await open(`/p/${projectId}/tasks/${taskId}`, 1440);
  const header = taskPage.locator(`[data-task-page="${taskId}"] [data-task-header]`);
  await header.getByText(shownName, { exact: true }).waitFor({ timeout: 10000 });
  const facts = taskPage.getByRole("complementary", { name: "右栏" }).locator(`[data-task-facts="${taskId}"]`);
  await facts.locator("[data-task-agent]").getByText(shownName, { exact: true }).waitFor({ timeout: 10000 });
  await facts.getByText(shownName, { exact: true }).first().waitFor();
  assert.ok(await facts.getByText(shownName, { exact: true }).count() >= 2, "下一步 and 承接智能体 say the same name");
  noShortId(await taskPage.locator("body").innerText(), "task page");
  await taskPage.close();

  // The task table's 承接者 column at 1440, and the phone's compact list at 390.
  const table = await open(`/p/${projectId}/work`, 1440);
  const ownerCell = table.locator(`[data-task-row="${taskId}"] [data-owner-cell]`);
  await ownerCell.getByRole("link", { name: shownName, exact: true }).waitFor({ timeout: 10000 });
  noShortId(await table.locator("body").innerText(), "task table");
  await table.close();
  const phone = await open(`/p/${projectId}/work`, 390);
  const row = phone.locator(`[data-task-row="${taskId}"]`);
  await row.getByRole("link", { name: shownName, exact: true }).waitFor({ timeout: 10000 });
  assert.match(await row.innerText(), new RegExp(`承接 · ${shownName}`));
  noShortId(await phone.locator("body").innerText(), "compact list");
  await phone.close();

  // The agent's own page says the same name.
  const agent = await open(`/p/${projectId}/sessions?session=${encodeURIComponent(agentKey)}`, 1440);
  await agent.getByRole("heading", { name: shownName }).first().waitFor({ timeout: 10000 });
  noShortId(await agent.locator("main").innerText(), "agent page");
  await agent.close();
  assert.deepEqual(errors, []);
});
