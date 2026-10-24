// Opt-in browser regression: build the workbench, then run this file with node --test.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, extname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const playwrightModule = process.env.EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE;
const dist = resolve(import.meta.dirname, "../dist");
const projectId = "00000000-0000-4000-8000-000000000001";
const goalId = "00000000-0000-4000-8000-000000000002";
const stageId = "00000000-0000-4000-8000-000000000003";
const taskId = "00000000-0000-4000-8000-000000000004";
const createdAt = "2026-10-25T00:00:00.000Z";
const goal = { projectId, id: goalId, version: 1, outcome: "完成验收", constraints: "保留证据", consumer: "用户", authority: "已授权", scope: "本地", owner: "owner", actorId: "owner", createdAt };
const stage = (current) => ({ projectId, id: stageId, goalId, version: current ? 3 : 2, deliverable: "阶段甲", learningQuestion: "能否验收", state: current ? "reviewed" : "active", actorId: "owner", createdAt });
const task = (current) => ({ projectId, id: taskId, version: current ? 3 : 2, currentRevisionId: taskId, title: "任务甲", content: "正文", contentDocumentId: taskId, contentRevisionId: taskId, kind: "validation", acceptance: "完成", owner: "owner", state: current ? "done" : "in_progress" });
const page = (items) => ({ items, nextCursor: null });

test("Journey reads current Stage and Task together after a cached return, retaining drafts on slow and failed reads", { skip: !playwrightModule && "Set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE after building the workbench" }, async (t) => {
  const { chromium } = (await import(pathToFileURL(playwrightModule).href)).default;
  let current = false, delayed = false, failTasks = false;
  let releaseRead;
  let readStarted;
  const started = new Promise(resolve => { readStarted = resolve; });
  const methods = [];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname === "/__fixture/advance" && req.method === "POST") { current = true; res.end("ok"); return; }
    if (url.pathname.startsWith("/api/")) {
      methods.push(req.method);
      if (delayed && url.pathname.endsWith("/tasks")) await new Promise(resolve => { releaseRead = resolve; readStarted(); });
      const prefix = `/api/projects/${projectId}`;
      let value, status = 200;
      if (url.pathname === "/api/session") value = { principal: { actorId: "owner", projectIds: [projectId], permissions: ["read", "write", "review"] }, capabilities: {} };
      else if (url.pathname === prefix) value = { id: projectId, title: "夹具项目", createdAt };
      else if (url.pathname === `${prefix}/goals`) value = page([goal]);
      else if (url.pathname === `${prefix}/stages`) value = [stage(current)];
      else if (url.pathname === `${prefix}/documents`) value = page([]);
      else if (url.pathname === `${prefix}/tasks`) value = failTasks ? { message: "任务关联读取失败" } : page([task(current)]);
      else if (url.pathname === `${prefix}/tasks/${taskId}`) value = {
        task: task(current), revision: { ...task(current), projectId, taskId, id: taskId, basisSetId: null, actorId: "owner", reason: "夹具", createdAt },
        basis: null, links: [], impacts: [], decisions: [], proposal: { stageId }, judgements: [], deliveries: [], observations: [], closures: [],
      };
      else if (url.pathname === `${prefix}/stages/${stageId}/reviews`) value = current ? [{ projectId, id: "review-1", stageId, stageVersion: 3, supersedesReviewId: null, adopted: "完成", rejected: "", gap: "", nextChoice: "stop", evidence: "验收", reason: "结束", actorId: "owner", createdAt }] : [];
      else { status = 404; value = { message: "夹具未提供此读取" }; }
      if (failTasks && url.pathname === `${prefix}/tasks`) status = 503;
      res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); return;
    }
    const file = join(dist, url.pathname === "/" ? "index.html" : url.pathname);
    if (!file.startsWith(dist + "/")) { res.writeHead(404); res.end(); return; }
    try {
      const body = await readFile(file);
      res.writeHead(200, { "content-type": ({ ".html": "text/html", ".js": "text/javascript", ".css": "text/css" })[extname(file)] ?? "application/octet-stream" }); res.end(body);
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1200, height: 800 } });
  await context.addInitScript(({ projectId, taskId, createdAt }) => {
    sessionStorage.setItem("evoloop.unconfirmed-operations.v1", JSON.stringify([{ actorId: "owner", projectId, taskId, operationId: "unknown-1", commandType: "task.reviewBasis", createdAt }]));
  }, { projectId, taskId, createdAt });
  const browserPage = await context.newPage();
  await browserPage.goto(`${base}/#/p/${projectId}/journey`);
  await browserPage.getByLabel("访问令牌").fill("fixture-token");
  await browserPage.getByRole("button", { name: "进入", exact: true }).click();
  const board = browserPage.locator(".journey-board");
  await board.getByText("active · 1 项任务").waitFor();
  await board.getByText("in_progress").waitFor();
  assert.match(await browserPage.locator(".global-alert").first().innerText(), /结果尚未确认/);
  await board.getByText("建立一个目标").click();
  await board.locator("summary", { hasText: "保存目标" }).click();
  await board.locator('textarea[name="outcome"]').last().fill("未提交草稿");
  await browserPage.evaluate((p) => { location.hash = `#/p/${p}/tasks/00000000-0000-4000-8000-000000000004`; }, projectId);
  await browserPage.waitForURL(/\/tasks\//);
  await browserPage.getByRole("heading", { name: "任务甲" }).waitFor();
  await fetch(`${base}/__fixture/advance`, { method: "POST" });
  await browserPage.evaluate((p) => { location.hash = `#/p/${p}/journey`; }, projectId);
  await board.getByText("active · 1 项任务").waitFor();
  assert.equal(await board.locator('textarea[name="outcome"]').last().inputValue(), "未提交草稿");

  delayed = true;
  await board.getByRole("button", { name: "回读当前状态" }).click();
  await board.getByRole("button", { name: "回读中…" }).waitFor();
  assert.equal(await board.getByRole("button", { name: "回读中…" }).isDisabled(), true);
  assert.match(await board.innerText(), /旧读取和草稿保留/);
  assert.match(await board.innerText(), /active · 1 项任务/);
  await started;
  delayed = false; releaseRead();
  await board.getByText("reviewed · 1 项任务").waitFor();
  await board.getByText("done").waitFor();
  assert.equal(await board.locator('textarea[name="outcome"]').last().inputValue(), "未提交草稿");
  assert.match(await browserPage.locator(".global-alert").first().innerText(), /结果尚未确认/);

  failTasks = true;
  await board.getByRole("button", { name: "回读当前状态" }).click();
  await board.getByText(/回读失败：任务关联读取失败/).waitFor();
  assert.match(await board.innerText(), /下方是上次读取，不能据此判断当前进度/);
  assert.match(await board.innerText(), /reviewed · 1 项任务/);
  assert.equal(await board.locator('textarea[name="outcome"]').last().inputValue(), "未提交草稿");
  assert.deepEqual([...new Set(methods)], ["GET"]);
  await browserPage.setViewportSize({ width: 390, height: 844 });
  assert.equal(await board.getByRole("button", { name: "回读当前状态" }).isVisible(), true);
  assert.equal(await board.locator('textarea[name="outcome"]').last().inputValue(), "未提交草稿");
});
