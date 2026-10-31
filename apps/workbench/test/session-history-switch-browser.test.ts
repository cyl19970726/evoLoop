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
const sessionA = "owned:60000002-0000-4000-8000-000000000002";
const sessionB = "owned:60000003-0000-4000-8000-000000000003";
const stamp = "2026-10-26T00:00:00.000Z";
const metadata = { generatedAt: stamp, sourceObservedAt: stamp, partial: false, limitations: [] };
const capability = { available: false, reason: "测试中不可用" };
const resources = Object.fromEntries(["configuredModel", "actualModel", "inputTokens", "outputTokens", "cost", "processMemory"]
  .map(key => [key, { value: null, unit: "", source: null, scope: "session", observedAt: null, interval: null, unavailableReason: "未记录" }]));
function snapshot(key: string) {
  const sessionId = key.slice("owned:".length);
  return { session: { key, target: { kind: "owned", sessionId }, aliases: [], title: key === sessionA ? "会话甲" : "会话乙",
    profile: null, kind: "owned", roles: [], membership: "current", membershipReason: "测试", runtimeState: "ready", busy: false,
    currentTask: null, latestBusinessRun: null, lastProgressAt: null, capabilities: { observe: capability,
      send: { ...capability, mode: "unavailable" }, open: { ...capability, ref: null }, interrupt: capability, close: capability },
    source: { kind: "session", id: sessionId, revision: null, evidence: "project-record", href: "" }, metadata },
    observationCursor: "0", currentWork: null, assignments: [], roleTasks: [], queue: [], results: [], questions: [], activity: [],
    resources, metadata };
}
function activity(key: string) {
  return { id: key === sessionA ? "activity-a" : "activity-b", sequence: "1", sessionKey: key, kind: "note",
    summary: key === sessionA ? "甲的历史记录" : "乙的历史记录", occurredAt: stamp, recordedAt: stamp,
    actorId: "reader", taskId: null, importance: "detail",
    source: { kind: "session", id: key.slice("owned:".length), revision: null, evidence: "project-record", href: "" } };
}

test("late history from session A cannot enter session B and B can load while A is pending", {
  skip: !modulePath && "Set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE after building the workbench",
}, async t => {
  const { chromium } = (await import(pathToFileURL(modulePath!).href)).default;
  let held = false, release: (() => void) | undefined;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname === "/__fixture/held") { res.end(String(held)); return; }
    if (url.pathname === "/__fixture/release") { release?.(); res.end("ok"); return; }
    if (url.pathname.startsWith("/api/")) {
      const root = `/api/projects/${projectId}`;
      let value: unknown = { items: [], nextCursor: null }, status = 200;
      if (url.pathname === "/api/session") value = { principal: { actorId: "reader", projectIds: [projectId], permissions: ["read"] }, capabilities: {} };
      else if (url.pathname === root) value = { id: projectId, title: "测试项目", createdAt: stamp };
      else if (url.pathname.endsWith("/activities")) {
        const key = decodeURIComponent(url.pathname.slice(`${root}/session-work/`.length, -"/activities".length));
        if (key === sessionA) { held = true; await new Promise<void>(resolve => { release = resolve; }); }
        value = { items: [activity(key)], nextCursor: null, metadata };
      } else if (url.pathname.endsWith("/messages")) value = { items: [], nextCursor: null, metadata };
      else if (url.pathname.startsWith(`${root}/session-work/`) && !url.pathname.endsWith("/changes")) {
        const key = decodeURIComponent(url.pathname.slice(`${root}/session-work/`.length));
        value = snapshot(key);
      } else if (url.pathname.includes("/recovery")) { status = 404; value = { message: "无恢复记录" }; }
      res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); return;
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
  await page.goto(`${base}/#/p/${projectId}/runtime?session=${encodeURIComponent(sessionA)}&filter=all`);
  await page.getByLabel("访问令牌").fill("fixture-token");
  await page.getByRole("button", { name: "进入", exact: true }).click();
  await page.getByRole("heading", { name: "会话甲" }).waitFor();
  await page.locator(".session-project-activity > summary").click();
  await page.getByRole("button", { name: "读取活动历史" }).click();
  for (let i = 0; i < 30 && await (await fetch(`${base}/__fixture/held`)).text() !== "true"; i++)
    await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(await (await fetch(`${base}/__fixture/held`)).text(), "true");
  await page.evaluate(([project, key]) => { window.location.hash = `#/p/${project}/runtime?session=${encodeURIComponent(key)}&filter=all`; }, [projectId, sessionB]);
  await page.getByRole("heading", { name: "会话乙" }).waitFor({ timeout: 3000 });
  const activityB = page.locator(".session-project-activity:visible");
  if (await activityB.getAttribute("open") === null) await activityB.locator("> summary").click();
  const loadB = page.getByRole("button", { name: "读取活动历史" });
  await loadB.waitFor({ timeout: 3000 });
  assert.equal(await loadB.isEnabled(), true, "the old request must not block the new session");
  await loadB.click();
  await page.getByText("乙的历史记录").waitFor();
  await fetch(`${base}/__fixture/release`);
  await page.waitForTimeout(100);
  assert.equal(await page.getByText("甲的历史记录").count(), 0);
  assert.equal(await page.getByText("乙的历史记录").count(), 1);
});
