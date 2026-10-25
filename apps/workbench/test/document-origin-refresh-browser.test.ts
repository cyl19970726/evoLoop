// Opt-in built-app regression: build workbench, then set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const playwrightModule = process.env.EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE;
const dist = resolve(import.meta.dirname, "../dist");
const projectId = "11111111-1111-4111-8111-111111111111";
const taskId = "22222222-2222-4222-8222-222222222222";
const taskRevisionId = "33333333-3333-4333-8333-333333333333";
const runId = "44444444-4444-4444-8444-444444444444";
const nextRunId = "77777777-7777-4777-8777-777777777777";
const documentId = "55555555-5555-4555-8555-555555555555";
const revisionId = "66666666-6666-4666-8666-666666666666";
const stamp = "2026-10-25T00:00:00.000Z";
const documentRoute = `#/p/${projectId}/documents/${documentId}?revision=${revisionId}`;
const pageItems = { items: [], nextCursor: null };

test("document source Run rereads after Delivery return and manual refresh, retaining an explicitly stale last read on failure", {
  skip: !playwrightModule && "Set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE",
}, async t => {
  const { chromium } = (await import(pathToFileURL(playwrightModule!).href)).default;
  let runState = "running", failRun = false, runReads = 0, originRunId = runId;
  let holdNextRun = false, heldRunReads = 0, releaseHeldRun: (() => void) | null = null;
  const task = { projectId, id:taskId, title:"来源任务 A", version:4, currentRevisionId:taskRevisionId, content:"正文", contentDocumentId:documentId,
    contentRevisionId:revisionId, kind:"implementation", acceptance:"核对交付", owner:"developer", state:"in_progress", createdAt:stamp };
  const revision = { projectId, id:revisionId, documentId, version:1, body:"报告正文", format:"markdown", contentHash:"a".repeat(64),
    previousRevisionId:null, author:"developer", actorId:"developer", reason:"报告", createdAt:stamp };
  const document = { projectId, id:documentId, version:1, currentRevisionId:revisionId, adoptedRevisionId:revisionId, title:"正式报告 A",
    kind:"report", status:"published", primaryTaskId:null, origin:{taskId,taskRevisionId,runId} };
  const taskRevision = {...task,id:taskRevisionId,taskId,version:4};
  const server = createServer(async (req,res) => {
    const url = new URL(req.url,"http://127.0.0.1");
    if (url.pathname === "/__fixture/complete") { runState = "completed"; res.end("ok"); return; }
    if (url.pathname === "/__fixture/reset") { runState = "running"; failRun = false; res.end("ok"); return; }
    if (url.pathname === "/__fixture/fail-run") { failRun = true; res.end("ok"); return; }
    if (url.pathname === "/__fixture/recover-run") { failRun = false; res.end("ok"); return; }
    if (url.pathname === "/__fixture/run-reads") { res.end(String(runReads)); return; }
    if (url.pathname === "/__fixture/hold-next-run") { holdNextRun = true; res.end("ok"); return; }
    if (url.pathname === "/__fixture/held-run-reads") { res.end(String(heldRunReads)); return; }
    if (url.pathname === "/__fixture/release-held-run") { releaseHeldRun?.(); res.end("ok"); return; }
    if (url.pathname === "/__fixture/change-origin") { originRunId = nextRunId; res.end("ok"); return; }
    if (url.pathname.startsWith("/api/")) {
      const p = `/api/projects/${projectId}`;
      let value: unknown = pageItems;
      if (url.pathname === "/api/session") value = {principal:{actorId:"developer",projectIds:[projectId],permissions:["read"]},capabilities:{}};
      else if (url.pathname === p) value = {id:projectId,title:"项目",createdAt:stamp};
      else if (url.pathname === `${p}/documents/${documentId}`) value = {document:{...document,origin:{...document.origin,runId:originRunId}},current:revision,adopted:revision};
      else if (url.pathname === `${p}/documents/${documentId}/revisions/${revisionId}`) value = revision;
      else if (url.pathname === `${p}/documents/${documentId}/tasks`) value = pageItems;
      else if (url.pathname === `${p}/tasks/${taskId}`) value = {task,revision:taskRevision,basis:null,links:[],impacts:[],decisions:[],
        deliveries:[{projectId,id:documentId,taskId,taskRevisionId,runId,technicalResult:"passed",technicalEvidence:"夹具检查",createdAt:stamp,
          actorId:"developer",artifactRef:documentRoute,artifactRevision:revisionId,contentHash:"a".repeat(64)}],observations:[],closures:[]};
      else if (url.pathname === `${p}/tasks/${taskId}/revisions/${taskRevisionId}`) value = {revision:taskRevision,basis:null};
      else if (url.pathname === `${p}/runtime/runs/${runId}` || url.pathname === `${p}/runtime/runs/${nextRunId}`) {
        runReads++;
        if (failRun) { res.writeHead(503,{"content-type":"application/json"});res.end(JSON.stringify({message:"来源运行暂不可读"}));return; }
        value = {projectId,id:url.pathname.endsWith(nextRunId) ? nextRunId : runId,taskId,taskRevisionId,basisSetId:taskRevisionId,sessionId:runId,operationId:runId,input:"固定输入",
          inputHash:"a".repeat(64),state:runState,version:runState === "running" ? 1 : 2,nativeTurnId:"turn",interruptRequested:false,
          resultSummary:null,actorId:"developer",createdAt:stamp,updatedAt:stamp};
        if (holdNextRun) { holdNextRun = false; heldRunReads++;
          await new Promise<void>(resolve => { releaseHeldRun = resolve; }); }
      }
      else if (url.pathname === `${p}/runtime`) value = {available:false,error:null,allowedCwds:[],grants:[]};
      else if (url.pathname === `${p}/runtime/runs` || url.pathname === `${p}/runtime/sessions`) value = [];
      else if (url.pathname === `${p}/orchestration/work-status`) value = {items:[]};
      else if (url.pathname.startsWith(`${p}/references/`)) value = [];
      res.writeHead(200,{"content-type":"application/json"});res.end(JSON.stringify(value));return;
    }
    const file = join(dist,url.pathname === "/" ? "index.html" : url.pathname);
    try {const body=await readFile(file);res.writeHead(200,{"content-type":({".html":"text/html",".js":"text/javascript",".css":"text/css"})[extname(file)] ?? "application/octet-stream"});res.end(body);}
    catch {res.writeHead(404);res.end();}
  });
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve)); t.after(()=>server.close());
  const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  const browser=await chromium.launch({headless:true}); t.after(()=>browser.close());
  const page=await browser.newPage({viewport:{width:390,height:844}});
  await page.goto(`${base}/${documentRoute}`);
  await page.getByLabel("访问令牌").fill("fixture-token");
  await page.getByRole("button",{name:"进入",exact:true}).click();
  await page.locator(".doc-origin-run > summary").getByText(/运行中/).waitFor();
  await page.evaluate(({projectId,taskId}) => {window.location.hash=`#/p/${projectId}/tasks/${taskId}`;},{projectId,taskId});
  await page.getByRole("heading",{name:"最新交付与使用"}).waitFor();
  await fetch(`${base}/__fixture/complete`);
  await page.locator(".task-delivery-summary .delivery-artifact-link").click();
  await page.locator(".doc-origin-run > summary").getByText(/运行结束/).waitFor({timeout:3000});
  await fetch(`${base}/__fixture/reset`);
  const second=await browser.newPage({viewport:{width:390,height:844}});
  await second.goto(`${base}/${documentRoute}`);
  await second.getByLabel("访问令牌").fill("fixture-token");
  await second.getByRole("button",{name:"进入",exact:true}).click();
  await second.locator(".doc-origin-run > summary").getByText(/运行中/).waitFor();
  const before=Number(await (await fetch(`${base}/__fixture/run-reads`)).text());
  await fetch(`${base}/__fixture/complete`);
  await second.getByRole("button",{name:"重新读取当前文档"}).click();
  await second.locator(".doc-origin-run > summary").getByText(/运行结束/).waitFor({timeout:3000});
  assert.ok(Number(await (await fetch(`${base}/__fixture/run-reads`)).text()) > before);
  await fetch(`${base}/__fixture/fail-run`);
  await second.getByRole("button",{name:"重新读取当前文档"}).click();
  await second.getByText(/来源 Run 本次回读失败.*上次状态.*不能视为当前/).waitFor();
  assert.match(await second.locator(".doc-origin-run > summary").innerText(),/上次读回/);
  await fetch(`${base}/__fixture/recover-run`);
  await second.getByRole("button",{name:"重新读取当前文档"}).click();
  await second.locator(".doc-origin-run > summary").getByText(/运行结束$/).waitFor();
  assert.doesNotMatch(await second.locator(".doc-origin-run > summary").innerText(),/上次读回/);
  await fetch(`${base}/__fixture/hold-next-run`);
  await second.getByRole("button",{name:"重新读取当前文档"}).click();
  for (let attempt=0; attempt<30 && await (await fetch(`${base}/__fixture/held-run-reads`)).text() !== "1"; attempt++)
    await new Promise(resolve=>setTimeout(resolve,25));
  assert.equal(await (await fetch(`${base}/__fixture/held-run-reads`)).text(),"1");
  assert.match(await second.locator(".doc-origin-run > summary").innerText(),/上次读回/);
  await fetch(`${base}/__fixture/change-origin`);
  await second.getByRole("button",{name:"重新读取当前文档"}).click();
  await second.locator(".doc-origin-run > summary").getByText(/77777777.*运行结束/).waitFor();
  await fetch(`${base}/__fixture/release-held-run`);
  await second.waitForTimeout(100);
  assert.match(await second.locator(".doc-origin-run > summary").innerText(),/77777777.*运行结束/);
  assert.doesNotMatch(await second.locator(".doc-origin-run > summary").innerText(),/44444444/);
});
