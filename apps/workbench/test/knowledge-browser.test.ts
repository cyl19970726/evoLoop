// Opt-in built-app regression: build workbench, then set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE.
// 知识空间 (docs/frontend/pages/knowledge.md): the directory sits in the inner rail under the 文档 / 知识 switch, the page
// reads in the center, sources, challenges, related pages and versions are in the right column. Covers reading, the topic
// directory and filters, load more, switching pages without the right column collapsing or focus being dropped,
// proposing a candidate, rejecting and accepting, publish with an unknown result then reconcile, retracting a source,
// the 来源与反例 entry at 1280 and 390, and the degraded state. Screenshots: EVOLOOP_KNOWLEDGE_SCREENSHOT_DIR.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const modulePath = process.env.EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE;
const shots = process.env.EVOLOOP_KNOWLEDGE_SCREENSHOT_DIR;
const dist = resolve(import.meta.dirname, "../dist");
const projectId = "35000001-0000-4000-8000-000000000001";
const id = (n: number) => `35000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const rid = (n: number, v: number) => `35000000-0000-4000-8${v}00-${String(n).padStart(12, "0")}`;
const stamp = "2026-11-09T08:00:00.000Z";
const hash = "a".repeat(64);
type Summary = { knowledgeId: string; revision: string; title: string; pageType: string; validity: string };

function fixture() {
  const titles: Record<number, [string, string]> = {
    3: ["布局专题", "topic"], 1: ["右栏只在要时打开", "concept"], 2: ["窄屏不能换组件树", "concept"], 4: ["列表要写明覆盖范围", "decision"],
  };
  const summary = (n: number, v = 2): Summary => ({ knowledgeId: id(n), revision: rid(n, v), title: titles[n]![0], pageType: titles[n]![1], validity: "valid" });
  const source = { documentId: id(90), title: "布局走查记录", revisionId: id(91), sourceKey: `document:${id(90)}`, state: "reachable" as string };
  const relation = (edgeId: string, from: number, to: number, type: string) => ({ edgeId, fromKnowledgeId: id(from), fromRevision: rid(from, 2),
    toKnowledgeId: id(to), toRevision: rid(to, 2), type, sourceKeys: [source.sourceKey], state: "active" });
  const challenge = relation("e-challenge", 2, 1, "contradicts"), member = relation("e-member", 1, 3, "member_of");
  const state = {
    degraded: false, published: [] as Summary[], observed: "valid", publishAttempts: 0, retracted: false,
    candidates: [{ projectId, knowledgeId: id(70), candidateId: id(80), candidateRevision: id(81), expectedRevision: null, contentHash: hash,
      title: "窄屏右栏是底部速览", body: "# 窄屏右栏是底部速览\n\n760px 以下右栏从底部升起。", pageType: "concept", epistemicStatus: "observation",
      sources: [{ sourceKey: source.sourceKey, originRevision: id(91), contentHash: hash, fragment: null, state: "reachable" }], relations: [],
      operationId: id(82), actorId: "reviewer", status: "pending", decision: null }] as Array<Record<string, unknown>>,
    writes: [] as string[],
  };
  const revision = (n: number, v: number) => ({
    projectId, knowledgeId: id(n), revision: rid(n, v), previousRevision: v > 1 ? rid(n, v - 1) : null, title: titles[n]![0],
    body: v === 1 ? `# ${titles[n]![0]}\n\n旧版正文：这是第一版。` : `# ${titles[n]![0]}\n\n${({ 1: "1100px 以下右栏是抽屉，只在用户要时打开。", 2: "跨 760px 换组件树会卸载页面。", 3: "布局相关的认识都收在这个专题下。", 4: "列表写明已载入多少。" } as Record<number, string>)[n]}`,
    contentHash: hash, pageType: titles[n]![1], epistemicStatus: "adopted", validity: "valid", observedValidity: n === 1 ? state.observed : "valid", createdAt: stamp,
    sources: n === 3 ? [] : [{ sourceKey: source.sourceKey, originRevision: id(91), contentHash: hash, fragment: "第 2 节", state: state.retracted ? "withdrawn" : "reachable" }],
    relations: n === 2 ? [challenge] : n === 1 ? [member] : [],
  });
  const graph = (n: number) => ({ status: "complete", watermark: 3,
    nodes: (n === 3 ? [3, 1] : n === 1 ? [1, 2, 3] : n === 2 ? [2, 1] : [n]).map(item => summary(item)),
    edges: n === 3 ? [member] : n === 1 ? [challenge, member] : n === 2 ? [challenge] : [] });
  return { state, source, summary, revision, graph };
}

test("知识空间 reads, filters, switches pages without collapsing the right column, and runs the candidate flow",
  { skip: !modulePath && "Set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE" }, async t => {
    const { chromium } = (await import(pathToFileURL(modulePath!).href)).default;
    const { state, source, summary, revision, graph } = fixture();
    const server = createServer(async (req, res) => {
      const url = new URL(req.url!, "http://127.0.0.1");
      if (url.pathname.startsWith("/api/")) {
        const root = `/api/projects/${projectId}`, k = `${root}/knowledge`;
        let body = "";
        for await (const chunk of req) body += chunk;
        const input = body ? JSON.parse(body) as Record<string, unknown> : {};
        let value: unknown = { items: [], nextCursor: null };
        const pageMatch = /^\/pages\/([^/]+)(\/history|\/graph)?$/.exec(url.pathname.slice(k.length));
        const n = pageMatch ? Number(pageMatch[1]!.slice(-12)) : 0;
        const candidateMatch = /^\/candidates\/([^/]+)(\/review|\/publish)?$/.exec(url.pathname.slice(k.length));
        if (url.pathname === "/api/session") value = { principal: { actorId: "reviewer", projectIds: [projectId], permissions: ["read", "write", "review"] }, capabilities: {} };
        else if (url.pathname === root) value = { id: projectId, title: "知识回归项目", createdAt: stamp };
        else if (url.pathname === `${k}/capabilities`) value = { backendVersion: "fixture", backendReachable: !state.degraded, fixedRevisionRead: state.degraded ? "unavailable" : "adapter_verified",
          conditionalPublish: "single_maintainer_adapter", boundedRelations: "adapter_verified", migration: "unsupported", semanticIndex: "unverified" };
        else if (url.pathname === `${k}/pages`) value = url.searchParams.get("cursor") === "page-2"
          ? { items: [summary(4), ...state.published], nextCursor: null, watermark: 3 } : { items: [summary(3), summary(1), summary(2)], nextCursor: "page-2", watermark: 3 };
        else if (pageMatch && pageMatch[2] === "/history") value = { items: [summary(n, 2), { ...summary(n, 1), validity: "valid" }], nextCursor: null, watermark: 3 };
        else if (pageMatch && pageMatch[2] === "/graph") value = graph(n);
        else if (pageMatch) {
          if (n === 1) await new Promise(done => setTimeout(done, 700));
          const wanted = url.searchParams.get("revision");
          value = revision(n, wanted === rid(n, 1) ? 1 : 2);
        }
        else if (url.pathname === `${k}/candidates` && req.method === "GET") value = { items: state.candidates.map(({ body: _body, sources: _s, relations: _r, ...rest }) => rest), nextCursor: null, watermark: 3 };
        else if (url.pathname === `${k}/candidates` && req.method === "POST") {
          state.writes.push(`propose:${input.title}`);
          const record = { ...input, projectId, contentHash: hash, actorId: "reviewer", status: "pending", decision: null,
            sources: [{ sourceKey: source.sourceKey, originRevision: id(91), contentHash: hash, fragment: null, state: "reachable" }] };
          state.candidates.unshift(record); value = record;
        } else if (candidateMatch) {
          const record = state.candidates.find(item => item.candidateId === candidateMatch[1]);
          if (!record) { res.writeHead(404, { "content-type": "application/json" }); res.end(JSON.stringify({ message: "没有这条候选" })); return; }
          if (candidateMatch[2] === "/review") {
            state.writes.push(`review:${input.decision}:${input.reason}`);
            record.status = input.decision === "accept" ? "accepted" : "rejected";
            record.decision = { candidateId: record.candidateId, candidateRevision: record.candidateRevision, contentHash: hash, expectedRevision: null, decision: input.decision, reviewerId: "reviewer", reason: input.reason };
            value = { status: "recorded", decision: record.decision };
          } else if (candidateMatch[2] === "/publish") {
            state.writes.push(`publish:${input.operationId}`); state.publishAttempts++;
            value = { status: "unknown", operationId: input.operationId, reason: "adapter timeout after manifest write" };
          } else value = record;
        } else if (url.pathname.startsWith(`${k}/operations/`) && url.pathname.endsWith("/reconcile")) {
          const operationId = url.pathname.split("/").at(-2)!;
          state.writes.push(`reconcile:${operationId}`);
          const record = state.candidates.find(item => item.status === "accepted")!;
          record.status = "published";
          state.published.push({ knowledgeId: String(record.knowledgeId), revision: rid(5, 2), title: String(record.title), pageType: "concept", validity: "valid" });
          value = { result: { status: "published", operationId, revision: rid(5, 2) } };
        } else if (url.pathname === `${k}/sources/documents`) value = { items: [{ ...source, state: state.retracted ? "withdrawn" : "reachable" }], nextCursor: null };
        else if (url.pathname === `${k}/sources/${id(90)}/retract`) {
          state.writes.push(`retract:${input.operationId}`); state.retracted = true; state.observed = "needs_review";
          value = { status: "recorded", operationId: input.operationId, affected: [id(1)] };
        }
        res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(value)); return;
      }
      try {
        const path = /^\/(?:$|p\/|ui$)/.test(url.pathname) ? "index.html" : url.pathname;
        const body = await readFile(join(dist, path));
        res.writeHead(200, { "content-type":
          ({ ".html": "text/html", ".js": "text/javascript", ".css": "text/css" } as Record<string, string>)[extname(path)] ??
          "application/octet-stream" });
        res.end(body);
      } catch { res.writeHead(404); res.end(); }
    });
    await new Promise<void>(done => server.listen(0, "127.0.0.1", done)); t.after(() => server.close());
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const browser = await chromium.launch({ headless: true, executablePath: process.env.EVOLOOP_BROWSER_TEST_CHROMIUM_EXECUTABLE }); t.after(() => browser.close());
    const errors: string[] = [];
    const open = async (width: number, height: number, path = "") => {
      const page = await browser.newPage({ viewport: { width, height } });
      page.on("pageerror", (error: Error) => errors.push(error.message));
      await page.goto(`${base}/p/${projectId}/knowledge${path}`);
      await page.getByLabel("访问令牌").fill("fixture-token");
      await page.getByRole("button", { name: "进入", exact: true }).click();
      return page;
    };
    const noOverflow = (page: { evaluate(script: string): Promise<unknown> }) =>
      page.evaluate("document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1");

    // ---- 1440: the space's index, the directory in the rail, filters and load more.
    const page = await open(1440, 900);
    await page.getByRole("heading", { name: "知识空间", level: 1 }).waitFor();
    const rail = page.locator("aside[aria-label=项目导航]");
    assert.equal(await rail.getByRole("navigation", { name: "文档与知识" }).getByRole("link", { name: "知识" }).getAttribute("aria-current"), "page");
    const directory = rail.getByRole("region", { name: "知识目录" });
    await directory.getByRole("navigation", { name: "专题目录" }).getByRole("link", { name: /布局专题/ }).waitFor();
    assert.match(await directory.innerText(), /已载入 3 项 · 后续页面未读/);
    await directory.getByRole("button", { name: "载入更多" }).click();
    await directory.getByRole("link", { name: /列表要写明覆盖范围/ }).waitFor();
    assert.match(await directory.innerText(), /已载入 4 项 · 已读完/);
    await directory.getByRole("searchbox", { name: "搜索知识" }).fill("右栏");
    await page.waitForFunction(() => /匹配 1 项/.test(document.querySelector("[aria-label=知识目录]")?.textContent ?? ""));
    assert.equal(await directory.getByRole("link", { name: /窄屏不能换组件树/ }).count(), 0);
    await directory.getByRole("searchbox", { name: "搜索知识" }).fill("");
    await directory.getByLabel("有效状态筛选").selectOption("needs_review");
    assert.match(await directory.innerText(), /已载入范围没有匹配的知识页/);
    await directory.getByLabel("有效状态筛选").selectOption("all");
    if (shots) await page.screenshot({ path: `${shots}/knowledge-index-1440.png` });

    // ---- Reading: the body in the center, sources and challenges in the right column, raw IDs only in 完整标识.
    await directory.getByRole("link", { name: /窄屏不能换组件树/ }).click();
    const main = page.locator("main");
    await main.getByRole("heading", { name: "窄屏不能换组件树", level: 1 }).waitFor();
    assert.equal(await directory.getByRole("link", { name: /窄屏不能换组件树/ }).getAttribute("aria-current"), "page");
    assert.match(await main.innerText(), /跨 760px 换组件树会卸载页面/);
    const side = page.getByRole("region", { name: "来源、反例与版本" });
    await side.waitFor();
    assert.match(await side.innerText(), /来源[\s\S]*《布局走查记录》[\s\S]*第 2 节[\s\S]*挑战与反例 · 1[\s\S]*右栏只在要时打开[\s\S]*版本[\s\S]*历史版本/);
    assert.equal(await main.getByRole("region", { name: "来源、反例与版本" }).count(), 0, "sources are not in the center column");
    const visibleText = `${await main.innerText()}\n${await side.innerText()}`;
    assert.doesNotMatch(visibleText, new RegExp(`${id(2)}|${rid(2, 2)}|知识 ID|水位|adapter_verified|后端报告版本`), "raw IDs and internal words stay out of the reading layers");
    await side.getByText("完整标识").click();
    assert.match(await side.innerText(), new RegExp(id(2)));
    if (shots) await page.screenshot({ path: `${shots}/knowledge-1440.png` });

    // History in the right column: the link keeps focus, and the old body is marked as a fixed historical version.
    const older = side.getByRole("link", { name: /往前第 1 版/ });
    await older.focus(); await page.keyboard.press("Enter");
    await main.getByText("旧版正文：这是第一版。").waitFor();
    assert.match(await main.innerText(), /固定历史版/);
    assert.match(await page.evaluate(() => document.activeElement?.textContent ?? "BODY"), /往前第 1 版/, "focus stays on the history link");
    await main.getByRole("link", { name: "阅读当前版" }).first().click();
    await main.getByText("跨 760px 换组件树会卸载页面。").waitFor();

    // A relation in the right column: the column stays (marked 正在读取) while the next page loads, and focus is not dropped.
    const panelWidth = async () => page.evaluate(() => (document.querySelector("aside[aria-label=右栏]") as HTMLElement | null)?.offsetWidth ?? 0);
    const widthBefore = await panelWidth();
    await side.getByRole("link", { name: "右栏只在要时打开" }).focus(); await page.keyboard.press("Enter");
    await side.getByText("正在读取所选页面；下面仍是上一页").waitFor();
    assert.equal(await panelWidth(), widthBefore, "the right column keeps its width while the next page loads");
    await main.getByRole("heading", { name: "右栏只在要时打开", level: 1 }).waitFor();
    assert.equal(await panelWidth(), widthBefore);
    assert.notEqual(await page.evaluate(() => document.activeElement?.tagName), "BODY", "focus is not dropped on the page body");

    // The open topic lists its members under it in the rail.
    await directory.getByRole("link", { name: /布局专题/ }).click();
    await main.getByRole("heading", { name: "布局专题", level: 1 }).waitFor();
    await directory.getByRole("list", { name: "布局专题的成员" }).getByRole("link", { name: /右栏只在要时打开/ }).waitFor();
    assert.match(await main.innerText(), /这一版没有登记来源，正文待复核/);

    // ---- Propose a candidate, reject the existing one, accept ours, publish (result unknown), reconcile.
    await page.locator("aside[aria-label=项目导航]").getByRole("navigation", { name: "文档与知识" }).getByRole("link", { name: "知识" }).click();
    await main.getByRole("button", { name: "提出候选" }).click();
    await main.getByRole("heading", { name: "提出知识候选" }).waitFor();
    await main.getByLabel("标题").fill("右栏入口要有名字");
    await main.getByLabel("完整 Markdown 正文").fill("# 右栏入口要有名字\n\n1100–1439 宽度下右栏默认收起，中间要有“来源与反例”。");
    await main.getByLabel("已采纳的固定来源").selectOption(id(90));
    await main.getByRole("button", { name: "保存候选" }).click();
    await main.getByRole("heading", { name: "候选与审阅", level: 1 }).waitFor();
    await main.getByRole("heading", { name: "右栏入口要有名字" }).waitFor();
    assert.match(await main.innerText(), /候选已保存/);

    await main.getByRole("link", { name: "全部候选" }).click();
    await main.getByRole("link", { name: /窄屏右栏是底部速览/ }).click();
    await main.getByRole("heading", { name: "窄屏右栏是底部速览" }).waitFor();
    await main.getByLabel("审阅意见").fill("底部速览已由布局说明覆盖");
    await main.getByRole("button", { name: "不采纳" }).click();
    await main.getByText("已记录不采纳").waitFor();
    await main.getByText("这条候选没有被采纳，不会发布。").waitFor();

    await main.getByRole("link", { name: "全部候选" }).click();
    await main.getByRole("link", { name: /右栏入口要有名字/ }).click();
    await main.getByLabel("审阅意见").fill("来源与反例入口已核对");
    await main.getByRole("button", { name: "接受候选" }).click();
    await main.getByRole("button", { name: "发布为固定版本" }).click();
    const dialog = page.getByRole("dialog");
    assert.match(await dialog.innerText(), /新建一个知识页/);
    await dialog.getByRole("button", { name: "确认发布" }).click();
    await main.getByText("发布结果待核对").waitFor();
    assert.equal(await main.getByRole("button", { name: "发布为固定版本" }).isDisabled(), true, "no second publish while a result is unknown");
    await main.getByRole("button", { name: "核对结果" }).click();
    await main.getByText("已核到发布记录").waitFor();
    await main.getByRole("link", { name: "阅读已发布的知识页 →" }).waitFor();
    assert.equal(state.publishAttempts, 1);
    assert.equal(await main.getByText("发布结果待核对").count(), 0);

    // ---- Retract a source: confirmed in a dialog, then the affected page is marked for review.
    await main.getByText("撤回固定来源").click();
    await main.getByRole("button", { name: "撤回", exact: true }).click();
    assert.match(await page.getByRole("dialog").innerText(), /布局走查记录[\s\S]*待复核/);
    await page.getByRole("dialog").getByRole("button", { name: "确认撤回" }).click();
    await main.getByText("1 个知识页标为待复核。").waitFor();
    assert.deepEqual(state.writes.map(item => item.split(":")[0]), ["propose", "review", "review", "publish", "reconcile", "retract"]);
    assert.ok(state.writes.includes("review:reject:底部速览已由布局说明覆盖") && state.writes.includes("review:accept:来源与反例入口已核对"));

    // ---- Degraded: the service is unreachable; the index says so and what can still be done.
    state.degraded = true;
    await page.locator("aside[aria-label=项目导航]").getByRole("navigation", { name: "文档与知识" }).getByRole("link", { name: "知识" }).click();
    await main.getByRole("button", { name: "重新读取" }).click();
    await main.getByText("知识服务暂不可达").waitFor();
    await main.getByRole("heading", { name: "此时仍可做什么" }).waitFor();
    if (shots) await page.screenshot({ path: `${shots}/knowledge-degraded-1440.png` });
    state.degraded = false;
    await page.close();

    // ---- 1280: the right column starts collapsed; the named entry in the center opens it.
    const laptop = await open(1280, 800, `?knowledgeId=${id(2)}`);
    await laptop.locator("main").getByRole("heading", { name: "窄屏不能换组件树", level: 1 }).waitFor();
    assert.equal(await laptop.getByRole("region", { name: "来源、反例与版本" }).isVisible(), false, "collapsed by default between 1100 and 1439");
    const entry = laptop.locator("main").getByRole("button", { name: /来源与反例/ });
    assert.equal(await entry.getAttribute("aria-expanded"), "false");
    await entry.click();
    await laptop.getByRole("region", { name: "来源、反例与版本" }).getByText("挑战与反例 · 1").waitFor();
    if (shots) await laptop.screenshot({ path: `${shots}/knowledge-1280.png` });
    await laptop.close();

    // ---- 1024: the right column is a drawer and never opens by itself.
    const tablet = await open(1024, 768, `?knowledgeId=${id(2)}`);
    await tablet.locator("main").getByRole("heading", { name: "窄屏不能换组件树", level: 1 }).waitFor();
    assert.equal(await tablet.getByRole("dialog").count(), 0, "the drawer does not open on its own");
    if (shots) await tablet.screenshot({ path: `${shots}/knowledge-1024.png` });
    await tablet.close();

    // ---- 390: no horizontal overflow; the 文档 / 知识 switch is in the center; the entry opens the sheet.
    const phone = await open(390, 844);
    await phone.getByRole("heading", { name: "知识空间", level: 1 }).waitFor();
    await phone.locator("main").getByRole("navigation", { name: "文档与知识" }).waitFor();
    assert.equal(await noOverflow(phone), true, "no horizontal overflow at 390px (index)");
    await phone.locator("main").getByRole("link", { name: /窄屏不能换组件树/ }).click();
    await phone.locator("main").getByRole("heading", { name: "窄屏不能换组件树", level: 1 }).waitFor();
    assert.equal(await noOverflow(phone), true, "no horizontal overflow at 390px (reader)");
    if (shots) await phone.screenshot({ path: `${shots}/knowledge-390.png` });
    await phone.locator("main").getByRole("button", { name: /来源与反例/ }).click();
    await phone.getByRole("dialog").getByRole("region", { name: "来源、反例与版本" }).getByText("《布局走查记录》").waitFor();
    if (shots) await phone.screenshot({ path: `${shots}/knowledge-390-sheet.png` });
    await phone.close();
    assert.deepEqual(errors, []);
  });
