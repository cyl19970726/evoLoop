// Opt-in built-app regression: build workbench, then set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE.
// 团队: the inner rail switches views and lists roles; a role link opens its card; reviews open their document.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { initialRoleTemplates } from "@evoloop/contracts/roles";

const modulePath = process.env.EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE;
const shots = process.env.EVOLOOP_TEAM_SCREENSHOT_DIR;
const dist = resolve(import.meta.dirname, "../dist");
const projectId = "34000001-0000-4000-8000-000000000001";
const id = (n: number) => `34000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const stamp = "2026-11-09T08:00:00.000Z";
const role = (n: number, title: string, state: string, roleClass: "business" | "system") => ({
  projectId, id: id(n), version: 1, currentRevisionId: id(n), state,
  proposal: { title, roleClass, goal: `${title}的目标`, independentResponsibility: "独立责任", ownerScope: "项目", inputs: ["任务"], writableAssets: [],
    deliverables: ["交付"], triggers: ["分派"], workflow: "读与做", handoffBoundary: "人工承接", evidence: [], alternatives: [], firstTaskId: id(n),
    baseline: "旧状态", expectedEffect: "可用", costLimit: "有限", trialDays: 7, reviewAtUtc: stamp, exitCriteria: "回看" },
  proposedBy: "reviewer", createdAtUtc: stamp, trialStartedAtUtc: stamp, reviewAtUtc: stamp, mergeTargetRoleId: null,
});
const roles = [role(1, "前端实现", "active", "business"), role(2, "统筹", "active", "system"), role(3, "测试验收", "trial", "business"), role(4, "旧职责", "retired", "business")];
const review = (n: number, title: string) => ({ projectId, id: id(100 + n), version: 1, currentRevisionId: id(200 + n), title, kind: "organization_review",
  status: "published", createdAt: stamp, updatedAt: stamp,
  organizationReview: { observedFrom: "2026-11-01T00:00:00.000Z", observedTo: "2026-11-08T00:00:00.000Z", timeZone: "Asia/Shanghai" } });

test("团队 switches views in the inner rail, lists roles there and opens organization reviews",
  { skip: !modulePath && "Set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE" }, async t => {
    const { chromium } = (await import(pathToFileURL(modulePath!).href)).default;
    const server = createServer(async (req, res) => {
      const url = new URL(req.url!, "http://127.0.0.1");
      if (url.pathname.startsWith("/api/")) {
        const root = `/api/projects/${projectId}`;
        let value: unknown = { items: [], nextCursor: null };
        if (url.pathname === "/api/session") value = { principal: { actorId: "reader", projectIds: [projectId], permissions: ["read"] }, capabilities: {} };
        else if (url.pathname === root) value = { id: projectId, title: "团队回归项目", createdAt: stamp };
        else if (url.pathname === `${root}/roles`) value = { items: roles, nextCursor: null };
        else if (url.pathname.startsWith(`${root}/roles/`) && (url.pathname.endsWith("/hosts") || url.pathname.endsWith("/bindings"))) value = [];
        else if (url.pathname.startsWith(`${root}/roles/`)) value = roles.find(item => url.pathname.includes(item.id)) ?? {};
        else if (url.pathname === `${root}/role-templates`) value = { templates: initialRoleTemplates.map(item => ({ ...item, state: "not-established", roleIds: [] })), roles, nextCursor: null };
        else if (url.pathname === `${root}/documents` && url.searchParams.get("kind") === "organization_review") value = { items: [review(1, "第 3 轮组织复盘"), review(2, "第 2 轮组织复盘")], nextCursor: null };
        else if (url.pathname === `${root}/runtime`) value = { available: true, error: null, allowedCwds: [], grants: [] };
        else if ([`${root}/runtime/sessions`, `${root}/runtime/runs`, `${root}/resident-queues`, `${root}/impacts`].includes(url.pathname)) value = [];
        else if (url.pathname === `${root}/orchestration/status`) value = { state: "active", running: false, busy: false, faults: [], lastError: null };
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
    await page.goto(`${base}/p/${projectId}/roles`);
    await page.getByLabel("访问令牌").fill("fixture-token");
    await page.getByRole("button", { name: "进入", exact: true }).click();
    await page.getByRole("heading", { name: "职责", exact: true }).waitFor();
    const views = page.locator("aside[aria-label=项目导航]");
    const directory = page.getByRole("navigation", { name: "职责目录" });
    await directory.getByRole("link", { name: /前端实现/ }).waitFor();
    assert.deepEqual(await directory.locator(":scope > div > span").allTextContents(), ["业务职责 · 2", "系统职责 · 1", "提议与已关闭 · 1"]);
    await directory.getByRole("link", { name: /测试验收/ }).click();
    await page.waitForURL(new RegExp(`role=${id(3)}`));
    assert.equal(await directory.getByRole("link", { name: /测试验收/ }).getAttribute("aria-current"), "page");
    await page.locator(`#role-${id(3)}[open]`).waitFor();
    if (shots) await page.screenshot({ path: `${shots}/team-roles-1440.png` });

    await views.getByRole("link", { name: "组织复盘", exact: true }).click();
    await page.waitForURL(new RegExp(`/p/${projectId}/reviews`));
    await page.getByRole("heading", { name: "组织复盘", exact: true }).waitFor();
    const list = page.getByRole("list", { name: "复盘文档" });
    await list.getByRole("link").first().waitFor();
    assert.deepEqual(await list.getByRole("link").evaluateAll(links => links.map(link => link.querySelector("span")?.textContent)), ["第 3 轮组织复盘", "第 2 轮组织复盘"]);
    assert.equal(await list.getByRole("link").first().getAttribute("href"), `/p/${projectId}/documents/${id(101)}?revision=${id(201)}`);
    await page.getByLabel("搜索复盘文档").fill("第 2");
    assert.equal(await list.getByRole("link").count(), 1);
    if (shots) await page.screenshot({ path: `${shots}/team-reviews-1440.png` });

    await views.getByRole("link", { name: "分工讨论", exact: true }).click();
    await page.getByRole("heading", { name: "分工讨论", exact: true }).waitFor();
    assert.equal(await page.getByRole("navigation", { name: "职责目录" }).count(), 0, "the role directory only shows with 职责");

    await views.getByRole("link", { name: "职责", exact: true }).click();
    await page.getByRole("heading", { name: "职责", exact: true }).waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate("document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1"), true, "no horizontal overflow at 390px");
    if (shots) await page.screenshot({ path: `${shots}/team-roles-390.png` });
    assert.deepEqual(errors, []);
  });
