// Opt-in regression against the built workbench. The HTML and image are synthetic and self-contained.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { mkdir, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";

const modulePath = process.env.EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE;
const dist = resolve(process.env.EVOLOOP_BROWSER_TEST_DIST ?? resolve(import.meta.dirname, "../dist"));
// The private source is never copied into Git. Set both variables to retain private screenshots and geometry.
const realSource = process.env.EVOLOOP_HTML_READING_ORIGINAL_SOURCE;
const realArtifactDir = process.env.EVOLOOP_HTML_READING_ARTIFACT_DIR;
const projectId = "99000001-0000-4000-8000-000000000001";
const documentId = "99000002-0000-4000-8000-000000000002";
const fixedId = "99000003-0000-4000-8000-000000000003";
const currentId = "99000004-0000-4000-8000-000000000004";
const stamp = "2026-11-02T00:00:00.000Z";
const returnHash = `/p/${projectId}/documents`;
const fixedRoute = `/p/${projectId}/documents/${documentId}?revision=${fixedId}&return=${encodeURIComponent(returnHash)}`;
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lXcAAAAASUVORK5CYII=";
const html = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><style>
  body{margin:0;padding:28px;font:17px/1.7 sans-serif;color:#172b53} section{min-height:680px}
  h2{margin:0 0 20px} img{display:block;width:240px;height:140px;object-fit:cover}
  </style></head><body><section id="first"><h2>FIXED-FIRST</h2><p>完整 HTML 阅读起点</p></section>
  <section id="middle"><h2>FIXED-MIDDLE</h2><img id="report-image" src="assets/chart.png" alt="报告图表"></section>
  <section id="last"><h2>FIXED-LAST</h2><p>完整 HTML 阅读终点</p></section></body></html>`;
const revision = (id: string, version: number, body: string) => ({ projectId, documentId, id, version,
  previousRevisionId: version === 1 ? null : fixedId, format: "html", mediaType: "text/html", originalName: "report.html",
  body: null, payloadRef: id, contentHash: (version === 1 ? "a" : "b").repeat(64), entrypoint: "report.html",
  assetsManifest: [{ path: "assets/chart.png", blobId: id, contentHash: "c".repeat(64), size: 68, mediaType: "image/png" }],
  author: "fixture", actorId: "fixture", reason: "HTML 阅读回归", createdAt: stamp, fixtureBody: body });
const fixed = revision(fixedId, 1, html);
const current = revision(currentId, 2, html.replaceAll("FIXED-", "CURRENT-"));
const document = { projectId, id: documentId, version: 2, title: "长 HTML 报告", kind: "report", status: "published",
  currentRevisionId: currentId, adoptedRevisionId: currentId, primaryTaskId: null, origin: null };

test("built HTML Document uses the available reading space and keeps fixed revision, image, and controls usable", {
  skip: !modulePath && "Set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE",
}, async t => {
  const { chromium } = (await import(pathToFileURL(modulePath!).href)).default;
  const reads: string[] = [];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname.startsWith("/api/")) {
      const root = `/api/projects/${projectId}`;
      let value: unknown = { items: [], nextCursor: null }, status = 200;
      if (url.pathname === "/api/session") value = { principal: { actorId: "fixture", projectIds: [projectId], permissions: ["read"] }, capabilities: {} };
      else if (url.pathname === root) value = { id: projectId, title: "HTML 阅读测试", createdAt: stamp };
      else if (url.pathname === `${root}/documents/${documentId}`) value = { document, current, adopted: current };
      else if (url.pathname === `${root}/documents/${documentId}/tasks`) value = { items: [], nextCursor: null };
      else if (url.pathname === `${root}/documents`) value = { items: [], nextCursor: null, total: 0 };
      else if (url.pathname.startsWith(`${root}/documents/${documentId}/revisions/`)) {
        const id = url.pathname.split("/")[7];
        reads.push(`${id}${url.pathname.endsWith("/original") ? ":original" : ""}`);
        const selected = id === fixedId ? fixed : id === currentId ? current : null;
        if (!selected) { status = 404; value = { message: "revision absent" }; }
        else if (url.pathname.endsWith("/original")) value = { status: "available", revision: selected,
          body: selected.fixtureBody, assets: [{ path: "assets/chart.png", mediaType: "image/png", base64: png }] };
        else value = selected;
      }
      else if (url.pathname === `${root}/runtime`) value = { available: false, error: null, allowedCwds: [], grants: [] };
      else if (url.pathname === `${root}/runtime/runs` || url.pathname === `${root}/runtime/sessions` || url.pathname.startsWith(`${root}/references/`)) value = [];
      else if (url.pathname === `${root}/orchestration/work-status`) value = { items: [] };
      res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); return;
    }
    const file = join(dist, /^\/(?:$|p\/|ui$)/.test(url.pathname) ? "index.html" : url.pathname);
    try { const body = await readFile(file); res.writeHead(200, { "content-type": ({ ".html": "text/html", ".js": "text/javascript", ".css": "text/css" } as Record<string, string>)[extname(file)] ?? "application/octet-stream" }); res.end(body); }
    catch { res.writeHead(404); res.end(); }
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const browser = await chromium.launch({ headless: true, ...(process.env.EVOLOOP_BROWSER_TEST_EXECUTABLE_PATH
    ? { executablePath: process.env.EVOLOOP_BROWSER_TEST_EXECUTABLE_PATH } : {}) });
  t.after(async () => { await browser.close(); await new Promise<void>(done => server.close(() => done())); });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const page = await browser.newPage({ viewport: { width: 1201, height: 819 } });
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(`${base}${fixedRoute}`);
  await page.getByLabel("访问令牌").fill("fixture-token");
  await page.getByRole("button", { name: "进入", exact: true }).click();
  await page.getByRole("heading", { name: document.title, exact: true }).waitFor();
  const iframe = page.locator(".doc-html-frame");
  await iframe.waitFor();
  const frame = await iframe.contentFrame();
  assert.ok(frame, "sandboxed HTML frame is present");
  await frame.locator("#last").waitFor();
  assert.equal(await frame.locator("#first h2").innerText(), "FIXED-FIRST");
  assert.equal(await frame.locator("#middle h2").innerText(), "FIXED-MIDDLE");
  assert.equal(await frame.locator("#last h2").innerText(), "FIXED-LAST");
  assert.equal(await frame.locator("#report-image").evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0), true);
  assert.equal(await page.getByText("所读为固定历史版").count() > 0, true);
  assert.equal(await frame.locator("body").getByText("CURRENT-FIRST").count(), 0);

  const geometryFailures: string[] = [];
  for (const width of [1201, 1920, 1179, 1181, 390]) {
    const height = width === 1920 ? 1200 : width === 390 ? 844 : 819;
    await page.setViewportSize({ width, height });
    const box = await iframe.evaluate((element: HTMLIFrameElement) => {
      const rect = element.getBoundingClientRect();
      const main = document.querySelector(".document-read-main")!.getBoundingClientRect();
      const layout = document.querySelector(".document-read-layout")!.getBoundingClientRect();
      const page = document.querySelector(".document-reading-page")!.getBoundingClientRect();
      let visibleBottom = Math.min(rect.bottom, innerHeight), visibleTop = Math.max(rect.top, 0);
      let ancestorBottom = Infinity;
      const clippers: Array<{ name: string; bottom: number; overflow: string }> = [];
      for (let parent = element.parentElement; parent; parent = parent.parentElement) {
        const style = getComputedStyle(parent);
        if ([style.overflowY, style.overflow].some(value => value === "hidden" || value === "clip" || value === "auto" || value === "scroll")) {
          const bound = parent.getBoundingClientRect();
          visibleBottom = Math.min(visibleBottom, bound.bottom);
          visibleTop = Math.max(visibleTop, bound.top);
          ancestorBottom = Math.min(ancestorBottom, bound.bottom);
          clippers.push({ name: parent.className, bottom: Math.round(bound.bottom), overflow: style.overflowY });
        }
      }
      return { frameHeight: Math.round(rect.height), frameBottom: Math.round(rect.bottom), mainHeight: Math.round(main.height),
        mainBottom: Math.round(main.bottom), layoutHeight: Math.round(layout.height), pageBottom: Math.round(page.bottom),
        visibleHeight: Math.round(Math.max(0, visibleBottom - visibleTop)), clipped: Math.round(Math.max(0, rect.bottom - ancestorBottom)),
        viewportGap: Math.round(innerHeight - Math.min(rect.bottom, innerHeight)), clippers };
    });
    console.log(`HTML reading ${width}x${height}: ${JSON.stringify(box)}`);
    if (width > 1180) {
      if (box.frameHeight < height * 0.42) geometryFailures.push(`${width}: iframe too short (${box.frameHeight}px)`);
      if (box.viewportGap > 110) geometryFailures.push(`${width}: ${box.viewportGap}px unused viewport below iframe`);
      if (box.clipped > 2) geometryFailures.push(`${width}: ${box.clipped}px iframe clipped by ancestor`);
      if (box.mainHeight + 2 < box.frameHeight) geometryFailures.push(`${width}: main ${box.mainHeight}px shorter than frame ${box.frameHeight}px`);
    } else {
      if (box.frameHeight < height * 0.42) geometryFailures.push(`${width}: narrow iframe too short (${box.frameHeight}px)`);
      if (box.clipped > 2 && box.frameBottom <= height) geometryFailures.push(`${width}: narrow iframe clipped by ancestor (${box.clipped}px)`);
    }
    if (width === 1181) assert.equal(await page.locator(".document-read-layout").evaluate(el => getComputedStyle(el).display), "grid");
  }

  // A short phone window must preserve a usable iframe and let the outer page reach content below it.
  await page.setViewportSize({ width: 390, height: 560 });
  const short = await iframe.evaluate(el => ({ frame: Math.round(el.getBoundingClientRect().height),
    main: Math.round(document.querySelector(".document-read-main")!.getBoundingClientRect().height),
    outerScroll: document.scrollingElement!.scrollHeight - innerHeight,
    overflow: getComputedStyle(document.querySelector(".document-reading-page")!).overflowY }));
  assert.ok(short.main >= 220 && short.frame >= 150, `short phone reader stays usable: ${JSON.stringify(short)}`);
  assert.ok(short.outerScroll > 0 && short.overflow === "visible", `short phone page can scroll: ${JSON.stringify(short)}`);
  await page.evaluate(() => scrollTo(0, document.scrollingElement!.scrollHeight));
  assert.ok(await page.evaluate(() => scrollY) > 0, "short phone outer page reaches its bottom");
  await page.evaluate(() => scrollTo(0, 0));

  // At 900px the evidence rail overlays a single reading column and scrolls independently.
  await page.setViewportSize({ width: 900, height: 560 });
  await page.getByRole("button", { name: "查看版本与来源" }).click();
  const narrowAside = await page.locator(".document-read-aside").evaluate(el => {
    const layout = document.querySelector(".document-read-layout")!;
    const layoutBox = layout.getBoundingClientRect(), asideBox = el.getBoundingClientRect();
    el.scrollTop = el.scrollHeight;
    return { columns: getComputedStyle(layout).gridTemplateColumns, position: getComputedStyle(el).position,
      layoutWidth: Math.round(layoutBox.width), asideWidth: Math.round(asideBox.width),
      asideHeight: Math.round(asideBox.height), layoutHeight: Math.round(layoutBox.height),
      scrollTop: el.scrollTop, scrollable: el.scrollHeight - el.clientHeight };
  });
  assert.equal(narrowAside.position, "absolute");
  assert.equal(narrowAside.columns.trim().split(/\s+/).length, 1, `900px reader uses one column: ${JSON.stringify(narrowAside)}`);
  assert.ok(narrowAside.asideWidth <= narrowAside.layoutWidth && narrowAside.asideHeight <= narrowAside.layoutHeight + 2,
    `900px rail fits its overlay: ${JSON.stringify(narrowAside)}`);
  assert.ok(narrowAside.scrollable > 0 && narrowAside.scrollTop > 0, `900px rail scrolls: ${JSON.stringify(narrowAside)}`);
  await page.getByRole("button", { name: "收起版本与来源" }).click();

  // Reading happens inside the same fixed, isolated frame at the first, middle, image, and last sections.
  await page.setViewportSize({ width: 1201, height: 819 });
  const scroll = async (id: string) => {
    await frame.locator(`#${id}`).evaluate(el => el.scrollIntoView({ block: "start" }));
    return frame.locator("body").evaluate(() => ({ y: scrollY, max: document.documentElement.scrollHeight - innerHeight }));
  };
  const first = await scroll("first"), middle = await scroll("middle"), last = await scroll("last");
  assert.ok(middle.y > first.y + 300, `middle moves inside iframe: ${JSON.stringify({ first, middle })}`);
  assert.ok(last.y > middle.y + 300, `last section is reachable inside iframe: ${JSON.stringify({ middle, last })}`);
  await frame.locator("body").evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
  const end = await frame.locator("#last").evaluate(el => ({ visible: el.getBoundingClientRect().bottom > 0 && el.getBoundingClientRect().top < innerHeight,
    y: scrollY, max: document.documentElement.scrollHeight - innerHeight }));
  assert.ok(end.visible && end.y >= end.max - 5, `last section remains visible at scroll end: ${JSON.stringify(end)}`);
  await frame.locator("#report-image").evaluate(el => el.scrollIntoView({ block: "center" }));
  assert.equal(await frame.locator("#report-image").evaluate((image: HTMLImageElement) => image.getBoundingClientRect().bottom > 0 && image.getBoundingClientRect().top < innerHeight), true);

  const modernToggle = page.getByRole("button", { name: "查看版本与来源" });
  if (await modernToggle.count()) {
    await modernToggle.click();
    assert.equal(await page.getByRole("button", { name: "收起版本与来源" }).getAttribute("aria-expanded"), "true");
    assert.equal(await page.getByRole("complementary", { name: "文档版本、来源与关联" }).isVisible(), true);
    await page.getByRole("button", { name: "收起版本与来源" }).click();
    assert.equal(await page.getByRole("complementary", { name: "文档版本、来源与关联" }).isVisible(), false);
  } else {
    await page.getByRole("button", { name: "展开版本、来源与关联" }).click();
    assert.equal(await page.getByRole("button", { name: "收起版本、来源与关联" }).getAttribute("aria-expanded"), "true");
    assert.equal(await page.getByRole("complementary", { name: "文档版本、来源与关联" }).isVisible(), true);
    await page.getByRole("button", { name: "收起版本、来源与关联" }).click();
    assert.equal(await page.getByRole("complementary", { name: "文档版本、来源与关联" }).isVisible(), false);
  }
  await page.locator(".doc-continuous-secondary > summary").click();
  await page.locator(".doc-continuous-secondary .revision-body > summary").click();
  assert.equal(await page.locator(".doc-continuous-secondary .revision-body pre").isVisible(), true);
  assert.match(await page.locator(".doc-continuous-secondary .revision-body pre").innerText(), /FIXED-LAST/);
  assert.ok(reads.includes(fixedId) && reads.includes(`${fixedId}:original`) && !reads.includes(`${currentId}:original`), `fixed revision reads: ${reads.join(", ")}`);
  assert.deepEqual(errors, []);
  const back = page.locator(".document-reading-backlinks").getByRole("link", { name: /返回来源/ });
  assert.equal(await back.getAttribute("href"), returnHash);
  await back.click();
  assert.equal(await page.evaluate(() => (location.pathname + location.search)), returnHash);
  assert.deepEqual(geometryFailures, [], `reading geometry failures: ${geometryFailures.join("; ")}`);
});

test("optional real HTML original keeps all five images readable in the built fixed-revision viewer", {
  skip: !modulePath || !realSource ? "Set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE and EVOLOOP_HTML_READING_ORIGINAL_SOURCE" : false,
}, async t => {
  const source = resolve(realSource!);
  const output = realArtifactDir ? resolve(realArtifactDir) : null;
  if (output) assert.ok(output.startsWith("/private/tmp/"), "real-original evidence must stay under /private/tmp");
  const manifest = JSON.parse(await readFile(join(source, "manifest.json"), "utf8")) as {
    revision: { projectId: string; documentId: string; id: string; format: string; contentHash: string;
      assetsManifest: Array<{ path: string; contentHash: string; mediaType: string; size: number }> };
  };
  const original = await readFile(join(source, "report.html"));
  const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
  assert.equal(manifest.revision.format, "html");
  assert.equal(digest(original), manifest.revision.contentHash, "HTML bytes match the fixed source manifest");
  assert.equal(manifest.revision.assetsManifest.length, 5, "the real fixture includes all five images");
  const assets = await Promise.all(manifest.revision.assetsManifest.map(async asset => {
    assert.match(asset.path, /^assets\/[a-z0-9-]+\.png$/i, "read only a local fixture PNG");
    assert.equal(asset.mediaType, "image/png");
    const data = await readFile(join(source, asset.path));
    assert.equal(data.length, asset.size, `${asset.path} size`);
    assert.equal(digest(data), asset.contentHash, `${asset.path} hash`);
    return { path: asset.path, mediaType: asset.mediaType, base64: data.toString("base64") };
  }));
  const { projectId: realProjectId, documentId: realDocumentId, id: realRevisionId } = manifest.revision;
  const title = `实景 HTML 原件阅读回归：${"固定修订、完整报告、五张图片与窄屏连续阅读。".repeat(4)}`;
  const realDocument = { projectId: realProjectId, id: realDocumentId, version: 1, title, kind: "report", status: "published",
    currentRevisionId: realRevisionId, adoptedRevisionId: realRevisionId, primaryTaskId: null, origin: null };
  const reads: string[] = [];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname.startsWith("/api/")) {
      const root = `/api/projects/${realProjectId}`;
      let value: unknown = { items: [], nextCursor: null }, status = 200;
      if (url.pathname === "/api/session") value = { principal: { actorId: "fixture", projectIds: [realProjectId], permissions: ["read"] }, capabilities: {} };
      else if (url.pathname === root) value = { id: realProjectId, title: "实景原件测试", createdAt: stamp };
      else if (url.pathname === `${root}/documents/${realDocumentId}`) value = { document: realDocument, current: manifest.revision, adopted: manifest.revision };
      else if (url.pathname === `${root}/documents/${realDocumentId}/tasks`) value = { items: [], nextCursor: null };
      else if (url.pathname === `${root}/documents`) value = { items: [], nextCursor: null, total: 0 };
      else if (url.pathname === `${root}/documents/${realDocumentId}/revisions/${realRevisionId}`) {
        reads.push("revision"); value = manifest.revision;
      } else if (url.pathname === `${root}/documents/${realDocumentId}/revisions/${realRevisionId}/original`) {
        reads.push("original"); value = { status: "available", revision: manifest.revision, body: original.toString("utf8"), assets };
      } else if (url.pathname === `${root}/runtime`) value = { available: false, error: null, allowedCwds: [], grants: [] };
      else if (url.pathname === `${root}/runtime/runs` || url.pathname === `${root}/runtime/sessions` || url.pathname.startsWith(`${root}/references/`)) value = [];
      else if (url.pathname === `${root}/orchestration/work-status`) value = { items: [] };
      else { status = 404; value = { message: "fixture route absent" }; }
      res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); return;
    }
    const file = join(dist, /^\/(?:$|p\/|ui$)/.test(url.pathname) ? "index.html" : url.pathname);
    try { const body = await readFile(file); res.writeHead(200, { "content-type": ({ ".html": "text/html", ".js": "text/javascript", ".css": "text/css" } as Record<string, string>)[extname(file)] ?? "application/octet-stream" }); res.end(body); }
    catch { res.writeHead(404); res.end(); }
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const { chromium } = (await import(pathToFileURL(modulePath!).href)).default;
  const browser = await chromium.launch({ headless: true, ...(process.env.EVOLOOP_BROWSER_TEST_EXECUTABLE_PATH
    ? { executablePath: process.env.EVOLOOP_BROWSER_TEST_EXECUTABLE_PATH } : {}) });
  t.after(async () => { await browser.close(); await new Promise<void>(done => server.close(() => done())); });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const route = `/p/${realProjectId}/documents/${realDocumentId}?revision=${realRevisionId}`;
  const report: Array<Record<string, unknown>> = [];
  if (output) await mkdir(output, { recursive: true, mode: 0o700 });
  for (const [width, height] of [[1201, 819], [1920, 1200], [900, 560], [390, 560]]) {
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(`${base}${route}`);
    await page.getByLabel("访问令牌").fill("fixture-token");
    await page.getByRole("button", { name: "进入", exact: true }).click();
    await page.getByRole("heading", { name: title, exact: true }).waitFor();
    const iframe = page.locator(".doc-html-frame");
    await iframe.waitFor();
    const frame = await iframe.contentFrame();
    assert.ok(frame);
    await frame.locator("main section").last().waitFor();
    const geometry = await iframe.evaluate((element: HTMLIFrameElement) => {
      const rect = element.getBoundingClientRect();
      const main = document.querySelector(".document-read-main")!.getBoundingClientRect();
      const layout = document.querySelector(".document-read-layout")!.getBoundingClientRect();
      const readingPage = document.querySelector(".document-reading-page")!.getBoundingClientRect();
      const ancestors: Array<{ className: string; top: number; bottom: number; overflowY: string }> = [];
      let clipBottom = Infinity, clipTop = -Infinity;
      for (let parent = element.parentElement; parent; parent = parent.parentElement) {
        const style = getComputedStyle(parent);
        if ([style.overflowY, style.overflow].some(value => ["hidden", "clip", "auto", "scroll"].includes(value))) {
          const bound = parent.getBoundingClientRect();
          clipBottom = Math.min(clipBottom, bound.bottom);
          clipTop = Math.max(clipTop, bound.top);
          ancestors.push({ className: String(parent.className), top: Math.round(bound.top), bottom: Math.round(bound.bottom), overflowY: style.overflowY });
        }
      }
      return { viewport: { width: innerWidth, height: innerHeight }, iframe: { top: Math.round(rect.top), bottom: Math.round(rect.bottom), width: Math.round(rect.width), height: Math.round(rect.height) },
        main: { top: Math.round(main.top), bottom: Math.round(main.bottom), height: Math.round(main.height) },
        layout: { top: Math.round(layout.top), bottom: Math.round(layout.bottom), height: Math.round(layout.height) },
        readingPage: { top: Math.round(readingPage.top), bottom: Math.round(readingPage.bottom) },
        ancestorClippedBottom: Math.round(Math.max(0, rect.bottom - clipBottom)),
        ancestorClippedTop: Math.round(Math.max(0, clipTop - rect.top)),
        unusedViewportBelowIframe: Math.round(Math.max(0, innerHeight - rect.bottom)), ancestors };
    });
    const entry: Record<string, unknown> = { viewport: `${width}x${height}`, fixedRevision: realRevisionId,
      sourceSha256: manifest.revision.contentHash, geometry };
    report.push(entry);
    const saveReport = async () => {
      if (output) await writeFile(join(output, "geometry.json"), JSON.stringify({ source, dist, reads, report }, null, 2), { mode: 0o600 });
    };
    await saveReport();
    if (width === 390) {
      const outer = await page.evaluate(() => ({ scrollable: document.scrollingElement!.scrollHeight - innerHeight,
        overflow: getComputedStyle(document.querySelector(".document-reading-page")!).overflowY }));
      await page.evaluate(() => scrollTo(0, document.scrollingElement!.scrollHeight));
      const reached = await page.evaluate(() => scrollY);
      const readerFootAtBottom = await page.locator(".doc-continuous-secondary > summary").evaluate(el => {
        const box = el.getBoundingClientRect(); return box.top < innerHeight && box.bottom > 0;
      });
      Object.assign(entry, { outer: { ...outer, reached, readerFootAtBottom } });
      await saveReport();
      if (output) await page.screenshot({ path: join(output, "390x560-page-bottom.png") });
      assert.ok(geometry.main.height >= 220 && geometry.iframe.height >= 150,
        `short phone real report retains readable frame: ${JSON.stringify(geometry)}`);
      assert.ok(outer.overflow === "visible" && outer.scrollable > 0 && reached >= outer.scrollable - 1 && readerFootAtBottom,
        `short phone real report reaches the reader foot: ${JSON.stringify({ outer, reached, readerFootAtBottom })}`);
      await page.evaluate(() => scrollTo(0, 0));
    }
    if (width === 900) {
      await page.getByRole("button", { name: "查看版本与来源" }).click();
      const aside = await page.locator(".document-read-aside").evaluate(el => {
        const layout = document.querySelector(".document-read-layout")!;
        el.scrollTop = el.scrollHeight;
        return { columns: getComputedStyle(layout).gridTemplateColumns, position: getComputedStyle(el).position,
          layoutWidth: Math.round(layout.getBoundingClientRect().width), asideWidth: Math.round(el.getBoundingClientRect().width),
          layoutHeight: Math.round(layout.getBoundingClientRect().height), asideHeight: Math.round(el.getBoundingClientRect().height),
          scrollTop: el.scrollTop, scrollable: el.scrollHeight - el.clientHeight };
      });
      Object.assign(entry, { aside });
      await saveReport();
      if (output) await page.screenshot({ path: join(output, "900x560-aside.png") });
      assert.equal(aside.columns.trim().split(/\s+/).length, 1, `900px real reader has one column: ${JSON.stringify(aside)}`);
      assert.equal(aside.position, "absolute");
      assert.ok(aside.asideWidth <= aside.layoutWidth && aside.asideHeight <= aside.layoutHeight + 2 &&
        aside.scrollable > 0 && aside.scrollTop > 0, `900px real rail scrolls: ${JSON.stringify(aside)}`);
      await page.getByRole("button", { name: "收起版本与来源" }).click();
    }
    const images = frame.locator("img");
    assert.equal(await images.count(), 5);
    const decoded = await images.first().evaluate(async () => Promise.all(Array.from(document.images, async image => {
      await image.decode(); return { src: image.getAttribute("src")?.slice(0, 22), width: image.naturalWidth, height: image.naturalHeight };
    })));
    assert.ok(decoded.every(image => image.width > 0 && image.height > 0), `all five real images decode: ${JSON.stringify(decoded)}`);
    const scrollState = async () => frame.locator("body").evaluate(() => ({ y: scrollY, max: document.documentElement.scrollHeight - innerHeight }));
    const visible = async (selector: string) => frame.locator(selector).evaluate(el => {
      const box = el.getBoundingClientRect(); return box.bottom > 0 && box.top < innerHeight && box.right > 0 && box.left < innerWidth;
    });
    await frame.locator("body").evaluate(() => scrollTo(0, 0));
    const first = await scrollState();
    assert.equal(await visible("main h1"), true, "report opening is visible");
    if (output) await page.screenshot({ path: join(output, `${width}x${height}-first.png`) });
    await frame.locator("main section").nth(2).evaluate(el => el.scrollIntoView({ block: "start" }));
    const middle = await scrollState();
    assert.equal(await visible("main section:nth-of-type(3) h2"), true, "middle section is visible");
    if (output) await page.screenshot({ path: join(output, `${width}x${height}-middle.png`) });
    const imageScroll: Array<{ index: number; y: number; visible: boolean }> = [];
    for (let index = 0; index < 5; index++) {
      await images.nth(index).evaluate(el => el.scrollIntoView({ block: "center" }));
      const state = await scrollState();
      const inView = await images.nth(index).evaluate(el => {
        const box = el.getBoundingClientRect(); return box.bottom > 0 && box.top < innerHeight && box.right > 0 && box.left < innerWidth;
      });
      imageScroll.push({ index, y: state.y, visible: inView });
      assert.equal(inView, true, `image ${index + 1} appears while scrolling inside iframe`);
    }
    await frame.locator("body").evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
    const last = await scrollState();
    assert.equal(await visible("main section:last-of-type"), true, "report end is visible");
    if (output) await page.screenshot({ path: join(output, `${width}x${height}-last.png`) });
    Object.assign(entry, { first, middle, last, images: decoded, imageScroll });
    await saveReport();
    assert.ok(middle.y > first.y + 100 && last.y > middle.y + 100 && last.y >= last.max - 5,
      `real HTML scroll reaches middle and end: ${JSON.stringify({ first, middle, last })}`);
    assert.ok(geometry.iframe.height >= (width === 390 ? 150 : height * 0.42), `${width}: iframe too short: ${JSON.stringify(geometry)}`);
    if (height > 560) assert.ok(geometry.unusedViewportBelowIframe <= 110, `${width}: unused height: ${JSON.stringify(geometry)}`);
    assert.ok(geometry.ancestorClippedBottom <= 2 && geometry.ancestorClippedTop <= 2,
      `${width}: iframe clipped by ancestor: ${JSON.stringify(geometry)}`);
    assert.ok(geometry.main.height + 2 >= geometry.iframe.height, `${width}: reading main shorter than iframe: ${JSON.stringify(geometry)}`);
    assert.deepEqual(errors, []);
    console.log(`real HTML reading ${width}x${height}: ${JSON.stringify(geometry)}`);
    await page.close();
  }
  assert.ok(reads.filter(read => read === "revision").length >= 2 && reads.filter(read => read === "original").length >= 2,
    `both windows read the fixed revision and original: ${reads.join(", ")}`);
});
