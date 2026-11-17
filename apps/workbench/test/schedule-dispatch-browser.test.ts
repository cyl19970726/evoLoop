// Opt-in built-app regression: build workbench, then set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE (EVOLOOP_SCHEDULE_SCREENSHOT_DIR keeps the shots).
// Task 9e45cd20: 日程 shows what each trigger did and how the schedule hands its Task over: five trigger samples (generated, skipped for an open previous
// Task, fell back to the Leader, dispatched straight to a line, two skips in a row escalated), the dispatch facts, "未知" when a read fails, and the
// schedule definition told apart from a Task's own timing. At 1440x900 and 390x844.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const modulePath = process.env.EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE;
const shots = process.env.EVOLOOP_SCHEDULE_SCREENSHOT_DIR;
const dist = resolve(import.meta.dirname, "../dist");
const id = (n: number) => `43000${String(n).padStart(3, "0")}-0000-4000-8000-${String(n).padStart(12, "0")}`;
const projectId = id(1), roleId = id(2), directId = id(3), plainId = id(4), sessionId = id(5), entryId = id(6);
const taskDispatched = id(11), taskFellBack = id(12), taskGenerated = id(13), taskOpen = id(14), taskGate = id(15);
const stamp = "2026-11-17T01:00:00.000Z";
const at = (day: number) => `2026-11-${String(day).padStart(2, "0")}T01:00:00.000Z`;

function revision(scheduleId: string, title: string) {
  return { projectId, scheduleId, id: scheduleId, version: 1, timezone: "Asia/Taipei", rule: { kind: "daily", localTime: "09:00" }, misfire: { kind: "latest" }, overlap: "skip",
    template: { title, content: "核对来源", acceptance: "留下报告", owner: roleId, acceptanceMode: "human_required", consumer: "acceptance-owner" },
    authorization: { scopeId: "scope-dev", roleId, authorizedBy: "reader", expiresAtUtc: null }, reason: "首次建立", actorId: "reviewer-zhang", createdAtUtc: stamp };
}
const occurrence = (day: number, state: string, taskId: string | null, reason: string) => ({ projectId, scheduleId: directId, revisionId: directId, plannedAtUtc: at(day),
  observedAtUtc: at(day), state, taskId, operationId: id(100 + day), reason });
const log = (day: number, state: string, reason: string, taskId: string | null, extra: Record<string, unknown> = {}) => ({ scheduleId: directId, plannedAtUtc: at(day), state, reason, taskId,
  sessionId: null, entryId: null, templateHash: "h", roleRevisionId: null, executionConfig: {}, decidedAt: at(day), dispatchedAt: null, escalatedAt: null, ...extra });

test("schedule triggers: five samples, dispatch facts, unknown on a failed read, definition apart from Task timing; measured at 1440x900 and 390x844",
  { skip: !modulePath && "Set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE" }, async t => {
    const { chromium } = (await import(pathToFileURL(modulePath!).href)).default;
    let mode: "ok" | "fail" = "ok";
    const server = createServer(async (req, res) => {
      const url = new URL(req.url!, "http://127.0.0.1");
      if (url.pathname === "/__fixture") { mode = (url.searchParams.get("mode") as typeof mode) ?? mode; res.end("ok"); return; }
      if (url.pathname.startsWith("/api/")) {
        const base = `/api/projects/${projectId}`;
        let value: unknown = { items: [], nextCursor: null }, status = 200;
        if (url.pathname === "/api/session") value = { principal: { actorId: "reader", projectIds: [projectId], permissions: ["task", "document", "session", "management"], decisions: true }, capabilities: {} };
        else if (url.pathname === base) value = { id: projectId, title: "日程触发项目", createdAt: stamp };
        else if (url.pathname === `${base}/impacts`) value = [];
        else if (url.pathname === `${base}/schedules`) value = [
          { projectId, id: directId, version: 1, currentRevisionId: directId, state: "active", watermarkUtc: stamp, revision: revision(directId, "CI/CD 例行") },
          { projectId, id: plainId, version: 1, currentRevisionId: plainId, state: "active", watermarkUtc: stamp, revision: revision(plainId, "每日评估") },
        ];
        else if (url.pathname === `${base}/scheduling/status`) value = { state: "idle", lastTickAt: stamp, lastError: null, lastCreated: 0, grants: [] };
        else if (url.pathname === `${base}/schedules/${directId}/revisions`) value = [revision(directId, "CI/CD 例行")];
        else if (url.pathname === `${base}/schedules/${plainId}/revisions`) value = [revision(plainId, "每日评估")];
        else if (url.pathname === `${base}/schedules/${directId}/occurrences`) value = [
          occurrence(12, "created", taskDispatched, "scheduled"), occurrence(13, "created", taskFellBack, "scheduled"), occurrence(14, "created", taskGenerated, "scheduled"),
          occurrence(15, "skipped", null, "overlap skipped"), occurrence(16, "skipped", null, "overlap skipped"), occurrence(17, "created", taskGate, "scheduled")];
        else if (url.pathname === `${base}/schedules/${plainId}/occurrences`) value = [{ ...occurrence(12, "created", taskGenerated, "scheduled"), scheduleId: plainId, revisionId: plainId }];
        else if (url.pathname === `${base}/schedules/${directId}/dispatch`) {
          if (mode === "fail") { status = 500; value = { message: "boom" }; }
          else value = { projectId, scheduleId: directId, version: 3, mode: "direct", state: "active", waitLimitMinutes: 120, dailyRunBudget: 3, setRevisionId: directId, roleRevisionId: roleId,
            consecutiveFailures: 0, consecutiveSkips: 2, revertReason: null, actorId: "leader", reason: "试行", updatedAt: stamp };
        }
        else if (url.pathname === `${base}/schedules/${plainId}/dispatch`) value = null;
        else if (url.pathname === `${base}/schedules/${directId}/dispatches`) {
          if (mode === "fail") { status = 500; value = { message: "boom" }; }
          else value = { items: [
            log(12, "dispatched", "", taskDispatched, { sessionId, entryId, dispatchedAt: at(12), escalatedAt: at(12) }), log(13, "fell_back", "POLICY_PAUSED", taskFellBack),
            log(15, "skipped", "PREVIOUS_STILL_OPEN", taskOpen), log(16, "skipped", "PREVIOUS_STILL_OPEN", taskOpen),
            log(17, "fell_back", "NOT_AVAILABLE:RECOVERY_GATE_CLOSED", taskGate)], nextCursor: null };
        }
        else if (url.pathname === `${base}/schedules/${plainId}/dispatches`) value = { items: [], nextCursor: null };
        else if (url.pathname === `${base}/work-management/notices`) value = { items: url.searchParams.get("taskId") === taskOpen ? [{ id: id(200), projectId, kind: "schedule_skips_escalated", level: "digest",
          sourceEventId: id(201), taskId: taskOpen, taskRevisionId: taskOpen, sourceSessionId: null, sourceActorId: "dispatcher:schedule", sourceRef: `schedule:${directId}:skips@2026-11-16 01:00:00+00`,
          occurredAt: at(16), state: "delivered", messageId: id(202), operationId: id(203), linkedSessionId: null, blockedReason: null, stale: false, messageState: null, messageBlockedReason: null,
          processingState: null, nativeTurnId: null }] : [], nextCursor: null };
        else if (url.pathname === `${base}/roles/${roleId}`) value = { projectId, id: roleId, version: 1, currentRevisionId: roleId, state: "active", proposal: { title: "巡检职责" },
          proposedBy: "reader", createdAtUtc: stamp, trialStartedAtUtc: stamp, reviewAtUtc: stamp, mergeTargetRoleId: null };
        res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); return;
      }
      const file = join(dist, /^\/(?:$|p\/|ui$)/.test(url.pathname) ? "index.html" : url.pathname);
      try { const body = await readFile(file); res.writeHead(200, { "content-type": ({ ".html": "text/html", ".js": "text/javascript", ".css": "text/css" } as Record<string, string>)[extname(file)] ?? "application/octet-stream" }); res.end(body); }
      catch { res.writeHead(404); res.end(); }
    });
    await new Promise<void>(done => server.listen(0, "127.0.0.1", done)); t.after(() => server.close());
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const browser = await chromium.launch({ headless: true, ...(process.env.EVOLOOP_BROWSER_TEST_EXECUTABLE_PATH ? { executablePath: process.env.EVOLOOP_BROWSER_TEST_EXECUTABLE_PATH } : {}) });
    t.after(() => browser.close());
    const errors: string[] = [];
    const open = async (width: number, height: number, schedule: string, state: "ok" | "fail" = "ok") => {
      await fetch(`${base}/__fixture?mode=${state}`);
      const page = await browser.newPage({ viewport: { width, height } });
      page.on("pageerror", error => errors.push(error.message));
      await page.goto(`${base}/p/${projectId}/schedules?schedule=${schedule}`);
      await page.getByLabel("访问令牌").fill("fixture-token");
      await page.getByRole("button", { name: "进入", exact: true }).click();
      await page.locator(".schedule-definition").waitFor({ timeout: 8000 });
      return page;
    };

    for (const [width, height] of [[1440, 900], [390, 844]] as const) {
      const page = await open(width, height, directId);
      const card = page.locator(".schedule-definition");
      const facts = card.locator("[data-dispatch-facts]");
      await facts.getByText("直派到队伍").waitFor();
      const text = await facts.innerText();
      assert.match(text, /生效中/); assert.match(text, /连续跳过\s*2 次/); assert.match(text, /每日最多直派 3 次/);
      assert.match(text, /连续跳过已升级：读到 1 条通知/); assert.match(text, /等过上限，已告知 Leader/);
      await card.locator("[data-trigger-list] li").first().waitFor();
      const rows = await card.locator("[data-trigger-list] li").evaluateAll(items => items.map(item => ({ state: item.getAttribute("data-trigger-state"), text: (item as HTMLElement).innerText })));
      assert.equal(rows.length, 6, "all six triggers, newest first");
      // Newest first: day 17 fell back (no session available), day 16 skipped, 15 skipped, 14 generated (no log row), 13 fell back, 12 dispatched.
      assert.deepEqual(rows.map(row => row.state), ["fell_back", "skipped", "skipped", "created", "fell_back", "dispatched"]);
      // A real "no session can take it" reason is in words in the main view, with the code beside it; never "未收录".
      assert.match(rows[0].text, /恢复门还没打开/); assert.match(rows[0].text, /NOT_AVAILABLE:RECOVERY_GATE_CLOSED/); assert.doesNotMatch(rows[0].text, /未收录/);
      assert.match(rows[1].text, /已跳过，没有生成任务/); assert.match(rows[1].text, /上一次生成的任务还没关闭/); assert.match(rows[1].text, /PREVIOUS_STILL_OPEN/);
      assert.doesNotMatch(rows[1].text, /已创建待办任务|已直派/, "a skip is never shown as a success");
      assert.match(rows[3].text, /已创建待办任务 · 没有直派记录/);
      assert.match(rows[4].text, /交回 Leader 安排/); assert.match(rows[4].text, /POLICY_PAUSED/); assert.doesNotMatch(rows[4].text, /已直派到队伍/, "fell_back is not shown as dispatched");
      assert.match(rows[5].text, /已直派到队伍/); assert.match(rows[5].text, /放进队伍不等于已开始/);
      const links = await card.locator("[data-trigger-list] li a").evaluateAll(items => items.map(item => ({ text: item.textContent, href: item.getAttribute("href") })));
      assert.ok(links.some(link => link.text === "仍未关闭的上一个任务" && link.href!.includes(`/tasks/${taskOpen}`)), "a skip links the open Task it waited for");
      assert.ok(links.some(link => link.text === "阅读此任务" && link.href!.includes(`/tasks/${taskDispatched}`)));
      assert.match(await card.locator("[data-kind='schedule']").innerText(), /日程定义/);
      assert.match(await page.getByRole("region", { name: "定时任务" }).innerText(), /这不是上面的日程定义/);
      assert.equal(await page.evaluate("document.documentElement.scrollWidth <= document.documentElement.clientWidth"), true, `no horizontal overflow at ${width}`);
      if (shots) { await page.screenshot({ path: `${shots}/schedule-dispatch-${width}.png`, fullPage: true }); }
      await page.close();
    }

    // A schedule with no policy: the default, said as the default; nothing is invented.
    const plain = await open(1440, 900, plainId);
    await plain.locator("[data-dispatch-facts]").getByText("交 Leader 安排（没有登记直派策略，按默认）").waitFor();
    assert.doesNotMatch(await plain.locator("[data-dispatch-facts]").innerText(), /连续跳过|已升级/);
    await plain.close();

    // The dispatch reads fail: unknown, not "交 Leader", and the occurrences still list.
    const failed = await open(390, 844, directId, "fail");
    await failed.locator("[data-dispatch-facts]").getByText(/当前方式未知，不推断为交 Leader/).waitFor();
    await failed.getByText(/派发记录本次没有读到/).waitFor();
    assert.equal(await failed.locator("[data-trigger-list] li").count(), 6);
    assert.doesNotMatch(await failed.locator("[data-trigger-list]").innerText(), /已直派到队伍|交回 Leader/);
    if (shots) await failed.screenshot({ path: `${shots}/schedule-dispatch-390-unknown.png`, fullPage: true });
    await failed.close();
    assert.deepEqual(errors, []);
  });
