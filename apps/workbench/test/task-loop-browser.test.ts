// Opt-in built-app regression: build workbench, then set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const playwrightModule = process.env.EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE;
const dist = resolve(import.meta.dirname, "../dist");
const projectId = "00000000-0000-4000-8000-000000000001";
const taskId = "00000000-0000-4000-8000-000000000002";
const oldId = "11111111-0000-4000-8000-000000000003";
const newId = "22222222-0000-4000-8000-000000000004";
const runId = "33333333-0000-4000-8000-000000000005";
const goalId = "00000000-0000-4000-8000-000000000006";
const stageId = "00000000-0000-4000-8000-000000000007";
const createdAt = "2026-10-25T00:00:00.000Z";
const page = (items: unknown[]) => ({ items, nextCursor: null });
const long = "夹具范围说明".repeat(24);
const task = { projectId, id:taskId, version:8, currentRevisionId:taskId, title:"同一任务续跑", content:"任务正文", contentDocumentId:taskId,
  contentRevisionId:taskId, kind:"validation", acceptance:"有证据", owner:"owner", state:"in_progress" };
const context = (loopId: string, dispatchId: string) => ({ loopId, dispatchIds:[dispatchId],parentDispatchIds:[],sourceEventIds:[] });
const loop = (id: string, state: string) => ({projectId,id,version:1,goalId,stageId,bootstrapEventId:taskId,cognitiveRoleId:"owner",
  allowedBusinessRoleIds:["owner"],sourceAfter:{createdAtUtc:createdAt,eventId:null},maxRuns:6,maxConcurrent:1,dispatchCount:state === "stopped" ? 4 : 1,
  state,enrolledBy:"owner",createdAtUtc:createdAt,updatedAtUtc:createdAt});

test("built Task page selects the current Loop, preserves manual history and fits 390px", {skip:!playwrightModule && "Set EVOLOOP_BROWSER_TEST_PLAYWRIGHT_MODULE"}, async t => {
  const { chromium } = (await import(pathToFileURL(playwrightModule!).href)).default;
  let failWorkStatus = false;
  const server = createServer(async (req,res) => {
    const url = new URL(req.url,"http://127.0.0.1");
    if (url.pathname === "/__fixture/fail-status" && req.method === "POST") { failWorkStatus = true; res.end("ok"); return; }
    if (url.pathname.startsWith("/api/")) {
      const p = `/api/projects/${projectId}`;
      let value: unknown = page([]), status = 200;
      if (url.pathname === "/api/session") value = {principal:{actorId:"owner",projectIds:[projectId],permissions:["read"]},capabilities:{}};
      else if (url.pathname === p) value = {id:projectId,title:"夹具项目",createdAt};
      else if (url.pathname === `${p}/tasks/${taskId}`) value = {task,revision:{...task,taskId,id:taskId,actorId:"owner",reason:"夹具",createdAt},basis:null,
        links:[],impacts:[],decisions:[],proposal:{stageId},judgements:[],deliveries:[],observations:[],closures:[]};
      else if (url.pathname === `${p}/runtime`) value = {available:true,error:null,allowedCwds:[],grants:[]};
      else if (url.pathname === `${p}/runtime/sessions`) value = [];
      else if (url.pathname === `${p}/references/tasks/${taskId}`) value = [];
      else if (url.pathname === `${p}/runtime/runs`) value = [{projectId,id:runId,taskId,taskRevisionId:taskId,basisSetId:taskId,sessionId:taskId,
        operationId:taskId,input:"",inputHash:"",state:"running",version:1,nativeTurnId:null,interruptRequested:false,resultSummary:null,actorId:"owner",createdAt,updatedAt:createdAt}];
      else if (url.pathname === `${p}/orchestration/status`) value = {state:"active",running:true,busy:false,faults:[],lastError:null};
      else if (url.pathname === `${p}/orchestration/tasks/${taskId}/context`) value = page([context(oldId,"old-dispatch"),context(newId,"new-dispatch")]);
      else if (url.pathname === `${p}/orchestration/work-status`) {
        if (failWorkStatus) { status=503; value={message:"正式派发读取失败"}; }
        else value = {items:[{taskId,dispatchId:"new-dispatch",runId,runState:"running"}]};
      }
      else if (url.pathname === `${p}/orchestration/loops/${oldId}`) value = loop(oldId,"stopped");
      else if (url.pathname === `${p}/orchestration/loops/${newId}`) value = loop(newId,"active");
      else if (url.pathname === `${p}/goals/${goalId}`) value = {id:goalId,outcome:long};
      else if (url.pathname === `${p}/stages/${stageId}`) value = {id:stageId,deliverable:long};
      else if (url.pathname.startsWith(`${p}/orchestration/loops/`)) value = page([]);
      res.writeHead(status,{"content-type":"application/json"}); res.end(JSON.stringify(value)); return;
    }
    const file = join(dist,url.pathname === "/" ? "index.html" : url.pathname);
    if (!file.startsWith(dist+"/")) { res.writeHead(404); res.end(); return; }
    try { const body=await readFile(file); res.writeHead(200,{"content-type":({".html":"text/html",".js":"text/javascript",".css":"text/css"})[extname(file)] ?? "application/octet-stream"}); res.end(body); }
    catch { res.writeHead(404); res.end(); }
  });
  await new Promise<void>(resolve => server.listen(0,"127.0.0.1",resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as {port:number}).port}`;
  const browser = await chromium.launch({headless:true}); t.after(() => browser.close());
  const pageBrowser = await browser.newPage({viewport:{width:1280,height:720}});
  await pageBrowser.goto(`${base}/#/p/${projectId}/tasks/${taskId}?tab=runtime`);
  await pageBrowser.getByLabel("访问令牌").fill("fixture-token");
  await pageBrowser.getByRole("button",{name:"进入",exact:true}).click();
  await pageBrowser.getByRole("tab",{name:"运行与关联"}).waitFor();
  const panel = pageBrowser.getByRole("region",{name:"自动循环观察"});
  await panel.getByText(/当前运行 33333333 关联循环 22222222/).waitFor();
  assert.match(await panel.locator(".orch-loop-head h3").innerText(),/22222222/);
  assert.equal((await panel.locator(".orch-loop-picker button").allInnerTexts()).every(text => text.length < 40),true);
  await panel.getByRole("button",{name:/循环 11111111/}).click();
  assert.match(await panel.locator(".orch-loop-head h3").innerText(),/11111111/);
  await panel.getByRole("button",{name:"重新读取"}).click();
  await panel.getByText(/手动查看历史循环 11111111/).waitFor();
  assert.match(await panel.locator(".orch-loop-head h3").innerText(),/11111111/);
  await pageBrowser.setViewportSize({width:390,height:844});
  assert.equal(await panel.evaluate(el => el.scrollWidth <= el.clientWidth),true);
  await fetch(`${base}/__fixture/fail-status`,{method:"POST"});
  await panel.getByRole("button",{name:"重新读取"}).click();
  await panel.getByText(/自动循环读取未完成/).waitFor();
  assert.equal(await panel.getByText(/当前运行 33333333/).count(),0);
});
