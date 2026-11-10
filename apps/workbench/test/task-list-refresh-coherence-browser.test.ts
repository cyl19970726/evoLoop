// Opt-in built-app regression for returning to Task work and for a started Run whose assignment receipt is absent.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Task } from "@evoloop/contracts";
import type { LeaderWorkTask } from "@evoloop/contracts/work-index";

const modulePath = process.env.EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE;
const dist = resolve(import.meta.dirname, "../dist");
const projectId = "33000001-0000-4000-8000-000000000001";
const roleId = "33000002-0000-4000-8000-000000000002";
const sessionId = "33000003-0000-4000-8000-000000000003";
const firstId = "33000010-0000-4000-8000-000000000010";
const secondId = "33000011-0000-4000-8000-000000000011";
const stamp = "2026-11-10T12:00:00.000Z";

const task = (id: string, title: string, state: Task["state"] = "in_progress"): Task => ({
  projectId, id, version: 1, currentRevisionId: id, title, content: `# 目标\n${title}`,
  contentDocumentId: id, contentRevisionId: id, kind: "implementation", acceptance: "核对", owner: roleId, state,
});

const timing = (id: string, stage: "running" | "unassigned") => ({
  createdAt: stamp, publication: { at: null, source: "unknown" as const },
  current: { stage, startedAt: stamp, endedAt: null, elapsedMs: stage === "running" ? 480000 : null, source: null,
    waitingFor: stage === "running" ? { kind: "session" as const, id: sessionId } : { kind: "role" as const, id: roleId } },
  rounds: [{ number: 1, startedAt: stamp, endedAt: null, elapsedMs: stage === "running" ? 480000 : null,
    intervals: [{ stage, startedAt: stamp, endedAt: null, source: null,
      waitingFor: stage === "running" ? { kind: "session" as const, id: sessionId } : { kind: "role" as const, id: roleId } }] }],
  latestEffectiveProgress: null, executionActivity: null, observedAt: stamp,
});

const projection = (item: Task, latestRun: LeaderWorkTask["latestRun"], phase: "running" | "unassigned"): LeaderWorkTask => ({
  kind: "task", taskId: item.id, version: item.version, currentRevisionId: item.currentRevisionId,
  workChangeSequence: 4, title: item.title, taskKind: item.kind, taskState: item.state, phase,
  nextAction: phase === "running" ? "继续当前工作" : "等待分派",
  responsible: phase === "running" ? { kind: "session", id: sessionId, label: "承接智能体" } : { kind: "role", id: roleId, label: "负责职责" },
  assignment: phase === "running" ? { state: "assigned", targetKind: "owned", targetId: sessionId, recipientActorId: "agent" } : null,
  latestRun, delivery: null, pendingImpactCount: 0, queueHold: null, goal: null, stage: null, plan: null,
  dependencies: [], dependencyVersion: 0, review: null,
  dates: { createdAt: stamp, businessChangedAt: stamp, startedAt: stamp, completedAt: null, observedAt: stamp },
  latestProgress: phase === "running" ? { sequence: 4, entityKind: "run", entityId: latestRun?.runId ?? "run", eventName: "运行状态已更新", changedAt: stamp } : null,
  timing: timing(item.id, phase), actionKey: `task:${item.id}:v1:${phase}:4`,
});

test("returning to Task work reflects newer work changes, and a started Run without receipt reads coherently", {
  skip: !modulePath && "Set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE",
}, async t => {
  const { chromium } = (await import(pathToFileURL(modulePath!).href)).default;
  let changeSequence = 4;
  let tasks = [task(firstId, "已开始但回执未到")];
  let changesReads = 0;
  const appendTask = () => {
    tasks = [tasks[0]!, task(secondId, "回到任务页后出现", "todo")];
    changeSequence = 5;
  };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, "http://127.0.0.1");
    if (url.pathname === "/__fixture/append") { appendTask(); res.end("ok"); return; }
    if (url.pathname.startsWith("/api/")) {
      const root = `/api/projects/${projectId}`;
      const path = decodeURIComponent(url.pathname);
      let value: unknown = { items: [], nextCursor: null }, status = 200;
      if (path === "/api/session") value = {
        principal: { actorId: "reader", projectIds: [projectId], permissions: ["read", "write", "review"] }, capabilities: {},
      };
      else if (path === root) value = { id: projectId, title: "任务刷新夹具", createdAt: stamp };
      else if (path === `${root}/tasks`) value = { items: tasks, nextCursor: null };
      else if (path === `${root}/orchestration/work-status`) value = { items: tasks.map(item => ({
        taskId: item.id, cognition: false, hasClosure: false, readyForAcceptance: false,
        runId: item.id === firstId ? "run-started" : null, runState: item.id === firstId ? "running" : null,
      })) };
      else if (path === `${root}/work-management/index`) {
        const items = tasks.map(item => projection(item, item.id === firstId ? { runId: "run-started", state: "running" } : null,
          item.id === firstId ? "running" : "unassigned"));
        value = { items, nextCursor: null, total: items.length,
          counts: { running: 1, unassigned: tasks.length - 1 }, changeSequence,
          observedAt: stamp, partial: false };
      }
      else if (path === `${root}/work-management/changes`) {
        changesReads++;
        value = { items: [], nextCursor: null, changeSequence, observedAt: stamp };
      }
      else if (path.startsWith(`${root}/work-management/tasks/`)) {
        const id = path.slice(`${root}/work-management/tasks/`.length);
        const item = tasks.find(candidate => candidate.id === id);
        value = item ? projection(item, item.id === firstId ? { runId: "run-started", state: "running" } : null,
          item.id === firstId ? "running" : "unassigned") : null;
      }
      else if (path === `${root}/task-attention/items`) value = { items: [], nextCursor: null };
      else if (path === `${root}/roles/${roleId}`) value = { projectId, id: roleId, proposal: { title: "功能开发" } };
      else if (path === `${root}/session-work/owned:${sessionId}`) value = { session: {
        key: `owned:${sessionId}`, target: { kind: "owned", sessionId }, aliases: [],
        title: "功能开发 · Codex 1", profile: { displayName: "功能开发 · Codex 1" },
        roles: [{ id: roleId, title: "功能开发" }], kind: "owned",
      } };
      else if (path.startsWith(`${root}/tasks/`)) {
        const [id, sub] = path.slice(`${root}/tasks/`.length).split("/");
        const item = tasks.find(candidate => candidate.id === id);
        if (!item) { status = 404; value = { message: "无此任务" }; }
        else if (sub === "timing") value = timing(item.id, item.id === firstId ? "running" : "unassigned");
        else if (sub === "assignment") value = {
          projectId, taskId: item.id, version: 1, taskRevisionId: item.currentRevisionId,
          target: { kind: "owned", sessionId }, recipientActorId: "agent", state: "assigned", ack: null,
          actorId: "leader", reason: "分派执行", updatedAt: stamp,
        };
        else if (sub) value = [];
        else value = { task: item, revision: { ...item, taskId: item.id, id: item.currentRevisionId,
          actorId: "leader", reason: "夹具", createdAt: stamp, basisSetId: null }, basis: null, links: [],
          impacts: [], decisions: [], deliveries: [], observations: [], closures: [] };
      }
      else if (path.startsWith(`${root}/references/tasks/`)) value = [];
      else if (path === `${root}/session-work`) value = { items: [], nextCursor: null };
      res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); return;
    }
    try {
      const file = /^\/(?:$|p\/|ui$)/.test(url.pathname) ? "index.html" : url.pathname;
      res.writeHead(200, { "content-type": ({
        ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
      } as Record<string, string>)[extname(file)] ?? "application/octet-stream" });
      res.end(await readFile(join(dist, file)));
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const browser = await chromium.launch({ headless: true, ...(process.env.EVOLOOP_BROWSER_TEST_EXECUTABLE_PATH
    ? { executablePath: process.env.EVOLOOP_BROWSER_TEST_EXECUTABLE_PATH } : {}) });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const pageErrors: string[] = [];
  page.on("pageerror", error => pageErrors.push(error.stack ?? error.message));
  await page.goto(`${base}/p/${projectId}/work`);
  await page.getByLabel("访问令牌").fill("fixture-token");
  await page.getByRole("button", { name: "进入", exact: true }).click();

  const main = page.getByRole("main");
  const firstRow = main.getByRole("row").filter({ hasText: "已开始但回执未到" });
  await firstRow.waitFor();
  const firstRowText = await firstRow.innerText();
  assert.match(firstRowText, /运行中/);

  await fetch(`${base}/__fixture/append`);
  const spaces = page.getByRole("navigation", { name: "空间" });
  await spaces.getByRole("link", { name: "智能体", exact: true }).click();
  await page.waitForURL(new RegExp(`/p/${projectId}/sessions`), { waitUntil: "commit", timeout: 5000 })
    .catch(() => assert.fail(`did not leave Task work: ${page.url()}`));
  await spaces.getByRole("link", { name: "工作", exact: true }).click();
  await page.waitForURL(new RegExp(`/p/${projectId}/work(?:\\?|$)`), { waitUntil: "commit", timeout: 5000 })
    .catch(() => assert.fail(`did not return to Task work: ${page.url()}`));

  const newRow = main.getByRole("row").filter({ hasText: "回到任务页后出现" });
  await newRow.waitFor({ timeout: 5000 }).catch(() => undefined);
  const refreshed = await newRow.count() > 0;
  const counts = await main.getByLabel("对账阶段计数").innerText();
  const owner = await firstRow.locator("[data-owner-cell]").innerText();
  assert.equal(changesReads > 0, true, "returning to the page checks the work change stream");
  assert.equal(refreshed, true, `new Task appeared: changesReads=${changesReads} counts=${counts}`);
  assert.match(counts, /未分派\s*·?\s*1/);
  assert.match(owner, /已开始执行，接手回执未到/);
  assert.doesNotMatch(owner, /仍待接受/);
  if (process.env.EVOLOOP_TASK_LIST_REFRESH_SCREENSHOT)
    await page.screenshot({ path: process.env.EVOLOOP_TASK_LIST_REFRESH_SCREENSHOT, fullPage: false });
  assert.deepEqual(pageErrors, []);
});
