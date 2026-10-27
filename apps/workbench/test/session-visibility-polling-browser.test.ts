// Opt-in built-app regression. Page visibility is overridden in a real Chrome page;
// this exercises the UI guard but is not an OS-hidden tab or production network trace.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const modulePath = process.env.EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE;
const dist = resolve(import.meta.dirname, "../dist");
const projectId = "80000001-0000-4000-8000-000000000001";
const ownedId = "80000002-0000-4000-8000-000000000002";
const externalId = "80000003-0000-4000-8000-000000000003";
const ownedKey = `owned:${ownedId}`;
const externalKey = `external:${externalId}`;
const stamp = "2026-10-27T00:00:00.000Z";
const visiblePollWindowMs = 7500; // Busy Session polling is every five seconds; allow scheduling margin.
const hiddenPollWindowMs = 11500; // Cross two scheduled ticks while the visibility guard is hidden.
const metadata = { generatedAt: stamp, sourceObservedAt: stamp, partial: false, limitations: [] };
const unavailable = { available: false, reason: "fixture unavailable" };
const resources = Object.fromEntries(["configuredModel", "actualModel", "inputTokens", "outputTokens", "cost", "processMemory"]
  .map(key => [key, { value: null, unit: "", source: null, scope: "session", observedAt: null, interval: null, unavailableReason: "未记录" }]));

function snapshot(key: string, updated = false) {
  const external = key === externalKey;
  const id = key.slice(key.indexOf(":") + 1);
  return { session: { key, target: external ? { kind: "external", linkId: id } : { kind: "owned", sessionId: id },
    aliases: [], title: external ? "外部测试会话" : "受管测试会话", profile: null, kind: external ? "external" : "owned",
    roles: [], membership: "current", membershipReason: "fixture", runtimeState: "busy", busy: true,
    currentTask: null, latestBusinessRun: null, lastProgressAt: null,
    capabilities: { observe: unavailable, send: { ...unavailable, mode: "unavailable" },
      open: { ...unavailable, ref: null }, interrupt: unavailable, close: unavailable },
    source: { kind: "session", id, revision: null, evidence: "project-record", href: "" }, metadata },
    observationCursor: updated ? "1" : "0", currentWork: null, assignments: [], roleTasks: [], queue: [], results: [], questions: [],
    activity: updated && !external ? [{ id: "fresh-activity", sequence: "1", sessionKey: key, kind: "note", summary: "新活动已显示",
      occurredAt: stamp, recordedAt: stamp, actorId: "reader", taskId: null, importance: "detail",
      source: { kind: "session", id, revision: null, evidence: "project-record", href: "" } }] : [],
    resources, metadata };
}

test("busy owned polling shows a fixture update, pauses under simulated hidden visibility, and external never reads recovery", {
  skip: !modulePath && "Set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE after building the workbench",
}, async t => {
  const { chromium } = (await import(pathToFileURL(modulePath!).href)).default;
  const counts = { ownedSnapshot: 0, externalSnapshot: 0, changes: 0, recovery: 0 };
  let updated = false, changeDelivered = false;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname === "/__fixture/counts") { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(counts)); return; }
    if (url.pathname === "/__fixture/update") { updated = true; res.end("ok"); return; }
    if (url.pathname.startsWith("/api/")) {
      const root = `/api/projects/${projectId}`;
      let value: unknown = { items: [], nextCursor: null, metadata }, status = 200;
      if (url.pathname === "/api/session") value = { principal: { actorId: "reader", projectIds: [projectId], permissions: ["read"] }, capabilities: {} };
      else if (url.pathname === root) value = { id: projectId, title: "测试项目", createdAt: stamp };
      else if (url.pathname === `${root}/session-work/changes`) {
        counts.changes++;
        const notify = updated && !changeDelivered && url.searchParams.get("cursor") === "0";
        if (notify) changeDelivered = true;
        value = { items: notify ? [{ sessionKeys: [ownedKey] }] : [], nextCursor: changeDelivered ? "1" : "0",
          hasMore: false, resetRequired: false, metadata };
      } else if (url.pathname.endsWith("/recovery")) {
        counts.recovery++; status = 404; value = { message: "无恢复记录" };
      } else if (url.pathname.endsWith("/messages")) value = { items: [], nextCursor: null, metadata };
      else if (url.pathname.startsWith(`${root}/session-work/`)) {
        const key = decodeURIComponent(url.pathname.slice(`${root}/session-work/`.length));
        if (key === externalKey) counts.externalSnapshot++; else counts.ownedSnapshot++;
        value = snapshot(key, updated);
      }
      res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); return;
    }
    try {
      const file = url.pathname === "/" ? "index.html" : url.pathname;
      const body = await readFile(join(dist, file));
      res.writeHead(200, { "content-type": ({ ".html": "text/html", ".js": "text/javascript", ".css": "text/css" } as Record<string, string>)[extname(file)] ?? "application/octet-stream" });
      res.end(body);
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const readCounts = async (): Promise<typeof counts> => (await (await fetch(`${base}/__fixture/counts`)).json()) as typeof counts;
  const browser = await chromium.launch({ headless: true, ...(process.env.EVOLOOP_BROWSER_TEST_EXECUTABLE_PATH
    ? { executablePath: process.env.EVOLOOP_BROWSER_TEST_EXECUTABLE_PATH } : {}) }); t.after(() => browser.close());
  const page = await browser.newPage();
  await page.goto(`${base}/#/p/${projectId}/runtime?session=${encodeURIComponent(ownedKey)}`);
  await page.getByLabel("访问令牌").fill("fixture-token");
  await page.getByRole("button", { name: "进入", exact: true }).click();
  await page.getByRole("heading", { name: "受管测试会话" }).waitFor();
  for (let i = 0; i < 30 && (await readCounts()).recovery === 0; i++) await page.waitForTimeout(50);
  assert.equal((await readCounts()).recovery > 0, true, "owned initial read requests recovery");

  const visibleStart = await readCounts();
  await page.waitForTimeout(visiblePollWindowMs);
  const visibleEnd = await readCounts();
  assert.equal(visibleEnd.ownedSnapshot > visibleStart.ownedSnapshot, true, "visible owned Session polls its snapshot for transient input");
  assert.equal(visibleEnd.recovery > visibleStart.recovery, true, "visible owned Session polls recovery");

  // Headless and headed Chrome in this host both reported two switched tabs as visible.
  // Override only the Page Visibility value and fire its event; retain real timers and HTTP.
  await page.evaluate('Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" }); document.dispatchEvent(new Event("visibilitychange"));');
  assert.equal(await page.evaluate(() => document.visibilityState), "hidden");
  const hiddenStart = await readCounts();
  await page.waitForTimeout(hiddenPollWindowMs);
  const hiddenEnd = await readCounts();
  assert.deepEqual(hiddenEnd, hiddenStart, "hidden guard issues no snapshot, changes, or recovery request across one poll period");

  await page.evaluate('Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" }); document.dispatchEvent(new Event("visibilitychange"));');
  for (let i = 0; i < 30 && (await readCounts()).ownedSnapshot === hiddenStart.ownedSnapshot; i++) await page.waitForTimeout(50);
  for (let i = 0; i < 30 && (await readCounts()).recovery === hiddenStart.recovery; i++) await page.waitForTimeout(50);
  const returned = await readCounts();
  assert.equal(returned.ownedSnapshot > hiddenStart.ownedSnapshot, true, "visible event immediately rereads snapshot");
  assert.equal(returned.recovery > hiddenStart.recovery, true, "visible reread requests recovery");

  const beforeUpdate = await readCounts();
  const injectedAt = Date.now();
  await fetch(`${base}/__fixture/update`);
  await page.getByText("新活动已显示").waitFor({ timeout: 8000 });
  const visibleDelayMs = Date.now() - injectedAt;
  const afterUpdate = await readCounts();
  assert.equal(afterUpdate.ownedSnapshot > beforeUpdate.ownedSnapshot, true, "owned Session sees a new snapshot without a change entry");

  const beforeExternal = await readCounts();
  await page.evaluate(([project, key]) => { location.hash = `#/p/${project}/runtime?session=${encodeURIComponent(key)}`; }, [projectId, externalKey]);
  await page.getByRole("heading", { name: "外部测试会话" }).waitFor();
  const externalStart = await readCounts();
  assert.equal(externalStart.recovery, beforeExternal.recovery, "external initial read never requests recovery");
  await page.waitForTimeout(visiblePollWindowMs);
  const externalEnd = await readCounts();
  assert.equal(externalEnd.changes > externalStart.changes, true, "external workspace still polls changes");
  assert.equal(externalEnd.recovery, externalStart.recovery, "external Session never requests recovery");
  t.diagnostic(JSON.stringify({ visibleStart, visibleEnd, hiddenStart, hiddenEnd, returned,
    beforeUpdate, afterUpdate, visibleDelayMs, beforeExternal, externalStart, externalEnd }));
});
