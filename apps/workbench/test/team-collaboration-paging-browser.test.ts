// Opt-in built-app regression: build workbench, then set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE.
// 协作回执's later rows: 加载更多 reads only the next page (never the earlier ones again); the later rows are reread
// with the project, and a reread that fails keeps them as 上次读回 with their writes held until they are read again;
// a cursor that comes back says the list may be incomplete; the original answers stay in 诊断信息, and 连接诊断 shows
// the connection's own original text. All data is synthetic.
// Screenshots: EVOLOOP_COLLABORATION_SCREENSHOT_DIR.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const modulePath = process.env.EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE;
const shots = process.env.EVOLOOP_COLLABORATION_SCREENSHOT_DIR;
const dist = resolve(import.meta.dirname, "../dist");
const projectId = "36100001-0000-4000-8000-000000000001";
const id = (n: number) => `36100000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const stamp = "2026-11-09T08:00:00.000Z";
const titles: Record<string, string> = { [id(1)]: "首页改版", [id(2)]: "知识空间入口", [id(3)]: "协作看板" };
const delivery = (n: number, taskId: string, state: string) => ({ projectId, eventId: id(n), consumerId: "feishu", operationId: id(n + 100), effectKey: `k${n}`,
  taskId, taskVersion: 3, state, fence: 1, leaseOwner: null, leaseUntilUtc: null, nextRetryAtUtc: null, lastReason: null, updatedAtUtc: stamp });
const incoming = (n: number, taskId: string) => ({ projectId, id: id(n), operationId: id(n + 100), state: "pending", sourceEventId: id(n + 200), observedAtUtc: stamp,
  reviewedBy: null, reviewedAtUtc: null, entityId: taskId, remoteRecordId: `rec-${n}`, observedLocalVersion: 3, observedRemoteOperationId: `op-${n}`,
  observedRemoteModifiedTime: stamp, patch: { title: `${titles[taskId]}（远端改名）` }, reviewOnly: false,
  actor: { platformUserId: "ou_1", projectActorId: "designer", sourceEventId: id(n + 200), verified: true }, reason: null });
const connectionError = "feishu app_access_token expired (code 99991663)";

test("协作回执 reads later rows one page at a time and holds their writes when their reread fails", {
  skip: !modulePath && "Set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE",
}, async t => {
  const { chromium } = (await import(pathToFileURL(modulePath!).href)).default;
  const reads: string[] = [];
  let failLater = false;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, "http://127.0.0.1");
    const send = (value: unknown, status = 200) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
    if (url.pathname.startsWith("/api/")) {
      const root = `/api/projects/${projectId}`, base = `${root}/collaboration`, path = url.pathname;
      if (path === "/api/session") return send({ principal: { actorId: "owner", projectIds: [projectId], permissions: ["read", "write", "review"] }, capabilities: {} });
      if (path === root) return send({ id: projectId, title: "协作分页项目", createdAt: stamp });
      if (path.startsWith(`${root}/tasks/`)) {
        const taskId = path.slice(`${root}/tasks/`.length);
        return send({ task: { projectId, id: taskId, version: 3, currentRevisionId: id(90), title: titles[taskId] ?? "其他任务" } });
      }
      if (path === base) return send({ configured: true, verifiedAtUtc: stamp, error: connectionError,
        deliveries: { items: [delivery(10, id(1), "applied")], nextCursor: "d2" }, incoming: { items: [incoming(20, id(1))], nextCursor: "i2" }, incomingPending: 2 });
      const cursor = url.searchParams.get("cursor");
      if (path === `${base}/deliveries` || path === `${base}/incoming`) {
        reads.push(`${path.endsWith("incoming") ? "incoming" : "deliveries"}:${cursor}`);
        if (failLater) return send({ message: "collaboration store unavailable", code: "STORE_UNAVAILABLE" }, 503);
        if (cursor === "d2") return send({ items: [delivery(11, id(2), "failed")], nextCursor: "d3" });
        if (cursor === "d3") return send({ items: [delivery(12, id(3), "applied")], nextCursor: null });
        // The remote side hands back the same cursor: a page that does not move.
        if (cursor === "i2") return send({ items: [incoming(21, id(2))], nextCursor: "i2" });
      }
      return send({ items: [], nextCursor: null });
    }
    const file = join(dist, /^\/(?:$|p\/|ui$)/.test(url.pathname) ? "index.html" : url.pathname);
    try { const body = await readFile(file); res.writeHead(200, { "content-type": ({ ".html": "text/html", ".js": "text/javascript", ".css": "text/css" } as Record<string, string>)[extname(file)] ?? "application/octet-stream" }); res.end(body); }
    catch { res.writeHead(404); res.end(); }
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const browser = await chromium.launch({ headless: true, ...(process.env.EVOLOOP_BROWSER_TEST_EXECUTABLE_PATH
    ? { executablePath: process.env.EVOLOOP_BROWSER_TEST_EXECUTABLE_PATH } : {}) });
  t.after(async () => { await browser.close(); await new Promise<void>(done => server.close(() => done())); });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const errors: string[] = [];
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on("pageerror", (error: Error) => errors.push(error.message));
  await page.goto(`${base}/p/${projectId}/collaboration`);
  await page.getByLabel("访问令牌").fill("fixture-token");
  await page.getByRole("button", { name: "进入", exact: true }).click();
  const main = page.locator("main");
  const projections = main.getByRole("region", { name: "投影状态" });
  const remote = main.getByRole("region", { name: "远端修改" });
  await projections.getByText("首页改版").waitFor();
  assert.deepEqual(reads, [], "later rows are read only on request");

  // 加载更多 reads the next page only.
  await projections.getByRole("button", { name: "加载更多投影" }).click();
  await projections.getByText("知识空间入口").waitFor();
  await projections.getByRole("button", { name: "加载更多投影" }).click();
  await projections.getByText("协作看板").waitFor();
  assert.deepEqual(reads, ["deliveries:d2", "deliveries:d3"], "each click reads one more page, never the earlier ones");
  assert.equal(await projections.getByRole("button", { name: "加载更多投影" }).count(), 0, "no more after the last page");
  await remote.getByRole("button", { name: "加载更多远端修改" }).click();
  const later = remote.locator("li").filter({ hasText: "知识空间入口（远端改名）" });
  await later.waitFor();
  // The remote side's next cursor points back at the page just read: the list says it may be incomplete, not that it ended.
  await remote.getByRole("button", { name: "加载更多远端修改" }).click();
  await remote.getByRole("heading", { name: /后续页没有前进，列表可能不完整/ }).waitFor();
  assert.equal(await remote.getByRole("button", { name: "加载更多远端修改" }).count(), 0, "the reading stops at a cursor already read");
  assert.equal(await later.count(), 1, "the row read twice is listed once");
  await later.getByLabel("审阅理由").fill("标题更清楚");
  assert.equal(await later.getByRole("button", { name: "采纳为任务修订" }).isEnabled(), true);

  // 连接诊断: the connection's own original text.
  const rail = page.getByRole("complementary", { name: "右栏" });
  await rail.getByText("连接诊断").click();
  await rail.getByText(connectionError).waitFor();

  // The later rows are reread with the project; when that fails they stay, marked, and offer no write.
  failLater = true;
  reads.length = 0;
  await main.getByRole("button", { name: "重新读取" }).first().click();
  await remote.getByText("上次读回，当前待核对").first().waitFor({ timeout: 15000 });
  await projections.getByText("上次读回，当前待核对").first().waitFor();
  assert.ok(reads.includes("incoming:i2") && reads.includes("deliveries:d2"), "the reread starts again from the overview's cursor");
  assert.equal(await later.count(), 1, "the later row is kept");
  await later.locator("[data-row-stale]").waitFor();
  assert.equal(await later.getByRole("button", { name: "采纳为任务修订" }).isDisabled(), true, "a row whose reread failed offers no write");
  assert.equal(await later.getByRole("button", { name: "拒绝回写" }).isDisabled(), true);
  const failedRow = projections.locator("li").filter({ hasText: "知识空间入口" });
  assert.equal(await failedRow.getByRole("button", { name: "请求重新投影" }).isDisabled(), true);
  const first = remote.locator("li").filter({ hasText: "首页改版（远端改名）" });
  await first.getByLabel("审阅理由").fill("首页标题");
  assert.equal(await first.getByRole("button", { name: "采纳为任务修订" }).isEnabled(), true, "the first page was read again and stays writable");
  // The service's English is only in 诊断信息.
  const notice = remote.getByRole("status").filter({ hasText: "上次读回，当前待核对" });
  assert.doesNotMatch(await notice.innerText(), /collaboration store unavailable/);
  await notice.getByText("诊断信息").click();
  await notice.getByText(/collaboration store unavailable（STORE_UNAVAILABLE）/).waitFor();
  if (shots) await page.screenshot({ path: `${shots}/collaboration-later-stale-1440.png`, fullPage: true });

  // Read again: the rows are current and writable again.
  failLater = false;
  await main.getByRole("button", { name: "重新读取" }).first().click();
  await later.getByRole("button", { name: "采纳为任务修订" }).and(page.locator(":enabled")).waitFor({ timeout: 15000 });
  assert.equal(await later.locator("[data-row-stale]").count(), 0);
  assert.deepEqual(errors, []);
});
