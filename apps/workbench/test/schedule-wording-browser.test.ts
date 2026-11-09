// Opt-in built-app regression: build workbench, then set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE.
// The schedule page speaks in the page's own words: scheduler reason codes and errors become Chinese, roles show their
// names, identifiers (operations, actors, scopes, the fixed managed target) sit in the source layer, and a reread that
// is running or failed never says "no grants".
import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const modulePath = process.env.EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE;
const shots = process.env.EVOLOOP_SCHEDULE_SCREENSHOT_DIR;
const dist = resolve(import.meta.dirname, "../dist");
const id = (n: number) => `42000${String(n).padStart(3, "0")}-0000-4000-8000-${String(n).padStart(12, "0")}`;
const projectId = id(1), roleId = id(2), stoppedId = id(3), managedId = id(4), taskId = id(5);
const operationA = id(6), operationB = id(7), loopId = id(8), stageId = id(9), goalId = id(10);
const stamp = "2026-11-09T01:00:00.000Z";
const leaked = /scheduled|overlap|clock moved|scope-dev|reviewer-zhang|acceptance-owner|Loop|Stage/;
const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-/;

function revision(scheduleId: string, managed: boolean) {
  return { projectId, scheduleId, id: scheduleId, version: 1, timezone: managed ? "Not/AZone" : "Asia/Taipei",
    rule: { kind: "daily", localTime: "09:00" }, misfire: { kind: "latest" }, overlap: "skip",
    template: managed
      ? { title: "受管巡检", content: "按阶段巡检", acceptance: "留下报告", owner: roleId, managedTarget: { loopId, stageId } }
      : { title: "每日巡检", content: "核对来源", acceptance: "留下报告", owner: roleId, acceptanceMode: "human_required", consumer: "acceptance-owner" },
    authorization: { scopeId: "scope-dev", roleId, authorizedBy: "reader", expiresAtUtc: null },
    reason: "首次建立", actorId: "reviewer-zhang", createdAtUtc: stamp };
}

test("schedule wording: reason codes and errors in words, names for roles, identifiers folded, grants undecided while rereading",
  { skip: !modulePath && "Set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE" }, async t => {
    const { chromium } = (await import(pathToFileURL(modulePath!).href)).default;
    let statusMode: "ok" | "hold" | "fail" | "granted" = "ok";
    let release: (() => void) | null = null;
    const server = createServer(async (req, res) => {
      const url = new URL(req.url!, "http://127.0.0.1");
      if (url.pathname === "/__fixture") {
        const next = url.searchParams.get("status");
        if (next) statusMode = next as typeof statusMode;
        if (url.searchParams.has("release")) { release?.(); release = null; }
        res.end("ok"); return;
      }
      if (url.pathname.startsWith("/api/")) {
        const base = `/api/projects/${projectId}`;
        let value: unknown = { items: [], nextCursor: null }, status = 200;
        if (url.pathname === "/api/session") value = { principal: { actorId: "reader", projectIds: [projectId], permissions: ["read", "write", "review"] }, capabilities: {} };
        else if (url.pathname === base) value = { id: projectId, title: "日程用语项目", createdAt: stamp };
        else if (url.pathname === `${base}/impacts`) value = [];
        else if (url.pathname === `${base}/schedules`) value = [
          { projectId, id: stoppedId, version: 1, currentRevisionId: stoppedId, state: "stopped", watermarkUtc: stamp, revision: revision(stoppedId, false) },
          { projectId, id: managedId, version: 1, currentRevisionId: managedId, state: "active", watermarkUtc: stamp, revision: revision(managedId, true) },
        ];
        else if (url.pathname === `${base}/scheduling/status`) {
          if (statusMode === "hold") await new Promise<void>(done => { release = done; });
          if (statusMode === "fail") { status = 503; value = { message: "scheduler unavailable" }; }
          else value = { state: "error", lastTickAt: stamp, lastError: "clock moved behind schedule watermark", lastCreated: 0,
            grants: statusMode === "granted" ? [{ projectId, actorId: "reader", scopeId: "scope-dev", roleId }] : [] };
        }
        else if (url.pathname === `${base}/schedules/${stoppedId}/revisions`) value = [revision(stoppedId, false)];
        else if (url.pathname === `${base}/schedules/${managedId}/revisions`) value = [revision(managedId, true)];
        else if (url.pathname === `${base}/schedules/${stoppedId}/occurrences`) value = [
          { projectId, scheduleId: stoppedId, revisionId: stoppedId, plannedAtUtc: "2026-11-08T01:00:00.000Z", observedAtUtc: "2026-11-08T01:00:05.000Z",
            state: "created", taskId, operationId: operationA, reason: "scheduled" },
          { projectId, scheduleId: stoppedId, revisionId: stoppedId, plannedAtUtc: stamp, observedAtUtc: "2026-11-09T01:00:05.000Z",
            state: "skipped", taskId: null, operationId: operationB, reason: "overlap skipped" },
        ];
        else if (url.pathname === `${base}/schedules/${managedId}/occurrences`) value = [];
        else if (url.pathname === `${base}/roles/${roleId}`) value = { projectId, id: roleId, version: 1, currentRevisionId: roleId, state: "active",
          proposal: { title: "巡检职责" }, proposedBy: "reader", createdAtUtc: stamp, trialStartedAtUtc: stamp, reviewAtUtc: stamp, mergeTargetRoleId: null };
        else if (url.pathname === `${base}/orchestration/loops/${loopId}`) value = { projectId, id: loopId, version: 1, goalId, stageId, bootstrapEventId: loopId,
          cognitiveRoleId: roleId, allowedBusinessRoleIds: [roleId], sourceAfter: null, maxRuns: 3, maxConcurrent: 1, dispatchCount: 0, state: "active",
          enrolledBy: "reader", createdAtUtc: stamp, updatedAtUtc: stamp };
        else if (url.pathname === `${base}/stages/${stageId}`) value = { projectId, id: stageId, goalId, version: 1, state: "active",
          deliverable: "每周巡检报告", learningQuestion: "巡检能否发现漂移", createdAt: stamp, actorId: "reader" };
        res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); return;
      }
      const file = join(dist, /^\/(?:$|p\/|ui$)/.test(url.pathname) ? "index.html" : url.pathname);
      try { const body = await readFile(file); res.writeHead(200, { "content-type": ({ ".html": "text/html", ".js": "text/javascript", ".css": "text/css" } as Record<string, string>)[extname(file)] ?? "application/octet-stream" }); res.end(body); }
      catch { res.writeHead(404); res.end(); }
    });
    await new Promise<void>(done => server.listen(0, "127.0.0.1", done)); t.after(() => { release?.(); server.close(); });
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const fixture = (query: string) => fetch(`${base}/__fixture?${query}`);
    const browser = await chromium.launch({ headless: true, ...(process.env.EVOLOOP_BROWSER_TEST_EXECUTABLE_PATH ? { executablePath: process.env.EVOLOOP_BROWSER_TEST_EXECUTABLE_PATH } : {}) });
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(`${base}/p/${projectId}/schedules`);
    await page.getByLabel("访问令牌").fill("fixture-token");
    await page.getByRole("button", { name: "进入", exact: true }).click();
    const rail = page.getByRole("navigation", { name: "日程" });
    await rail.getByRole("button", { name: /每日巡检/ }).click();
    if (await page.getByRole("button", { name: "展开右栏" }).count()) await page.getByRole("button", { name: "展开右栏" }).click();
    const card = page.locator(".schedule-definition");
    const panel = page.getByRole("complementary", { name: "右栏" });

    // A stopped schedule still shows its role by name, its designated acceptor, and why each instant ended as it did.
    await card.getByText("责任 巡检职责").waitFor({ timeout: 5000 }).catch(async () => assert.fail(`Role not named: ${await card.innerText()} ${errors.join(" | ")}`));
    await card.getByText("已指定，身份见下方来源").waitFor();
    await card.getByText("到了规则时刻，按规则创建任务").waitFor();
    await card.getByText("上一份任务还没结束，按设置跳过这个时刻").waitFor();
    await page.getByText(/协调器状态：检查失败，最近一次检查出错/).waitFor();
    await panel.getByText("最近一次检查出错，原文见来源").first().waitFor();
    await panel.getByText(/按职责“巡检职责”授权/).first().waitFor();
    await panel.getByText(/^没有；已有安排可阅读/).waitFor();
    await card.getByText(/日程修订 · 1 版已读/).click();
    await card.getByText(/修订于/).waitFor();
    for (const text of [await card.innerText(), await panel.innerText(), await page.locator("#workspace-main").innerText()]) {
      assert.doesNotMatch(text, leaked);
      assert.doesNotMatch(text, uuid, "no raw identifier in the main layer");
    }
    // The identifiers are one click away.
    await card.getByText("来源与完整标识（含固定目标）").click();
    assert.match(await card.innerText(), /acceptance-owner/);
    assert.match(await card.innerText(), new RegExp(stoppedId));
    const firstOccurrence = card.locator("li").filter({ hasText: "到了规则时刻" });
    await firstOccurrence.getByText("来源与完整标识").click();
    assert.match(await firstOccurrence.innerText(), new RegExp(operationA));
    const revisionItem = card.locator("li").filter({ hasText: "首次建立" });
    await revisionItem.getByText("来源与完整标识").click();
    assert.match(await revisionItem.innerText(), /reviewer-zhang/);
    const grantRows = panel.locator("section").filter({ hasText: "授权与协调器" });
    await grantRows.getByText("来源与完整标识").first().click();
    assert.match(await grantRows.innerText(), /scope-dev/);
    if (shots) await page.screenshot({ path: `${shots}/schedule-wording-1440.png`, fullPage: true });

    // A managed schedule: the fixed target's identifiers come back in the source layer; a bad timezone cannot be worked out.
    await rail.getByRole("button", { name: /受管巡检/ }).click();
    await panel.getByText(/阶段产物：每周巡检报告（工作链可运行）/).waitFor();
    await panel.getByText("无法推算：规则的时区或时间不合法").waitFor();
    await card.getByText("来源与完整标识（含固定目标）").click();
    for (const value of [loopId, stageId, goalId]) assert.match(await card.innerText(), new RegExp(value));

    // While the grants are reread, and after the reread fails, the page does not claim there are none.
    await fixture("status=hold");
    await page.getByRole("button", { name: "回读当前状态" }).click();
    await panel.getByText("正在重新核对授权，暂不能判断").waitFor();
    assert.match(await panel.innerText(), /以下为上次读回，当前待核对（正在重新读取）/);
    assert.doesNotMatch(await panel.innerText(), /没有；已有安排可阅读/);
    await fixture("status=fail&release=1");
    await page.getByText(/日程与授权本次未读完整/).waitFor();
    await panel.getByText("授权未能重新读取，无法判断").waitFor();
    assert.match(await panel.innerText(), /以下为上次读回，当前待核对（重新读取失败）/);
    assert.doesNotMatch(await panel.innerText(), /没有；已有安排可阅读/);
    await fixture("status=granted");
    await page.getByRole("button", { name: "回读当前状态" }).click();
    await panel.getByText(/以下为上次读回/).waitFor({ state: "detached" });
    await panel.getByText("无法推算：规则的时区或时间不合法").waitFor();
    assert.match(await panel.innerText(), /当前身份的日程授权\s*按职责“巡检职责”授权/);

    await page.setViewportSize({ width: 1024, height: 900 });
    assert.equal(await page.getByRole("dialog").count(), 0, "the right drawer does not open by itself");
    if (shots) {
      await page.screenshot({ path: `${shots}/schedule-wording-1024.png`, fullPage: true });
      await page.getByRole("button", { name: "展开右栏" }).click();
      await page.getByRole("dialog").waitFor();
      await page.screenshot({ path: `${shots}/schedule-wording-1024-panel.png` });
      await page.getByRole("button", { name: "关闭右栏" }).click();
    }
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate("document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1"), true, "the schedule fits 390px");
    if (shots) await page.screenshot({ path: `${shots}/schedule-wording-390.png`, fullPage: true });
    assert.deepEqual(errors, []);
  });
