// Opt-in built-app regression: build workbench, then set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE.
// The fixture puts every matching Report after unrelated Spec documents and archived Reports. Kind and lifecycle
// must therefore reach the server; filtering only the loaded page would hide most of the 60+ active Reports.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const modulePath = process.env.EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE;
const dist = resolve(import.meta.dirname, "../dist");
const id = (n: number) => `47000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const projectId = id(1);
const stamp = "2026-11-10T08:00:00.000Z";
const documents = [
  ...Array.from({ length: 30 }, (_, index) => ({
    projectId, id: id(1001 + index), version: 1, title: `规范 ${String(index + 1).padStart(3, "0")}`, kind: "spec",
    status: "draft", currentRevisionId: id(5001 + index), adoptedRevisionId: null, primaryTaskId: null, origin: null,
  })),
  ...Array.from({ length: 20 }, (_, index) => ({
    projectId, id: id(1031 + index), version: 1, title: `已归档报告 ${String(index + 1).padStart(3, "0")}`, kind: "report",
    status: "archived", currentRevisionId: id(5031 + index), adoptedRevisionId: null, primaryTaskId: null, origin: null,
  })),
  ...Array.from({ length: 60 }, (_, index) => ({
    projectId, id: id(1051 + index), version: 1, title: `报告 ${String(index + 1).padStart(3, "0")}`, kind: "report",
    status: "draft", currentRevisionId: id(5051 + index), adoptedRevisionId: null, primaryTaskId: null, origin: null,
  })),
];

test("Report + active filtering happens before pagination", {
  skip: !modulePath && "Set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE",
}, async t => {
  const { chromium } = (await import(pathToFileURL(modulePath!).href)).default;
  const requests: string[] = [];
  const missingResources: string[] = [];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, "http://127.0.0.1");
    const root = `/api/projects/${projectId}`;
    const send = (value: unknown, status = 200) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
    if (url.pathname === "/favicon.ico" || url.pathname === "/apple-touch-icon.png" || url.pathname === "/apple-touch-icon-precomposed.png") {
      res.writeHead(302, { location: "/favicon.svg" }); res.end(); return;
    }
    if (url.pathname.startsWith("/api/")) {
      if (url.pathname === "/api/session") return send({ principal: { actorId: "fixture", projectIds: [projectId], permissions: ["read", "write", "review"] }, capabilities: {} });
      if (url.pathname === root) return send({ id: projectId, title: "文档筛选项目", createdAt: stamp });
      if (url.pathname === `${root}/documents`) {
        requests.push(`${url.pathname}?${url.searchParams}`);
        const kind = url.searchParams.get("kind");
        const status = url.searchParams.get("status");
        const matching = documents.filter(item => (!kind || item.kind === kind) &&
          (!status || (status === "active" ? item.status !== "archived" : item.status === status)));
        const start = Number(url.searchParams.get("cursor") ?? 0);
        const items = matching.slice(start, start + 50);
        const nextCursor = start + items.length < matching.length ? String(start + items.length) : null;
        return send({ items, nextCursor });
      }
      if (url.pathname === `${root}/work-management/index`) return send({ items: [], nextCursor: null, total: 0, counts: {}, changeSequence: 0, observedAt: stamp, partial: false });
      return send({ items: [], nextCursor: null });
    }
    const file = join(dist, /^\/(?:$|p\/|ui$)/.test(url.pathname) ? "index.html" : url.pathname);
    try {
      const body = await readFile(file);
      res.writeHead(200, { "content-type": ({ ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" } as Record<string, string>)[extname(file)] ?? "application/octet-stream" });
      res.end(body);
    } catch {
      missingResources.push(url.pathname);
      res.writeHead(404); res.end();
    }
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const browser = await chromium.launch({ headless: true, ...(process.env.EVOLOOP_BROWSER_TEST_EXECUTABLE_PATH
    ? { executablePath: process.env.EVOLOOP_BROWSER_TEST_EXECUTABLE_PATH } : {}) });
  t.after(async () => { await browser.close(); await new Promise<void>(done => server.close(() => done())); });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(`${base}/p/${projectId}/documents`);
  await page.getByLabel("访问令牌").fill("fixture-token");
  await page.getByRole("button", { name: "进入", exact: true }).click();
  const main = page.locator("main");
  const rail = page.locator("aside[aria-label=项目导航]");
  await main.getByRole("link", { name: "规范 001" }).waitFor();

  await rail.getByLabel("文档类型筛选").selectOption("report");
  await main.getByRole("link", { name: "报告 050" }).waitFor();
  let text = await main.innerText();
  assert.match(text, /已载入 50 项 · 匹配 50 项 · 后续页面未读/);
  assert.doesNotMatch(text, /已归档报告|规范 \d/);
  assert.match(requests.at(-1)!, /kind=report/);
  assert.match(requests.at(-1)!, /status=active/);

  await main.getByRole("button", { name: "载入更多" }).click();
  await main.getByRole("link", { name: "报告 060" }).waitFor();
  text = await main.innerText();
  assert.match(text, /已载入 60 项 · 匹配 60 项 · 已读完/);
  assert.doesNotMatch(text, /已归档报告|规范 \d/);

  await rail.getByLabel("文档状态筛选").selectOption("archived");
  await main.getByRole("link", { name: "已归档报告 001" }).waitFor();
  text = await main.innerText();
  assert.match(text, /已载入 20 项 · 匹配 20 项 · 已读完/);
  assert.doesNotMatch(text, /\n报告 00[1-9]\n|规范 \d/);
  assert.match(requests.at(-1)!, /kind=report/);
  assert.match(requests.at(-1)!, /status=archived/);

  for (const path of ["/favicon.ico", "/apple-touch-icon.png", "/apple-touch-icon-precomposed.png"]) {
    const response = await page.request.get(`${base}${path}`);
    assert.ok(response.status() < 400, `${path}: ${response.status()}`);
  }
  assert.deepEqual(missingResources, []);
});
