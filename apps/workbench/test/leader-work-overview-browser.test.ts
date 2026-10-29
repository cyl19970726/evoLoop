// Opt-in built-app regression: build workbench, then set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const modulePath = process.env.EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE;
const dist = resolve(import.meta.dirname, "../dist");
const projectId = "31000001-0000-4000-8000-000000000001";
const roleId = "31000002-0000-4000-8000-000000000002";
const taskId = "31000003-0000-4000-8000-000000000003";
const stamp = "2026-10-29T03:30:00.000Z";
const rawCognitionTitle = "Cognition: business result event 25deb2bf-f765-4258-b836-41b2d8502539";
const task = {
  projectId, id: taskId, version: 3, currentRevisionId: "31000004-0000-4000-8000-000000000004",
  title: rawCognitionTitle, content: "正文", contentDocumentId: taskId, contentRevisionId: taskId,
  kind: "research", acceptance: "确认", owner: roleId, state: "in_progress", createdAt: stamp,
};

test("Leader overview hides empty review counts and maps cognition history to readable Chinese labels",
  { skip: !modulePath && "Set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE" }, async t => {
    const { chromium } = (await import(pathToFileURL(modulePath!).href)).default;
    const server = createServer(async (req, res) => {
      const url = new URL(req.url, "http://127.0.0.1");
      if (url.pathname.startsWith("/api/")) {
        const root = `/api/projects/${projectId}`;
        let value: unknown = { items: [], nextCursor: null };
        if (url.pathname === "/api/session") value = {
          principal: { actorId: "reader", projectIds: [projectId], permissions: ["read"] }, capabilities: {},
        };
        else if (url.pathname === root) value = { id: projectId, title: "现场回归项目", createdAt: stamp };
        else if (url.pathname === `${root}/tasks`) value = { items: [task], nextCursor: null };
        else if (url.pathname === `${root}/impacts`) value = [];
        else if (url.pathname === `${root}/orchestration/work-status`) value = { items: [{
          taskId, cognition: true, dispatchId: "dispatch", dispatchState: "accepted", outcome: "delivered",
          runId: "run", runState: "completed", unsettledRunState: null, loopState: "active",
          goalOutcome: "完成真实闭环验收", stageDeliverable: null, sourceKind: "worker.outcome",
          sourceTaskId: null, sourceTaskTitle: rawCognitionTitle, decisionKind: null, decisionReason: null,
          useRequired: true, deliveryId: null, technicalResult: null, observationResult: null,
          observerKind: null, hasClosure: false, readyForAcceptance: false,
        }] };
        else if (url.pathname === `${root}/work-management/index`) value = {
          items: [{
            kind: "task", taskId, version: 3, currentRevisionId: task.currentRevisionId,
            workChangeSequence: 9, title: rawCognitionTitle, taskKind: "research", taskState: "in_progress",
            phase: "awaiting_delivery",
            nextAction: "核对 Run 终态与本人提交；缺交付时保留缺口，不猜结果",
            responsible: { kind: "role", id: roleId, label: "Role cognition" },
            assignment: null, latestRun: null, delivery: null, pendingImpactCount: 0, queueHold: null,
            goal: null, stage: null, plan: null, dependencies: [], dependencyVersion: 0, review: null,
            dates: { createdAt: stamp, businessChangedAt: stamp, startedAt: stamp,
              completedAt: null, observedAt: stamp },
            actionKey: `task:${taskId}:v3:awaiting_delivery:9`,
          }],
          nextCursor: null, total: 1, counts: { awaiting_delivery: 1, review_deferred: 0 },
          changeSequence: 9, observedAt: stamp, partial: false,
        };
        else if (url.pathname === `${root}/roles/${roleId}`) value = {
          projectId, id: roleId, proposal: { title: "cognition" },
        };
        res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(value)); return;
      }
      try {
        const path = url.pathname === "/" ? "index.html" : url.pathname;
        const body = await readFile(join(dist, path));
        res.writeHead(200, { "content-type":
          ({ ".html": "text/html", ".js": "text/javascript", ".css": "text/css" } as Record<string, string>)[extname(path)] ??
          "application/octet-stream" });
        res.end(body);
      } catch { res.writeHead(404); res.end(); }
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); t.after(() => server.close());
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const browser = await chromium.launch({ headless: true,
      executablePath: process.env.EVOLOOP_BROWSER_TEST_CHROMIUM_EXECUTABLE }); t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.goto(`${base}/#/p/${projectId}/work`);
    await page.getByLabel("访问令牌").fill("fixture-token");
    await page.getByRole("button", { name: "进入", exact: true }).click();
    const overview = page.locator(".leader-work");
    await overview.getByRole("heading", { name: "现在需要处理什么" }).waitFor();
    assert.equal(await overview.locator(".leader-work-phases").count(), 1);
    assert.doesNotMatch(await overview.innerText(), /^\s*0\s*$/m);
    await overview.getByText("业务结果反馈 · 完成真实闭环验收").waitFor();
    await overview.getByText("历史判断记录 · 原任务责任见原任务").waitFor();
    const text = await overview.innerText();
    assert.doesNotMatch(text, /Cognition:|Role cognition|25deb2bf/);
    assert.match(text, /待结果交付/);
    if (process.env.EVOLOOP_LEADER_OVERVIEW_SCREENSHOT)
      await page.screenshot({ path: process.env.EVOLOOP_LEADER_OVERVIEW_SCREENSHOT, fullPage: false });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await overview.evaluate(element => element.scrollWidth <= element.clientWidth), true);
    if (process.env.EVOLOOP_LEADER_OVERVIEW_MOBILE_SCREENSHOT)
      await page.screenshot({ path: process.env.EVOLOOP_LEADER_OVERVIEW_MOBILE_SCREENSHOT, fullPage: false });
  });
