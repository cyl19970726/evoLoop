// Opt-in built-app regression for Task 92ec6597: the "运行受阻" bar above every page is one line of plain words that names who is stopped and what the person
// has to do, links to the affected agent (one) or to 待我处理 (several, where the runtime-problem list has exactly as many rows as the line counts), is red
// only on an affected agent's own page, and is absent when nothing is held; 待我处理 puts what has content on top and folds the empty categories into one line.
// All IDs and API responses are synthetic fixture data; the fixture is read-only. EVOLOOP_HOLD_SCREENSHOT_DIR=<dir> saves screenshots.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const modulePath = process.env.EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE;
const shots = process.env.EVOLOOP_HOLD_SCREENSHOT_DIR;
const dist = resolve(import.meta.dirname, "../dist");
const projectId = "92000001-0000-4000-8000-000000000001";
const leader = "92000002-0000-4000-8000-000000000002", frontend = "92000003-0000-4000-8000-000000000003", idle = "92000004-0000-4000-8000-000000000004";
const holdId = "92000005-0000-4000-8000-000000000005";
const stamp = "2026-11-22T00:00:00.000Z";
const names: Record<string, string> = { [leader]: "统筹 Leader", [frontend]: "前端实现", [idle]: "不受影响的智能体" };
const cap = { available: true, reason: null };
const impact = (sessionId: string, blocked: boolean, queued: number) => ({ sessionId, gatePhase: blocked ? "blocked" : "open", blockedByQuotaFailure: blocked, queuedMessages: queued });
const hold = (impacts: ReturnType<typeof impact>[]) => ({ projectId, id: holdId, provider: "codex", state: "held", category: "quota_exhausted", causeSessionId: leader, causeMessageId: null,
  reason: "x", version: 4, openedAt: stamp, releasedAt: null, releasedBy: null, releaseReason: null, releaseSummary: null, impact: impacts, queuedMessages: impacts.reduce((n, i) => n + i.queuedMessages, 0) });
let holds: unknown[] = [];

test("the run-blocked bar is one plain line, goes to the affected object, and 待我处理 folds what is empty", { skip: !modulePath && "Set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE after building the workbench" }, async t => {
  const { chromium } = (await import(pathToFileURL(modulePath!).href)).default;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, "http://127.0.0.1");
    if (url.pathname.startsWith("/api/")) {
      if (req.method !== "GET") { res.writeHead(405); res.end(); return; }
      const root = `/api/projects/${projectId}`, path = decodeURIComponent(url.pathname);
      let value: unknown = { items: [], nextCursor: null };
      if (path === "/api/session") value = { principal: { actorId: "reader", projectIds: [projectId], permissions: [] }, capabilities: {} };
      else if (path === root) value = { id: projectId, title: "合成夹具项目", createdAt: stamp };
      else if (path === `${root}/runtime/provider-holds`) value = { items: holds, observedAtUtc: stamp };
      else if (path === `${root}/impacts`) value = [];
      else if (path === `${root}/work-management/index`) value = { items: [], nextCursor: null, total: 0, counts: {}, changeSequence: 1, observedAt: stamp, partial: false };
      else for (const [id, name] of Object.entries(names)) {
        if (path === `${root}/session-work/owned:${id}/profile`) value = { projectId, target: { kind: "owned", sessionId: id }, version: 1, displayName: name, purpose: null, membership: "current", tenure: "resident", actorId: "lead", reason: "fixture", updatedAt: stamp };
        if (path === `${root}/session-work/owned:${id}`) value = { session: { key: `owned:${id}`, title: name, target: { kind: "owned", sessionId: id }, profile: { displayName: name }, kind: "owned", roles: [], aliases: [], membership: "current", membershipReason: "fixture", runtimeState: "ready", busy: false, currentTask: null, latestBusinessRun: null, lastProgressAt: null, identity: null, capabilities: { observe: cap, send: { ...cap, mode: "owned-conversation" }, open: { ...cap, ref: null }, interrupt: cap, close: cap }, source: {}, metadata: { limitations: [] } }, metadata: { limitations: [] } };
        if (path === `${root}/session-work/owned:${id}/timeline`) value = { sessionKey: `owned:${id}`, sessionTitle: name, entries: [], pending: [], turns: [], nextCursor: null, messagesCursor: null, observedAt: stamp, partial: false, limitations: [], unsupportedKinds: [], live: { cursor: null, active: false }, capabilities: { history: true, live: false, originalToolDetail: false, reason: null }, metadata: { limitations: [] } };
      }
      res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(value)); return;
    }
    const file = join(dist, /^\/(?:$|p\/|ui$)/.test(url.pathname) ? "index.html" : url.pathname);
    if (!file.startsWith(`${dist}/`)) { res.writeHead(404); res.end(); return; }
    try { res.writeHead(200, { "content-type": ({ ".html": "text/html", ".js": "text/javascript", ".css": "text/css" } as Record<string, string>)[extname(file)] ?? "application/octet-stream" }); res.end(await readFile(file)); }
    catch { res.writeHead(404); res.end(); }
  });
  await new Promise<void>(resolveListen => server.listen(0, "127.0.0.1", resolveListen));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const browser = await chromium.launch({ headless: true, ...(process.env.EVOLOOP_BROWSER_TEST_EXECUTABLE_PATH ? { executablePath: process.env.EVOLOOP_BROWSER_TEST_EXECUTABLE_PATH } : {}) });
  t.after(() => browser.close());
  const open = async (page: Awaited<ReturnType<typeof browser.newPage>>, path: string) => {
    await page.goto(`${base}${path}`);
    await page.getByLabel("访问令牌").fill("fixture-token");
    await page.getByRole("button", { name: "进入", exact: true }).click();
  };
  const line = (page: Awaited<ReturnType<typeof browser.newPage>>) => page.locator("[data-provider-hold-line]");
  const shot = async (page: Awaited<ReturnType<typeof browser.newPage>>, name: string) => { if (shots) await page.screenshot({ path: `${shots}/${name}.png` }); };

  for (const width of [1440, 900]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    const pageErrors: string[] = [];
    page.on("pageerror", error => pageErrors.push(error.message));

    // Two affected agents (a third is not touched by the hold): one line, plain words, the count, no command, number or version.
    holds = [hold([impact(leader, true, 0), impact(frontend, false, 3), impact(idle, false, 0)])];
    await open(page, `/p/${projectId}/work`);
    await page.getByText(/统筹 Leader 等 2 个智能体停着/).first().waitFor();
    const box = (await line(page).boundingBox())!;
    assert.ok(box.height <= 44, `${width}: the bar is one line, ${box.height}px high (it was 105 at 1440 and 185 at 900)`);
    t.diagnostic(`bar height at ${width}: ${box.height}px (page 总高 ${await page.evaluate(() => document.documentElement.scrollHeight)})`);
    const text = await line(page).innerText();
    assert.match(text, /^模型服务 Codex 额度用完，统筹 Leader 等 2 个智能体停着：需要你充值或重新授权/);
    assert.doesNotMatch(text, /runtime\.providerHold|暂停编号|版本|92000005/, "the line has no command name, hold number or version");
    assert.equal(await page.locator("[data-provider-hold-bar]").getAttribute("data-here"), "false", "neutral on a page the hold does not touch");
    assert.equal(await page.locator("[data-provider-hold-link]").getAttribute("href"), `/p/${projectId}/inbox`, "several affected agents go to 待我处理");
    await shot(page, `hold-bar-neutral-${width}`);
    // Unfolded: the source layer has the full identifiers and the release command.
    await page.locator("[data-provider-hold-line]").click({ position: { x: 4, y: 4 } });
    const detail = page.locator("[data-provider-hold-detail]");
    await detail.waitFor();
    await detail.getByText("来源与完整标识").click();
    assert.match(await detail.innerText(), /runtime\.providerHold\.release[\s\S]*|暂停编号/);
    assert.match(await detail.innerText(), new RegExp(holdId));
    await shot(page, `hold-bar-open-${width}`);
    await page.locator("[data-provider-hold-line]").click({ position: { x: 4, y: 4 } });

    // The link lists exactly the agents the line counts; what is empty is one line.
    await page.locator("[data-provider-hold-link]").click();
    const rows = page.locator('[data-runtime-problems] ul[aria-label="受影响的智能体"] > li');
    await rows.first().waitFor();
    assert.equal(await rows.count(), 2, "the list has as many rows as the line says");
    assert.match(await rows.first().innerText(), /统筹 Leader/);
    const emptyLine = page.locator("[data-inbox-empty]");
    await emptyLine.waitFor();
    assert.match(await emptyLine.innerText(), /待我验收.*等我使用的交付.*待我决定.*依据变化.*用量与上下文告警/);
    assert.doesNotMatch(await emptyLine.innerText(), /只有你能办的运行问题/, "the category with content is not folded");
    const sections = await page.locator("[data-inbox] section h2").allInnerTexts();
    assert.deepEqual(sections.slice(0, 1), ["只有你能办的运行问题"], "the category with content is first");
    await shot(page, `inbox-runtime-${width}`);

    // One affected agent: the link goes straight to it; on its own page the line is red, on another agent's page it stays neutral.
    holds = [hold([impact(leader, true, 0)])];
    await open(page, `/p/${projectId}/work`);
    await page.getByText(/统筹 Leader 停着/).first().waitFor();
    assert.equal(await page.locator("[data-provider-hold-link]").getAttribute("href"), `/p/${projectId}/sessions?session=${encodeURIComponent(`owned:${leader}`)}`);
    await open(page, `/p/${projectId}/sessions?session=${encodeURIComponent(`owned:${leader}`)}`);
    await page.locator('[data-provider-hold-bar][data-here="true"]').waitFor();
    assert.equal((await line(page).boundingBox())!.height <= 44, true, `${width}: still one line when red`);
    await shot(page, `hold-bar-red-${width}`);
    await open(page, `/p/${projectId}/sessions?session=${encodeURIComponent(`owned:${idle}`)}`);
    await page.locator('[data-provider-hold-bar][data-here="false"]').waitFor();

    // Nothing held: no bar, and 待我处理 with every category empty says so in one line within one screen.
    holds = [];
    await open(page, `/p/${projectId}/inbox`);
    await page.locator("[data-inbox-empty]").waitFor();
    assert.equal(await page.locator("[data-provider-hold-bar]").count(), 0, "no hold, no bar");
    assert.match(await page.locator("[data-inbox-empty]").innerText(), /当前没有等你处理的事：.*只有你能办的运行问题/);
    assert.ok((await page.locator("[data-inbox]").boundingBox())!.height <= 300, "all empty: said within one screen");
    await shot(page, `inbox-empty-${width}`);
    assert.equal(pageErrors.length, 0, pageErrors.join(" | "));
    await page.close();
  }
});
