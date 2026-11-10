// Opt-in built-app regression; EVOLOOP_BROWSER_TEST_DIST can select an isolated Vite output.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { timelinePage } from "./session-timeline-fixtures.ts";

const modulePath = process.env.EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE;
const dist = resolve(process.env.EVOLOOP_BROWSER_TEST_DIST ?? resolve(import.meta.dirname, "../dist"));
const projectId = "96000001-0000-4000-8000-000000000001";
const documentId = "96000002-0000-4000-8000-000000000002";
const fixedRevisionId = "96000003-0000-4000-8000-000000000003";
const sessionId = "96000004-0000-4000-8000-000000000004";
const sessionKey = `owned:${sessionId}`;
const currentRevisionId = "96000005-0000-4000-8000-000000000005";
const taskId = "96000006-0000-4000-8000-000000000006";
const deliveryId = "96000007-0000-4000-8000-000000000007";
const stamp = "2026-11-02T00:00:00.000Z";
const fixedDocument = `/p/${projectId}/documents/${documentId}?revision=${fixedRevisionId}`;
const metadata = { generatedAt: stamp, sourceObservedAt: stamp, partial: false, limitations: [] };
const unavailable = { available: false, reason: "fixture unavailable" };

test("Session results → fixed Document → return restores the exact Session results view", {
  skip: !modulePath && "Set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE and EVOLOOP_BROWSER_TEST_DIST",
}, async t => {
  const { chromium } = (await import(pathToFileURL(modulePath!).href)).default;
  const revisionReads: string[] = [];
  const apiReads: string[] = [];
  const resources = Object.fromEntries(["configuredModel", "actualModel", "inputTokens", "outputTokens", "cost", "processMemory"]
    .map(key => [key, { value: null, unit: "", source: null, scope: "session", observedAt: null, interval: null, unavailableReason: "未记录" }]));
  const session = { key: sessionKey, target: { kind: "owned", sessionId }, aliases: [], title: "Document 往返会话", profile: null,
    kind: "owned", roles: [], membership: "current", membershipReason: "fixture", runtimeState: "ready", busy: false,
    currentTask: null, latestBusinessRun: null, lastProgressAt: null,
    capabilities: { observe: unavailable, send: { ...unavailable, mode: "owned-conversation" }, open: { ...unavailable, ref: null }, interrupt: unavailable, close: unavailable },
    source: { kind: "session", id: sessionId, revision: null, evidence: "project-record", href: "" }, metadata };
  const result = { deliveryId, taskId, taskTitle: "固定方案交付任务", technicalResult: "passed", artifactRef: fixedDocument,
    artifactRevision: fixedRevisionId, contentHash: "a".repeat(64), submittedAt: stamp, latestUse: null,
    source: { kind: "delivery", id: deliveryId, revision: null, evidence: "project-record", href: "" } };
  const snapshot = { session, observationCursor: "0", currentWork: null, assignments: [], roleTasks: [], queue: [],
    results: [result], questions: [], activity: [], resources, metadata };
  const fixedRevision = { projectId, documentId, id: fixedRevisionId, version: 1, body: "固定方案正文：FIXED-PLAN-OLD-REVISION",
    format: "markdown", contentHash: "a".repeat(64), previousRevisionId: null, author: "reader", actorId: "reader", reason: "固定方案", createdAt: stamp };
  const currentRevision = { ...fixedRevision, id: currentRevisionId, version: 2, body: "当前新版正文：CURRENT-PLAN-NEW-REVISION",
    contentHash: "b".repeat(64), previousRevisionId: fixedRevisionId };
  const document = { projectId, id: documentId, version: 2, title: "固定方案 Document", kind: "spec", status: "published",
    currentRevisionId, adoptedRevisionId: currentRevisionId, primaryTaskId: null, origin: null };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname.startsWith("/api/")) {
      apiReads.push(url.pathname + url.search);
      const root = `/api/projects/${projectId}`;
      let value: unknown = { items: [], nextCursor: null, metadata }, status = 200;
      if (url.pathname === "/api/session") value = { principal: { actorId: "reader", projectIds: [projectId], permissions: ["read"] }, capabilities: {} };
      else if (url.pathname === root) value = { id: projectId, title: "Document 往返回归项目", createdAt: stamp };
      else if (url.pathname === `${root}/session-work`) value = { items: url.searchParams.get("membership") && url.searchParams.get("membership") !== "current" ? [] : [session],
        nextCursor: null, observationCursor: "0", metadata, totals: { current: 1, historical: 0, unclassified: 0 },
        attention: { unansweredQuestions: 0, pendingMessages: 0, pendingAcceptance: 0, unclassifiedSessions: 0 } };
      else if (url.pathname === `${root}/session-work/changes`) value = { items: [], nextCursor: "0", hasMore: false, resetRequired: false, metadata };
      else if (url.pathname === `${root}/session-work/${encodeURIComponent(sessionKey)}`) value = snapshot;
      else if (url.pathname.endsWith("/timeline")) value = timelinePage(sessionKey, { title: session.title, live: false, liveFreshness: "unavailable" });
      else if (url.pathname === `${root}/documents/${documentId}`) value = { document, current: currentRevision, adopted: currentRevision };
      else if (url.pathname.startsWith(`${root}/documents/${documentId}/revisions/`)) {
        const revision = url.pathname.split("/").at(-1)!;
        revisionReads.push(revision);
        if (revision === fixedRevisionId) value = fixedRevision;
        else if (revision === currentRevisionId) value = currentRevision;
        else { status = 404; value = { message: "固定修订不存在" }; }
      }
      else if (url.pathname === `${root}/work-management/index`) value = { items: [], nextCursor: null, total: 0, counts: {}, changeSequence: 1, observedAt: stamp, partial: false };
      else if (url.pathname === `${root}/impacts` || url.pathname === `${root}/runtime/runs` || url.pathname === `${root}/runtime/sessions` || url.pathname.startsWith(`${root}/references/`)) value = [];
      else if (url.pathname === `${root}/runtime`) value = { available: false, error: null, allowedCwds: [], grants: [] };
      else if (url.pathname === `${root}/orchestration/work-status`) value = { items: [] };
      else if (url.pathname.endsWith("/recovery")) { status = 404; value = { message: "无恢复记录" }; }
      res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); return;
    }
    try {
      const body = await readFile(join(dist, /^\/(?:$|p\/|ui$)/.test(url.pathname) ? "index.html" : url.pathname));
      res.writeHead(200, { "content-type": ({ ".html": "text/html", ".js": "text/javascript", ".css": "text/css" } as Record<string, string>)[extname(/^\/(?:$|p\/|ui$)/.test(url.pathname) ? "index.html" : url.pathname)] ?? "application/octet-stream" });
      res.end(body);
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const browser = await chromium.launch({ headless: true, ...(process.env.EVOLOOP_BROWSER_TEST_EXECUTABLE_PATH
    ? { executablePath: process.env.EVOLOOP_BROWSER_TEST_EXECUTABLE_PATH } : {}) });
  t.after(async () => { await browser.close(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(`${base}/p/${projectId}/sessions?${new URLSearchParams({ session: sessionKey, tab: "activity", filter: "all" })}`);
  await page.getByLabel("访问令牌").fill("fixture-token");
  await page.getByRole("button", { name: "进入", exact: true }).click();
  await page.getByRole("heading", { name: session.title }).waitFor({ timeout: 5000 }).catch(async cause => {
    assert.fail(`${String(cause)}; pageErrors=${JSON.stringify(errors)}; apiReads=${JSON.stringify(apiReads)}; body=${(await page.locator("body").innerText()).slice(0, 1800)}`);
  });
  if (await page.getByRole("button", { name: "展开右栏" }).count()) await page.getByRole("button", { name: "展开右栏" }).click();
  await page.getByRole("tab", { name: "资料库", exact: true }).click();
  await page.getByRole("heading", { name: "成果与使用" }).waitFor();
  const returnHash = await page.evaluate(() => (location.pathname + location.search));
  const artifact = page.locator(".session-results").getByRole("link", { name: "打开固定成果" });
  const artifactHref = (await artifact.getAttribute("href"))!;
  assert.equal(new URLSearchParams(artifactHref.split("?")[1]).get("revision"), fixedRevisionId);
  await artifact.click();
  await page.getByRole("heading", { name: document.title, exact: true }).waitFor();
  await page.getByRole("region", { name: "文档完整正文" }).locator(".markdown-body").getByText(fixedRevision.body, { exact: true }).waitFor();
  assert.equal(await page.getByRole("region", { name: "文档完整正文" }).locator(".markdown-body").getByText(currentRevision.body, { exact: true }).count(), 0,
    "the delivery reads its fixed revision even when the current Document is newer");
  const back = page.locator(".document-reading-backlinks").getByRole("link", { name: /^返回智能体/ });
  assert.equal(await back.getAttribute("href"), returnHash, "Document returns to the exact source Session and results tab");
  await back.click();
  await page.getByRole("heading", { name: "成果与使用" }).waitFor();
  assert.equal(await page.evaluate(() => (location.pathname + location.search)), returnHash);
  assert.equal(await page.getByRole("tab", { name: "资料库", exact: true }).getAttribute("aria-selected"), "true");

  // Legacy bare fixed links still use the source captured on same-tab navigation.
  await page.evaluate(hash => { location.hash = hash; }, fixedDocument);
  await page.getByRole("heading", { name: document.title, exact: true }).waitFor();
  assert.equal(await back.getAttribute("href"), returnHash, "stored same-project Session source remains a valid fallback");
  await back.click();
  await page.getByRole("heading", { name: "成果与使用" }).waitFor();

  // A direct fixed link carries its own source and does not depend on this tab's navigation history.
  assert.equal(new URLSearchParams(artifactHref.split("?")[1]).get("return"), returnHash);
  const direct = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await direct.goto(`${base}${artifactHref}`);
  await direct.getByLabel("访问令牌").fill("fixture-token");
  await direct.getByRole("button", { name: "进入", exact: true }).click();
  await direct.getByRole("heading", { name: document.title, exact: true }).waitFor();
  await direct.getByRole("region", { name: "文档完整正文" }).locator(".markdown-body").getByText(fixedRevision.body, { exact: true }).waitFor();
  const directBack = direct.locator(".document-reading-backlinks").getByRole("link", { name: /^返回智能体/ });
  assert.equal(await directBack.getAttribute("href"), returnHash);
  await directBack.click();
  // At 390px the right column is a drawer that opens only when asked; it opens on the results the link named.
  assert.equal(await direct.getByRole("heading", { name: "成果与使用" }).isVisible(), false, "the drawer does not open by itself");
  await direct.getByRole("button", { name: "展开右栏" }).click();
  await direct.getByRole("heading", { name: "成果与使用" }).waitFor();
  assert.equal(await direct.getByRole("tab", { name: "资料库", exact: true }).getAttribute("aria-selected"), "true");
  assert.equal(await direct.evaluate(() => (location.pathname + location.search)), returnHash);
  assert.ok(revisionReads.length >= 2 && revisionReads.every(id => id === fixedRevisionId), "every selected-revision read stays on the declared fixed revision");
  assert.deepEqual(errors, []);
});
