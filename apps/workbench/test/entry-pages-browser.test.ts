// Opt-in built-app regression: build workbench, then set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE.
// Login, the project list, and the pages behind the settings menu (项目设置, 结果未知的操作, 仓库规范).
import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const modulePath = process.env.EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE;
const shots = process.env.EVOLOOP_ENTRY_SCREENSHOT_DIR;
const dist = resolve(import.meta.dirname, "../dist");
const projectId = "33000001-0000-4000-8000-000000000001";
const missingId = "33000002-0000-4000-8000-000000000002";
const stamp = "2026-11-09T08:00:00.000Z";

test("login, project list and settings pages use the new layout and keep their behaviour",
  { skip: !modulePath && "Set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE" }, async t => {
    const { chromium } = (await import(pathToFileURL(modulePath!).href)).default;
    const server = createServer(async (req, res) => {
      const url = new URL(req.url!, "http://127.0.0.1");
      if (url.pathname.startsWith("/api/")) {
        const auth = req.headers.authorization;
        if (auth !== "Bearer fixture-token") { res.writeHead(401, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "unauthorized" })); return; }
        let value: unknown = { items: [], nextCursor: null };
        if (url.pathname === "/api/session") value = {
          principal: { actorId: "zhang-reviewer", projectIds: [projectId, missingId], permissions: ["read", "write", "review"], identityKind: "human" },
          capabilities: {},
        };
        else if (url.pathname === `/api/projects/${missingId}`) { res.writeHead(404, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "not found" })); return; }
        else if (url.pathname === `/api/projects/${projectId}`) value = { id: projectId, title: "入口回归项目", createdAt: stamp };
        else if (url.pathname.endsWith("/impacts")) value = [];
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
    const go = (path: string) => page.evaluate(`(() => { const a = Object.assign(document.createElement("a"), { href: ${JSON.stringify(path)} }); document.body.append(a); a.click(); a.remove(); })()`);
    const noOverflow = () => page.evaluate("document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1");

    await page.goto(`${base}/`);
    await page.getByRole("heading", { name: "进入项目工作台" }).waitFor();
    if (shots) await page.screenshot({ path: `${shots}/login-1440.png` });
    await page.getByLabel("访问令牌").fill("wrong-token");
    await page.getByRole("button", { name: "进入", exact: true }).click();
    await page.getByRole("alert").filter({ hasText: /./ }).first().waitFor();
    await page.getByLabel("访问令牌").fill("fixture-token");
    await page.getByRole("button", { name: "进入", exact: true }).click();

    await page.getByRole("heading", { name: "你的项目" }).waitFor();
    const list = page.getByRole("list", { name: "项目" });
    await list.getByRole("link", { name: /入口回归项目/ }).waitFor();
    assert.match(await list.innerText(), /建立于/);
    assert.doesNotMatch(await list.innerText(), /本机/, "a project is not assumed to be on this machine");
    await page.getByText("有 1 个授权项目尚未创建或暂不可读取").waitFor();
    const create = page.getByRole("region", { name: "创建项目" });
    await create.getByLabel("项目名称").waitFor({ state: "attached" });
    // The card explains itself in words; the full project ID is one click away for the CLI, never an 8-character prefix.
    assert.doesNotMatch(await create.innerText(), /33000002/);
    await create.getByText("完整标识（用于 CLI）").click();
    assert.match(await create.innerText(), new RegExp(missingId));
    assert.equal(await noOverflow(), true);
    if (shots) await page.screenshot({ path: `${shots}/projects-1440.png` });

    await list.getByRole("link", { name: /入口回归项目/ }).click();
    await page.waitForURL(new RegExp(`/p/${projectId}/work`));
    await go(`/p/${projectId}/settings`);
    await page.getByRole("heading", { name: "项目设置" }).waitFor();
    const projectFacts = page.getByRole("region", { name: "当前项目" });
    await projectFacts.getByText("入口回归项目").waitFor();
    // The project's identifier is only under 完整标识, not in the facts' text.
    assert.doesNotMatch(await projectFacts.innerText(), new RegExp(projectId));
    await projectFacts.getByText("完整标识", { exact: true }).click();
    assert.match(await projectFacts.innerText(), new RegExp(`项目\\s*${projectId}`));
    // The fact rows keep their own grid; the old global `dl > div` (170px, gap 12px) stays out of [data-ui].
    const factRow = await projectFacts.locator("dl > div").first().evaluate(el => ({
      columns: getComputedStyle(el).gridTemplateColumns, gap: getComputedStyle(el).columnGap }));
    assert.ok(factRow.columns.startsWith("160px ") && factRow.gap === "16px", `settings fact row: ${JSON.stringify(factRow)}`);
    const access = page.getByRole("region", { name: "当前登录身份" });
    assert.match(await access.innerText(), /zhang-reviewer[\s\S]*人[\s\S]*读取项目[\s\S]*提交业务变更[\s\S]*审阅与复核/);
    assert.equal(await page.getByRole("list", { name: "各类记录的入口" }).getByRole("link").count(), 5);
    if (shots) await page.screenshot({ path: `${shots}/settings-1440.png` });

    await go(`/p/${projectId}/operations`);
    await page.getByRole("heading", { name: "结果未知的操作", level: 1 }).waitFor();
    await page.getByText("没有结果未知的操作").waitFor();
    if (shots) await page.screenshot({ path: `${shots}/operations-1440.png` });

    await go(`/p/${projectId}/repository`);
    await page.getByRole("heading", { name: "仓库规范" }).waitFor();
    assert.equal(await page.getByRole("list", { name: "按问题查阅" }).getByRole("link").count(), 3);
    assert.equal(await page.getByRole("link", { name: /贡献与变更入口/ }).getAttribute("target"), "_blank");

    await page.setViewportSize({ width: 390, height: 844 });
    await go(`/p/${projectId}/settings`);
    await page.getByRole("heading", { name: "项目设置" }).waitFor();
    assert.equal(await noOverflow(), true, "settings fit 390px");
    if (shots) await page.screenshot({ path: `${shots}/settings-390.png`, fullPage: true });
    await go("/");
    await page.getByRole("heading", { name: "你的项目" }).waitFor();
    assert.equal(await noOverflow(), true, "the project list fits 390px");
    if (shots) await page.screenshot({ path: `${shots}/projects-390.png`, fullPage: true });
    await page.getByRole("button", { name: "退出" }).click();
    await page.getByRole("heading", { name: "进入项目工作台" }).waitFor();
    assert.equal(await noOverflow(), true, "the login page fits 390px");
    if (shots) await page.screenshot({ path: `${shots}/login-390.png` });
    assert.deepEqual(errors, []);
  });
