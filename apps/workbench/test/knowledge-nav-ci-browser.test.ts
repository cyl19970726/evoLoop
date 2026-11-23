// Task 95fc1fb1: a project without a knowledge backend is a normal state. The navigation decides whether 知识空间 is listed from the service's
// 200 judgment of the project (`GET /projects/:id/capabilities`), so no page sends the refused `knowledge/capabilities` read or leaves a
// failed-resource line in the console; a project with a backend still lists 知识空间. Needs EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const modulePath = process.env.EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE;
const required = process.env.EVOLOOP_BROWSER_TEST_REQUIRED === "1";
const dist = resolve(import.meta.dirname, "../dist");
const projectId = "95000000-0000-4000-8000-000000000001";
const stamp = "2026-11-23T08:00:00.000Z";

test("no page sends a refused knowledge read without a backend; a configured project lists 知识空间", { skip: !required && !modulePath && "Set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE" }, async t => {
  assert.ok(modulePath, "EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE is required when EVOLOOP_BROWSER_TEST_REQUIRED=1");
  const { chromium } = (await import(pathToFileURL(modulePath).href)).default;
  let configured = false;
  const knowledgeReads: string[] = [];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, "http://127.0.0.1");
    const p = `/api/projects/${projectId}`;
    const send = (value: unknown, status = 200) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
    if (url.pathname.startsWith("/api/")) {
      if (url.pathname === "/api/session") return send({ principal: { actorId: "fixture", projectIds: [projectId], permissions: ["task", "document", "session", "management"], decisions: true }, capabilities: {} });
      if (url.pathname === p) return send({ id: projectId, title: "知识导航项目", createdAt: stamp });
      if (url.pathname === `${p}/capabilities`) return send({ projectId, status: "available", items: [{ key: "knowledge", scope: "project", readAt: "start", pending: null,
        state: configured ? "configured" : "not_configured", reason: configured ? null : "project_not_configured" }] });
      if (url.pathname.startsWith(`${p}/knowledge`)) {
        knowledgeReads.push(url.pathname);
        return configured ? send({ items: [], nextCursor: null }) : send({ code: "KNOWLEDGE_NOT_CONFIGURED", message: "当前项目尚未配置外置知识后端。" }, 409);
      }
      if (url.pathname === `${p}/work-management/index`) return send({ items: [], nextCursor: null, total: 0, counts: {}, changeSequence: 0, observedAt: stamp, partial: false });
      if (url.pathname === `${p}/stages`) return send([]);
      return send({ items: [], nextCursor: null });
    }
    const file = join(dist, /^\/(?:$|p\/|ui$)/.test(url.pathname) ? "index.html" : url.pathname);
    try { const data = await readFile(file); res.writeHead(200, { "content-type": ({ ".html": "text/html", ".js": "text/javascript", ".css": "text/css" } as Record<string, string>)[extname(file)] ?? "application/octet-stream" }); res.end(data); }
    catch { res.writeHead(404); res.end(); }
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const browser = await chromium.launch({ headless: true, ...(process.env.EVOLOOP_BROWSER_TEST_EXECUTABLE_PATH ? { executablePath: process.env.EVOLOOP_BROWSER_TEST_EXECUTABLE_PATH } : {}) });
  t.after(async () => { await browser.close(); await new Promise<void>(done => server.close(() => done())); });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const visit = async (width: number, height: number, path: string) => {
    const page = await browser.newPage({ viewport: { width, height } });
    const consoleErrors: string[] = []; const failed: string[] = [];
    page.on("console", (message: { type(): string; text(): string }) => { if (message.type() === "error") consoleErrors.push(message.text()); });
    page.on("response", (response: { status(): number; url(): string }) => { if (response.status() >= 400 && response.url().includes("/knowledge")) failed.push(`${response.status()} ${response.url()}`); });
    await page.goto(`${base}/p/${projectId}${path}`);
    await page.getByLabel("访问令牌").fill("fixture-token");
    await page.getByRole("button", { name: "进入", exact: true }).click();
    await page.locator("aside[aria-label=项目导航], main").first().waitFor();
    await page.waitForTimeout(1500);
    return { page, consoleErrors, failed };
  };

  for (const [width, height] of [[1440, 900], [390, 844]] as const) {
    for (const path of ["", "/tasks", "/documents", "/schedules", "/settings"]) {
      knowledgeReads.length = 0;
      const { page, consoleErrors, failed } = await visit(width, height, path);
      assert.deepEqual(knowledgeReads, [], `${path || "/"} at ${width}: no knowledge read goes out without a backend`);
      assert.deepEqual(failed, [], `${path || "/"} at ${width}: no refused knowledge request`);
      assert.deepEqual(consoleErrors.filter(line => /Failed to load resource/.test(line)), [], `${path || "/"} at ${width}: no failed-resource line in the console`);
      assert.equal(await page.locator("aside[aria-label=项目导航]").getByRole("link", { name: /^知识空间/ }).count(), 0, `${path || "/"} at ${width}: not listed in the navigation without a backend`);
      await page.close();
    }
  }

  configured = true;
  const { page } = await visit(1440, 900, "");
  await page.locator("aside[aria-label=项目导航]").getByRole("link", { name: /^知识空间/ }).waitFor();
  await page.close();
});
