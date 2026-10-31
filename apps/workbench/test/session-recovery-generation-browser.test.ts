// Opt-in built-app Chrome regression for same-Session snapshot/recovery response order.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const modulePath = process.env.EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE;
const dist = resolve(import.meta.dirname, "../dist");
const projectId = "90000001-0000-4000-8000-000000000001";
const sessionId = "90000002-0000-4000-8000-000000000002";
const sessionKey = `owned:${sessionId}`;
const stamp = "2026-10-27T00:00:00.000Z";
const metadata = { generatedAt: stamp, sourceObservedAt: stamp, partial: false, limitations: [] };
const unavailable = { available: false, reason: "fixture unavailable" };
const resources = Object.fromEntries(["configuredModel", "actualModel", "inputTokens", "outputTokens", "cost", "processMemory"]
  .map(key => [key, { value: null, unit: "", source: null, scope: "session", observedAt: null, interval: null, unavailableReason: "未记录" }]));
const snapshot = { session: { key: sessionKey, target: { kind: "owned", sessionId }, aliases: [], title: "恢复竞态会话", profile: null,
  kind: "owned", roles: [], membership: "current", membershipReason: "fixture", runtimeState: "busy", busy: true,
  currentTask: null, latestBusinessRun: null, lastProgressAt: null,
  capabilities: { observe: unavailable, send: { ...unavailable, mode: "unavailable" },
    open: { ...unavailable, ref: null }, interrupt: unavailable, close: unavailable },
  source: { kind: "session", id: sessionId, revision: null, evidence: "project-record", href: "" }, metadata },
  observationCursor: "0", currentWork: null, assignments: [], roleTasks: [], queue: [], results: [], questions: [], activity: [],
  resources, metadata };
const recovery = (sequence: number) => ({ sessionId, executionProfile: null,
  gate: sequence === 3 ? { projectId, sessionId, phase: "blocked", causeKind: "run", causeId: null,
    causeState: "unknown", reason: "新一轮恢复结果", queueId: null, claimId: null, retryRunId: null,
    resumeMessageId: null, decisionOperationId: null, updatedAt: stamp } : null,
  decisions: [], queues: [], nextAction: sequence === 3 ? "reconcile_original_operation" : "normal_work",
  partial: false, observedAtUtc: stamp });

test("late recovery from an older snapshot cannot overwrite failure or a newer recovery view", {
  skip: !modulePath && "Set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE after building the workbench",
}, async t => {
  const { chromium } = (await import(pathToFileURL(modulePath!).href)).default;
  let snapshotReads = 0, recoveryReads = 0;
  const releases = new Map<number, () => void>();
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname === "/__fixture/counts") { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ snapshotReads, recoveryReads })); return; }
    if (url.pathname === "/__fixture/release") { releases.get(Number(url.searchParams.get("number")))?.(); res.end("ok"); return; }
    if (url.pathname.startsWith("/api/")) {
      const root = `/api/projects/${projectId}`;
      let value: unknown = { items: [], nextCursor: null, metadata }, status = 200;
      if (url.pathname === "/api/session") value = { principal: { actorId: "reader", projectIds: [projectId], permissions: ["read"] }, capabilities: {} };
      else if (url.pathname === root) value = { id: projectId, title: "测试项目", createdAt: stamp };
      else if (url.pathname.endsWith("/recovery")) {
        recoveryReads++;
        const number = recoveryReads;
        if (number <= 2) await new Promise<void>(resolve => releases.set(number, resolve));
        value = recovery(number);
      } else if (url.pathname === `${root}/session-work/${encodeURIComponent(sessionKey)}`) {
        snapshotReads++;
        if (snapshotReads === 2) { status = 503; value = { message: "较新快照失败" }; }
        else value = { ...snapshot, metadata: { ...metadata, generatedAt: new Date(Date.parse(stamp) + snapshotReads * 1000).toISOString() } };
      } else if (url.pathname.endsWith("/messages")) value = { items: [], nextCursor: null, metadata };
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
  const counts = async () => (await (await fetch(`${base}/__fixture/counts`)).json()) as { snapshotReads: number; recoveryReads: number };
  const waitCount = async (name: "snapshotReads" | "recoveryReads", number: number) => {
    for (let i = 0; i < 50 && (await counts())[name] < number; i++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal((await counts())[name] >= number, true, `${name} reaches ${number}`);
  };
  const browser = await chromium.launch({ headless: true, ...(process.env.EVOLOOP_BROWSER_TEST_EXECUTABLE_PATH
    ? { executablePath: process.env.EVOLOOP_BROWSER_TEST_EXECUTABLE_PATH } : {}) }); t.after(() => browser.close());
  const page = await browser.newPage();
  await page.goto(`${base}/#/p/${projectId}/runtime?session=${encodeURIComponent(sessionKey)}`);
  await page.getByLabel("访问令牌").fill("fixture-token");
  await page.getByRole("button", { name: "进入", exact: true }).click();
  await page.getByRole("heading", { name: "恢复竞态会话" }).waitFor();
  await page.locator(".session-information:visible > summary").click();
  await waitCount("recoveryReads", 1); // Old recovery GET is still held.

  await page.evaluate('document.dispatchEvent(new Event("visibilitychange"));');
  await waitCount("snapshotReads", 2);
  const recoveryOverview = page.locator(".session-information .session-recovery-overview");
  await recoveryOverview.getByText("请先重新读取当前会话。").waitFor();
  await fetch(`${base}/__fixture/release?number=1`);
  await page.waitForTimeout(100);
  assert.equal(await recoveryOverview.getByText("请先重新读取当前会话。").count(), 1,
    "old recovery cannot erase a newer snapshot failure");
  assert.equal(await recoveryOverview.getByText("没有持久恢复记录", { exact: false }).count(), 0);

  await page.evaluate('document.dispatchEvent(new Event("visibilitychange"));');
  await waitCount("recoveryReads", 2); // Recovery for successful snapshot 3 is held.
  await page.evaluate('document.dispatchEvent(new Event("visibilitychange"));');
  await waitCount("snapshotReads", 4);
  await fetch(`${base}/__fixture/release?number=2`);
  await waitCount("recoveryReads", 3);
  await recoveryOverview.getByText("已停止接续").waitFor();
  await recoveryOverview.getByText("查看原始恢复原因与状态代码").click();
  await page.getByText("新一轮恢复结果").waitFor();
  assert.equal(await page.getByText("已停止接续").count() > 0, true, "newer recovery wins after same-Session snapshot reread");
  t.diagnostic(JSON.stringify(await counts()));
});
