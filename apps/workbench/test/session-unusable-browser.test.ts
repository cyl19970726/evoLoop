// Opt-in built-app regression (Task 6612e287 rework): the workbench says 不可用 + the reason for a Session the coordinator judged unable to start a Run,
// in the Session directory, the header of its page and 统筹安排 (where it is not counted as free), while a bound Session still reads as free.
// Needs the built workbench and EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE; EVOLOOP_UNUSABLE_SCREENSHOT_DIR=<dir> saves screenshots.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const modulePath = process.env.EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE;
const shots = process.env.EVOLOOP_UNUSABLE_SCREENSHOT_DIR;
const dist = process.env.EVOLOOP_BROWSER_TEST_DIST ?? resolve(import.meta.dirname, "../dist");
const projectId = "99000001-0000-4000-8000-000000000001";
const badId = "99000002-0000-4000-8000-000000000002", goodId = "99000003-0000-4000-8000-000000000003";
const stamp = "2026-11-01T12:00:00.000Z";
const metadata = { generatedAt: stamp, sourceObservedAt: stamp, partial: false, limitations: [] };
const unavailable = { available: false, reason: "fixture unavailable" };
const resources = Object.fromEntries(["configuredModel", "actualModel", "inputTokens", "outputTokens", "cost", "processMemory"]
  .map(key => [key, { value: null, unit: "", source: null, scope: "session", observedAt: null, interval: null, unavailableReason: "未记录" }]));
const reason = "没有绑定业务身份：这个 Session 没有自己的 materialCli 条目，业务身份不会从 Role 猜";
let mode: "judged" | "older" = "judged";   // "older": a server that does not judge (no `dispatch` at all)
const dispatchOf = (id: string) => mode === "older" ? {} : { dispatch: id === badId ? { usable: false, reasons: [{ code: "BUSINESS_IDENTITY_UNBOUND", reason }] } : { usable: true, reasons: [] } };
const agent = (id: string, title: string) => ({ key: `owned:${id}`, target: { kind: "owned", sessionId: id }, aliases: [], title, profile: null, identity: null, kind: "owned",
  roles: [{ id: "99000009-0000-4000-8000-000000000009", title: "功能开发", state: "active", roleClass: "business", templateKey: null, responsibility: "开发" }],
  membership: "current", membershipReason: "fixture", runtimeState: "ready", busy: false, currentTask: null, latestBusinessRun: null, lastProgressAt: stamp,
  capabilities: { observe: unavailable, send: { available: true, reason: null, mode: "owned-conversation" }, open: { ...unavailable, ref: null }, interrupt: unavailable, close: unavailable },
  source: { kind: "session", id, revision: null, evidence: "project-record", href: "" }, metadata, ...dispatchOf(id) });
const snapshot = (id: string, title: string) => ({ session: agent(id, title), observationCursor: "0", currentWork: null, assignments: [], roleTasks: [], queue: [], results: [], questions: [], activity: [], resources, metadata });

test("the workbench labels an unusable Session 不可用 with its reason and does not count it as free; a bound Session is still free; an older server reads as before", {
  skip: !modulePath && "Set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE after building the workbench",
}, async t => {
  const { chromium } = (await import(pathToFileURL(modulePath!).href)).default;
  if (shots) mkdirSync(shots, { recursive: true });
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, "http://127.0.0.1");
    if (url.pathname.startsWith("/api/")) {
      const root = `/api/projects/${projectId}`;
      let value: unknown = { items: [], nextCursor: null, metadata };
      if (url.pathname === "/api/session") value = { principal: { actorId: "reader", projectIds: [projectId], permissions: ["read", "write"] }, capabilities: {} };
      else if (url.pathname === root) value = { id: projectId, title: "测试项目", createdAt: stamp };
      else if (url.pathname === `${root}/session-work`) value = { items: [agent(badId, "没绑身份的开发"), agent(goodId, "已绑身份的开发")], nextCursor: null, observationCursor: "0", metadata,
        totals: { current: 2, historical: 0, unclassified: 0 }, attention: { unansweredQuestions: 0, pendingMessages: 0, pendingAcceptance: null, unclassifiedSessions: 0 } };
      else if (url.pathname === `${root}/session-work/changes`) value = { items: [], nextCursor: "0", hasMore: false, resetRequired: false, metadata };
      else if (url.pathname === `${root}/work-management/index`) value = { items: [], nextCursor: null, partial: false, observedAt: stamp };
      else if (url.pathname === `${root}/resident-queues`) value = [];
      else if (url.pathname === `${root}/impacts` || url.pathname === `${root}/runtime/runs` || url.pathname === `${root}/runtime/sessions` || url.pathname.startsWith(`${root}/references/`)) value = [];
      else if (url.pathname === `${root}/runtime`) value = { available: false, error: null, allowedCwds: [], grants: [] };
      else if (url.pathname.startsWith(`${root}/session-work/`) && url.pathname.endsWith("/timeline")) value = { sessionKey: `owned:${badId}`, sessionTitle: "x", entries: [], pending: [], turns: [], nextCursor: null, messagesCursor: null, observedAt: stamp, partial: false, limitations: [], unsupportedKinds: [],
        live: { cursor: "0", resetRequired: false, entries: [], turns: [], freshness: "live", limitations: [], activeTurnId: null }, capabilities: { history: true, live: true, originalToolDetail: false, reason: null } };
      else if (url.pathname.startsWith(`${root}/session-work/`) && !url.pathname.includes("/timeline")) {
        const key = decodeURIComponent(url.pathname.slice(`${root}/session-work/`.length)); const id = key.replace("owned:", "");
        value = snapshot(id, id === badId ? "没绑身份的开发" : "已绑身份的开发");
      } else if (url.pathname.endsWith("/recovery")) { res.writeHead(404, { "content-type": "application/json" }); res.end("{}"); return; }
      res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(value)); return;
    }
    if (url.pathname === "/__fixture/older") { mode = "older"; res.end("ok"); return; }
    if (url.pathname === "/__fixture/judged") { mode = "judged"; res.end("ok"); return; }
    try {
      const file = /^\/(?:$|p\/|ui$)/.test(url.pathname) ? "index.html" : url.pathname;
      const body = await readFile(join(dist, file));
      res.writeHead(200, { "content-type": ({ ".html": "text/html", ".js": "text/javascript", ".css": "text/css" } as Record<string, string>)[extname(file)] ?? "application/octet-stream" }); res.end(body);
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise<void>(listening => server.listen(0, "127.0.0.1", listening)); t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const browser = await chromium.launch({ headless: true, ...(process.env.EVOLOOP_BROWSER_TEST_EXECUTABLE_PATH ? { executablePath: process.env.EVOLOOP_BROWSER_TEST_EXECUTABLE_PATH } : {}) }); t.after(() => browser.close());

  const open = async (width: number, height: number, path: string, scheme: "light" | "dark" = "light") => {
    const context = await browser.newContext({ viewport: { width, height } });
    const page = await context.newPage();
    const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
    await page.goto(`${base}/p/${projectId}${path}`);
    await page.getByLabel("访问令牌").fill("fixture-token"); await page.getByRole("button", { name: "进入", exact: true }).click();
    return { page, context, errors, theme: (mode: string) => page.evaluate((m: string) => { document.documentElement.dataset.theme = m; }, mode), scheme };
  };

  // 统筹安排 at 1440 and 390, light and dark.
  for (const [w, h, scheme] of [[1440, 900, "light"], [1440, 900, "dark"], [390, 844, "light"]] as const) {
    const r = await open(w, h, "/sessions", scheme);
    await r.page.getByRole("heading", { name: "统筹安排", exact: true }).waitFor({ timeout: 30000 });
    await r.page.getByText("没绑身份的开发").first().waitFor({ timeout: 30000 });
    await r.theme(scheme);
    const board = await r.page.locator(".arrangement-page").innerText();
    assert.match(board, /不可用 · 没有绑定业务身份/, `${w} ${scheme}: the arrangement board says 不可用 and why`);
    // The right-hand panel is a drawer on a narrow screen; at 1440 it is on the page.
    if (w >= 1100) assert.match(await r.page.locator("body").innerText(), /另有 1 个智能体不可用/, `${w} ${scheme}: the panel counts it apart from free agents`);
    const rows = await r.page.locator(".arrangement-row").evaluateAll((els: Element[]) => els.map(el => (el as HTMLElement).innerText.replace(/\s+/g, " ")));
    const bad = rows.find(x => x.includes("没绑身份的开发"))!, good = rows.find(x => x.includes("已绑身份的开发"))!;
    assert.ok(/不可用/.test(bad) && !/无在途工作/.test(bad), `${w} ${scheme}: the unusable row (${bad})`);
    assert.ok(/无在途工作/.test(good) && !/不可用/.test(good), `${w} ${scheme}: the bound Session still reads as before (${good})`);
    if (w >= 1100) {
      const free = await r.page.locator("section[aria-label=空闲与过载]").innerText();
      assert.ok(free.includes("已绑身份的开发") && !free.includes("没绑身份的开发"), `${w} ${scheme}: only the bound Session is in the free list (${free.replace(/\s+/g, " ")})`);
    }
    assert.ok((await r.page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)) <= 0, `${w} ${scheme}: no horizontal overflow`);
    assert.deepEqual(r.errors, []);
    if (shots) await r.page.screenshot({ path: `${shots}/arrangement-${w}-${scheme}.png`, fullPage: true });
    await r.context.close();
  }

  // The Session's own page: header and directory entry.
  const s = await open(1440, 900, `/sessions?session=${encodeURIComponent(`owned:${badId}`)}`);
  await s.page.getByRole("heading", { name: "没绑身份的开发" }).first().waitFor({ timeout: 30000 });
  const text = await s.page.locator("body").innerText();
  assert.match(text, /不可用 · 没有绑定业务身份/, "the Session page and its directory entry say 不可用");
  if (shots) await s.page.screenshot({ path: `${shots}/session-header-1440-light.png`, fullPage: true });
  await s.context.close();

  // An older server (no `dispatch`): the old wording, nothing invented.
  await (await fetch(`${base}/__fixture/older`)).text();
  const o = await open(1440, 900, "/sessions");
  await o.page.getByText("没绑身份的开发").first().waitFor({ timeout: 30000 });
  const old = await o.page.locator(".arrangement-page").innerText();
  assert.ok(!/不可用/.test(old), "a server that does not judge shows no 不可用 label");
  await o.context.close();
});
