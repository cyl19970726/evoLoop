// Opt-in built-app regression. All IDs and API responses below are synthetic fixture data.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const modulePath = process.env.EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE;
const dist = resolve(import.meta.dirname, "../dist");
const projectId = "97000001-0000-4000-8000-000000000001";
const taskId = "97000002-0000-4000-8000-000000000002";
const revisionId = "97000003-0000-4000-8000-000000000003";
const developerRoleId = "97000004-0000-4000-8000-000000000004";
const developerSessionId = "97000005-0000-4000-8000-000000000005";
const qaSessionId = "97000006-0000-4000-8000-000000000006";
const stamp = "2026-11-05T00:00:00.000Z";
const title = "合成夹具 · 核对验收责任";
const nextAction = "由 QA 核对当前交付并记录验收结论";
const task = { projectId, id: taskId, version: 2, currentRevisionId: revisionId,
  title, content: "合成夹具正文", contentDocumentId: taskId, contentRevisionId: revisionId,
  kind: "implementation", acceptance: "QA 核对交付", owner: developerRoleId,
  state: "in_progress", createdAt: stamp };
const timing = { createdAt: stamp, publication: { at: stamp, source: "task" },
  current: { stage: "awaiting_acceptance", startedAt: stamp, endedAt: null, elapsedMs: null,
    source: null, waitingFor: { kind: "consumer", id: qaSessionId } },
  rounds: [], latestEffectiveProgress: null, executionActivity: null, observedAt: stamp };
const projection = { kind: "task", taskId, version: 2, currentRevisionId: revisionId,
  workChangeSequence: 7, title, taskKind: "implementation", taskState: "in_progress",
  phase: "awaiting_acceptance", nextAction,
  responsible: { kind: "session", id: qaSessionId, label: "QA Session · 当前验收负责人" },
  // This accepted assignment is retained as history; it is not the current QA responsibility.
  assignment: { state: "accepted", targetKind: "owned", targetId: developerSessionId,
    recipientActorId: "developer" },
  latestRun: null, delivery: null, pendingImpactCount: 0, queueHold: null,
  goal: null, stage: null, plan: null, dependencies: [], dependencyVersion: 0, review: null,
  dates: { createdAt: stamp, businessChangedAt: stamp, startedAt: stamp,
    completedAt: null, observedAt: stamp }, timing,
  actionKey: `task:${taskId}:v2:awaiting_acceptance:7` };

test("ordinary Task row, right preview and full detail use current QA responsibility", {
  skip: !modulePath && "Set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE after building the workbench",
}, async t => {
  const { chromium } = (await import(pathToFileURL(modulePath!).href)).default;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname.startsWith("/api/")) {
      // Fixture is read-only. A browser mutation cannot reach any production service.
      if (req.method !== "GET") { res.writeHead(405); res.end(); return; }
      const root = `/api/projects/${projectId}`;
      let value: unknown = { items: [], nextCursor: null };
      if (url.pathname === "/api/session") value = {
        principal: { actorId: "reader", projectIds: [projectId], permissions: ["read"] }, capabilities: {},
      };
      else if (url.pathname === root) value = { id: projectId, title: "合成夹具项目", createdAt: stamp };
      else if (url.pathname === `${root}/tasks`) value = { items: [task], nextCursor: null };
      else if (url.pathname === `${root}/tasks/${taskId}`) value = {
        task, revision: { ...task, id: revisionId, taskId, actorId: "fixture", reason: "synthetic", createdAt: stamp },
        basis: null, links: [], impacts: [], decisions: [], proposal: null, judgements: [],
        deliveries: [], observations: [], closures: [],
      };
      else if (url.pathname === `${root}/tasks/${taskId}/attention`) value = {
        followUp: null, followUpHistory: [], items: [], itemsNextCursor: null,
      };
      else if (url.pathname === `${root}/references/tasks/${taskId}`) value = [];
      else if (url.pathname === `${root}/impacts`) value = [];
      else if (url.pathname === `${root}/orchestration/work-status`) value = {
        items: [{ taskId, cognition: false, hasClosure: false, readyForAcceptance: false }],
      };
      else if (url.pathname === `${root}/work-management/index`) value = {
        items: [projection], nextCursor: null, total: 1, counts: { awaiting_acceptance: 1 },
        changeSequence: 7, observedAt: stamp, partial: false,
      };
      else if (url.pathname === `${root}/work-management/tasks/${taskId}`) value = projection;
      else if (url.pathname === `${root}/roles/${developerRoleId}`) value = {
        projectId, id: developerRoleId, proposal: { title: "功能开发职责" },
      };
      else if (decodeURIComponent(url.pathname) === `${root}/session-work/owned:${developerSessionId}`) value = {
        session: { key: `owned:${developerSessionId}`, title: "开发 Session",
          target: { kind: "owned", sessionId: developerSessionId },
          profile: { displayName: "功能开发" } },
      };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(value)); return;
    }
    const file = join(dist, /^\/(?:$|p\/|ui$)/.test(url.pathname) ? "index.html" : url.pathname);
    if (!file.startsWith(`${dist}/`)) { res.writeHead(404); res.end(); return; }
    try {
      const body = await readFile(file);
      res.writeHead(200, { "content-type": ({ ".html": "text/html", ".js": "text/javascript",
        ".css": "text/css" } as Record<string, string>)[extname(file)] ?? "application/octet-stream" });
      res.end(body);
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const browser = await chromium.launch({ headless: true,
    ...(process.env.EVOLOOP_BROWSER_TEST_EXECUTABLE_PATH
      ? { executablePath: process.env.EVOLOOP_BROWSER_TEST_EXECUTABLE_PATH } : {}) });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const pageErrors: string[] = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  await page.goto(`${base}/p/${projectId}/work`);
  await page.getByLabel("访问令牌").fill("fixture-token");
  await page.getByRole("button", { name: "进入", exact: true }).click();

  const row = page.locator(".work-status-section").getByRole("row").filter({ hasText: title });
  await row.getByRole("button", { name: title }).waitFor();
  await row.getByText("待验收").waitFor();
  await row.locator(".task-list-owner").getByText("功能开发").waitFor();
  assert.match(await row.locator(".task-list-owner").innerText(), /已接受/);
  await page.locator(".task-column-settings > summary").click();
  await page.getByLabel("下一动作", { exact: true }).check();
  assert.match(await row.locator(".task-list-next").innerText(), /QA 核对当前交付/);
  await page.locator(".task-column-settings > summary").click();

  await row.getByRole("button", { name: title }).click();
  const preview = page.getByRole("complementary", { name: "所选任务摘要" });
  await preview.getByText("QA Session · 当前验收负责人").waitFor();
  const previewNext = preview.getByRole("region", { name: "当前进展与下一责任" });
  assert.match(await previewNext.innerText(), /待验收[\s\S]*QA 核对当前交付[\s\S]*QA Session/);
  assert.doesNotMatch(await previewNext.innerText(), /功能开发|开发 Session/);
  const mainBox = await page.locator(".task-list-main").boundingBox();
  const previewBox = await preview.boundingBox();
  assert.ok(mainBox && previewBox && previewBox.x > mainBox.x, "preview is to the right of the list");
  assert.deepEqual(await page.evaluate(() => [innerWidth, innerHeight]), [1440, 900]);
  await page.screenshot({ path: "/private/tmp/evoloop-preview-after.png", fullPage: false });

  await preview.getByRole("link", { name: "查看完整任务" }).click();
  const detailNext = page.locator(".task-detail-result .task-result-facts");
  await detailNext.getByText("QA Session · 当前验收负责人").waitFor({ timeout: 5000 }).catch(async () => {
    assert.fail(`detail QA missing: url=${page.url()} detail=${await detailNext.innerText().catch(() => "absent")} body=${(await page.locator("body").innerText()).slice(0,1200)} errors=${pageErrors.join(" | ")}`);
  });
  assert.match(await detailNext.innerText(), /下一责任[\s\S]*QA 核对当前交付[\s\S]*QA Session/);
  assert.doesNotMatch(await detailNext.innerText(), /功能开发|开发 Session/);
  assert.equal(pageErrors.length, 0, pageErrors.join(" | "));
});
