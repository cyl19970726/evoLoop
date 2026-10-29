// Opt-in built-app regression for the Session workspace's managed close entry.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const modulePath = process.env.EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE;
const dist = resolve(import.meta.dirname, "../dist");
const projectId = "94000001-0000-4000-8000-000000000001";
const sessionId = "94000002-0000-4000-8000-000000000002";
const taskId = "94000003-0000-4000-8000-000000000003";
const sessionKey = `owned:${sessionId}`;
const stamp = "2026-10-29T00:00:00.000Z";
const metadata = { generatedAt: stamp, sourceObservedAt: stamp, partial: false, limitations: [] };
const unavailable = { available: false, reason: "fixture" };
const source = { kind: "session", id: sessionId, revision: null, evidence: "project-record", href: "" };
const resources = Object.fromEntries(["configuredModel", "actualModel", "inputTokens", "outputTokens", "cost", "processMemory"]
  .map(key => [key, { value: null, unit: "", source: null, scope: "session", observedAt: null, interval: null, unavailableReason: "未记录" }]));

test("Session workspace exposes blockers, submits one close intent, and reads the original closing operation", {
  skip: !modulePath && "Set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE after building the workbench",
}, async t => {
  const { chromium } = (await import(pathToFileURL(modulePath!).href)).default;
  let blocked = true;
  let state: "ready" | "closing" | "closed" = "ready";
  let version = 1;
  let closeOperationId: string | null = null;
  let commandCount = 0;
  let lastCommand: Record<string, unknown> | null = null;
  const observedSession = () => ({ key: sessionKey, target: { kind: "owned", sessionId }, aliases: [], title: "关闭入口测试会话",
    profile: null, kind: "owned", roles: [], membership: "current", membershipReason: "fixture", runtimeState: state, busy: false,
    currentTask: null, latestBusinessRun: null, lastProgressAt: null,
    capabilities: { observe: unavailable, send: { ...unavailable, mode: "unavailable" }, open: { ...unavailable, ref: null },
      interrupt: unavailable, close: unavailable }, source, metadata });
  const snapshot = () => ({ session: observedSession(), observationCursor: "0", currentWork: null,
    assignments: blocked ? [{ assignment: { state: "accepted", taskId }, task: { id: taskId, title: "未完任务", state: "in_progress", relation: "accepted", source }, stale: false }]
      : Array.from({ length: 20 }, (_, index) => ({ assignment: { state: "accepted", taskId: `${taskId}:${index}` },
        task: { id: `${taskId}:${index}`, title: "已完成任务", state: "done", relation: "accepted", source }, stale: false })),
    roleTasks: [], queue: blocked ? [{ entryId: "claim", taskId, taskTitle: "未完任务", state: "claimed", position: 1, holdReason: null }] : [],
    results: [], questions: [], activity: [], resources,
    metadata: blocked ? metadata : { ...metadata, partial: true, limitations: ["活动首屏仅展示前20项，请从分页历史继续读取。"] } });
  const runtimeSession = () => ({ projectId, id: sessionId, roleId: "role", cwd: "/tmp", authorizationScope: "fixture",
    model: null, sandbox: "danger-full-access", approvalPolicy: "never", state, version, nativeThreadId: "thread",
    nativeSessionId: "native", operationId: "created", actorId: "owner", createdAt: stamp, updatedAt: stamp,
    closeOperationId, closeAttemptedAt: state === "ready" ? null : stamp, closeVerifiedAt: state === "closed" ? stamp : null });
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname === "/__fixture/clear") { blocked = false; res.end("ok"); return; }
    if (url.pathname === "/__fixture/closed") { state = "closed"; version++; res.end("ok"); return; }
    if (url.pathname.startsWith("/api/")) {
      const root = `/api/projects/${projectId}`;
      let value: unknown = { items: [], nextCursor: null, metadata }, status = 200;
      if (url.pathname === "/api/session") value = { principal: { actorId: "owner", projectIds: [projectId], permissions: ["read", "write", "review"] }, capabilities: {} };
      else if (url.pathname === root) value = { id: projectId, title: "测试项目", createdAt: stamp };
      else if (url.pathname === `${root}/session-work/${encodeURIComponent(sessionKey)}`) value = snapshot();
      else if (url.pathname === `${root}/runtime/sessions`) value = [runtimeSession()];
      else if (url.pathname === `${root}/runtime`) value = { available: true, error: null, allowedCwds: [], grants: [],
        faults: state === "closing" ? [{ sessionId, phase: "session_close", category: "native_rejected",
          nativeMethod: "thread/archive", nativeCode: -32600, nativeCategory: "rollout_not_found", observedAtUtc: stamp }] : [] };
      else if (url.pathname === `${root}/runtime/runs`) value = blocked ? [{ projectId, id: "run", sessionId, state: "running" }] : [];
      else if (url.pathname === `${root}/session-work/${encodeURIComponent(sessionKey)}/messages`) value = blocked ? {
        items: [{ projectId, id: "message", content: "待处理消息", createdAt: stamp, updatedAt: stamp,
          target: { kind: "owned", sessionId }, state: "queued" }], nextCursor: null, metadata } : {
        items: [{ projectId, id: `settled-${url.searchParams.get("cursor") ?? "0"}`, content: "已处理消息", createdAt: stamp,
          updatedAt: stamp, target: { kind: "owned", sessionId }, state: "replied" }],
        nextCursor: Number(url.searchParams.get("cursor") ?? "0") < 21
          ? String(Number(url.searchParams.get("cursor") ?? "0") + 1) : null, metadata: { ...metadata, partial: true,
          limitations: ["消息正文预览已截断。"] } };
      else if (url.pathname === "/api/commands" && req.method === "POST") {
        commandCount++;
        let body = ""; for await (const chunk of req) body += chunk;
        lastCommand = JSON.parse(body) as Record<string, unknown>;
        if (lastCommand.type === "runtime.session.close" && state === "ready" && !blocked && lastCommand.expectedVersion === version) {
          closeOperationId = String(lastCommand.operationId); state = "closing"; version++;
          value = { status: "applied", operationId: closeOperationId, entityId: sessionId, version };
        } else { status = 409; value = { message: "unexpected close" }; }
      } else if (url.pathname.endsWith("/recovery")) { status = 404; value = { message: "unavailable" }; }
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
  const page = await browser.newPage({ viewport: { width: 390, height: 840 } });
  await page.goto(`${base}/#/p/${projectId}/runtime?session=${encodeURIComponent(sessionKey)}`);
  await page.getByLabel("访问令牌").fill("fixture-token");
  await page.getByRole("button", { name: "进入", exact: true }).click();
  await page.getByRole("heading", { name: "关闭入口测试会话" }).waitFor();
  await page.getByRole("button", { name: "关闭受管 Session", exact: true }).click();
  const panel = page.getByRole("region", { name: "结束会话与历史归类" });
  await panel.getByText(/未完 Task/).waitFor();
  for (const label of ["队列占用", "Run", "消息"]) assert.match(await panel.innerText(), new RegExp(label));
  assert.equal(await panel.getByRole("button", { name: "请求关闭受管 Session" }).count(), 0);
  assert.equal(commandCount, 0);
  await fetch(`${base}/__fixture/clear`);
  await panel.getByRole("button", { name: "重新核对关闭条件" }).click();
  await panel.getByText(/未在本次已读范围发现/).waitFor();
  await panel.locator(".command-disclosure > summary").click();
  await panel.getByLabel("关闭理由与核对依据").fill("任务、队列、运行和消息均已核对");
  await panel.getByRole("button", { name: "请求关闭受管 Session" }).click();
  await panel.getByText(/原生归档已尝试/).waitFor();
  await panel.getByText(/错误码 -32600 · 安全类别 rollout_not_found/).waitFor();
  assert.equal(commandCount, 1);
  assert.equal(lastCommand?.type, "runtime.session.close");
  assert.equal(lastCommand?.sessionId, sessionId);
  assert.equal(lastCommand?.expectedVersion, 1);
  assert.match(await panel.innerText(), new RegExp(closeOperationId!));
  await panel.getByRole("button", { name: "重新核对关闭条件" }).click();
  assert.equal(commandCount, 1, "closing reads the original intent without resubmitting");
  await fetch(`${base}/__fixture/closed`);
  await panel.getByRole("button", { name: "重新核对关闭条件" }).click();
  await panel.getByText(/受管 Session 已关闭/).waitFor();
  assert.equal(commandCount, 1);
  assert.equal(await page.locator("body").evaluate(element => element.scrollWidth <= window.innerWidth), true);
});
