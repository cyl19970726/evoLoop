// Opt-in built-app regression: build workbench, then set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE.
// 知识: the list sits in the inner rail under the 文档 / 知识 switch; the page reads in the center; sources,
// challenges, relations and history are in the right panel.
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
const stamp = "2026-11-09T08:00:00.000Z";
const hash = "a".repeat(64);
const summary = (n: number, title: string) => ({ knowledgeId: id(n), revision: `rev-${n}-2`, title, pageType: "concept", validity: "valid" });
const pages = [summary(1, "右栏只在要时打开"), summary(2, "窄屏不能换组件树")];
const revision = (n: number, title: string, body: string) => ({
  projectId, knowledgeId: id(n), revision: `rev-${n}-2`, previousRevision: `rev-${n}-1`, title, body: `# ${title}\n\n${body}`, contentHash: hash,
  pageType: "concept", epistemicStatus: "adopted", validity: "valid", observedValidity: "valid", createdAt: stamp,
  sources: [{ sourceKey: "document:" + id(90), originRevision: id(91), contentHash: hash, fragment: "第 2 节", state: "reachable" }],
  relations: [{ edgeId: "e1", fromKnowledgeId: id(2), fromRevision: "rev-2-2", toKnowledgeId: id(1), toRevision: "rev-1-2", type: "contradicts", sourceKeys: ["document:" + id(90)], state: "active" }],
});

test("知识 lists pages in the rail, reads in the center and keeps sources and relations in the right panel",
  { skip: !modulePath && "Set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE" }, async t => {
    const { chromium } = (await import(pathToFileURL(modulePath!).href)).default;
    const server = createServer(async (req, res) => {
      const url = new URL(req.url!, "http://127.0.0.1");
      if (url.pathname.startsWith("/api/")) {
        const root = `/api/projects/${projectId}`, k = `${root}/knowledge`;
        let value: unknown = { items: [], nextCursor: null };
        if (url.pathname === "/api/session") value = { principal: { actorId: "reader", projectIds: [projectId], permissions: ["read"] }, capabilities: {} };
        else if (url.pathname === root) value = { id: projectId, title: "知识回归项目", createdAt: stamp };
        else if (url.pathname === `${k}/capabilities`) value = { backendVersion: "fixture", backendReachable: true, fixedRevisionRead: "adapter_verified",
          conditionalPublish: "single_maintainer_adapter", boundedRelations: "adapter_verified", migration: "unsupported", semanticIndex: "unverified" };
        else if (url.pathname === `${k}/pages`) value = { items: pages, nextCursor: null, watermark: 3 };
        else if (url.pathname === `${k}/pages/${id(1)}`) value = revision(1, "右栏只在要时打开", "1100px 以下右栏是抽屉，只在用户要时打开。");
        else if (url.pathname === `${k}/pages/${id(2)}`) value = revision(2, "窄屏不能换组件树", "跨 760px 换组件树会卸载页面。");
        else if (url.pathname.endsWith("/history")) { const n = url.pathname.includes(id(1)) ? 1 : 2; value = { items: [summary(n, "历史"), { ...summary(n, "历史"), revision: `rev-${n}-1` }], nextCursor: null, watermark: 3 }; }
        else if (url.pathname.endsWith("/graph")) value = { nodes: pages, edges: [], status: "complete", watermark: 3 };
        else if (url.pathname === `${k}/candidates`) value = { items: [], nextCursor: null, watermark: 3 };
        else if (url.pathname === `${k}/sources/documents`) value = { items: [], nextCursor: null };
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
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); t.after(() => server.close());
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const browser = await chromium.launch({ headless: true,
      executablePath: process.env.EVOLOOP_BROWSER_TEST_CHROMIUM_EXECUTABLE }); t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(`${base}/p/${projectId}/knowledge`);
    await page.getByLabel("访问令牌").fill("fixture-token");
    await page.getByRole("button", { name: "进入", exact: true }).click();
    await page.getByRole("heading", { name: "知识", exact: true }).waitFor();
    const rail = page.locator("aside[aria-label=项目导航]");
    assert.equal(await rail.getByRole("navigation", { name: "文档与知识" }).getByRole("link", { name: "知识" }).getAttribute("aria-current"), "page");
    const list = rail.getByRole("navigation", { name: "知识页面" });
    await list.getByRole("button", { name: /窄屏不能换组件树/ }).click();
    await page.getByRole("heading", { name: "窄屏不能换组件树" }).waitFor();
    assert.equal(await list.getByRole("button", { name: /窄屏不能换组件树/ }).getAttribute("aria-current"), "page");
    assert.match(await page.locator("main").innerText(), /跨 760px 换组件树会卸载页面/);
    const side = page.getByRole("complementary", { name: "来源、关系与版本" });
    await side.waitFor();
    assert.match(await side.innerText(), /固定来源[\s\S]*第 2 节[\s\S]*挑战与反例[\s\S]*右栏只在要时打开[\s\S]*历史版本/);
    assert.equal(await page.locator("main").getByRole("complementary", { name: "来源、关系与版本" }).count(), 0, "sources are not in the center column");
    if (shots) await page.screenshot({ path: `${shots}/knowledge-1440.png` });
    await side.getByRole("button", { name: /右栏只在要时打开/ }).click();
    await page.getByRole("heading", { name: "右栏只在要时打开" }).waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate("document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1"), true, "no horizontal overflow at 390px");
    if (shots) await page.screenshot({ path: `${shots}/knowledge-390.png` });
    assert.deepEqual(errors, []);
  });
