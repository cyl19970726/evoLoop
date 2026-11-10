// Opt-in built-app regression: build workbench, then set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE.
// The overview speaks in the page's own words: the server's agent-facing text, state codes and identifiers stay in the
// source layer, a failed read never becomes "none", and every active stage can be chosen at any width.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const modulePath = process.env.EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE;
const shots = process.env.EVOLOOP_OVERVIEW_SCREENSHOT_DIR;
const dist = resolve(import.meta.dirname, "../dist");
const id = (n: number) => `41000${String(n).padStart(3, "0")}-0000-4000-8000-${String(n).padStart(12, "0")}`;
const projectId = id(1), roleId = id(2), sessionId = id(3), attentionTask = id(4), activeTask = id(5);
const heldTask = id(6), currentTask = id(7), queueId = id(8), goalId = id(9), previousTask = id(20);
const stageIds = [id(11), id(12), id(13), id(14)];
const stamp = "2026-11-09T08:00:00.000Z";
const sessionKey = `owned:${sessionId}`;
// Server wording that must not reach the main text.
const leaked = /prerequisite not accepted|dispatching|retirement-pending|先按原 Run|operation|负责 Role|受管 Session|HostLink/;
const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-/;

function listedTask(taskId: string, title: string, state: "todo" | "in_progress") {
  return { projectId, id: taskId, version: 1, currentRevisionId: taskId, title, content: "正文", contentDocumentId: taskId,
    contentRevisionId: taskId, kind: "implementation", acceptance: "验收", owner: roleId, state };
}
function entry(taskId: string, position: number, state: string, holdCode: string | null, holdReason: string | null) {
  return { projectId, queueId, id: taskId, taskId, taskRevisionId: taskId, sourceInputJson: "{}", sessionId, roleId, position,
    dependsOn: [], consumerId: "acceptance-owner", useRequired: true, releaseRule: "accepted", state, holdCode, holdReason,
    claimId: state === "claimed" ? taskId : null, version: 1 };
}

test("overview wording: next step and responsibility in words, codes mapped, identifiers folded, failed reads undecided",
  { skip: !modulePath && "Set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE" }, async t => {
    const { chromium } = (await import(pathToFileURL(modulePath!).href)).default;
    let timingMode: "fail" | "none" | "waiting" = "fail";
    let responsibleMode: "role" | "session" = "role";
    const server = createServer(async (req, res) => {
      const url = new URL(req.url!, "http://127.0.0.1");
      if (url.pathname === "/__fixture") {
        timingMode = (url.searchParams.get("timing") as typeof timingMode | null) ?? timingMode;
        responsibleMode = (url.searchParams.get("responsible") as typeof responsibleMode | null) ?? responsibleMode;
        res.end("ok"); return;
      }
      if (url.pathname.startsWith("/api/")) {
        const base = `/api/projects/${projectId}`;
        let value: unknown = { items: [], nextCursor: null }, status = 200;
        if (url.pathname === "/api/session") value = { principal: { actorId: "reader", projectIds: [projectId], permissions: ["read"] }, capabilities: {} };
        else if (url.pathname === base) value = { id: projectId, title: "用语回归项目", createdAt: stamp };
        else if (url.pathname === `${base}/impacts`) value = [];
        else if (url.pathname === `${base}/goals`) value = { items: [{ projectId, id: goalId, version: 1, outcome: "让新用户第一次就能用上",
          constraints: "不改接口", consumer: "新用户", authority: "项目负责人", scope: "工作台", owner: roleId, createdAt: stamp, actorId: "reader" }], nextCursor: null };
        else if (url.pathname === `${base}/stages`) value = stageIds.map((stageId, index) => ({ projectId, id: stageId, goalId, version: 1, state: "active",
          deliverable: `阶段交付 ${index + 1}`, learningQuestion: `要弄清的问题 ${index + 1}`, createdAt: stamp, actorId: "reader" }));
        else if (url.pathname === `${base}/work-management/index`) value = { items: [{
          kind: "task", taskId: attentionTask, version: 1, currentRevisionId: attentionTask, workChangeSequence: 1, title: "核对上次执行",
          taskKind: "implementation", taskState: "in_progress", phase: "unknown", nextAction: "先按原 Run 与 operation 对账；结果不明时不要重复派发",
          responsible: responsibleMode === "role" ? { kind: "role", id: roleId, label: `负责 Role ${roleId}` } : { kind: "session", id: sessionId, label: `受管 Session ${sessionId}` },
          assignment: responsibleMode === "session" ? { state: "accepted", targetKind: "owned", targetId: sessionId, recipientActorId: null } : null,
          latestRun: null, delivery: null, pendingImpactCount: 0, queueHold: null, goal: null, stage: null, plan: null, dependencies: [], dependencyVersion: 0,
          review: null, dates: { createdAt: stamp, businessChangedAt: stamp, startedAt: null, completedAt: null, observedAt: stamp }, actionKey: "fixture",
        }], nextCursor: null, partial: false, changeSequence: 1, total: 1, counts: {}, observedAt: stamp };
        else if (url.pathname === `${base}/orchestration/work-status`) value = { items: (url.searchParams.get("taskIds") ?? "").split(",").filter(Boolean).map(taskId => ({
          taskId, cognition: false, dispatchId: null, dispatchState: null, outcome: null, runId: null, runState: null,
          unsettledRunState: taskId === activeTask ? "dispatching" : null, loopState: null, goalOutcome: null, stageDeliverable: null, sourceKind: null,
          sourceTaskId: null, sourceTaskTitle: null, decisionKind: null, decisionReason: null, useRequired: null, deliveryId: null, technicalResult: null,
          observationResult: null, observerKind: null, hasClosure: false, readyForAcceptance: false })) };
        else if (url.pathname === `${base}/tasks`) value = { items: [listedTask(activeTask, "进行中的改版", "in_progress")], nextCursor: null };
        else if (url.pathname === `${base}/tasks/${activeTask}/timing`) {
          if (timingMode === "fail") { status = 503; value = { message: "timing store unavailable" }; }
          else value = timingMode === "none" ? null : { projectId, taskId: activeTask, seriesId: activeTask, rootTaskId: previousTask, version: 2,
            executeAtUtc: stamp, timezone: "Asia/Taipei", repeat: "daily", seriesState: "active", previousTaskId: previousTask, nextTaskId: null,
            nextAtUtc: "2026-11-10T08:00:00.000Z", waitingReason: `上一份任务 ${previousTask} 仍为进行中`,
            futureTemplate: { title: "每日改版", content: "正文", acceptance: "验收" },
            occurrences: [{ taskId: previousTask, executeAtUtc: "2026-11-08T08:00:00.000Z", state: "in_progress" }, { taskId: activeTask, executeAtUtc: stamp, state: "in_progress" }] };
        }
        else if (url.pathname.startsWith(`${base}/tasks/`)) {
          const taskId = url.pathname.split("/").at(-1)!;
          const task = { ...listedTask(taskId, taskId === heldTask ? "等依赖的任务" : "当前承接的任务", "in_progress") };
          value = { task, revision: { ...task, taskId, actorId: "reader", reason: "夹具", createdAt: stamp }, basis: null, links: [], impacts: [], decisions: [] };
        }
        else if (url.pathname === `${base}/resident-queues`) value = [{ projectId, id: queueId, version: 2, adoptedVersion: 2, maxRuns: 6, reason: "先做当前项", actorId: "lead", entries: [
          entry(currentTask, 0, "claimed", null, null), entry(heldTask, 1, "held", "dependency", "prerequisite not accepted")] }];
        else if (url.pathname === `${base}/roles/${roleId}`) value = { projectId, id: roleId, version: 1, currentRevisionId: roleId, state: "retirement-pending",
          proposal: { title: "开发职责" }, proposedBy: "reader", createdAtUtc: stamp, trialStartedAtUtc: stamp, reviewAtUtc: stamp, mergeTargetRoleId: null };
        else if (url.pathname === `${base}/session-work/${encodeURIComponent(sessionKey)}/profile`) value = { projectId, target: { kind: "owned", sessionId },
          version: 1, displayName: "前端智能体", purpose: null, membership: "current", tenure: "resident", actorId: "reader", reason: "夹具", updatedAt: stamp };
        // An agent is named from its directory record (agentDisplayName), with the registered name.
        else if (url.pathname === `${base}/session-work/${encodeURIComponent(sessionKey)}`) value = { session: { key: sessionKey, kind: "owned", title: "开发职责",
          roles: [], profile: { displayName: "前端智能体" } }, observationCursor: "0", currentWork: null };
        res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); return;
      }
      const file = join(dist, /^\/(?:$|p\/|ui$)/.test(url.pathname) ? "index.html" : url.pathname);
      try { const body = await readFile(file); res.writeHead(200, { "content-type": ({ ".html": "text/html", ".js": "text/javascript", ".css": "text/css" } as Record<string, string>)[extname(file)] ?? "application/octet-stream" }); res.end(body); }
      catch { res.writeHead(404); res.end(); }
    });
    await new Promise<void>(done => server.listen(0, "127.0.0.1", done)); t.after(() => server.close());
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const fixture = (query: string) => fetch(`${base}/__fixture?${query}`);
    const browser = await chromium.launch({ headless: true, ...(process.env.EVOLOOP_BROWSER_TEST_EXECUTABLE_PATH ? { executablePath: process.env.EVOLOOP_BROWSER_TEST_EXECUTABLE_PATH } : {}) });
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(`${base}/p/${projectId}/overview`);
    await page.getByLabel("访问令牌").fill("fixture-token");
    await page.getByRole("button", { name: "进入", exact: true }).click();
    await page.locator("#workspace-main:focus").waitFor();
    const main = page.locator("#workspace-main");
    const panel = page.getByRole("complementary", { name: "右栏" });
    const attention = page.locator(".overview-attention");
    const reread = async () => { await page.getByRole("button", { name: "重新读取" }).click(); await page.getByRole("button", { name: "重新读取" }).and(page.locator(":enabled")).waitFor(); };

    // 本次优先核对: the phase's next step and a named responsibility, not the server's agent-facing text.
    await attention.getByText("上次执行结果未知，先核对，不要重复派发").waitFor();
    await attention.getByText("下一责任：职责 · 开发职责").waitFor({ timeout: 5000 })
      .catch(async () => assert.fail(`Responsibility not named: ${await attention.innerText()} ${errors.join(" | ")}`));
    // 当前工作 and the queue: state codes in words.
    await main.locator(".overview-current-work").getByText(/执行正在派发/).waitFor();
    assert.match(await main.locator(".overview-current-work").innerText(), /职责当前为待交接关闭/);
    await panel.getByText("依赖尚未放行").waitFor();
    await panel.getByRole("link", { name: "智能体 · 前端智能体" }).first().waitFor();
    assert.match(await panel.innerText(), /承接职责当前为待交接关闭/);
    // A timing read failed: the page cannot say there is no scheduled work.
    await panel.getByText("1 项任务的执行时间未能读回，无法判断是否有约定执行的任务。").waitFor();
    assert.doesNotMatch(await panel.innerText(), /已读范围内没有约定执行/);
    for (const text of [await main.innerText(), await panel.innerText()]) {
      assert.doesNotMatch(text, leaked);
      assert.doesNotMatch(text, uuid, "no raw identifier in the main layer");
      assert.doesNotMatch(text, /41000\d{3}/, "no identifier prefix either");
    }
    // The original wording and identifiers stay reachable in the source layer.
    const held = panel.locator("li").filter({ hasText: "等依赖的任务" });
    await held.getByText("来源与完整标识").click();
    assert.match(await held.innerText(), /prerequisite not accepted/);
    assert.match(await held.innerText(), new RegExp(sessionId));
    assert.match(await held.innerText(), /acceptance-owner/);
    await attention.getByText("来源与完整标识").click();
    assert.match(await attention.innerText(), new RegExp(roleId));
    if (shots) await page.screenshot({ path: `${shots}/overview-wording-1440.png`, fullPage: true });

    // A complete read with no timing may say there is none; a waiting reason is summarised and folded.
    await fixture("timing=none"); await reread();
    await panel.getByText("已读范围内没有约定执行的未结束任务。").waitFor();
    await fixture("timing=waiting&responsible=session"); await reread();
    const scheduled = panel.locator("li").filter({ hasText: "进行中的改版" });
    await scheduled.getByText(/有未满足的等待条件/).waitFor();
    assert.doesNotMatch(await scheduled.innerText(), uuid);
    await scheduled.getByText("来源与完整标识").click();
    assert.match(await scheduled.innerText(), new RegExp(`上一份任务 ${previousTask} 仍为进行中`));
    await attention.getByText("下一责任：智能体 · 前端智能体").waitFor();
    assert.doesNotMatch(await attention.innerText(), /受管 Session/);

    // Below 1100px the inner rail is folded: the goal card still lists every stage and switches between them.
    await page.setViewportSize({ width: 1024, height: 900 });
    const goal = page.locator(".overview-goal");
    await goal.getByRole("button", { name: /阶段交付 4/ }).click();
    await goal.getByText("要弄清的问题 4").waitFor();
    const switcher = goal.getByLabel(/切换阶段/);
    assert.equal(await switcher.locator("option").count(), 4);
    await switcher.selectOption({ label: "阶段交付 2" });
    await goal.getByText("要弄清的问题 2").waitFor();
    assert.equal(await page.getByRole("dialog").count(), 0, "the right drawer does not open by itself");
    assert.equal(await panel.isVisible(), false);
    if (shots) {
      await page.screenshot({ path: `${shots}/overview-wording-1024.png`, fullPage: true });
      await page.getByRole("button", { name: "展开右栏" }).click();
      await page.getByRole("dialog").waitFor();
      await page.screenshot({ path: `${shots}/overview-wording-1024-panel.png` });
      await page.getByRole("button", { name: "关闭右栏" }).click();
      await page.getByRole("dialog").waitFor({ state: "detached" });
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await switcher.selectOption({ label: "阶段交付 3" });
    await goal.getByText("要弄清的问题 3").waitFor();
    assert.equal(await page.evaluate("document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1"), true, "the overview fits 390px");
    if (shots) await page.screenshot({ path: `${shots}/overview-wording-390.png`, fullPage: true });
    assert.deepEqual(errors, []);
  });
