// Opt-in built-app regression: build workbench, then set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE.
// 协作回执: projections and remote edits read by task name; reconcile an unknown projection, read its attempts, poll the
// remote side, apply one remote edit after confirming, and settle a lost review answer by its original IDs.
// Screenshots at 1440 / 1024 / 390 go to EVOLOOP_COLLABORATION_SCREENSHOT_DIR when it is set.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const modulePath = process.env.EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE;
const shots = process.env.EVOLOOP_COLLABORATION_SCREENSHOT_DIR;
const dist = resolve(import.meta.dirname, "../dist");
const projectId = "36000001-0000-4000-8000-000000000001";
const id = (n: number) => `36000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const stamp = "2026-11-09T08:00:00.000Z";
const task = (n: number, title: string) => ({ projectId, id: id(n), version: 3, currentRevisionId: id(n + 50), title });
const tasks = [task(1, "首页改版"), task(2, "知识空间入口"), task(3, "协作看板")];
const delivery = (n: number, taskId: string, state: string, lastReason: string | null) => ({ projectId, eventId: id(n), consumerId: "feishu", operationId: id(n + 100), effectKey: `k${n}`,
  taskId, taskVersion: 3, state, fence: 1, leaseOwner: null, leaseUntilUtc: null, nextRetryAtUtc: null, lastReason, updatedAtUtc: stamp });
const unknownReason = "socket hang up while writing row";
const deliveries = [delivery(10, id(1), "unknown", "update acknowledged but readback missing"), delivery(11, id(2), "applied", null), delivery(12, id(3), "failed", unknownReason)];
const incoming = (n: number, taskId: string, patch: Record<string, string>, verified: boolean, reviewOnly: boolean, reason: string | null) => ({ projectId, id: id(n), operationId: id(n + 100),
  state: reviewOnly ? "review-only" : "pending", sourceEventId: id(n + 200), observedAtUtc: stamp, reviewedBy: null, reviewedAtUtc: null, entityId: taskId, remoteRecordId: `rec-${n}`,
  observedLocalVersion: 3, observedRemoteOperationId: `op-${n}`, observedRemoteModifiedTime: stamp, patch, reviewOnly,
  actor: verified ? { platformUserId: "ou_1", projectActorId: "designer", sourceEventId: id(n + 200), verified: true } : null, reason });
const incomings = [incoming(20, id(1), { title: "首页改版（第二版）" }, true, false, null), incoming(21, id(2), { status: "已完成" }, false, true, "external actor not verified")];
const posts: Array<{ path: string; body: Record<string, unknown> }> = [];
let verifiedAtUtc = "2026-11-09T07:00:00.000Z";
let loseReview = false;

test("协作回执 reconciles, reads attempts, polls, applies a remote edit and settles a lost answer by its IDs",
  { skip: !modulePath && "Set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE" }, async t => {
    const { chromium } = (await import(pathToFileURL(modulePath!).href)).default;
    const server = createServer(async (req, res) => {
      const url = new URL(req.url!, "http://127.0.0.1");
      if (url.pathname.startsWith("/api/")) {
        const root = `/api/projects/${projectId}`, base = `${root}/collaboration`, path = url.pathname;
        let value: unknown = { items: [], nextCursor: null };
        if (req.method === "POST") {
          let raw = ""; for await (const chunk of req) raw += chunk;
          const body = JSON.parse(raw || "{}") as Record<string, unknown>;
          posts.push({ path: path.slice(base.length), body });
          if (path === `${base}/deliveries/${id(10)}/reconcile`) { deliveries[0]!.state = "conflict"; deliveries[0]!.lastReason = "remote content differs from projection intent"; value = deliveries[0]; }
          else if (path === `${base}/deliveries/${id(12)}/retry`) { deliveries[2]!.state = "pending"; deliveries[2]!.lastReason = null; value = { requested: true }; }
          else if (path === `${base}/poll`) { verifiedAtUtc = new Date().toISOString(); value = { observed: 1 }; }
          else if (path.startsWith(`${base}/incoming/`)) {
            const item = incomings.find(entry => path.includes(entry.id))!;
            if (loseReview) { item.state = "rejected"; res.writeHead(200, { "content-type": "application/json" }); res.end(""); return; }
            item.state = body.decision === "apply" ? "applied" : "rejected"; item.reviewedBy = "owner"; item.reviewedAtUtc = stamp;
            value = { state: item.state, operationId: item.operationId, reason: body.reason };
          }
        } else if (path === "/api/session") value = { principal: { actorId: "owner", projectIds: [projectId], permissions: ["read", "write", "review"] }, capabilities: {} };
        else if (path === root) value = { id: projectId, title: "协作回执回归项目", createdAt: stamp };
        else if (path.startsWith(`${root}/tasks/`)) value = { task: tasks.find(item => path.endsWith(item.id)) };
        else if (path === base) value = { configured: true, verifiedAtUtc, error: null, deliveries: { items: deliveries, nextCursor: null }, incoming: { items: incomings, nextCursor: null },
          incomingPending: incomings.filter(item => ["pending", "review-only", "unknown"].includes(item.state)).length };
        else if (path === `${base}/deliveries/${id(10)}/attempts`) value = [{ projectId, id: id(30), eventId: id(10), consumerId: "feishu", fence: 1, action: "reconcile", outcome: "conflict",
          reason: "remote content differs from projection intent", remoteRecordId: "rec-1", actorId: "owner", createdAtUtc: stamp }];
        else if (path.startsWith(`${base}/incoming/`)) value = incomings.find(item => path.endsWith(item.id)) ?? null;
        else if (path === `${root}/orchestration/status`) value = { state: "active", running: false, busy: false, faults: [], lastError: null };
        res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(value)); return;
      }
      try {
        const path = /^\/(?:$|p\/|ui$)/.test(url.pathname) ? "index.html" : url.pathname;
        const file = await readFile(join(dist, path));
        res.writeHead(200, { "content-type": ({ ".html": "text/html", ".js": "text/javascript", ".css": "text/css" } as Record<string, string>)[extname(path)] ?? "application/octet-stream" });
        res.end(file);
      } catch { res.writeHead(404); res.end(); }
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); t.after(() => server.close());
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const browser = await chromium.launch({ headless: true, executablePath: process.env.EVOLOOP_BROWSER_TEST_CHROMIUM_EXECUTABLE }); t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(`${base}/p/${projectId}/collaboration`);
    await page.getByLabel("访问令牌").fill("fixture-token");
    await page.getByRole("button", { name: "进入", exact: true }).click();
    await page.getByRole("heading", { name: "协作回执", exact: true }).waitFor();
    assert.equal(await page.locator("main .content").count(), 0, "the page is no longer wrapped in the generic .content block");

    const projections = page.getByRole("region", { name: "投影状态" });
    const first = projections.getByRole("listitem").filter({ hasText: "首页改版" });
    await first.getByText("结果未知", { exact: true }).waitFor();
    await first.getByText("远端接受了更新，但回读不到结果。").waitFor();
    await projections.getByRole("listitem").filter({ hasText: "知识空间入口" }).getByText("已同步", { exact: true }).waitFor();
    const panel = page.locator("aside[aria-label=右栏]");
    await panel.getByText("已核实", { exact: true }).waitFor();
    const visible = `${await page.locator("main").innerText()}\n${await panel.innerText()}`;
    for (const raw of [id(1), id(2), id(10), id(20), unknownReason]) assert.ok(!visible.includes(raw), `${raw} is shown only under 完整标识`);
    if (shots) await page.screenshot({ path: `${shots}/collaboration-1440.png`, fullPage: true });

    // 对账 an unknown projection, then read its attempts.
    await first.getByLabel("处理依据").fill("飞书表格已人工核对");
    await first.getByRole("button", { name: "按稳定键对账" }).click();
    await first.getByText("远端冲突", { exact: true }).waitFor();
    assert.deepEqual(posts[0], { path: `/deliveries/${id(10)}/reconcile`, body: { reason: "飞书表格已人工核对" } });
    await first.getByRole("button", { name: "尝试记录与完整标识" }).click();
    await first.getByRole("button", { name: "读取尝试记录" }).click();
    await first.getByText("对账 → 远端冲突").waitFor();
    await first.getByText(id(10)).waitFor();

    // 轮询.
    await page.getByRole("button", { name: "回读远端变化" }).click();
    await page.getByText("回读远端变化已提交，正在回读。").waitFor();
    assert.equal(posts[1]!.path, "/poll");

    // 采纳 a verified title-only edit after the confirmation names the change.
    const edits = page.getByRole("region", { name: "远端修改" });
    const apply = edits.getByRole("listitem").filter({ hasText: "首页改版（第二版）" });
    await apply.getByLabel("审阅理由").fill("标题更准确");
    await apply.getByRole("button", { name: "采纳为任务修订" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByText("首页改版（第二版）").waitFor();
    await dialog.getByRole("button", { name: "确认采纳" }).click();
    await apply.getByText("已采纳", { exact: true }).waitFor();
    assert.deepEqual(posts[2], { path: `/incoming/${id(20)}/review`, body: { decision: "apply", reason: "标题更准确" } });

    // An unverified status edit can only be rejected; its lost answer keeps a receipt until read back by its ID.
    const reviewOnly = edits.getByRole("listitem").filter({ hasText: "已完成" });
    assert.equal(await reviewOnly.getByRole("button", { name: "采纳为任务修订" }).count(), 0);
    await reviewOnly.getByText("修改人身份没有核实。").waitFor();
    loseReview = true;
    await reviewOnly.getByLabel("审阅理由").fill("状态要走任务流程");
    await reviewOnly.getByRole("button", { name: "拒绝回写" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "确认拒绝" }).click();
    const receipts = page.getByRole("region", { name: "待核对的写入" });
    await receipts.getByText("有 1 项写入结果尚未核实").waitFor();
    await receipts.getByText("知识空间入口").waitFor();
    // The receipt names its object; the object and the operation are identifiers, only under 完整标识.
    assert.doesNotMatch(await receipts.innerText(), /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i, "no identifier in the receipt's text");
    await receipts.getByRole("button", { name: "完整标识" }).click();
    assert.match(await receipts.innerText(), /对象 \S+[\s\S]*原操作 [0-9a-f]{8}-/);
    await receipts.getByRole("button", { name: "按原 ID 核对" }).click();
    await page.getByText("已按原 ID 读回结果。").waitFor();
    assert.equal(await receipts.count(), 0);

    // 请求重新投影: a failed projection whose reason the page does not know keeps the English original under 完整标识.
    const failed = projections.getByRole("listitem").filter({ hasText: "协作看板" });
    await failed.getByText("写入失败", { exact: true }).waitFor();
    await failed.getByText("协调器给出了一条页面不认识的原因，原文在“完整标识”里。").waitFor();
    await failed.getByRole("button", { name: "尝试记录与完整标识" }).click();
    await failed.getByText(unknownReason).waitFor();
    await failed.getByLabel("处理依据").fill("飞书接口已恢复");
    await failed.getByRole("button", { name: "请求重新投影" }).click();
    await failed.getByText("待投影", { exact: true }).waitFor();
    assert.deepEqual(posts.at(-1), { path: `/deliveries/${id(12)}/retry`, body: { reason: "飞书接口已恢复" } });
    if (shots) await page.screenshot({ path: `${shots}/collaboration-after-1440.png`, fullPage: true });

    await page.setViewportSize({ width: 1024, height: 800 });
    await page.waitForTimeout(300);
    assert.equal(await page.getByRole("dialog").count(), 0, "the right column stays closed below 1100px");
    if (shots) await page.screenshot({ path: `${shots}/collaboration-1024.png`, fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(300);
    assert.equal(await page.evaluate("document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1"), true, "no horizontal overflow at 390px");
    if (shots) await page.screenshot({ path: `${shots}/collaboration-390.png`, fullPage: true });
    assert.deepEqual(errors, []);
  });

test("协作回执 says it cannot judge when the collaboration state cannot be read",
  { skip: !modulePath && "Set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE" }, async t => {
    const { chromium } = (await import(pathToFileURL(modulePath!).href)).default;
    const server = createServer(async (req, res) => {
      const url = new URL(req.url!, "http://127.0.0.1");
      const root = `/api/projects/${projectId}`;
      if (url.pathname.startsWith("/api/")) {
        if (url.pathname === `${root}/collaboration`) { res.writeHead(503, { "content-type": "application/json" }); res.end(JSON.stringify({ message: "协作服务暂时不可用" })); return; }
        const value = url.pathname === "/api/session" ? { principal: { actorId: "owner", projectIds: [projectId], permissions: ["read", "write", "review"] }, capabilities: {} }
          : url.pathname === root ? { id: projectId, title: "协作回执回归项目", createdAt: stamp } : { items: [], nextCursor: null };
        res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(value)); return;
      }
      try {
        const path = /^\/(?:$|p\/|ui$)/.test(url.pathname) ? "index.html" : url.pathname;
        const file = await readFile(join(dist, path));
        res.writeHead(200, { "content-type": ({ ".html": "text/html", ".js": "text/javascript", ".css": "text/css" } as Record<string, string>)[extname(path)] ?? "application/octet-stream" });
        res.end(file);
      } catch { res.writeHead(404); res.end(); }
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); t.after(() => server.close());
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const browser = await chromium.launch({ headless: true, executablePath: process.env.EVOLOOP_BROWSER_TEST_CHROMIUM_EXECUTABLE }); t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(`${base}/p/${projectId}/collaboration`);
    await page.getByLabel("访问令牌").fill("fixture-token");
    await page.getByRole("button", { name: "进入", exact: true }).click();
    await page.getByRole("heading", { name: "协作回执", exact: true }).waitFor();
    await page.getByText("协作状态没有读回").waitFor({ timeout: 15000 });
    await page.getByText("现在无法判断投影和远端修改的情况。请重新读取。").waitFor();
    await page.locator("aside[aria-label=右栏]").getByText("连接状态没有读回，无法判断。").waitFor();
    const text = await page.locator("main").innerText();
    for (const conclusion of ["还没有任务投影记录", "还没有远端修改", "未配置", "已同步"]) assert.ok(!text.includes(conclusion), `a failed read never says ${conclusion}`);
    assert.equal(await page.getByRole("button", { name: "回读远端变化" }).count(), 0, "no write offered on an unread state");
    if (shots) await page.screenshot({ path: `${shots}/collaboration-read-failed-1440.png`, fullPage: true });
    assert.deepEqual(errors, []);
  });
