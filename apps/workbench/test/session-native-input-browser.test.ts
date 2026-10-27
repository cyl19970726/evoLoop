// Opt-in built-app regression for the native input projection and operation-backed reply.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const modulePath = process.env.EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE;
const dist = resolve(import.meta.dirname, "../dist");
const projectId = "93000001-0000-4000-8000-000000000001";
const sessionId = "93000002-0000-4000-8000-000000000002";
const sessionKey = `owned:${sessionId}`;
const requestId = "93000003-0000-4000-8000-000000000003";
const stamp = "2026-10-27T00:00:00.000Z";
const metadata = { generatedAt: stamp, sourceObservedAt: stamp, partial: false, limitations: [] };
const unavailable = { available: false, reason: "fixture unavailable" };
const resources = Object.fromEntries(["configuredModel", "actualModel", "inputTokens", "outputTokens", "cost", "processMemory"]
  .map(key => [key, { value: null, unit: "", source: null, scope: "session", observedAt: null, interval: null, unavailableReason: "未记录" }]));

test("native question stays bound to its Session and one exact operation, then distinguishes saved from resolved", {
  skip: !modulePath && "Set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE after building the workbench",
}, async t => {
  const { chromium } = (await import(pathToFileURL(modulePath!).href)).default;
  let state: "pending" | "response_saved" | "resolved" = "pending";
  let version = 1;
  let wrongSession = false;
  let failSnapshot = false;
  let postCount = 0;
  let command: Record<string, unknown> | null = null;
  const nativeInput = () => ({ id: requestId, sessionId: wrongSession ? "other-session" : sessionId, version,
    turnId: "turn-1", itemId: "item-1", questions: [{ id: "choice", header: "方式", question: "请选择处理方式",
      isOther: true, options: [{ label: "采用当前布局", description: "按已确认布局继续" }, { label: "重新设计", description: "先调整预览" }] }],
    isBlocking: true, state, source: { kind: "run", runId: "93000004-0000-4000-8000-000000000004",
      operationId: "93000005-0000-4000-8000-000000000005", actorId: "operator",
      taskId: "93000006-0000-4000-8000-000000000006", taskRevisionId: "93000007-0000-4000-8000-000000000007" },
    canReply: state === "pending", reason: state === "resolved" ? "native_resolved" : null,
    response: state === "pending" ? null : { operationId: String(command?.operationId), actorId: "operator",
      answers: { choice: ["采用当前布局"] }, savedAt: stamp, attemptedAt: null, submittedAt: null, outcome: "pending" },
    createdAt: stamp, updatedAt: stamp });
  const snapshot = () => ({ session: { key: sessionKey, target: { kind: "owned", sessionId }, aliases: [], title: "原生提问测试会话",
    profile: null, kind: "owned", roles: [], membership: "current", membershipReason: "fixture", runtimeState: "busy", busy: true,
    currentTask: null, latestBusinessRun: null, lastProgressAt: null,
    capabilities: { observe: unavailable, send: { ...unavailable, mode: "unavailable" },
      open: { ...unavailable, ref: null }, interrupt: unavailable, close: unavailable },
    source: { kind: "session", id: sessionId, revision: null, evidence: "project-record", href: "" }, metadata },
    observationCursor: "0", currentWork: null, assignments: [], roleTasks: [], queue: [], results: [], questions: [], activity: [],
    resources, metadata, nativeInputRequests: [nativeInput()] });
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname === "/__fixture/set") {
      const next = url.searchParams.get("state");
      if (next === "pending" || next === "response_saved" || next === "resolved") state = next;
      wrongSession = url.searchParams.has("wrongSession"); failSnapshot = url.searchParams.has("failSnapshot");
      res.end("ok"); return;
    }
    if (url.pathname.startsWith("/api/")) {
      const root = `/api/projects/${projectId}`;
      let value: unknown = { items: [], nextCursor: null, metadata }, status = 200;
      if (url.pathname === "/api/session") value = { principal: { actorId: "operator", projectIds: [projectId], permissions: ["read", "write", "review"] }, capabilities: {} };
      else if (url.pathname === root) value = { id: projectId, title: "测试项目", createdAt: stamp };
      else if (url.pathname === "/api/commands" && req.method === "POST") {
        postCount++;
        let body = ""; for await (const chunk of req) body += chunk;
        command = JSON.parse(body) as Record<string, unknown>;
        if (command.type === "session.input.reply" && command.inputRequestId === requestId && command.expectedVersion === version) {
          state = "response_saved"; version++;
          value = { status: "applied", operationId: command.operationId, entityId: requestId, version };
        } else { status = 409; value = { message: "错误的原生请求身份" }; }
      } else if (url.pathname === `${root}/session-work/${encodeURIComponent(sessionKey)}`) {
        if (failSnapshot) { status = 503; value = { message: "暂时不可读取" }; }
        else value = snapshot();
      } else if (url.pathname.endsWith("/recovery")) { status = 404; value = { message: "无恢复记录" }; }
      else if (url.pathname.endsWith("/messages")) value = { items: [], nextCursor: null, metadata };
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
  await page.getByRole("heading", { name: "原生提问测试会话" }).waitFor();
  const question = page.locator(".native-session-panel > .native-question-card");
  await question.getByText("请选择处理方式").waitFor();
  assert.equal(await page.locator("body").evaluate(element => element.scrollWidth <= window.innerWidth), true, "mobile workspace has no horizontal overflow");
  await question.getByText("采用当前布局").click();
  await question.getByRole("button", { name: "确认回答" }).click();
  await question.getByText("答复已保存").waitFor();
  assert.equal(postCount, 1, "one operation submits the exact native answer");
  assert.deepEqual((command?.answers as Record<string, string[]>), { choice: ["采用当前布局"] });
  assert.equal(command?.inputRequestId, requestId);
  assert.equal(command?.expectedVersion, 1);
  assert.equal(await question.getByRole("button", { name: "确认回答" }).count(), 0, "saved reply cannot be sent again");

  await fetch(`${base}/__fixture/set?state=resolved`);
  await page.getByRole("button", { name: "重新读取" }).click();
  await page.getByText("已结束的原生提问").waitFor();
  assert.equal(await question.count(), 0, "closed question leaves the active area");

  await fetch(`${base}/__fixture/set?state=pending&wrongSession=1`);
  await page.getByRole("button", { name: "重新读取" }).click();
  await page.getByText("原生提问身份或状态无法核实").waitFor();
  assert.equal(await page.getByRole("button", { name: "确认回答" }).count(), 0, "foreign Session input cannot be answered");

  await fetch(`${base}/__fixture/set?state=pending&failSnapshot=1`);
  await page.getByRole("button", { name: "重新读取" }).click();
  await page.locator(".native-session-panel .native-panel-warning").filter({ hasText: "暂时不可读取" }).first().waitFor();
  assert.equal(await page.getByRole("button", { name: "确认回答" }).count(), 0, "failed reread cannot enable answer");
  assert.equal(postCount, 1);
});
