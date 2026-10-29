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
const ordinaryTaskId = "31000005-0000-4000-8000-000000000005";
const sessionTaskId = "31000006-0000-4000-8000-000000000006";
const sessionId = "31000007-0000-4000-8000-000000000007";
const ownedSessionKey = `owned:${sessionId}`;
const stamp = "2026-10-29T03:30:00.000Z";
const rawCognitionTitle = "Cognition: business result event 25deb2bf-f765-4258-b836-41b2d8502539";
const task = {
  projectId, id: taskId, version: 3, currentRevisionId: "31000004-0000-4000-8000-000000000004",
  title: rawCognitionTitle, content: "正文", contentDocumentId: taskId, contentRevisionId: taskId,
  kind: "research", acceptance: "确认", owner: roleId, state: "in_progress", createdAt: stamp,
};
const ordinaryTask = {
  projectId, id: ordinaryTaskId, version: 1, currentRevisionId: ordinaryTaskId,
  title: "普通首批任务", content: "正文", contentDocumentId: ordinaryTaskId, contentRevisionId: ordinaryTaskId,
  kind: "implementation", acceptance: "确认", owner: roleId, state: "todo", createdAt: stamp,
};

test("Leader overview hides empty review counts and maps cognition history to readable Chinese labels",
  { skip: !modulePath && "Set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE" }, async t => {
    const { chromium } = (await import(pathToFileURL(modulePath!).href)).default;
    const workStatusCalls: string[][] = [], sessionSnapshotCalls: string[] = [];
    const server = createServer(async (req, res) => {
      const url = new URL(req.url, "http://127.0.0.1");
      if (url.pathname === "/__fixture/work-status-calls") {
        res.end(JSON.stringify(workStatusCalls)); return;
      }
      if (url.pathname === "/__fixture/session-snapshot-calls") {
        res.end(JSON.stringify(sessionSnapshotCalls)); return;
      }
      if (url.pathname.startsWith("/api/")) {
        const root = `/api/projects/${projectId}`;
        let value: unknown = { items: [], nextCursor: null };
        if (url.pathname === "/api/session") value = {
          principal: { actorId: "reader", projectIds: [projectId], permissions: ["read"] }, capabilities: {},
        };
        else if (url.pathname === root) value = { id: projectId, title: "现场回归项目", createdAt: stamp };
        else if (url.pathname === `${root}/tasks`) value = { items: [ordinaryTask], nextCursor: null };
        else if (url.pathname === `${root}/impacts`) value = [];
        else if (url.pathname === `${root}/orchestration/work-status`) {
          const requested = url.searchParams.get("taskIds")!.split(",");
          workStatusCalls.push(requested);
          const empty = { dispatchId: null, dispatchState: null, outcome: null, runId: null, runState: null,
            unsettledRunState: null, loopState: null, goalOutcome: null, stageDeliverable: null,
            sourceKind: null, sourceTaskId: null, sourceTaskTitle: null, decisionKind: null, decisionReason: null,
            useRequired: null, deliveryId: null, technicalResult: null, observationResult: null,
            observerKind: null, hasClosure: false, readyForAcceptance: false };
          value = { items: requested.map(id => id === taskId ? {
            taskId, cognition: true, dispatchId: "dispatch", dispatchState: "accepted", outcome: "delivered",
            runId: "run", runState: "completed", unsettledRunState: null, loopState: "active",
            goalOutcome: "完成真实闭环验收", stageDeliverable: null, sourceKind: "worker.outcome",
            sourceTaskId: null, sourceTaskTitle: rawCognitionTitle, decisionKind: null, decisionReason: null,
            useRequired: true, deliveryId: null, technicalResult: null, observationResult: null,
            observerKind: null, hasClosure: false, readyForAcceptance: false,
          } : { ...empty, taskId: id, cognition: false }) };
        }
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
          }, {
            kind: "task", taskId: sessionTaskId, version: 2, currentRevisionId: sessionTaskId,
            workChangeSequence: 10, title: "核对产品文档交接", taskKind: "implementation",
            taskState: "in_progress", phase: "running", nextAction: "等待当前 Run 的真实终态",
            responsible: { kind: "session", id: sessionId, label: `受管 Session ${sessionId}` },
            assignment: { state: "accepted", targetKind: "owned", targetId: sessionId,
              recipientActorId: "product-docs-owner" },
            latestRun: { runId: "31000008-0000-4000-8000-000000000008", state: "running" },
            delivery: null, pendingImpactCount: 0, queueHold: null, goal: null, stage: null, plan: null,
            dependencies: [], dependencyVersion: 0, review: null,
            dates: { createdAt: stamp, businessChangedAt: stamp, startedAt: stamp,
              completedAt: null, observedAt: stamp },
            actionKey: `task:${sessionTaskId}:v2:running:10`,
          }],
          nextCursor: null, total: 2, counts: { awaiting_delivery: 1, running: 1, review_deferred: 0 },
          changeSequence: 9, observedAt: stamp, partial: false,
        };
        else if (url.pathname === `${root}/roles/${roleId}`) value = {
          projectId, id: roleId, proposal: { title: "cognition" },
        };
        else if (decodeURIComponent(url.pathname) === `${root}/session-work/${ownedSessionKey}`) {
          sessionSnapshotCalls.push(ownedSessionKey);
          value = { session: { key: ownedSessionKey, title: "Role cognition fallback",
            target: { kind: "owned", sessionId }, profile: { displayName: "产品文档" } } };
        }
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
    await page.locator(".leader-work-disclosure > summary").click();
    const overview = page.locator(".leader-work");
    await overview.getByRole("heading", { name: "现在需要处理什么" }).waitFor();
    assert.equal(await overview.locator(".leader-work-phases").count(), 1);
    assert.doesNotMatch(await overview.innerText(), /^\s*0\s*$/m);
    await overview.getByText("业务结果反馈 · 完成真实闭环验收").waitFor();
    await overview.getByText("历史判断记录 · 原任务责任见原任务").waitFor();
    await overview.getByText("受管 Session · 产品文档").waitFor();
    await overview.getByRole("link", { name: "打开 Session" }).waitFor();
    const text = await overview.innerText();
    assert.doesNotMatch(text, /Cognition:|Role cognition|25deb2bf|Role cognition fallback/);
    assert.match(text, /待结果交付/);
    assert.match(text, new RegExp(sessionId.slice(0, 8)));
    await page.waitForFunction(async () =>
      (await (await fetch("/__fixture/work-status-calls")).json() as string[][]).some(ids => ids.includes(
        "31000006-0000-4000-8000-000000000006")));
    const statusCalls = await (await fetch(`${base}/__fixture/work-status-calls`)).json() as string[][];
    assert.equal(statusCalls.some(ids => ids.includes(taskId)), true,
      "the cognition Leader row is absent from the ordinary Task first page and must be read separately");
    assert.equal((await (await fetch(`${base}/__fixture/session-snapshot-calls`)).json() as string[])
      .includes(ownedSessionKey), true);
    if (process.env.EVOLOOP_LEADER_OVERVIEW_SCREENSHOT)
      await page.screenshot({ path: process.env.EVOLOOP_LEADER_OVERVIEW_SCREENSHOT, fullPage: false });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await overview.evaluate(element => element.scrollWidth <= element.clientWidth), true);
    if (process.env.EVOLOOP_LEADER_OVERVIEW_MOBILE_SCREENSHOT)
      await page.screenshot({ path: process.env.EVOLOOP_LEADER_OVERVIEW_MOBILE_SCREENSHOT, fullPage: false });
  });
