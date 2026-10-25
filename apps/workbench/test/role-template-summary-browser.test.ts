// Built-app fixture. It becomes runnable when the shared summary is wired into runtime and Roles.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { initialRoleTemplates } from "@evoloop/contracts/roles";

const modulePath = process.env.EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE;
const dist = resolve(import.meta.dirname, "../dist");
const projectId = "30000001-0000-4000-8000-000000000001";
const roleId = "30000002-0000-4000-8000-000000000002";
const stamp = "2026-10-25T00:00:00.000Z";
const role = { projectId, id: roleId, version: 2, currentRevisionId: roleId, state: "trial",
  proposal: { title: "真实功能开发职责", roleClass: "business", templateKey: "functional-development",
    goal: "真实工作", independentResponsibility: "真实责任", ownerScope: "项目", inputs: ["任务"], writableAssets: [],
    deliverables: ["交付"], triggers: ["分派"], workflow: "读与做", handoffBoundary: "人工承接",
    evidence: [], alternatives: [], firstTaskId: roleId, baseline: "旧状态", expectedEffect: "可用", costLimit: "有限",
    trialDays: 7, reviewAtUtc: stamp, exitCriteria: "回看" },
  proposedBy: "reviewer", createdAtUtc: stamp, trialStartedAtUtc: stamp, reviewAtUtc: stamp, mergeTargetRoleId: null };
const templates = initialRoleTemplates.map(item => ({ ...item, state: item.key === "functional-development" ? "established" : "not-established",
  roleIds: item.key === "functional-development" ? [roleId] : [] }));

test("seven template states appear in runtime and Roles with truthful refresh and target link", { skip: !modulePath && "Set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE after integration" }, async t => {
  const { chromium } = (await import(pathToFileURL(modulePath!).href)).default;
  let mode: "normal" | "fail" | "partial" = "normal";
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname === "/__fixture/mode") { mode = url.searchParams.get("value") as typeof mode; res.end("ok"); return; }
    if (url.pathname.startsWith("/api/")) {
      let value: unknown = { items: [], nextCursor: null }, status = 200;
      const root = `/api/projects/${projectId}`;
      if (url.pathname === "/api/session") value = { principal: { actorId: "reader", projectIds: [projectId], permissions: ["read"] }, capabilities: {} };
      else if (url.pathname === root) value = { id: projectId, title: "模板项目", createdAt: stamp };
      else if (url.pathname === `${root}/runtime`) value = { available: true, error: null, allowedCwds: [], grants: [] };
      else if ([`${root}/runtime/sessions`, `${root}/runtime/runs`, `${root}/resident-queues`].includes(url.pathname)) value = [];
      else if (url.pathname === `${root}/orchestration/status`) value = { state: "active", running: false, busy: false, faults: [], lastError: null };
      else if (url.pathname === `${root}/role-templates`) {
        if (mode === "fail") { status = 503; value = { message: "暂不可读" }; }
        else value = { templates: mode === "partial" ? templates.map(item => item.key === "cognition" ? { ...item, state: "unknown" } : item) : templates,
          roles: [role], nextCursor: mode === "partial" ? roleId : null };
      } else if (url.pathname === `${root}/roles`) value = { items: [role], nextCursor: null };
      else if (url.pathname === `${root}/roles/${roleId}`) value = role;
      else if (url.pathname === `${root}/roles/${roleId}/hosts` || url.pathname === `${root}/roles/${roleId}/bindings`) value = [];
      res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); return;
    }
    const file = join(dist, url.pathname === "/" ? "index.html" : url.pathname);
    try { const body = await readFile(file); res.writeHead(200, { "content-type": ({ ".html": "text/html", ".js": "text/javascript", ".css": "text/css" })[extname(file)] ?? "application/octet-stream" }); res.end(body); }
    catch { res.writeHead(404); res.end(); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const browser = await chromium.launch({ headless: true }); t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await page.goto(`${base}/#/p/${projectId}/runtime`);
  await page.getByLabel("访问令牌").fill("fixture-token");
  await page.getByRole("button", { name: "进入", exact: true }).click();
  const summary = page.locator(".role-template-summary:visible");
  await summary.getByText("真实功能开发职责").waitFor();
  assert.equal(await summary.locator("li").count(), 7);
  assert.match(await summary.innerText(), /认知.*未建立/s);
  assert.equal(await summary.getByRole("link", { name: /真实功能开发职责/ }).getAttribute("href"), `#/p/${projectId}/roles?role=${roleId}`);
  await fetch(`${base}/__fixture/mode?value=fail`);
  await summary.getByRole("button", { name: "回读当前状态" }).click();
  await summary.getByRole("alert").getByText(/保留上次观察/).waitFor();
  assert.equal(await summary.getByText("真实功能开发职责").count(), 1);
  await fetch(`${base}/__fixture/mode?value=partial`);
  await summary.getByRole("button", { name: "回读当前状态" }).click();
  await summary.getByText(/Role 列表尚有未读页/).waitFor();
  assert.match(await summary.innerText(), /认知.*未知/s);
  await summary.getByRole("link", { name: /真实功能开发职责/ }).click();
  await page.waitForURL(url => url.hash === `#/p/${projectId}/roles?role=${roleId}`);
  await page.locator(`#role-${roleId}[open]`).waitFor();
  const rolesSummary = page.locator(".role-template-summary:visible");
  await rolesSummary.getByText("真实功能开发职责").waitFor();
  assert.equal(await rolesSummary.locator("li").count(), 7);
  assert.equal(errors.length, 0, errors.join(" | "));
});
