// Built-app regression for Task 849c458e: the 未完成 list is every open task read from the work index, the header's phase
// counts are buttons that filter it, and the default order follows the urgency constant. Run after `npm run build`.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const modulePath = process.env.EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE;
const dist = resolve(import.meta.dirname, "../dist");
const projectId = "32000001-0000-4000-8000-000000000001";
const stamp = "2026-11-01T00:00:00.000Z";
const idOf = (n: number) => `32000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
type Fixture = { id: string; title: string; state: string; phase?: string; changedAt?: string };
const task = (item: Fixture) => ({ projectId, id: item.id, version: 1, currentRevisionId: item.id, contentDocumentId: item.id, contentRevisionId: item.id,
  title: item.title, content: "正文", kind: "implementation", acceptance: "核对", owner: "reader", state: item.state, createdAt: stamp });
const row = (item: Fixture) => ({ kind: "task", taskId: item.id, version: 1, currentRevisionId: item.id, title: item.title, taskState: item.state, taskKind: "implementation",
  phase: item.phase, nextAction: "继续", workChangeSequence: 0, owner: "reader", responsible: { kind: "actor", id: "reader", label: "reader" }, assignment: null,
  latestRun: null, delivery: null, pendingImpactCount: 0, queueHold: null, goal: null, stage: null,
  plan: { plannedStartAt: null, dueAt: null, priority: null }, dependencies: [], dependencyVersion: 0, review: null,
  dates: { createdAt: stamp, businessChangedAt: item.changedAt ?? stamp, startedAt: null, completedAt: null, observedAt: stamp }, actionKey: item.id });

/** Open tasks by phase (title "<phase>-<n>", a larger n changed later so a smaller n has waited longer), then closed ones. */
function sample(open: Record<string, number>, closedCount: number) {
  let next = 1;
  const items: Fixture[] = [];
  for (const [phase, count] of Object.entries(open)) for (let n = 1; n <= count; n++) {
    items.push({ id: idOf(next++), title: `${phase}-${n}`, state: phase === "running" ? "in_progress" : "todo", phase,
      changedAt: new Date(Date.parse(stamp) + n * 3_600_000).toISOString() });
  }
  // Closed work comes first in Task-number order, so open work is only reached after several pages.
  const closed = Array.from({ length: closedCount }, (_, index): Fixture => ({ id: idOf(1000 + index), title: `历史任务 ${index + 1}`, state: index % 2 ? "done" : "cancelled" }));
  return { open: items, closed, all: [...closed, ...[...items].reverse()] };
}

async function serve(data: ReturnType<typeof sample>, behaviour: { failIndexPage2: boolean; indexPageSize: number }) {
  const state = { taskCursors: [] as string[], indexCursors: [] as string[] };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, "http://127.0.0.1");
    const size = Math.min(Number(url.searchParams.get("limit") ?? behaviour.indexPageSize), behaviour.indexPageSize);
    if (url.pathname === "/__fixture/recover") { behaviour.failIndexPage2 = false; res.end("ok"); return; }
    if (url.pathname.startsWith("/api/")) {
      const root = `/api/projects/${projectId}`;
      let value: unknown = { items: [], nextCursor: null }, status = 200;
      if (url.pathname === "/api/session") value = { principal: { actorId: "reader", projectIds: [projectId], permissions: [] }, capabilities: {} };
      else if (url.pathname === root) value = { id: projectId, title: "未完成列表项目", createdAt: stamp };
      else if (url.pathname === `${root}/tasks`) {
        const start = Number(url.searchParams.get("cursor") ?? 0); state.taskCursors.push(String(start));
        const items = data.all.slice(start, start + 50);
        value = { items: items.map(task), nextCursor: start + 50 < data.all.length ? String(start + 50) : null };
      } else if (url.pathname === `${root}/orchestration/work-status`) value = { items: (url.searchParams.get("taskIds") ?? "").split(",").filter(Boolean).map(taskId => ({ taskId, cognition: false, hasClosure: false, readyForAcceptance: false })) };
      else if (url.pathname === `${root}/impacts`) value = [];
      else if (url.pathname === `${root}/work-management/index`) {
        const start = Number(url.searchParams.get("cursor") ?? 0); state.indexCursors.push(String(start));
        if (start > 0 && behaviour.failIndexPage2) { res.writeHead(503, { "content-type": "application/json" }); res.end(JSON.stringify({ message: "索引第二页暂不可读" })); return; }
        const counts: Record<string, number> = {};
        for (const item of data.open) counts[item.phase!] = (counts[item.phase!] ?? 0) + 1;
        const items = data.open.slice(start, start + size);
        value = { items: items.map(row), nextCursor: start + size < data.open.length ? String(start + size) : null,
          total: data.open.length, counts, changeSequence: 0, observedAt: stamp, partial: false };
      } else if (url.pathname === `${root}/session-work`) value = { items: [], nextCursor: null, totals: { current: 0, historical: 0, unclassified: 0 }, metadata: { generatedAt: stamp, sourceObservedAt: stamp, partial: false, limitations: [] } };
      res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); return;
    }
    try {
      const file = /^\/(?:$|p\/|ui$)/.test(url.pathname) ? "index.html" : url.pathname;
      res.writeHead(200, { "content-type": ({ ".html": "text/html", ".js": "text/javascript", ".css": "text/css" } as Record<string, string>)[extname(file)] ?? "application/octet-stream" });
      res.end(await readFile(join(dist, file)));
    } catch { res.end(); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return { server, state, base: `http://127.0.0.1:${(server.address() as { port: number }).port}` };
}

async function open(t: { after(fn: () => void): void }, data: ReturnType<typeof sample>, behaviour = { failIndexPage2: false, indexPageSize: 50 }, width = 1440, query = "") {
  const { chromium } = (await import(pathToFileURL(modulePath!).href)).default;
  const { server, state, base } = await serve(data, behaviour);
  t.after(() => server.close());
  const browser = await chromium.launch({ headless: true, ...(process.env.EVOLOOP_BROWSER_TEST_EXECUTABLE_PATH ? { executablePath: process.env.EVOLOOP_BROWSER_TEST_EXECUTABLE_PATH } : {}) });
  t.after(() => { void browser.close(); });
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await page.goto(`${base}/p/${projectId}/work${query}`);
  await page.getByLabel("访问令牌").fill("fixture-token");
  await page.getByRole("button", { name: "进入", exact: true }).click();
  return { page, state, base, errors, main: page.getByRole("main") };
}

const skip = !modulePath && "Set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE";
const phases = { rework: 3, awaiting_acceptance: 2, awaiting_close: 2, blocked: 1, running: 2, unassigned: 22 };
const phaseLabel = (page: Awaited<ReturnType<typeof open>>["page"], phase: string) => page.locator(`main [data-phase="${phase}"]`);

test("every open task is listed, the header numbers add up to the rows, and each number filters", { skip }, async t => {
  const data = sample(phases, 130);
  const { page, state, main, errors } = await open(t, data);
  const rows = main.locator("tr[data-task-row]");
  await main.getByText("未完成 32 项，已全部列出", { exact: true }).waitFor({ timeout: 8000 });
  assert.equal(await rows.count(), 32);
  assert.equal(await main.getByRole("button", { name: "加载更多", exact: true }).count(), 0);
  assert.deepEqual(state.taskCursors.filter(cursor => cursor !== "0"), [], "no Task page beyond the first is needed");
  // Header numbers sum to the rows, and the left rail lists the same tasks.
  const counts = await main.locator("[data-phase]").evaluateAll(nodes => nodes.map(node => ({ phase: node.getAttribute("data-phase")!, text: node.textContent ?? "" })));
  assert.deepEqual(counts.map(item => item.phase), ["rework", "blocked", "awaiting_acceptance", "awaiting_close", "running", "unassigned"], "header follows the urgency order");
  assert.equal(counts.reduce((sum, item) => sum + Number(item.text.match(/(\d+)\s*$/)?.[1]), 0), 32);
  assert.equal(await page.getByRole("region", { name: "任务列表" }).getByRole("link").count() >= 32, true, "the rail lists the same open tasks");
  // The first ten rows follow the phase order, the longest-waiting first within a phase.
  const titles = await rows.evaluateAll(nodes => nodes.map(node => node.getAttribute("data-task-row")));
  const expected = [...data.open].sort((a, b) => ["rework", "blocked", "awaiting_acceptance", "awaiting_close", "awaiting_assignment", "ready", "running", "unassigned"].indexOf(a.phase!) - ["rework", "blocked", "awaiting_acceptance", "awaiting_close", "awaiting_assignment", "ready", "running", "unassigned"].indexOf(b.phase!)
    || Date.parse(a.changedAt!) - Date.parse(b.changedAt!)).map(item => item.id);
  assert.deepEqual(titles.slice(0, 10), expected.slice(0, 10));
  // Each number filters: rows equal the number, the address carries the phase, a second press clears.
  for (const [phase, count] of Object.entries(phases)) {
    const button = phaseLabel(page, phase);
    assert.equal(await button.getAttribute("aria-pressed"), "false");
    await button.click();
    await page.waitForFunction(expected => document.querySelectorAll("main tr[data-task-row]").length === expected, count);
    assert.equal(await button.getAttribute("aria-pressed"), "true");
    assert.match(page.url(), new RegExp(`[?&]phase=${phase}`));
    await button.click();
    await page.waitForFunction(() => document.querySelectorAll("main tr[data-task-row]").length === 32);
    assert.doesNotMatch(page.url(), /[?&]phase=/);
  }
  // The keyboard works as a click does. Choosing a phase adds a history entry: Back returns to the unfiltered list, Forward to the
  // phase again; opening a task from the filtered list and going Back returns to the same filter.
  await phaseLabel(page, "rework").focus(); await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.querySelectorAll("main tr[data-task-row]").length === 3);
  await page.goBack();
  await page.waitForFunction(() => document.querySelectorAll("main tr[data-task-row]").length === 32);
  assert.equal(await phaseLabel(page, "rework").getAttribute("aria-pressed"), "false");
  assert.doesNotMatch(page.url(), /[?&]phase=/);
  await page.goForward();
  await page.waitForFunction(() => document.querySelectorAll("main tr[data-task-row]").length === 3);
  assert.equal(await phaseLabel(page, "rework").getAttribute("aria-pressed"), "true");
  await main.locator("tr[data-task-row]").first().getByRole("link", { name: /打开任务/ }).click();
  await page.waitForURL(/\/tasks\//);
  await page.goBack();
  await page.waitForFunction(() => document.querySelectorAll("main tr[data-task-row]").length === 3);
  assert.equal(await phaseLabel(page, "rework").getAttribute("aria-pressed"), "true");
  await page.reload();
  await page.getByLabel("访问令牌").fill("fixture-token").catch(() => undefined);
  await page.getByRole("button", { name: "进入", exact: true }).click().catch(() => undefined);
  await page.waitForFunction(() => document.querySelectorAll("main tr[data-task-row]").length === 3);
  assert.equal(await phaseLabel(page, "rework").getAttribute("aria-pressed"), "true");
  await phaseLabel(page, "rework").click();
  await page.waitForFunction(() => document.querySelectorAll("main tr[data-task-row]").length === 32);
  await phaseLabel(page, "blocked").focus(); await page.keyboard.press("Space");
  await page.waitForFunction(() => document.querySelectorAll("main tr[data-task-row]").length === 1);
  assert.equal(await page.locator("body").evaluate(element => element.scrollWidth <= window.innerWidth), true);
  assert.deepEqual(errors, []);
});

test("130 open tasks are all listed; a failed index page says how much was read and recovers on retry", { skip }, async t => {
  const data = sample({ ready: 130 }, 0);
  const behaviour = { failIndexPage2: true, indexPageSize: 50 };
  const { page, base, main, errors } = await open(t, data, behaviour);
  await main.getByText(/已读 50 项，未读全/).first().waitFor({ timeout: 8000 });
  assert.equal(await main.getByText(/已全部列出/).count(), 0, "a partial read never says all");
  assert.equal(await main.locator("tr[data-task-row]").count(), 50);
  await fetch(`${base}/__fixture/recover`);
  await main.getByRole("button", { name: "重试", exact: true }).first().click();
  await main.getByText("未完成 130 项，已全部列出", { exact: true }).waitFor({ timeout: 8000 });
  assert.equal(await main.locator("tr[data-task-row]").count(), 130);
  const total = await main.locator("[data-phase]").evaluateAll(nodes => nodes.reduce((sum, node) => sum + Number(node.textContent?.match(/(\d+)\s*$/)?.[1]), 0));
  assert.equal(total, 130);
  assert.deepEqual(errors, []);
});

test("the 全部 range pages honestly, search reaches every open task, and closed work stays out of 未完成", { skip }, async t => {
  const data = sample({ ready: 40, running: 2 }, 130);
  const { page, main, errors } = await open(t, data);
  await main.getByText("未完成 42 项，已全部列出", { exact: true }).waitFor({ timeout: 8000 });
  assert.equal(await main.getByText(/历史任务/).count(), 0, "closed and cancelled tasks are not in 未完成");
  // A task found by its title although the Task pages reach it only after the closed ones.
  await page.getByRole("searchbox", { name: "搜索任务" }).fill("ready-40");
  await page.waitForFunction(() => document.querySelectorAll("main tr[data-task-row]").length === 1);
  await page.getByRole("searchbox", { name: "搜索任务" }).fill("");
  await page.goto(page.url().replace(/\?.*$/, "") + "?state=all");
  await page.getByLabel("访问令牌").fill("fixture-token").catch(() => undefined);
  await page.getByRole("button", { name: "进入", exact: true }).click().catch(() => undefined);
  await main.getByText(/已载入 50 项，后面还有，按编号顺序/).waitFor({ timeout: 8000 });
  assert.equal(await main.getByRole("button", { name: "加载更多", exact: true }).count() > 0, true);
  await main.getByText(/它不是下面这张/).first().waitFor();
  assert.deepEqual(errors, []);
});
