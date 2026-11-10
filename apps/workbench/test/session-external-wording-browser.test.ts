// Opt-in built-app regression for an external agent (#229 F4): its directory name and page say what kind of agent it is
// without the service's eight-character identifier; the right column says the model, effort and permission are not
// provided by an external host instead of “正在读取” forever; the reading scope says the service's English limits in
// Chinese with the originals folded under 原文. Screenshots: EVOLOOP_AGENT_WORDING_SCREENSHOT_DIR (1440, 1024, 390).
import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { timelineMessage, timelinePage } from "./session-timeline-fixtures";

const modulePath = process.env.EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE;
const shots = process.env.EVOLOOP_AGENT_WORDING_SCREENSHOT_DIR;
const dist = resolve(import.meta.dirname, "../dist");
const projectId = "97000001-0000-4000-8000-000000000001";
const linkId = "0aba35cb-0000-4000-8000-000000000002";
const roleId = "97000003-0000-4000-8000-000000000003";
const key = `external:${linkId}`;
const stamp = "2026-11-10T02:00:00.000Z";
const generatedTitle = "功能开发 · 外部 0aba35cb";
const english = ["Native history is unsupported for this Session", "Manual handoff records do not prove native delivery or reading", "Live native updates unavailable"];
const metadata = { generatedAt: stamp, sourceObservedAt: stamp, partial: false, limitations: [] };
const unavailable = { available: false, reason: "外部接入不提供" };
const resources = Object.fromEntries(["configuredModel", "actualModel", "inputTokens", "outputTokens", "cost", "processMemory"]
  .map(name => [name, { value: null, unit: "", source: null, scope: "session", observedAt: null, interval: null, unavailableReason: "未记录" }]));
const session = { key, target: { kind: "external", linkId }, aliases: [], title: generatedTitle, profile: null, identity: null, kind: "external",
  roles: [{ id: roleId, title: "功能开发", state: "active", roleClass: "business", templateKey: null, responsibility: "功能开发职责" }],
  membership: "current", membershipReason: "测试", runtimeState: null, busy: null, currentTask: null, latestBusinessRun: null,
  lastProgressAt: "2026-11-10T01:30:00.000Z",
  capabilities: { observe: { available: true, reason: null }, send: { available: true, reason: "仅可保存人工转交；不证明已经送达或被读取。", mode: "manual-handoff" },
    open: { ...unavailable, ref: null }, interrupt: unavailable, close: unavailable,
    ordinaryExecution: { state: "manual", reasonCode: "EXTERNAL_HANDOFF", reason: "需人工转交原会话。", observedAt: stamp } },
  source: { kind: "host-link", id: linkId, revision: null, evidence: "project-record", href: "" },
  metadata: { ...metadata, partial: true, limitations: ["外部会话仅人工接入；未同步原聊天实时状态和完整历史。"] } };

test("an external agent is named without its short identifier, and its environment is not applicable rather than reading", {
  skip: !modulePath && "Set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE after building the workbench",
}, async t => {
  const { chromium } = (await import(pathToFileURL(modulePath!).href)).default;
  const recoveryReads: string[] = [];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, "http://127.0.0.1");
    if (url.pathname.startsWith("/api/")) {
      const root = `/api/projects/${projectId}`;
      const path = decodeURIComponent(url.pathname);
      let value: unknown = { items: [], nextCursor: null, metadata }, status = 200;
      if (path === "/api/session") value = { principal: { actorId: "reader", projectIds: [projectId], permissions: ["read", "write"] }, capabilities: {} };
      else if (path === root) value = { id: projectId, title: "外部智能体用语", createdAt: stamp };
      else if (path === `${root}/session-work`) {
        const membership = url.searchParams.get("membership") ?? "current";
        value = { items: membership === "current" ? [session] : [], nextCursor: null, observationCursor: "1", metadata,
          totals: { current: 1, historical: 2, unclassified: 0 }, attention: { unansweredQuestions: 0, pendingMessages: 0, pendingAcceptance: null, unclassifiedSessions: 0 } };
      } else if (path === `${root}/session-work/changes`) value = { items: [], nextCursor: "2", hasMore: false, resetRequired: false, metadata };
      else if (path === `${root}/session-work/${key}`) value = { session, observationCursor: "1", currentWork: null, assignments: [], roleTasks: [], queue: [],
        results: [], questions: [], activity: [], resources, metadata };
      else if (path === `${root}/session-work/${key}/timeline`) {
        const page = timelinePage(key, { title: generatedTitle, history: false, live: false, liveFreshness: "unavailable",
          pending: [timelineMessage("m1", "请核对右栏的说法。", { state: "pending" })] });
        value = { ...page, partial: true, limitations: [english[0], english[1]], live: { ...page.live, limitations: [english[2]] } };
      } else if (path === `${root}/session-work/${key}/timeline/updates`) value = { cursor: "1", resetRequired: false, entries: [], turns: [], freshness: "unavailable",
        activeTurnId: null, limitations: [english[2]] };
      else if (path.includes("/recovery")) { recoveryReads.push(path); status = 404; value = { message: "外部智能体没有恢复记录" }; }
      else if (path === `${root}/hosts/${linkId}`) { status = 404; value = { message: "测试中不可用" }; }
      res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); return;
    }
    try {
      const file = /^\/(?:$|p\/|ui$)/.test(url.pathname) ? "index.html" : url.pathname;
      const body = await readFile(join(dist, file));
      res.writeHead(200, { "content-type": ({ ".html": "text/html", ".js": "text/javascript", ".css": "text/css" } as Record<string, string>)[extname(file)] ?? "application/octet-stream" });
      res.end(body);
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done)); t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const browser = await chromium.launch({ headless: true, ...(process.env.EVOLOOP_BROWSER_TEST_EXECUTABLE_PATH
    ? { executablePath: process.env.EVOLOOP_BROWSER_TEST_EXECUTABLE_PATH } : {}) });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(`${base}/p/${projectId}/sessions?session=${encodeURIComponent(key)}`);
  await page.getByLabel("访问令牌").fill("fixture-token");
  await page.getByRole("button", { name: "进入", exact: true }).click();

  // The page and its directory say what kind of agent this is; the eight characters are only in 完整标识.
  await page.getByRole("heading", { level: 1, name: "功能开发 · 外部接入的智能体" }).waitFor();
  if (await page.locator("[data-shell=frame]").getAttribute("data-rail") !== "shown") await page.getByRole("button", { name: "展开项目导航" }).click();
  const directory = page.locator("aside[aria-label=项目导航] .session-navigation");
  const item = directory.locator(".session-nav-item").first();
  await item.getByText("功能开发 · 外部接入的智能体", { exact: true }).waitFor();
  assert.match(await item.innerText(), /最近活动 /, "the last activity tells two agents of the same role apart");
  await directory.getByText("共 3 个智能体", { exact: true }).waitFor();

  // 环境与用量: not applicable, and still so after the page has had time to read.
  if (await page.getByRole("button", { name: "展开右栏" }).count()) await page.getByRole("button", { name: "展开右栏" }).click();
  const panel = page.locator(".session-panel");
  await panel.getByText("外部接入不提供", { exact: true }).first().waitFor();
  await page.waitForTimeout(1500);
  const environment = await panel.locator('section[aria-label="环境与用量"]').innerText();
  assert.match(environment, /目标模型\s*外部接入不提供[\s\S]*思考强度\s*外部接入不提供[\s\S]*执行权限\s*外部接入不提供/, environment);
  assert.doesNotMatch(await panel.innerText(), /正在读取/, "nothing in the right column waits on a read that never runs");
  assert.deepEqual(recoveryReads, [], "an external agent's recovery is never read");

  // 消息怎样处理与读取范围: Chinese lines, the English originals folded under 原文.
  const scope = page.locator(".workspace-reading-scope");
  await scope.locator("summary").first().click();
  await scope.getByText("这个智能体的来源不提供原有历史，这里只显示经 evoLoop 保存的消息。", { exact: true }).waitFor();
  await scope.getByText("人工转交的记录只说明消息已保存，不能证明原聊天已收到或已读。", { exact: true }).waitFor();
  await scope.getByText("这个智能体没有实时活动来源，新的活动要重新读取才会出现。", { exact: true }).waitFor();
  if (shots) await page.screenshot({ path: `${shots}/agent-external-1440.png`, fullPage: false });
  const visible = `${await page.locator("#workspace-main").innerText()}\n${await page.locator("aside[aria-label=项目导航]").innerText()}\n${await panel.innerText()}`;
  for (const raw of [...english, "0aba35cb", generatedTitle]) assert.ok(!visible.includes(raw), `“${raw}” is not in the page's text`);
  await scope.locator("summary", { hasText: "原文" }).click();
  for (const raw of english) await scope.getByText(raw, { exact: true }).waitFor();
  const details = panel.locator(".session-information");
  await details.locator("summary").first().click();
  await details.locator("summary", { hasText: "来源与完整标识" }).last().click();
  await details.getByText(generatedTitle, { exact: true }).waitFor();

  // 1024: the right column is a drawer, opened by the reader; 390: no sideways scroll.
  await page.setViewportSize({ width: 1024, height: 800 });
  await page.waitForTimeout(200);
  if (await page.getByRole("button", { name: "展开右栏" }).count()) await page.getByRole("button", { name: "展开右栏" }).click();
  await page.locator(".session-panel").getByText("外部接入不提供", { exact: true }).first().waitFor();
  await page.waitForTimeout(500); // the drawer has finished sliding in
  if (shots) await page.screenshot({ path: `${shots}/agent-external-1024.png` });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(200);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "no sideways scroll at 390");
  if (shots) await page.screenshot({ path: `${shots}/agent-external-390.png` });
  assert.deepEqual(errors, []);
});
