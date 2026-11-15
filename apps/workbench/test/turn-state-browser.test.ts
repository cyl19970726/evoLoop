// Opt-in built-app regression (Task 3c6973c5): a Turn that has ended must not show its tools as "进行中" / "正在进行", and a just-sent line must not stay
// beside the receipt that replaced it. Needs the built workbench and EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE; EVOLOOP_TURN_SCREENSHOT_DIR=<dir> saves screenshots.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { timelineAssistant, timelineMessage, timelinePage, timelineStamp, timelineTool } from "./session-timeline-fixtures";

const modulePath = process.env.EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE;
const shots = process.env.EVOLOOP_TURN_SCREENSHOT_DIR;
const dist = process.env.EVOLOOP_BROWSER_TEST_DIST ?? resolve(import.meta.dirname, "../dist");
const projectId = "98000001-0000-4000-8000-000000000001";
const sessionId = "98000002-0000-4000-8000-000000000002";
const sessionKey = `owned:${sessionId}`;
const stamp = timelineStamp;
const metadata = { generatedAt: stamp, sourceObservedAt: stamp, partial: false, limitations: [] };
const unavailable = { available: false, reason: "fixture unavailable" };
const resources = Object.fromEntries(["configuredModel", "actualModel", "inputTokens", "outputTokens", "cost", "processMemory"]
  .map(key => [key, { value: null, unit: "", source: null, scope: "session", observedAt: null, interval: null, unavailableReason: "未记录" }]));
const snapshot = () => ({ session: { key: sessionKey, target: { kind: "owned", sessionId }, aliases: [], title: "轮次状态会话", profile: null,
  kind: "owned", roles: [], membership: "current", membershipReason: "fixture", runtimeState: "ready", busy: false, currentTask: null, latestBusinessRun: null, lastProgressAt: null,
  capabilities: { observe: unavailable, send: { available: true, reason: null, mode: "owned-conversation" }, open: { ...unavailable, ref: null }, interrupt: unavailable, close: unavailable },
  source: { kind: "session", id: sessionId, revision: null, evidence: "project-record", href: "" }, metadata },
  observationCursor: "0", currentWork: null, assignments: [], roleTasks: [], queue: [], results: [], questions: [], activity: [], resources, metadata });

type TurnState = "running" | "completed" | "failed" | "interrupted" | "unknown";
const turnDef = (id: string, state: TurnState) => ({ id, state, startedAt: stamp, completedAt: state === "running" ? null : stamp, origin: null });
/** One tool per Turn, as the native source leaves it: still "running" because its end was never recorded. */
const toolOf = (turn: string, label: string) => timelineTool(`tool-${turn}`, "命令", `工具·${label}`, "running", { turnId: turn, freshness: "live" });

/** The mock server and the browser, shared by the tests of this file; torn down by the test that created them. */
async function fixture(t: { after(fn: () => unknown): void }) {
  const { chromium } = (await import(pathToFileURL(modulePath!).href)).default;
  if (shots) mkdirSync(shots, { recursive: true });
  // The Turn "switch" starts running and is interrupted later; the others have their state from the start.
  let switchState: TurnState = "running";
  const turns = () => [turnDef("t-done", "completed"), turnDef("t-int", "interrupted"), turnDef("t-fail", "failed"), turnDef("t-unk", "unknown"), turnDef("t-switch", switchState), turnDef("t-live", "running")];
  const entries = () => [
    timelineMessage("m-done", "任务一"), timelineAssistant("a-done", "一已结束", { turnId: "t-done" }), toolOf("t-done", "已结束的一轮"),
    timelineMessage("m-int", "任务二"), toolOf("t-int", "被中断的一轮"), timelineAssistant("a-int", "二被打断", { turnId: "t-int", state: "interrupted" }),
    timelineMessage("m-fail", "任务三"), toolOf("t-fail", "失败的一轮"),
    timelineMessage("m-unk", "任务四"), toolOf("t-unk", "结果未知的一轮"),
    timelineMessage("m-switch", "任务五"), toolOf("t-switch", "会切换状态的一轮"),
    // Rework: the rows beside the unconfirmed one. A completed and a failed tool and a pending one in the interrupted Turn; a tool with no Turn; a running Turn with a live and a stale tool.
    timelineTool("ok-int", "命令", "工具·中断轮里已完成的", "completed", { turnId: "t-int" }), timelineTool("bad-int", "命令", "工具·中断轮里失败的", "failed", { turnId: "t-int" }),
    timelineTool("pend-int", "命令", "工具·中断轮里待处理的", "pending", { turnId: "t-int" }),
    timelineTool("tool-none", "命令", "工具·没有轮次的", "running", { turnId: null, freshness: "live" }),
    timelineMessage("m-live", "任务六"), timelineTool("live-live", "命令", "工具·运行中的轮里在跑的", "running", { turnId: "t-live", freshness: "live" }),
    timelineTool("stale-live", "命令", "工具·运行中的轮里上次读到的", "running", { turnId: "t-live", freshness: "stale" }),
  ];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, "http://127.0.0.1");
    if (url.pathname.startsWith("/api/")) {
      const root = `/api/projects/${projectId}`;
      let value: unknown = { items: [], nextCursor: null, metadata }, status = 200;
      if (url.pathname === "/api/session") value = { principal: { actorId: "reader", projectIds: [projectId], permissions: ["task", "document", "session"] }, capabilities: {} };
      else if (url.pathname === root) value = { id: projectId, title: "测试项目", createdAt: stamp };
      else if (url.pathname === `${root}/session-work`) value = { items: [snapshot().session], nextCursor: null, observationCursor: "0", metadata, totals: { current: 1, historical: 0, unclassified: 0 },
        attention: { unansweredQuestions: 0, pendingMessages: 0, pendingAcceptance: null, unclassifiedSessions: 0 } };
      else if (url.pathname === `${root}/session-work/changes`) value = { items: [], nextCursor: "0", hasMore: false, resetRequired: false, metadata };
      else if (url.pathname === `${root}/impacts` || url.pathname === `${root}/runtime/runs` || url.pathname === `${root}/runtime/sessions` || url.pathname.startsWith(`${root}/references/`)) value = [];
      else if (url.pathname === `${root}/runtime`) value = { available: false, error: null, allowedCwds: [], grants: [] };
      else if (url.pathname === `${root}/orchestration/work-status`) value = { items: [] };
      else if (url.pathname.endsWith("/timeline/updates")) value = { cursor: "2", resetRequired: false, entries: [], turns: turns(), freshness: "live", limitations: [], activeTurnId: switchState === "running" ? "t-switch" : null };
      else if (url.pathname.endsWith("/timeline")) value = timelinePage(sessionKey, { title: "轮次状态会话", entries: entries(), turns: turns(), cursor: "1",
        liveTurns: turns(), liveEntries: [], activeTurnId: switchState === "running" ? "t-switch" : null });
      else if (url.pathname.startsWith(`${root}/session-work/`)) value = snapshot();
      else if (url.pathname.endsWith("/recovery")) { status = 404; value = { message: "无恢复记录" }; }
      else if (url.pathname.endsWith("/direct-input-capability")) value = { available: false, mode: null, expectedTurnId: null, reasonCode: "DIRECT_GRANT_MISSING", observedAt: stamp };
      res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); return;
    }
    if (url.pathname === "/__fixture/switch") { switchState = (url.searchParams.get("to") as TurnState) ?? "interrupted"; res.end("ok"); return; }
    try {
      const file = /^\/(?:$|p\/|ui$)/.test(url.pathname) ? "index.html" : url.pathname;
      const body = await readFile(join(dist, file));
      res.writeHead(200, { "content-type": ({ ".html": "text/html", ".js": "text/javascript", ".css": "text/css" } as Record<string, string>)[extname(file)] ?? "application/octet-stream" }); res.end(body);
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise<void>(resolveListen => server.listen(0, "127.0.0.1", resolveListen)); t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const browser = await chromium.launch({ headless: true, ...(process.env.EVOLOOP_BROWSER_TEST_EXECUTABLE_PATH ? { executablePath: process.env.EVOLOOP_BROWSER_TEST_EXECUTABLE_PATH } : {}) }); t.after(() => browser.close());
  return { base, browser };
}
const skip = !modulePath && "Set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE after building the workbench";

test("an ended Turn does not show its tool as running, whether it completed, failed or was interrupted; a running or unknown Turn is left as it is; a status change and a reload agree", { skip }, async t => {
  const { base, browser } = await fixture(t);

  const open = async (width: number, height: number, scheme: "light" | "dark" = "light") => {
    const context = await browser.newContext({ viewport: { width, height }, colorScheme: scheme });
    const page = await context.newPage();
    const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
    await page.goto(`${base}/p/${projectId}/sessions?session=${encodeURIComponent(sessionKey)}&tab=activity`);
    await page.getByLabel("访问令牌").fill("fixture-token");
    await page.getByRole("button", { name: "进入", exact: true }).click();
    await page.locator(".workspace-tools").first().waitFor({ timeout: 30000 });
    await page.evaluate((mode: string) => { document.documentElement.dataset.theme = mode; }, scheme);   // the dark tokens hang on :root[data-theme="dark"]
    return { page, context, errors };
  };
  /** The one-line status of the tool group of a Turn, read from the page: what the reader is told. */
  const groupOf = (page: any, label: string) => page.locator(".workspace-tools").filter({ hasText: "命令" }).filter({ has: page.locator(`[data-turn-id]`) });
  const readGroups = async (page: any) => page.evaluate(() => [...document.querySelectorAll<HTMLElement>(".workspace-tools")].map(group => ({
    turn: group.querySelector<HTMLElement>("[data-turn-id]")?.getAttribute("data-turn-id") ?? null, text: group.innerText.replace(/\s+/g, " ").trim() })));
  const openAll = async (page: any) => { for (const toggle of await page.locator(".workspace-tools-toggle").all()) { if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click().catch(() => undefined); } };

  const { page, context, errors } = await open(1440, 900);
  await openAll(page);
  let groups = await readGroups(page);
  const by = (turn: string) => groups.find(g => g.turn === turn)!;
  for (const turn of ["t-done", "t-int", "t-fail"]) {
    assert.ok(!/正在进行|进行中/.test(by(turn).text), `${turn}: an ended Turn does not say 进行中 (${by(turn).text})`);
    assert.match(by(turn).text, /结果未确认/, `${turn}: its tool says the result was not confirmed`);
  }
  assert.ok(!/正在进行|进行中/.test(by("t-unk").text) && /结果未确认/.test(by("t-unk").text), `a Turn whose state is unknown does not confirm its tool as running (${by("t-unk").text})`);
  assert.match(by("t-switch").text, /正在进行|进行中/, "a Turn that is running shows its tool running");
  assert.match(by("t-live").text, /正在进行|进行中/, "a running Turn's live tool is running");
  if (shots) await page.screenshot({ path: `${shots}/turn-1440-before-switch.png`, fullPage: true });

  // A status change: the running Turn is interrupted; the page follows (poll) and the line is replaced, not left beside the new one.
  await (await fetch(`${base}/__fixture/switch?to=interrupted`)).text();
  await page.waitForFunction(() => { const g = [...document.querySelectorAll<HTMLElement>(".workspace-tools")].find(x => x.querySelector("[data-turn-id='t-switch']")); return !!g && !/正在进行|进行中/.test(g.innerText); }, undefined, { timeout: 30000 });
  await openAll(page);
  groups = await readGroups(page);
  assert.ok(!/正在进行|进行中/.test(by("t-switch").text), "after the interruption the switched Turn no longer shows 进行中");
  assert.match(by("t-switch").text, /结果未确认/);
  assert.equal((by("t-switch").text.match(/结果未确认/g) ?? []).length >= 1, true);
  // Completed and failed also read differently from interrupted where the page says so (the Turn summary line below the Turn).
  const body = await page.locator("body").innerText();
  assert.match(body, /这一轮已中断，等你决定是否继续/); assert.match(body, /这一轮失败，等你核对/);
  assert.deepEqual(errors, [], "no page error");
  if (shots) await page.screenshot({ path: `${shots}/turn-1440-after-switch.png`, fullPage: true });
  await context.close();

  // Reopened after a refresh (a fresh page reads the same final state), at 390 wide too, both themes.
  for (const [w, h, scheme] of [[1440, 900, "dark"], [390, 844, "light"], [390, 844, "dark"]] as const) {
    const r = await open(w, h, scheme);
    await openAll(r.page);
    const g = await readGroups(r.page);
    for (const turn of ["t-done", "t-int", "t-fail", "t-switch"]) {
      const row = g.find(x => x.turn === turn)!;
      assert.ok(row && !/正在进行|进行中/.test(row.text) && /结果未确认/.test(row.text), `${w} ${scheme} ${turn}: ${row?.text}`);
    }
    const overflow = await r.page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(overflow <= 0, `${w} ${scheme}: horizontal overflow ${overflow}px`);
    if (shots) await r.page.screenshot({ path: `${shots}/turn-${w}-${scheme}-reopened.png`, fullPage: true });
    await r.context.close();
  }
  void groupOf;
});

test("rows of one interrupted Turn: completed, failed, unconfirmed, pending, stale and running each have their own icon, colour and spoken name; only completed is a check, at 1440 and 390, light and dark", { skip }, async t => {
  const { base, browser } = await fixture(t);
  const expected: Record<string, string> = { "tool-t-done": "unknown", "tool-t-int": "unknown", "ok-int": "completed", "bad-int": "failed", "pend-int": "pending",
    "tool-t-unk": "unknown", "tool-none": "unknown", "live-live": "running", "stale-live": "stale" };
  const names: Record<string, string> = { unknown: "结果未确认", completed: "已完成", failed: "失败", pending: "待处理", running: "进行中", stale: "上次进行中，当前待核对" };
  for (const [w, h, scheme] of [[1440, 900, "light"], [1440, 900, "dark"], [390, 844, "light"], [390, 844, "dark"]] as const) {
    const context = await browser.newContext({ viewport: { width: w, height: h }, colorScheme: scheme });
    const page = await context.newPage();
    const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
    await page.goto(`${base}/p/${projectId}/sessions?session=${encodeURIComponent(sessionKey)}&tab=activity`);
    await page.getByLabel("访问令牌").fill("fixture-token"); await page.getByRole("button", { name: "进入", exact: true }).click();
    await page.locator(".workspace-tools").first().waitFor({ timeout: 30000 });
    await page.evaluate((mode: string) => { document.documentElement.dataset.theme = mode; }, scheme);
    for (const toggle of await page.locator(".workspace-tools-toggle").all()) { if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click().catch(() => undefined); }
    const rows = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>(".workspace-tool")].map(li => ({
      entry: li.getAttribute("data-workspace-entry")!, state: li.querySelector<HTMLElement>("[data-step-state]")?.getAttribute("data-step-state") ?? null,
      icon: li.querySelector("svg")?.getAttribute("class")?.match(/lucide-([a-z-]+)/)?.[1] ?? null, name: li.querySelector(".sr-only")?.textContent?.replace("：", "") ?? null,
      colour: getComputedStyle(li.querySelector("[data-step-state]")!).color })));
    const by = (id: string) => rows.find(r => r.entry === id)!;
    for (const [id, state] of Object.entries(expected)) {
      const r = by(id);
      assert.ok(r, `${w} ${scheme}: row ${id} is there`);
      assert.equal(r.state, state, `${w} ${scheme} ${id}: state`); assert.equal(r.name, names[state], `${w} ${scheme} ${id}: spoken name`);
      if (state === "completed") assert.equal(r.icon, "check", `${w} ${scheme}: completed is the check`);
      else assert.notEqual(r.icon, "check", `${w} ${scheme} ${id}: ${state} is not drawn as a check (icon ${r.icon})`);
    }
    // One icon per state, and unconfirmed / stale differ in colour from completed (so a glance at 390 wide tells them apart).
    const byState = new Map(Object.entries(expected).map(([id, state]) => [state, by(id)]));
    assert.equal(new Set([...byState.values()].map(r => r.icon)).size, byState.size, `${w} ${scheme}: one icon per state ${JSON.stringify([...byState].map(([k, v]) => [k, v.icon]))}`);
    for (const state of ["unknown", "stale"]) assert.notEqual(byState.get(state)!.colour, byState.get("completed")!.colour, `${w} ${scheme}: ${state} colour differs from completed`);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(overflow <= 0, `${w} ${scheme}: no horizontal overflow (${overflow}px)`);
    assert.deepEqual(errors, []);
    if (shots) await page.screenshot({ path: `${shots}/icons-${w}-${scheme}.png`, fullPage: true });
    await context.close();
  }
});
