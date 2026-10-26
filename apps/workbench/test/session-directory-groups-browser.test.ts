// Opt-in built-app regression: build workbench, then set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const modulePath = process.env.EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE;
const dist = resolve(import.meta.dirname, "../dist");
const projectId = "30000001-0000-4000-8000-000000000001";
const stamp = "2026-10-27T00:00:00.000Z";
const totals = { current: 5, historical: 37, unclassified: 14 };
const entries = {
  current: Array.from({ length: 5 }, (_, i) => ({ key: `external:current-${i}`, title: `当前成员 ${i + 1}`, membership: "current" })),
  historical: Array.from({ length: 37 }, (_, i) => ({ key: `external:historical-${i}`, title: `历史会话 ${i + 1}`, membership: "historical" })),
  unclassified: Array.from({ length: 14 }, (_, i) => ({ key: `external:unclassified-${i}`, title: `待归类会话 ${i + 1}`, membership: "unclassified" })),
};

test("retrying one Session category preserves another category's loaded pages", { skip: !modulePath && "Set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE" }, async t => {
  const { chromium } = (await import(pathToFileURL(modulePath!).href)).default;
  let unclassifiedUnavailable = true;
  const reads: Array<{ membership: string; cursor: string | null }> = [];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname === "/__fixture/restore") { unclassifiedUnavailable = false; res.end("ok"); return; }
    if (url.pathname === "/__fixture/reads") { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(reads)); return; }
    if (url.pathname.startsWith("/api/")) {
      const root = `/api/projects/${projectId}`;
      let value: unknown = { items: [], nextCursor: null }, status = 200;
      if (url.pathname === "/api/session") value = { principal: { actorId: "reader", projectIds: [projectId], permissions: ["read"] }, capabilities: {} };
      else if (url.pathname === root) value = { id: projectId, title: "目录回归项目", createdAt: stamp };
      else if (url.pathname === `${root}/session-work`) {
        const membership = url.searchParams.get("membership") ?? "current";
        const cursor = url.searchParams.get("cursor");
        reads.push({ membership, cursor });
        if (membership === "unclassified" && unclassifiedUnavailable) { status = 503; value = { message: "temporary fixture failure" }; }
        else {
          const search = url.searchParams.get("search") ?? "";
          const rows = (entries[membership as keyof typeof entries] ?? []).filter(item => item.title.includes(search));
          const start = cursor ? Number(cursor.split(":")[1]) : 0;
          const limit = Number(url.searchParams.get("limit") ?? "20");
          value = { items: rows.slice(start, start + limit).map(item => ({ ...item, kind: "external", roles: [], currentTask: null, busy: null })),
            nextCursor: start + limit < rows.length ? `${membership}:${start + limit}` : null, totals, observationCursor: "0",
            metadata: { generatedAt: stamp, sourceObservedAt: null, partial: false, limitations: [] },
            attention: { unansweredQuestions: 0, pendingMessages: 0, pendingAcceptance: null, unclassifiedSessions: 14 } };
        }
      }
      res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); return;
    }
    try {
      const path = url.pathname === "/" ? "index.html" : url.pathname;
      const body = await readFile(join(dist, path));
      res.writeHead(200, { "content-type": ({ ".html": "text/html", ".js": "text/javascript", ".css": "text/css" } as Record<string, string>)[extname(path)] ?? "application/octet-stream" });
      res.end(body);
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const browser = await chromium.launch({ headless: true }); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto(`${base}/#/p/${projectId}/operations`);
  await page.getByLabel("访问令牌").fill("fixture-token");
  await page.getByRole("button", { name: "进入", exact: true }).click();
  const sidebar = page.locator(".project-sidebar .session-navigation");
  await sidebar.locator(".session-nav-history").click();
  await sidebar.locator(".session-nav-error").waitFor();
  await sidebar.getByRole("button", { name: "加载更多历史 Session" }).click();
  await sidebar.locator(".session-nav-item").filter({ hasText: "历史会话 37" }).waitFor();
  assert.equal(await sidebar.locator(".session-nav-group").nth(1).locator(".session-nav-item").count(), 37);
  await sidebar.locator(".session-nav-error button").click();
  await sidebar.locator(".session-nav-error").waitFor();
  assert.equal(await sidebar.locator(".session-nav-group").nth(1).locator(".session-nav-item").count(), 37);
  await fetch(`${base}/__fixture/restore`);
  await sidebar.locator(".session-nav-error button").click();
  await sidebar.locator(".session-nav-error").waitFor({ state: "detached" });
  assert.equal(await sidebar.locator(".session-nav-group").nth(1).locator(".session-nav-item").count(), 51);
  const requests = await (await fetch(`${base}/__fixture/reads`)).json() as typeof reads;
  assert.equal(requests[0]?.membership, "current");
  assert.ok(requests.some(request => request.membership === "historical" && request.cursor === "historical:20"));
});
