// Built-app regression for identity: a 401 ends the session and clears the page; a project whose grant is gone
// (403 on the project) sends the reader back to the project list. Runs only with a Playwright module.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const modulePath = process.env.EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE;
const dist = resolve(import.meta.dirname, "../dist");
const projectA = "31000001-0000-4000-8000-000000000001", projectB = "31000002-0000-4000-8000-000000000002";
const stamp = "2026-11-09T00:00:00.000Z";

test("a 401 signs out and clears the page; a revoked project returns to the project list", { skip: !modulePath && "Set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE" }, async t => {
  const { chromium } = (await import(pathToFileURL(modulePath!).href)).default;
  let expired = false, revokedA = false;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, "http://127.0.0.1");
    if (url.pathname.startsWith("/api/")) {
      const signedIn = req.headers.authorization === "Bearer fixture-token" && !expired;
      let status = signedIn ? 200 : 401, value: unknown = signedIn ? { items: [], nextCursor: null } : { message: "令牌无效" };
      if (signedIn && url.pathname === "/api/session") value = { principal: { actorId: "reader", projectIds: revokedA ? [projectB] : [projectA, projectB], permissions: ["read"] }, capabilities: {} };
      else if (signedIn && url.pathname === `/api/projects/${projectA}`) {
        if (revokedA) { status = 403; value = { message: "无权访问项目" }; } else value = { id: projectA, title: "甲项目", createdAt: stamp };
      } else if (signedIn && url.pathname === `/api/projects/${projectB}`) value = { id: projectB, title: "乙项目", createdAt: stamp };
      res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); return;
    }
    const file = join(dist, /^\/(?:$|p\/|ui$)/.test(url.pathname) ? "index.html" : url.pathname);
    try { const body = await readFile(file); res.writeHead(200, { "content-type": ({ ".html": "text/html", ".js": "text/javascript", ".css": "text/css" } as Record<string, string>)[extname(file)] ?? "application/octet-stream" }); res.end(body); }
    catch { res.writeHead(404); res.end(); }
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done)); t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const browser = await chromium.launch({ headless: true, ...(process.env.EVOLOOP_BROWSER_TEST_EXECUTABLE_PATH ? { executablePath: process.env.EVOLOOP_BROWSER_TEST_EXECUTABLE_PATH } : {}) }); t.after(() => browser.close());
  const page = await browser.newPage();
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  const signIn = async () => { await page.getByLabel("访问令牌").fill("fixture-token"); await page.getByRole("button", { name: "进入", exact: true }).click(); };
  await page.goto(`${base}/p/${projectA}/settings`);
  await signIn();
  await page.getByRole("heading", { name: "项目设置" }).waitFor();
  await page.locator(".project-switch strong", { hasText: "甲项目" }).waitFor();

  expired = true;
  await page.getByRole("button", { name: "重新读取" }).first().click();
  await page.getByLabel("访问令牌").waitFor();
  assert.match(await page.locator(".auth-card").innerText(), /登录已失效/);
  assert.equal(await page.getByText("甲项目").count(), 0, "nothing read under the lost login stays on screen");
  assert.equal(new URL(page.url()).pathname, `/p/${projectA}/settings`, "the address is kept for the next login");

  expired = false;
  await signIn();
  await page.locator(".project-switch strong", { hasText: "甲项目" }).waitFor();
  assert.equal(await page.locator(".auth-card").count(), 0);

  revokedA = true;
  await page.locator('nav[aria-label="主导航"] a.rail-brand').click();
  await page.getByRole("heading", { name: "你的项目" }).waitFor();
  assert.equal(await page.locator(`a[href="/p/${projectA}/work"]`).count(), 0, "the list rereads each project; A is no longer readable");
  await page.evaluate(path => { const link = Object.assign(document.createElement("a"), { href: path }); document.body.append(link); link.click(); link.remove(); }, `/p/${projectB}/settings`);
  await page.locator(".project-switch strong", { hasText: "乙项目" }).waitFor();
  // A saved link to the revoked project, opened inside the app.
  await page.evaluate(path => { const link = Object.assign(document.createElement("a"), { href: path }); document.body.append(link); link.click(); link.remove(); }, `/p/${projectA}/settings`);
  await page.getByText("你已无权访问该项目，已回到项目列表。").waitFor();
  assert.equal(new URL(page.url()).pathname, "/");
  await page.locator(`a[href="/p/${projectB}/work"]`).waitFor();
  assert.equal(await page.getByText("甲项目").count(), 0, "nothing of the revoked project stays on screen");
  assert.deepEqual(errors, []);
});
