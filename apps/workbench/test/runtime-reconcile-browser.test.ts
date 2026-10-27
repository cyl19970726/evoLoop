// Opt-in built-app regression: build workbench, then set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const modulePath = process.env.EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE;
const dist = resolve(import.meta.dirname, "../dist");
const projectId = "60000001-0000-4000-8000-000000000001";
const runId = "60000002-0000-4000-8000-000000000002";
const taskId = "60000003-0000-4000-8000-000000000003";
const sessionId = "60000004-0000-4000-8000-000000000004";
const nativeTurnId = "native-turn-1";

test("reconcile pages retain the same run baseline and never report a partial read as changed", {
  skip: !modulePath && "Set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE after building the workbench",
}, async t => {
  const { chromium } = (await import(pathToFileURL(modulePath!).href)).default;
  const requests: Array<{ expectedVersion: number; reason: string; turnCursor?: string }> = [];
  let run = { projectId, id: runId, taskId, sessionId, taskRevisionId: taskId, basisSetId: taskId,
    state: "completed", version: 1, nativeTurnId, resultSummary: null as string | null, interruptRequested: false };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname.startsWith("/api/")) {
      const root = `/api/projects/${projectId}`;
      let value: unknown = { items: [], nextCursor: null };
      if (url.pathname === "/api/session") value = { principal: { actorId: "reviewer", projectIds: [projectId], permissions: ["read", "write", "review"] }, capabilities: {} };
      else if (url.pathname === root) value = { id: projectId, title: "核对夹具", createdAt: "2026-10-27T00:00:00Z" };
      else if (url.pathname === `${root}/runtime`) value = { available: true, error: null, allowedCwds: [], grants: [] };
      else if (url.pathname === `${root}/runtime/sessions`) value = [];
      else if (url.pathname === `${root}/runtime/runs`) value = [run];
      else if (url.pathname === `${root}/runtime/runs/${runId}/reconcile` && req.method === "POST") {
        let body = ""; for await (const chunk of req) body += String(chunk);
        const request = JSON.parse(body) as { expectedVersion: number; reason: string; turnCursor?: string };
        requests.push(request);
        if (requests.length < 3) value = { status: "partial", changed: false, projectId, runId, nativeTurnId,
          expectedVersion: 1, nextTurnCursor: `page-${requests.length}`, reason: request.reason };
        else { run = { ...run, version: 2, resultSummary: "原生终态已回读并登记" }; value = run; }
      }
      else if (url.pathname === `${root}/resident-queues`) value = [];
      else if (url.pathname === `${root}/orchestration/status`) value = { state: "active", running: false, busy: false, faults: [], lastError: null };
      res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(value)); return;
    }
    try {
      const file = url.pathname === "/" ? "index.html" : url.pathname;
      const body = await readFile(join(dist, file));
      res.writeHead(200, { "content-type": ({ ".html": "text/html", ".js": "text/javascript", ".css": "text/css" } as Record<string, string>)[extname(file)] ?? "application/octet-stream" }); res.end(body);
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const browser = await chromium.launch({ headless: true, ...(process.env.EVOLOOP_BROWSER_TEST_EXECUTABLE_PATH
    ? { executablePath: process.env.EVOLOOP_BROWSER_TEST_EXECUTABLE_PATH } : {}) }); t.after(() => browser.close());
  const page = await browser.newPage();
  await page.goto(`${base}/#/p/${projectId}/runtime?view=execution`);
  await page.getByLabel("访问令牌").fill("fixture-token");
  await page.getByRole("button", { name: "进入", exact: true }).click();
  const card = page.locator(".runtime-run-card").filter({ hasText: runId.slice(0, 8) });
  await card.locator(":scope > summary").click();
  const form = card.locator(".workflow-detail").filter({ hasText: "核对已绑定运行的终态观察" }).first();
  await form.locator(":scope > summary").click();
  await form.getByLabel("复核理由").fill("复核原 Turn 的终态");
  await form.getByRole("button", { name: "回读原生终态并登记观察" }).click();
  await form.getByText(/尚未定位该运行，运行记录没有修改/).waitFor();
  assert.equal(await form.getByText(/终态观察已核对/).count(), 0);
  assert.deepEqual(requests[0], { expectedVersion: 1, reason: "复核原 Turn 的终态" });
  assert.equal(await form.getByLabel("复核理由").getAttribute("readonly"), "");
  await form.getByRole("button", { name: "继续核对" }).click();
  await form.getByText(/尚未定位该运行，运行记录没有修改/).waitFor();
  assert.deepEqual(requests[1], { expectedVersion: 1, reason: "复核原 Turn 的终态", turnCursor: "page-1" });
  await form.getByRole("button", { name: "继续核对" }).click();
  await page.waitForFunction(() => !!document.querySelector(".runtime-run-card .history-body"));
  if (await card.getAttribute("open") === null) await card.locator(":scope > summary").click();
  await card.getByText(/原生终态已回读并登记/).waitFor();
  assert.deepEqual(requests[2], { expectedVersion: 1, reason: "复核原 Turn 的终态", turnCursor: "page-2" });
});
