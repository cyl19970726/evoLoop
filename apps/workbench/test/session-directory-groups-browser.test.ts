// Opt-in built-app regression: build workbench, then set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { timelinePage } from "./session-timeline-fixtures";

const modulePath = process.env.EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE;
const dist = resolve(import.meta.dirname, "../dist");
const projectId = "30000001-0000-4000-8000-000000000001";
const stamp = "2026-10-27T00:00:00.000Z";
const totals = { current: 51, historical: 37, unclassified: 14 };
const metadata = { generatedAt: stamp, sourceObservedAt: stamp, partial: false, limitations: [] };
const unavailable = { available: false, reason: "fixture unavailable" };
const resources = Object.fromEntries(["configuredModel", "actualModel", "inputTokens", "outputTokens", "cost", "processMemory"]
  .map(key => [key, { value: null, unit: "", source: null, scope: "session", observedAt: null, interval: null, unavailableReason: "未记录" }]));
const entries = {
  current: Array.from({ length: 51 }, (_, i) => ({ key: `external:current-${i}`, title: `当前成员 ${i + 1}`, membership: "current",
    roles: i < 6 ? [{ title: "业务", roleClass: "business" }] : i === 6 ? [{ title: "System", roleClass: "system" }] : [] })),
  historical: Array.from({ length: 37 }, (_, i) => ({ key: `external:historical-${i}`, title: `历史会话 ${i + 1}`, membership: "historical" })),
  unclassified: Array.from({ length: 14 }, (_, i) => ({ key: `external:unclassified-${i}`, title: `待归类会话 ${i + 1}`, membership: "unclassified" })),
};
function observed(item: { key: string; title: string; membership: string; roles?: { title: string; roleClass: string }[] }) {
  return { ...item, kind: "external", roles: item.roles ?? [],
    target: { kind: "external", linkId: "30000002-0000-4000-8000-000000000001" }, aliases: [], profile: null, identity: null,
    membershipReason: "fixture", runtimeState: null, currentTask: null, latestBusinessRun: null, lastProgressAt: null, busy: null,
    capabilities: { observe: unavailable, send: { ...unavailable, mode: "unavailable" }, open: { ...unavailable, ref: null }, interrupt: unavailable, close: unavailable },
    source: { kind: "host-link", id: "30000002-0000-4000-8000-000000000001", revision: null, evidence: "project-record", href: "" }, metadata };
}

test("Session navigation retains order, pages and filters across selection, back navigation and category retry", { skip: !modulePath && "Set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE" }, async t => {
  const { chromium } = (await import(pathToFileURL(modulePath!).href)).default;
  let unclassifiedUnavailable = true;
  let holdCurrentPage = false;
  let releaseCurrentPage: (() => void) | null = null;
  const reads: Array<{ membership: string; cursor: string | null; search: string }> = [];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname === "/__fixture/restore") { unclassifiedUnavailable = false; res.end("ok"); return; }
    if (url.pathname === "/__fixture/reads") { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(reads)); return; }
    if (url.pathname === "/__fixture/hold") { holdCurrentPage = true; res.end("ok"); return; }
    if (url.pathname === "/__fixture/release") { releaseCurrentPage?.(); holdCurrentPage = false; res.end("ok"); return; }
    if (url.pathname === "/__fixture/pending") { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ pending: !!releaseCurrentPage })); return; }
    if (url.pathname.startsWith("/api/")) {
      const root = `/api/projects/${projectId}`;
      let value: unknown = { items: [], nextCursor: null }, status = 200;
      if (url.pathname === "/api/session") value = { principal: { actorId: "reader", projectIds: [projectId], permissions: ["read"] }, capabilities: {} };
      else if (url.pathname === root) value = { id: projectId, title: "目录回归项目", createdAt: stamp };
      else if (url.pathname === `${root}/session-work`) {
        const membership = url.searchParams.get("membership") ?? "current";
        const cursor = url.searchParams.get("cursor");
        reads.push({ membership, cursor, search: url.searchParams.get("search") ?? "" });
        if (membership === "current" && cursor === "current:45" && holdCurrentPage) {
          await new Promise<void>(resolve => { releaseCurrentPage = resolve; });
          releaseCurrentPage = null;
        }
        if (membership === "unclassified" && unclassifiedUnavailable) { status = 503; value = { message: "temporary fixture failure" }; }
        else {
          const search = url.searchParams.get("search") ?? "";
          const rows = (entries[membership as keyof typeof entries] ?? []).filter(item => item.title.includes(search));
          const start = cursor ? Number(cursor.split(":")[1]) : 0;
          const limit = Number(url.searchParams.get("limit") ?? "20");
          const pageLimit = membership === "current" && start === 0 ? 5 : limit;
          value = { items: rows.slice(start, start + pageLimit).map(observed),
            nextCursor: start + pageLimit < rows.length ? `${membership}:${start + pageLimit}` : null, totals, observationCursor: "0",
            metadata,
            attention: { unansweredQuestions: 0, pendingMessages: 0, pendingAcceptance: null, unclassifiedSessions: 14 } };
        }
      }
      else if (url.pathname.startsWith(`${root}/session-work/`)) {
        const key = decodeURIComponent(url.pathname.slice(`${root}/session-work/`.length));
        if (key.endsWith("/timeline/updates")) value = { cursor: "1", resetRequired: false, entries: [], turns: [], freshness: "live", limitations: [] };
        else if (key.endsWith("/timeline")) value = timelinePage(key.slice(0, -"/timeline".length), { title: "当前成员" });
        else if (key.endsWith("/messages")) value = { items: [], nextCursor: null, metadata };
        else if (key === "changes") value = { items: [], nextCursor: "1", hasMore: false, resetRequired: false, metadata };
        else {
          const item = Object.values(entries).flat().find(entry => entry.key === key);
          if (item) value = { session: observed(item), observationCursor: "0", currentWork: null, assignments: [], roleTasks: [], queue: [], results: [], questions: [], activity: [], resources, metadata, nativeObservation: null };
          else { status = 404; value = { message: "fixture session not found" }; }
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
  const browser = await chromium.launch({ headless: true, ...(process.env.EVOLOOP_BROWSER_TEST_EXECUTABLE_PATH
    ? { executablePath: process.env.EVOLOOP_BROWSER_TEST_EXECUTABLE_PATH } : {}) }); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto(`${base}/#/p/${projectId}/sessions`);
  await page.getByLabel("访问令牌").fill("fixture-token");
  await page.getByRole("button", { name: "进入", exact: true }).click();
  const navigationToggle = page.getByRole("button", { name: /^(展开|收起)项目导航$/ });
  if (await navigationToggle.getAttribute("aria-expanded") !== "true") await navigationToggle.click();
  const sidebar = page.locator(".project-sidebar .session-navigation");
  const current = sidebar.locator(".session-nav-current");
  await current.getByText("业务 Session · 已加载 5", { exact: true }).waitFor();
  assert.equal(await current.locator(".session-nav-item").count(), 5,
    "the Sessions root shows all five rows in its first current page");
  const firstPageOrder = await current.locator(".session-nav-item").evaluateAll(nodes => nodes.map(node => node.getAttribute("href")));
  await current.locator(".session-nav-item").nth(2).click();
  await page.waitForURL(/session=external%3Acurrent-2/);
  await current.locator('.session-nav-item[aria-current="page"]').waitFor();
  await page.getByRole("heading", { name: "当前成员 3" }).waitFor();
  assert.deepEqual(await current.locator(".session-nav-item").evaluateAll(nodes => nodes.map(node => node.getAttribute("href"))), firstPageOrder,
    "opening a detail keeps every loaded Session in its original position");
  assert.equal(await current.locator(".session-nav-item[aria-current=page]").count(), 1);
  await current.locator(".session-nav-item").nth(0).click();
  await page.waitForURL(/session=external%3Acurrent-0/);
  await current.locator('.session-nav-item[aria-current="page"][href*="current-0"]').waitFor();
  await page.getByRole("heading", { name: "当前成员 1" }).waitFor();
  assert.equal(await page.getByRole("heading", { name: "当前成员 3" }).count(), 0,
    "the previous Session detail is no longer visible");
  assert.deepEqual(await current.locator(".session-nav-item").evaluateAll(nodes => nodes.map(node => node.getAttribute("href"))), firstPageOrder,
    "switching Session changes selection without reordering the directory");
  await sidebar.getByRole("button", { name: "加载更多当前 Session" }).click();
  await current.getByText("当前成员 25", { exact: true }).waitFor();
  await sidebar.getByRole("button", { name: "加载更多当前 Session" }).click();
  await current.getByText("当前成员 45", { exact: true }).waitFor();
  await fetch(`${base}/__fixture/hold`);
  await sidebar.getByRole("button", { name: "加载更多当前 Session" }).click();
  await page.waitForFunction(async base => (await (await fetch(`${base}/__fixture/pending`)).json()).pending, base);
  await sidebar.getByRole("textbox", { name: "搜索 Session 名称或职责" }).fill("当前成员 24");
  await page.waitForFunction(() => document.querySelectorAll(".project-sidebar .session-nav-current .session-nav-item").length === 0);
  await fetch(`${base}/__fixture/release`);
  await page.waitForFunction(() => document.querySelectorAll(".project-sidebar .session-nav-current .session-nav-item").length === 1);
  await current.getByText("当前成员 24", { exact: true }).waitFor();
  await sidebar.getByRole("textbox", { name: "搜索 Session 名称或职责" }).fill("");
  await page.waitForFunction(() => document.querySelectorAll(".project-sidebar .session-nav-current .session-nav-item").length === 5);
  assert.equal(await current.locator(".session-nav-item").count(), 5,
    "a stale page response during the search debounce must not restore the old page count");
  const afterSearchReads = await (await fetch(`${base}/__fixture/reads`)).json() as typeof reads;
  assert.equal(afterSearchReads.at(-1)?.cursor, null, "clearing search reads only the bounded first page");
  await sidebar.getByRole("button", { name: "加载更多当前 Session" }).click();
  await current.getByText("当前成员 25", { exact: true }).waitFor();
  await sidebar.getByRole("button", { name: "加载更多当前 Session" }).click();
  await current.getByText("当前成员 45", { exact: true }).waitFor();
  await sidebar.getByRole("button", { name: "加载更多当前 Session" }).click();
  await current.getByText("当前成员 51", { exact: true }).waitFor();
  assert.equal(await current.locator(".session-nav-item").count(), 51,
    "the Sessions root continues until all 51 current rows are loaded");
  assert.deepEqual(await current.locator(".session-nav-class > span").allTextContents(),
    ["业务 Session · 已加载 6", "System Session · 已加载 1", "待归类 · 已加载 44"]);
  await current.locator(".session-nav-item").first().click();
  await page.waitForURL(/session=external%3Acurrent-0/);
  await page.setViewportSize({ width: 1920, height: 1200 });
  if (process.env.EVOLOOP_SESSION_NAV_SCREENSHOT) await page.screenshot({ path: process.env.EVOLOOP_SESSION_NAV_SCREENSHOT });
  await page.setViewportSize({ width: 1280, height: 800 });
  await sidebar.locator(".session-nav-history").click();
  await current.locator(".session-nav-item").nth(44).scrollIntoViewIfNeeded();
  const priorScroll = await sidebar.evaluate(element => element.scrollTop);
  await current.locator(".session-nav-item").nth(44).click();
  await page.waitForURL(/session=external%3Acurrent-44/);
  await page.getByRole("heading", { name: "当前成员 45" }).waitFor();
  assert.equal(await sidebar.evaluate(element => element.scrollTop), priorScroll,
    "selection keeps the Session sidebar scroll position");
  assert.equal(await sidebar.locator(".session-nav-history").getAttribute("aria-expanded"), "true",
    "history expansion survives a Session switch");
  assert.equal(await current.locator(".session-nav-item").count(), 51,
    "loaded pages remain accessible in a Session detail");
  assert.equal(await page.locator(".sessions-directory-page:visible").count(), 0,
    "the selected Session keeps the directory in navigation instead of adding a second visible catalog");
  await page.goBack();
  await page.waitForURL(/session=external%3Acurrent-0/);
  assert.equal(await current.locator(".session-nav-item").count(), 51, "browser back preserves loaded pages");
  await page.setViewportSize({ width: 390, height: 700 });
  await page.getByRole("button", { name: "打开项目导航" }).click();
  await page.locator('.mobile-navigation[data-state="open"]').waitFor();
  const mobileCurrent = page.locator(".mobile-navigation .session-nav-current");
  await mobileCurrent.getByText("当前成员 51", { exact: true }).waitFor();
  assert.equal(await mobileCurrent.locator(".session-nav-item").count(), 51,
    "the narrow drawer reads the same loaded page range as the desktop navigation");
  await mobileCurrent.getByText("当前成员 51", { exact: true }).scrollIntoViewIfNeeded();
  assert.ok(await mobileCurrent.getByText("当前成员 51", { exact: true }).isVisible(),
    "the last loaded Session remains reachable in the narrow navigation drawer");
  const mobileScroll = await page.locator(".mobile-navigation").evaluate(element => element.scrollTop);
  await mobileCurrent.locator(".session-nav-item").last().click();
  await page.waitForURL(/session=external%3Acurrent-50/);
  await page.getByRole("button", { name: "打开项目导航" }).click();
  await page.locator('.mobile-navigation[data-state="open"]').waitFor();
  await mobileCurrent.getByText("当前成员 51", { exact: true }).waitFor();
  assert.equal(await mobileCurrent.locator(".session-nav-item").count(), 51,
    "closing the drawer to select a Session preserves its loaded pages");
  await page.waitForFunction(expected => Math.abs((document.querySelector(".mobile-navigation")?.scrollTop ?? 0) - expected) < 3, mobileScroll);
  await page.waitForFunction(() => { const box = document.querySelector('.mobile-navigation[data-state="open"]')?.getBoundingClientRect();
    return !!box && box.x >= -1 && box.right > 0; });
  const drawerBox = await page.locator('.mobile-navigation[data-state="open"]').boundingBox();
  assert.ok(drawerBox && drawerBox.x >= -1 && drawerBox.x + drawerBox.width > 0,
    "reopened navigation drawer is on screen");
  if (process.env.EVOLOOP_SESSION_NAV_NARROW_SCREENSHOT) await page.screenshot({ path: process.env.EVOLOOP_SESSION_NAV_NARROW_SCREENSHOT });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true,
    "the narrow Session detail has no page-wide horizontal overflow");
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 1280, height: 800 });
  await sidebar.getByRole("textbox", { name: "搜索 Session 名称或职责" }).fill("当前成员 24");
  await page.waitForFunction(() => document.querySelectorAll(".project-sidebar .session-nav-current .session-nav-item").length === 1);
  await current.getByText("当前成员 24", { exact: true }).waitFor();
  assert.equal(await current.locator(".session-nav-item").count(), 1, "search narrows the loaded directory without changing the selected route");
  await current.locator(".session-nav-item").click();
  await page.waitForURL(/session=external%3Acurrent-23/);
  assert.equal(await sidebar.getByRole("textbox", { name: "搜索 Session 名称或职责" }).inputValue(), "当前成员 24",
    "the search term survives navigation to its matching Session");
  await sidebar.getByRole("textbox", { name: "搜索 Session 名称或职责" }).fill("");
  await page.waitForFunction(() => document.querySelectorAll(".project-sidebar .session-nav-current .session-nav-item").length === 5);
  assert.equal(await current.locator(".session-nav-item").count(), 5, "clearing search restores the first bounded page");
  const deepLink = await browser.newPage({ viewport: { width: 1920, height: 1200 } });
  await deepLink.goto(`${base}/#/p/${projectId}/sessions?session=external%3Acurrent-4`);
  await deepLink.getByLabel("访问令牌").fill("fixture-token");
  await deepLink.getByRole("button", { name: "进入", exact: true }).click();
  const deepCurrent = deepLink.locator(".project-sidebar .session-nav-current");
  await deepCurrent.getByText("当前成员 5", { exact: true }).waitFor();
  assert.equal(await deepCurrent.locator(".session-nav-item").count(), 5, "direct entry keeps the bounded directory available");
  assert.equal(await deepCurrent.locator('.session-nav-item[aria-current="page"][href*="current-4"]').count(), 1);
  await deepLink.close();
  if (await sidebar.locator(".session-nav-history").getAttribute("aria-expanded") !== "true") await sidebar.locator(".session-nav-history").click();
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
