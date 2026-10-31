// Opt-in built-app regression for a real empty-first-page failure.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const modulePath = process.env.EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE;
const dist = resolve(import.meta.dirname, "../dist");
const projectId = "31000001-0000-4000-8000-000000000001";
const stamp = "2026-10-31T00:00:00.000Z";
const task = (index: number, state: string, title: string) => ({ projectId,
  id: `31000000-0000-4000-8000-${String(index).padStart(12, "0")}`, version: 1,
  currentRevisionId: projectId, contentDocumentId: projectId, contentRevisionId: projectId,
  title, content: "正文", kind: "implementation", acceptance: "核对", owner: "reader", state, createdAt: stamp });

for (const scenario of ["visible", "failure", "closed", "mine"] as const) test({
  visible: "unfinished work behind a closed first page appears without a manual load",
  failure: "filtered continuation reports a failed page and can resume without claiming an empty project",
  closed: "exhausted closed pages report no matching tasks rather than an empty project",
  mine: "my work waits for assignment projections before deciding to continue past the current page",
}[scenario], {
  skip: !modulePath && "Set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE",
}, async t => {
  const failingPage = scenario === "failure", mine = scenario === "mine", onlyClosed = scenario === "closed";
  const heldProjections: (() => void)[] = [];
  const { chromium } = (await import(pathToFileURL(modulePath!).href)).default;
  const closed = Array.from({ length: 50 }, (_, index) => task(index + 1, index % 2 ? "done" : "cancelled", `历史任务 ${index + 1}`));
  const current = task(51, "in_progress", "后页正在做的工作");
  const future = task(52, "todo", "后页待办工作");
  const cursors: string[] = [];
  let fail = failingPage;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, "http://127.0.0.1");
    if (url.pathname === "/__fixture/restore") { fail = false; heldProjections.splice(0).forEach(release => release()); res.end("ok"); return; }
    if (url.pathname.startsWith("/api/")) {
      const root = `/api/projects/${projectId}`;
      let value: unknown = { items: [], nextCursor: null }, status = 200;
      if (url.pathname === "/api/session") value = { principal: { actorId: "reader", projectIds: [projectId], permissions: ["read"] }, capabilities: {} };
      else if (url.pathname === root) value = { id: projectId, title: "分页回归项目", createdAt: stamp };
      else if (url.pathname === `${root}/tasks`) {
        const cursor = url.searchParams.get("cursor") ?? "first"; cursors.push(cursor);
        if (cursor === "second" && fail) { status = 503; value = { message: "后页暂不可读" }; }
        else value = cursor === "first" ? { items: mine ? [current] : closed, nextCursor: "second" }
          : onlyClosed ? { items: [], nextCursor: null }
          : cursor === "second" ? { items: [current], nextCursor: "third" } : { items: [future], nextCursor: null };
      } else if (url.pathname.startsWith(`${root}/tasks/`)) {
        const found = [...closed, current, future].find(item => url.pathname.endsWith(item.id))!;
        value = { task: found, revision: { ...found, taskId: found.id }, basis: null, links: [], impacts: [], decisions: [], deliveries: [], observations: [], closures: [] };
      } else if (url.pathname === `${root}/orchestration/work-status`) value = { items: (url.searchParams.get("taskIds") ?? "").split(",").filter(Boolean).map(taskId => ({ taskId, cognition: false, hasClosure: false, readyForAcceptance: false })) };
      else if (url.pathname === `${root}/impacts`) value = [];
      else if (url.pathname === `${root}/work-management/index`) {
        if (mine) await new Promise<void>(resolve => heldProjections.push(resolve));
        value = { items: mine ? [{ kind: "task", taskId: current.id, version: 1, currentRevisionId: current.currentRevisionId,
          title: current.title, taskState: current.state, taskKind: current.kind, phase: "ready", nextAction: "继续当前工作", workChangeSequence: 0,
          responsible: { kind: "actor", id: "reader", label: "reader" }, assignment: { state: "accepted", targetKind: "external", targetId: projectId, recipientActorId: "reader" },
          latestRun: null, delivery: null, pendingImpactCount: 0, queueHold: null, goal: null, stage: null,
          plan: { plannedStartAt: null, dueAt: null, priority: null }, dependencies: [], dependencyVersion: 0, review: null,
          dates: { createdAt: stamp, businessChangedAt: stamp, startedAt: null, completedAt: null, observedAt: stamp }, actionKey: "current" }] : [],
          nextCursor: null, total: mine ? 1 : 0, counts: {}, changeSequence: 0, observedAt: stamp, partial: false };
      }
      else if (url.pathname.startsWith(`${root}/work-management/tasks/`)) { status = 404; value = { message: "未登记投影" }; }
      else if (url.pathname === `${root}/session-work`) value = { items: [], nextCursor: null, totals: { current: 0, historical: 0, unclassified: 0 }, metadata: { generatedAt: stamp, sourceObservedAt: stamp, partial: false, limitations: [] } };
      res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); return;
    }
    try {
      const file = url.pathname === "/" ? "index.html" : url.pathname;
      res.writeHead(200, { "content-type": ({ ".html": "text/html", ".js": "text/javascript", ".css": "text/css" } as Record<string, string>)[extname(file)] ?? "application/octet-stream" });
      res.end(await readFile(join(dist, file)));
    } catch { res.end(); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); t.after(() => { heldProjections.splice(0).forEach(release => release()); server.close(); });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const browser = await chromium.launch({ headless: true }); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await page.goto(`${base}/#/p/${projectId}/work${mine ? "?scope=mine" : ""}`);
  await page.getByLabel("访问令牌").fill("fixture-token");
  await page.getByRole("button", { name: "进入", exact: true }).click();
  if (mine) {
    await page.getByText("我的承接信息尚未读全，当前结果不完整。", { exact: true }).waitFor();
    await page.waitForTimeout(300);
    assert.deepEqual(cursors, ["first"], "an unread assignment is not evidence to fetch more Tasks");
    await fetch(`${base}/__fixture/restore`);
    await page.getByRole("row").filter({ hasText: current.title }).waitFor();
    await page.waitForTimeout(300);
    assert.deepEqual(cursors, ["first"], "a matching current assignment stops continuation");
    assert.deepEqual(errors, []); return;
  }
  if (onlyClosed) {
    await page.getByRole("heading", { name: "没有匹配项", exact: true }).waitFor({ timeout: 5000 });
    assert.deepEqual(cursors, ["first", "second"]);
    assert.equal(await page.getByRole("heading", { name: "还没有任务", exact: true }).count(), 0);
    await page.getByLabel("任务状态筛选").selectOption("all");
    await page.getByRole("row").filter({ hasText: "历史任务 1" }).first().waitFor();
    assert.deepEqual(errors, []); return;
  }
  if (failingPage) {
    await page.getByText(/搜索未完成：.*后页暂不可读/).waitFor({ timeout: 5000 });
    assert.equal(await page.getByRole("heading", { name: "还没有任务", exact: true }).count(), 0);
    await fetch(`${base}/__fixture/restore`);
    await page.getByRole("button", { name: "加载更多", exact: true }).click();
  }
  await page.getByRole("row").filter({ hasText: current.title }).waitFor({ timeout: 5000 });
  await page.waitForTimeout(300);
  assert.equal(cursors.filter(cursor => cursor === "second").length, failingPage ? 2 : 1);
  assert.equal(cursors.includes("third"), false, "stop automatic continuation once matching work is visible");
  await page.getByLabel("任务状态筛选").selectOption("todo");
  await page.getByRole("row").filter({ hasText: future.title }).waitFor({ timeout: 5000 });
  assert.equal(cursors.filter(cursor => cursor === "third").length, 1);
  await page.getByLabel("任务状态筛选").selectOption("all");
  await page.getByRole("row").filter({ hasText: "历史任务 1" }).first().waitFor();
  assert.equal(await page.locator("body").evaluate(element => element.scrollWidth <= window.innerWidth), true);
  assert.deepEqual(errors, []);
});
