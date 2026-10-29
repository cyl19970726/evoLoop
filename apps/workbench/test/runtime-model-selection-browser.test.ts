// Opt-in built-app regression: build workbench, then set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const modulePath = process.env.EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE;
const dist = resolve(import.meta.dirname, "../dist");
const projectId = "71000001-0000-4000-8000-000000000001";
const roleId = "71000002-0000-4000-8000-000000000002";

test("Session creation requires a catalog model authorized by the selected grant", {
  skip: !modulePath && "Set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE after building the workbench",
}, async t => {
  const { chromium } = (await import(pathToFileURL(modulePath!).href)).default;
  const grants = [
    { projectId, actorId: "reviewer", roleId, authorizationScope: "multi", cwd: "/tmp/multi",
      sandbox: "danger-full-access", approvalPolicy: "never", networkAccess: true, model: "gpt-6-luna", models: ["gpt-6-sol", "uncatalogued"] },
    { projectId, actorId: "reviewer", roleId, authorizationScope: "legacy", cwd: "/tmp/legacy",
      sandbox: "danger-full-access", approvalPolicy: "never", networkAccess: true, model: "gpt-6-luna" },
    { projectId, actorId: "reviewer", roleId, authorizationScope: "default", cwd: "/tmp/default",
      sandbox: "danger-full-access", approvalPolicy: "never", networkAccess: true },
    { projectId, actorId: "reviewer", roleId, authorizationScope: "missing", cwd: "/tmp/missing",
      sandbox: "danger-full-access", approvalPolicy: "never", networkAccess: true, models: ["uncatalogued"] },
  ];
  let catalog: { status: string; models: string[]; error?: string } = { status: "available", models: ["gpt-6-sol", "gpt-6-luna"] };
  let httpFailure = false;
  const commands: Record<string, unknown>[] = [];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname === "/__fixture/catalog") {
      catalog = JSON.parse(url.searchParams.get("value")!) as typeof catalog;
      httpFailure = url.searchParams.get("httpFailure") === "1";
      res.end("ok"); return;
    }
    if (url.pathname.startsWith("/api/")) {
      const root = `/api/projects/${projectId}`;
      let value: unknown = { items: [], nextCursor: null }, status = 200;
      if (url.pathname === "/api/session") value = { principal: { actorId: "reviewer", projectIds: [projectId], permissions: ["read", "write", "review"] }, capabilities: {} };
      else if (url.pathname === "/api/commands" && req.method === "POST") {
        let body = ""; for await (const chunk of req) body += String(chunk);
        const command = JSON.parse(body) as Record<string, unknown>; commands.push(command);
        value = { status: "applied", operationId: command.operationId, entityId: command.sessionId, version: 1 };
      }
      else if (url.pathname === root) value = { id: projectId, title: "模型夹具", createdAt: "2026-10-29T00:00:00Z" };
      else if (url.pathname === `${root}/runtime`) value = { available: true, error: null, allowedCwds: [], grants };
      else if (url.pathname === `${root}/runtime/models`) { value = httpFailure ? { message: "目录连接失败" } : catalog; status = httpFailure ? 503 : 200; }
      else if (url.pathname === `${root}/runtime/sessions` || url.pathname === `${root}/runtime/runs` || url.pathname === `${root}/resident-queues`) value = [];
      else if (url.pathname === `${root}/orchestration/status`) value = { state: "active", running: false, busy: false, faults: [], lastError: null };
      res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); return;
    }
    try {
      const file = url.pathname === "/" ? "index.html" : url.pathname;
      const body = await readFile(join(dist, file));
      res.writeHead(200, { "content-type": ({ ".html": "text/html", ".js": "text/javascript", ".css": "text/css" } as Record<string, string>)[extname(file)] ?? "application/octet-stream" }); res.end(body);
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const browser = await chromium.launch({ headless: true, ...(process.env.EVOLOOP_BROWSER_TEST_EXECUTABLE_PATH
    ? { executablePath: process.env.EVOLOOP_BROWSER_TEST_EXECUTABLE_PATH } : {}) }); t.after(() => browser.close());
  const page = await browser.newPage();
  await page.goto(`${base}/#/p/${projectId}/runtime?view=execution`);
  await page.getByLabel("访问令牌").fill("fixture-token");
  await page.getByRole("button", { name: "进入", exact: true }).click();
  await page.getByText("创建授权范围内的新会话").click();
  const grant = page.getByLabel("已配置的完整权限授权");
  const model = page.locator("label").filter({ hasText: /^精确模型/ }).locator("select");
  const create = page.getByRole("button", { name: "登记并创建会话" });
  assert.equal(await create.count(), 0);
  await grant.selectOption("0");
  assert.deepEqual(await model.locator("option").allTextContents(), ["请选择模型", "gpt-6-sol", "gpt-6-luna"]);
  assert.equal(await create.count(), 0);
  await model.selectOption("gpt-6-sol");
  const firstResponse=page.waitForResponse(response=>response.url().endsWith("/api/commands")&&response.request().method()==="POST");
  await create.click();
  await firstResponse;
  assert.equal(commands.at(-1)?.model, "gpt-6-sol");
  assert.equal(commands.at(-1)?.authorizationScope, "multi");
  await grant.selectOption("1");
  assert.deepEqual(await model.locator("option").allTextContents(), ["请选择模型", "gpt-6-luna"]);
  assert.equal(await create.count(), 0);
  await grant.selectOption("2");
  await page.getByText("此环境尚未配置精确模型授权", { exact: false }).waitFor();
  assert.equal(await model.count(), 0);
  assert.equal(await create.count(), 0);
  await grant.selectOption("3");
  await page.getByText("此授权与当前模型目录没有交集").waitFor();
  assert.equal(await create.count(), 0);
  assert.equal(commands.length, 1);

  for (const [next, failureText] of [
    [{ status: "empty", models: [] }, "模型目录为空"],
    [{ status: "unavailable", models: [], error: "provider offline" }, "模型目录暂不可用"],
  ] as const) {
    await fetch(`${base}/__fixture/catalog?value=${encodeURIComponent(JSON.stringify(next))}`);
    await page.getByRole("button", { name: "读取运行状态" }).click();
    await page.getByText(failureText, { exact: false }).waitFor();
    assert.equal(await create.count(), 0);
  }
  await fetch(`${base}/__fixture/catalog?value=${encodeURIComponent(JSON.stringify(catalog))}&httpFailure=1`);
  await page.getByRole("button", { name: "读取运行状态" }).click();
  await page.getByText("模型目录读取失败", { exact: false }).waitFor();
  assert.equal(await create.count(), 0);
  assert.equal(commands.length, 1);
});
