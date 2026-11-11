// Opt-in built-app regression (build the workbench, then set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE): two Sessions of one
// business Role that nobody named — one on Claude, one on Codex — both sit under 业务智能体, not 待归类, and the list says
// which is which and what each runs on. The directory read is replaced; everything else is the screenshot fixture.
import assert from "node:assert/strict";
import { test } from "node:test";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const modulePath = process.env.EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE;
const dist = resolve(import.meta.dirname, "../dist");
const fixtureDir = resolve(import.meta.dirname, "../../../scripts/frontend/fixture");

test("bound Sessions of one Role are business agents, told apart by runtime and short identifier, with their model", { skip: !modulePath && "Set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE after building the workbench" }, async t => {
  const { chromium } = (await import(pathToFileURL(modulePath!).href)).default;
  const { startFixtureServer } = await import(pathToFileURL(`${fixtureDir}/server.mjs`).href);
  const { projectId, token } = await import(pathToFileURL(`${fixtureDir}/common.mjs`).href);
  const fixture = await startFixtureServer(dist); t.after(() => fixture.close());
  const browser = await chromium.launch({ headless: true }); t.after(() => browser.close());
  const stamp = new Date().toISOString();
  const unavailable = { available: false, reason: "未开放" };
  const role = { id: "30000009-0000-4000-8000-000000000001", title: "功能开发", state: "active", roleClass: "business", templateKey: "functional-development", responsibility: "实现" };
  const agent = (hex: string, provider: "claude" | "codex", model: string | null) => ({ key: `owned:${hex}-0000-4000-8000-000000000001`, target: { kind: "owned", sessionId: `${hex}-0000-4000-8000-000000000001` }, aliases: [],
    title: "功能开发", profile: null, identity: null, kind: "owned", roles: [role], membership: "current", membershipReason: "已按项目记录绑定到职责，归入该职责的团队。",
    runtime: { provider, model }, runtimeState: "ready", busy: false, currentTask: null, latestBusinessRun: null, lastProgressAt: stamp,
    capabilities: { observe: { available: true, reason: null }, send: { available: true, reason: null, mode: "owned-conversation" }, open: { ...unavailable, ref: null }, interrupt: unavailable, close: unavailable },
    source: { kind: "session", id: hex, revision: null, evidence: "project-record", href: "" }, metadata: { generatedAt: stamp, sourceObservedAt: stamp, partial: false, limitations: [] } });
  const sessions = [agent("8cf291f4", "claude", "sonnet"), agent("5d2e7a10", "claude", "sonnet"), agent("c4be4124", "codex", null)];
  const page = await (await browser.newContext({ viewport: { width: 1195, height: 900 } })).newPage();
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await page.route(new RegExp(`/api/projects/${projectId}/session-work(\\?|$)`), route => {
    const membership = new URL(route.request().url()).searchParams.get("membership") ?? "current";
    const items = membership === "current" ? sessions : [];
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ items, nextCursor: null, observationCursor: "1",
      metadata: { generatedAt: stamp, sourceObservedAt: stamp, partial: false, limitations: [] }, totals: { current: sessions.length, historical: 0, unclassified: 0 },
      attention: { unansweredQuestions: 0, pendingMessages: 0, pendingAcceptance: null, unclassifiedSessions: 0 } }) });
  });
  await page.goto(`${fixture.base}/#/p/${projectId}/sessions`);
  await page.getByLabel("访问令牌").fill(token);
  await page.getByRole("button", { name: "进入", exact: true }).click();
  const nav = page.getByRole("navigation", { name: "智能体目录" }).or(page.locator("section[aria-label='智能体目录']")).first();
  await nav.getByText("业务智能体 · 已加载 3", { exact: true }).waitFor();
  const text = await nav.innerText();
  assert.equal(await nav.getByText(/^待归类/).count(), 0, "nothing is filed under 待归类");
  assert.equal((text.match(/功能开发 · Claude/g) ?? []).length, 2, "the two Claude agents read alike by name …");
  assert.equal((text.match(/功能开发 · Codex/g) ?? []).length, 1);
  assert.match(text, /标识 8cf291f4/);
  assert.match(text, /标识 5d2e7a10/, "… and are told apart by their short identifier");
  assert.doesNotMatch(text, /标识 c4be4124/, "a name that is not shared needs no identifier");
  assert.equal((text.match(/Claude · sonnet/g) ?? []).length, 2, "the model each runs on is said");
  assert.match(text, /Codex · 默认模型/);
  assert.deepEqual(errors, []);
});
