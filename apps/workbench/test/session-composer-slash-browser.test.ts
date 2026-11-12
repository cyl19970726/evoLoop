// Opt-in built-app regression: build workbench, then set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE.
// Typing / in an agent's composer always answers. A Codex role may have no skills at all (or its skills may not be readable); the
// menu then still lists the commands, each with why it cannot be used now, and says where the skills stand. It used to open only when
// there was at least one item, so a Codex Session with no skills, nothing running, nothing queued and no current task showed nothing.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { timelinePage } from "./session-timeline-fixtures";

const modulePath = process.env.EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE;
const dist = resolve(import.meta.dirname, "../dist");
const projectId = "95000001-0000-4000-8000-000000000001";
const id = (n: number) => `95000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const sessionId = id(2), roleId = id(20);
const sessionKey = `owned:${sessionId}`;
const stamp = new Date(Date.now() - 64_000).toISOString();
const metadata = { generatedAt: stamp, sourceObservedAt: stamp, partial: false, limitations: [] };
const unavailable = { available: false, reason: "未开放" };
const resources = Object.fromEntries(["configuredModel", "actualModel", "inputTokens", "outputTokens", "cost", "processMemory"]
  .map(key => [key, { value: null, unit: "", source: null, scope: "session", observedAt: null, interval: null, unavailableReason: "未记录" }]));
const role = { id: roleId, title: "功能开发", state: "active", roleClass: "business", templateKey: null, responsibility: "功能开发职责" };
const agent = (provider: "codex" | "claude") => ({ key: sessionKey, target: { kind: "owned", sessionId }, aliases: [], title: `功能开发 · ${provider === "codex" ? "Codex" : "Claude"}`, profile: null, identity: null,
  kind: "owned", roles: [role], membership: "current", membershipReason: "fixture", runtimeState: "ready", busy: false, currentTask: null, latestBusinessRun: null, lastProgressAt: stamp,
  capabilities: { observe: { available: true, reason: null }, send: { available: true, reason: null, mode: "owned-conversation" }, open: { ...unavailable, ref: null }, interrupt: unavailable, close: unavailable,
    ordinaryExecution: { state: "unverified", reasonCode: "fixture", reason: "执行前仍须核验。", observedAt: stamp } },
  source: { kind: "session", id: sessionId, revision: null, evidence: "project-record", href: "" }, metadata });

type SkillsMode = "none" | "fails" | "listed";
const runtimeView = (provider: "codex" | "claude", mode: SkillsMode) => ({ projectId, roleId, binding: null, history: [], provider, providerSource: "default", availableProviders: [provider], providerAvailable: true,
  selection: { project: true, personal: false, builtin: true, add: [], remove: [] }, selectionSource: "default", workDirectory: null, missing: [], skillsReportedBy: "files", plugins: [], mcpServers: [],
  notes: [], observedAtUtc: stamp,
  skills: mode === "listed" ? [{ name: "frontend-design", source: "project", selected: true, reason: "switch", description: "界面设计方向", location: null, contentHash: null, delivery: "native" },
    { name: "unused-skill", source: "personal", selected: false, reason: "switch_off", description: null, location: null, contentHash: null, delivery: "none" }]
    : [{ name: "unused-skill", source: "personal", selected: false, reason: "switch_off", description: null, location: null, contentHash: null, delivery: "none" }] });

async function open(t: import("node:test").TestContext, provider: "codex" | "claude", mode: SkillsMode) {
  const { chromium } = (await import(pathToFileURL(modulePath!).href)).default;
  const posted: Array<Record<string, unknown>> = [];
  const idle = agent(provider);
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, "http://127.0.0.1");
    const root = `/api/projects/${projectId}`;
    const json = (value: unknown, status = 200) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
    if (url.pathname.startsWith("/api/")) {
      if (url.pathname === "/api/session") return json({ principal: { actorId: "reader", projectIds: [projectId], permissions: ["read", "write", "review"] }, capabilities: {} });
      if (url.pathname === root) return json({ id: projectId, title: "输入框测试项目", createdAt: stamp });
      if (url.pathname === "/api/commands" && req.method === "POST") { let text = ""; for await (const chunk of req) text += String(chunk); posted.push(JSON.parse(text)); return json({ status: "applied" }); }
      if (url.pathname === `${root}/roles/${roleId}/runtime`) return mode === "fails" ? json({ code: "RUNTIME_UNAVAILABLE", message: "运行时视图读取失败" }, 500) : json(runtimeView(provider, mode));
      if (url.pathname === `${root}/sessions/${sessionId}/direct-input-capability`) return json({ available: false, mode: null, expectedTurnId: null, reasonCode: "DIRECT_DISABLED", observedAt: stamp });
      if (url.pathname === `${root}/session-work`) return json({ items: [idle], nextCursor: null, observationCursor: "1", metadata,
        totals: { current: 1, historical: 0, unclassified: 0 }, attention: { unansweredQuestions: 0, pendingMessages: 0, pendingAcceptance: null, unclassifiedSessions: 0 } });
      if (url.pathname === `${root}/session-work/${encodeURIComponent(sessionKey)}`) return json({ session: idle, observationCursor: "1", currentWork: null,
        assignments: [], roleTasks: [], queue: [], results: [], questions: [], activity: [], resources, metadata });
      if (url.pathname === `${root}/session-work/${encodeURIComponent(sessionKey)}/timeline`) return json(timelinePage(sessionKey, { title: idle.title }));
      if (url.pathname.endsWith("/timeline/updates")) return json({ cursor: "1", resetRequired: false, entries: [], turns: [], freshness: "live", limitations: [], activeTurnId: null });
      if (url.pathname.endsWith("/recovery")) return json({ message: "无恢复记录" }, 404);
      if (url.pathname === `${root}/runtime`) return json({ available: true, error: null, allowedCwds: [], grants: [] });
      return json({ items: [], nextCursor: null, metadata });
    }
    try {
      const file = /^\/(?:$|p\/|ui$)/.test(url.pathname) ? "index.html" : url.pathname;
      const content = await readFile(join(dist, file));
      res.writeHead(200, { "content-type": ({ ".html": "text/html", ".js": "text/javascript", ".css": "text/css" } as Record<string, string>)[extname(file)] ?? "application/octet-stream" });
      res.end(content);
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done)); t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const browser = await chromium.launch({ headless: true, ...(process.env.EVOLOOP_BROWSER_TEST_EXECUTABLE_PATH ? { executablePath: process.env.EVOLOOP_BROWSER_TEST_EXECUTABLE_PATH } : {}) });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(`${base}/p/${projectId}/sessions?session=${encodeURIComponent(sessionKey)}`);
  await page.getByLabel("访问令牌").fill("fixture-token");
  await page.getByRole("button", { name: "进入", exact: true }).click();
  const box = page.getByRole("combobox", { name: "消息" });
  await box.waitFor();
  return { page, box, posted, menu: page.getByRole("listbox", { name: "技能与命令" }) };
}

for (const provider of ["codex", "claude"] as const) {
  test(`${provider}: / with no skills still opens the menu, lists the commands with why each cannot be used now, and says there are no skills; Esc closes it; no match is said, not silent`, {
    skip: !modulePath && "Set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE after building the workbench",
  }, async t => {
    const { page, box, posted, menu } = await open(t, provider, "none");
    await box.fill("/");
    await menu.waitFor();
    await menu.getByText("这个职责现在没有可用的技能").waitFor();
    for (const [name, reason] of [["停止这一轮", "现在没有进行中的一轮"], ["撤回排队消息", "没有排队的消息"], ["关联当前任务", "这个智能体现在没有当前任务"]] as const) {
      const option = menu.getByRole("option", { name: new RegExp(name) });
      await option.waitFor();
      assert.equal(await option.getAttribute("aria-disabled"), "true", `${name} is shown but cannot be picked`);
      assert.match(await option.innerText(), new RegExp(`现在不能用：${reason}`));
    }
    // A command that cannot be used is not picked by Enter or a click, and nothing is sent.
    await box.press("Enter");
    await menu.waitFor();
    assert.equal(await box.inputValue(), "/");
    // (force: Playwright refuses to click an aria-disabled item on its own; a person can, and it must do nothing)
    await menu.getByRole("option", { name: /停止这一轮/ }).click({ force: true });
    assert.equal(await box.inputValue(), "/");
    assert.equal(posted.length, 0, "nothing was sent");
    await box.press("Escape");
    await menu.waitFor({ state: "hidden" });
    // Typing something that matches nothing is answered too.
    await box.fill("/zzzz");
    await menu.getByText("没有匹配的技能或命令").waitFor();
    // Narrowing to one command keeps only it, with its reason.
    await box.fill("/撤回");
    assert.equal(await menu.getByRole("option").count(), 1);
    await menu.getByText("没有排队的消息").waitFor();
  });
}

test("a role whose skills cannot be read says so and still lists the commands", { skip: !modulePath && "Set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE after building the workbench" }, async t => {
  const { page, box, menu } = await open(t, "codex", "fails");
  await box.fill("/");
  await menu.getByText("技能读取失败").waitFor();
  await menu.getByRole("option", { name: /关联当前任务/ }).waitFor();
  void page;
});

test("a role with skills still lists them first, then the commands (the Claude path), and picking a skill names it", { skip: !modulePath && "Set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE after building the workbench" }, async t => {
  const { page, box, menu } = await open(t, "claude", "listed");
  await box.fill("/");
  await menu.getByText("frontend-design").waitFor();
  assert.equal(await menu.getByText("unused-skill").count(), 0, "a skill the role does not load is not offered");
  assert.equal(await menu.getByText("这个职责现在没有可用的技能").count(), 0, "no 'no skills' line when there are skills");
  await menu.getByRole("option", { name: /停止这一轮/ }).waitFor();
  await menu.getByText("frontend-design").click();
  await page.getByText("技能 · frontend-design").waitFor();
});
