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
const ownedId = "70000002-0000-4000-8000-000000000002";
const legacyId = "70000003-0000-4000-8000-000000000003";
const externalId = "70000004-0000-4000-8000-000000000004";
const revokedId = "70000005-0000-4000-8000-000000000005";
const keys = { disabled: `owned:${ownedId}`, legacy: `owned:${legacyId}`, manual: `external:${externalId}`, revoked: `external:${revokedId}` };
const stamp = "2026-10-27T00:00:00.000Z";
const metadata = { generatedAt: stamp, sourceObservedAt: stamp, partial: false, limitations: [] };
const unavailable = { available: false, reason: "未开放" };
const resources = Object.fromEntries(["configuredModel", "actualModel", "inputTokens", "outputTokens", "cost", "processMemory"]
  .map(key => [key, { value: null, unit: "", source: null, scope: "session", observedAt: null, interval: null, unavailableReason: "未记录" }]));
function snapshot(key: string, disabledReason: string) {
  const external = key === keys.manual || key === keys.revoked;
  const id = key.slice(key.indexOf(":") + 1);
  const target = external ? { kind: "external", linkId: id } : { kind: "owned", sessionId: id };
  const send = key === keys.legacy ? { available: false, reason: "当前身份只有读取权限。", mode: "unavailable" }
    : key === keys.revoked ? { available: false, reason: "外部连接已撤销。", mode: "unavailable" }
    : { available: true, reason: external ? "外部消息仅保存" : "当前可保存待处理消息", mode: external ? "manual-handoff" : "owned-conversation" };
  const ordinaryExecution = key === keys.disabled ? { state: "disabled", reasonCode: "SESSION_MESSAGES_DISABLED",
    reason: disabledReason, observedAt: stamp }
    : key === keys.manual ? { state: "manual", reasonCode: "EXTERNAL_HANDOFF", reason: "需人工转交原会话。", observedAt: stamp }
      : key === keys.revoked ? { state: "blocked", reasonCode: "EXTERNAL_LINK_REVOKED", reason: "已撤销的连接不可人工转交。", observedAt: stamp } : undefined;
  return { session: { key, target, aliases: [], title: key === keys.disabled ? "关闭自动回复的会话" : key === keys.legacy ? "旧版只读会话" : key === keys.revoked ? "已撤销外部会话" : "外部会话",
    profile: null, kind: external ? "external" : "owned", roles: [], membership: "current", membershipReason: "测试",
    runtimeState: external ? null : "ready", busy: external ? null : false, currentTask: null, latestBusinessRun: null,
    lastProgressAt: null, capabilities: { observe: unavailable, send, open: { ...unavailable, ref: null }, interrupt: unavailable,
      close: unavailable, ...(ordinaryExecution ? { ordinaryExecution } : {}) },
    source: { kind: "session", id, revision: null, evidence: "project-record", href: "" }, metadata },
    observationCursor: "0", currentWork: null, assignments: [], roleTasks: [], queue: [], results: [], questions: [], activity: [],
    resources, metadata };
}

test("Session message entry distinguishes saving, execution and manual handoff", {
  skip: !modulePath && "Set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE after building the workbench",
}, async t => {
  const { chromium } = (await import(pathToFileURL(modulePath!).href)).default;
  let disabledReason = "普通自动回复未启用；保存后当前不会启动此会话。";
  let postedMessage: Record<string, unknown> | null = null;
  let detailHeld = false, releaseDetail: (() => void) | undefined;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname === "/__fixture/update") { disabledReason = "本次重读确认：普通自动回复仍未启用。"; res.end("ok"); return; }
    if (url.pathname === "/__fixture/detail-held") { res.end(String(detailHeld)); return; }
    if (url.pathname === "/__fixture/release-detail") { releaseDetail?.(); res.end("ok"); return; }
    if (url.pathname.startsWith("/api/")) {
      const root = `/api/projects/${projectId}`;
      let value: unknown = { items: [], nextCursor: null }, status = 200;
      if (url.pathname === "/api/session") value = { principal: { actorId: "reader", projectIds: [projectId], permissions: ["read", "write"] }, capabilities: {} };
      else if (url.pathname === "/api/commands" && req.method === "POST") {
        let body = ""; for await (const chunk of req) body += String(chunk);
        const command = JSON.parse(body) as { operationId: string; messageId: string; target: unknown; content: string };
        postedMessage = { projectId, id: command.messageId, operationId: command.operationId, target: command.target,
          senderActorId: "reader", content: command.content, context: null, replyToMessageId: null, state: "queued",
          version: 1, blockedReason: null, readReceipt: null, createdAt: stamp, updatedAt: stamp };
        value = { status: "applied", operationId: command.operationId, entityId: command.messageId, version: 1 };
      }
      else if (url.pathname === root) value = { id: projectId, title: "测试项目", createdAt: stamp };
      else if (url.pathname.endsWith("/messages")) {
        if (postedMessage && url.pathname.includes(encodeURIComponent(keys.disabled))) { status = 503; value = { message: "列表暂不可读" }; }
        else value = { items: [], nextCursor: null, metadata };
      } else if (url.pathname.startsWith(`${root}/session-messages/`)) {
        detailHeld = true; await new Promise<void>(resolve => { releaseDetail = resolve; });
        value = { message: postedMessage, processing: null, metadata };
      }
      else if (url.pathname.startsWith(`${root}/session-work/`) && !url.pathname.endsWith("/changes"))
        value = snapshot(decodeURIComponent(url.pathname.slice(`${root}/session-work/`.length)), disabledReason);
      else if (url.pathname.includes("/recovery") || url.pathname.includes("/hosts/")) { status = 404; value = { message: "测试中不可用" }; }
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
  await page.goto(`${base}/#/p/${projectId}/runtime?session=${encodeURIComponent(keys.disabled)}`);
  await page.getByLabel("访问令牌").fill("fixture-token");
  await page.getByRole("button", { name: "进入", exact: true }).click();
  await page.getByRole("heading", { name: "关闭自动回复的会话" }).waitFor();
  assert.match(await page.getByRole("status").filter({ hasText: "自动处理" }).innerText(), /未启用.*不会启动此会话/);
  assert.equal(await page.getByText("保存能力：当前可保存待处理消息").count(), 1);
  assert.equal(await page.getByText("保存待处理", { exact: true }).count() > 0, true);
  assert.match(await page.getByRole("status").filter({ hasText: "自动处理" }).innerText(), /配置变化后请点上方“重新读取”/);
  await fetch(`${base}/__fixture/update`);
  await page.getByRole("button", { name: "重新读取", exact: true }).click();
  await page.getByRole("status").filter({ hasText: "本次重读确认" }).waitFor();
  await page.locator(".command-disclosure").filter({ hasText: "保存待处理" }).first().locator("summary").click();
  await page.getByLabel("消息内容").fill("保存后的消息详情");
  await page.getByRole("button", { name: "保存待处理", exact: true }).click();
  await page.getByText(/消息列表暂不可读取：列表暂不可读/).waitFor();
  assert.equal(await page.getByText("没有已保存的普通消息。", { exact: true }).count(), 0);
  for (let i = 0; i < 30 && await (await fetch(`${base}/__fixture/detail-held`)).text() !== "true"; i++)
    await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(await (await fetch(`${base}/__fixture/detail-held`)).text(), "true");
  await fetch(`${base}/__fixture/release-detail`);
  await page.getByRole("heading", { name: "消息详情 · 待派发" }).waitFor();
  assert.equal(await page.getByText(/消息列表暂不可读取：列表暂不可读/).count(), 1);
  assert.equal(await page.getByText("没有已保存的普通消息。", { exact: true }).count(), 0);

  await page.evaluate(([project, key]) => { location.hash = `#/p/${project}/runtime?session=${encodeURIComponent(key)}`; }, [projectId, keys.legacy]);
  await page.getByRole("heading", { name: "旧版只读会话" }).waitFor();
  assert.equal(await page.getByText("保存后的消息详情", { exact: true }).count(), 0);
  assert.match(await page.getByRole("status").filter({ hasText: "自动处理" }).innerText(), /暂不可核实.*不能预期自动回复/);
  assert.equal(await page.getByText("当前身份只有读取权限。").count(), 1);
  assert.equal(await page.getByText("保存待处理", { exact: true }).count(), 0);

  await page.evaluate(([project, key]) => { location.hash = `#/p/${project}/runtime?session=${encodeURIComponent(key)}`; }, [projectId, keys.manual]);
  await page.getByRole("heading", { name: "外部会话" }).waitFor();
  assert.match(await page.getByRole("status").filter({ hasText: "自动处理" }).innerText(), /需人工转交.*需人工转交原会话/);
  assert.equal(await page.getByText("保存人工转交", { exact: true }).count() > 0, true);

  await page.evaluate(([project, key]) => { location.hash = `#/p/${project}/runtime?session=${encodeURIComponent(key)}`; }, [projectId, keys.revoked]);
  await page.getByRole("heading", { name: "已撤销外部会话" }).waitFor();
  assert.match(await page.locator(".session-workspace-section").filter({ hasText: "普通对话" }).first().innerText(), /不能向当前外部会话保存或转交消息/);
  assert.equal(await page.getByText("外部连接已撤销。", { exact: true }).count(), 1);
  assert.equal(await page.getByText("保存人工转交", { exact: true }).count(), 0);
});
