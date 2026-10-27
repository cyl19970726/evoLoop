// Opt-in built-app regression: build workbench, then set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const modulePath = process.env.EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE;
const dist = resolve(import.meta.dirname, "../dist");
const projectId = "70000001-0000-4000-8000-000000000001";
const sessionId = "70000002-0000-4000-8000-000000000002";
const sessionKey = `owned:${sessionId}`;
const stamp = "2026-10-27T00:00:00.000Z";
const metadata = { generatedAt: stamp, sourceObservedAt: stamp, partial: false, limitations: [] };
const capability = { available: false, reason: "测试中不可用" };
const resources = Object.fromEntries(["configuredModel", "actualModel", "inputTokens", "outputTokens", "cost", "processMemory"]
  .map(key => [key, { value: null, unit: "", source: null, scope: "session", observedAt: null, interval: null, unavailableReason: "未记录" }]));
const source = { kind: "session", id: sessionId, revision: null, evidence: "project-record", href: "" };
function assignment(index: number, state: string, stale: boolean, assignmentState: "accepted" | "assigned" | "released" = "accepted") {
  const taskId = `7000001${index}-0000-4000-8000-00000000000${index}`;
  return { assignment: { projectId, taskId, version: 2, taskRevisionId: `old-${index}`, target: { kind: "owned", sessionId },
    recipientActorId: null, state: assignmentState, ack: assignmentState === "accepted" ? { method: "direct", actorId: "worker",
      observerActorId: "worker", evidence: "已确认", sourceRef: null, at: stamp } : null,
    actorId: "owner", reason: "测试", updatedAt: stamp },
    task: { id: taskId, title: `任务 ${index}`, state, revisionId: `current-${index}`, owner: "worker", relation: "accepted", source }, stale };
}
const snapshot = { session: { key: sessionKey, target: { kind: "owned", sessionId }, aliases: [], title: "终态分派测试会话",
  profile: null, kind: "owned", roles: [], membership: "current", membershipReason: "测试", runtimeState: "ready", busy: false,
  currentTask: null, latestBusinessRun: null, lastProgressAt: null, capabilities: { observe: capability,
    send: { ...capability, mode: "unavailable" }, open: { ...capability, ref: null }, interrupt: capability, close: capability },
  source, metadata }, observationCursor: "0", currentWork: null,
  assignments: [assignment(1, "done", true), assignment(2, "in_progress", true), assignment(3, "cancelled", true, "released")],
  roleTasks: [], queue: [], results: [], questions: [], activity: [], resources, metadata };

test("completed assignments remain historical while active stale assignments still need confirmation", {
  skip: !modulePath && "Set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE after building the workbench",
}, async t => {
  const { chromium } = (await import(pathToFileURL(modulePath!).href)).default;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname.startsWith("/api/")) {
      const root = `/api/projects/${projectId}`;
      let value: unknown = { items: [], nextCursor: null }, status = 200;
      if (url.pathname === "/api/session") value = { principal: { actorId: "reader", projectIds: [projectId], permissions: ["read"] }, capabilities: {} };
      else if (url.pathname === root) value = { id: projectId, title: "测试项目", createdAt: stamp };
      else if (url.pathname === `${root}/session-work/${encodeURIComponent(sessionKey)}`) value = snapshot;
      else if (url.pathname.includes("/recovery")) { status = 404; value = { message: "无恢复记录" }; }
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
  await page.goto(`${base}/#/p/${projectId}/runtime?session=${encodeURIComponent(sessionKey)}&tab=responsibilities`);
  await page.getByLabel("访问令牌").fill("fixture-token");
  await page.getByRole("button", { name: "进入", exact: true }).click();
  await page.getByRole("heading", { name: "终态分派测试会话" }).waitFor();
  const items = page.locator(".session-workspace-section li");
  await page.getByText("任务 1").waitFor();
  assert.match(await items.nth(0).innerText(), /任务已完成 · 历史分派（曾直接确认接手）/);
  assert.doesNotMatch(await items.nth(0).innerText(), /需重新确认/);
  assert.match(await items.nth(1).innerText(), /任务修订已变化，需重新确认/);
  assert.match(await items.nth(2).innerText(), /任务已取消 · 历史分派（已释放）/);
});
