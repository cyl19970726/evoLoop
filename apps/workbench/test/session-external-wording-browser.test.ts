// Opt-in built-app regression for an external agent (#229 F4): its page names it without the service's eight-character
// identifier; two unregistered external agents of one role are still told apart (what the service records, then the
// short identifier as secondary text) in the directory and in the @ menu; the right column says the model, effort and
// permission are not provided by an external host instead of “正在读取” forever; the reading scope says the service's
// English limits in Chinese with the originals folded under 原文. Fixtures follow the service: an external agent has
// no lastProgressAt, only its connection record's time in metadata. Screenshots: EVOLOOP_AGENT_WORDING_SCREENSHOT_DIR.
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
const linkA = "0aba35cb-0000-4000-8000-000000000002", linkB = "7f3e0c11-0000-4000-8000-000000000005";
const roleId = "97000003-0000-4000-8000-000000000003";
const ownedId = "97000004-0000-4000-8000-000000000004";
const keyA = `external:${linkA}`, keyB = `external:${linkB}`, ownedKey = `owned:${ownedId}`;
const stamp = "2026-11-10T02:00:00.000Z";
const generatedTitle = "功能开发 · 外部 0aba35cb";
const shownName = "功能开发 · 外部接入的智能体";
const english = ["Native history is unsupported for this Session", "Manual handoff records do not prove native delivery or reading", "Live native updates unavailable"];
const metadata = { generatedAt: stamp, sourceObservedAt: stamp, partial: false, limitations: [] };
const unavailable = { available: false, reason: "外部接入不提供" };
const resources = Object.fromEntries(["configuredModel", "actualModel", "inputTokens", "outputTokens", "cost", "processMemory"]
  .map(name => [name, { value: null, unit: "", source: null, scope: "session", observedAt: null, interval: null, unavailableReason: "未记录" }]));
const role = (id: string, title: string) => ({ id, title, state: "active", roleClass: "business", templateKey: null, responsibility: `${title}职责` });
function externalAgent(linkId: string, observedAt: string) {
  return { key: `external:${linkId}`, target: { kind: "external", linkId }, aliases: [], title: `功能开发 · 外部 ${linkId.slice(0, 8)}`, profile: null, identity: null,
    kind: "external", roles: [role(roleId, "功能开发")], membership: "current", membershipReason: "测试", runtimeState: null, busy: null,
    currentTask: null, latestBusinessRun: null, lastProgressAt: null,
    capabilities: { observe: { available: true, reason: null }, send: { available: true, reason: "仅可保存人工转交；不证明已经送达或被读取。", mode: "manual-handoff" },
      open: { ...unavailable, ref: null }, interrupt: unavailable, close: unavailable,
      ordinaryExecution: { state: "manual", reasonCode: "EXTERNAL_HANDOFF", reason: "需人工转交原会话。", observedAt: stamp } },
    source: { kind: "host-link", id: linkId, revision: null, evidence: "project-record", href: "" },
    metadata: { ...metadata, sourceObservedAt: observedAt, partial: true, limitations: ["外部会话仅人工接入；未同步原聊天实时状态和完整历史。"] } };
}
const agentA = externalAgent(linkA, "2026-11-10T01:30:00.000Z");
// Registered at the same minute: the time alone cannot tell the two apart.
const agentB = externalAgent(linkB, "2026-11-10T01:30:00.000Z");
const owned = { key: ownedKey, target: { kind: "owned", sessionId: ownedId }, aliases: [], title: "前端实现", profile: { displayName: "前端实现" }, identity: null,
  kind: "owned", roles: [role("97000006-0000-4000-8000-000000000006", "前端实现")], membership: "current", membershipReason: "测试", runtimeState: "ready", busy: false,
  currentTask: null, latestBusinessRun: null, lastProgressAt: stamp,
  capabilities: { observe: { available: true, reason: null }, send: { available: true, reason: null, mode: "owned-conversation" },
    open: { ...unavailable, ref: null }, interrupt: unavailable, close: unavailable,
    ordinaryExecution: { state: "unverified", reasonCode: "fixture", reason: "执行前仍须核验。", observedAt: stamp } },
  source: { kind: "session", id: ownedId, revision: null, evidence: "project-record", href: "" }, metadata };
const agents = [agentA, agentB, owned];

test("external agents are named without the short identifier, same-role ones stay apart, and their environment is not applicable rather than reading", {
  skip: !modulePath && "Set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE after building the workbench",
}, async t => {
  const { chromium } = (await import(pathToFileURL(modulePath!).href)).default;
  const recoveryReads: string[] = [];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, "http://127.0.0.1");
    if (url.pathname.startsWith("/api/")) {
      const root = `/api/projects/${projectId}`;
      const path = decodeURIComponent(url.pathname);
      const agentPath = path.startsWith(`${root}/session-work/`) ? path.slice(`${root}/session-work/`.length) : "";
      const agent = agents.find(item => agentPath === item.key || agentPath.startsWith(`${item.key}/`));
      let value: unknown = { items: [], nextCursor: null, metadata }, status = 200;
      if (path === "/api/session") value = { principal: { actorId: "reader", projectIds: [projectId], permissions: ["read", "write"] }, capabilities: {} };
      else if (path === root) value = { id: projectId, title: "外部智能体用语", createdAt: stamp };
      else if (path === `${root}/session-work`) {
        const membership = url.searchParams.get("membership") ?? "current";
        value = { items: membership === "current" ? agents : [], nextCursor: null, observationCursor: "1", metadata,
          totals: { current: 3, historical: 2, unclassified: 0 }, attention: { unansweredQuestions: 0, pendingMessages: 0, pendingAcceptance: null, unclassifiedSessions: 0 } };
      } else if (path === `${root}/session-work/changes`) value = { items: [], nextCursor: "2", hasMore: false, resetRequired: false, metadata };
      else if (agent && agentPath === agent.key) value = { session: agent, observationCursor: "1", currentWork: null, assignments: [], roleTasks: [], queue: [],
        results: [], questions: [], activity: [], resources, metadata };
      else if (agent && agentPath === `${agent.key}/timeline`) {
        const external = agent.kind === "external";
        const page = timelinePage(agent.key, { title: agent.title, history: !external, live: !external, liveFreshness: external ? "unavailable" : "live",
          pending: external ? [timelineMessage("m1", "请核对右栏的说法。", { state: "pending" })] : [] });
        value = external ? { ...page, partial: true, limitations: [english[0], english[1]], live: { ...page.live, limitations: [english[2]] } } : page;
      } else if (agent && agentPath === `${agent.key}/timeline/updates`) value = { cursor: "1", resetRequired: false, entries: [], turns: [],
        freshness: agent.kind === "external" ? "unavailable" : "live", activeTurnId: null, limitations: agent.kind === "external" ? [english[2]] : [] };
      else if (path.includes("/recovery")) { recoveryReads.push(path); status = 404; value = { message: "没有恢复记录" }; }
      else if (path.startsWith(`${root}/hosts/`)) { status = 404; value = { message: "测试中不可用" }; }
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
  await page.goto(`${base}/p/${projectId}/sessions?session=${encodeURIComponent(keyA)}`);
  await page.getByLabel("访问令牌").fill("fixture-token");
  await page.getByRole("button", { name: "进入", exact: true }).click();

  // The page names what kind of agent this is; the eight characters are not in its name.
  await page.getByRole("heading", { level: 1, name: shownName }).waitFor();
  if (await page.locator("[data-shell=frame]").getAttribute("data-rail") !== "shown") await page.getByRole("button", { name: "展开项目导航" }).click();
  const directory = page.locator("aside[aria-label=项目导航] .session-navigation");
  await directory.getByText("共 5 个智能体", { exact: true }).waitFor();
  // Two external agents of one role: the same name, told apart on the second line by what the service records and,
  // since that is the same minute here, by the short identifier.
  const itemA = directory.locator(`.session-nav-item[href*="${linkA}"]`), itemB = directory.locator(`.session-nav-item[href*="${linkB}"]`);
  await itemA.getByText(shownName, { exact: true }).waitFor();
  await itemB.getByText(shownName, { exact: true }).waitFor();
  const [signalA, signalB] = [await itemA.locator(".session-nav-signal").getAttribute("title"), await itemB.locator(".session-nav-signal").getAttribute("title")];
  assert.match(signalA!, /^标识 0aba35cb · 接入更新于 /);
  assert.match(signalB!, /^标识 7f3e0c11 · 接入更新于 /);
  assert.notEqual(signalA, signalB);
  assert.doesNotMatch(`${signalA}${signalB}`, /最近活动/, "an external agent records no activity time, so none is claimed");
  assert.doesNotMatch(await directory.locator(`.session-nav-item[href*="${ownedId}"]`).innerText(), /标识/, "a name nobody shares needs no identifier");

  // 执行配置: not applicable, and still so after the page has had time to read.
  if (await page.getByRole("button", { name: "展开右栏" }).count()) await page.getByRole("button", { name: "展开右栏" }).click();
  const panel = page.locator(".session-panel");
  await panel.getByText("外部接入不提供", { exact: true }).first().waitFor();
  await page.waitForTimeout(1500);
  const environment = await panel.locator('section[aria-label="执行配置"]').innerText();
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
  const pageText = `${await page.locator("#workspace-main").innerText()}\n${await panel.innerText()}`;
  for (const raw of [...english, "0aba35cb", generatedTitle]) assert.ok(!pageText.includes(raw), `“${raw}” is not in the page's text`);
  assert.ok(!(await page.locator("aside[aria-label=项目导航]").innerText()).includes(generatedTitle), "the directory does not show the service's title");
  await scope.locator("summary", { hasText: "原文" }).click();
  for (const raw of english) await scope.getByText(raw, { exact: true }).waitFor();
  const details = panel.locator(".session-information");
  await details.locator("summary").first().click();
  await details.locator("summary", { hasText: "来源与完整标识" }).last().click();
  await details.getByText(generatedTitle, { exact: true }).waitFor();

  // The @ menu of a project-run agent offers both external agents, each with its short identifier, never two same names.
  await page.goto(`${base}/p/${projectId}/sessions?session=${encodeURIComponent(ownedKey)}`);
  await page.getByLabel("访问令牌").fill("fixture-token");
  await page.getByRole("button", { name: "进入", exact: true }).click();
  await page.getByRole("heading", { level: 1, name: "前端实现" }).waitFor();
  const box = page.getByRole("combobox", { name: "消息" });
  await box.fill("请 @");
  const menu = page.getByRole("listbox", { name: "选择智能体" });
  await menu.getByText(`${shownName}（标识 0aba35cb）`, { exact: true }).waitFor();
  await menu.getByText(`${shownName}（标识 7f3e0c11）`, { exact: true }).waitFor();
  assert.equal(await menu.getByText(shownName, { exact: true }).count(), 0, "no entry carries the bare shared name");
  await menu.getByText(`${shownName}（标识 7f3e0c11）`, { exact: true }).click();
  await page.waitForFunction(() => document.querySelector<HTMLTextAreaElement>("[aria-label='消息']")?.value.includes("（标识 7f3e0c11）"));
  await box.fill("");

  // 1024: the right column is a drawer, opened by the reader; 390: no sideways scroll.
  await page.goto(`${base}/p/${projectId}/sessions?session=${encodeURIComponent(keyA)}`);
  await page.getByLabel("访问令牌").fill("fixture-token");
  await page.getByRole("button", { name: "进入", exact: true }).click();
  await page.setViewportSize({ width: 1024, height: 800 });
  await page.getByRole("heading", { level: 1, name: shownName }).waitFor();
  if (await page.getByRole("button", { name: "展开右栏" }).count()) await page.getByRole("button", { name: "展开右栏" }).click();
  await page.locator(".session-panel").getByText("外部接入不提供", { exact: true }).first().waitFor();
  await page.waitForTimeout(500); // the drawer has finished sliding in
  if (shots) await page.screenshot({ path: `${shots}/agent-external-1024.png` });
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(300);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "no sideways scroll at 390");
  if (shots) await page.screenshot({ path: `${shots}/agent-external-390.png` });
  assert.deepEqual(errors, []);
});
