// Opt-in built-app regression: build workbench, then set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE.
// The three pages behind the account menu on the screenshot fixture (scripts/frontend/fixture): 结果未知的操作 opens
// each receipt's object and comes back; 仓库规范 says what the server declared, registers a fixed Git source and records
// a formal decision with the document and revision chosen by name (the request bodies are the same as before); 项目设置
// reads the identity again, says what changed, and keeps the last answer when a reread fails. Screenshots at 1440, 1024
// and 390 go to EVOLOOP_SETTINGS_SCREENSHOT_DIR when it is set.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { answer } from "../../../scripts/frontend/fixture/api.mjs";
import { actorId, id, projectId, token } from "../../../scripts/frontend/fixture/common.mjs";
import { docs, tasks } from "../../../scripts/frontend/fixture/work.mjs";

const modulePath = process.env.EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE;
const shots = process.env.EVOLOOP_SETTINGS_SCREENSHOT_DIR;
const dist = resolve(import.meta.dirname, "../dist");
const root = `/api/projects/${projectId}`;
const gitRef = id(950), formalId = id(951);
const commit = "c".repeat(40), contentHash = "d".repeat(64);
const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const stamp = "2026-11-10T02:40:00.000Z";
const receipts = [
  { actorId, projectId, taskId: docs.rule.id, operationId: id(960), commandType: "document.revise", createdAt: stamp },
  { actorId, projectId, taskId: tasks.t1.id, operationId: id(961), commandType: "task.assignment.set", createdAt: stamp },
  { actorId, projectId, taskId: projectId, operationId: id(962), commandType: "session.message.interrupt", createdAt: stamp },
  { actorId, projectId, taskId: id(963), operationId: id(964), commandType: "task.create", createdAt: stamp },
];

test("结果未知的操作, 仓库规范 and 项目设置: back to the object, sources chosen by name, the identity read again",
  { skip: !modulePath && "Set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE" }, async t => {
    const { chromium } = (await import(pathToFileURL(modulePath!).href)).default;
    const state = { permissions: ["read", "write", "review"], failSession: false };
    const posts: Array<{ path: string; body: Record<string, unknown> }> = [];
    const server = createServer(async (req, res) => {
      const url = new URL(req.url!, "http://127.0.0.1");
      const send = (status: number, value: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
      if (url.pathname.startsWith("/api/")) {
        if (req.headers.authorization !== `Bearer ${token}`) return send(401, { error: "unauthorized" });
        const path = decodeURIComponent(url.pathname);
        if (req.method === "POST") {
          let text = ""; for await (const chunk of req) text += String(chunk);
          const body = JSON.parse(text) as Record<string, unknown>;
          posts.push({ path, body });
          const entityId = path === `${root}/references/git` ? gitRef : path === `${root}/references/formal-decisions` ? formalId : null;
          return send(200, entityId ? { status: "applied", operationId: body.operationId, entityId }
            : { status: "rejected", operationId: body.operationId, code: "FIXTURE", message: "夹具不接受这项写入" });
        }
        if (path === "/api/session") return state.failSession ? send(503, { message: "身份服务暂不可用" }) : send(200, {
          principal: { actorId, projectIds: [projectId], permissions: state.permissions, identityKind: "human" },
          capabilities: { git: true, wiki: false, sourceConfiguration: { git: true, wiki: false }, runtime: false, documentOriginals: true } });
        if (path === `${root}/references/git/${gitRef}`) return send(200, { status: "available", referenceId: gitRef,
          ref: { projectId, repositoryId: "evoLoop", path: "docs/api.md", commit, contentHash }, base64: "", observedAt: stamp });
        if (path === `${root}/references/git/${id(952)}`) return send(200, { status: "unavailable", referenceId: id(952), reason: "commit",
          ref: { projectId, repositoryId: "evoLoop", path: "docs/guide.md", commit, contentHash }, observedAt: stamp });
        if (path.startsWith(`${root}/references/git/`)) return send(404, { message: "没有这条固定引用" });
        const result = answer(path, url.searchParams) as { status: number; value: unknown } | undefined;
        return result ? send(result.status, result.value) : send(200, { items: [], nextCursor: null });
      }
      try {
        const file = /^\/(?:$|p\/|ui$)/.test(url.pathname) ? "index.html" : url.pathname;
        const body = await readFile(join(dist, file));
        res.writeHead(200, { "content-type": ({ ".html": "text/html", ".js": "text/javascript", ".css": "text/css" } as Record<string, string>)[extname(file)] ?? "application/octet-stream" });
        res.end(body);
      } catch { res.writeHead(404); res.end(); }
    });
    await new Promise<void>(done => server.listen(0, "127.0.0.1", done)); t.after(() => server.close());
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const browser = await chromium.launch({ headless: true, ...(process.env.EVOLOOP_BROWSER_TEST_CHROMIUM_EXECUTABLE ? { executablePath: process.env.EVOLOOP_BROWSER_TEST_CHROMIUM_EXECUTABLE } : {}) });
    t.after(() => browser.close());
    const errors: string[] = [];
    async function open(path: string, init?: (context: import("playwright").BrowserContext) => Promise<void>) {
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "zh-CN", timezoneId: "Asia/Shanghai" });
      if (init) await init(context);
      const page = await context.newPage();
      page.on("pageerror", error => errors.push(error.message));
      await page.goto(`${base}${path}`);
      await page.getByLabel("访问令牌").fill(token);
      await page.getByRole("button", { name: "进入", exact: true }).click();
      return page;
    }
    type Page = Awaited<ReturnType<typeof open>>;
    const go = (page: Page, path: string) => page.evaluate(target => { const a = Object.assign(document.createElement("a"), { href: target }); document.body.append(a); a.click(); a.remove(); }, path);
    const heading = (page: Page, name: string) => page.getByRole("heading", { name, exact: true, level: 1 }).filter({ visible: true }).first();
    const shoot = async (page: Page, name: string) => {
      for (const width of [1440, 1024, 390]) {
        await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
        await page.waitForTimeout(150);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1), true, `${name} fits ${width}px`);
        if (shots) await page.screenshot({ path: `${shots}/${name}-${width}.png`, fullPage: true });
      }
      await page.setViewportSize({ width: 1440, height: 900 });
    };

    // 项目设置: the identity is read again on the page, with its time; a change is said, a failed reread keeps the last answer.
    const settings = await open(`/p/${projectId}/settings`);
    await heading(settings, "项目设置").waitFor();
    const access = settings.getByRole("region", { name: "当前登录身份" });
    await access.getByText(/^\d{4}\/\d{1,2}\/\d{1,2} \d{1,2}:\d{2}:\d{2}$/).waitFor();
    assert.match(await access.innerText(), /zhang-reviewer[\s\S]*人[\s\S]*读取项目[\s\S]*提交业务变更[\s\S]*审阅与复核[\s\S]*最后读取/);
    assert.equal(await settings.getByRole("list", { name: "各类记录的入口" }).getByRole("link", { name: /^结果未知的操作/ }).count(), 1,
      "the entry uses the navigation's name for the page");
    await shoot(settings, "settings");
    state.permissions = ["read", "review"];
    await settings.getByRole("button", { name: "重新读取" }).click();
    await access.getByText("与登录时读回的不同").waitFor();
    assert.match(await access.innerText(), /不再有的权限：提交业务变更/);
    assert.doesNotMatch(await access.locator("dl").innerText(), /提交业务变更/, "the permissions shown are the ones read again");
    state.failSession = true;
    await settings.getByRole("button", { name: "重新读取" }).click();
    await access.getByText("上次读回，当前待核对").first().waitFor({ timeout: 20000 });
    assert.match(await access.innerText(), /身份与权限本次重新读取失败：身份服务暂不可用/);
    assert.match(await access.locator("dl").innerText(), /审阅与复核[\s\S]*最后读取[\s\S]*上次读回，当前待核对/, "the last answer stays, marked");
    state.failSession = false; state.permissions = ["read", "write", "review"];

    // 仓库规范: what the server declared, then a Git source registered and a formal decision with the revision chosen by name.
    await go(settings, `/p/${projectId}/repository`);
    const repository = settings;
    await heading(repository, "仓库规范").waitFor();
    const capabilities = repository.getByRole("region", { name: "已配置的能力" });
    await capabilities.getByText("已为本项目配置。").waitFor();
    assert.match(await capabilities.innerText(), /本项目的仓库[\s\S]*无法判断[\s\S]*没有提供列出仓库的接口/);
    assert.match(await capabilities.innerText(), /受管智能体运行[\s\S]*未配置/);
    assert.equal(await repository.getByRole("link", { name: /贡献与变更入口/ }).getAttribute("target"), "_blank");
    const forms = repository.getByRole("region", { name: "登记固定 Git 来源与正式采用" });
    const block = (title: string) => forms.locator("details").filter({ has: repository.getByText(title, { exact: true }) }).first();
    const register = block("登记 Git 固定来源");
    await register.getByText("登记 Git 固定来源", { exact: true }).click();
    await register.getByLabel("仓库标识").fill("evoLoop");
    await register.getByLabel("相对路径").fill("docs/api.md");
    await register.getByLabel("完整 commit").fill(commit.toUpperCase());
    await register.getByText("完整 commit 要用小写字母 a–f。").waitFor();
    await register.getByLabel("完整 commit").fill(commit);
    assert.equal(await register.getByText("完整 commit 要用小写字母 a–f。").count(), 0);
    await register.getByLabel("原文 SHA-256").fill(contentHash);
    await register.getByRole("button", { name: "核验并登记" }).click();
    await forms.getByText("已保存。登记的固定引用已填入下面的表单。").waitFor();
    const registered = posts.find(item => item.path.endsWith("/references/git"))!;
    assert.deepEqual(Object.keys(registered.body).sort(), ["commit", "contentHash", "operationId", "path", "referenceId", "repositoryId"], "the same fields as before");
    assert.deepEqual([registered.body.repositoryId, registered.body.path, registered.body.commit, registered.body.contentHash], ["evoLoop", "docs/api.md", commit, contentHash]);

    const formal = block("记录正式文档与过程文档的关系");
    await formal.getByText("记录正式文档与过程文档的关系", { exact: true }).click();
    await formal.getByText("刚登记的固定来源：evoLoop · docs/api.md").waitFor();
    const documentSelect = formal.getByLabel("过程文档", { exact: true });
    await formal.locator("option", { hasText: docs.rule.title }).waitFor({ state: "attached" });
    await documentSelect.selectOption({ label: docs.rule.title });
    const revisionSelect = formal.getByLabel("过程文档修订");
    await formal.locator("option", { hasText: "当前版，已采用" }).waitFor({ state: "attached" });
    assert.equal(await formal.locator("option", { hasText: "建立对账规则" }).count(), 0, "earlier revisions are read when asked for");
    await formal.getByRole("button", { name: "列出更早的修订" }).click();
    const older = formal.locator("option", { hasText: "建立对账规则" });
    await older.waitFor({ state: "attached" });
    await revisionSelect.selectOption(await older.getAttribute("value") ?? "");
    await formal.getByLabel("决定").selectOption("incorporated");
    await formal.getByLabel("理由").fill("第 1 版的规则已并入接口说明第 2 节");
    assert.doesNotMatch(await formal.innerText(), uuid, "identifiers stay in the closed full-identifier layer");
    await formal.getByText("将要记录的完整标识").click();
    assert.match(await formal.innerText(), new RegExp(`${gitRef}[\\s\\S]*${docs.rule.id}[\\s\\S]*${docs.rule.oldRev}`));
    await formal.getByRole("button", { name: "记录关系" }).click();
    for (let i = 0; i < 50 && !posts.some(item => item.path.endsWith("/formal-decisions")); i++) await repository.waitForTimeout(50);
    const decided = posts.find(item => item.path.endsWith("/formal-decisions"))!;
    assert.deepEqual(Object.keys(decided.body).sort(), ["decision", "decisionId", "documentId", "documentRevisionId", "gitReferenceId", "operationId", "reason"], "the same fields as before");
    assert.deepEqual([decided.body.gitReferenceId, decided.body.documentId, decided.body.documentRevisionId, decided.body.decision, decided.body.reason],
      [gitRef, docs.rule.id, docs.rule.oldRev, "incorporated", "第 1 版的规则已并入接口说明第 2 节"]);
    await formal.getByText("已保存。", { exact: true }).waitFor();
    // Another fixed reference is pasted from a task's full identifiers and read back to say what it is.
    await formal.getByRole("button", { name: "改用另一条固定引用" }).click();
    const reference = formal.getByLabel("固定 Git 引用");
    await reference.fill(id(999));
    await formal.getByText("本项目里没有这条固定 Git 引用。").waitFor();
    await reference.fill(id(999).slice(0, 12));
    await formal.getByText(/36 位的完整标识/).waitFor();
    await reference.fill(id(952));
    await formal.getByText("已登记的固定来源：evoLoop · docs/guide.md（原文当前读不到，提交时服务端会再核验）").waitFor();
    await reference.fill(gitRef);
    await formal.getByText("刚登记的固定来源：evoLoop · docs/api.md").waitFor();
    await shoot(repository, "repository");
    await repository.context().close();

    // 结果未知的操作: each receipt says where its operation was and opens it, with the way back.
    const operations = await open(`/p/${projectId}/operations`, context => context.addInitScript(saved =>
      sessionStorage.setItem("evoloop.unconfirmed-operations.v1", JSON.stringify(saved)), receipts));
    await heading(operations, "结果未知的操作").waitFor();
    const row = (n: number) => operations.locator(`[data-receipt-origin="${id(n)}"]`);
    await row(960).getByText(`原操作所在：文档 · ${docs.rule.title}`).waitFor();
    await row(961).getByText(`原操作所在：任务 · ${tasks.t1.title}`).waitFor();
    await row(962).getByText("回执只记下了项目，没有记下是哪个智能体；可以到智能体核对。").waitFor();
    assert.equal(await row(962).getByRole("link", { name: "打开智能体" }).getAttribute("href"), `/p/${projectId}/sessions`);
    await row(964).getByText(/^在本项目里读不到这个任务。如果原操作是新建，它可能还没有建立/).waitFor();
    assert.equal(await row(964).getByRole("link").count(), 0, "an object that is not there is not linked");
    for (const n of [960, 961, 962, 964]) assert.doesNotMatch(await row(n).innerText(), uuid, "the object's identifier stays in the full-identifier layer");
    assert.equal(await operations.getByRole("link", { name: /发给智能体的消息/ }).getAttribute("href"), `/p/${projectId}/sessions`, "the text and the link agree");
    await shoot(operations, "operations");
    const back = new URLSearchParams({ return: `/p/${projectId}/operations`, actor: actorId, returnTitle: "结果未知的操作" });
    assert.equal(await row(960).getByRole("link", { name: "打开原对象" }).getAttribute("href"), `/p/${projectId}/documents/${docs.rule.id}?${back}`);
    await row(960).getByRole("link", { name: "打开原对象" }).click();
    await heading(operations, docs.rule.title).waitFor();
    await operations.getByRole("link", { name: /返回来源/ }).filter({ visible: true }).first().click();
    await heading(operations, "结果未知的操作").waitFor();
    assert.equal(new URL(operations.url()).pathname, `/p/${projectId}/operations`);
    await row(961).getByRole("link", { name: "打开原对象" }).click();
    await heading(operations, tasks.t1.title).waitFor();
    await operations.goBack();
    await heading(operations, "结果未知的操作").waitFor();
    assert.deepEqual(errors, []);
  });
