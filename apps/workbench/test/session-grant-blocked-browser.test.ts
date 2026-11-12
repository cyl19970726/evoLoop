// Opt-in built-app regression (build the workbench, then set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE): a message that waits
// only for its sender's grant is shown as blocked, with what is missing, and does not make the page unusable.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { timelineAssistant, timelineMessage, timelinePage } from "./session-timeline-fixtures";

const modulePath = process.env.EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE;
const dist = resolve(import.meta.dirname, "../dist");
const projectId = "97000001-0000-4000-8000-000000000001";
const id = (n: number) => `97000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const sessionId = id(2), sessionKey = `owned:${sessionId}`;
const stamp = new Date(Date.now() - 64_000).toISOString();
const metadata = { generatedAt: stamp, sourceObservedAt: stamp, partial: false, limitations: [] };
const unavailable = { available: false, reason: "未开放" };
const resources = Object.fromEntries(["configuredModel", "actualModel", "inputTokens", "outputTokens", "cost", "processMemory"]
  .map(key => [key, { value: null, unit: "", source: null, scope: "session", observedAt: null, interval: null, unavailableReason: "未记录" }]));
const roles = [{ id: id(20), title: "项目统筹", state: "active", roleClass: "business", templateKey: null, responsibility: "统筹" }];
const leader = { key: sessionKey, target: { kind: "owned", sessionId }, aliases: [], title: "统筹", profile: null, identity: null, kind: "owned", roles,
  membership: "current", membershipReason: "fixture", runtimeState: "ready", busy: true, currentTask: null, latestBusinessRun: null, lastProgressAt: stamp,
  capabilities: { observe: { available: true, reason: null }, send: { available: true, reason: null, mode: "owned-conversation" },
    open: { ...unavailable, ref: null }, interrupt: unavailable, close: unavailable,
    ordinaryExecution: { state: "unverified", reasonCode: "fixture", reason: "执行前仍须核验。", observedAt: stamp } },
  source: { kind: "session", id: sessionId, revision: null, evidence: "project-record", href: "" }, metadata };
const taskIdOf = (n: number) => id(1000 + n);
const taskTitle = (n: number) => `第 ${n} 个新任务`;
const notice = (n: number) => `A Task was created for Leader triage.\nSource event: ${id(2000 + n)} at 2026-11-10T13:${String(10 + n).padStart(2, "0")}:00.000Z`
  + `\nSource Task revision: ${taskIdOf(n)}@${id(3000 + n)}\nSource actor: dev-claude-agent; source Session: ${id(4000 + n)}\nSource: task:${taskIdOf(n)}`
  + "\nThis is a historical source event that may have been superseded. Next responsibility: Leader reads the current Task, fixed source and any existing arrangement, then saves the next decision. This notice is not current acceptance, consumer use, or Task closure.";
const queuedId = (n: number) => id(500 + n);
const runningTurn = { id: "turn-2", state: "running", startedAt: stamp, completedAt: null, origin: { kind: "message", id: id(7), taskId: null, taskRevisionId: null, initiatingActorId: "reader" } };
const history = Array.from({ length: 30 }, (_, index) => [
  timelineMessage(`ask-${index}`, `第 ${index + 1} 个问题：请核对这一项并写出结论。`, { turnId: `turn-h${index}` }),
  timelineAssistant(`answer-${index}`, `第 ${index + 1} 个回答：已核对，结论如下。\n\n- 要点一\n- 要点二\n- 要点三`, { turnId: `turn-h${index}`, author: { kind: "session", id: sessionId, label: "统筹" } }),
]).flat();

const blockedReason = "MESSAGE_GRANT_MISSING: 没有发送这条消息的授权：私有配置 sessionMessages.grants 里没有 user-sim-agent → 这个 Session 的授权。在 sessionMessages.grants 加一项 {\"enabled\":true,\"sessionId\":\"s\",\"senderActorId\":\"user-sim-agent\",\"cwd\":\"/Users/gongshi006/.local/share/evoloop/workspaces/leader\"}（使用时重读，不需要重启）。消息没有保存。";
test("a message blocked for a missing grant is visible on the Session page with what is missing, and the page stays usable",
  { skip: !modulePath && "Set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE after building the workbench" }, async t => {
  const { chromium } = (await import(pathToFileURL(modulePath!).href)).default;
  const blocked = timelineMessage(id(700), "你好，Leader。", { state: "pending", blockedReason, author: { kind: "actor", id: "user-sim-agent", label: "user-sim-agent" },
    origin: { kind: "message", id: id(700), taskId: null, taskRevisionId: null, initiatingActorId: "user-sim-agent" } } as never);
  const behind = timelineMessage(id(701), "后面的通知", { state: "pending", author: { kind: "actor", id: "leader-notice", label: "leader-notice" },
    origin: { kind: "message", id: id(701), taskId: null, taskRevisionId: null, initiatingActorId: "leader-notice" } });
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, "http://127.0.0.1"); const root = `/api/projects/${projectId}`;
    if (url.pathname.startsWith("/api/")) {
      let value: unknown = { items: [], nextCursor: null, metadata }, status = 200;
      if (url.pathname === "/api/session") value = { principal: { actorId: "reader", projectIds: [projectId], permissions: ["read", "write", "review"] }, capabilities: {} };
      else if (url.pathname === root) value = { id: projectId, title: "授权受阻测试", createdAt: stamp };
      else if (url.pathname === `${root}/sessions/${sessionId}/direct-input-capability`) value = { available: false, mode: null, expectedTurnId: null, reasonCode: "DIRECT_STEER_DISABLED", observedAt: stamp };
      else if (url.pathname === `${root}/session-work`) value = { items: [leader], nextCursor: null, observationCursor: "1", metadata,
        totals: { current: 1, historical: 0, unclassified: 0 }, attention: { unansweredQuestions: 0, pendingMessages: 0, pendingAcceptance: null, unclassifiedSessions: 0 } };
      else if (url.pathname === `${root}/session-work/${encodeURIComponent(sessionKey)}`) value = { session: leader, observationCursor: "1", currentWork: null,
        assignments: [], roleTasks: [], queue: [], results: [], questions: [], activity: [], resources, metadata };
      else if (url.pathname === `${root}/session-work/${encodeURIComponent(sessionKey)}/timeline`)
        value = timelinePage(sessionKey, { title: "统筹", entries: history.slice(0, 6), pending: [blocked, behind], turns: [], liveTurns: [], activeTurnId: null });
      else if (url.pathname.endsWith("/timeline/updates")) value = { cursor: "1", resetRequired: false, entries: [], turns: [], freshness: "live", limitations: [], activeTurnId: null };
      else if (url.pathname.endsWith("/recovery")) { status = 404; value = { message: "无恢复记录" }; }
      else if (url.pathname === `${root}/runtime/runs` || url.pathname === `${root}/runtime/sessions` || url.pathname === `${root}/resident-queues`) value = [];
      else if (url.pathname === `${root}/runtime`) value = { available: true, error: null, allowedCwds: [], grants: [] };
      else if (url.pathname.startsWith(`${root}/work-management/tasks/`) || url.pathname.startsWith(`${root}/roles/`)) { status = 404; value = { message: "未登记" }; }
      res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); return;
    }
    try {
      const file = /^\/(?:$|p\/|ui$)/.test(url.pathname) ? "index.html" : url.pathname;
      const content = await readFile(join(dist, file));
      res.writeHead(200, { "content-type": ({ ".html": "text/html", ".js": "text/javascript", ".css": "text/css" } as Record<string, string>)[extname(file)] ?? "application/octet-stream" });
      res.end(content);
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done)); t.after(() => server.close());
  const browser = await chromium.launch({ headless: true }); t.after(() => browser.close());
  for (const viewport of [{ width: 1195, height: 914 }, { width: 390, height: 844 }]) {
    const page = await (await browser.newContext({ viewport })).newPage();
    const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${(server.address() as { port: number }).port}/p/${projectId}/sessions?${new URLSearchParams({ session: sessionKey })}`);
    await page.getByLabel("访问令牌").fill("fixture-token");
    await page.getByRole("button", { name: "进入", exact: true }).click();
    const notice = page.locator("[data-grant-blocked-notice]");
    await notice.waitFor();
    const text = await notice.innerText();
    assert.match(text, /有 1 条来自 user-sim-agent 的消息因缺少消息授权而受阻/);
    assert.match(text, /没有占用队列，后面的消息照常处理/);
    assert.match(text, /sessionMessages\.grants 里没有 user-sim-agent → 这个 Session 的授权/, "what is missing is named");
    assert.match(text, /维护者/, "who sets it up is named");
    assert.doesNotMatch(text, /[{}]|\/Users|workspaces\/leader|cwd/, "no configuration text and no local path on the page");
    assert.equal(await page.getByText("受阻：缺少消息授权").count(), 1, "the blocked message is tagged; the one behind it is an ordinary queued message");
    assert.equal(await page.getByText("排队中", { exact: true }).count() >= 1, true);
    const layout = await page.evaluate(`(() => { const t = document.querySelector(".workspace-timeline-scroll"); const c = document.querySelector(".session-composer-host").getBoundingClientRect();
      return { timeline: t.clientHeight, composerBottom: c.bottom, height: innerHeight, overflowX: document.documentElement.scrollWidth > innerWidth }; })()`) as { timeline: number; composerBottom: number; height: number; overflowX: boolean };
    assert.ok(layout.timeline >= 150 && layout.composerBottom <= layout.height && !layout.overflowX, JSON.stringify(layout));
    assert.deepEqual(errors, []);
  }
});
