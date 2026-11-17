// Opt-in built-app regression (defect b1f5d4c7). All IDs and API responses are synthetic fixture data in the shape the Leader work index returns.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { mkdir, readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

const modulePath = process.env.EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE;
const dist = resolve(import.meta.dirname, "../dist");
const shotDir = process.env.EVOLOOP_SHOT_DIR ?? join(tmpdir(), "evoloop-used-waits-shots");
const projectId = "98000001-0000-4000-8000-000000000001";
const stamp = "2026-11-16T00:00:00.000Z";
const id = (n: number) => `98000${String(n).padStart(3, "0")}-0000-4000-8000-000000000002`;
const roleId = "98000900-0000-4000-8000-000000000004";

interface Fixture { n: number; title: string; phase: string; responsible: { kind: string; id: string | null; label: string }; waitingTask?: { taskId: string; state: string } | null }
// Three different waits that all follow a used conclusion, one Task still waiting for acceptance, and a second close wait whose prerequisite has closed.
const fixtures: Fixture[] = [
  { n: 1, title: "合成 · 没有验收结论", phase: "awaiting_acceptance", responsible: { kind: "consumer", id: "accept-agent", label: "验收者 accept-agent" } },
  { n: 2, title: "合成 · 已签 used 等关闭", phase: "awaiting_close", responsible: { kind: "leader", id: null, label: "x" } },
  { n: 3, title: "合成 · 前置刚关闭仍等关闭", phase: "awaiting_close", responsible: { kind: "leader", id: null, label: "x" } },
  { n: 4, title: "合成 · 已签 used 等发布", phase: "awaiting_release", responsible: { kind: "publisher", id: "requirements", label: "x" } },
  { n: 5, title: "合成 · 已签 used 等前置", phase: "awaiting_prerequisite", responsible: { kind: "task", id: id(9), label: "x" }, waitingTask: { taskId: id(9), state: "in_progress" } },
];
const counts = { awaiting_acceptance: 1, awaiting_close: 2, awaiting_release: 1, awaiting_prerequisite: 1 };
const taskOf = (f: Fixture) => ({ projectId, id: id(f.n), version: 2, currentRevisionId: id(f.n + 20), title: f.title, content: "合成夹具正文",
  contentDocumentId: id(f.n), contentRevisionId: id(f.n + 20), kind: "implementation", acceptance: "合成验收", owner: roleId, state: "in_progress", createdAt: stamp });
const projectionOf = (f: Fixture) => ({ kind: "task", taskId: id(f.n), version: 2, currentRevisionId: id(f.n + 20), workChangeSequence: 7, title: f.title,
  taskKind: "implementation", taskState: "in_progress", phase: f.phase, nextAction: "server text is never shown", responsible: f.responsible,
  waitingTask: f.waitingTask ?? null, assignment: null, latestRun: null, delivery: null, pendingImpactCount: 0, queueHold: null, goal: null, stage: null,
  plan: null, dependencies: [], dependencyVersion: 0, review: null,
  dates: { createdAt: stamp, businessChangedAt: stamp, startedAt: stamp, completedAt: null, observedAt: stamp },
  timing: { createdAt: stamp, publication: { at: null, source: "unknown" }, current: { stage: "awaiting_acceptance", startedAt: stamp, endedAt: null, elapsedMs: 1000,
    source: null, waitingFor: { kind: "unknown", id: null } }, rounds: [], latestEffectiveProgress: null, executionActivity: null, observedAt: stamp },
  actionKey: `task:${id(f.n)}:v2:${f.phase}:7` });

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test(`used Tasks leave 待验收 for 等关闭／等发布／等前置 with the actual party, counts equal rows (${viewport.width}×${viewport.height})`, {
    skip: !modulePath && "Set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE after building the workbench",
  }, async t => {
    const { chromium } = (await import(pathToFileURL(modulePath!).href)).default;
    const server = createServer(async (req, res) => {
      const url = new URL(req.url!, "http://127.0.0.1");
      if (url.pathname.startsWith("/api/")) {
        if (req.method !== "GET") { res.writeHead(405); res.end(); return; }
        const root = `/api/projects/${projectId}`;
        let value: unknown = { items: [], nextCursor: null };
        if (url.pathname === "/api/session") value = { principal: { actorId: "reader", projectIds: [projectId], permissions: [] }, capabilities: {} };
        else if (url.pathname === root) value = { id: projectId, title: "合成夹具项目", createdAt: stamp };
        else if (url.pathname === `${root}/tasks`) value = { items: fixtures.map(taskOf), nextCursor: null };
        else if (url.pathname === `${root}/orchestration/work-status`) value = { items: fixtures.map(f => ({ taskId: id(f.n), cognition: false, hasClosure: false, readyForAcceptance: false })) };
        else if (url.pathname === `${root}/work-management/index`) value = { items: fixtures.map(projectionOf), nextCursor: null, total: fixtures.length, counts,
          changeSequence: 7, observedAt: stamp, partial: false };
        else if (url.pathname === `${root}/roles/${roleId}`) value = { projectId, id: roleId, proposal: { title: "功能开发职责" } };
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(value)); return;
      }
      const file = join(dist, /^\/(?:$|p\/|ui$)/.test(url.pathname) ? "index.html" : url.pathname);
      if (!file.startsWith(`${dist}/`)) { res.writeHead(404); res.end(); return; }
      try {
        res.writeHead(200, { "content-type": ({ ".html": "text/html", ".js": "text/javascript", ".css": "text/css" } as Record<string, string>)[extname(file)] ?? "application/octet-stream" });
        res.end(await readFile(file));
      } catch { res.writeHead(404); res.end(); }
    });
    await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
    t.after(() => server.close());
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const browser = await chromium.launch({ headless: true,
      ...(process.env.EVOLOOP_BROWSER_TEST_EXECUTABLE_PATH ? { executablePath: process.env.EVOLOOP_BROWSER_TEST_EXECUTABLE_PATH } : {}) });
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport });
    const pageErrors: string[] = [];
    page.on("pageerror", error => pageErrors.push(error.message));
    await page.goto(`${base}/p/${projectId}/work`);
    await page.getByLabel("访问令牌").fill("fixture-token");
    await page.getByRole("button", { name: "进入", exact: true }).click();

    // Counts: one tag per class, taken from the same classification as the rows.
    const tags = page.getByLabel("对账阶段计数");
    await tags.waitFor();
    const tagText = await tags.innerText();
    for (const [label, count] of [["待验收", 1], ["等关闭", 2], ["等发布", 1], ["等前置", 1]] as const)
      assert.match(tagText.replace(/\s+/g, " "), new RegExp(`${label} · ${count}`), `${label} count in: ${tagText}`);

    // Rows: each Task carries its own class label, and 待验收 is only the Task with no conclusion.
    const rows = page.locator('main tbody[data-group="business"]').getByRole("row");
    for (const f of fixtures) {
      const row = rows.filter({ hasText: f.title });
      await row.getByRole("button", { name: f.title }).waitFor();
      const label = ({ awaiting_acceptance: "待验收", awaiting_close: "等关闭", awaiting_release: "等发布", awaiting_prerequisite: "等前置" } as Record<string, string>)[f.phase]!;
      await row.getByText(label, { exact: true }).first().waitFor();
      if (f.phase !== "awaiting_acceptance") assert.equal(await row.getByText("待验收", { exact: true }).count(), 0, `${f.title} must not be counted as 待验收`);
    }
    const acceptanceRows = await rows.filter({ has: page.getByText("待验收", { exact: true }) }).count();
    assert.equal(acceptanceRows, counts.awaiting_acceptance, "the 待验收 rows equal the 待验收 count");

    // The reconciliation list names the actual party for each wait.
    await page.getByText(/查看全项目统筹对账/).click();
    const overview = page.locator("[data-leader-overview]");
    await overview.waitFor();
    const text = (await overview.innerText()).replace(/\s+/g, " ");
    assert.match(text, /验收者已签 used，不需要再验收；等负责关闭的责任者关闭/);
    assert.match(text, /项目统筹 · 负责关闭/);
    assert.match(text, /发布维护者 requirements/);
    assert.match(text, new RegExp(`前置任务 ${id(9).slice(0, 8)} · 当前进行中`));
    // The stage clock on a used Task no longer says it waits for acceptance.
    assert.match(text, /当前阶段 验收已有结论，等关闭/);
    assert.doesNotMatch(await rows.filter({ hasText: "已签 used 等发布" }).innerText(), /等待验收/);
    assert.doesNotMatch(text, /server text is never shown/);
    assert.equal(pageErrors.length, 0, pageErrors.join(" | "));
    const horizontal = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(horizontal <= 1, `no horizontal overflow (${horizontal}px)`);
    await mkdir(shotDir, { recursive: true });
    await page.screenshot({ path: join(shotDir, `used-waits-${viewport.width}x${viewport.height}.png`), fullPage: true });
  });
}
