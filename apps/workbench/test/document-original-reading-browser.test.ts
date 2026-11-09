// Opt-in built-app regression: build workbench, then set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE.
// Documents whose text lives only in the fixed original (an uploaded file, an import): Markdown is read from that
// original, an HTML original that cannot be read still leaves 修订与发布, and a write never downloads a fixed revision
// or an original again. Also: focus on return from the inner rail, row highlight on hover, and the asset list of the
// task page's revision comparison. All data is synthetic.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const modulePath = process.env.EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE;
const shots = process.env.EVOLOOP_DOCUMENT_SCREENSHOT_DIR;
const dist = resolve(import.meta.dirname, "../dist");
const id = (n: number) => `44000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const projectId = id(1), mdDoc = id(2), mdRev = id(3), htmlDoc = id(4), htmlRev = id(5), htmlOld = id(6), inlineDoc = id(7), inlineRev = id(8);
const taskId = id(9), impactId = id(10);
const stamp = "2026-11-09T08:00:00.000Z";
const markdown = ["# 上传的 Markdown 方案", "", "从原件读出的完整正文。", "",
  ...["第一节 背景", "第二节 方案", "第三节 结论"].flatMap((heading, index) => [`## ${heading}`, "", `${"这一节的正文较长，用来确认原件里的段落都能读到。".repeat(6)}`, "",
    ...(index === 1 ? ["| 项目 | 说明 |", "| --- | --- |", "| 原件 | 上传时保存 |", ""] : [])]),
  "原件末段：读到这里说明正文完整。"].join("\n");
const longCss = ".report-row{color:#123456;background:#fafafa}".repeat(120);
const css = Buffer.from(longCss).toString("base64");
const html = `<!doctype html><html><head><link rel="stylesheet" href="assets/report.css"></head><body><h2>REPORT-FIRST</h2><p class="report-row">报告正文</p></body></html>`;
const revision = (documentId: string, revisionId: string, format: "markdown" | "html", body: string | null, previous: string | null = null) => ({
  projectId, documentId, id: revisionId, previousRevisionId: previous, format, mediaType: format === "html" ? "text/html" : "text/markdown",
  originalName: format === "html" ? "report.html" : "plan.md", body, payloadRef: body === null ? revisionId : null, contentHash: "a".repeat(64),
  entrypoint: format === "html" ? "report.html" : null,
  assetsManifest: format === "html" ? [{ path: "assets/report.css", blobId: revisionId, contentHash: "c".repeat(64), size: longCss.length, mediaType: "text/css" }] : [],
  author: "fixture", actorId: "fixture", reason: "上传原件", createdAt: stamp });
const revisions: Record<string, ReturnType<typeof revision>> = {
  [mdRev]: revision(mdDoc, mdRev, "markdown", null),
  [htmlRev]: revision(htmlDoc, htmlRev, "html", null, htmlOld),
  [htmlOld]: revision(htmlDoc, htmlOld, "html", null),
  [inlineRev]: revision(inlineDoc, inlineRev, "markdown", "# 内联方案\n\n内联正文。"),
};
const document = (documentId: string, title: string, kind: string, current: string) => ({ projectId, id: documentId, version: 2, title, kind,
  status: "draft", currentRevisionId: current, adoptedRevisionId: null, primaryTaskId: null, origin: null });
const documents = [document(mdDoc, "上传的 Markdown 方案", "spec", mdRev), document(htmlDoc, "上传的 HTML 报告", "report", htmlRev),
  document(inlineDoc, "内联方案", "spec", inlineRev)];
const task = { projectId, id: taskId, version: 2, currentRevisionId: taskId, title: "依据有新版的任务", content: "正文", contentDocumentId: inlineDoc,
  contentRevisionId: inlineRev, kind: "implementation", acceptance: "核对依据", owner: "developer", state: "in_progress", basisSetId: null,
  actorId: "developer", reason: "创建", createdAt: stamp };

type HtmlMode = "available" | "hold" | "fail" | "unavailable";

async function startFixture(t: { after(fn: () => unknown): void }) {
  const { chromium } = (await import(pathToFileURL(modulePath!).href)).default;
  const reads = new Map<string, number>();
  const count = (name: string) => reads.set(name, (reads.get(name) ?? 0) + 1);
  const fixture = { htmlMode: "available" as HtmlMode, release: null as (() => void) | null, commands: 0, reads };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, "http://127.0.0.1");
    const p = `/api/projects/${projectId}`;
    const send = (value: unknown, status = 200) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
    if (url.pathname.startsWith("/api/")) {
      if (url.pathname === "/api/session") return send({ principal: { actorId: "fixture", projectIds: [projectId], permissions: ["read", "write", "review"] }, capabilities: {} });
      if (url.pathname === "/api/commands" && req.method === "POST") {
        let body = ""; for await (const chunk of req) body += chunk;
        const command = JSON.parse(body) as { operationId: string; documentId?: string };
        fixture.commands++;
        return send({ status: "applied", operationId: command.operationId, entityId: command.documentId ?? projectId, version: 3 });
      }
      if (url.pathname === p) return send({ id: projectId, title: "原件阅读项目", createdAt: stamp });
      if (url.pathname === `${p}/documents`) return send({ items: documents, nextCursor: null });
      if (url.pathname === `${p}/work-management/index`) return send({ items: [], nextCursor: null, total: 0, counts: {}, changeSequence: 0, observedAt: stamp, partial: false });
      const match = /^\/documents\/([^/]+)(?:\/revisions\/([^/]+)(\/original)?)?(\/tasks)?$/.exec(url.pathname.slice(p.length));
      if (match) {
        const [, documentId, revisionId, original, tasks] = match;
        const doc = documents.find(item => item.id === documentId);
        if (!doc) return send({ message: "document absent" }, 404);
        if (tasks) return send({ items: [], nextCursor: null });
        if (!revisionId) {
          count(`detail:${documentId}`);
          const current = revisions[doc.currentRevisionId]!;
          return send({ document: doc, current, adopted: null });
        }
        const fixed = revisions[revisionId];
        if (!fixed || fixed.documentId !== documentId) return send({ message: "revision absent" }, 404);
        if (!original) { count(`revision:${revisionId}`); return send(fixed); }
        count(`original:${revisionId}`);
        if (revisionId === htmlRev && fixture.htmlMode === "hold") await new Promise<void>(done => { fixture.release = done; });
        if (revisionId === htmlRev && fixture.htmlMode === "fail") return send({ message: "原件存储暂时不可达" }, 503);
        if (revisionId === htmlRev && fixture.htmlMode === "unavailable") return send({ status: "unavailable", revision: fixed, reason: "payload missing" });
        if (fixed.format === "markdown") return send({ status: "available", revision: fixed, body: markdown, assets: [] });
        return send({ status: "available", revision: fixed, body: html.replace("REPORT-FIRST", revisionId === htmlOld ? "OLD-FIRST" : "REPORT-FIRST"),
          assets: [{ path: "assets/report.css", mediaType: "text/css", base64: css }] });
      }
      if (url.pathname === `${p}/tasks/${taskId}`) return send({ task, revision: { ...task, taskId, id: taskId }, basis: null, links: [],
        impacts: [{ projectId, id: impactId, taskId, taskRevisionId: taskId, documentId: htmlDoc, fromRevisionId: htmlOld, toRevisionId: htmlRev,
          state: "pending", decisionId: null, createdAt: stamp }], decisions: [], deliveries: [], observations: [], closures: [] });
      if (url.pathname === `${p}/impacts` || url.pathname === `${p}/runtime/runs` || url.pathname === `${p}/runtime/sessions`
        || url.pathname.startsWith(`${p}/references/`)) return send([]);
      if (url.pathname === `${p}/runtime`) return send({ available: false, error: null, allowedCwds: [], grants: [] });
      if (url.pathname === `${p}/orchestration/work-status`) return send({ items: url.searchParams.get("taskIds")?.split(",").map(taskId => ({ taskId })) ?? [] });
      return send({ items: [], nextCursor: null });
    }
    const file = join(dist, /^\/(?:$|p\/|ui$)/.test(url.pathname) ? "index.html" : url.pathname);
    try { const body = await readFile(file); res.writeHead(200, { "content-type": ({ ".html": "text/html", ".js": "text/javascript", ".css": "text/css" } as Record<string, string>)[extname(file)] ?? "application/octet-stream" }); res.end(body); }
    catch { res.writeHead(404); res.end(); }
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const browser = await chromium.launch({ headless: true, ...(process.env.EVOLOOP_BROWSER_TEST_EXECUTABLE_PATH
    ? { executablePath: process.env.EVOLOOP_BROWSER_TEST_EXECUTABLE_PATH } : {}) });
  t.after(async () => { fixture.release?.(); await browser.close(); await new Promise<void>(done => server.close(() => done())); });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const open = async (path: string, viewport = { width: 1440, height: 900 }) => {
    const page = await browser.newPage({ viewport });
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(`${base}${path}`);
    await page.getByLabel("访问令牌").fill("fixture-token");
    await page.getByRole("button", { name: "进入", exact: true }).click();
    // In-app navigation, the way a link inside the workbench moves between pages (visited pages stay mounted).
    const go = (to: string) => page.evaluate(`(() => { const a = Object.assign(document.createElement("a"), { href: ${JSON.stringify(to)} }); document.body.append(a); a.click(); a.remove(); })()`);
    return { page, errors, go };
  };
  const settle = async () => {
    let last = "";
    for (let attempt = 0; attempt < 40; attempt++) {
      await new Promise(done => setTimeout(done, 150));
      const now = JSON.stringify([...reads]);
      if (now === last) return;
      last = now;
    }
  };
  return { fixture, open, settle, read: (name: string) => reads.get(name) ?? 0 };
}

const route = (documentId: string, revisionId?: string) => `/p/${projectId}/documents/${documentId}${revisionId ? `?revision=${revisionId}` : ""}`;

test("an uploaded Markdown document is read in full from its original, with its outline, at 1440 and 390", {
  skip: !modulePath && "Set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE",
}, async t => {
  const { open, read } = await startFixture(t);
  const { page, errors } = await open(route(mdDoc));
  await page.getByRole("heading", { name: "上传的 Markdown 方案", level: 1 }).waitFor();
  const body = page.getByRole("region", { name: "文档完整正文" });
  await body.getByRole("heading", { name: "第三节 结论" }).waitFor();
  assert.match(await body.innerText(), /从原件读出的完整正文[\s\S]*第二节 方案[\s\S]*原件[\s\S]*上传时保存[\s\S]*原件末段：读到这里说明正文完整/);
  assert.equal(await page.getByText("这一版没有可读的正文").count(), 0);
  const facts = page.getByRole("region", { name: "文档版本、来源与关联" });
  if (!await facts.isVisible()) await page.getByRole("button", { name: "版本与来源" }).click();
  const outline = facts.getByRole("navigation", { name: "页内目录" });
  await outline.getByRole("button", { name: "第三节 结论" }).waitFor();
  assert.deepEqual(await outline.getByRole("button").allInnerTexts(), ["第一节 背景", "第二节 方案", "第三节 结论"]);
  await outline.getByRole("button", { name: "第三节 结论" }).click();
  await page.waitForFunction("document.activeElement?.textContent === '第三节 结论'");
  if (shots) {
    await page.evaluate(() => scrollTo(0, 0));
    await page.screenshot({ path: `${shots}/document-uploaded-markdown-1440x900.png` });
  }
  await page.getByRole("tab", { name: "原文" }).click();
  assert.match(await body.locator("pre").innerText(), /^# 上传的 Markdown 方案\n[\s\S]*## 第二节 方案[\s\S]*\| 原件 \| 上传时保存 \|/);
  await page.getByRole("tab", { name: "排版" }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await body.getByRole("heading", { name: "第一节 背景" }).waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "no sideways scroll at 390");
  if (shots) {
    await page.evaluate(() => scrollTo(0, 0));
    await page.screenshot({ path: `${shots}/document-uploaded-markdown-390x844.png` });
  }
  assert.equal(read(`original:${mdRev}`), 1, "the original is read once");
  assert.deepEqual(errors, []);
});

test("an HTML original that is loading, failing or unusable keeps 修订与发布", {
  skip: !modulePath && "Set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE",
}, async t => {
  const { fixture, open } = await startFixture(t);
  fixture.htmlMode = "hold";
  const { page, errors } = await open(route(htmlDoc));
  const reader = page.getByRole("region", { name: "文档完整正文" }).last();
  // In an HTML report 修订与发布 is the last fold under the frame, inside the reading region.
  const revise = reader.getByText("修订与发布", { exact: true });
  await page.getByRole("heading", { name: "上传的 HTML 报告", level: 1 }).waitFor();
  await reader.getByText("正在读取原件及其资源").waitFor({ state: "attached" });
  await revise.waitFor();

  fixture.htmlMode = "fail";
  fixture.release?.();
  await reader.getByText("原件没有读回").waitFor({ timeout: 15000 });
  assert.match(await reader.innerText(), /原件存储暂时不可达/);
  await revise.waitFor();
  if (shots) await page.screenshot({ path: `${shots}/document-html-original-failed-1440x900.png` });

  fixture.htmlMode = "unavailable";
  await reader.getByRole("button", { name: "重试读取" }).click();
  await reader.getByText("原件暂时不能完整读取").waitFor();
  assert.match(await reader.innerText(), /payload missing/);
  await revise.waitFor();
  await revise.click();
  await reader.getByText("归档文档", { exact: true }).first().waitFor();

  fixture.htmlMode = "available";
  await reader.getByRole("button", { name: "重新核对" }).click();
  const frame = reader.locator("iframe[data-report-frame]");
  await frame.waitFor();
  assert.equal(await frame.getAttribute("sandbox"), "");
  await revise.waitFor();
  assert.deepEqual(errors, []);
});

test("a write rereads the current versions once and never a visited fixed revision or original", {
  skip: !modulePath && "Set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE",
}, async t => {
  const { fixture, open, settle, read } = await startFixture(t);
  // Three visited pages stay mounted: an inline Markdown document, a fixed historical HTML revision, and the
  // current HTML report, where the write is made.
  const { page, errors, go } = await open(route(inlineDoc));
  await page.getByRole("heading", { name: "内联方案", level: 1 }).waitFor();
  await go(route(htmlDoc, htmlOld));
  await page.getByText(/你在读固定的历史版本/).waitFor();
  await page.locator("iframe[data-report-frame]").last().waitFor();
  await go(route(htmlDoc));
  const reader = page.getByRole("region", { name: "文档完整正文" }).last();
  const revise = reader.getByText("修订与发布", { exact: true });
  await reader.locator("iframe[data-report-frame]").waitFor();
  await settle();
  const before = {
    htmlDetail: read(`detail:${htmlDoc}`), inlineDetail: read(`detail:${inlineDoc}`), htmlOriginal: read(`original:${htmlRev}`),
    oldOriginal: read(`original:${htmlOld}`), oldRevision: read(`revision:${htmlOld}`),
  };
  const aborted: string[] = [];
  page.on("requestfailed", request => aborted.push(request.url()));
  if (!await revise.evaluate(el => (el.parentElement as HTMLDetailsElement).open)) await revise.click();
  const archive = reader.locator("details.command-disclosure").filter({ has: page.locator("summary", { hasText: "归档文档" }) });
  if (!await archive.locator("textarea").isVisible()) await archive.locator("summary").click();
  await archive.locator("textarea").fill("夹具：确认写入后不重读固定内容");
  await archive.locator("button[type=submit]").click();
  for (let attempt = 0; attempt < 40 && (fixture.commands < 1 || read(`detail:${htmlDoc}`) === before.htmlDetail); attempt++)
    await new Promise(done => setTimeout(done, 100));
  await settle();
  const after = {
    htmlDetail: read(`detail:${htmlDoc}`), inlineDetail: read(`detail:${inlineDoc}`), htmlOriginal: read(`original:${htmlRev}`),
    oldOriginal: read(`original:${htmlOld}`), oldRevision: read(`revision:${htmlOld}`),
  };
  assert.equal(fixture.commands, 1);
  assert.deepEqual(after, { ...before, htmlDetail: before.htmlDetail + 1, inlineDetail: before.inlineDetail + 1 },
    `the current versions reread once; fixed revisions and originals are not read again: ${JSON.stringify({ before, after })}`);
  assert.deepEqual(aborted.filter(url => url.includes("/documents/")), [], "no read is cancelled and sent again");
  assert.deepEqual(errors, []);
});

test("focus returns to the row opened from the table or the inner rail, and its highlight survives hover", {
  skip: !modulePath && "Set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE",
}, async t => {
  const { open } = await startFixture(t);
  const { page, errors } = await open(`/p/${projectId}/documents`);
  const table = page.getByRole("table");
  await table.getByRole("link", { name: "内联方案" }).waitFor();
  const back = () => page.locator(".document-reading-backlinks").getByRole("link", { name: /返回来源/ }).click();
  await table.getByRole("link", { name: "内联方案" }).click();
  await page.getByRole("heading", { name: "内联方案", level: 1 }).waitFor();
  await back();
  await page.waitForFunction("document.activeElement?.textContent === '内联方案'");
  const rail = page.getByRole("region", { name: "文档列表" }).first();
  await rail.getByRole("link", { name: /上传的 Markdown 方案/ }).click();
  await page.getByRole("heading", { name: "上传的 Markdown 方案", level: 1 }).waitFor();
  await back();
  await page.waitForFunction("document.activeElement?.textContent === '上传的 Markdown 方案'", undefined, { timeout: 5000 }).catch(async () =>
    assert.fail(`focus stayed on ${await page.evaluate(() => document.activeElement?.textContent)}`));

  const row = (title: string) => table.getByRole("row").filter({ has: page.getByRole("link", { name: title, exact: true }) });
  const background = (title: string) => row(title).evaluate(el => getComputedStyle(el).backgroundColor);
  const highlighted = await background("上传的 Markdown 方案");
  assert.notEqual(highlighted, "rgba(0, 0, 0, 0)", "the row last opened is highlighted");
  await row("上传的 Markdown 方案").hover();
  assert.equal(await background("上传的 Markdown 方案"), highlighted, "hover keeps the token highlight");
  await row("上传的 HTML 报告").hover();
  assert.equal(await background("上传的 HTML 报告"), "rgba(0, 0, 0, 0)", "the old hover colour stays out of the new table");
  // Outside [data-ui] the old rules still apply: an old-style table and fact list keep their look.
  await page.evaluate(() => document.body.insertAdjacentHTML("beforeend", `<div id="legacy-probe"><table><tbody><tr><td>旧表格</td></tr></tbody></table>
    <dl><div><dt>旧事实</dt><dd>值</dd></div></dl></div><div data-ui="" id="ui-probe"><dl><div class="grid gap-1"><dt>新事实</dt><dd>值</dd></div></dl></div>`));
  await page.locator("#legacy-probe td").hover();
  assert.equal(await page.locator("#legacy-probe tr").evaluate(el => getComputedStyle(el).backgroundColor), "rgb(250, 251, 249)");
  assert.match(await page.locator("#legacy-probe dl > div").evaluate(el => getComputedStyle(el).gridTemplateColumns), /^170px /);
  const fact = await page.locator("#ui-probe dl > div").evaluate(el => ({ columns: getComputedStyle(el).gridTemplateColumns, gap: getComputedStyle(el).rowGap }));
  assert.ok(!fact.columns.startsWith("170px") && fact.gap === "4px", `a fact row inside [data-ui] keeps its own grid: ${JSON.stringify(fact)}`);
  assert.deepEqual(errors, []);
});

test("the task page's revision comparison lists assets on tokens, and a long CSS preview wraps inside its own box", {
  skip: !modulePath && "Set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE",
}, async t => {
  const { open } = await startFixture(t);
  // Opened on the 依据与影响 tab through the address, so an early click cannot be undone while the page settles.
  const { page, errors } = await open(`/p/${projectId}/tasks/${taskId}?tab=basis`);
  await page.getByRole("tab", { name: /依据与影响/, selected: true }).waitFor();
  const compare = page.locator("[data-impact-compare]");
  await compare.getByRole("heading", { name: /配套资源 · 1 项/ }).nth(1).waitFor({ timeout: 30000 }).catch(async cause =>
    assert.fail(`${String(cause).split("\n")[0]}; compare=${await compare.count() ? (await compare.first().innerText()).slice(0, 600) : "absent"}; `
      + `panel=${(await page.locator("[role=tabpanel]:not([hidden])").first().innerText().catch(() => "")).slice(0, 400)}; errors=${JSON.stringify(errors)}`));
  const item = compare.locator("li").filter({ hasText: "assets/report.css" }).nth(1);
  const layout = await item.evaluate(el => ({ display: getComputedStyle(el).display, wrap: getComputedStyle(el).flexWrap,
    border: getComputedStyle(el).borderTopWidth, list: getComputedStyle(el.parentElement!).listStyleType }));
  assert.deepEqual(layout, { display: "flex", wrap: "wrap", border: "1px", list: "none" });
  await item.getByRole("button", { name: "预览" }).click();
  const preview = item.locator("[data-asset-preview]");
  await preview.waitFor();
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    // The shell switches to its narrow layout on the resize event; measure once two frames have been drawn.
    await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(() => done(null)))));
    const box = await preview.evaluate(el => {
      const pre = el.querySelector("pre")!;
      const style = getComputedStyle(pre);
      // The old task page may give the <pre> its own height limit; either box may be the one that scrolls.
      return { height: Math.round(el.getBoundingClientRect().height),
        scrollable: el.scrollHeight > el.clientHeight || pre.scrollHeight > pre.clientHeight,
        sideways: Math.max(el.scrollWidth - el.clientWidth, pre.scrollWidth - pre.clientWidth), whiteSpace: style.whiteSpace, wrap: style.overflowWrap,
        fullRow: Math.abs(el.getBoundingClientRect().width - el.parentElement!.getBoundingClientRect().width) <= 1,
        page: document.documentElement.scrollWidth - innerWidth };
    });
    assert.ok(box.height <= 440 && box.scrollable && box.sideways <= 1 && box.whiteSpace === "pre-wrap" && box.wrap === "anywhere"
      && box.fullRow && box.page <= 1, `${width}: CSS preview stays in its box: ${JSON.stringify(box)}`);
    if (shots) await preview.screenshot({ path: `${shots}/task-asset-preview-${width}.png` });
  }
  assert.deepEqual(errors, []);
});
