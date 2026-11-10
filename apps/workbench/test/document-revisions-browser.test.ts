// Opt-in built-app regression: build workbench, then set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE.
// 过程文档 › 第 N 版 / 共 M 版 and 全部版本 on the screenshot fixture (scripts/frontend/fixture): the header and the right
// column number the revision on screen, M from the revision list's count (an older document numbered by time may not end
// at it); 全部版本 lists every revision and opens the read-only page of each; a document that changed between pages
// offers the first page again; a list that cannot be read says so and never claims a count. Screenshots at 1440, 1024
// (the right column a drawer, opened by hand) and 390 go to EVOLOOP_DOCUMENT_REVISIONS_SCREENSHOT_DIR when it is set.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { answer } from "../../../scripts/frontend/fixture/api.mjs";
import { id, projectId, token } from "../../../scripts/frontend/fixture/common.mjs";
import { docs, revisionPage } from "../../../scripts/frontend/fixture/work.mjs";

const modulePath = process.env.EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE;
const shots = process.env.EVOLOOP_DOCUMENT_REVISIONS_SCREENSHOT_DIR;
const dist = resolve(import.meta.dirname, "../dist");
const root = `/api/projects/${projectId}`;

test("过程文档: 第 N 版 / 共 M 版 in the header and the right column, 全部版本 opens each version, the list's limits said",
  { skip: !modulePath && "Set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE" }, async t => {
    const { chromium } = (await import(pathToFileURL(modulePath!).href)).default;
    // 本轮需求总图 is an older document numbered by time: its current revision is 第 1 版 of 3, and a 第 4 版 is saved
    // between the two pages of its list. 验收排队怎样分担's list repeats a cursor. 试用反馈汇总's list cannot be read.
    const legacy = { saved: false };
    const server = createServer(async (req, res) => {
      const url = new URL(req.url!, "http://127.0.0.1");
      const send = (status: number, value: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
      if (url.pathname.startsWith("/api/")) {
        if (req.headers.authorization !== `Bearer ${token}`) return send(401, { error: "unauthorized" });
        const path = decodeURIComponent(url.pathname);
        if (path === `${root}/documents/${docs.report.id}/revisions`) return send(503, { message: "修订列表暂不可读" });
        if (path === `${root}/documents/${docs.map.id}/revisions`) {
          const fixture = revisionPage(docs.map);
          const current = fixture.items[0]!;
          const earlier = (n: number) => ({ ...current, id: id(170 + n), revisionNumber: n + 1, current: false, published: false, state: "historical",
            createdAt: `2026-11-0${n + 2}T01:00:00.000Z`, reason: n === 3 ? "读取期间保存的新版" : n === 2 ? "按时间补号的较新一版" : "第二稿", previousRevisionId: null });
          // Once 第 4 版 is saved it is the current revision; the published one stays.
          const head = () => legacy.saved ? { ...fixture.document, version: 2, currentRevisionId: id(173) } : fixture.document;
          if (url.searchParams.get("cursor") === "older") {
            legacy.saved = true;
            return send(200, { items: [{ ...current, current: false, state: "published" }], nextCursor: null, document: head(), revisionCount: 4 });
          }
          return send(200, legacy.saved ? { items: [{ ...earlier(3), current: true, state: "current" }, earlier(2)], nextCursor: "older", document: head(), revisionCount: 4 }
            : { items: [earlier(2), earlier(1)], nextCursor: "older", document: head(), revisionCount: 3 });
        }
        if (path === `${root}/documents/${docs.discussion.id}/revisions`) {
          const fixture = revisionPage(docs.discussion);
          const current = fixture.items[0]!;
          return send(200, url.searchParams.get("cursor") === "loop"
            ? { ...fixture, items: [current], nextCursor: "loop", revisionCount: 2 }
            : { ...fixture, items: [{ ...current, id: id(180), revisionNumber: 2, current: false, state: "historical", reason: "补充第二种做法" }], nextCursor: "loop", revisionCount: 2 });
        }
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
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "zh-CN", timezoneId: "Asia/Shanghai" });
    const page = await context.newPage();
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(`${base}/p/${projectId}/documents/${docs.rule.id}`);
    await page.getByLabel("访问令牌").fill(token);
    await page.getByRole("button", { name: "进入", exact: true }).click();
    const heading = (name: string) => page.getByRole("heading", { name, exact: true, level: 1 }).filter({ visible: true }).first();
    const header = page.locator("[data-revision-number]").filter({ visible: true }).first();
    const numbered = (text: string) => page.locator("[data-revision-number]").filter({ visible: true, hasText: new RegExp(`^${text}$`) }).first().waitFor();
    const openPanel = async () => {
      if (!await panel.isVisible()) await page.getByRole("button", { name: "版本与来源" }).filter({ visible: true }).first().click();
      await panel.waitFor();
    };
    const panel = page.getByRole("region", { name: "文档版本、来源与关联" }).filter({ visible: true }).first();
    const go = (path: string) => page.evaluate(target => { const a = Object.assign(document.createElement("a"), { href: target }); document.body.append(a); a.click(); a.remove(); }, path);

    // The current revision: 第 2 版 / 共 2 版 in the header and in 版本.
    await heading(docs.rule.title).waitFor();
    await numbered("第 2 版 / 共 2 版");
    await openPanel();
    await panel.getByText(/第 2 版 \/ 共 2 版 · /).waitFor();
    // 全部版本: folded until opened, then every revision, newest first, the one on screen marked.
    const all = panel.locator("details").filter({ has: page.getByText(/^全部版本/) }).first();
    assert.equal(await all.getAttribute("open"), null, "全部版本 starts folded");
    await all.getByText("全部版本 · 2").click();
    const versions = all.getByRole("list", { name: "全部版本" });
    await versions.waitFor();
    assert.match(await versions.innerText(), /第 2 版 · 当前版 · 已发布[\s\S]*zhang-reviewer · 补充交付与验收的区分[\s\S]*正在读[\s\S]*第 1 版 · 历史版[\s\S]*建立对账规则/);
    await all.getByText("共 2 版，已列出 2 版，已读完。").waitFor();
    if (shots) await page.screenshot({ path: `${shots}/document-versions-1440.png`, fullPage: true });
    // A version opens on the read-only page of that version; the header says which of how many.
    await versions.getByRole("link", { name: /第 1 版/ }).click();
    await page.waitForURL(url => url.search.includes(docs.rule.oldRev));
    await numbered("第 1 版 / 共 2 版");
    await page.getByText("你在读固定的历史版本，当前版已更新。请核对任务实际采用的版本。").waitFor();
    assert.match(await all.getByRole("list", { name: "全部版本", includeHidden: true }).locator("[aria-current=page]").textContent() ?? "", /第 1 版[\s\S]*正在读/, "the version on screen is marked in the list");

    // An older document numbered by time: 第 1 版 of 3, the count from the list. A 第 4 版 is saved between two pages:
    // the newer one is on the first page, which is offered; the loaded ones are judged by the newest head.
    await go(`/p/${projectId}/documents/${docs.map.id}`);
    await heading(docs.map.title).waitFor();
    await numbered("第 1 版 / 共 3 版");
    await openPanel();
    const mapAll = panel.locator("details").filter({ has: page.getByText(/^全部版本/) }).first();
    await mapAll.getByText("全部版本 · 3").click();
    await mapAll.getByText("共 3 版，已列出 2 版。").waitFor();
    await mapAll.getByRole("button", { name: "列出更早的版本" }).click();
    await mapAll.getByText("文档在读取期间保存了新的版本，它们在第一页；上面的状态已按最新读回的文档重算。").waitFor();
    assert.match(await mapAll.getByRole("list", { name: "全部版本" }).innerText(), /第 3 版 · 历史版[\s\S]*第 2 版 · 历史版[\s\S]*第 1 版 · 已发布[\s\S]*正在读/,
      "第 1 版 is no longer called current: the newest head says 第 4 版 is");
    await mapAll.getByText("共 4 版，已列出 3 版。").waitFor();
    await mapAll.getByRole("button", { name: "回到第一页" }).click();
    await mapAll.getByText("共 4 版，已列出 2 版。").waitFor();
    assert.match(await mapAll.getByRole("list", { name: "全部版本" }).innerText(), /^第 4 版 · 当前版/);
    assert.equal(await mapAll.getByText(/文档在读取期间/).count(), 0);

    // A list that repeats a cursor stops there and says what was not read; it never says 已读完.
    await go(`/p/${projectId}/documents/${docs.discussion.id}`);
    await heading(docs.discussion.title).waitFor();
    await openPanel();
    const loopAll = panel.locator("details").filter({ has: page.getByText(/^全部版本/) }).first();
    await loopAll.getByText("全部版本 · 2").click();
    await loopAll.getByRole("button", { name: "列出更早的版本" }).click();
    await loopAll.getByText("读到重复的读取位置，后面的版本没读到。").waitFor();
    await loopAll.getByText("共 2 版，已列出 2 版。").waitFor();
    assert.equal(await loopAll.getByText(/已读完/).count(), 0);

    // A list that cannot be read: the number of the revision on screen only, never a count; the list says it failed.
    await go(`/p/${projectId}/documents/${docs.report.id}`);
    await heading(docs.report.title).waitFor();
    await numbered("第 1 版");
    await openPanel();
    const reportAll = panel.locator("details").filter({ has: page.getByText(/^全部版本/) }).first();
    await reportAll.getByText("全部版本", { exact: true }).click();
    await reportAll.getByText(/版本列表没有读回：.*读回之前无法判断有哪些版本/).waitFor();
    assert.doesNotMatch(await header.innerText(), /共/);

    // The other widths: at 1024 the right column is a drawer that stays closed until asked for; nothing overflows at 390.
    await go(`/p/${projectId}/documents/${docs.rule.id}`);
    await heading(docs.rule.title).waitFor();
    await page.setViewportSize({ width: 1024, height: 768 });
    await page.waitForTimeout(200);
    assert.equal(await page.getByRole("dialog").count(), 0, "the drawer does not open by itself");
    await page.getByRole("button", { name: "版本与来源" }).filter({ visible: true }).first().click();
    const drawer = page.getByRole("dialog");
    await drawer.getByText(/第 2 版 \/ 共 2 版 · /).waitFor();
    await drawer.getByText("全部版本 · 2").click();
    await drawer.getByRole("list", { name: "全部版本" }).waitFor();
    if (shots) await page.screenshot({ path: `${shots}/document-versions-1024.png`, fullPage: true });
    await page.keyboard.press("Escape");
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(200);
    await numbered("第 2 版 / 共 2 版");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1), true, "no horizontal overflow at 390px");
    if (shots) await page.screenshot({ path: `${shots}/document-versions-390.png`, fullPage: true });
    assert.deepEqual(errors, []);
  });
