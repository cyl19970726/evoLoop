// Opt-in built-app regression for 待我处理 (docs/frontend/pages/tasks.md 收件页): signed in as a task's declared consumer,
// 等我使用的交付 lists every current delivery that waits for my use, read across both pages of the work index, and leaves
// out another consumer's, one I already used, one I last recorded as 使用失败 (back to rework, not mine), an older
// revision's; every row (等我使用, 依据变化, 待我验收) opens its task with the way back to 待我验收与判断.
// The 待我处理 count adds 验收安排, 依据变化 and 等我使用; when a part cannot be read it shows the 待核对 mark instead of a
// number and the shell says why, and the page never says 0. At 1440, 1024 and 390 (no sideways scroll).
// EVOLOOP_INBOX_SCREENSHOT_DIR=<dir> saves the screenshots.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const modulePath = process.env.EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE;
const shots = process.env.EVOLOOP_INBOX_SCREENSHOT_DIR;
const dist = resolve(import.meta.dirname, "../dist");
const id = (n: number) => `34000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const projectId = id(1), roleId = id(2);
const me = "test-consumer";
const stamp = "2026-11-09T01:00:00.000Z";
const at = (hour: number) => `2026-11-09T${String(hour).padStart(2, "0")}:00:00.000Z`;

interface Fixture { n: number; title: string; consumer: string | null; useRequired: boolean; observer?: string; result?: "used" | "failed" | "notUsed"; oldDelivery?: boolean }
const fixtures: Record<string, Fixture> = {
  mine: { n: 10, title: "甲：截图说明待你使用", consumer: me, useRequired: true },
  others: { n: 11, title: "乙：交给别人使用", consumer: "qa-agent", useRequired: true },
  used: { n: 12, title: "丙：我已经用过", consumer: me, useRequired: true, observer: me, result: "used" },
  observedByOther: { n: 13, title: "丁：别人后来也看过", consumer: me, useRequired: true, observer: "qa-agent", result: "used" },
  oldRevision: { n: 14, title: "戊：交付属于旧修订", consumer: me, useRequired: true, oldDelivery: true },
  declared: { n: 15, title: "己：只是声明的使用者", consumer: me, useRequired: false, observer: me, result: "notUsed" },
  failedByMe: { n: 16, title: "庚：我记过使用失败", consumer: me, useRequired: true, observer: me, result: "failed" },
};
const taskId = (f: Fixture) => id(f.n), revision = (f: Fixture) => id(100 + f.n), deliveryId = (f: Fixture) => id(200 + f.n);
const record = (f: Fixture) => ({ projectId, id: taskId(f), version: 2, currentRevisionId: revision(f), title: f.title, content: `# ${f.title}\n\n正文。`,
  contentDocumentId: id(300 + f.n), contentRevisionId: id(400 + f.n), kind: "implementation", acceptance: "打开成果并记录使用", owner: roleId, state: "in_progress" });
const projection = (f: Fixture) => ({
  kind: "task", taskId: taskId(f), version: 2, currentRevisionId: revision(f), workChangeSequence: f.n, title: f.title, taskKind: "implementation",
  taskState: "in_progress", phase: "awaiting_acceptance", nextAction: "agent text", responsible: { kind: "consumer", id: f.consumer, label: "x" },
  assignment: null, latestRun: null, pendingImpactCount: 0, queueHold: null, goal: null, stage: null, plan: null, dependencies: [], dependencyVersion: 0, review: null,
  delivery: { deliveryId: deliveryId(f), taskRevisionId: f.oldDelivery ? id(500 + f.n) : revision(f), technicalResult: "passed", consumer: f.consumer,
    useRequired: f.useRequired, observationResult: f.result ?? null, observationActorId: f.observer ?? null, observationKind: f.observer ? "human" : null },
  dates: { createdAt: stamp, businessChangedAt: stamp, startedAt: stamp, completedAt: null, observedAt: stamp }, latestProgress: null,
  timing: { createdAt: stamp, publication: { at: null, source: "unknown" }, observedAt: stamp, latestEffectiveProgress: null, executionActivity: null,
    current: { stage: "awaiting_acceptance", startedAt: at(f.n - 8), endedAt: null, source: { kind: "delivery", id: deliveryId(f) }, waitingFor: { kind: "consumer", id: f.consumer }, elapsedMs: null },
    rounds: [{ number: 1, startedAt: stamp, endedAt: null, elapsedMs: null, intervals: [{ stage: "awaiting_acceptance", startedAt: at(f.n - 8), endedAt: null,
      source: { kind: "delivery", id: deliveryId(f) }, waitingFor: { kind: "consumer", id: f.consumer } }] }] },
  actionKey: `task:${taskId(f)}`,
});
const observation = (f: Fixture, observer: string, result: string, createdAt: string) => ({ projectId, id: id(600 + f.n + (observer === me ? 0 : 50)), taskId: taskId(f),
  deliveryId: deliveryId(f), observer, observerKind: "human", result, evidence: "打开了成果", reason: "使用记录", actorId: observer, createdAt });
const detail = (f: Fixture) => ({
  task: record(f), revision: { ...record(f), taskId: taskId(f), id: revision(f), actorId: "lead", reason: "开始执行", createdAt: stamp },
  basis: null, links: [], impacts: [], decisions: [], judgements: [], closures: [],
  proposal: { projectId, taskId: taskId(f), taskRevisionId: revision(f), stageId: null, consumer: f.consumer, useRequired: f.useRequired,
    acceptanceMode: "human_required", evidence: "需求会话", stopCondition: "范围变化时停止", createdAt: stamp },
  deliveries: [{ projectId, id: deliveryId(f), taskId: taskId(f), taskRevisionId: revision(f), runId: null, artifactRef: "https://git.example/pr/42", artifactRevision: "b2",
    contentHash: "b".repeat(64), technicalResult: "passed", technicalEvidence: "构建通过", reason: "交付", actorId: "worker", createdAt: at(f.n - 8) }],
  observations: f === fixtures.observedByOther ? [observation(f, me, "notUsed", at(6)), observation(f, "qa-agent", "used", at(7))]
    : f.observer ? [observation(f, f.observer, f.result!, at(6))] : [],
});
const all = Object.values(fixtures);
const firstPage = [fixtures.mine, fixtures.others, fixtures.used], secondPage = [fixtures.observedByOther, fixtures.oldRevision, fixtures.declared, fixtures.failedByMe];

test("待我处理 lists what waits for my use and counts every part, or says it cannot", {
  skip: !modulePath && "Set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE", timeout: 240_000,
}, async t => {
  const { chromium } = (await import(pathToFileURL(modulePath!).href)).default;
  const failing = new Set<string>();
  const indexCursors: Array<string | null> = [];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, "http://127.0.0.1");
    if (url.pathname.startsWith("/__fixture/")) {
      const what = url.searchParams.get("what") ?? "";
      if (url.pathname === "/__fixture/fail") failing.add(what); else failing.delete(what);
      res.end("ok"); return;
    }
    if (!url.pathname.startsWith("/api/")) {
      try {
        const file = /^\/(?:$|p\/|ui$)/.test(url.pathname) ? "index.html" : url.pathname;
        res.writeHead(200, { "content-type": ({ ".html": "text/html", ".js": "text/javascript", ".css": "text/css" } as Record<string, string>)[extname(file)] ?? "application/octet-stream" });
        res.end(await readFile(join(dist, file)));
      } catch { res.writeHead(404); res.end(); }
      return;
    }
    const root = `/api/projects/${projectId}`;
    const path = decodeURIComponent(url.pathname);
    let value: unknown = { items: [], nextCursor: null }, status = 200;
    const fail = (what: string) => { if (failing.has(what)) { status = 503; value = { message: `${what} 暂不可读（夹具）` }; return true; } return false; };
    const task = all.find(f => path.startsWith(`${root}/tasks/${taskId(f)}`) || path === `${root}/work-management/tasks/${taskId(f)}`);
    if (path === "/api/session") value = { principal: { actorId: me, projectIds: [projectId], permissions: ["read", "write"], identityKind: "human" }, capabilities: {} };
    else if (path === root) value = { id: projectId, title: "使用者夹具", createdAt: stamp };
    else if (path === `${root}/acceptance-relay/mine`) { if (!fail("acceptance")) value = { items: [{ projectId, relayId: id(30), taskId: taskId(fixtures.others),
      taskRevisionId: revision(fixtures.others), deliveryId: deliveryId(fixtures.others), stage: "candidate", scopeKey: "shots", scopeDescription: "核对三张截图",
      entrypoint: null, publicationRef: null, version: 1, createdAt: stamp, readAt: null, observationId: null }] }; }
    else if (path === `${root}/impacts`) { if (!fail("impacts")) value = [{ projectId, id: id(31), taskId: taskId(fixtures.used), taskRevisionId: revision(fixtures.used),
      documentId: id(32), fromRevisionId: id(33), toRevisionId: id(34), state: "pending", decisionId: null, createdAt: stamp }]; }
    else if (path === `${root}/decisions-for-me`) { if (!fail("decisions")) value = { items: [], observedAt: stamp }; }
    else if (path === `${root}/work-management/index`) {
      const cursor = url.searchParams.get("cursor");
      indexCursors.push(cursor);
      if (!fail("index")) {
        const items = (cursor ? secondPage : firstPage).map(projection);
        value = { items, nextCursor: cursor ? null : "page-2", total: all.length, counts: { awaiting_acceptance: all.length }, changeSequence: 9, observedAt: stamp, partial: false };
      }
    }
    else if (path === `${root}/tasks`) value = { items: all.map(record), nextCursor: null };
    else if (path === `${root}/orchestration/work-status`) value = { items: all.map(f => ({ taskId: taskId(f), cognition: false, hasClosure: false, readyForAcceptance: true })) };
    else if (task && path === `${root}/work-management/tasks/${taskId(task)}`) value = projection(task);
    else if (task && path === `${root}/tasks/${taskId(task)}`) value = detail(task);
    else if (task && path.endsWith("/revisions")) value = [{ revision: detail(task).revision, basis: null }];
    else if (task && (path.endsWith("/timing") || path.endsWith("/assignment"))) value = null;
    else if (task && path.endsWith("/attention")) value = { followUp: null, followUpHistory: [], items: [], itemsNextCursor: null };
    else if (task && path.endsWith("/acceptance-relay")) value = { items: [] };
    else if (path === `${root}/roles/${roleId}`) value = { projectId, id: roleId, state: "active", proposal: { title: "开发" } };
    else if (path === `${root}/runtime`) value = { available: true, error: null, allowedCwds: [], grants: [] };
    else if (path === `${root}/runtime/sessions` || path === `${root}/runtime/runs` || path === `${root}/resident-queues` || path.startsWith(`${root}/references/tasks/`)) value = [];
    else if (path.startsWith(`${root}/documents/`)) { status = 404; value = { message: "无此文档" }; }
    res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value));
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done)); t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const fixture = (path: string) => fetch(`${base}/__fixture/${path}`);
  const browser = await chromium.launch({ headless: true, ...(process.env.EVOLOOP_BROWSER_TEST_EXECUTABLE_PATH ? { executablePath: process.env.EVOLOOP_BROWSER_TEST_EXECUTABLE_PATH } : {}) });
  t.after(() => browser.close());
  const errors: string[] = [];
  const open = async (path: string) => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, locale: "zh-CN", timezoneId: "Asia/Shanghai" });
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(`${base}${path}`);
    await page.getByLabel("访问令牌").fill("fixture-token");
    await page.getByRole("button", { name: "进入", exact: true }).click();
    return page;
  };
  // In-app navigation keeps the in-memory login.
  const go = (page: Awaited<ReturnType<typeof open>>, path: string) => page.evaluate(target => {
    const link = Object.assign(document.createElement("a"), { href: target }); document.body.append(link); link.click(); link.remove();
  }, path);
  const badge = async (page: Awaited<ReturnType<typeof open>>) => {
    const narrow = (page.viewportSize()?.width ?? 1440) < 760;
    return (await page.locator(`[data-shell="${narrow ? "tabs" : "rail"}"] a`, { hasText: "待我处理" }).innerText()).replace("待我处理", "").trim();
  };
  // A count that cannot be checked shows the 待核对 mark (a question mark named 数目待核对), never a number.
  const badgeUnknown = async (page: Awaited<ReturnType<typeof open>>) => {
    const narrow = (page.viewportSize()?.width ?? 1440) < 760;
    const mark = page.locator(`[data-shell="${narrow ? "tabs" : "rail"}"] a`, { hasText: "待我处理" }).locator('[data-count="unknown"]');
    await mark.waitFor();
    assert.equal(await mark.getAttribute("title"), "数目待核对");
    assert.doesNotMatch(await badge(page), /\d/);
  };
  const noSideways = async (page: Awaited<ReturnType<typeof open>>, label: string) => {
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    assert.ok(overflow <= 1, `${label}: no sideways page scroll (${overflow}px)`);
  };
  const shoot = async (page: Awaited<ReturnType<typeof open>>, name: string, ready: () => Promise<unknown>) => {
    for (const width of [1440, 1024, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await ready();
      await page.waitForTimeout(150);
      await noSideways(page, `${name} at ${width}`);
      if (shots) await page.screenshot({ path: `${shots}/${name}-${width}.png`, fullPage: true });
    }
    await page.setViewportSize({ width: 1440, height: 900 });
  };

  // Signed in as the declared consumer: both pages of the work index are read; three deliveries wait for me.
  const page = await open(`/p/${projectId}/inbox`);
  const inbox = page.locator("[data-inbox]");
  const deliveries = inbox.getByRole("region", { name: "等我使用的交付" });
  const list = deliveries.getByRole("list", { name: "等我使用的交付" });
  await list.getByText(fixtures.mine.title).waitFor();
  assert.deepEqual(await list.getByRole("listitem").evaluateAll(items => items.length), 3);
  assert.deepEqual(indexCursors.slice(0, 2), [null, "page-2"]);
  const text = await deliveries.innerText();
  for (const f of [fixtures.mine, fixtures.observedByOther, fixtures.declared]) assert.match(text, new RegExp(f.title));
  // My latest 使用失败 sends the delivery back to the executor for rework: not listed, not counted (N9).
  for (const f of [fixtures.others, fixtures.used, fixtures.oldRevision, fixtures.failedByMe]) assert.doesNotMatch(text, new RegExp(f.title));
  assert.match(text, /3 项/);
  const row = (f: Fixture) => list.getByRole("listitem").filter({ hasText: f.title });
  assert.match(await row(fixtures.mine).innerText(), /必须使用才能关闭 · 尚未记录使用[\s\S]*交付于 2026\/11\/9 10:00:00/);
  assert.match(await row(fixtures.declared).innerText(), /只是声明的使用者 · 你上次：未使用/);
  // Someone else observed after me: my own last observation is read from the task.
  assert.match(await row(fixtures.observedByOther).innerText(), /你上次：未使用[\s\S]*交付于 2026\/11\/9 13:00:00 · 你上次记录于 2026\/11\/9 14:00:00 · 这次交付最近一条观察来自别人/);
  assert.doesNotMatch(await inbox.innerText(), /34000000-|Session|Run\b|consumer/);
  // How reading and use are recorded is said in words, never as the command line (N10).
  assert.match(await inbox.getByRole("region", { name: "待我验收" }).innerText(), /由验收人本人记录/);
  assert.match(await inbox.getByRole("region", { name: "待我决定" }).innerText(), /当前没有等你决定的事项/);
  assert.doesNotMatch(await inbox.innerText(), /work acceptance|acceptance read|\bobserve\b/);
  assert.match(await deliveries.innerText(), /记过“使用失败”的交付由执行者返工，不在这里列出/);
  // 待我验收 1 + 依据变化 1 + 等我使用 3.
  await page.waitForFunction(() => document.querySelector('[data-shell="rail"]')?.textContent?.includes("待我处理5"));
  assert.equal(await badge(page), "5");
  await shoot(page, "inbox", () => list.getByText(fixtures.mine.title).waitFor());

  // The row opens the task's 交付与使用 tab and says where it came from.
  const link = row(fixtures.mine).getByRole("link");
  const target = new URL(await link.getAttribute("href") ?? "", base);
  assert.equal(target.pathname, `/p/${projectId}/tasks/${taskId(fixtures.mine)}`);
  assert.deepEqual([target.searchParams.get("tab"), target.searchParams.get("return"), target.searchParams.get("actor"), target.searchParams.get("returnTitle")],
    ["delivery", `/p/${projectId}/inbox`, me, "待我验收与判断"]);
  await link.click();
  const center = page.locator(`[data-task-page="${taskId(fixtures.mine)}"]`);
  await center.getByRole("tab", { name: /^交付与使用/, selected: true }).waitFor();
  await center.getByRole("tabpanel").filter({ visible: true }).locator(`[data-delivery="${deliveryId(fixtures.mine)}"]`).getByText("技术检查通过").waitFor();
  await shoot(page, "inbox-delivery-tab", () => center.getByRole("tab", { name: /^交付与使用/, selected: true }).waitFor());
  await center.getByRole("link", { name: "返回待我验收与判断" }).waitFor();

  // 依据变化 and 待我验收 open their tasks with the same way back (N1).
  await go(page, `/p/${projectId}/inbox`);
  const back = async (href: string | null, tab: string | null, task: Fixture) => {
    const url = new URL(href ?? "", base);
    assert.deepEqual([url.pathname, url.searchParams.get("tab"), url.searchParams.get("return"), url.searchParams.get("actor"), url.searchParams.get("returnTitle")],
      [`/p/${projectId}/tasks/${taskId(task)}`, tab, `/p/${projectId}/inbox`, me, "待我验收与判断"]);
  };
  const impactLink = inbox.getByRole("list", { name: "依据变化" }).getByRole("link").first();
  await back(await impactLink.getAttribute("href"), "basis", fixtures.used);
  await back(await inbox.getByRole("list", { name: "待我验收" }).getByRole("link").first().getAttribute("href"), null, fixtures.others);
  await impactLink.click();
  const impactTask = page.locator(`[data-task-page="${taskId(fixtures.used)}"]`);
  await impactTask.getByRole("tab", { name: /^依据与影响/, selected: true }).waitFor();
  await impactTask.getByRole("link", { name: "返回待我验收与判断" }).click();
  await page.waitForURL(url => url.pathname === `/p/${projectId}/inbox`);
  await inbox.getByRole("list", { name: "依据变化" }).waitFor();

  // A part that cannot be read again: the count shows 待核对 instead of a number, the shell says why away from 待我处理, the
  // page says 待核对.
  await go(page, `/p/${projectId}/inbox`);
  await fixture("fail?what=impacts");
  await inbox.getByRole("button", { name: "重新读取" }).first().click();
  await inbox.getByRole("region", { name: "依据变化" }).getByText("上次读回，当前待核对").waitFor({ timeout: 15000 });
  await page.waitForFunction(() => !/待我处理\d/.test(document.querySelector('[data-shell="rail"]')?.textContent ?? ""));
  await badgeUnknown(page);
  assert.equal(await page.getByText(/待我处理的数目暂时无法判断/).count(), 0, "the page itself says which part failed");
  await go(page, `/p/${projectId}/operations`);
  const notice = page.getByRole("status").filter({ hasText: "待我处理的数目暂时无法判断" });
  await notice.waitFor();
  assert.match(await notice.innerText(), /依据变化读取失败；已读回的 4 项不是全部/);
  await shoot(page, "inbox-count-unknown", () => page.getByRole("heading", { level: 1, name: "结果未知的操作" }).waitFor());
  await fixture("recover?what=impacts");
  await notice.getByRole("link", { name: "去待我处理核对" }).click();
  await inbox.getByRole("region", { name: "依据变化" }).getByRole("button", { name: "重新读取" }).click();
  await page.waitForFunction(() => document.querySelector('[data-shell="rail"]')?.textContent?.includes("待我处理5"));
  await page.close();

  // The work index cannot be read at all: no 0 项 and no 当前没有, the count shows 待核对 instead of a number.
  await fixture("fail?what=index");
  const failed = await open(`/p/${projectId}/inbox`);
  const failedInbox = failed.locator("[data-inbox]");
  const failedSection = failedInbox.getByRole("region", { name: "等我使用的交付" });
  await failedSection.getByRole("alert").getByText("等我使用的交付暂不可读取").waitFor({ timeout: 20000 });
  const failedText = await failedSection.innerText();
  assert.match(failedText, /暂不可读取/);
  assert.doesNotMatch(failedText, /0 项|当前没有/);
  await failedInbox.getByRole("region", { name: "依据变化" }).getByText("1 项").waitFor();
  await badgeUnknown(failed);
  await shoot(failed, "inbox-index-failed", () => failedSection.getByRole("alert").getByText("等我使用的交付暂不可读取").waitFor());
  await fixture("recover?what=index");
  await failed.close();

  assert.deepEqual(errors, []);
});
